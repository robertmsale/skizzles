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

export class PendingFirstTurnThreads {
  private readonly snapshots = new Map<string, ThreadDto>();

  remember(thread: ThreadDto): void {
    this.snapshots.set(thread.id, thread);
  }

  snapshot(threadId: string): ThreadDto | undefined {
    return this.snapshots.get(threadId);
  }

  materialized(threadId: string): void {
    this.snapshots.delete(threadId);
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
  for (const machine of machines) {
    const projectCwd = machine.threads.find((thread) => thread.threadId === threadId)?.projectCwd;
    if (projectCwd) return projectCwd;
  }
  return undefined;
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
  if (request.method === "item/commandExecution/requestApproval" || request.method === "execCommandApproval") {
    return commandApprovalDetail(params);
  }
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
  if (request.method === "item/commandExecution/requestApproval") {
    const params = record(request.params);
    const completeCommand = Boolean(commandText(params.command) && typeof params.cwd === "string" && params.cwd.trim());
    const network = record(params.networkApprovalContext);
    const completeNetwork = Boolean(
      typeof network.host === "string" && network.host
      && typeof network.protocol === "string" && network.protocol,
    );
    if (!completeCommand && !completeNetwork) return null;
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
      const baseText = itemText(item);
      const streamed = deltas.get(key);
      const text = type === "commandExecution" && baseText && streamed && !item.aggregatedOutput
        ? joinSections(baseText, streamed)
        : mergeStreamedText(baseText, streamed);
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
  if (event.method === "item/reasoning/textDelta") return null;
  const params = record(event.params);
  const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
  const delta = typeof params.delta === "string" ? params.delta : typeof params.text === "string" ? params.text : undefined;
  return itemId && delta ? { itemId, delta } : null;
}

export function eventNeedsReconciliation(event: { method: string; params?: unknown }): boolean {
  return BOARD_RECONCILIATION_METHODS.has(event.method);
}

export function eventMaterializesThread(event: { method: string; params?: unknown }): boolean {
  return event.method.startsWith("turn/") || event.method.startsWith("item/");
}

export function eventPageNeedsReconciliation(records: EventRecordDto[]): boolean {
  return records.some((record) => eventNeedsReconciliation(record.event));
}

export function eventPageNeedsSelectedThreadRead(
  records: EventRecordDto[],
  selectedThreadId: string | null,
): boolean {
  return Boolean(selectedThreadId && records.some((record) =>
    eventThreadId(record.event) === selectedThreadId
    && SELECTED_THREAD_READ_METHODS.has(record.event.method)));
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
  const name = typeof thread.name === "string" ? thread.name.replace(/\s+/g, " ").trim() : "";
  const preview = thread.preview?.replace(/\s+/g, " ").trim();
  return name || preview || "New Codex thread";
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
  const structured = structuredToolText(item);
  if (structured) return structured;
  for (const key of ["text", "output", "aggregatedOutput", "result", "summary"]) {
    if (typeof item[key] === "string") return item[key] as string;
  }
  if (Array.isArray(item.summary)) {
    const summary = item.summary.filter((part): part is string => typeof part === "string").join("\n");
    if (summary) return summary;
  }
  const content = item.content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      const value = record(part);
      if (value.type === "image" || value.type === "localImage") return "[Image attachment]";
      if (typeof value.text === "string") return value.text;
      if (typeof value.value === "string") return value.value;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function structuredToolText(item: ThreadItemDto): string {
  switch (item.type) {
    case "commandExecution": {
      const command = commandText(item.command);
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      return joinSections(command, output);
    }
    case "fileChange":
      return Array.isArray(item.changes)
        ? item.changes.map(formatFileChange).filter(Boolean).join("\n\n")
        : "";
    case "mcpToolCall": {
      const sections: string[] = [];
      if (typeof item.tool === "string" && item.tool) sections.push(`Tool: ${item.tool}`);
      if (item.arguments !== undefined) sections.push(`Arguments:\n${formatPayload(item.arguments)}`);
      if (item.result !== null && item.result !== undefined) sections.push(`Result:\n${formatPayload(item.result)}`);
      if (item.error !== null && item.error !== undefined) sections.push(`Error:\n${formatPayload(item.error)}`);
      return sections.join("\n\n");
    }
    case "functionCallOutput":
      return item.output === undefined ? "" : `Output:\n${formatPayload(item.output)}`;
    case "enteredReviewMode":
    case "exitedReviewMode":
      return typeof item.review === "string" ? item.review : "";
    case "webSearch": {
      const sections: string[] = [];
      if (typeof item.query === "string" && item.query) sections.push(`Query: ${item.query}`);
      if (item.action !== null && item.action !== undefined) sections.push(`Action:\n${formatPayload(item.action)}`);
      if (item.results !== null && item.results !== undefined) sections.push(`Results:\n${formatPayload(item.results)}`);
      return sections.join("\n\n");
    }
    default:
      return "";
  }
}

function commandText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string").join(" ") : "";
}

function commandApprovalDetail(params: Record<string, unknown>): string {
  const command = commandText(params.command);
  const sections = [
    `Command:\n${command || "Not provided"}`,
    `Working directory: ${typeof params.cwd === "string" && params.cwd ? params.cwd : "Not provided"}`,
    `Environment: ${typeof params.environmentId === "string" && params.environmentId ? params.environmentId : "Not specified"}`,
  ];
  if (typeof params.reason === "string" && params.reason) sections.push(`Reason:\n${params.reason}`);
  if (params.networkApprovalContext !== null && params.networkApprovalContext !== undefined) {
    sections.push(`Network approval:\n${formatPayload(params.networkApprovalContext)}`);
  }
  if (Array.isArray(params.commandActions) && params.commandActions.length) {
    sections.push(`Parsed actions:\n${formatPayload(params.commandActions)}`);
  }
  if (params.additionalPermissions !== null && params.additionalPermissions !== undefined) {
    sections.push(`Additional permissions:\n${formatPayload(params.additionalPermissions)}`);
  }
  if (params.proposedExecpolicyAmendment !== null && params.proposedExecpolicyAmendment !== undefined) {
    sections.push(`Proposed execution policy:\n${formatPayload(params.proposedExecpolicyAmendment)}`);
  }
  if (Array.isArray(params.proposedNetworkPolicyAmendments) && params.proposedNetworkPolicyAmendments.length) {
    sections.push(`Proposed network policy:\n${formatPayload(params.proposedNetworkPolicyAmendments)}`);
  }
  return sections.join("\n\n");
}

function formatFileChange(value: unknown): string {
  const change = record(value);
  if (typeof change.path !== "string") return formatPayload(value);
  const kind = record(change.kind);
  const type = typeof kind.type === "string"
    ? words(kind.type)
    : typeof change.kind === "string" ? words(change.kind) : "Change";
  const movePath = typeof kind.move_path === "string" ? ` → ${kind.move_path}` : "";
  const heading = `${type} · ${change.path}${movePath}`;
  return typeof change.diff === "string" && change.diff ? `${heading}\n${change.diff}` : heading;
}

function formatPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

function joinSections(...sections: string[]): string {
  return sections.filter(Boolean).join("\n\n");
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
  const command = commandText(item.command);
  if (command) return command;
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

const BOARD_RECONCILIATION_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "thread/archived",
  "thread/deleted",
  "thread/closed",
  "thread/name/updated",
]);

const SELECTED_THREAD_READ_METHODS = new Set([
  "thread/status/changed",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
]);
