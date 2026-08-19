import type { T3Thread, T3ThreadActivity, T3ThreadShell, ThreadSnapshot } from "./protocol.ts";

export type ApprovalRequestKind = "command" | "file-read" | "file-change";
export type ApprovalDecision = "accept" | "decline";

export type PendingApproval = {
  requestId: string;
  requestKind: ApprovalRequestKind | null;
  createdAt: string;
  command: string | null;
  toolName: string | null;
  cwd: string | null;
  identifiable: boolean;
  reason?: string;
};

export type ApprovalProject = {
  title?: string | null;
  workspaceRoot?: string | null;
};

export type ProjectedApproval = {
  threadId: string;
  title: string;
  projectId: string;
  projectTitle: string | null;
  workspaceRoot: string | null;
  provider: string;
  providerDriver: string | null;
  runtimeMode: string | null;
  requestId: string;
  requestKind: ApprovalRequestKind | null;
  toolName: string | null;
  command: string;
  cwd: string | null;
  worktreePath: string | null;
  createdAt: string;
};

export type UnidentifiableApproval = {
  threadId: string;
  title: string;
  projectId: string;
  projectTitle: string | null;
  workspaceRoot: string | null;
  provider: string;
  providerDriver: string | null;
  runtimeMode: string | null;
  requestId: string | null;
  reason: string;
  createdAt: string | null;
  worktreePath: string | null;
};

export const MISSING_COMMAND_GAP =
  "T3 did not expose a bindable command, path, URL, title, kind, or tool name for this pending approval. Refusing to approve blindly.";
export const CONFLICTING_COMMAND_GAP =
  "T3 approval payload has conflicting command or path representations. Refusing to approve blindly.";
export const APPROVAL_ACTION_CHANGED =
  "Pending approval action changed after judgment. Refusing to approve blindly.";
export const UNBOUND_ACCEPT_GAP =
  "T3 cannot bind accept to the judged action. Refusing to approve blindly.";
export const MISSING_SNAPSHOT_GAP =
  "T3 reports hasPendingApprovals, but the thread snapshot window did not include an approval.requested activity with a request id.";

export type ApprovalActionIdentity = {
  requestKind: ApprovalRequestKind | null;
  command: string | null;
  cwd: string | null;
  toolName: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asLiteralString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function unwrapPresentation(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner) return inner;
  }
  return trimmed;
}

function asActionText(value: unknown): string | null {
  const literal = asLiteralString(value);
  if (literal === null) return null;
  const unwrapped = unwrapPresentation(literal);
  return unwrapped.length > 0 ? unwrapped : null;
}

export function threadActivities(snapshot: ThreadSnapshot): T3ThreadActivity[] {
  const activities = snapshot.thread.activities;
  if (!Array.isArray(activities)) return [];
  return activities.filter((activity): activity is T3ThreadActivity =>
    Boolean(activity && typeof activity === "object" && typeof activity.kind === "string" && typeof activity.createdAt === "string")
  );
}

function requestKindFromRequestType(requestType: unknown): ApprovalRequestKind | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function requestKindFromPayload(payload: Record<string, unknown> | null): ApprovalRequestKind | null {
  if (!payload) return null;
  if (payload.requestKind === "command" || payload.requestKind === "file-read" || payload.requestKind === "file-change") {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload.requestType)
    ?? requestKindFromToolKind(uniqueTypedKinds(payload)[0] ?? null);
}

function isStalePendingRequestFailureDetail(detail: string | null): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request")
  );
}

function compareActivitiesByOrder(left: T3ThreadActivity, right: T3ThreadActivity): number {
  if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  if (left.sequence !== undefined && right.sequence === undefined) return 1;
  if (left.sequence === undefined && right.sequence !== undefined) return -1;
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  if (createdAt !== 0) return createdAt;
  return (left.id ?? "").localeCompare(right.id ?? "");
}

function xaiTool(record: Record<string, unknown> | null): Record<string, unknown> | null {
  const meta = asRecord(record?._meta);
  return asRecord(meta?.["x.ai/tool"]);
}

function nestedActionRecords(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const payloadArgs = asRecord(payload.arguments) ?? asRecord(payload.args);
  const dataArgs = asRecord(data?.arguments) ?? asRecord(data?.args);
  const itemArgs = asRecord(item?.arguments) ?? asRecord(item?.args);
  const toolCall = asRecord(payload.toolCall)
    ?? asRecord(payloadArgs?.toolCall)
    ?? asRecord(data?.toolCall)
    ?? asRecord(dataArgs?.toolCall)
    ?? asRecord(item?.toolCall);
  const records = [
    payload,
    data,
    item,
    asRecord(data?.input),
    asRecord(item?.input),
    asRecord(item?.result),
    asRecord(data?.result),
    payloadArgs,
    dataArgs,
    itemArgs,
    toolCall,
    asRecord(payload.rawInput),
    asRecord(data?.rawInput),
    asRecord(item?.rawInput),
    asRecord(payloadArgs?.rawInput),
    asRecord(dataArgs?.rawInput),
    asRecord(itemArgs?.rawInput),
    asRecord(toolCall?.rawInput),
    xaiTool(payload),
    xaiTool(data),
    xaiTool(item),
    xaiTool(payloadArgs),
    xaiTool(toolCall),
    asRecord(xaiTool(payload)?.input),
    asRecord(xaiTool(data)?.input),
    asRecord(xaiTool(item)?.input),
    asRecord(xaiTool(payloadArgs)?.input),
    asRecord(xaiTool(toolCall)?.input),
  ];
  return records.filter((record): record is Record<string, unknown> => record !== null);
}

function uniqueTypedActions(payload: Record<string, unknown>): { commands: string[]; paths: string[] } {
  const records = nestedActionRecords(payload);
  const commands = uniqueNonEmpty(records.flatMap((record) => [
    asActionText(record.command),
    asActionText(record.rawCommand),
  ]));
  const details = uniqueNonEmpty(records.map((record) => asActionText(record.detail)))
    .filter((value) => !isGenericApprovalLabel(value));
  const paths = uniqueNonEmpty(records.map((record) => asLiteralString(record.path)));
  return { commands: uniqueNonEmpty([...commands, ...details]), paths };
}

const GENERIC_APPROVAL_LABELS = new Set([
  "searched files",
  "run requested command",
  "run requested tool",
  "fetch",
  "search",
  "read",
  "edit",
  "write",
  "execute",
  "shell",
  "other",
]);

export function isGenericApprovalLabel(value: string | null | undefined): boolean {
  if (value == null) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return GENERIC_APPROVAL_LABELS.has(trimmed.toLowerCase());
}

function uniqueTypedUrls(payload: Record<string, unknown>): string[] {
  return uniqueNonEmpty(nestedActionRecords(payload).flatMap((record) => [
    asLiteralString(record.url),
    asLiteralString(record.uri),
    asLiteralString(record.href),
  ]));
}

function uniqueTypedQueries(payload: Record<string, unknown>): string[] {
  return uniqueNonEmpty(nestedActionRecords(payload).flatMap((record) => [
    asLiteralString(record.query),
    asLiteralString(record.pattern),
    asLiteralString(record.search),
  ]));
}

function uniqueTypedTitles(payload: Record<string, unknown>): string[] {
  return uniqueNonEmpty(nestedActionRecords(payload).flatMap((record) => [
    asActionText(record.title),
  ])).filter((value) => !isGenericApprovalLabel(value));
}

function uniqueTypedKinds(payload: Record<string, unknown>): string[] {
  return uniqueNonEmpty(nestedActionRecords(payload).flatMap((record) => [
    asLiteralString(record.kind),
  ])).filter((value) => value !== "allow_once" && value !== "allow_always" && value !== "reject_once");
}

function uniqueTypedToolCallIds(payload: Record<string, unknown>): string[] {
  return uniqueNonEmpty(nestedActionRecords(payload).flatMap((record) => [
    asLiteralString(record.toolCallId),
  ]));
}

function composeKindIdentity(kind: string | null, toolCallId: string | null): string | null {
  if (kind && toolCallId) return `${kind}:${toolCallId}`;
  return null;
}

function requestKindFromToolKind(kind: string | null): ApprovalRequestKind | null {
  switch (kind?.trim().toLowerCase()) {
    case "read":
      return "file-read";
    case "edit":
    case "write":
    case "delete":
    case "move":
      return "file-change";
    case "execute":
    case "fetch":
    case "search":
    case "other":
      return "command";
    default:
      return kind ? "command" : null;
  }
}

function uniqueNonEmpty(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

function uniqueTypedCwds(payload: Record<string, unknown>): string[] {
  return uniqueNonEmpty(nestedActionRecords(payload).flatMap((record) => [
    asLiteralString(record.cwd),
    asLiteralString(record.workingDirectory),
  ]));
}

function uniqueTypedTools(payload: Record<string, unknown>): string[] {
  const records = nestedActionRecords(payload);
  const xaiNames = records
    .map((record) => xaiTool(record))
    .map((record) => asLiteralString(record?.name));
  return uniqueNonEmpty([
    asLiteralString(payload.toolName),
    ...xaiNames,
    ...records.flatMap((record) => [
      asLiteralString(record.toolName),
      asLiteralString(record.tool),
    ]),
  ]).filter((value) => !isGenericApprovalLabel(value));
}

function firstOrConflict(values: string[]): { value: string | null; conflict: boolean } {
  if (values.length > 1) return { value: null, conflict: true };
  return { value: values[0] ?? null, conflict: false };
}

function extractTypedAction(payload: Record<string, unknown> | null): {
  command: string | null;
  cwd: string | null;
  toolName: string | null;
  commandSource: "command" | "path" | null;
  kind: string | null;
  reason?: string;
} {
  if (!payload) {
    return { command: null, cwd: null, toolName: null, commandSource: null, kind: null, reason: MISSING_COMMAND_GAP };
  }
  const { commands, paths } = uniqueTypedActions(payload);
  const urls = uniqueTypedUrls(payload);
  const queries = uniqueTypedQueries(payload);
  const titles = uniqueTypedTitles(payload);
  const kinds = uniqueTypedKinds(payload);
  const toolCallIds = uniqueTypedToolCallIds(payload);
  const cwds = uniqueTypedCwds(payload);
  const tools = uniqueTypedTools(payload);
  const command = firstOrConflict(commands);
  const path = firstOrConflict(paths);
  const url = firstOrConflict(urls);
  const query = firstOrConflict(queries);
  const title = firstOrConflict(titles);
  const kind = firstOrConflict(kinds);
  const toolCallId = firstOrConflict(toolCallIds);
  const cwd = firstOrConflict(cwds);
  const tool = firstOrConflict(tools);
  if (
    command.conflict || path.conflict || url.conflict || query.conflict || title.conflict
    || kind.conflict || toolCallId.conflict || cwd.conflict || tool.conflict
  ) {
    return { command: null, cwd: null, toolName: null, commandSource: null, kind: null, reason: CONFLICTING_COMMAND_GAP };
  }
  const identity = command.value
    ?? path.value
    ?? url.value
    ?? title.value
    ?? query.value
    ?? composeKindIdentity(kind.value, toolCallId.value)
    ?? tool.value;
  const presented = asActionText(payload.detail);
  if (
    identity
    && presented
    && !isGenericApprovalLabel(presented)
    && unwrapPresentation(identity) !== presented
  ) {
    return { command: null, cwd: null, toolName: null, commandSource: null, kind: kind.value, reason: CONFLICTING_COMMAND_GAP };
  }
  if (!identity) {
    return {
      command: null,
      cwd: cwd.value,
      toolName: tool.value ?? kind.value,
      commandSource: null,
      kind: kind.value,
      reason: MISSING_COMMAND_GAP,
    };
  }
  return {
    command: identity,
    cwd: cwd.value,
    toolName: tool.value ?? kind.value ?? toolCallId.value,
    commandSource: command.value ? "command" : path.value ? "path" : "command",
    kind: kind.value,
  };
}

function extractToolName(activity: T3ThreadActivity, payload: Record<string, unknown> | null): string | null {
  if (!payload) {
    const summary = asTrimmedString(activity.summary);
    return isGenericApprovalLabel(summary) ? null : summary;
  }
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const toolCall = asRecord(payload.toolCall)
    ?? asRecord(asRecord(payload.args)?.toolCall)
    ?? asRecord(asRecord(payload.arguments)?.toolCall);
  const xai = xaiTool(payload) ?? xaiTool(data) ?? xaiTool(asRecord(payload.args)) ?? xaiTool(toolCall);
  const candidates = [
    asTrimmedString(payload.toolName),
    asTrimmedString(xai?.name),
    asTrimmedString(data?.toolName),
    asTrimmedString(item?.tool),
    asTrimmedString(payload.title),
    asTrimmedString(toolCall?.kind),
    asTrimmedString(toolCall?.toolCallId),
    asTrimmedString(payload.itemType),
    asTrimmedString(activity.summary),
  ];
  return candidates.find((value) => value && value.trim().toLowerCase() !== "searched files") ?? null;
}

export function derivePendingApprovals(activities: readonly T3ThreadActivity[]): PendingApproval[] {
  const openByRequestId = new Map<string, PendingApproval>();
  for (const activity of [...activities].sort(compareActivitiesByOrder)) {
    const payload = asRecord(activity.payload);
    const requestId = asTrimmedString(payload?.requestId);
    if (!requestId) continue;
    const detail = asTrimmedString(payload?.detail);
    if (activity.kind === "approval.requested") {
      const extracted = extractTypedAction(payload);
      const requestKind = requestKindFromPayload(payload)
        ?? (extracted.commandSource === "command" ? "command" : extracted.commandSource === "path" ? "file-read" : null)
        ?? requestKindFromToolKind(extracted.kind);
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        command: extracted.command,
        toolName: extracted.toolName ?? extractToolName(activity, payload),
        cwd: extracted.cwd,
        identifiable: extracted.command !== null && extracted.command.trim() !== "",
        ...(extracted.reason ? { reason: extracted.reason } : {}),
      });
      continue;
    }
    if (activity.kind === "approval.resolved") {
      openByRequestId.delete(requestId);
      continue;
    }
    if (activity.kind === "provider.approval.respond.failed" && isStalePendingRequestFailureDetail(detail)) {
      openByRequestId.delete(requestId);
    }
  }
  return [...openByRequestId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.requestId.localeCompare(right.requestId));
}

export function selectPendingApproval(pending: readonly PendingApproval[], requestId?: string): PendingApproval {
  const selector = requestId?.trim();
  if (selector) {
    const match = pending.find((approval) => approval.requestId === selector);
    if (!match) throw new Error(`No pending approval matches request id ${selector}`);
    return match;
  }
  if (pending.length === 0) {
    throw new Error("This thread has no pending approval in the T3 thread snapshot");
  }
  if (pending.length > 1) {
    throw new Error(`Thread has ${pending.length} pending approvals; pass the request id from t3ctl tasks approvals`);
  }
  return pending[0]!;
}

export function requireIdentifiableApproval(approval: PendingApproval): void {
  if (approval.identifiable && approval.command) return;
  throw new Error(approval.reason ?? MISSING_COMMAND_GAP);
}

export function approvalActionIdentity(approval: Pick<PendingApproval, "requestKind" | "command" | "cwd" | "toolName">): ApprovalActionIdentity {
  return {
    requestKind: approval.requestKind,
    command: approval.command,
    cwd: approval.cwd,
    toolName: approval.toolName,
  };
}

export function sameApprovalAction(left: ApprovalActionIdentity, right: ApprovalActionIdentity): boolean {
  return left.requestKind === right.requestKind &&
    left.command === right.command &&
    left.cwd === right.cwd &&
    left.toolName === right.toolName;
}

export function hasBindableApprovalAction(action: ApprovalActionIdentity | undefined): action is ApprovalActionIdentity {
  return Boolean(action && typeof action.command === "string" && action.command.trim() !== "");
}

function threadProvider(thread: T3Thread): string {
  return thread.modelSelection.instanceId;
}

export function providerDriversFromConfig(config: unknown): Map<string, string> {
  const providers = config && typeof config === "object" && "providers" in config
    ? (config as { providers?: unknown }).providers
    : undefined;
  const drivers = new Map<string, string>();
  if (!Array.isArray(providers)) return drivers;
  for (const entry of providers) {
    if (!entry || typeof entry !== "object") continue;
    const provider = entry as { instanceId?: unknown; driver?: unknown };
    if (typeof provider.instanceId !== "string" || provider.instanceId.trim() === "") continue;
    if (typeof provider.driver !== "string" || provider.driver.trim() === "") continue;
    drivers.set(provider.instanceId, provider.driver.trim());
  }
  return drivers;
}

function projectContext(
  thread: T3ThreadShell,
  projects?: ReadonlyMap<string, ApprovalProject>,
): { projectTitle: string | null; workspaceRoot: string | null } {
  const project = projects?.get(thread.projectId);
  return {
    projectTitle: project?.title?.trim() || null,
    workspaceRoot: project?.workspaceRoot?.trim() || null,
  };
}

export function resolveProjectedRuntimeMode(
  thread: Pick<T3ThreadShell, "runtimeMode">,
  snapshot?: Pick<ThreadSnapshot, "thread">,
): string | null {
  const fromThread = asTrimmedString(thread.runtimeMode);
  const fromSnapshot = asTrimmedString(snapshot?.thread.runtimeMode);
  if (fromThread && fromSnapshot && fromThread.toLowerCase() !== fromSnapshot.toLowerCase()) return null;
  return fromThread ?? fromSnapshot;
}

export function projectPendingApprovalList(
  threads: readonly T3ThreadShell[],
  snapshots: ReadonlyMap<string, ThreadSnapshot>,
  projects?: ReadonlyMap<string, ApprovalProject>,
  drivers?: ReadonlyMap<string, string>,
): { approvals: ProjectedApproval[]; unidentifiable: UnidentifiableApproval[]; count: number } {
  const approvals: ProjectedApproval[] = [];
  const unidentifiable: UnidentifiableApproval[] = [];
  for (const thread of threads) {
    if (thread.deletedAt || thread.archivedAt || !thread.hasPendingApprovals) continue;
    const snapshot = snapshots.get(thread.id);
    const pending = snapshot ? derivePendingApprovals(threadActivities(snapshot)) : [];
    const context = projectContext(thread, projects);
    const provider = threadProvider(thread);
    const providerDriver = drivers?.get(provider)?.trim() || null;
    const runtimeMode = resolveProjectedRuntimeMode(thread, snapshot);
    if (pending.length === 0) {
      unidentifiable.push({
        threadId: thread.id,
        title: thread.title,
        projectId: thread.projectId,
        ...context,
        provider,
        providerDriver,
        runtimeMode,
        requestId: null,
        reason: MISSING_SNAPSHOT_GAP,
        createdAt: thread.updatedAt ?? null,
        worktreePath: thread.worktreePath,
      });
      continue;
    }
    for (const approval of pending) {
      if (approval.identifiable && approval.command) {
        approvals.push({
          threadId: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          ...context,
          provider,
          providerDriver,
          runtimeMode,
          requestId: approval.requestId,
          requestKind: approval.requestKind,
          toolName: approval.toolName,
          command: approval.command,
          cwd: approval.cwd,
          worktreePath: thread.worktreePath,
          createdAt: approval.createdAt,
        });
        continue;
      }
      unidentifiable.push({
        threadId: thread.id,
        title: thread.title,
        projectId: thread.projectId,
        ...context,
        provider,
        providerDriver,
        runtimeMode,
        requestId: approval.requestId,
        reason: approval.reason ?? MISSING_COMMAND_GAP,
        createdAt: approval.createdAt,
        worktreePath: thread.worktreePath,
      });
    }
  }
  approvals.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.threadId.localeCompare(right.threadId) || left.requestId.localeCompare(right.requestId));
  unidentifiable.sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? "") || left.threadId.localeCompare(right.threadId));
  return { approvals, unidentifiable, count: approvals.length };
}

export function approvalRespondCommand(
  threadId: string,
  requestId: string,
  decision: ApprovalDecision,
  commandId: string,
  createdAt: string,
  _expected?: ApprovalActionIdentity,
) {
  return {
    type: "thread.approval.respond",
    commandId,
    threadId,
    requestId,
    decision,
    createdAt,
  };
}
