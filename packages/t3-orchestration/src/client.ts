import { connect } from "node:net";
import { SOCKET_PATH } from "./config.ts";
import { normalizeRemoteUrl } from "./remote-config.ts";

type DaemonResponse = { ok: boolean; result?: unknown; error?: string };

export function daemonResponseTimeoutMs(payload: Record<string, unknown>): number {
  if (payload.op !== "tasks.wait") return 240_000;
  const waitTimeoutMs = Number(payload.timeoutMs);
  if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 3_600_000) return 240_000;
  return waitTimeoutMs + 30_000;
}

export function daemonRequest(
  payload: Record<string, unknown>,
  socketPath = SOCKET_PATH,
  responseTimeoutMs = daemonResponseTimeoutMs(payload),
  remoteUrl?: string,
): Promise<DaemonResponse> {
  if (remoteUrl) return remoteDaemonRequest(payload, remoteUrl, responseTimeoutMs);
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() => { socket.destroy(); reject(new Error(`t3-orchestrationd did not respond within ${responseTimeoutMs} milliseconds`)); });
    }, responseTimeoutMs);
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
      finish(() => {
        const code = "code" in error ? String(error.code) : "";
        if (code === "ENOENT" || code === "ECONNREFUSED") reject(new Error("t3-orchestrationd is unavailable. Run `bun run install-global` in the t3-orchestration project to install and start its LaunchAgent."));
        else reject(error);
      });
    });
    socket.once("end", () => finish(() => reject(new Error("t3-orchestrationd closed without a complete response"))));
    socket.write(`${JSON.stringify(payload)}\n`);
  });
}

async function remoteDaemonRequest(
  payload: Record<string, unknown>,
  remoteUrl: string,
  responseTimeoutMs: number,
): Promise<DaemonResponse> {
  const endpoint = normalizeRemoteUrl(remoteUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), responseTimeoutMs);
  try {
    const response = await fetch(`${endpoint}/v1/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("remote t3-orchestrationd redirect rejected");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 1_048_576) throw new Error("remote daemon response exceeds 1 MiB");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("remote t3-orchestrationd returned an empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) {
        await reader.cancel();
        throw new Error("remote daemon response exceeds 1 MiB");
      }
      chunks.push(value);
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
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`remote t3-orchestrationd did not respond within ${responseTimeoutMs} milliseconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
