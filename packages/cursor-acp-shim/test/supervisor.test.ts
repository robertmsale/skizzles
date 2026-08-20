import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { encodeFrame, readFrames, writeFrame, type JsonRpcMessage } from "../src/framing.ts";
import { STRUCTURED_ERROR_CODE, runSupervisor, type ChildHandle } from "../src/supervisor.ts";
import { FLAKE_TEXT, SUCCESS_TEXT, runFakeAcp, type FakeAcpMode, type FakeAcpRequest } from "./fake-acp.ts";

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
    expect(result.id).toBe(3);
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

  test("does not swallow a short answer after a thought that quotes ConnectError", async () => {
    const session = await startSession("ok", {
      successText: "Retry the webhook.",
      thoughtText: "The API threw Error: ConnectError: [unavailable] ECONNRESET",
    });
    const updates: string[] = [];
    const result = await session.prompt("what next", updates);
    expect(updates).toEqual(["Retry the webhook."]);
    expect(result).toEqual({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    expect(session.logs.join("\n")).not.toContain("swallowed");
    await session.close();
  });

  test("respawns once when a flake turn is followed by child death", async () => {
    const seen: Array<{ launch: number; method?: string; params?: unknown; id?: string | number | null }> = [];
    let launches = 0;
    const session = await startHarness({
      handshake: "load",
      spawn: () => {
        launches += 1;
        const launch = launches;
        return fakeChild(launch === 1 ? "always-flake" : "ok", {
          successText: SUCCESS_TEXT,
          exitAfterPrompts: launch === 1 ? 1 : undefined,
          onRequest: (request) => seen.push({ launch, ...request }),
        });
      },
    });
    const updates: string[] = [];
    const result = await session.prompt("try again", updates);
    expect(launches).toBe(2);
    expect(result.id).toBe(3);
    expect(result.result).toEqual({ stopReason: "end_turn" });
    expect(updates).toEqual([SUCCESS_TEXT]);
    expect(session.logs.filter((line) => line.includes("replaying session/prompt")).length).toBe(1);
    expect(session.logs.some((line) => line.includes("respawning"))).toBe(true);
    expect(JSON.stringify(result.error ?? {})).not.toContain("after 3 attempts");
    await session.close();
  });

  test("replays session/new deaths as session/load with cwd and mcpServers", async () => {
    const secondChild: Array<{ method?: string; params?: unknown }> = [];
    let launches = 0;
    const session = await startHarness({
      handshake: "new",
      spawn: () => {
        launches += 1;
        const launch = launches;
        return fakeChild(launch === 1 ? "always-flake" : "ok", {
          exitAfterPrompts: launch === 1 ? 1 : undefined,
          onRequest: (request) => {
            if (launch === 2) secondChild.push(request);
          },
        });
      },
    });
    const result = await session.prompt("continue", []);
    expect(result.id).toBe(3);
    expect(result.result).toEqual({ stopReason: "end_turn" });
    expect(secondChild.some((request) => request.method === "session/new")).toBe(false);
    const load = secondChild.find((request) => request.method === "session/load");
    expect(load?.params).toEqual({
      sessionId: "sess-1",
      cwd: "/tmp/work",
      mcpServers: [{ name: "docs", command: "docs" }],
    });
    await session.close();
  });

  test("does not swallow flake text after a tool call already started", async () => {
    const flake = "\n\nError: ConnectError: [unavailable] HTTP/2 stream cancelled (NGHTTP2_CANCEL)";
    const session = await startSession("ok", { successText: flake, toolCallFirst: true });
    const updates: string[] = [];
    const result = await session.prompt("keep going", updates);
    expect(updates).toEqual([flake]);
    expect(result.result).toEqual({ stopReason: "end_turn" });
    expect(session.logs.join("\n")).not.toContain("swallowed");
    await session.close();
  });

  test("drops historical session/load updates during a synthetic re-handshake", async () => {
    let launches = 0;
    const session = await startHarness({
      handshake: "load",
      spawn: () => {
        launches += 1;
        const launch = launches;
        return fakeChild(launch === 1 ? "always-flake" : "ok", {
          exitAfterPrompts: launch === 1 ? 1 : undefined,
          loadHistory: launch === 2
            ? [
              { sessionUpdate: "user_message_chunk", text: "old user turn" },
              { sessionUpdate: "agent_message_chunk", text: "old assistant turn" },
              { sessionUpdate: "tool_call", toolCallId: "hist-tool" },
            ]
            : undefined,
        });
      },
    });
    await session.startPrompt("try again");
    const seen: JsonRpcMessage[] = [];
    while (true) {
      const message = await session.next();
      seen.push(message);
      if (message.result !== undefined || message.error !== undefined) break;
    }
    const dumped = JSON.stringify(seen);
    expect(dumped).not.toContain("old user turn");
    expect(dumped).not.toContain("old assistant turn");
    expect(dumped).not.toContain("hist-tool");
    expect(dumped).toContain(SUCCESS_TEXT);
    expect(seen.at(-1)?.id).toBe(3);
    expect(seen.at(-1)?.result).toEqual({ stopReason: "end_turn" });
    await session.close();
  });

  test("does not replay after a reverse child request has been forwarded", async () => {
    const session = await startSession("ok", { successText: FLAKE_TEXT, reverseRequest: true });
    const updates: string[] = [];
    const seen: JsonRpcMessage[] = [];
    await session.startPrompt("need approval");
    while (true) {
      const message = await session.next();
      seen.push(message);
      if (message.method === "session/update") {
        const update = (message.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update;
        if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) updates.push(update.content.text);
        continue;
      }
      if (message.result !== undefined || message.error !== undefined) {
        expect(message.id).toBe(3);
        expect(updates).toEqual([FLAKE_TEXT]);
        expect(seen.some((item) => item.method === "session/request_permission" && item.id === 99)).toBe(true);
        expect(session.logs.join("\n")).not.toContain("swallowed");
        break;
      }
    }
    await session.close();
  });

  test("fails instead of replaying after a streamed chunk if the child exits", async () => {
    let release!: () => void;
    const deferResult = new Promise<void>((resolve) => {
      release = resolve;
    });
    let child: ChildHandle | undefined;
    const session = await startHarness({
      handshake: "load",
      spawn: () => {
        child = fakeChild("ok", { deferResult });
        return child;
      },
    });
    await session.startPrompt("hi");
    const first = await session.next();
    expect((first.params as { update?: { content?: { text?: string } } }).update?.content?.text).toBe(SUCCESS_TEXT);
    child?.kill();
    const result = await session.next();
    expect(result.id).toBe(3);
    expect(result.error && typeof result.error === "object" && "code" in result.error ? result.error.code : undefined).toBe(STRUCTURED_ERROR_CODE);
    expect(JSON.stringify(result.error)).toContain("already visible");
    expect(session.logs.join("\n")).not.toContain("replaying session/prompt");
    release();
    await session.close();
  });

  test("fails instead of replaying after a reverse request if the child exits", async () => {
    const session = await startHarness({
      handshake: "load",
      spawn: () => fakeChild("ok", { reverseRequest: true, exitAfterReverse: true }),
    });
    await session.startPrompt("need approval");
    const first = await session.next();
    expect(first.method).toBe("session/request_permission");
    const result = await session.next();
    expect(result.id).toBe(3);
    expect(result.error && typeof result.error === "object" && "code" in result.error ? result.error.code : undefined).toBe(STRUCTURED_ERROR_CODE);
    expect(JSON.stringify(result.error)).toContain("already visible");
    expect(session.logs.join("\n")).not.toContain("replaying session/prompt");
    await session.close();
  });

  test("bounds consecutive pre-result child crashes to the retry budget", async () => {
    let launches = 0;
    const session = await startHarness({
      handshake: "load",
      maxRetries: 1,
      spawn: () => {
        launches += 1;
        return fakeChild("ok", { crashOnPrompt: true });
      },
    });
    const result = await session.prompt("keep crashing", []);
    expect(result.id).toBe(3);
    expect(result.error && typeof result.error === "object" && "code" in result.error ? result.error.code : undefined).toBe(STRUCTURED_ERROR_CODE);
    expect(launches).toBeLessThanOrEqual(3);
    expect(launches).toBeGreaterThan(1);
    expect(session.logs.some((line) => line.includes("structured failure"))).toBe(true);
    await session.close();
  });

  test("does not replay after a plan_update has been forwarded", async () => {
    const session = await startSession("ok", { successText: FLAKE_TEXT, extraUpdate: "plan_update" });
    const updates: string[] = [];
    const seen: JsonRpcMessage[] = [];
    await session.startPrompt("plan then flake");
    while (true) {
      const message = await session.next();
      seen.push(message);
      if (message.method === "session/update") {
        const update = (message.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update;
        if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) updates.push(update.content.text);
        continue;
      }
      if (message.result !== undefined || message.error !== undefined) {
        expect(message.id).toBe(3);
        expect(updates).toEqual([FLAKE_TEXT]);
        expect(seen.some((item) => (item.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "plan_update")).toBe(true);
        expect(session.logs.join("\n")).not.toContain("swallowed");
        break;
      }
    }
    await session.close();
  });

  test("maps a cancelled synthetic replay result back to T3's original prompt id", async () => {
    let replayId: string | number | undefined;
    const session = await startSession("flake-then-ok", {
      waitForCancel: true,
      onRequest: (request) => {
        if (request.method === "session/prompt" && request.id !== 3 && request.id != null) replayId = request.id;
      },
    });
    await session.startPrompt("try again");
    await waitFor(() => replayId !== undefined);
    await session.sendCancel();
    const result = await session.next();
    expect(result.id).toBe(3);
    expect(result.id).not.toBe(replayId);
    expect(result.result).toEqual({ stopReason: "cancelled" });
    await session.close();
  });

  test("idle child exit closes the ACP wrapper instead of leaving a zombie", async () => {
    let child: ChildHandle | undefined;
    const session = await startHarness({
      handshake: "load",
      spawn: () => {
        child = fakeChild("ok");
        return child;
      },
    });
    child?.kill();
    await Promise.race([
      session.done,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("shim remained a zombie ACP connection after idle child exit")), 500);
      }),
    ]);
  });

  test("closes the wrapper when synthetic session/load restore fails and the child stays alive", async () => {
    let launches = 0;
    const session = await startHarness({
      handshake: "load",
      spawn: () => {
        launches += 1;
        const launch = launches;
        return fakeChild(launch === 1 ? "always-flake" : "ok", {
          exitAfterPrompts: launch === 1 ? 1 : undefined,
          failLoad: launch === 2,
        });
      },
    });
    const result = await session.prompt("try again", []);
    expect(result.id).toBe(3);
    expect(result.error && typeof result.error === "object" && "code" in result.error ? result.error.code : undefined).toBe(STRUCTURED_ERROR_CODE);
    expect(JSON.stringify(result.error)).toContain("could not restore");
    await Promise.race([
      session.done,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("shim stayed open after failed session/load restore")), 500);
      }),
    ]);
    expect(launches).toBe(2);
  });

  test("preserves a normal child result when cancel races with completion", async () => {
    let release!: () => void;
    const deferReplayResult = new Promise<void>((resolve) => {
      release = resolve;
    });
    let replayId: string | number | undefined;
    const session = await startSession("flake-then-ok", {
      deferReplayResult,
      onRequest: (request) => {
        if (request.method === "session/prompt" && request.id !== 3 && request.id != null) replayId = request.id;
      },
    });
    await session.startPrompt("try again");
    await waitFor(() => replayId !== undefined);
    await session.sendCancel();
    release();
    while (true) {
      const message = await session.next();
      if (message.method === "session/update") continue;
      expect(message.id).toBe(3);
      expect(message.id).not.toBe(replayId);
      expect(message.result).toEqual({ stopReason: "end_turn" });
      break;
    }
    await session.close();
  });

  test("does not grant an extra prompt after a same-child replay is proven received", async () => {
    let prompts = 0;
    const session = await startHarness({
      handshake: "load",
      maxRetries: 1,
      spawn: () => fakeChild("flake-then-ok", {
        partialThenExit: true,
        onRequest: (request) => {
          if (request.method === "session/prompt") prompts += 1;
        },
      }),
    });
    const result = await session.prompt("try again", []);
    expect(result.id).toBe(3);
    expect(result.error && typeof result.error === "object" && "code" in result.error ? result.error.code : undefined).toBe(STRUCTURED_ERROR_CODE);
    expect(prompts).toBe(2);
    await session.close();
  });

  test("queues a second T3 prompt until the cancelled wire turn drains", async () => {
    let releaseCancelResult!: () => void;
    const deferCancelResult = new Promise<void>((resolve) => {
      releaseCancelResult = resolve;
    });
    const childRequests: FakeAcpRequest[] = [];
    let replayId: string | number | undefined;
    const session = await startSession("flake-then-ok", {
      waitForCancel: true,
      deferCancelResult,
      onRequest: (request) => {
        childRequests.push(request);
        if (request.method === "session/prompt" && request.id !== 3 && request.id != null && replayId === undefined) {
          replayId = request.id;
        }
      },
    });
    await session.startPrompt("first");
    await waitFor(() => replayId !== undefined);
    await session.sendCancel();
    await session.startPrompt("second", 4);
    try {
      await waitFor(() => childRequests.some((request) => request.id === 4), 40);
      throw new Error("queued session/prompt was forwarded to Cursor before the old wire turn drained");
    } catch (error) {
      expect((error as Error).message).toBe("timed out waiting for replay prompt");
    }
    expect(childRequests.filter((request) => request.method === "session/prompt")).toHaveLength(2);
    releaseCancelResult();
    const cancelled = await session.next();
    expect(cancelled.id).toBe(3);
    expect(cancelled.id).not.toBe(replayId);
    expect(cancelled.result).toEqual({ stopReason: "cancelled" });
    await waitFor(() => childRequests.some((request) => request.id === 4));
    const updates: string[] = [];
    while (true) {
      const message = await session.next();
      if (message.method === "session/update") {
        const update = (message.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update;
        if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) updates.push(update.content.text);
        continue;
      }
      expect(message.id).toBe(4);
      expect(message.result).toEqual({ stopReason: "end_turn" });
      expect(updates).toEqual([SUCCESS_TEXT]);
      expect(JSON.stringify(message)).not.toContain("ConnectError");
      break;
    }
    await session.close();
  });

  test("does not forward aborted death text after session/cancel", async () => {
    const death = "\n\nError: ConnectError: [aborted] aborted";
    const session = await startSession("ok", {
      holdUntilCancel: true,
      cancelDeathText: death,
    });
    await session.startPrompt("hi");
    await session.sendCancel();
    const seen: JsonRpcMessage[] = [];
    while (true) {
      const message = await session.next();
      seen.push(message);
      if (message.result !== undefined || message.error !== undefined) break;
    }
    const dumped = JSON.stringify(seen);
    expect(dumped).not.toContain("ConnectError");
    expect(dumped).not.toContain("[aborted]");
    expect(dumped).not.toContain("[cancelled]");
    expect(dumped).not.toContain("aborted");
    expect(seen.at(-1)?.id).toBe(3);
    expect(seen.at(-1)?.result).toEqual({ stopReason: "cancelled" });
    await session.close();
  });

  test("replays a lost write of the final same-child attempt on a replacement child", async () => {
    let launches = 0;
    const prompts: Array<{ launch: number; id?: string | number | null }> = [];
    const session = await startHarness({
      handshake: "load",
      maxRetries: 1,
      spawn: () => {
        launches += 1;
        const launch = launches;
        return fakeChild(launch === 1 ? "flake-then-ok" : "ok", {
          exitBeforeAnyFrameOnPrompt: launch === 1 ? 2 : undefined,
          onRequest: (request) => {
            if (request.method === "session/prompt") prompts.push({ launch, id: request.id });
          },
        });
      },
    });
    const updates: string[] = [];
    const result = await session.prompt("try again", updates);
    expect(result.id).toBe(3);
    expect(result.result).toEqual({ stopReason: "end_turn" });
    expect(updates).toEqual([SUCCESS_TEXT]);
    expect(launches).toBe(2);
    expect(prompts).toHaveLength(3);
    expect(prompts.filter((prompt) => prompt.launch === 2)).toHaveLength(1);
    await session.close();
  });

  test("streams a normal first chunk before the prompt result", async () => {
    let release!: () => void;
    const deferResult = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = await startSession("ok", { deferResult });
    await session.startPrompt("hi");
    const first = await Promise.race([
      session.next(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("normal chunk did not stream before session/prompt result")), 200);
      }),
    ]);
    expect(first.method).toBe("session/update");
    expect((first.params as { update?: { content?: { text?: string } } }).update?.content?.text).toBe(SUCCESS_TEXT);
    release();
    const result = await session.next();
    expect(result).toEqual({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    await session.close();
  });
});

async function startSession(mode: FakeAcpMode, options: {
  maxRetries?: number;
  successText?: string;
  thoughtText?: string;
  toolCallFirst?: boolean;
  reverseRequest?: boolean;
  extraUpdate?: string;
  waitForCancel?: boolean;
  holdUntilCancel?: boolean;
  cancelDeathText?: string;
  deferCancelResult?: Promise<void>;
  deferReplayResult?: Promise<void>;
  onRequest?: (request: FakeAcpRequest) => void;
  deferResult?: Promise<void>;
} = {}) {
  return startHarness({
    handshake: "load",
    maxRetries: options.maxRetries,
    spawn: () => fakeChild(mode, options),
  });
}

async function startHarness(options: {
  handshake: "load" | "new";
  maxRetries?: number;
  spawn: () => ChildHandle;
}) {
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
    spawn: options.spawn,
  });
  temporary.push(() => {
    t3stdin.end();
  });

  await send(t3stdin, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "t3" } } });
  expect((await inbound.next()).id).toBe(1);
  if (options.handshake === "new") {
    await send(t3stdin, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/tmp/work", mcpServers: [{ name: "docs", command: "docs" }] },
    });
  } else {
    await send(t3stdin, { jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "sess-1", cwd: "/tmp" } });
  }
  expect((await inbound.next()).id).toBe(2);

  return {
    logs,
    done: supervisor,
    next: () => inbound.next(),
    async sendCancel() {
      await send(t3stdin, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "sess-1" } });
    },
    async startPrompt(text: string, id: string | number = 3) {
      await send(t3stdin, {
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { sessionId: "sess-1", prompt: [{ type: "text", text }] },
      });
    },
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
          const update = (message.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update;
          if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) updates.push(update.content.text);
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

function fakeChild(mode: FakeAcpMode, options: {
  successText?: string;
  thoughtText?: string;
  toolCallFirst?: boolean;
  reverseRequest?: boolean;
  extraUpdate?: string;
  crashOnPrompt?: boolean;
  exitAfterReverse?: boolean;
  waitForCancel?: boolean;
  holdUntilCancel?: boolean;
  cancelDeathText?: string;
  deferCancelResult?: Promise<void>;
  exitBeforeAnyFrameOnPrompt?: number;
  partialThenExit?: boolean;
  failLoad?: boolean;
  deferReplayResult?: Promise<void>;
  loadHistory?: import("./fake-acp.ts").FakeAcpHistoryUpdate[];
  deferResult?: Promise<void>;
  exitAfterPrompts?: number;
  onRequest?: (request: FakeAcpRequest) => void;
} = {}): ChildHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let settle: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  void runFakeAcp({ stdin, stdout, mode, ...options }).then(() => {
    stdout.end();
    settle(0);
  }, () => settle(1));
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

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for replay prompt");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
