#!/usr/bin/env bun
import { encodeFrame, readFrames, writeFrame, type JsonRpcMessage } from "../src/framing.ts";

export const FLAKE_TEXT = "\n\nError: ConnectError: [unavailable] HTTP/2 stream cancelled (NGHTTP2_CANCEL)";
export const SUCCESS_TEXT = "hello from cursor";

export type FakeAcpMode = "ok" | "flake-then-ok" | "always-flake";

export type FakeAcpRequest = {
  method?: string;
  id?: string | number | null;
  params?: unknown;
};

export type FakeAcpHistoryUpdate = {
  sessionUpdate: string;
  text?: string;
  toolCallId?: string;
};

export async function runFakeAcp(options: {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  mode?: FakeAcpMode;
  flakeText?: string;
  successText?: string;
  exitAfterPrompts?: number;
  thoughtText?: string;
  toolCallFirst?: boolean;
  reverseRequest?: boolean;
  loadHistory?: FakeAcpHistoryUpdate[];
  deferResult?: Promise<void>;
  extraUpdate?: string;
  crashOnPrompt?: boolean;
  exitAfterReverse?: boolean;
  waitForCancel?: boolean;
  partialThenExit?: boolean;
  failLoad?: boolean;
  deferReplayResult?: Promise<void>;
  onRequest?: (request: FakeAcpRequest) => void;
}): Promise<void> {
  const mode = options.mode ?? (process.env.FAKE_ACP_MODE as FakeAcpMode | undefined) ?? "ok";
  const flakeText = options.flakeText ?? process.env.FAKE_ACP_FLAKE_TEXT ?? FLAKE_TEXT;
  const successText = options.successText ?? SUCCESS_TEXT;
  let prompts = 0;
  let cancelled = false;
  let notifyCancel: (() => void) | undefined;
  for await (const frame of readFrames(options.stdin as import("node:stream").Readable)) {
    const { message } = frame;
    options.onRequest?.({ method: message.method, id: message.id, params: message.params });
    if (message.method === "session/cancel") {
      cancelled = true;
      notifyCancel?.();
      continue;
    }
    if (message.method === "initialize") {
      await reply(options.stdout, message, { protocolVersion: 1, agentCapabilities: {} });
      continue;
    }
    if (message.method === "authenticate") {
      await reply(options.stdout, message, {});
      continue;
    }
    if (message.method === "session/new" || message.method === "session/load") {
      const params = asRecord(message.params);
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "sess-1";
      if (message.method === "session/load" && options.failLoad) {
        await writeFrame(options.stdout as import("node:stream").Writable, encodeFrame({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32603, message: "session not found" },
        }, frame.style));
        continue;
      }
      if (message.method === "session/load") {
        for (const update of options.loadHistory ?? []) {
          await writeFrame(options.stdout as import("node:stream").Writable, encodeFrame({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: update.sessionUpdate === "tool_call"
                ? { sessionUpdate: "tool_call", toolCallId: update.toolCallId ?? "hist-1", title: "old", kind: "execute", status: "pending" }
                : { sessionUpdate: update.sessionUpdate, content: { type: "text", text: update.text ?? "" } },
            },
          }, frame.style));
        }
      }
      await reply(options.stdout, message, { sessionId });
      continue;
    }
    if (message.method === "session/prompt") {
      prompts += 1;
      if (options.crashOnPrompt) return;
      const flake = mode === "always-flake" || (mode === "flake-then-ok" && prompts === 1);
      if (options.partialThenExit && prompts >= 2) {
        const params = asRecord(message.params);
        const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "sess-1";
        await writeFrame(options.stdout as import("node:stream").Writable, encodeFrame({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Error:" } },
          },
        }, frame.style));
        return;
      }
      if (options.deferReplayResult && prompts >= 2) {
        if (options.deferReplayResult) await options.deferReplayResult;
        const params = asRecord(message.params);
        const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "sess-1";
        await writeFrame(options.stdout as import("node:stream").Writable, encodeFrame({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: successText } },
          },
        }, frame.style));
        await reply(options.stdout, message, { stopReason: "end_turn" });
        continue;
      }
      if (options.waitForCancel && prompts >= 2) {
        const request = message;
        void (async () => {
          if (!cancelled) {
            await new Promise<void>((resolve) => {
              notifyCancel = resolve;
            });
          }
          await reply(options.stdout, request, { stopReason: "cancelled" });
        })();
        continue;
      }
      const text = flake ? flakeText : successText;
      const params = asRecord(message.params);
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "sess-1";
      if (options.reverseRequest) {
        await writeFrame(options.stdout as import("node:stream").Writable, encodeFrame({
          jsonrpc: "2.0",
          id: 99,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "call-1", title: "ls", kind: "execute" },
            options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
          },
        }, frame.style));
        if (options.exitAfterReverse) return;
      }
      if (options.extraUpdate) {
        await writeFrame(options.stdout as import("node:stream").Writable, encodeFrame({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: options.extraUpdate, entries: [{ content: "plan" }] },
          },
        }, frame.style));
      }
      if (options.toolCallFirst) {
        await writeFrame(options.stdout as import("node:stream").Writable, encodeFrame({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "curl", kind: "execute", status: "pending" },
          },
        }, frame.style));
      }
      if (options.thoughtText) {
        await writeFrame(options.stdout as import("node:stream").Writable, encodeFrame({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: options.thoughtText } },
          },
        }, frame.style));
      }
      await writeFrame(options.stdout as import("node:stream").Writable, encodeFrame({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      }, frame.style));
      if (options.deferResult) await options.deferResult;
      await reply(options.stdout, message, { stopReason: "end_turn" });
      if (options.exitAfterPrompts && prompts >= options.exitAfterPrompts) return;
      continue;
    }
    if (message.id !== undefined && message.id !== null) {
      await reply(options.stdout, message, {});
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function reply(stdout: NodeJS.WritableStream, request: JsonRpcMessage, result: unknown): Promise<void> {
  await writeFrame(stdout as import("node:stream").Writable, encodeFrame({
    jsonrpc: "2.0",
    id: request.id ?? null,
    result,
  }, "ndjson"));
}

if (import.meta.main) {
  await runFakeAcp({ stdin: process.stdin, stdout: process.stdout });
}
