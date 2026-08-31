import type {
  EventPageDto,
  LoadedThreadPageDto,
  MachineDto,
  ProjectDto,
  ServerRequestDto,
  ThreadDto,
  ThreadPageDto,
} from "./types.ts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const error = object(object(body).error);
    throw new ApiError(response.status, typeof error.message === "string" ? error.message : `Request failed (${response.status})`, body);
  }
  return body as T;
}

export function eventCursorRecovery(error: ApiError): { after: number; stream: string } | null {
  if (error.status !== 410) return null;
  const detail = object(object(error.body).error);
  const oldestCursor = detail.oldestCursor;
  const streamId = detail.streamId;
  if (typeof oldestCursor !== "number" || !Number.isSafeInteger(oldestCursor) || oldestCursor < 1 || typeof streamId !== "string" || !streamId) return null;
  return { after: oldestCursor - 1, stream: streamId };
}

export const boardApi = {
  projects: (signal?: AbortSignal) => api<{ data: ProjectDto[] }>("/v1/projects", signalInit(signal)),
  addProject: (cwd: string) => api<{ project: ProjectDto }>("/v1/projects", { method: "POST", body: JSON.stringify({ cwd }) }),
  removeProject: (cwd: string) => api<{ removed: boolean }>(`/v1/projects?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" }),
  threads: (cwd: string | null, archived: boolean, searchTerm?: string, signal?: AbortSignal) => allThreads(cwd, archived, searchTerm, signal),
  loaded: (signal?: AbortSignal) => allLoadedThreads(signal),
  readThread: (id: string, includeTurns: boolean, signal?: AbortSignal) => api<{ thread: ThreadDto }>(`/v1/threads/${encodeURIComponent(id)}?includeTurns=${includeTurns}`, signalInit(signal)),
  startThread: (cwd: string, mode: "host" | "container" = "container") => api<{ thread: ThreadDto }>("/v1/threads", {
    method: "POST",
    body: JSON.stringify({ cwd, skizzlesExecutionMode: mode }),
  }),
  sendTurn: (id: string, text: string) => api(`/v1/threads/${encodeURIComponent(id)}/turns`, { method: "POST", body: JSON.stringify({ input: [{ type: "text", text }] }) }),
  interrupt: (id: string, turnId: string) => api(`/v1/threads/${encodeURIComponent(id)}/interrupt`, { method: "POST", body: JSON.stringify({ turnId }) }),
  archive: (id: string) => api(`/v1/threads/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
  delete: (id: string) => api(`/v1/threads/${encodeURIComponent(id)}`, { method: "DELETE" }),
  approvals: (signal?: AbortSignal) => api<{ data: ServerRequestDto[] }>("/v1/server-requests", signalInit(signal)),
  respond: (id: string | number, result: unknown) => api(`/v1/server-requests/${encodeURIComponent(String(id))}/responses`, { method: "POST", body: JSON.stringify({ result }) }),
  machines: (signal?: AbortSignal) => api<{ data: MachineDto[] }>("/v1/machines", signalInit(signal)),
  events: (after: number, stream: string | null) => {
    const query = new URLSearchParams({ after: String(after), limit: "200" });
    if (stream) query.set("stream", stream);
    return api<EventPageDto>(`/v1/events?${query}`);
  },
};

async function allThreads(cwd: string | null, archived: boolean, searchTerm?: string, signal?: AbortSignal): Promise<ThreadPageDto> {
  const data: ThreadDto[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ archived: String(archived), limit: "100", sortKey: "recency_at", sortDirection: "desc" });
    if (cwd) query.set("cwd", cwd);
    if (searchTerm) query.set("searchTerm", searchTerm);
    if (cursor) query.set("cursor", cursor);
    const page = await api<ThreadPageDto>(`/v1/threads?${query}`, signalInit(signal));
    data.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("thread pagination returned a repeated cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return { data, nextCursor: null };
}

async function allLoadedThreads(signal?: AbortSignal): Promise<LoadedThreadPageDto> {
  const data: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "500" });
    if (cursor) query.set("cursor", cursor);
    const page = await api<LoadedThreadPageDto>(`/v1/threads/loaded?${query}`, signalInit(signal));
    data.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("loaded-thread pagination returned a repeated cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return { data, nextCursor: null };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function signalInit(signal: AbortSignal | undefined): RequestInit | undefined {
  return signal ? { signal } : undefined;
}
