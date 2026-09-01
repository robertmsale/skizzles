import type { EventRecord } from "./bridge.ts";
import { requestThreadIdFromParams, type RpcId, type RpcRequest } from "./protocol.ts";
import type { AggregatorState, RegisteredProject, StoredThread } from "./state.ts";

export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_RETRY_MS = 3_000;
export const SSE_TARGET_EVENT_BYTES = 384 * 1024;
export const SSE_HARD_EVENT_BYTES = 880 * 1024;
export const SSE_MAX_QUEUE_EVENTS = 2_048;
export const SSE_MAX_QUEUE_BYTES = 16 * 1024 * 1024;

const textEncoder = new TextEncoder();
const MAX_DEDUPLICATION_IDS = 2_048;

export type SseScope = "app" | "thread";

export type AppThreadDto = Record<string, unknown> & {
  id: string;
  projectCwd: string;
  machineId: string;
  executionMode: "host" | "container";
  loaded: boolean;
  archived: boolean;
  hydrationHref?: string;
};

export type ServerRequestStreamDto = {
  id: RpcId;
  method: string;
  threadId: string | null;
  projectCwd: string | null;
  request?: RpcRequest;
  hydrationHref?: string;
};

export type TimelineEntryDto = {
  kind: "item";
  id: string;
  turnId: string;
  item: Record<string, unknown>;
};

export type TimelineAvailableDto = {
  kind: "available";
  id: string;
  turnId: string;
  bytes: number;
  hydrationHref: string;
};

export type TimelineStreamEntryDto = TimelineEntryDto | TimelineAvailableDto;

export type TimelinePageDto = {
  data: TimelineEntryDto[];
  olderCursor: string | null;
  hasOlder: boolean;
};

export type TimelineHistoryPageDto = {
  data: TimelineStreamEntryDto[];
  olderCursor: string | null;
  hasOlder: boolean;
};

export type SseEventDescriptor = {
  event: string;
  data: Record<string, unknown>;
};

export type SseSnapshotReset = {
  reason: "cursor_expired" | "stream_restarted";
  requestedCursor: number;
};

export type SnapshotSseEventDto =
  | { event: "snapshot.begin"; data: { scope: SseScope; streamId: string; cursor: number; threadId?: string; reset?: SseSnapshotReset } }
  | { event: "snapshot.projects"; data: { scope: "app"; projects: RegisteredProject[] } }
  | { event: "snapshot.threads"; data: { scope: SseScope; threadId?: string; threads: AppThreadDto[] } }
  | { event: "snapshot.entries"; data: { scope: "thread"; threadId: string; entries: TimelineStreamEntryDto[] } }
  | { event: "snapshot.requests"; data: { scope: SseScope; threadId?: string; requests: ServerRequestStreamDto[] } }
  | { event: "snapshot.end"; data: { scope: SseScope; streamId: string; cursor: number; threadId?: string; history?: { count: number; tail: number; olderCursor: string | null; hasOlder: boolean } } };

export type LiveSseEventDto =
  | { event: "stream.ready"; data: { scope: SseScope; streamId: string; cursor: number; replay: true; threadId?: string } }
  | { event: "project.upsert"; data: { project: RegisteredProject; cursor: number } }
  | { event: "project.removed"; data: { cwd: string; cursor: number } }
  | { event: "thread.upsert"; data: { thread: AppThreadDto; cursor: number } }
  | { event: "thread.status"; data: { threadId: string; status: unknown; cursor: number } }
  | { event: "thread.archived"; data: { threadId: string; cursor: number } }
  | { event: "thread.removed"; data: { threadId: string; cursor: number } }
  | { event: "thread.responding"; data: { threadId: string; cursor: number } }
  | { event: "turn.started"; data: { threadId: string; turn: Record<string, unknown>; cursor: number } }
  | { event: "turn.completed"; data: { threadId: string; turn: Record<string, unknown>; cursor: number } }
  | { event: "item.completed"; data: { threadId: string; item: TimelineEntryDto; cursor: number } }
  | { event: "item.available"; data: { threadId: string; item: TimelineAvailableDto; cursor: number } }
  | { event: "server-request.pending"; data: { request: ServerRequestStreamDto; cursor: number } }
  | { event: "server-request.resolved"; data: { id: RpcId; method: unknown; threadId: string | null; projectCwd: string | null; cursor: number } };

export type SseStreamEventDto = SnapshotSseEventDto | LiveSseEventDto;

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-store, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive",
} as const;

export function encodeSseEvent(
  id: string | undefined,
  event: string,
  data: unknown,
  retry?: number,
): Uint8Array {
  if ((id !== undefined && /\r|\n/.test(id)) || !event || /\r|\n/.test(event)) {
    throw new Error("invalid SSE id or event name");
  }
  const json = JSON.stringify(data);
  if (json === undefined) throw new Error("SSE data must be JSON serializable");
  const frame = textEncoder.encode(
    `${retry === undefined ? "" : `retry: ${retry}\n`}${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${json}\n\n`,
  );
  if (frame.byteLength > SSE_HARD_EVENT_BYTES) {
    throw new Error(`SSE event exceeds ${SSE_HARD_EVENT_BYTES} byte hard limit`);
  }
  return frame;
}

export function encodeSseComment(comment = "heartbeat"): Uint8Array {
  if (/\r|\n/.test(comment)) throw new Error("invalid SSE comment");
  return textEncoder.encode(`: ${comment}\n\n`);
}

export function sseEventId(streamId: string, cursor: number): string {
  return `${streamId}:${cursor}`;
}

export function parseSseEventId(value: string): { streamId: string; cursor: number } {
  const separator = value.lastIndexOf(":");
  const streamId = value.slice(0, separator);
  const cursor = Number(value.slice(separator + 1));
  if (separator < 1 || !streamId || !Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("Last-Event-ID must be <stream-id>:<non-negative-cursor>");
  }
  return { streamId, cursor };
}

export function batchSseItems<T>(
  id: string | undefined,
  event: string,
  key: string,
  items: T[],
  base: Record<string, unknown> = {},
): Uint8Array[] {
  if (items.length === 0) return [encodeSseEvent(id, event, { ...base, [key]: [] })];
  const frames: Uint8Array[] = [];
  let batch: T[] = [];
  for (const item of items) {
    const candidate = [...batch, item];
    let frame: Uint8Array;
    try {
      frame = encodeSseEvent(id, event, { ...base, [key]: candidate });
    } catch (error) {
      if (batch.length === 0) throw error;
      frames.push(encodeSseEvent(id, event, { ...base, [key]: batch }));
      batch = [item];
      encodeSseEvent(id, event, { ...base, [key]: batch });
      continue;
    }
    if (frame.byteLength > SSE_TARGET_EVENT_BYTES && batch.length > 0) {
      frames.push(encodeSseEvent(id, event, { ...base, [key]: batch }));
      batch = [item];
      encodeSseEvent(id, event, { ...base, [key]: batch });
    } else {
      batch = candidate;
    }
  }
  if (batch.length > 0) frames.push(encodeSseEvent(id, event, { ...base, [key]: batch }));
  return frames;
}

export function appThreadDto(thread: StoredThread): AppThreadDto {
  const metadata = thread.snapshot ?? { id: thread.threadId };
  const value: AppThreadDto = {
    ...structuredClone(metadata),
    id: thread.threadId,
    projectCwd: thread.projectCwd,
    machineId: thread.machineId,
    executionMode: thread.executionMode,
    loaded: thread.loaded,
    archived: thread.archived,
  };
  if (jsonBytes(value) <= SSE_TARGET_EVENT_BYTES - 4_096) return value;
  return {
    id: thread.threadId,
    projectCwd: thread.projectCwd,
    machineId: thread.machineId,
    executionMode: thread.executionMode,
    loaded: thread.loaded,
    archived: thread.archived,
    ...compactThreadMetadata(metadata),
    hydrationHref: `/v1/threads/${encodeURIComponent(thread.threadId)}?includeTurns=false`,
  };
}

export function serverRequestStreamDto(request: RpcRequest, state: AggregatorState): ServerRequestStreamDto {
  const params = asRecord(request.params);
  const threadId = requestThreadIdFromParams(params) ?? null;
  const projectCwd = threadId === null
    ? registeredRequestCwd(state, params.cwd)
    : state.threads().find((thread) => thread.threadId === threadId && !thread.deleted)?.projectCwd ?? null;
  const dto: ServerRequestStreamDto = {
    id: request.id,
    method: request.method,
    threadId,
    projectCwd,
    request: structuredClone(request),
  };
  if (jsonBytes(dto) <= SSE_TARGET_EVENT_BYTES - 4_096) return dto;
  delete dto.request;
  dto.hydrationHref = "/v1/server-requests";
  return dto;
}

export function timelineEntries(
  thread: Record<string, unknown>,
  completedItemIds: ReadonlySet<string> = new Set(),
): TimelineEntryDto[] {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const entries: TimelineEntryDto[] = [];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = asRecord(turns[turnIndex]);
    const turnId = typeof turn.id === "string" ? turn.id : `turn:${turnIndex}`;
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const item = asRecord(items[itemIndex]);
      const id = typeof item.id === "string" ? item.id : `${turnId}:item:${itemIndex}`;
      if (!isFinalizedItem(item, turn, completedItemIds.has(id))) continue;
      entries.push({ kind: "item", id, turnId, item: cloneFinalizedValue(item) as Record<string, unknown> });
    }
  }
  return entries;
}

export function timelinePage(
  thread: Record<string, unknown>,
  before: number | undefined,
  limit: number,
  completedItemIds: ReadonlySet<string> = new Set(),
): TimelinePageDto {
  const entries = timelineEntries(thread, completedItemIds);
  const end = Math.min(before ?? entries.length, entries.length);
  const start = Math.max(0, end - limit);
  return {
    data: entries.slice(start, end),
    olderCursor: start > 0 ? encodeTimelineCursor(start) : null,
    hasOlder: start > 0,
  };
}

export function encodeTimelineCursor(index: number): string {
  return `entry:${index.toString(36)}`;
}

export function decodeTimelineCursor(cursor: string): number {
  if (!cursor.startsWith("entry:")) throw new Error("before must be a valid entry cursor");
  const value = cursor.slice("entry:".length);
  if (!/^[0-9a-z]+$/.test(value)) throw new Error("before must be a valid entry cursor");
  const index = Number.parseInt(value, 36);
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("before must be a valid entry cursor");
  return index;
}

export function timelineEntryForStream(entry: TimelineEntryDto, threadId: string): TimelineStreamEntryDto {
  const bytes = jsonBytes(entry);
  if (bytes <= SSE_TARGET_EVENT_BYTES - 4_096) return structuredClone(entry);
  return {
    kind: "available",
    id: entry.id,
    turnId: entry.turnId,
    bytes,
    hydrationHref: timelineHydrationHref(threadId, entry.id),
  };
}

export function timelineHydrationHref(threadId: string, entryId: string): string {
  return `/v1/threads/${encodeURIComponent(threadId)}/entries/${encodeURIComponent(entryId)}`;
}

export function visibleAppThreads(state: AggregatorState): AppThreadDto[] {
  return state.threads().filter((thread) => !thread.deleted).map(appThreadDto);
}

export function snapshotProjects(projects: RegisteredProject[]): RegisteredProject[] {
  return projects.map((project) => structuredClone(project));
}

export class SseEventMapper {
  private readonly respondingThreads = new Set<string>();
  private readonly deliveredItems: BoundedIdSet;
  private readonly pendingRequests: BoundedIdSet;

  constructor(
    private readonly scope: SseScope,
    private readonly state: AggregatorState,
    private readonly selectedThreadId?: string,
    deliveredItemIds: string[] = [],
    pendingRequestIds: RpcId[] = [],
  ) {
    this.deliveredItems = new BoundedIdSet(deliveredItemIds);
    this.pendingRequests = new BoundedIdSet(pendingRequestIds.map(stableRpcId));
  }

  map(record: EventRecord): SseEventDescriptor | null {
    const notification = record.event;
    const params = asRecord(notification.params);
    const threadId = eventThreadId(notification.method, params);
    const oversizedBytes = typeof params.oversizedBytes === "number" ? params.oversizedBytes : undefined;
    if (this.scope === "thread" && threadId !== this.selectedThreadId) return null;

    if (isDeltaMethod(notification.method)) {
      if (typeof params.itemId === "string" && this.deliveredItems.has(params.itemId)) return null;
      if (!threadId || this.respondingThreads.has(threadId)) return null;
      this.respondingThreads.add(threadId);
      return { event: "thread.responding", data: { threadId } };
    }

    if (notification.method === "skizzles/project/upsert" && this.scope === "app") {
      const inline = asRecord(params.project);
      const project = typeof inline.cwd === "string"
        ? inline
        : this.state.projects().find((candidate) => candidate.cwd === params.cwd);
      return project ? { event: "project.upsert", data: { project } } : null;
    }
    if (notification.method === "skizzles/project/removed" && this.scope === "app") {
      return { event: "project.removed", data: { cwd: params.cwd } };
    }
    if (notification.method === "skizzles/server-request/pending") {
      const request = asRpcRequest(params.request);
      if (!request) return null;
      const requestDto = serverRequestStreamDto(request, this.state);
      if (this.scope === "thread" && requestDto.threadId !== this.selectedThreadId) return null;
      const key = stableRpcId(request.id);
      if (this.pendingRequests.has(key)) return null;
      this.pendingRequests.add(key);
      if (typeof params.oversizedBytes === "number") {
        delete requestDto.request;
        requestDto.hydrationHref = "/v1/server-requests";
      }
      return { event: "server-request.pending", data: { request: requestDto } };
    }
    if (notification.method === "skizzles/server-request/resolved") {
      const id = params.id;
      if (!isRpcId(id)) return null;
      const resolvedThreadId = requestThreadIdFromParams(params) ?? null;
      if (this.scope === "thread" && resolvedThreadId !== this.selectedThreadId) return null;
      this.pendingRequests.delete(stableRpcId(id));
      return {
        event: "server-request.resolved",
        data: {
          id,
          method: params.method,
          threadId: resolvedThreadId,
          projectCwd: resolvedThreadId === null
            ? registeredRequestCwd(this.state, params.cwd)
            : projectForThread(this.state, resolvedThreadId),
        },
      };
    }

    if (notification.method === "thread/started") {
      const id = threadId ?? stringMember(params.thread, "id");
      return id ? { event: "thread.upsert", data: { thread: threadDtoForId(this.state, id, params.thread) } } : null;
    }
    if (notification.method === "thread/name/updated") {
      return threadId ? { event: "thread.upsert", data: { thread: threadDtoForId(this.state, threadId) } } : null;
    }
    if (notification.method === "thread/status/changed") {
      if (!threadId) return null;
      if (oversizedBytes !== undefined) {
        const thread = threadDtoForId(this.state, threadId);
        if (statusEndsResponse(thread.status)) this.respondingThreads.delete(threadId);
        return { event: "thread.upsert", data: { thread } };
      }
      if (statusEndsResponse(params.status)) this.respondingThreads.delete(threadId);
      return { event: "thread.status", data: { threadId, status: compactStatus(params.status) } };
    }
    if (notification.method === "thread/closed") {
      if (!threadId) return null;
      this.respondingThreads.delete(threadId);
      return { event: "thread.status", data: { threadId, status: { type: "notLoaded" } } };
    }
    if (notification.method === "thread/archived") {
      if (!threadId) return null;
      this.respondingThreads.delete(threadId);
      return { event: "thread.archived", data: { threadId } };
    }
    if (notification.method === "thread/deleted") {
      if (!threadId) return null;
      this.respondingThreads.delete(threadId);
      return { event: "thread.removed", data: { threadId } };
    }
    if (notification.method === "turn/started") {
      return threadId ? {
        event: "turn.started",
        data: { threadId, turn: oversizedBytes === undefined ? compactTurn(params.turn) : compactTurn({ id: params.turnId }) },
      } : null;
    }
    if (notification.method === "turn/completed") {
      if (!threadId) return null;
      this.respondingThreads.delete(threadId);
      return {
        event: "turn.completed",
        data: { threadId, turn: oversizedBytes === undefined ? compactTurn(params.turn) : compactTurn({ id: params.turnId }) },
      };
    }
    if (notification.method === "item/completed") {
      if (!threadId) return null;
      this.respondingThreads.delete(threadId);
      if (this.scope === "app") {
        return { event: "thread.upsert", data: { thread: threadDtoForId(this.state, threadId) } };
      }
      const item = cloneFinalizedValue(asRecord(params.item)) as Record<string, unknown>;
      const itemId = typeof item.id === "string"
        ? item.id
        : typeof params.itemId === "string" ? params.itemId : undefined;
      if (itemId && this.deliveredItems.has(itemId)) return null;
      if (itemId) this.deliveredItems.add(itemId);
      const turnId = typeof params.turnId === "string" ? params.turnId : "";
      if (oversizedBytes !== undefined) {
        const id = itemId ?? `oversized:${record.cursor}`;
        return {
          event: "item.available",
          data: {
            threadId,
            item: {
              kind: "available",
              id,
              turnId,
              bytes: oversizedBytes,
              hydrationHref: timelineHydrationHref(threadId, id),
            },
          },
        };
      }
      const entry: TimelineEntryDto = { kind: "item", id: itemId ?? `${turnId}:completed:${record.cursor}`, turnId, item };
      const bounded = timelineEntryForStream(entry, threadId);
      return bounded.kind === "available"
        ? { event: "item.available", data: { threadId, item: bounded } }
        : { event: "item.completed", data: { threadId, item: bounded } };
    }
    return null;
  }
}

type SseSessionOptions = {
  maxQueueEvents?: number;
  maxQueueBytes?: number;
  onClose?: () => void;
};

export class SseSession {
  private readonly initial: Uint8Array[];
  private readonly live: Uint8Array[] = [];
  private readonly maxQueueEvents: number;
  private readonly maxQueueBytes: number;
  private readonly onClose: () => void;
  private queuedBytes = 0;
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private waiting = false;
  private closed = false;
  private abortSignal: AbortSignal | undefined;
  private readonly abort = () => this.close();

  constructor(initial: Uint8Array[], options: SseSessionOptions = {}) {
    if (initial.some((frame) => frame.byteLength > SSE_HARD_EVENT_BYTES)) throw new Error("oversized initial SSE frame");
    this.maxQueueEvents = options.maxQueueEvents ?? SSE_MAX_QUEUE_EVENTS;
    this.maxQueueBytes = options.maxQueueBytes ?? SSE_MAX_QUEUE_BYTES;
    // The finite snapshot is drained one frame at a time before live traffic. Only the live
    // backlog is subject to subscriber queue limits; otherwise 50 valid bounded entries can
    // exceed the 16 MiB live cap and make the route fail before returning its response.
    this.initial = [...initial];
    this.onClose = options.onClose ?? (() => undefined);
  }

  response(signal?: AbortSignal): Response {
    if (this.controller) throw new Error("SSE response is already attached");
    if (signal) {
      this.abortSignal = signal;
      signal.addEventListener("abort", this.abort, { once: true });
      if (signal.aborted) this.close();
    }
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller; },
      pull: (controller) => this.pull(controller),
      cancel: () => this.close(),
    }, { highWaterMark: 1 });
    return new Response(body, { headers: SSE_HEADERS });
  }

  enqueue(frame: Uint8Array): boolean {
    if (this.closed) return false;
    if (frame.byteLength > SSE_HARD_EVENT_BYTES) {
      this.close();
      return false;
    }
    if (this.waiting && this.controller) {
      this.waiting = false;
      this.controller.enqueue(frame);
      return true;
    }
    if (this.live.length >= this.maxQueueEvents || this.queuedBytes + frame.byteLength > this.maxQueueBytes) {
      this.close();
      return false;
    }
    this.live.push(frame);
    this.queuedBytes += frame.byteLength;
    return true;
  }

  heartbeat(): boolean {
    return this.enqueue(encodeSseComment());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortSignal?.removeEventListener("abort", this.abort);
    this.abortSignal = undefined;
    this.initial.length = 0;
    this.live.length = 0;
    this.queuedBytes = 0;
    this.waiting = false;
    try {
      this.controller?.close();
    } catch {
      // The consumer may already have cancelled the stream.
    }
    this.onClose();
  }

  private pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.closed) {
      try { controller.close(); } catch { /* already closed */ }
      return;
    }
    const initial = this.initial.shift();
    if (initial) {
      controller.enqueue(initial);
      return;
    }
    const live = this.live.shift();
    if (live) {
      this.queuedBytes -= live.byteLength;
      controller.enqueue(live);
      return;
    }
    this.waiting = true;
  }
}

export type SseIntervalScheduler = {
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

const defaultScheduler: SseIntervalScheduler = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class SseHeartbeatHub {
  private readonly sessions = new Set<SseSession>();
  private timer: unknown;

  constructor(
    private readonly milliseconds = SSE_HEARTBEAT_MS,
    private readonly scheduler: SseIntervalScheduler = defaultScheduler,
  ) {}

  get activeCount(): number {
    return this.sessions.size;
  }

  add(session: SseSession): void {
    this.sessions.add(session);
    if (this.timer === undefined) {
      this.timer = this.scheduler.setInterval(() => {
        for (const active of [...this.sessions]) active.heartbeat();
      }, this.milliseconds);
    }
  }

  remove(session: SseSession): void {
    this.sessions.delete(session);
    if (this.sessions.size === 0) this.stopTimer();
  }

  close(): void {
    for (const session of [...this.sessions]) session.close();
    this.sessions.clear();
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    this.scheduler.clearInterval(this.timer);
    this.timer = undefined;
  }
}

function threadDtoForId(state: AggregatorState, threadId: string, fallback?: unknown): AppThreadDto {
  const stored = state.threads().find((thread) => thread.threadId === threadId);
  if (stored) return appThreadDto(stored);
  const metadata = asRecord(fallback);
  return {
    ...metadata,
    id: threadId,
    projectCwd: typeof metadata.cwd === "string" ? metadata.cwd : "",
    machineId: "unknown",
    executionMode: "host",
    loaded: true,
    archived: false,
  };
}

function projectForThread(state: AggregatorState, threadId: string): string | null {
  return state.threads().find((thread) => thread.threadId === threadId && !thread.deleted)?.projectCwd ?? null;
}

function registeredRequestCwd(state: AggregatorState, value: unknown): string | null {
  return typeof value === "string" && state.projects().some((project) => project.cwd === value) ? value : null;
}

function eventThreadId(method: string, params: Record<string, unknown>): string | undefined {
  if (typeof params.threadId === "string") return params.threadId;
  const threadId = stringMember(params.thread, "id");
  if (threadId) return threadId;
  if (method === "skizzles/server-request/pending") {
    const request = asRpcRequest(params.request);
    const requestParams = asRecord(request?.params);
    return requestThreadIdFromParams(requestParams);
  }
  if (method === "skizzles/server-request/resolved") return requestThreadIdFromParams(params);
  return undefined;
}

function isDeltaMethod(method: string): boolean {
  return method.toLowerCase().includes("delta");
}

function statusEndsResponse(value: unknown): boolean {
  const type = asRecord(value).type;
  return type === "idle" || type === "notLoaded" || type === "systemError" || type === "failed";
}

function compactTurn(value: unknown): Record<string, unknown> {
  const turn = asRecord(value);
  const compact: Record<string, unknown> = {};
  for (const key of ["id", "status", "error", "startedAt", "completedAt"] as const) {
    if (key in turn) compact[key] = cloneFinalizedValue(turn[key]);
  }
  if (jsonBytes(compact) > 64 * 1024) {
    return {
      ...(typeof compact.id === "string" ? { id: compact.id } : {}),
      ...(compact.status === undefined ? {} : { status: compactStatus(compact.status) }),
      ...(compact.error === undefined ? {} : { error: compactError(compact.error) }),
      ...(compact.startedAt === undefined ? {} : { startedAt: compact.startedAt }),
      ...(compact.completedAt === undefined ? {} : { completedAt: compact.completedAt }),
    };
  }
  return compact;
}

function compactThreadMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const key of ["name", "preview", "status", "createdAt", "updatedAt", "recencyAt", "source"] as const) {
    if (!(key in metadata)) continue;
    const value = key === "status" ? compactStatus(metadata[key]) : cloneFinalizedValue(metadata[key]);
    compact[key] = typeof value === "string" && value.length > 2_048 ? `${value.slice(0, 2_048)}…` : value;
  }
  if (jsonBytes(compact) > 16 * 1024) return { status: compactStatus(compact.status) };
  return compact;
}

function compactStatus(value: unknown): unknown {
  const status = cloneFinalizedValue(value);
  if (jsonBytes(status) <= 16 * 1024) return status;
  const type = asRecord(status).type;
  return typeof type === "string" ? { type } : { type: "unknown" };
}

function compactError(value: unknown): unknown {
  if (typeof value === "string") return value.length > 8_192 ? `${value.slice(0, 8_192)}…` : value;
  const error = asRecord(cloneFinalizedValue(value));
  const message = error.message;
  return {
    ...(typeof error.code === "string" || typeof error.code === "number" ? { code: error.code } : {}),
    ...(typeof message === "string" ? { message: message.length > 8_192 ? `${message.slice(0, 8_192)}…` : message } : {}),
  };
}

function isFinalizedItem(item: Record<string, unknown>, turn: Record<string, unknown>, knownCompleted: boolean): boolean {
  if (knownCompleted) return true;
  const itemStatus = lifecycleStatus(item.status);
  if (itemStatus !== undefined) {
    if (["completed", "failed", "declined", "interrupted", "cancelled", "canceled"].includes(itemStatus)) return true;
    if (["inprogress", "running", "started", "pending"].includes(itemStatus)) return false;
  }

  const turnStatus = lifecycleStatus(turn.status);
  if (["completed", "failed", "interrupted"].includes(turnStatus ?? "")) return true;

  // These variants are delivered atomically by app-server and contain no progressive result
  // fields. Other status-less variants (agent messages, plans, reasoning, searches, sleep,
  // compaction, and extension items) may be partial while their enclosing turn is in progress.
  return ["userMessage", "hookPrompt", "imageView", "enteredReviewMode", "exitedReviewMode"]
    .includes(typeof item.type === "string" ? item.type : "");
}

function lifecycleStatus(value: unknown): string | undefined {
  const status = typeof value === "string" ? value : asRecord(value).type;
  return typeof status === "string" ? status.replaceAll(/[-_\s]/g, "").toLowerCase() : undefined;
}

function cloneFinalizedValue(value: unknown): unknown {
  return structuredClone(value);
}

function asRpcRequest(value: unknown): RpcRequest | undefined {
  const request = asRecord(value);
  return typeof request.method === "string" && isRpcId(request.id)
    ? request as RpcRequest
    : undefined;
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function stableRpcId(id: RpcId): string {
  return `${typeof id}:${id}`;
}

function stringMember(value: unknown, key: string): string | undefined {
  const member = asRecord(value)[key];
  return typeof member === "string" ? member : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json);
}

class BoundedIdSet {
  private readonly values = new Set<string>();

  constructor(initial: string[]) {
    for (const value of initial) this.add(value);
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  add(value: string): void {
    this.values.delete(value);
    this.values.add(value);
    if (this.values.size > MAX_DEDUPLICATION_IDS) this.values.delete(this.values.values().next().value!);
  }

  delete(value: string): void {
    this.values.delete(value);
  }
}
