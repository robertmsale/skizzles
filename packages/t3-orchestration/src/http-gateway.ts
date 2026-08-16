import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const MAX_BODY_BYTES = 1_048_576;

type DaemonResponse = { ok: boolean; result?: unknown; error?: string };

async function readBoundedBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    request.on("data", (chunk) => {
      if (oversized) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => {
      if (oversized) reject(new Error("request exceeds 1 MiB"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: DaemonResponse): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

export function createTailscaleGateway(
  allowedLogins: readonly string[],
  execute: (command: { op: string; [key: string]: unknown }) => Promise<unknown>,
): Server {
  const allowed = new Set(allowedLogins.map((login) => login.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) throw new Error("Tailscale gateway requires at least one allowed login");
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/request") {
      send(response, 404, { ok: false, error: "not found" });
      return;
    }
    if (request.headers.origin) {
      send(response, 403, { ok: false, error: "browser-origin requests are not allowed" });
      return;
    }
    if (request.headers["x-forwarded-proto"] !== "https") {
      send(response, 401, { ok: false, error: "verified Tailscale HTTPS proxy required" });
      return;
    }
    const loginHeader = request.headers["tailscale-user-login"];
    const login = typeof loginHeader === "string" ? loginHeader.trim().toLowerCase() : "";
    if (!login) {
      send(response, 401, { ok: false, error: "verified Tailscale user identity required" });
      return;
    }
    if (!allowed.has(login)) {
      send(response, 403, { ok: false, error: "Tailscale user is not authorized" });
      return;
    }
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      send(response, 415, { ok: false, error: "application/json required" });
      return;
    }
    try {
      const body = await readBoundedBody(request);
      const command = JSON.parse(body) as { op?: unknown; [key: string]: unknown };
      if (!command || typeof command !== "object" || typeof command.op !== "string") {
        throw new Error("command is malformed");
      }
      send(response, 200, { ok: true, result: await execute(command as { op: string; [key: string]: unknown }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(response, message === "request exceeds 1 MiB" ? 413 : 200, { ok: false, error: message });
    }
  });
}
