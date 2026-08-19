import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { extractAssistantText, isSpuriousNetworkDeath, sessionUpdateKind } from "./fingerprint.ts";
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
};

type Handshake = {
  initialize?: JsonRpcMessage;
  authenticate?: JsonRpcMessage;
  sessionLoad?: JsonRpcMessage;
};

const WORK_UPDATES = new Set(["tool_call", "tool_call_update", "plan"]);
const TEXT_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk"]);

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
  let nextSyntheticId = 1_000_000_001;
  let closedByT3 = false;
  let child = launchChild();

  const t3Loop = pumpT3();
  await t3Loop;
  closedByT3 = true;
  child.kill("SIGTERM");
  return 0;

  function launchChild(): ChildHandle {
    const handle = spawnChild(options.childCommand, options.childArgs);
    void pumpChild(handle);
    handle.stderr.on("data", (chunk: Buffer | string) => {
      options.io.stderr.write(chunk);
    });
    void handle.exited.then((code) => {
      void onChildExit(handle, code);
    });
    return handle;
  }

  async function pumpT3(): Promise<void> {
    for await (const frame of readFrames(options.io.stdin, style)) {
      style = frame.style;
      await onT3Frame(frame);
    }
  }

  async function pumpChild(handle: ChildHandle): Promise<void> {
    try {
      for await (const frame of readFrames(handle.stdout)) {
        if (handle !== child) continue;
        if (handshakeWaiter && isResponseTo(frame.message, handshakeWaiter.id)) {
          const waiter = handshakeWaiter;
          handshakeWaiter = undefined;
          waiter.resolve(frame.message);
          continue;
        }
        await onChildFrame(frame);
      }
    } catch (error) {
      if (!closedByT3) log(`t3-cursor-acp: child stdout closed (${errorString(error)})`);
    }
  }

  async function onT3Frame(frame: Frame): Promise<void> {
    const { message } = frame;
    if (message.method === "initialize") handshake.initialize = message;
    if (message.method === "authenticate") handshake.authenticate = message;
    if (message.method === "session/load") handshake.sessionLoad = message;
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
      await onChildPromptResult(frame);
      return;
    }
    if (frame.message.method === "session/update") {
      await onSessionUpdate(frame);
      return;
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
    if (kind && TEXT_UPDATES.has(kind)) {
      held.assistantText += extractAssistantText(frame.message);
      held.buffered.push(frame);
      if (held.assistantText.length > 1_500 && !isSpuriousNetworkDeath(held.assistantText)) {
        await flushHeld();
      }
      return;
    }
    await writeFrame(options.io.stdout, frame.bytes);
  }

  async function onChildPromptResult(frame: Frame): Promise<void> {
    if (!held) {
      await writeFrame(options.io.stdout, frame.bytes);
      return;
    }
    const flake = !held.sawWork && !held.flushed && isSpuriousNetworkDeath(held.assistantText);
    if (flake && held.attempts <= maxRetries) {
      log(`t3-cursor-acp: swallowed spurious Cursor ACP network death; replaying session/prompt (attempt ${held.attempts + 1}/${maxRetries + 1})`);
      await replayHeld(child.stdin.writable ? "same-child" : "respawn");
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

  async function replayHeld(mode: "same-child" | "respawn"): Promise<void> {
    if (!held) return;
    held.attempts += 1;
    held.assistantText = "";
    held.buffered = [];
    held.flushed = false;
    held.sawWork = false;
    if (mode === "respawn" || !child.stdin.writable) {
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
    } catch {
      if (held.attempts <= maxRetries) await replayHeld("respawn");
      else await failHeld("Cursor ACP child stdin closed while replaying session/prompt");
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
    const sessionId = heldSessionId();
    const load = handshake.sessionLoad ?? (sessionId
      ? { jsonrpc: "2.0", method: "session/load", params: { sessionId } }
      : undefined);
    if (!load) return false;
    const loaded = await roundTrip(load);
    if (!loaded || loaded.error) return false;
    return true;
  }

  function heldSessionId(): string | undefined {
    const params = held && held.params && typeof held.params === "object" && !Array.isArray(held.params)
      ? held.params as Record<string, unknown>
      : undefined;
    return typeof params?.sessionId === "string" ? params.sessionId : undefined;
  }

  async function roundTrip(template: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
    const id = nextSyntheticId++;
    const request: JsonRpcMessage = { ...template, jsonrpc: "2.0", id };
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
      return undefined;
    }
    return result;
  }

  async function onChildExit(handle: ChildHandle, code: number): Promise<void> {
    if (handle !== child || closedByT3) return;
    if (!held) return;
    if (held.attempts <= maxRetries) {
      log(`t3-cursor-acp: child exited ${code} during session/prompt; respawning`);
      await replayHeld("respawn");
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
  return message.id === id && (message.result !== undefined || message.error !== undefined);
}

function errorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
