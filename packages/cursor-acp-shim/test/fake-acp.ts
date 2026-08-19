#!/usr/bin/env bun
import { encodeFrame, readFrames, writeFrame, type JsonRpcMessage } from "../src/framing.ts";

export const FLAKE_TEXT = "\n\nError: ConnectError: [unavailable] HTTP/2 stream cancelled (NGHTTP2_CANCEL)";
export const SUCCESS_TEXT = "hello from cursor";

export type FakeAcpMode = "ok" | "flake-then-ok" | "always-flake";

export async function runFakeAcp(options: {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  mode?: FakeAcpMode;
  flakeText?: string;
  successText?: string;
  exitAfterPrompts?: number;
}): Promise<void> {
  const mode = options.mode ?? (process.env.FAKE_ACP_MODE as FakeAcpMode | undefined) ?? "ok";
  const flakeText = options.flakeText ?? process.env.FAKE_ACP_FLAKE_TEXT ?? FLAKE_TEXT;
  const successText = options.successText ?? SUCCESS_TEXT;
  let prompts = 0;
  for await (const frame of readFrames(options.stdin as import("node:stream").Readable)) {
    const { message } = frame;
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
      await reply(options.stdout, message, { sessionId });
      continue;
    }
    if (message.method === "session/prompt") {
      prompts += 1;
      const flake = mode === "always-flake" || (mode === "flake-then-ok" && prompts === 1);
      const text = flake ? flakeText : successText;
      const params = asRecord(message.params);
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "sess-1";
      await writeFrame(options.stdout as import("node:stream").Writable, encodeFrame({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      }, frame.style));
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
