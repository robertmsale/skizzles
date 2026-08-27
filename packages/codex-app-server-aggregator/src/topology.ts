import type { RpcMessage } from "./protocol.ts";
import type { ThreadListParams } from "./generated/v2/ThreadListParams.ts";
import type { ThreadSourceKind } from "./generated/v2/ThreadSourceKind.ts";

export type { ThreadListParams } from "./generated/v2/ThreadListParams.ts";

export type ThreadSnapshot = Record<string, unknown> & { id: string };

type ThreadEntry = {
  machineId: string;
  snapshot: ThreadSnapshot | undefined;
  archived: boolean;
  deleted: boolean;
};

export class Topology {
  private readonly threads = new Map<string, ThreadEntry>();

  bind(machineId: string, threadId: string, snapshot?: ThreadSnapshot): void {
    const current = this.threads.get(threadId);
    if (current && current.machineId !== machineId) {
      throw new Error(`thread ${threadId} was minted by more than one backend`);
    }
    this.threads.set(threadId, {
      machineId,
      snapshot: snapshot ?? current?.snapshot,
      archived: current?.archived ?? false,
      deleted: current?.deleted ?? false,
    });
  }

  observe(machineId: string, message: RpcMessage): void {
    const envelope = message as Record<string, unknown>;
    const result = asRecord(envelope.result);
    const params = asRecord(envelope.params);
    const thread = asThread(result?.thread) ?? asThread(params?.thread);
    if (thread) this.bind(machineId, thread.id, thread);

    const reviewThreadId = result?.reviewThreadId;
    if (typeof reviewThreadId === "string") this.bind(machineId, reviewThreadId);

    const method = typeof envelope.method === "string" ? envelope.method : undefined;
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    if (method === "thread/archived" && threadId) this.markArchived(threadId);
    if (method === "thread/unarchived" && threadId) this.markUnarchived(threadId);
    if (method === "thread/deleted" && threadId) this.markDeleted(threadId);
    if (method === "thread/closed" && threadId) this.patchSnapshot(threadId, { status: { type: "notLoaded" } });
    if (method === "thread/status/changed" && threadId && params?.status) {
      this.patchSnapshot(threadId, { status: params.status });
    }
    if (method === "thread/name/updated" && threadId && typeof params?.threadName === "string") {
      this.patchSnapshot(threadId, { name: params.threadName });
    }
  }

  machineFor(threadId: string): string | undefined {
    const entry = this.threads.get(threadId);
    return entry && !entry.deleted ? entry.machineId : undefined;
  }

  snapshot(threadId: string): ThreadSnapshot | undefined {
    const entry = this.threads.get(threadId);
    return entry && !entry.deleted && entry.snapshot ? structuredClone(entry.snapshot) : undefined;
  }

  markArchived(threadId: string): void {
    const entry = this.threads.get(threadId);
    if (!entry) return;
    entry.archived = true;
    if (entry.snapshot) entry.snapshot = { ...entry.snapshot, status: { type: "notLoaded" } };
  }

  markUnarchived(threadId: string): void {
    const entry = this.threads.get(threadId);
    if (entry) entry.archived = false;
  }

  markDeleted(threadId: string): void {
    const entry = this.threads.get(threadId);
    if (entry) entry.deleted = true;
  }

  hasLiveThreads(machineId: string): boolean {
    return [...this.threads.values()].some((entry) => entry.machineId === machineId && !entry.archived && !entry.deleted);
  }

  loaded(machineIds: ReadonlySet<string>, params: { cursor?: string | null; limit?: number | null }): {
    data: string[];
    nextCursor: string | null;
  } {
    const ids = [...this.threads.entries()]
      .filter(([, entry]) => loadedMachine(entry, machineIds))
      .map(([threadId]) => threadId)
      .sort();
    const offset = decodeCursor(params.cursor);
    const limit = normalizeLimit(params.limit, ids.length || 50);
    const data = ids.slice(offset, offset + limit);
    return { data, nextCursor: offset + data.length < ids.length ? encodeCursor(offset + data.length) : null };
  }

  list(params: ThreadListParams): { data: ThreadSnapshot[]; nextCursor: string | null; backwardsCursor: string | null } {
    const archived = params.archived === true;
    const cwds = typeof params.cwd === "string" ? [params.cwd] : params.cwd;
    const providers = params.modelProviders?.length ? new Set(params.modelProviders) : undefined;
    const records = [...this.threads.values()]
      .filter((entry) => !entry.deleted && entry.archived === archived && entry.snapshot)
      .map((entry) => entry.snapshot!)
      .filter((thread) => !providers || providers.has(String(thread.modelProvider ?? "")))
      .filter((thread) => matchesSourceKinds(thread.source, params.sourceKinds))
      .filter((thread) => !cwds?.length || cwds.includes(String(thread.cwd ?? "")))
      .filter((thread) => !("sectionId" in params) || sectionId(thread.section) === params.sectionId)
      .filter((thread) => !("projectId" in params) || (thread.projectId ?? null) === params.projectId)
      .filter((thread) => matchesSearch(thread, params.searchTerm))
      .filter((thread) => params.parentThreadId == null || thread.parentThreadId === params.parentThreadId)
      .filter((thread) => params.ancestorThreadId == null || isDescendant(thread, params.ancestorThreadId, this.threads))
      .sort(compareThreads(params.sortKey ?? "created_at", params.sortDirection ?? "desc"));

    const offset = decodeCursor(params.cursor);
    const limit = normalizeLimit(params.limit, 50);
    const data = records.slice(offset, offset + limit);
    return {
      data,
      nextCursor: offset + data.length < records.length ? encodeCursor(offset + data.length) : null,
      backwardsCursor: offset > 0 ? encodeCursor(Math.max(0, offset - limit)) : null,
    };
  }

  private patchSnapshot(threadId: string, patch: Record<string, unknown>): void {
    const entry = this.threads.get(threadId);
    if (entry?.snapshot) entry.snapshot = { ...entry.snapshot, ...patch };
  }
}

function loadedMachine(entry: ThreadEntry, machineIds: ReadonlySet<string>): boolean {
  return !entry.deleted && !entry.archived && machineIds.has(entry.machineId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asThread(value: unknown): ThreadSnapshot | undefined {
  const record = asRecord(value);
  return record && typeof record.id === "string" ? record as ThreadSnapshot : undefined;
}

function matchesSearch(thread: ThreadSnapshot, term: string | null | undefined): boolean {
  if (!term) return true;
  const haystack = `${String(thread.name ?? "")}\n${String(thread.preview ?? "")}`.toLowerCase();
  return haystack.includes(term.toLowerCase());
}

function isDescendant(thread: ThreadSnapshot, ancestorId: string, entries: Map<string, ThreadEntry>): boolean {
  let parent = typeof thread.parentThreadId === "string" ? thread.parentThreadId : undefined;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    if (parent === ancestorId) return true;
    seen.add(parent);
    const snapshot = entries.get(parent)?.snapshot;
    parent = snapshot && typeof snapshot.parentThreadId === "string" ? snapshot.parentThreadId : undefined;
  }
  return false;
}

function matchesSourceKinds(source: unknown, requested: ThreadSourceKind[] | null | undefined): boolean {
  if (!requested?.length) {
    if (source === "cli" || source === "vscode") return true;
    const custom = objectMember(source, "custom");
    return custom === "atlas" || custom === "chatgpt";
  }
  return requested.some((kind) => sourceMatchesKind(source, kind));
}

function sourceMatchesKind(source: unknown, kind: ThreadSourceKind): boolean {
  if (kind === "cli" || kind === "vscode" || kind === "exec" || kind === "appServer" || kind === "unknown") {
    return source === kind;
  }
  const subAgent = objectMember(source, "subAgent");
  if (subAgent === undefined) return false;
  if (kind === "subAgent") return true;
  if (kind === "subAgentReview") return subAgent === "review";
  if (kind === "subAgentCompact") return subAgent === "compact";
  if (kind === "subAgentThreadSpawn") return objectMember(subAgent, "thread_spawn") !== undefined;
  return kind === "subAgentOther" && objectMember(subAgent, "other") !== undefined;
}

function objectMember(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function sectionId(section: unknown): string | null {
  return section !== null && typeof section === "object" && !Array.isArray(section)
    && typeof (section as Record<string, unknown>).id === "string"
    ? (section as Record<string, unknown>).id as string
    : null;
}

function compareThreads(key: NonNullable<ThreadListParams["sortKey"]>, direction: "asc" | "desc") {
  const field = key === "created_at" ? "createdAt" : key === "updated_at" ? "updatedAt" : key === "recency_at" ? "recencyAt" : "sectionEnteredAt";
  const multiplier = direction === "asc" ? 1 : -1;
  return (left: ThreadSnapshot, right: ThreadSnapshot): number => {
    const delta = Number(left[field] ?? 0) - Number(right[field] ?? 0);
    return delta === 0 ? left.id.localeCompare(right.id) * multiplier : delta * multiplier;
  };
}

function normalizeLimit(value: number | null | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? Math.min(value!, 1_000) : fallback;
}

function encodeCursor(offset: number): string {
  return `agg:${offset.toString(36)}`;
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  if (!cursor.startsWith("agg:")) return 0;
  const offset = Number.parseInt(cursor.slice(4), 36);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}
