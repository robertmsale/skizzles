import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { executeCommand } from "./commands.ts";
import type { OmpManager } from "./manager.ts";
import { MAX_REQUEST_BYTES, ServiceError, isRecord, type DaemonResponse } from "./protocol.ts";
import { failure } from "./local-server.ts";

export interface HttpServerOptions {
  token: string;
  allowedProjects?: ReadonlySet<string>;
}

export function createHttpServer(manager: OmpManager, options: HttpServerOptions): Server {
  if (options.token.length < 24 || /[\0\r\n]/.test(options.token)) {
    throw new Error("HTTP ingress requires an OMP_ORCHESTRATION_HTTP_TOKEN of at least 24 characters");
  }
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/health") {
      send(response, 200, { ok: true, result: { service: "omp-orchestrationd", schema: 1 } });
      return;
    }
    const auth = authorize(request, options.token);
    if (auth) { send(response, auth.status, { ok: false, error: auth.message, code: auth.code }); return; }
    if (request.headers.origin) { send(response, 403, { ok: false, error: "browser-origin requests are not allowed", code: "unauthorized" }); return; }
    try {
      if (request.method === "GET" && request.url?.startsWith("/v1/events")) {
        await eventsRequest(request, response, manager, options.allowedProjects);
        return;
      }
      let command: Record<string, unknown>;
      const ingress = request.url?.match(/^\/v1\/projects\/([^/]+)\/inbox$/);
      if (request.method === "POST" && ingress) {
        requireJson(request);
        const body = await readJson(request);
        let projectId: string;
        try { projectId = decodeURIComponent(ingress[1]!); }
        catch { throw new ServiceError("project id encoding is invalid", "invalid_request"); }
        command = { ...body, op: "ingress.accept", projectId };
      } else if (request.method === "POST" && request.url === "/v1/request") {
        requireJson(request);
        command = await readJson(request);
      } else {
        throw new ServiceError("not found", "not_found", 404);
      }
      const scopedResult = scopedCommand(command, manager, options.allowedProjects);
      send(response, 200, { ok: true, result: scopedResult ?? await executeCommand(command, manager) });
    } catch (error) {
      const body = failure(error);
      send(response, error instanceof ServiceError ? error.status : 500, body);
    }
  });
}

function authorize(request: IncomingMessage, token: string): { status: number; code: string; message: string } | undefined {
  const header = request.headers.authorization;
  if (!header) return { status: 401, code: "unauthenticated", message: "bearer token required" };
  const supplied = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    return { status: 401, code: "invalid_session", message: "bearer token is invalid" };
  }
  return undefined;
}

function enforceProjectScope(value: unknown, allowed: ReadonlySet<string> | undefined): void {
  if (!allowed) return;
  if (value === undefined || value === null) throw new ServiceError("token requires an explicit authorized project", "unauthorized", 403);
  if (typeof value !== "string" || !allowed.has(value)) throw new ServiceError("token is not authorized for this project", "unauthorized", 403);
}

function scopedCommand(command: Record<string, unknown>, manager: OmpManager, allowed: ReadonlySet<string> | undefined): unknown {
  if (!allowed) return undefined;
  if (command.op === "health") return { service: "omp-orchestrationd", schema: 1 };
  if (command.op === "projects.list") return manager.projects.list().filter((project) => allowed.has(project.id));
  if (command.op === "projects.add") throw new ServiceError("scoped tokens cannot register projects", "unauthorized", 403);
  enforceProjectScope(command.projectId, allowed);
  return undefined;
}

async function eventsRequest(request: IncomingMessage, response: ServerResponse, manager: OmpManager, allowed: ReadonlySet<string> | undefined): Promise<void> {
  const url = new URL(request.url!, "http://localhost");
  const projectId = url.searchParams.get("project") ?? undefined;
  enforceProjectScope(projectId, allowed);
  const after = parseInteger(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
  if (url.pathname === "/v1/events") {
    send(response, 200, { ok: true, result: manager.events(after, projectId) });
    return;
  }
  if (url.pathname !== "/v1/events/stream") throw new ServiceError("not found", "not_found", 404);
  response.writeHead(200, {
    "cache-control": "no-cache, no-store",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
    "x-omp-orchestration": "1",
  });
  let cursor = after;
  let closed = false;
  response.once("close", () => { closed = true; });
  response.write(": connected\n\n");
  while (!closed) {
    const events = manager.events(cursor, projectId);
    for (const event of events) {
      cursor = event.sequence;
      response.write(`id: ${event.sequence}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    if (!closed) await manager.waitForEvent(cursor, 25_000, projectId);
    if (!closed && events.length === 0) response.write(": keepalive\n\n");
  }
}

function requireJson(request: IncomingMessage): void {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new ServiceError("application/json required", "invalid_request", 415);
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new ServiceError("request exceeds 1 MiB", "too_large", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new ServiceError("request exceeds 1 MiB", "too_large", 413);
    chunks.push(bytes);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ServiceError("request body must be valid JSON", "invalid_request"); }
  if (!isRecord(parsed)) throw new ServiceError("request body must be an object", "invalid_request");
  return parsed;
}

function parseInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new ServiceError("invalid integer query parameter", "invalid_request");
  return parsed;
}

function send(response: ServerResponse, status: number, body: DaemonResponse): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-omp-orchestration": "1",
  });
  response.end(`${JSON.stringify(body)}\n`);
}
