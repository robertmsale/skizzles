import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { encodeFrame, readFrames, writeFrame, type JsonRpcMessage } from "../src/framing.ts";
import { STRUCTURED_ERROR_CODE, runSupervisor, type ChildHandle } from "../src/supervisor.ts";
import { SUCCESS_TEXT, runFakeAcp, type FakeAcpMode } from "./fake-acp.ts";

const temporary: Array<() => void> = [];
afterEach(() => {
  for (const stop of temporary.splice(0)) stop();
});

describe("ACP supervisor", () => {
  test("passes a normal turn through unchanged", async () => {
    const session = await startSession("ok");
    const updates: string[] = [];
    const result = await session.prompt("hi", updates);
    expect(updates).toEqual([SUCCESS_TEXT]);
    expect(result).toEqual({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    expect(session.logs.join("\n")).not.toContain("swallowed");
    await session.close();
  });

  test("swallows death-as-text and replays the same session/prompt on the live child", async () => {
    const session = await startSession("flake-then-ok");
    const updates: string[] = [];
    const result = await session.prompt("try again", updates);
    expect(updates).toEqual([SUCCESS_TEXT]);
    expect(result.result).toEqual({ stopReason: "end_turn" });
    expect(session.logs.some((line) => line.includes("swallowed spurious Cursor ACP network death"))).toBe(true);
    expect(session.logs.some((line) => line.includes("replaying session/prompt"))).toBe(true);
    expect(updates.join("")).not.toContain("ConnectError");
    await session.close();
  });

  test("fails in an error-shaped way after the retry budget", async () => {
    const session = await startSession("always-flake", { maxRetries: 1 });
    const updates: string[] = [];
    const result = await session.prompt("keep dying", updates);
    expect(updates).toEqual([]);
    expect(result.error && typeof result.error === "object" && "code" in result.error ? result.error.code : undefined).toBe(STRUCTURED_ERROR_CODE);
    expect(JSON.stringify(result.error)).toContain("after 2 attempts");
    expect(session.logs.some((line) => line.includes("structured failure"))).toBe(true);
    await session.close();
  });

  test("does not swallow a genuine HTTP failure described by the agent", async () => {
    const text = "The HTTP request failed in the app you are debugging because /health returned 500.";
    const session = await startSession("ok", { successText: text });
    const updates: string[] = [];
    const result = await session.prompt("debug the app", updates);
    expect(updates).toEqual([text]);
    expect(result.result).toEqual({ stopReason: "end_turn" });
    expect(session.logs.join("\n")).not.toContain("swallowed");
    await session.close();
  });
});

async function startSession(mode: FakeAcpMode, options: { maxRetries?: number; successText?: string } = {}) {
  const t3stdin = new PassThrough();
  const t3stdout = new PassThrough();
  const t3stderr = new PassThrough();
  const logs: string[] = [];
  const inbound = readQueue(t3stdout);
  const supervisor = runSupervisor({
    childCommand: "fake-acp",
    childArgs: ["acp"],
    io: { stdin: t3stdin, stdout: t3stdout, stderr: t3stderr },
    maxRetries: options.maxRetries,
    log: (line) => logs.push(line),
    spawn: () => fakeChild(mode, options.successText),
  });
  temporary.push(() => {
    t3stdin.end();
  });

  await send(t3stdin, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "t3" } } });
  expect((await inbound.next()).id).toBe(1);
  await send(t3stdin, { jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "sess-1", cwd: "/tmp" } });
  expect((await inbound.next()).id).toBe(2);

  return {
    logs,
    async prompt(text: string, updates: string[]) {
      await send(t3stdin, {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: "sess-1", prompt: [{ type: "text", text }] },
      });
      while (true) {
        const message = await inbound.next();
        if (message.method === "session/update") {
          const update = (message.params as { update?: { content?: { text?: string } } }).update;
          if (update?.content?.text) updates.push(update.content.text);
          continue;
        }
        return message;
      }
    },
    async close() {
      t3stdin.end();
      await supervisor;
    },
  };
}

function fakeChild(mode: FakeAcpMode, successText?: string): ChildHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let settle: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  void runFakeAcp({ stdin, stdout, mode, successText }).then(() => settle(0), () => settle(1));
  return {
    stdin,
    stdout,
    stderr,
    exited,
    kill: () => {
      stdin.end();
      stdout.end();
      stderr.end();
      settle(0);
    },
  };
}

function readQueue(stream: PassThrough) {
  const pending: JsonRpcMessage[] = [];
  const waiters: Array<(message: JsonRpcMessage) => void> = [];
  void (async () => {
    for await (const frame of readFrames(stream)) {
      const waiter = waiters.shift();
      if (waiter) waiter(frame.message);
      else pending.push(frame.message);
    }
  })();
  return {
    next(): Promise<JsonRpcMessage> {
      const queued = pending.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function send(stream: PassThrough, message: JsonRpcMessage): Promise<void> {
  await writeFrame(stream, encodeFrame(message, "ndjson"));
}
