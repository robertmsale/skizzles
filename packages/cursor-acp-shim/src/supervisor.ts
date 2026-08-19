import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { couldBecomeSpuriousNetworkDeath, extractAssistantText, isSpuriousNetworkDeath, sessionUpdateKind } from "./fingerprint.ts";
import { encodeFrame, readFrames, writeFrame, type Frame, type FrameStyle, type JsonRpcMessage } from "./framing.ts";

export const DEFAULT_MAX_RETRIES = 2;
export const STRUCTURED_ERROR_CODE = -32_000;

export type SupervisorIo = {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
};

export type SpawnChild = (command: string, args: string[]) => ChildHandle;

export type ChildHandle = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => void;
};

export type SupervisorOptions = {
  childCommand: string;
  childArgs: string[];
  io: SupervisorIo;
  spawn?: SpawnChild;
  maxRetries?: number;
  log?: (line: string) => void;
};

type HeldRequest = {
  method: string;
  params: unknown;
  t3Id: string | number;
  childId: string | number;
  style: FrameStyle;
  assistantText: string;
  buffered: Frame[];
  flushed: boolean;
  sawWork: boolean;
  attempts: number;
  replaying: boolean;
};

type Handshake = {
  initialize?: JsonRpcMessage;
  authenticate?: JsonRpcMessage;
  sessionLoad?: JsonRpcMessage;
  sessionNew?: JsonRpcMessage;
};

const WORK_UPDATES = new Set(["tool_call", "tool_call_update", "plan"]);
const BUFFERED_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk"]);

export async function runSupervisor(options: SupervisorOptions): Promise<number> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const log = options.log ?? ((line: string) => {
    options.io.stderr.write(`${line}\n`);
  });
  const spawnChild = options.spawn ?? spawnRealChild;
  const handshake: Handshake = {};
  let style: FrameStyle = "ndjson";
  let held: HeldRequest | undefined;
  let handshakeWaiter: { id: string | number; resolve: (message: JsonRpcMessage | undefined) => void } | undefined;
  let suppressLoad: { loadId: string | number; sessionId?: string } | undefined;
  let nextSyntheticId = 1_000_000_001;
  let closedByT3 = false;
  let childGeneration = 0;
  let childClosed = false;
  let child = launchChild();
  let heldLock: Promise<void> = Promise.resolve();

  const t3Loop = pumpT3();
  await t3Loop;
  closedByT3 = true;
  child.kill("SIGTERM");
  return 0;

  function withHeld(work: () => Promise<void>): Promise<void> {
    const run = heldLock.then(work, work);
    heldLock = run.then(() => undefined, () => undefined);
    return run;
  }

  function launchChild(): ChildHandle {
    childGeneration += 1;
    childClosed = false;
    const generation = childGeneration;
    const handle = spawnChild(options.childCommand, options.childArgs);
    void pumpChild(handle, generation);
    handle.stderr.on("data", (chunk: Buffer | string) => {
      options.io.stderr.write(chunk);
    });
    void handle.exited.then((code) => {
      if (generation === childGeneration) childClosed = true;
      void withHeld(() => onChildExit(handle, generation, code));
    });
    return handle;
  }

  function childAlive(): boolean {
    return !childClosed && child.stdin.writable;
  }

  async function pumpT3(): Promise<void> {
    for await (const frame of readFrames(options.io.stdin, style)) {
      style = frame.style;
      await onT3Frame(frame);
    }
  }

  async function pumpChild(handle: ChildHandle, generation: number): Promise<void> {
    try {
      for await (const frame of readFrames(handle.stdout)) {
        if (generation !== childGeneration) continue;
        if (handshakeWaiter && isResponseTo(frame.message, handshakeWaiter.id)) {
          const waiter = handshakeWaiter;
          handshakeWaiter = undefined;
          waiter.resolve(frame.message);
          continue;
        }
        if (shouldDropReplayLoadTraffic(frame.message)) continue;
        await onChildFrame(frame);
      }
    } catch (error) {
      if (!closedByT3) log(`t3-cursor-acp: child stdout closed (${errorString(error)})`);
    } finally {
      if (generation === childGeneration) childClosed = true;
    }
  }

  async function onT3Frame(frame: Frame): Promise<void> {
    const { message } = frame;
    if (message.method === "initialize") handshake.initialize = message;
    if (message.method === "authenticate") handshake.authenticate = message;
    if (message.method === "session/load") handshake.sessionLoad = message;
    if (message.method === "session/new") handshake.sessionNew = message;
    if (message.method === "session/cancel") {
      held = undefined;
      await writeChild(frame.bytes);
      return;
    }
    if (message.method === "session/prompt" && message.id !== undefined && message.id !== null) {
      held = {
        method: message.method,
        params: message.params,
        t3Id: message.id,
        childId: message.id,
        style: frame.style,
        assistantText: "",
        buffered: [],
        flushed: false,
        sawWork: false,
        attempts: 1,
        replaying: false,
      };
    }
    await writeChild(frame.bytes);
  }

  async function onChildFrame(frame: Frame): Promise<void> {
    if (!held) {
      await writeFrame(options.io.stdout, frame.bytes);
      return;
    }
    if (isResponseTo(frame.message, held.childId)) {
      await withHeld(() => onChildPromptResult(frame));
      return;
    }
    if (frame.message.method === "session/update") {
      await onSessionUpdate(frame);
      return;
    }
    if (isChildClientRequest(frame.message) && held && !held.flushed) {
      held.sawWork = true;
      await flushHeld();
    }
    await writeFrame(options.io.stdout, frame.bytes);
  }

  async function onSessionUpdate(frame: Frame): Promise<void> {
    if (!held || held.flushed) {
      await writeFrame(options.io.stdout, frame.bytes);
      return;
    }
    const kind = sessionUpdateKind(frame.message);
    if (kind && WORK_UPDATES.has(kind)) {
      held.sawWork = true;
      await flushHeld();
      await writeFrame(options.io.stdout, frame.bytes);
      return;
    }
    if (kind && BUFFERED_UPDATES.has(kind)) {
      if (kind === "agent_message_chunk") held.assistantText += extractAssistantText(frame.message);
      held.buffered.push(frame);
      if (!couldBecomeSpuriousNetworkDeath(held.assistantText)) {
        await flushHeld();
      }
      return;
    }
    await writeFrame(options.io.stdout, frame.bytes);
  }

  async function onChildPromptResult(frame: Frame): Promise<void> {
    if (!held || held.replaying) {
      if (!held) await writeFrame(options.io.stdout, frame.bytes);
      return;
    }
    const flake = !held.sawWork && !held.flushed && isSpuriousNetworkDeath(held.assistantText);
    if (flake && held.attempts <= maxRetries) {
      log(`t3-cursor-acp: swallowed spurious Cursor ACP network death; replaying session/prompt (attempt ${held.attempts + 1}/${maxRetries + 1})`);
      await replayHeld(childAlive() ? "same-child" : "respawn", true);
      return;
    }
    if (flake) {
      await failHeld(`Cursor ACP stream failed after ${held.attempts} attempts: ${held.assistantText.trim().slice(0, 240)}`);
      return;
    }
    await flushHeld();
    await writeMappedResult(frame.message, held.t3Id, held.style);
    held = undefined;
  }

  async function replayHeld(mode: "same-child" | "respawn", countAttempt: boolean): Promise<void> {
    if (!held || held.replaying) return;
    held.replaying = true;
    try {
      let nextMode = mode;
      let increment = countAttempt;
      while (held) {
        if (increment) {
          if (held.attempts > maxRetries) {
            await failHeld(`Cursor ACP stream failed after ${held.attempts} attempts`);
            return;
          }
          held.attempts += 1;
        }
        increment = true;
        held.assistantText = "";
        held.buffered = [];
        held.flushed = false;
        held.sawWork = false;
        if (nextMode === "respawn" || !childAlive()) {
          log("t3-cursor-acp: child dead or wedged; respawning and re-handshaking for replay");
          const ok = await respawnAndHandshake();
          if (!ok) {
            await failHeld("Cursor ACP child died; could not restore a visible session for replay");
            return;
          }
        }
        const childId = nextSyntheticId++;
        held.childId = childId;
        const request: JsonRpcMessage = {
          jsonrpc: "2.0",
          id: childId,
          method: held.method,
          params: held.params,
        };
        try {
          await writeChild(encodeFrame(request, held.style));
          return;
        } catch {
          nextMode = "respawn";
          increment = false;
        }
      }
    } finally {
      if (held) held.replaying = false;
    }
  }

  async function respawnAndHandshake(): Promise<boolean> {
    const previous = child;
    child = launchChild();
    try {
      previous.kill("SIGTERM");
    } catch { /* already gone */ }
    if (handshake.initialize) {
      const result = await roundTrip(handshake.initialize);
      if (!result || result.error) return false;
    }
    if (handshake.authenticate) {
      const result = await roundTrip(handshake.authenticate);
      if (!result || result.error) return false;
    }
    const load = sessionLoadForReplay();
    if (!load) return false;
    const loaded = await roundTrip(load);
    if (!loaded || loaded.error) return false;
    return true;
  }

  function sessionLoadForReplay(): JsonRpcMessage | undefined {
    const sessionId = heldSessionId();
    if (!sessionId) return undefined;
    const loadParams = asRecord(handshake.sessionLoad?.params);
    const newParams = asRecord(handshake.sessionNew?.params);
    const cwd = firstString(loadParams?.cwd, newParams?.cwd);
    const mcpServers = loadParams?.mcpServers ?? newParams?.mcpServers;
    const params: Record<string, unknown> = { sessionId };
    if (cwd !== undefined) params.cwd = cwd;
    if (mcpServers !== undefined) params.mcpServers = mcpServers;
    return { jsonrpc: "2.0", method: "session/load", params };
  }

  function heldSessionId(): string | undefined {
    return firstString(asRecord(held?.params)?.sessionId);
  }

  async function roundTrip(template: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
    const id = nextSyntheticId++;
    const request: JsonRpcMessage = { ...template, jsonrpc: "2.0", id };
    const suppressingLoad = template.method === "session/load";
    if (suppressingLoad) {
      suppressLoad = {
        loadId: id,
        sessionId: firstString(asRecord(template.params)?.sessionId),
      };
    }
    const result = new Promise<JsonRpcMessage | undefined>((resolve) => {
      const timer = setTimeout(() => {
        if (handshakeWaiter?.id === id) handshakeWaiter = undefined;
        resolve(undefined);
      }, 15_000);
      handshakeWaiter = {
        id,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
    });
    try {
      await writeChild(encodeFrame(request, style));
    } catch {
      if (handshakeWaiter?.id === id) handshakeWaiter = undefined;
      if (suppressingLoad) suppressLoad = undefined;
      return undefined;
    }
    try {
      return await result;
    } finally {
      if (suppressingLoad && suppressLoad?.loadId === id) suppressLoad = undefined;
    }
  }

  function shouldDropReplayLoadTraffic(message: JsonRpcMessage): boolean {
    if (!suppressLoad) return false;
    if (isResponseTo(message, suppressLoad.loadId)) return false;
    if (message.method === "session/update") {
      const sessionId = firstString(asRecord(message.params)?.sessionId);
      return !sessionId || !suppressLoad.sessionId || sessionId === suppressLoad.sessionId;
    }
    return true;
  }

  async function onChildExit(handle: ChildHandle, generation: number, code: number): Promise<void> {
    if (generation !== childGeneration || closedByT3) return;
    if (!held || held.replaying) return;
    const replayWriteLost = held.attempts > 1;
    if (held.attempts <= maxRetries || replayWriteLost) {
      log(`t3-cursor-acp: child exited ${code} during session/prompt; respawning`);
      await replayHeld("respawn", !replayWriteLost);
      return;
    }
    await failHeld(`Cursor ACP child exited (${code}) after ${held.attempts} attempts`);
  }

  async function failHeld(message: string): Promise<void> {
    if (!held) return;
    log(`t3-cursor-acp: structured failure: ${message}`);
    const error: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: held.t3Id,
      error: { code: STRUCTURED_ERROR_CODE, message },
    };
    await writeFrame(options.io.stdout, encodeFrame(error, held.style));
    held = undefined;
  }

  async function flushHeld(): Promise<void> {
    if (!held || held.flushed) return;
    held.flushed = true;
    for (const frame of held.buffered) await writeFrame(options.io.stdout, frame.bytes);
    held.buffered = [];
  }

  async function writeMappedResult(message: JsonRpcMessage, t3Id: string | number, frameStyle: FrameStyle): Promise<void> {
    await writeFrame(options.io.stdout, encodeFrame({ ...message, id: t3Id }, frameStyle));
  }

  async function writeChild(bytes: Buffer): Promise<void> {
    await writeFrame(child.stdin, bytes);
  }
}

export function spawnRealChild(command: string, args: string[]): ChildHandle {
  const subprocess: ChildProcessWithoutNullStreams = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdin: subprocess.stdin,
    stdout: subprocess.stdout,
    stderr: subprocess.stderr,
    pid: subprocess.pid,
    exited: new Promise((resolve) => {
      subprocess.once("close", (code) => resolve(code ?? 1));
    }),
    kill: (signal) => {
      try {
        subprocess.kill(signal);
      } catch { /* already gone */ }
    },
  };
}

function isResponseTo(message: JsonRpcMessage, id: string | number): boolean {
  return message.id !== undefined && message.id !== null
    && String(message.id) === String(id)
    && (message.result !== undefined || message.error !== undefined);
}

function isChildClientRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === "string"
    && message.method !== "session/update"
    && message.id !== undefined
    && message.id !== null
    && message.result === undefined
    && message.error === undefined;
}

function errorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
