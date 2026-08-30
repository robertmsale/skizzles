import type {
  ServerRequestDto,
  EventRecordDto,
  MachineDto,
  ProjectDto,
  ThreadDto,
  ThreadItemDto,
  ThreadView,
  TimelineEntry,
} from "./types.ts";

export class LatestRequest {
  private current: AbortController | null = null;

  begin(): AbortController {
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    return controller;
  }

  commit(controller: AbortController, action: () => void): boolean {
    if (controller.signal.aborted || this.current !== controller) return false;
    action();
    return true;
  }

  finish(controller: AbortController): void {
    if (this.current === controller) this.current = null;
  }

  cancel(): void {
    this.current?.abort();
    this.current = null;
  }
}

export class DirtyThreadReads {
  private readonly threadIds = new Set<string>();

  mark(threadId: string | null | undefined): void {
    if (threadId) this.threadIds.add(threadId);
  }

  has(threadId: string | null | undefined): boolean {
    return Boolean(threadId && this.threadIds.has(threadId));
  }

  resolve(threadId: string): void {
    this.threadIds.delete(threadId);
  }
}

export type OwnedError = { owner: "background" | "read" | "mutation"; message: string };

export function clearOwnedError(current: OwnedError | null, owner: OwnedError["owner"]): OwnedError | null {
  return current?.owner === owner ? null : current;
}

export function replaceOwnedError(current: OwnedError | null, incoming: OwnedError): OwnedError {
  return current && current.owner !== "background" && incoming.owner === "background" ? current : incoming;
}

export async function afterSuccessfulReconciliation(
  reconcile: () => Promise<boolean>,
  onSuccess: () => void | Promise<void>,
): Promise<boolean> {
  if (!await reconcile()) return false;
  await onSuccess();
  return true;
}

export function projectRegistriesMatch(current: ProjectDto[], incoming: ProjectDto[]): boolean {
  if (current.length !== incoming.length) return false;
  const byCwd = new Map(current.map((project) => [project.cwd, project]));
  return incoming.every((project) => {
    const previous = byCwd.get(project.cwd);
    return previous?.cloneUrl === project.cloneUrl && previous.updatedAt === project.updatedAt;
  });
}

export function classifyThread(
  thread: ThreadDto,
  loadedIds: ReadonlySet<string>,
  archived: boolean,
): ThreadView {
  return { ...thread, lifecycle: archived ? "archived" : loadedIds.has(thread.id) ? "live" : "snapshot" };
}

export function threadForSelection(thread: ThreadDto | null, selectedId: string | null): ThreadDto | null {
  return thread?.id === selectedId ? thread : null;
}

export function threadIsRunning(thread: ThreadDto): boolean {
  return thread.status?.type?.toLowerCase() === "active";
}

export function threadHasSystemError(thread: ThreadDto): boolean {
  return thread.status?.type?.toLowerCase() === "systemerror";
}

export function requestThreadId(request: ServerRequestDto): string | undefined {
  const params = record(request.params);
  return typeof params.threadId === "string"
    ? params.threadId
    : typeof params.conversationId === "string" ? params.conversationId : undefined;
}

export function projectForThread(machines: MachineDto[], threadId: string | undefined): string | undefined {
  if (!threadId) return undefined;
  return machines.find((machine) => machine.threadIds.includes(threadId))?.projectCwd;
}

export function requestLabel(request: ServerRequestDto): string {
  if (request.method.includes("commandExecution") || request.method === "execCommandApproval") return "Run command";
  if (request.method.includes("fileChange") || request.method === "applyPatchApproval") return "Apply file changes";
  if (request.method.includes("permissions")) return "Additional permissions requested";
  if (request.method.includes("requestUserInput")) return "Input requested";
  if (request.method === "mcpServer/elicitation/request") return "MCP input requested";
  if (request.method === "account/chatgptAuthTokens/refresh") return "Authentication refresh requested";
  if (request.method === "attestation/generate") return "Attestation requested";
  if (request.method.includes("tool") || request.method.includes("Tool")) return "Client tool requested";
  return words(request.method.split("/").at(-1) ?? "Request");
}

export function requestDetail(request: ServerRequestDto): string {
  const params = record(request.params);
  const command = params.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.filter((part): part is string => typeof part === "string").join(" ");
  for (const key of ["reason", "message", "description"]) {
    if (typeof params[key] === "string") return params[key];
  }
  return "Codex is waiting for a response.";
}

export function approvalResult(request: ServerRequestDto, accepted: boolean): Record<string, unknown> | null {
  if (request.method === "applyPatchApproval" || request.method === "execCommandApproval") {
    return { decision: accepted ? "approved" : "denied" };
  }
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
    return { decision: accepted ? "accept" : "decline" };
  }
  return null;
}

export function timelineEntries(thread: ThreadDto | null, deltas: ReadonlyMap<string, string>): TimelineEntry[] {
  if (!thread?.turns) return [];
  const result: TimelineEntry[] = [];
  for (const turn of thread.turns) {
    for (const [index, item] of (turn.items ?? []).entries()) {
      const type = item.type ?? "activity";
      const key = item.id ?? `${turn.id}-${index}`;
      const text = mergeStreamedText(itemText(item), deltas.get(key));
      if (/user.*message/i.test(type)) {
        result.push({ key, role: "user", label: "You", text: text || "Message", raw: item });
      } else if (/agent.*message|assistant.*message/i.test(type)) {
        result.push({ key, role: "assistant", label: "Codex", text: text || "Thinking…", raw: item });
      } else if (/reasoning/i.test(type)) {
        if (text) result.push({ key, role: "tool", label: "Reasoning", text, ...optionalStatus(item.status), raw: item });
      } else {
        result.push({
          key,
          role: "tool",
          label: toolLabel(item),
          text: text || toolFallback(item),
          ...optionalStatus(item.status),
          raw: item,
        });
      }
    }
  }
  return result;
}

export function eventThreadId(event: { params?: unknown }): string | undefined {
  const params = record(event.params);
  if (typeof params.threadId === "string") return params.threadId;
  const thread = record(params.thread);
  return typeof thread.id === "string" ? thread.id : undefined;
}

export function eventDelta(event: { method: string; params?: unknown }): { itemId: string; delta: string } | null {
  if (!/delta$/i.test(event.method)) return null;
  const params = record(event.params);
  const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
  const delta = typeof params.delta === "string" ? params.delta : typeof params.text === "string" ? params.text : undefined;
  return itemId && delta ? { itemId, delta } : null;
}

export function eventNeedsReconciliation(event: { method: string; params?: unknown }): boolean {
  return eventDelta(event) === null;
}

export function eventPageNeedsReconciliation(records: EventRecordDto[]): boolean {
  return records.some((record) => eventNeedsReconciliation(record.event));
}

export function appendSelectedDeltas(
  current: ReadonlyMap<string, string>,
  records: EventRecordDto[],
  selectedThreadId: string | null,
  maximumItems = 128,
): Map<string, string> {
  const next = new Map(current);
  if (!selectedThreadId) return next;
  for (const record of records) {
    if (eventThreadId(record.event) !== selectedThreadId) continue;
    const delta = eventDelta(record.event);
    if (delta) next.set(delta.itemId, (next.get(delta.itemId) ?? "") + delta.delta);
  }
  while (next.size > maximumItems) {
    const oldest = next.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

export function pruneIncorporatedDeltas(
  thread: ThreadDto,
  current: ReadonlyMap<string, string>,
): Map<string, string> {
  if (!current.size) return new Map();
  const next = new Map(current);
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (!item.id) continue;
      const streamed = next.get(item.id);
      if (!streamed) continue;
      const authoritative = itemText(item);
      if (authoritative.endsWith(streamed)) {
        next.delete(item.id);
      } else if (authoritative && streamed.startsWith(authoritative)) {
        const remainder = streamed.slice(authoritative.length);
        if (remainder) next.set(item.id, remainder);
        else next.delete(item.id);
      }
    }
  }
  return next;
}

export function threadTitle(thread: ThreadDto): string {
  const preview = thread.preview?.replace(/\s+/g, " ").trim();
  return preview || "New Codex thread";
}

export function relativeTime(value: number | undefined, now = Date.now()): string {
  if (!value) return "";
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  const seconds = Math.max(0, Math.round((now - milliseconds) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function itemText(item: ThreadItemDto): string {
  for (const key of ["text", "output", "aggregatedOutput", "result", "summary"]) {
    if (typeof item[key] === "string") return item[key] as string;
  }
  const content = item.content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      const value = record(part);
      return typeof value.text === "string" ? value.text : typeof value.value === "string" ? value.value : "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function mergeStreamedText(base: string, delta: string | undefined): string {
  if (!delta) return base;
  if (!base) return delta;
  if (base.endsWith(delta)) return base;
  if (delta.startsWith(base)) return delta;
  return base + delta;
}

function toolLabel(item: ThreadItemDto): string {
  const type = item.type ?? "activity";
  if (/command/i.test(type)) return "Command";
  if (/file.*change|patch/i.test(type)) return "File changes";
  if (/mcp/i.test(type)) return typeof item.server === "string" ? `MCP · ${item.server}` : "MCP tool";
  if (/web.*search/i.test(type)) return "Web search";
  if (/tool/i.test(type) && typeof item.name === "string") return words(item.name);
  return words(type);
}

function toolFallback(item: ThreadItemDto): string {
  if (Array.isArray(item.command)) return item.command.join(" ");
  if (typeof item.command === "string") return item.command;
  if (typeof item.path === "string") return item.path;
  return "Activity details are not available.";
}

function words(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_/-]+/g, " ").replace(/^./, (char) => char.toUpperCase());
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalStatus(value: unknown): { status: string } | Record<string, never> {
  return typeof value === "string" ? { status: value } : {};
}
