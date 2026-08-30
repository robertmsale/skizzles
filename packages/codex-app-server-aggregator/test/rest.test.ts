import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { BackendFactory, BackendTransport } from "../src/backend.ts";
import { AggregatorDaemon } from "../src/daemon.ts";
import { CONTAINER_WORKSPACE } from "../src/docker.ts";
import type { RpcId, RpcMessage } from "../src/protocol.ts";
import { AggregatorState, type RegisteredProject } from "../src/state.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("aggregator REST API", () => {
  test("uses one long-lived core for one-off project, thread, turn, read, event, and archive calls", async () => {
    const directory = temporaryDirectory();
    const cwd = join(directory, "project");
    await run("git", "init", cwd);
    await run("git", "-C", cwd, "remote", "add", "origin", "https://example.test/owner/project.git");
    const factory = new RestFactory();
    const databasePath = join(directory, "aggregator.sqlite3");
    const daemon = new AggregatorDaemon({
      socketPath: join(directory, "aggregator.sock"),
      state: new AggregatorState(databasePath),
      factory,
      http: { hostname: "127.0.0.1", port: 0 },
    });
    await daemon.start();
    const origin = daemon.httpUrl!.origin;

    const added = await fetchJson(`${origin}/v1/projects`, {
      method: "POST",
      body: JSON.stringify({ cwd }),
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ project: { cwd, cloneUrl: "https://example.test/owner/project.git" } });

    const malformedCwd = await fetchJson(`${origin}/v1/threads`, {
      method: "POST",
      body: JSON.stringify({ cwd: "relative/project" }),
    });
    expect(malformedCwd).toEqual({
      status: 400,
      body: {
        error: {
          code: -32602,
          message: "invalid thread/start cwd: project cwd must be absolute",
        },
      },
    });

    const started = await fetchJson(`${origin}/v1/threads`, {
      method: "POST",
      body: JSON.stringify({ cwd }),
    });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ thread: { id: factory.threadId, cwd } });
    expect(factory.transport.request("thread/start")?.params).toMatchObject({ cwd: CONTAINER_WORKSPACE });

    const machines = await fetchJson(`${origin}/v1/machines`);
    expect(machines.body).toMatchObject({
      data: [{
        machineId: factory.transport.machineId,
        threadIds: [factory.threadId],
        state: "active",
        dockerStatus: null,
      }],
    });

    const listed = await fetchJson(`${origin}/v1/threads?cwd=${encodeURIComponent(cwd)}`);
    expect(listed.body).toMatchObject({ data: [{ id: factory.threadId, cwd }] });

    const sent = await fetchJson(`${origin}/v1/threads/${factory.threadId}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "ship it" }] }),
    });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ turn: { id: "turn-1" } });
    expect(factory.transport.request("turn/start")?.params).toMatchObject({
      threadId: factory.threadId,
      input: [{ type: "text", text: "ship it" }],
    });

    const read = await fetchJson(`${origin}/v1/threads/${factory.threadId}`);
    expect(read.body).toMatchObject({ thread: { id: factory.threadId, turns: [{ id: "turn-1" }] } });
    expect(factory.transport.request("thread/read")?.params).toEqual({
      threadId: factory.threadId,
      includeTurns: true,
    });

    await waitFor(async () => {
      const polled = await fetchJson(`${origin}/v1/events?after=0`);
      const methods = (polled.body as { data: Array<{ event: { method: string } }> }).data.map(({ event }) => event.method);
      return methods.includes("thread/started") && methods.includes("turn/started");
    });
    const events = await fetchJson(`${origin}/v1/events?after=0`);
    expect(events.body).toMatchObject({ gap: false, oldestCursor: 1 });
    const eventPage = events.body as { oldestCursor: number; streamId: string };
    const wrongStream = await fetchJson(`${origin}/v1/events?after=0&stream=previous-daemon`);
    expect(wrongStream).toMatchObject({
      status: 410,
      body: {
        error: {
          code: "event_cursor_expired",
          oldestCursor: eventPage.oldestCursor,
          streamId: eventPage.streamId,
          restarted: true,
        },
      },
    });

    await waitFor(async () => {
      const pending = await fetchJson(`${origin}/v1/server-requests`);
      return (pending.body as { data: unknown[] }).data.length === 1;
    });
    const pending = await fetchJson(`${origin}/v1/server-requests`);
    const approval = (pending.body as { data: Array<{ id: string; method: string }> }).data[0]!;
    expect(approval.method).toBe("item/commandExecution/requestApproval");
    const approved = await fetchJson(`${origin}/v1/server-requests/${encodeURIComponent(approval.id)}/responses`, {
      method: "POST",
      body: JSON.stringify({ result: { decision: "accept" } }),
    });
    expect(approved.body).toEqual({ accepted: true });
    expect(factory.transport.response(7)).toEqual({ id: 7, result: { decision: "accept" } });

    const archived = await fetchJson(`${origin}/v1/threads/${factory.threadId}/archive`, { method: "POST" });
    expect(archived.status).toBe(200);
    expect(factory.transport.destroyed).toBe(true);
    const snapshot = await fetchJson(`${origin}/v1/threads/${factory.threadId}?includeTurns=false`);
    expect(snapshot.body).toMatchObject({ thread: { id: factory.threadId, cwd } });
    expect((snapshot.body as { thread: Record<string, unknown> }).thread).not.toHaveProperty("turns");

    await daemon.close();
    const persisted = new AggregatorState(databasePath);
    expect(persisted.threads()[0]?.snapshot).not.toHaveProperty("turns");
    persisted.close();
  });

  test("serves built SPA assets and falls back to index for client routes", async () => {
    const directory = temporaryDirectory();
    const staticDirectory = join(directory, "dist");
    mkdirSync(staticDirectory);
    writeFileSync(join(staticDirectory, "index.html"), "<!doctype html><title>Codex board</title>");
    const daemon = new AggregatorDaemon({
      socketPath: join(directory, "aggregator.sock"),
      state: new AggregatorState(join(directory, "aggregator.sqlite3")),
      factory: new RestFactory(),
      http: { hostname: "127.0.0.1", port: 0, staticDirectory },
    });
    await daemon.start();
    const root = await fetch(daemon.httpUrl!);
    const fallback = await fetch(new URL("/threads/example", daemon.httpUrl!));
    const unknownApi = await fetch(new URL("/v1/not-a-route", daemon.httpUrl!));
    expect(root.status).toBe(200);
    expect(root.headers.get("cache-control")).toBe("no-cache");
    expect(await root.text()).toContain("Codex board");
    expect(await fallback.text()).toContain("Codex board");
    expect(unknownApi.status).toBe(404);
    expect(await unknownApi.json()).toEqual({ error: { code: "not_found", message: "route not found" } });
    await daemon.close();
  });

  test("keeps machine projection available when container inspection rejects", async () => {
    const directory = temporaryDirectory();
    const state = new AggregatorState(join(directory, "aggregator.sqlite3"));
    const projectCwd = join(directory, "project");
    state.saveMachine({ machineId: "machine-orphan", projectCwd, containerId: "container-missing-docker" });
    state.saveThread({
      threadId: "thread-orphan",
      machineId: "machine-orphan",
      projectCwd,
      snapshot: { id: "thread-orphan", cwd: projectCwd },
      loaded: true,
      archived: false,
      deleted: false,
    });
    const inspected: string[] = [];
    const daemon = new AggregatorDaemon({
      socketPath: join(directory, "aggregator.sock"),
      state,
      factory: new RestFactory(),
      inspectContainer: async (containerId) => {
        inspected.push(containerId);
        throw new Error("Docker binary is unavailable");
      },
      http: { hostname: "127.0.0.1", port: 0 },
    });
    await daemon.start();

    const machines = await fetchJson(`${daemon.httpUrl!.origin}/v1/machines`);
    expect(machines).toEqual({
      status: 200,
      body: {
        data: [{
          machineId: "machine-orphan",
          projectCwd,
          containerId: "container-missing-docker",
          state: "orphaned",
          threadIds: ["thread-orphan"],
          dockerStatus: null,
        }],
      },
    });
    expect(inspected).toEqual(["container-missing-docker"]);
    await daemon.close();
  });

  test("keeps live backends when a JSONL relay disconnects and allows REST concurrently", async () => {
    const directory = temporaryDirectory();
    const cwd = join(directory, "project");
    await run("git", "init", cwd);
    await run("git", "-C", cwd, "remote", "add", "origin", "https://example.test/owner/project.git");
    const factory = new RestFactory();
    const socketPath = join(directory, "aggregator.sock");
    const daemon = new AggregatorDaemon({
      socketPath,
      state: new AggregatorState(join(directory, "aggregator.sqlite3")),
      factory,
      http: { hostname: "127.0.0.1", port: 0 },
    });
    await daemon.start();
    const origin = daemon.httpUrl!.origin;
    await fetchJson(`${origin}/v1/projects`, { method: "POST", body: JSON.stringify({ cwd }) });
    await fetchJson(`${origin}/v1/threads`, { method: "POST", body: JSON.stringify({ cwd }) });

    const initialized = await socketRequest(socketPath, {
      method: "initialize",
      id: "socket-init",
      params: {
        clientInfo: { name: "test-client", title: "Test client", version: "1.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
    expect(initialized).toMatchObject({ id: "socket-init", result: { platformOs: "linux" } });
    expect(factory.transport.destroyed).toBe(false);

    const listed = await fetchJson(`${origin}/v1/threads`);
    expect(listed.body).toMatchObject({ data: [{ id: factory.threadId }] });
    expect(factory.transport.destroyed).toBe(false);
    await daemon.close();
    expect(factory.transport.destroyed).toBe(true);
  });

  test("preserves initialize ordering for JSONL while retaining every notification for REST polling", async () => {
    const directory = temporaryDirectory();
    const cwd = join(directory, "project");
    await run("git", "init", cwd);
    await run("git", "-C", cwd, "remote", "add", "origin", "https://example.test/owner/project.git");
    const factory = new RestFactory();
    const socketPath = join(directory, "aggregator.sock");
    const daemon = new AggregatorDaemon({
      socketPath,
      state: new AggregatorState(join(directory, "aggregator.sqlite3")),
      factory,
      http: { hostname: "127.0.0.1", port: 0 },
    });
    await daemon.start();
    const origin = daemon.httpUrl!.origin;
    await fetchJson(`${origin}/v1/projects`, { method: "POST", body: JSON.stringify({ cwd }) });

    const messages = await socketMessages(socketPath, {
      method: "initialize",
      id: "socket-init",
      params: {
        clientInfo: { name: "test-client", title: "Test client", version: "1.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    }, 2);
    expect(messages[0]).toMatchObject({ id: "socket-init", result: { platformOs: "linux" } });
    expect(messages[1]).toMatchObject({ method: "configWarning" });

    const events = await fetchJson(`${origin}/v1/events?after=0`);
    expect(events.body).toMatchObject({
      data: [{ event: { method: "configWarning" } }],
      streamId: expect.any(String),
    });
    await daemon.close();
  });

  test("accepts a replacement relay while a disconnected client's backend call is still pending", async () => {
    const directory = temporaryDirectory();
    const cwd = join(directory, "project");
    await run("git", "init", cwd);
    await run("git", "-C", cwd, "remote", "add", "origin", "https://example.test/owner/project.git");
    const factory = new RestFactory();
    const socketPath = join(directory, "aggregator.sock");
    const daemon = new AggregatorDaemon({
      socketPath,
      state: new AggregatorState(join(directory, "aggregator.sqlite3")),
      factory,
      http: { hostname: "127.0.0.1", port: 0 },
    });
    await daemon.start();
    const origin = daemon.httpUrl!.origin;
    await fetchJson(`${origin}/v1/projects`, { method: "POST", body: JSON.stringify({ cwd }) });
    await fetchJson(`${origin}/v1/threads`, { method: "POST", body: JSON.stringify({ cwd }) });

    factory.delayNextRead = true;
    await sendReadThenDisconnect(socketPath, factory.threadId);
    await waitFor(async () => factory.hasPendingRead());
    const replacement = await waitForReplacement(socketPath);
    expect(replacement).toMatchObject({ id: "replacement", result: { data: [{ cwd }] } });

    factory.releaseRead();
    await daemon.close();
  });

  test("requires the configured bearer token", async () => {
    const directory = temporaryDirectory();
    const staticDirectory = join(directory, "dist");
    mkdirSync(staticDirectory);
    writeFileSync(join(staticDirectory, "index.html"), "<!doctype html><title>Must not leak</title>");
    const daemon = new AggregatorDaemon({
      socketPath: join(directory, "aggregator.sock"),
      state: new AggregatorState(join(directory, "aggregator.sqlite3")),
      factory: new RestFactory(),
      http: { hostname: "127.0.0.1", port: 0, token: "test-secret", staticDirectory },
    });
    await daemon.start();
    const origin = daemon.httpUrl!.origin;
    expect((await fetch(`${origin}/healthz`)).status).toBe(401);
    expect((await fetch(`${origin}/healthz`, { headers: { authorization: "Bearer test-secret" } })).status).toBe(200);
    const board = await fetch(origin, { headers: { authorization: "Bearer test-secret" } });
    expect(board.status).toBe(503);
    expect(await board.json()).toEqual({
      error: {
        code: "board_disabled",
        message: "browser board is available only on an unauthenticated loopback listener",
      },
    });
    await daemon.close();
  });

  test("rejects hostile browser origins on the unauthenticated loopback listener", async () => {
    const directory = temporaryDirectory();
    const daemon = new AggregatorDaemon({
      socketPath: join(directory, "aggregator.sock"),
      state: new AggregatorState(join(directory, "aggregator.sqlite3")),
      factory: new RestFactory(),
      http: { hostname: "127.0.0.1", port: 0 },
    });
    await daemon.start();
    const origin = daemon.httpUrl!.origin;

    const hostile = await fetchJson(`${origin}/v1/projects`, {
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    });
    expect(hostile).toEqual({
      status: 403,
      body: { error: { code: "forbidden_origin", message: "request Host or Origin is not allowed" } },
    });
    expect((await fetch(`${origin}/healthz`, { headers: { origin } })).status).toBe(200);
    await daemon.close();
  });

  test("rejects an oversized streamed body without waiting for its end", async () => {
    const directory = temporaryDirectory();
    const daemon = new AggregatorDaemon({
      socketPath: join(directory, "aggregator.sock"),
      state: new AggregatorState(join(directory, "aggregator.sqlite3")),
      factory: new RestFactory(),
      http: { hostname: "127.0.0.1", port: 0 },
    });
    await daemon.start();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 17; index++) controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() { cancelled = true; },
    });
    try {
      const response = await fetch(`${daemon.httpUrl!.origin}/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
        signal: AbortSignal.timeout(5_000),
      } as RequestInit & { duplex: "half" });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: { code: "bad_request", message: "request body exceeds 1 MiB" },
      });
      expect(cancelled).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  test("waits for an in-flight provisioning request before closing shared state", async () => {
    const directory = temporaryDirectory();
    const cwd = join(directory, "project");
    await run("git", "init", cwd);
    await run("git", "-C", cwd, "remote", "add", "origin", "https://example.test/owner/project.git");
    const factory = new RestFactory();
    const daemon = new AggregatorDaemon({
      socketPath: join(directory, "aggregator.sock"),
      state: new AggregatorState(join(directory, "aggregator.sqlite3")),
      factory,
      http: { hostname: "127.0.0.1", port: 0 },
    });
    await daemon.start();
    const origin = daemon.httpUrl!.origin;
    await fetchJson(`${origin}/v1/projects`, { method: "POST", body: JSON.stringify({ cwd }) });
    factory.pauseNextCreate = true;
    const starting = fetchJson(`${origin}/v1/threads`, {
      method: "POST",
      body: JSON.stringify({ cwd }),
    }).catch((error: unknown) => error);
    await waitFor(async () => factory.createBlocked);

    let closeSettled = false;
    const closing = daemon.close().then(() => { closeSettled = true; });
    await Bun.sleep(5);
    expect(closeSettled).toBe(false);
    factory.releaseCreate();
    await Promise.allSettled([starting, closing]);

    expect(closeSettled).toBe(true);
    expect(factory.transport.destroyed).toBe(true);
  });
});

class RestFactory implements BackendFactory {
  readonly threadId = "0198f000-7000-7000-8000-000000000000";
  readonly transport = new RestTransport((message) => this.handle(message));
  delayNextRead = false;
  pauseNextCreate = false;
  createBlocked = false;
  private pendingReadId: RpcId | undefined;
  private releaseBlockedCreate: (() => void) | undefined;

  async create(_project: RegisteredProject): Promise<BackendTransport> {
    if (this.pauseNextCreate) {
      this.pauseNextCreate = false;
      this.createBlocked = true;
      await new Promise<void>((resolve) => { this.releaseBlockedCreate = resolve; });
      this.createBlocked = false;
      this.releaseBlockedCreate = undefined;
    }
    return this.transport;
  }

  releaseCreate(): void {
    const release = this.releaseBlockedCreate;
    if (!release) throw new Error("no REST provisioning call is blocked");
    release();
  }

  hasPendingRead(): boolean {
    return this.pendingReadId !== undefined;
  }

  releaseRead(): void {
    const id = this.pendingReadId;
    if (id === undefined) throw new Error("no fake thread/read is pending");
    this.pendingReadId = undefined;
    this.transport.emit({
      id,
      result: { thread: { ...threadSnapshot(this.threadId), turns: [{ id: "turn-1" }] } },
    });
  }

  private async handle(message: RpcMessage): Promise<void> {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "initialize") {
      this.transport.emit({
        id: message.id,
        result: {
          userAgent: "fake-codex/0.149.1",
          codexHome: "/codex-home",
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      this.transport.emit({ method: "configWarning", params: { summary: "fake warning", details: null } });
      return;
    }
    if (message.method === "thread/start") {
      const thread = threadSnapshot(this.threadId);
      this.transport.emit({ id: message.id, result: { thread } });
      this.transport.emit({ method: "thread/started", params: { thread } });
      return;
    }
    if (message.method === "turn/start") {
      this.transport.emit({ id: message.id, result: { turn: { id: "turn-1" } } });
      this.transport.emit({
        method: "turn/started",
        params: { threadId: this.threadId, turn: { id: "turn-1", items: [] } },
      });
      this.transport.emit({
        method: "item/commandExecution/requestApproval",
        id: 7,
        params: { threadId: this.threadId, command: "echo ship" },
      });
      return;
    }
    if (message.method === "thread/read") {
      if (this.delayNextRead) {
        this.delayNextRead = false;
        this.pendingReadId = message.id;
        return;
      }
      this.transport.emit({
        id: message.id,
        result: { thread: { ...threadSnapshot(this.threadId), turns: [{ id: "turn-1" }] } },
      });
      return;
    }
    if (message.method === "thread/archive") {
      this.transport.emit({
        id: message.id,
        error: { code: -32600, message: `no rollout found for thread id ${this.threadId}` },
      });
      return;
    }
    this.transport.emit({ id: message.id, result: {} });
  }
}

class RestTransport implements BackendTransport {
  readonly machineId = "rest-machine";
  readonly containerId = "rest-container";
  readonly workspace = CONTAINER_WORKSPACE;
  readonly ready = Promise.resolve();
  readonly stdout: ReadableStream<Uint8Array>;
  readonly writes: RpcMessage[] = [];
  destroyed = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  constructor(private readonly onWrite: (message: RpcMessage) => Promise<void>) {
    this.stdout = new ReadableStream<Uint8Array>({ start: (controller) => { this.controller = controller; } });
  }

  async write(line: string): Promise<void> {
    const message = JSON.parse(line) as RpcMessage;
    this.writes.push(structuredClone(message));
    await this.onWrite(message);
  }

  emit(message: RpcMessage): void {
    this.controller.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.controller.close();
  }

  request(method: string): Extract<RpcMessage, { method: string; id: RpcId }> | undefined {
    return this.writes.find((message): message is Extract<RpcMessage, { method: string; id: RpcId }> =>
      "method" in message && "id" in message && message.method === method);
  }

  response(id: RpcId): RpcMessage | undefined {
    return this.writes.find((message) => !("method" in message) && "id" in message && message.id === id);
  }
}

function threadSnapshot(id: string) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "REST thread",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    cwd: CONTAINER_WORKSPACE,
    source: "vscode",
    turns: [],
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  return { status: response.status, body: await response.json() };
}

function socketRequest(socketPath: string, message: RpcMessage): Promise<RpcMessage> {
  return socketMessages(socketPath, message, 1).then((messages) => messages[0]!);
}

function socketMessages(socketPath: string, message: RpcMessage, count: number): Promise<RpcMessage[]> {
  return new Promise((resolveRequest, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    const messages: RpcMessage[] = [];
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (data) => {
      buffer += data.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        try {
          messages.push(JSON.parse(buffer.slice(0, newline)) as RpcMessage);
        } catch (error) {
          reject(error);
          socket.destroy();
          return;
        }
        buffer = buffer.slice(newline + 1);
        if (messages.length >= count) {
          resolveRequest(messages);
          socket.end();
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.once("error", reject);
  });
}

function sendReadThenDisconnect(socketPath: string, threadId: string): Promise<void> {
  return new Promise((resolveSend, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.once("connect", () => socket.write(`${JSON.stringify({
      method: "initialize",
      id: "disconnect-init",
      params: {
        clientInfo: { name: "disconnecting-client", title: null, version: "1.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    })}\n`));
    socket.on("data", (data) => {
      buffer += data.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline)) as RpcMessage;
      if (!("id" in message) || message.id !== "disconnect-init" || !("result" in message)) {
        reject(new Error("disconnecting client did not initialize"));
        socket.destroy();
        return;
      }
      socket.write(`${JSON.stringify({
        method: "thread/read",
        id: "abandoned-read",
        params: { threadId, includeTurns: true },
      })}\n`, () => {
        socket.destroy();
        resolveSend();
      });
    });
    socket.once("error", reject);
  });
}

async function waitForReplacement(socketPath: string): Promise<RpcMessage> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await socketRequest(socketPath, {
      method: "skizzles/project/list",
      id: "replacement",
      params: {},
    });
    if ("result" in response) return response;
    await Bun.sleep(1);
  }
  throw new Error("replacement relay remained busy after the old socket disconnected");
}

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "skizzles-aggregator-rest-")));
  temporaryDirectories.push(directory);
  return directory;
}

async function run(...command: string[]): Promise<void> {
  const process = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `${command[0]} failed`);
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("timed out waiting for REST-visible app-server event");
}
