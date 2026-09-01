import { timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";
import type { AggregatorBridge, EventSubscription } from "./bridge.ts";
import type { RpcError, RpcOutcome } from "./protocol.ts";
import {
  SSE_RETRY_MS,
  SseEventMapper,
  SseHeartbeatHub,
  SseSession,
  appThreadDto,
  batchSseItems,
  decodeTimelineCursor,
  encodeSseEvent,
  parseSseEventId,
  serverRequestStreamDto,
  snapshotProjects,
  sseEventId,
  timelineEntries,
  timelineEntryForStream,
  timelinePage,
  visibleAppThreads,
  type SseIntervalScheduler,
  type SseSnapshotReset,
} from "./sse.ts";
import type { AggregatorState } from "./state.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export type RestServerOptions = {
  hostname: string;
  port: number;
  token?: string;
  staticDirectory?: string;
  state?: AggregatorState;
  inspectContainer?: (containerId: string) => Promise<string | null>;
  sseHeartbeatMilliseconds?: number;
  sseIntervalScheduler?: SseIntervalScheduler;
  log?: (message: string) => void;
};

export class RestApiServer {
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly log: (message: string) => void;
  private readonly staticDirectory: string | undefined;
  private readonly activeRequests = new Set<Promise<Response>>();
  private readonly sseHub: SseHeartbeatHub;

  constructor(private readonly bridge: AggregatorBridge, private readonly options: RestServerOptions) {
    this.log = options.log ?? (() => undefined);
    this.sseHub = new SseHeartbeatHub(options.sseHeartbeatMilliseconds, options.sseIntervalScheduler);
    this.staticDirectory = options.staticDirectory && isLoopbackHost(options.hostname) && options.token === undefined
      ? options.staticDirectory
      : undefined;
    if (options.staticDirectory && !this.staticDirectory) {
      this.log("React board disabled: static assets are served only on an unauthenticated loopback listener");
    }
  }

  start(): URL {
    if (this.server) return this.server.url;
    if (!isLoopbackHost(this.options.hostname) && !this.options.token) {
      throw new Error("REST API requires a bearer token when bound beyond loopback");
    }
    this.server = Bun.serve({
      hostname: this.options.hostname,
      port: this.options.port,
      fetch: (request) => this.dispatch(request),
      error: (error) => {
        this.log(error instanceof Error ? error.stack ?? error.message : String(error));
        return json({ error: { code: "internal_error", message: "internal server error" } }, 500);
      },
    });
    return this.server.url;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.sseHub.close();
    server?.stop(true);
    await Promise.allSettled([...this.activeRequests]);
  }

  private dispatch(request: Request): Promise<Response> {
    const work = this.handle(request);
    this.activeRequests.add(work);
    work.finally(() => this.activeRequests.delete(work)).catch(() => undefined);
    return work;
  }

  private async handle(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: { code: error.code, message: error.message } }, error.status);
      }
      throw error;
    }
  }

  private async route(request: Request): Promise<Response> {
    if (!this.options.token && !trustedLoopbackRequest(request, this.server?.url)) {
      return json({ error: { code: "forbidden_origin", message: "request Host or Origin is not allowed" } }, 403);
    }
    if (!authorized(request, this.options.token)) {
      return json({ error: { code: "unauthorized", message: "missing or invalid bearer token" } }, 401, {
        "www-authenticate": "Bearer",
      });
    }
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/healthz") {
      return json({ ok: true });
    }
    if (path === "/v1/projects") return this.projects(request, url);
    if (request.method === "GET" && path === "/v1/machines") return this.machines();
    if (request.method === "GET" && path === "/v1/events") return this.events(url);
    if (request.method === "GET" && path === "/v1/app-state/stream") return this.appStateStream(request, url);
    if (path === "/v1/server-requests") return this.serverRequests(request);
    if (request.method === "GET" && path === "/v1/threads/loaded") {
      return outcome(await this.bridge.call("thread/loaded/list", listParams(url)), 200);
    }
    if (path === "/v1/threads") return this.threads(request, url);

    const threadStream = path.match(/^\/v1\/threads\/([^/]+)\/stream$/);
    if (request.method === "GET" && threadStream) {
      return this.threadStream(request, decodeURIComponent(threadStream[1]!), url);
    }
    const threadEntry = path.match(/^\/v1\/threads\/([^/]+)\/entries\/([^/]+)$/);
    if (request.method === "GET" && threadEntry) {
      return this.threadEntry(decodeURIComponent(threadEntry[1]!), decodeURIComponent(threadEntry[2]!));
    }
    const threadEntries = path.match(/^\/v1\/threads\/([^/]+)\/entries$/);
    if (request.method === "GET" && threadEntries) {
      return this.threadEntries(decodeURIComponent(threadEntries[1]!), url);
    }

    const serverResponse = path.match(/^\/v1\/server-requests\/([^/]+)\/responses$/);
    if (request.method === "POST" && serverResponse) {
      return this.serverRequestResponse(decodeURIComponent(serverResponse[1]!), request);
    }
    const threadRoute = path.match(/^\/v1\/threads\/([^/]+)(?:\/(turns|archive|delete|fork|resume|interrupt))?$/);
    if (threadRoute) {
      return this.thread(request, decodeURIComponent(threadRoute[1]!), threadRoute[2], url);
    }
    if ((request.method === "GET" || request.method === "HEAD") && this.staticDirectory && !path.startsWith("/v1/")) {
      return this.staticAsset(path, request.method === "HEAD");
    }
    if ((request.method === "GET" || request.method === "HEAD") && this.options.staticDirectory && !path.startsWith("/v1/")) {
      return json({
        error: {
          code: "board_disabled",
          message: "browser board is available only on an unauthenticated loopback listener",
        },
      }, 503);
    }
    return json({ error: { code: "not_found", message: "route not found" } }, 404);
  }

  private async machines(): Promise<Response> {
    const machines = this.options.state?.machineFleet() ?? [];
    const data = await Promise.all(machines.map(async (machine) => ({
      ...machine,
      dockerStatus: machine.kind === "container" && machine.containerId
        ? await inspectContainerStatus(this.options.inspectContainer, machine.containerId)
        : null,
    })));
    return json({ data });
  }

  private async staticAsset(pathname: string, head: boolean): Promise<Response> {
    const root = resolve(this.staticDirectory!);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return badRequest("invalid asset path");
    }
    const candidate = resolve(root, `.${decoded}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      return json({ error: { code: "not_found", message: "asset not found" } }, 404);
    }
    let file = Bun.file(candidate);
    const assetExists = await file.exists();
    if (!assetExists) file = Bun.file(resolve(root, "index.html"));
    if (!(await file.exists())) {
      return json({ error: { code: "spa_not_built", message: "run bun run build in the aggregator package" } }, 503);
    }
    const isIndex = !assetExists || decoded === "/" || candidate.endsWith(`${sep}index.html`);
    return new Response(head ? null : file, {
      headers: {
        "content-type": file.type || "application/octet-stream",
        "cache-control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  }

  private async projects(request: Request, url: URL): Promise<Response> {
    if (request.method === "GET") {
      return outcome(await this.bridge.call("skizzles/project/list", {}), 200);
    }
    if (request.method === "POST") {
      const body = await jsonObject(request);
      return outcome(await this.bridge.call("skizzles/project/add", body), 201);
    }
    if (request.method === "DELETE") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return badRequest("cwd query parameter is required");
      return outcome(await this.bridge.call("skizzles/project/remove", { cwd }), 200);
    }
    return methodNotAllowed("GET, POST, DELETE");
  }

  private async threads(request: Request, url: URL): Promise<Response> {
    if (request.method === "GET") {
      return outcome(await this.bridge.call("thread/list", listParams(url)), 200);
    }
    if (request.method === "POST") {
      const body = await jsonObject(request);
      return outcome(await this.bridge.call("thread/start", body), 201);
    }
    return methodNotAllowed("GET, POST");
  }

  private async thread(
    request: Request,
    threadId: string,
    action: string | undefined,
    url: URL,
  ): Promise<Response> {
    if (!action && request.method === "GET") {
      const includeTurns = booleanQuery(url, "includeTurns", true);
      return outcome(await this.bridge.call("thread/read", { threadId, includeTurns }), 200);
    }
    if (!action && request.method === "DELETE") {
      return outcome(await this.bridge.call("thread/delete", { threadId }), 200);
    }
    if (request.method !== "POST") return methodNotAllowed(action ? "POST" : "GET, DELETE");
    if (action === "archive") return outcome(await this.bridge.call("thread/archive", { threadId }), 200);
    if (action === "delete") return outcome(await this.bridge.call("thread/delete", { threadId }), 200);
    const body = await jsonObject(request);
    if (action === "turns") return outcome(await this.bridge.call("turn/start", { ...body, threadId }), 202);
    if (action === "fork") return outcome(await this.bridge.call("thread/fork", { ...body, threadId }), 201);
    if (action === "resume") return outcome(await this.bridge.call("thread/resume", { ...body, threadId }), 200);
    if (action === "interrupt") return outcome(await this.bridge.call("turn/interrupt", { ...body, threadId }), 200);
    return json({ error: { code: "not_found", message: "route not found" } }, 404);
  }

  private events(url: URL): Response {
    const after = nonNegativeIntegerQuery(url, "after", 0);
    const limit = positiveIntegerQuery(url, "limit", 100);
    const page = this.bridge.eventPage(after, limit, url.searchParams.get("stream") ?? undefined);
    if (page.gap) {
      return json({
        error: {
          code: "event_cursor_expired",
          message: page.restarted
            ? "event stream belongs to a previous daemon process"
            : "event cursor is outside the retained in-memory window",
          oldestCursor: page.oldestCursor,
          streamId: page.streamId,
          restarted: page.restarted,
        },
      }, 410);
    }
    return json(page);
  }

  private appStateStream(request: Request, url: URL): Response {
    const state = this.requiredSseState();
    const cursor = streamCursor(request, url);
    let subscription = this.bridge.openEventSubscription(cursor?.cursor, cursor?.streamId);
    let reset: SseSnapshotReset | undefined;
    if (subscription.gap || subscription.overflowed) {
      reset = {
        reason: subscription.restarted ? "stream_restarted" : "cursor_expired",
        requestedCursor: cursor?.cursor ?? subscription.cursor,
      };
      subscription.close();
      subscription = this.bridge.openEventSubscription();
    } else if (cursor) {
      return this.replayStream(request, subscription, new SseEventMapper("app", state), "app");
    }

    try {
      const id = sseEventId(subscription.streamId, subscription.cursor);
      const projects = snapshotProjects(state.projects());
      const threads = visibleAppThreads(state);
      const pending = this.bridge.pendingServerRequests().map((serverRequest) => serverRequestStreamDto(serverRequest, state));
      const frames = [
        encodeSseEvent(undefined, "snapshot.begin", {
          scope: "app",
          streamId: subscription.streamId,
          cursor: subscription.cursor,
          ...(reset ? { reset } : {}),
        }, SSE_RETRY_MS),
        ...batchSseItems(undefined, "snapshot.projects", "projects", projects, { scope: "app" }),
        ...batchSseItems(undefined, "snapshot.threads", "threads", threads, { scope: "app" }),
        ...batchSseItems(undefined, "snapshot.requests", "requests", pending, { scope: "app" }),
        encodeSseEvent(id, "snapshot.end", {
          scope: "app",
          streamId: subscription.streamId,
          cursor: subscription.cursor,
        }),
      ];
      const mapper = new SseEventMapper("app", state, undefined, [], pending.map((item) => item.id));
      return this.connectSse(request, subscription, mapper, frames);
    } catch (error) {
      subscription.close();
      throw error;
    }
  }

  private async threadStream(request: Request, threadId: string, url: URL): Promise<Response> {
    const state = this.requiredSseState();
    const stored = state.threads().find((thread) => thread.threadId === threadId && !thread.deleted);
    if (!stored) return json({ error: { code: "not_found", message: "thread not found" } }, 404);

    const cursor = streamCursor(request, url);
    let subscription = this.bridge.openEventSubscription(cursor?.cursor, cursor?.streamId);
    let reset: SseSnapshotReset | undefined;
    if (subscription.gap || subscription.overflowed) {
      reset = {
        reason: subscription.restarted ? "stream_restarted" : "cursor_expired",
        requestedCursor: cursor?.cursor ?? subscription.cursor,
      };
      subscription.close();
      subscription = this.bridge.openEventSubscription();
    } else if (cursor) {
      return this.replayStream(request, subscription, new SseEventMapper("thread", state, threadId), "thread", threadId);
    }

    const tail = boundedPositiveIntegerQuery(url, "tail", 50, 50);
    const cancelSnapshot = () => subscription.close();
    request.signal.addEventListener("abort", cancelSnapshot, { once: true });
    let read: Record<string, unknown> | Response;
    try {
      read = await this.readThread(threadId);
    } catch (error) {
      subscription.close();
      throw error;
    } finally {
      request.signal.removeEventListener("abort", cancelSnapshot);
    }
    if (request.signal.aborted) {
      subscription.close();
      return json({ error: { code: "client_closed_request", message: "request was cancelled" } }, 499);
    }
    if (read instanceof Response) {
      subscription.close();
      return read;
    }
    if (subscription.overflowed) {
      subscription.close();
      return json({ error: { code: "sse_snapshot_overflow", message: "events exceeded the bounded snapshot handoff buffer" } }, 503);
    }

    try {
      const page = timelinePage(read, undefined, tail);
      const entries = page.data.map((entry) => timelineEntryForStream(entry, threadId));
      const pending = this.bridge.pendingServerRequests()
        .map((serverRequest) => serverRequestStreamDto(serverRequest, state))
        .filter((serverRequest) => serverRequest.threadId === threadId);
      const id = sseEventId(subscription.streamId, subscription.cursor);
      const frames = [
        encodeSseEvent(undefined, "snapshot.begin", {
          scope: "thread",
          threadId,
          streamId: subscription.streamId,
          cursor: subscription.cursor,
          ...(reset ? { reset } : {}),
        }, SSE_RETRY_MS),
        ...batchSseItems(undefined, "snapshot.threads", "threads", [appThreadDto(stored)], { scope: "thread", threadId }),
        ...batchSseItems(undefined, "snapshot.entries", "entries", entries, { scope: "thread", threadId }),
        ...batchSseItems(undefined, "snapshot.requests", "requests", pending, { scope: "thread", threadId }),
        encodeSseEvent(id, "snapshot.end", {
          scope: "thread",
          threadId,
          streamId: subscription.streamId,
          cursor: subscription.cursor,
          history: {
            count: entries.length,
            tail,
            olderCursor: page.olderCursor,
            hasOlder: page.hasOlder,
          },
        }),
      ];
      const mapper = new SseEventMapper(
        "thread",
        state,
        threadId,
        entries.map((entry) => entry.id),
        pending.map((serverRequest) => serverRequest.id),
      );
      return this.connectSse(request, subscription, mapper, frames);
    } catch (error) {
      subscription.close();
      throw error;
    }
  }

  private async threadEntries(threadId: string, url: URL): Promise<Response> {
    const limit = boundedPositiveIntegerQuery(url, "limit", 50, 100);
    const rawBefore = url.searchParams.get("before");
    let before: number | undefined;
    if (rawBefore !== null) {
      try {
        before = decodeTimelineCursor(rawBefore);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
    }
    const thread = await this.readThread(threadId);
    if (thread instanceof Response) return thread;
    const page = timelinePage(thread, before, limit);
    return json({
      ...page,
      data: page.data.map((entry) => timelineEntryForStream(entry, threadId)),
    });
  }

  private async threadEntry(threadId: string, entryId: string): Promise<Response> {
    const thread = await this.readThread(threadId);
    if (thread instanceof Response) return thread;
    const entry = timelineEntries(thread).find((candidate) => candidate.id === entryId);
    return entry
      ? json({ entry })
      : json({ error: { code: "not_found", message: "timeline entry not found" } }, 404);
  }

  private async readThread(threadId: string): Promise<Record<string, unknown> | Response> {
    const rpcOutcome = await this.bridge.call("thread/read", { threadId, includeTurns: true });
    if ("error" in rpcOutcome) return outcome(rpcOutcome, 200);
    const result = asRecord(rpcOutcome.result);
    const thread = asRecord(result.thread);
    if (typeof thread.id !== "string") {
      return json({ error: { code: "invalid_upstream_response", message: "thread/read returned no thread" } }, 502);
    }
    return thread;
  }

  private replayStream(
    request: Request,
    subscription: EventSubscription,
    mapper: SseEventMapper,
    scope: "app" | "thread",
    threadId?: string,
  ): Response {
    const id = sseEventId(subscription.streamId, subscription.cursor);
    const frame = encodeSseEvent(id, "stream.ready", {
      scope,
      ...(threadId ? { threadId } : {}),
      streamId: subscription.streamId,
      cursor: subscription.cursor,
      replay: true,
    }, SSE_RETRY_MS);
    return this.connectSse(request, subscription, mapper, [frame]);
  }

  private connectSse(
    request: Request,
    subscription: EventSubscription,
    mapper: SseEventMapper,
    initial: Uint8Array[],
  ): Response {
    try {
      let session!: SseSession;
      session = new SseSession(initial, {
        onClose: () => {
          subscription.close();
          this.sseHub.remove(session);
        },
      });
      const started = subscription.start((record) => {
        const mapped = mapper.map(record);
        if (!mapped) return true;
        try {
          return session.enqueue(encodeSseEvent(
            sseEventId(subscription.streamId, record.cursor),
            mapped.event,
            { ...mapped.data, cursor: record.cursor },
          ));
        } catch (error) {
          this.log(`closing SSE client after encoding failure: ${error instanceof Error ? error.message : String(error)}`);
          session.close();
          return false;
        }
      });
      if (!started) {
        session.close();
        return json({ error: { code: "sse_queue_overflow", message: "reconnect from a fresh snapshot" } }, 503);
      }
      this.sseHub.add(session);
      return session.response(request.signal);
    } catch (error) {
      subscription.close();
      throw error;
    }
  }

  private requiredSseState(): AggregatorState {
    if (!this.options.state) throw new HttpError(503, "SSE state projection is unavailable", "sse_unavailable");
    return this.options.state;
  }

  private serverRequests(request: Request): Response {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json({ data: this.bridge.pendingServerRequests() });
  }

  private async serverRequestResponse(id: string, request: Request): Promise<Response> {
    const body = await jsonObject(request);
    const rpcOutcome = parseResponseOutcome(body);
    const accepted = await this.bridge.respondToServerRequest(id, rpcOutcome);
    return accepted
      ? json({ accepted: true })
      : json({ error: { code: "not_found", message: "server request is not pending" } }, 404);
  }
}

function listParams(url: URL): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  copyStringQuery(url, params, "cursor");
  copyStringQuery(url, params, "sortKey");
  copyStringQuery(url, params, "sortDirection");
  copyStringQuery(url, params, "searchTerm");
  copyStringQuery(url, params, "parentThreadId");
  copyStringQuery(url, params, "ancestorThreadId");
  if (url.searchParams.has("limit")) params.limit = positiveIntegerQuery(url, "limit", 100);
  if (url.searchParams.has("archived")) params.archived = booleanQuery(url, "archived", false);
  const cwd = url.searchParams.getAll("cwd");
  if (cwd.length === 1) params.cwd = cwd[0];
  else if (cwd.length > 1) params.cwd = cwd;
  const modelProviders = url.searchParams.getAll("modelProvider");
  if (modelProviders.length) params.modelProviders = modelProviders;
  const sourceKinds = url.searchParams.getAll("sourceKind");
  if (sourceKinds.length) params.sourceKinds = sourceKinds;
  return params;
}

function outcome(value: RpcOutcome, successStatus: number): Response {
  if ("result" in value) return json(value.result, successStatus);
  return json({ error: value.error }, statusForRpcError(value.error));
}

function statusForRpcError(error: RpcError): number {
  if (error.code === -32602) return 400;
  if (error.code === -32601 || error.code === -32004) return 404;
  if (error.code === -32005) return 409;
  if (error.code === -32000 || error.code === -32002 || error.code === -32003) return 503;
  return 500;
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
    throw new HttpError(413, "request body exceeds 1 MiB");
  }
  const bytes = await boundedBody(request);
  if (bytes.byteLength === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function inspectContainerStatus(
  inspectContainer: RestServerOptions["inspectContainer"],
  containerId: string,
): Promise<string | null> {
  if (!inspectContainer) return null;
  try {
    return await inspectContainer(containerId);
  } catch {
    return null;
  }
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "request body exceeds 1 MiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseResponseOutcome(body: Record<string, unknown>): RpcOutcome {
  if ("result" in body && !("error" in body)) return { result: body.result };
  const error = body.error;
  if (!("result" in body) && error !== null && typeof error === "object" && !Array.isArray(error)) {
    const value = error as Record<string, unknown>;
    if (typeof value.code === "number" && typeof value.message === "string") {
      return { error: { code: value.code, message: value.message, ...("data" in value ? { data: value.data } : {}) } };
    }
  }
  throw new HttpError(400, "response body must contain exactly one valid result or error outcome");
}

function copyStringQuery(url: URL, target: Record<string, unknown>, name: string): void {
  const value = url.searchParams.get(name);
  if (value !== null) target[name] = value;
}

function booleanQuery(url: URL, name: string, fallback: boolean): boolean {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HttpError(400, `${name} must be true or false`);
}

function positiveIntegerQuery(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new HttpError(400, `${name} must be a positive integer`);
  return parsed;
}

function boundedPositiveIntegerQuery(url: URL, name: string, fallback: number, maximum: number): number {
  const value = positiveIntegerQuery(url, name, fallback);
  if (value > maximum) throw new HttpError(400, `${name} must not exceed ${maximum}`);
  return value;
}

function nonNegativeIntegerQuery(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, `${name} must be a non-negative integer`);
  return parsed;
}

function streamCursor(request: Request, url: URL): { cursor: number; streamId?: string } | undefined {
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId) {
    try {
      const parsed = parseSseEventId(lastEventId);
      return { cursor: parsed.cursor, streamId: parsed.streamId };
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }
  const rawCursor = url.searchParams.get("cursor") ?? url.searchParams.get("after");
  if (rawCursor === null) return undefined;
  const cursor = Number(rawCursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, "cursor must be a non-negative integer");
  const streamId = url.searchParams.get("stream") ?? undefined;
  return streamId === undefined ? { cursor } : { cursor, streamId };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return true;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function trustedLoopbackRequest(request: Request, serverUrl: URL | undefined): boolean {
  if (!serverUrl || request.headers.get("host")?.toLowerCase() !== serverUrl.host.toLowerCase()) return false;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      if (new URL(origin).origin.toLowerCase() !== serverUrl.origin.toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  return fetchSite === undefined || fetchSite === "none" || fetchSite === "same-origin";
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function badRequest(message: string): Response {
  return json({ error: { code: "bad_request", message } }, 400);
}

function methodNotAllowed(allow: string): Response {
  return json({ error: { code: "method_not_allowed", message: "method not allowed" } }, 405, { allow });
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = "bad_request") {
    super(message);
  }
}
