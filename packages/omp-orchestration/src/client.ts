import { connect } from "node:net";
import { SOCKET_PATH } from "./config.ts";
import { isRecord, type DaemonResponse } from "./protocol.ts";

export const CLIENT_DEADLINE_MS = 60_000;

export async function daemonRequest(
  payload: Record<string, unknown>,
  options: { socketPath?: string; remoteUrl?: string; token?: string; deadlineMs?: number } = {},
): Promise<DaemonResponse> {
  const deadlineMs = options.deadlineMs ?? CLIENT_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > CLIENT_DEADLINE_MS) throw new Error("invalid client deadline");
  return options.remoteUrl
    ? remoteRequest(payload, normalizeRemoteUrl(options.remoteUrl), options.token, deadlineMs)
    : localRequest(payload, options.socketPath ?? SOCKET_PATH, deadlineMs);
}

function localRequest(payload: Record<string, unknown>, socketPath: string, deadlineMs: number): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(() => { socket.destroy(); reject(new Error(`ompctl request timed out after ${deadlineMs}ms`)); }), deadlineMs);
    timer.unref?.();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      finish(() => {
        socket.end();
        try { resolve(parseDaemonResponse(buffer.slice(0, newline), "omp-orchestrationd")); }
        catch (error) { reject(error); }
      });
    });
    socket.once("error", (error) => finish(() => {
      const code = "code" in error ? String(error.code) : "";
      reject(code === "ENOENT" || code === "ECONNREFUSED"
        ? new Error("omp-orchestrationd is unavailable; install or start the Skizzles OMP orchestration service")
        : error);
    }));
    socket.once("end", () => finish(() => reject(new Error("omp-orchestrationd closed without a complete response"))));
  });
}

async function remoteRequest(payload: Record<string, unknown>, remoteUrl: string, token: string | undefined, deadlineMs: number): Promise<DaemonResponse> {
  if (!token?.trim()) throw new Error("OMP_ORCHESTRATION_TOKEN is required for remote access");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  timer.unref?.();
  try {
    const response = await fetch(`${remoteUrl}/v1/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseDaemonResponse(text, "remote omp-orchestrationd");
    if (!response.ok && parsed.ok) throw new Error(`remote omp-orchestrationd failed with HTTP ${response.status}`);
    return parsed;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`ompctl request timed out after ${deadlineMs}ms`);
    throw error;
  } finally { clearTimeout(timer); }
}

function parseDaemonResponse(text: string, source: string): DaemonResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`${source} returned malformed JSON`); }
  if (
    !isRecord(parsed) || typeof parsed.ok !== "boolean" ||
    (parsed.ok && !("result" in parsed)) ||
    (!parsed.ok && (typeof parsed.error !== "string" || typeof parsed.code !== "string"))
  ) throw new Error(`${source} returned an invalid response envelope`);
  return parsed as unknown as DaemonResponse;
}

function normalizeRemoteUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("OMP_ORCHESTRATION_URL is invalid"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new Error("remote OMP orchestration requires HTTPS (HTTP is allowed only for loopback)");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("OMP_ORCHESTRATION_URL must not contain credentials, query, or fragment");
  return url.toString().replace(/\/$/, "");
}
