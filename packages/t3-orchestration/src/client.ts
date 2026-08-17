import { connect } from "node:net";
import { SOCKET_PATH } from "./config.ts";
import { normalizeRemoteUrl } from "./remote-config.ts";

type DaemonResponse = { ok: boolean; result?: unknown; error?: string };

export const CLIENT_DEADLINE_MS = 60_000;
export const WAIT_RESPONSE_BUFFER_MS = 2_000;
const CLIENT_DEADLINE_ENV = "T3_ORCHESTRATION_CLIENT_DEADLINE_MS";

export function formatClientDeadline(deadlineMs: number): string {
  return deadlineMs % 1000 === 0 ? `${deadlineMs / 1000}s` : `${deadlineMs}ms`;
}

export function clientTimeoutMessage(op: unknown, deadlineMs: number): string {
  const operation = typeof op === "string" && op.trim() ? op.trim() : "request";
  return `t3ctl ${operation} timed out after ${formatClientDeadline(deadlineMs)}`;
}

export function clientTimeoutError(op: unknown, deadlineMs: number): Error {
  return new Error(clientTimeoutMessage(op, deadlineMs));
}

function parseDeadlineMs(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

export function resolveClientDeadlineMs(overrideMs?: number): number {
  const override = parseDeadlineMs(overrideMs);
  if (override !== undefined) return Math.min(override, CLIENT_DEADLINE_MS);
  const injected = parseDeadlineMs(process.env[CLIENT_DEADLINE_ENV]);
  if (injected !== undefined) return Math.min(injected, CLIENT_DEADLINE_MS);
  return CLIENT_DEADLINE_MS;
}

export function maxWaitTimeoutMs(deadlineMs = CLIENT_DEADLINE_MS): number {
  return Math.max(0, deadlineMs - WAIT_RESPONSE_BUFFER_MS);
}

export function clampWaitTimeoutMs(requestedMs: number, deadlineMs = CLIENT_DEADLINE_MS): number {
  if (!Number.isInteger(requestedMs) || requestedMs < 0) return 0;
  return Math.min(requestedMs, maxWaitTimeoutMs(deadlineMs));
}

export function createClientDeadline(deadlineMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deadlineMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function whenAborted(signal: AbortSignal, op: unknown, deadlineMs: number): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(clientTimeoutError(op, deadlineMs));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

export function daemonRequest(
  payload: Record<string, unknown>,
  socketPath = SOCKET_PATH,
  deadlineMs = resolveClientDeadlineMs(),
  remoteUrl?: string,
): Promise<DaemonResponse> {
  const resolvedDeadlineMs = resolveClientDeadlineMs(deadlineMs);
  if (remoteUrl) return remoteDaemonRequest(payload, remoteUrl, resolvedDeadlineMs);
  return localDaemonRequest(payload, socketPath, resolvedDeadlineMs);
}

function localDaemonRequest(
  payload: Record<string, unknown>,
  socketPath: string,
  deadlineMs: number,
): Promise<DaemonResponse> {
  const deadline = createClientDeadline(deadlineMs);
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      deadline.dispose();
      callback();
    };
    const failWithTimeout = () => {
      finish(() => {
        socket.destroy();
        reject(clientTimeoutError(payload.op, deadlineMs));
      });
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      finish(() => {
        socket.end();
        try { resolve(JSON.parse(line) as DaemonResponse); }
        catch { reject(new Error("t3-orchestrationd returned malformed JSON")); }
      });
    });
    socket.once("error", (error) => {
      if (deadline.signal.aborted) {
        failWithTimeout();
        return;
      }
      finish(() => {
        const code = "code" in error ? String(error.code) : "";
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          reject(new Error("t3-orchestrationd is unavailable. From a full Skizzles checkout or plugin snapshot, run `bun run packages/t3-orchestration/scripts/install.ts` to install and start its LaunchAgent."));
        } else reject(error);
      });
    });
    socket.once("end", () => {
      if (deadline.signal.aborted) {
        failWithTimeout();
        return;
      }
      finish(() => reject(new Error("t3-orchestrationd closed without a complete response")));
    });
    if (deadline.signal.aborted) {
      failWithTimeout();
      return;
    }
    deadline.signal.addEventListener("abort", failWithTimeout, { once: true });
    socket.write(`${JSON.stringify(payload)}\n`);
  });
}

async function remoteDaemonRequest(
  payload: Record<string, unknown>,
  remoteUrl: string,
  deadlineMs: number,
): Promise<DaemonResponse> {
  const endpoint = normalizeRemoteUrl(remoteUrl);
  const deadline = createClientDeadline(deadlineMs);
  const timedOut = whenAborted(deadline.signal, payload.op, deadlineMs);
  void timedOut.catch(() => undefined);
  let request: Promise<Response> | undefined;
  try {
    request = fetch(`${endpoint}/v1/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: deadline.signal,
    });
    const response = await Promise.race([request, timedOut]);
    if (response.status >= 300 && response.status < 400) {
      throw new Error("remote t3-orchestrationd redirect rejected");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 1_048_576) throw new Error("remote daemon response exceeds 1 MiB");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("remote t3-orchestrationd returned an empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        if (deadline.signal.aborted) throw clientTimeoutError(payload.op, deadlineMs);
        const { done, value } = await Promise.race([reader.read(), timedOut]);
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) {
          await reader.cancel();
          throw new Error("remote daemon response exceeds 1 MiB");
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(combined);
    let body: DaemonResponse;
    try { body = JSON.parse(text) as DaemonResponse; }
    catch { throw new Error("remote t3-orchestrationd returned malformed JSON"); }
    if (!response.ok) throw new Error(body.error || `remote t3-orchestrationd failed with HTTP ${response.status}`);
    return body;
  } catch (error) {
    if (request) void request.catch(() => undefined);
    if (deadline.signal.aborted || isAbortError(error)) {
      throw clientTimeoutError(payload.op, deadlineMs);
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}
