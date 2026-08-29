import type {
  EventPageDto,
  MachineDto,
  ProjectDto,
  ServerRequestDto,
  ThreadDto,
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

export const boardApi = {
  projects: () => api<{ data: ProjectDto[] }>("/v1/projects"),
  addProject: (cwd: string) => api<{ project: ProjectDto }>("/v1/projects", { method: "POST", body: JSON.stringify({ cwd }) }),
  removeProject: (cwd: string) => api<{ removed: boolean }>(`/v1/projects?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" }),
  threads: (cwd: string | null, archived: boolean) => {
    const query = new URLSearchParams({ archived: String(archived), limit: "100", sortKey: "recency_at", sortDirection: "desc" });
    if (cwd) query.set("cwd", cwd);
    return api<{ data: ThreadDto[] }>(`/v1/threads?${query}`);
  },
  loaded: () => api<{ data: string[] }>("/v1/threads/loaded?limit=500"),
  readThread: (id: string, includeTurns: boolean) => api<{ thread: ThreadDto }>(`/v1/threads/${encodeURIComponent(id)}?includeTurns=${includeTurns}`),
  startThread: (cwd: string) => api<{ thread: ThreadDto }>("/v1/threads", { method: "POST", body: JSON.stringify({ cwd }) }),
  sendTurn: (id: string, text: string) => api(`/v1/threads/${encodeURIComponent(id)}/turns`, { method: "POST", body: JSON.stringify({ input: [{ type: "text", text }] }) }),
  interrupt: (id: string, turnId: string) => api(`/v1/threads/${encodeURIComponent(id)}/interrupt`, { method: "POST", body: JSON.stringify({ turnId }) }),
  archive: (id: string) => api(`/v1/threads/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
  delete: (id: string) => api(`/v1/threads/${encodeURIComponent(id)}`, { method: "DELETE" }),
  approvals: () => api<{ data: ServerRequestDto[] }>("/v1/server-requests"),
  respond: (id: string | number, result: unknown) => api(`/v1/server-requests/${encodeURIComponent(String(id))}/responses`, { method: "POST", body: JSON.stringify({ result }) }),
  machines: () => api<{ data: MachineDto[] }>("/v1/machines"),
  events: (after: number, stream: string | null) => {
    const query = new URLSearchParams({ after: String(after), limit: "200" });
    if (stream) query.set("stream", stream);
    return api<EventPageDto>(`/v1/events?${query}`);
  },
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
