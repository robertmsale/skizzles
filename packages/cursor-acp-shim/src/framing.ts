import type { Readable, Writable } from "node:stream";

export type FrameStyle = "ndjson" | "content-length";

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export type Frame = {
  bytes: Buffer;
  message: JsonRpcMessage;
  style: FrameStyle;
};

const CONTENT_LENGTH = /^content-length:\s*(\d+)\r\n\r\n/i;

export function encodeFrame(message: JsonRpcMessage, style: FrameStyle): Buffer {
  const json = JSON.stringify(message);
  if (style === "content-length") {
    const body = Buffer.from(json, "utf8");
    return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf8"), body]);
  }
  return Buffer.from(`${json}\n`, "utf8");
}

export function tryExtractFrame(buffer: Buffer, locked?: FrameStyle): { frame: Frame; rest: Buffer } | undefined {
  if (buffer.byteLength === 0) return undefined;
  let offset = 0;
  while (offset < buffer.byteLength && (buffer[offset] === 0x0a || buffer[offset] === 0x0d)) offset++;
  if (offset >= buffer.byteLength) {
    return offset > 0 ? undefined : undefined;
  }
  const view = offset > 0 ? buffer.subarray(offset) : buffer;
  const style = locked ?? detectStyle(view);
  if (style === "content-length") return extractContentLength(buffer, offset);
  return extractNdjson(buffer, offset);
}

function detectStyle(buffer: Buffer): FrameStyle {
  const head = buffer.subarray(0, Math.min(buffer.byteLength, 32)).toString("latin1");
  if (/^content-length:/i.test(head)) return "content-length";
  return "ndjson";
}

function extractContentLength(buffer: Buffer, offset: number): { frame: Frame; rest: Buffer } | undefined {
  const view = buffer.subarray(offset);
  const header = view.subarray(0, Math.min(view.byteLength, 80)).toString("latin1");
  const match = CONTENT_LENGTH.exec(header);
  if (!match) {
    if (view.includes(0x0a) && !/^content-length:/i.test(header)) return undefined;
    return undefined;
  }
  const size = Number(match[1]);
  if (!Number.isInteger(size) || size < 0 || size > 16 * 1024 * 1024) return undefined;
  const headerBytes = Buffer.byteLength(match[0], "latin1");
  if (view.byteLength < headerBytes + size) return undefined;
  const body = view.subarray(headerBytes, headerBytes + size);
  const bytes = buffer.subarray(offset, offset + headerBytes + size);
  return {
    frame: { bytes, message: parseJson(body), style: "content-length" },
    rest: buffer.subarray(offset + headerBytes + size),
  };
}

function extractNdjson(buffer: Buffer, offset: number): { frame: Frame; rest: Buffer } | undefined {
  const view = buffer.subarray(offset);
  const newline = view.indexOf(0x0a);
  if (newline < 0) return undefined;
  let end = newline;
  if (end > 0 && view[end - 1] === 0x0d) end--;
  const body = view.subarray(0, end);
  const bytes = buffer.subarray(offset, offset + newline + 1);
  if (body.byteLength === 0) {
    return tryExtractFrame(buffer.subarray(offset + newline + 1));
  }
  return {
    frame: { bytes, message: parseJson(body), style: "ndjson" },
    rest: buffer.subarray(offset + newline + 1),
  };
}

function parseJson(body: Buffer): JsonRpcMessage {
  const parsed: unknown = JSON.parse(body.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ACP frame is not a JSON-RPC object");
  }
  return parsed as JsonRpcMessage;
}

export async function* readFrames(input: Readable, locked?: FrameStyle): AsyncGenerator<Frame> {
  let buffer: Buffer = Buffer.alloc(0);
  let style = locked;
  for await (const chunk of input) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, next]);
    while (true) {
      let extracted: { frame: Frame; rest: Buffer } | undefined;
      try {
        extracted = tryExtractFrame(buffer, style);
      } catch {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        buffer = buffer.subarray(newline + 1);
        continue;
      }
      if (!extracted) break;
      style = extracted.frame.style;
      buffer = extracted.rest;
      yield extracted.frame;
    }
  }
}

export function writeFrame(output: Writable, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(bytes, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
