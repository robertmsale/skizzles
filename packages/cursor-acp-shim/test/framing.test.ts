import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { encodeFrame, readFrames, tryExtractFrame } from "../src/framing.ts";

describe("ACP JSON-RPC framing", () => {
  test("round-trips NDJSON and Content-Length", () => {
    const message = { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s" } };
    const ndjson = encodeFrame(message, "ndjson");
    const lsp = encodeFrame(message, "content-length");
    expect(tryExtractFrame(ndjson)?.frame.style).toBe("ndjson");
    expect(tryExtractFrame(ndjson)?.frame.message).toEqual(message);
    expect(tryExtractFrame(lsp)?.frame.style).toBe("content-length");
    expect(tryExtractFrame(lsp)?.frame.message).toEqual(message);
  });

  test("reads a stream of NDJSON frames", async () => {
    const stream = new PassThrough();
    const done = (async () => {
      const frames = [];
      for await (const frame of readFrames(stream)) frames.push(frame.message.id);
      return frames;
    })();
    stream.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize" }, "ndjson"));
    stream.write(encodeFrame({ jsonrpc: "2.0", id: 2, method: "session/prompt" }, "ndjson"));
    stream.end();
    expect(await done).toEqual([1, 2]);
  });
});
