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
  "T3 did not expose the command or path for this pending approval. Refusing to approve blindly.";
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
  return requestKindFromRequestType(payload.requestType);
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
  const commands = [...new Set(records
    .map((record) => asLiteralString(record.command))
    .filter((value): value is string => value !== null))];
  const paths = [...new Set(records
    .map((record) => asLiteralString(record.path))
    .filter((value): value is string => value !== null))];
  return { commands, paths };
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
  ]);
}

function extractTypedAction(payload: Record<string, unknown> | null): {
  command: string | null;
  cwd: string | null;
  toolName: string | null;
  commandSource: "command" | "path" | null;
  reason?: string;
} {
  if (!payload) return { command: null, cwd: null, toolName: null, commandSource: null, reason: MISSING_COMMAND_GAP };
  const { commands, paths } = uniqueTypedActions(payload);
  const typed = [...new Set([...commands, ...paths])];
  const cwds = uniqueTypedCwds(payload);
  const tools = uniqueTypedTools(payload);
  const detail = asLiteralString(payload.detail);
  if (typed.length > 1 || cwds.length > 1 || tools.length > 1) {
    return { command: null, cwd: null, toolName: null, commandSource: null, reason: CONFLICTING_COMMAND_GAP };
  }
  if (typed.length === 1) {
    if (detail !== null && detail !== typed[0]) return { command: null, cwd: null, toolName: null, commandSource: null, reason: CONFLICTING_COMMAND_GAP };
    return {
      command: typed[0]!,
      cwd: cwds[0] ?? null,
      toolName: tools[0] ?? null,
      commandSource: commands.length === 1 ? "command" : "path",
    };
  }
  return { command: null, cwd: cwds[0] ?? null, toolName: tools[0] ?? null, commandSource: null, reason: MISSING_COMMAND_GAP };
}

function extractToolName(activity: T3ThreadActivity, payload: Record<string, unknown> | null): string | null {
  if (!payload) return asTrimmedString(activity.summary);
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const xai = xaiTool(payload) ?? xaiTool(data) ?? xaiTool(asRecord(payload.args)) ?? xaiTool(asRecord(payload.toolCall));
  return asTrimmedString(payload.toolName)
    ?? asTrimmedString(xai?.name)
    ?? asTrimmedString(payload.title)
    ?? asTrimmedString(data?.toolName)
    ?? asTrimmedString(item?.tool)
    ?? asTrimmedString(payload.itemType)
    ?? asTrimmedString(activity.summary);
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
        ?? (extracted.commandSource === "command" ? "command" : null);
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
