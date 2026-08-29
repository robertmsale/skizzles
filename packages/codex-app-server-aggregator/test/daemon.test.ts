import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { BackendFactory, BackendTransport } from "../src/backend.ts";
import { AggregatorDaemon } from "../src/daemon.ts";
import type { RpcId, RpcMessage } from "../src/protocol.ts";
import { AggregatorState, type RegisteredProject } from "../src/state.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("aggregator daemon boundary", () => {
  test("outlives a client connection and reloads its registry after a daemon restart", async () => {
    const directory = temporaryDirectory();
    const cwd = join(directory, "project");
    await run("git", "init", cwd);
    await run("git", "-C", cwd, "remote", "add", "origin", "https://example.test/owner/project.git");
    const socketPath = join(directory, "aggregator.sock");
    const databasePath = join(directory, "aggregator.sqlite3");
    const daemon = daemonFor(socketPath, databasePath);
    await daemon.start();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    const added = await request(socketPath, {
      method: "skizzles/project/add",
      id: 1,
      params: { cwd },
    });
    expect(result(added, 1)).toMatchObject({ project: { cloneUrl: "https://example.test/owner/project.git" } });

    const listedBySameDaemon = await request(socketPath, { method: "skizzles/project/list", id: 2, params: {} });
    expect(result(listedBySameDaemon, 2)).toMatchObject({ data: [{ cloneUrl: "https://example.test/owner/project.git" }] });
    await daemon.close();

    const restarted = daemonFor(socketPath, databasePath);
    await restarted.start();
    const listedAfterRestart = await request(socketPath, { method: "skizzles/project/list", id: 3, params: {} });
    expect(result(listedAfterRestart, 3)).toMatchObject({ data: [{ cloneUrl: "https://example.test/owner/project.git" }] });
    const removed = await request(socketPath, {
      method: "skizzles/project/remove",
      id: 4,
      params: { cwd },
    });
    expect(result(removed, 4)).toEqual({ removed: true });
    const empty = await request(socketPath, { method: "skizzles/project/list", id: 5, params: {} });
    expect(result(empty, 5)).toEqual({ data: [] });
    await restarted.close();
  });

  test("marks persisted active machines orphaned and removes their exact containers", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "aggregator.sock");
    const state = new AggregatorState(join(directory, "aggregator.sqlite3"));
    state.saveMachine({ machineId: "machine-a", projectCwd: join(directory, "project"), containerId: "container-a" });
    state.saveThread({
      threadId: "thread-a",
      machineId: "machine-a",
      projectCwd: join(directory, "project"),
      snapshot: { id: "thread-a", cwd: join(directory, "project"), preview: "persisted" },
      loaded: true,
      archived: false,
      deleted: false,
    });
    const removed: string[] = [];
    const daemon = new AggregatorDaemon({
      socketPath,
      state,
      factory: new UnusedFactory(),
      removeOrphan: async (machine) => { removed.push(machine.containerId); },
    });

    await daemon.start();
    expect(removed).toEqual(["container-a"]);
    expect(state.threads()).toMatchObject([{
      threadId: "thread-a",
      loaded: false,
      snapshot: { id: "thread-a", preview: "persisted" },
    }]);
    await daemon.close();
  });
});

class UnusedFactory implements BackendFactory {
  async create(_project: RegisteredProject): Promise<BackendTransport> {
    throw new Error("backend creation was not expected");
  }
}

function daemonFor(socketPath: string, databasePath: string): AggregatorDaemon {
  return new AggregatorDaemon({
    socketPath,
    state: new AggregatorState(databasePath),
    factory: new UnusedFactory(),
  });
}

function request(socketPath: string, message: RpcMessage): Promise<RpcMessage> {
  return new Promise((resolveRequest, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let parsed: RpcMessage | undefined;
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0 || parsed) return;
      try {
        parsed = JSON.parse(buffer.slice(0, newline)) as RpcMessage;
        socket.end();
      } catch (error) {
        reject(error);
        socket.destroy();
      }
    });
    socket.once("error", reject);
    socket.once("close", () => parsed ? resolveRequest(parsed) : reject(new Error("daemon closed without a response")));
  });
}

function result(message: RpcMessage, id: RpcId): unknown {
  if (!("id" in message) || message.id !== id || !("result" in message)) throw new Error(`missing result for ${String(id)}`);
  return message.result;
}

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "skizzles-aggregator-daemon-")));
  temporaryDirectories.push(directory);
  return directory;
}

async function run(...command: string[]): Promise<void> {
  const process = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `${command[0]} failed`);
}
