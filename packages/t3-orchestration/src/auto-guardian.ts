import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  APPROVAL_ACTION_CHANGED,
  MISSING_COMMAND_GAP,
  MISSING_SNAPSHOT_GAP,
  UNBOUND_ACCEPT_GAP,
  approvalActionIdentity,
  requireIdentifiableApproval,
  sameApprovalAction,
  type ApprovalActionIdentity,
  type ApprovalDecision,
  type ProjectedApproval,
  type UnidentifiableApproval,
} from "./approval-projection.ts";
import { tryExclusiveFileLock, withExclusiveFileLock } from "./exclusive-lock.ts";
import {
  projectAllowed,
  type GuardianConfig,
} from "./auto-guardian-config.ts";
import {
  buildGuardianUserPrompt,
  decodeGuardianAssessment,
  GUARDIAN_OUTPUT_SCHEMA,
  lastUserMessageText,
  officialGuardianPolicyPrompt,
  type GuardianAssessment,
  type PlannedAction,
} from "./auto-guardian-policy.ts";

export const CODEX_PROVIDER_INSTANCE = "codex";
export const NON_CODEX_PROVIDERS = ["grok", "cursor", "opencode"] as const;
export const AUTO_RUNTIME_MODE = "auto";
const STATE_SCHEMA = 4;
const HISTORY_TURNS = 10;
export const GUARDIAN_CLAIM_LEASE_MS = 30_000;

export type GuardianCandidate = {
  threadId: string;
  title: string;
  projectId: string;
  projectTitle: string | null;
  workspaceRoot: string | null;
  provider: string;
  providerDriver: string | null;
  runtimeMode: string;
  requestId: string | null;
  requestKind: string | null;
  toolName: string | null;
  command: string | null;
  cwd: string | null;
  worktreePath: string | null;
  createdAt: string | null;
  identifiable: boolean;
  snapshotGap: boolean;
  gapReason?: string;
};

export type GuardianAction =
  | "skipped_codex"
  | "skipped_runtime"
  | "skipped_project"
  | "skipped_snapshot_gap"
  | "skipped_duplicate"
  | "denied_unidentifiable"
  | "judged"
  | "dry_run";

export type GuardianDecisionRecord = {
  action: GuardianAction;
  threadId: string;
  requestId: string | null;
  provider: string;
  runtimeMode: string;
  command: string | null;
  decision: ApprovalDecision | null;
  reason: string;
  dryRun: boolean;
  responded: boolean;
};

export type GuardianCycleReport = {
  ok: boolean;
  enabled: boolean;
  dryRun: boolean;
  model: string;
  modelReasoningEffort: string;
  scanned: number;
  decisions: GuardianDecisionRecord[];
  error?: string;
};

export type GuardianClaim = {
  threadId: string;
  decision: ApprovalDecision;
  at: string;
  status: "pending" | "completed";
  leaseId?: string;
  leaseUntil?: string;
  attempt?: number;
  action?: ApprovalActionIdentity;
};

export type GuardianState = {
  schema: 1 | 2 | 3 | 4;
  responded: Record<string, GuardianClaim>;
  lastPollAt: string | null;
  lastError: string | null;
};

export type ClaimResult = {
  status: "claimed" | "duplicate" | "retry";
  decision?: ApprovalDecision;
  leaseId?: string;
  action?: ApprovalActionIdentity;
};

export type ApprovalList = {
  approvals: ProjectedApproval[];
  unidentifiable: UnidentifiableApproval[];
};

export type HistoryResult = {
  messages?: Array<{ role?: unknown; text?: unknown }>;
};

export type JudgeInput = {
  model: string;
  modelReasoningEffort: string;
  timeoutMs: number;
  lastUserMessage: string | null;
  action: PlannedAction;
  cwd: string | null;
};

export type JudgeResult =
  | { ok: true; assessment: GuardianAssessment; raw: string }
  | { ok: false; reason: string; raw?: string };

export type GuardianDependencies = {
  listTaskApprovals(projectId?: string): Promise<ApprovalList>;
  resolveTaskApproval(input: {
    threadId: string;
    requestId?: string;
    decision: ApprovalDecision;
    reason?: string;
    expected?: ApprovalActionIdentity;
  }): Promise<unknown>;
  taskHistory(threadId: string, turns: number): Promise<HistoryResult>;
  judge(input: JudgeInput): Promise<JudgeResult>;
  now(): string;
  loadState(): Promise<GuardianState>;
  recordPoll(at: string, error: string | null): Promise<void>;
  claimRequest(input: { requestId: string; threadId: string; decision: ApprovalDecision; at: string; action?: ApprovalActionIdentity }): Promise<ClaimResult>;
  withDeliveryLock<T>(threadId: string, requestId: string, body: () => Promise<T>): Promise<T>;
  renewRequest(requestId: string, leaseId: string, threadId: string): Promise<boolean>;
  completeRequest(requestId: string, leaseId: string, threadId: string, decision?: ApprovalDecision): Promise<boolean>;
  releaseRequest(requestId: string, leaseId: string, threadId: string): Promise<void>;
  reconcileRequests(liveRequestIds: Iterable<string>): Promise<void>;
};

export function guardianClaimKey(threadId: string, requestId: string): string {
  return `${threadId}\0${requestId}`;
}

function parseGuardianClaimKey(key: string, fallbackThreadId: string): { threadId: string; requestId: string } {
  const split = key.indexOf("\0");
  if (split >= 0) return { threadId: key.slice(0, split), requestId: key.slice(split + 1) };
  return { threadId: fallbackThreadId, requestId: key };
}

export function hasCompleteActionIdentity(action: ApprovalActionIdentity | undefined): action is ApprovalActionIdentity {
  return Boolean(
    action &&
    (action.requestKind === "command" || action.requestKind === "file-read" || action.requestKind === "file-change") &&
    typeof action.command === "string" &&
    action.command.trim() !== "",
  );
}

function parseClaimAction(value: unknown): ApprovalActionIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const action = value as {
    requestKind?: unknown;
    command?: unknown;
    cwd?: unknown;
    toolName?: unknown;
  };
  return {
    requestKind: action.requestKind === "command" || action.requestKind === "file-read" || action.requestKind === "file-change"
      ? action.requestKind
      : null,
    command: typeof action.command === "string" ? action.command : null,
    cwd: typeof action.cwd === "string" ? action.cwd : null,
    toolName: typeof action.toolName === "string" ? action.toolName : null,
  };
}

export function defaultGuardianStatePath(home = process.env.HOME || homedir()): string {
  const t3Home = resolve(process.env.T3_HOME?.trim() || join(home, ".t3"));
  return join(t3Home, "t3-auto-guardian-state.json");
}

export function emptyGuardianState(): GuardianState {
  return { schema: STATE_SCHEMA, responded: {}, lastPollAt: null, lastError: null };
}

function normalizeClaims(value: unknown): Record<string, GuardianClaim> {
  if (!value || typeof value !== "object") return {};
  const claims: Record<string, GuardianClaim> = {};
  for (const [rawKey, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const claim = entry as {
      threadId?: unknown;
      decision?: unknown;
      at?: unknown;
      status?: unknown;
      leaseId?: unknown;
      leaseUntil?: unknown;
      attempt?: unknown;
      action?: unknown;
    };
    if (typeof claim.threadId !== "string" || (claim.decision !== "accept" && claim.decision !== "decline")) continue;
    if (typeof claim.at !== "string") continue;
    const parsed = parseGuardianClaimKey(rawKey, claim.threadId);
    const action = parseClaimAction(claim.action);
    claims[guardianClaimKey(parsed.threadId, parsed.requestId)] = {
      threadId: parsed.threadId,
      decision: claim.decision,
      at: claim.at,
      status: claim.status === "pending" ? "pending" : "completed",
      ...(typeof claim.leaseId === "string" ? { leaseId: claim.leaseId } : {}),
      ...(typeof claim.leaseUntil === "string" ? { leaseUntil: claim.leaseUntil } : {}),
      ...(typeof claim.attempt === "number" ? { attempt: claim.attempt } : {}),
      ...(action ? { action } : {}),
    };
  }
  return claims;
}

export function isCodexProvider(instanceId: string | null | undefined): boolean {
  const value = instanceId?.trim().toLowerCase() ?? "";
  if (!value) return true;
  return !(NON_CODEX_PROVIDERS as readonly string[]).includes(value);
}

export function isAutoRuntime(runtimeMode: string | null | undefined): boolean {
  return runtimeMode?.trim().toLowerCase() === AUTO_RUNTIME_MODE;
}

export function isCodexDriver(driver: string | null | undefined): boolean {
  return driver?.trim().toLowerCase() === CODEX_PROVIDER_INSTANCE;
}

export function isKnownNonCodexDriver(driver: string | null | undefined): boolean {
  const value = driver?.trim().toLowerCase() ?? "";
  return (NON_CODEX_PROVIDERS as readonly string[]).includes(value);
}

export function isGuardianEligible(target: { provider: string; providerDriver?: string | null; runtimeMode: string }): { eligible: boolean; action?: GuardianAction; reason?: string } {
  if (!isAutoRuntime(target.runtimeMode)) {
    return { eligible: false, action: "skipped_runtime", reason: `runtimeMode ${target.runtimeMode} is not auto` };
  }
  const driver = target.providerDriver?.trim() || null;
  if (!driver) {
    return { eligible: false, action: "skipped_codex", reason: "provider driver is unavailable" };
  }
  if (isCodexDriver(driver) || !isKnownNonCodexDriver(driver)) {
    return { eligible: false, action: "skipped_codex", reason: "provider is Codex or not a known non-Codex Auto harness" };
  }
  return { eligible: true };
}

export function candidatesFromApprovalList(list: ApprovalList): GuardianCandidate[] {
  const identifiable = list.approvals.map((approval): GuardianCandidate => ({
    threadId: approval.threadId,
    title: approval.title,
    projectId: approval.projectId,
    projectTitle: approval.projectTitle,
    workspaceRoot: approval.workspaceRoot,
    provider: approval.provider,
    providerDriver: approval.providerDriver,
    runtimeMode: approval.runtimeMode,
    requestId: approval.requestId,
    requestKind: approval.requestKind,
    toolName: approval.toolName,
    command: approval.command,
    cwd: approval.cwd,
    worktreePath: approval.worktreePath,
    createdAt: approval.createdAt,
    identifiable: true,
    snapshotGap: false,
  }));
  const unidentifiable = list.unidentifiable.map((approval): GuardianCandidate => ({
    threadId: approval.threadId,
    title: approval.title,
    projectId: approval.projectId,
    projectTitle: approval.projectTitle,
    workspaceRoot: approval.workspaceRoot,
    provider: approval.provider,
    providerDriver: approval.providerDriver,
    runtimeMode: approval.runtimeMode,
    requestId: approval.requestId,
    requestKind: null,
    toolName: null,
    command: null,
    cwd: null,
    worktreePath: approval.worktreePath,
    createdAt: approval.createdAt,
    identifiable: false,
    snapshotGap: approval.requestId == null,
    gapReason: approval.reason,
  }));
  return [...identifiable, ...unidentifiable].sort((left, right) =>
    (left.createdAt ?? "").localeCompare(right.createdAt ?? "") ||
    left.threadId.localeCompare(right.threadId) ||
    (left.requestId ?? "").localeCompare(right.requestId ?? ""),
  );
}

function candidateAction(candidate: GuardianCandidate): ApprovalActionIdentity {
  return approvalActionIdentity({
    requestKind: candidate.requestKind === "file-read" || candidate.requestKind === "file-change" || candidate.requestKind === "command"
      ? candidate.requestKind
      : null,
    command: candidate.command,
    cwd: candidate.cwd ?? candidate.worktreePath,
    toolName: candidate.toolName,
  });
}

async function claimOrSkip(
  dependencies: GuardianDependencies,
  input: { requestId: string; threadId: string; decision: ApprovalDecision; at: string; action?: ApprovalActionIdentity },
  dryRun: boolean,
): Promise<ClaimResult> {
  if (dryRun) return { status: "claimed" };
  return dependencies.claimRequest(input);
}

async function deliverClaim(
  dependencies: GuardianDependencies,
  input: {
    threadId: string;
    requestId: string;
    decision: ApprovalDecision;
    reason: string;
    leaseId?: string;
    action?: ApprovalActionIdentity;
  },
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;
  if (!input.leaseId) return false;
  if (input.decision === "accept") {
    input = {
      ...input,
      decision: "decline",
      reason: hasCompleteActionIdentity(input.action) ? UNBOUND_ACCEPT_GAP : "legacy claim has no action identity",
    };
  }
  return dependencies.withDeliveryLock(input.threadId, input.requestId, async () => {
    if (!await dependencies.renewRequest(input.requestId, input.leaseId!, input.threadId)) return false;
    try {
      await dependencies.resolveTaskApproval({
        threadId: input.threadId,
        requestId: input.requestId,
        decision: input.decision,
        reason: input.reason,
        ...(input.decision === "accept" && input.action ? { expected: input.action } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (input.decision === "accept" && message === APPROVAL_ACTION_CHANGED) {
        await dependencies.resolveTaskApproval({
          threadId: input.threadId,
          requestId: input.requestId,
          decision: "decline",
          reason: APPROVAL_ACTION_CHANGED,
        });
        return dependencies.completeRequest(input.requestId, input.leaseId!, input.threadId, "decline");
      }
      await dependencies.releaseRequest(input.requestId, input.leaseId!, input.threadId);
      return false;
    }
    return dependencies.completeRequest(input.requestId, input.leaseId!, input.threadId, input.decision);
  });
}

export async function runGuardianCycle(
  dependencies: GuardianDependencies,
  config: GuardianConfig,
): Promise<GuardianCycleReport> {
  const now = dependencies.now();
  let state = await dependencies.loadState();
  if (!config.enabled) {
    await dependencies.recordPoll(now, null);
    return {
      ok: true,
      enabled: false,
      dryRun: config.dryRun,
      model: config.model,
      modelReasoningEffort: config.modelReasoningEffort,
      scanned: 0,
      decisions: [],
    };
  }

  try {
    const list = await dependencies.listTaskApprovals();
    const candidates = candidatesFromApprovalList(list);
    const liveRequestIds = candidates.flatMap((candidate) =>
      candidate.requestId ? [guardianClaimKey(candidate.threadId, candidate.requestId)] : []
    );
    const snapshotIncomplete = candidates.some((candidate) => candidate.snapshotGap);
    if (!snapshotIncomplete) await dependencies.reconcileRequests(liveRequestIds);
    state = await dependencies.loadState();
    const decisions: GuardianDecisionRecord[] = [];

    for (const candidate of candidates) {
      const eligibility = isGuardianEligible(candidate);
      if (!eligibility.eligible) {
        decisions.push({
          action: eligibility.action!,
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          provider: candidate.provider,
          runtimeMode: candidate.runtimeMode,
          command: candidate.command,
          decision: null,
          reason: eligibility.reason!,
          dryRun: config.dryRun,
          responded: false,
        });
        continue;
      }

      const project = projectAllowed(candidate, config);
      if (!project.allowed) {
        decisions.push({
          action: "skipped_project",
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          provider: candidate.provider,
          runtimeMode: candidate.runtimeMode,
          command: candidate.command,
          decision: null,
          reason: project.reason!,
          dryRun: config.dryRun,
          responded: false,
        });
        continue;
      }

      const existing = candidate.requestId
        ? state.responded[guardianClaimKey(candidate.threadId, candidate.requestId)]
        : undefined;
      if (existing?.status === "completed" && existing.decision !== "accept") {
        decisions.push({
          action: "skipped_duplicate",
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          provider: candidate.provider,
          runtimeMode: candidate.runtimeMode,
          command: candidate.command,
          decision: existing.decision,
          reason: "already responded to this requestId",
          dryRun: config.dryRun,
          responded: false,
        });
        continue;
      }

      if (existing?.status === "pending" && candidate.requestId) {
        const currentAction = candidateAction(candidate);
        const actionlessAccept = existing.decision === "accept" && !hasCompleteActionIdentity(existing.action);
        const identityMismatch = existing.decision === "accept" &&
          hasCompleteActionIdentity(existing.action) &&
          !sameApprovalAction(existing.action, currentAction);
        const retryDecision = actionlessAccept || identityMismatch ? "decline" : existing.decision;
        const retryAction = actionlessAccept || identityMismatch ? currentAction : existing.action;
        const retryReason = actionlessAccept
          ? "legacy claim has no action identity"
          : identityMismatch
            ? "stored accept identity does not match the current action"
            : "retrying incomplete guardian claim";
        const claim = await claimOrSkip(dependencies, {
          requestId: candidate.requestId,
          threadId: candidate.threadId,
          decision: retryDecision,
          at: now,
          action: retryAction,
        }, config.dryRun);
        if (!config.dryRun && claim.status === "duplicate") {
          decisions.push({
            action: "skipped_duplicate",
            threadId: candidate.threadId,
            requestId: candidate.requestId,
            provider: candidate.provider,
            runtimeMode: candidate.runtimeMode,
            command: candidate.command,
            decision: existing.decision,
            reason: "already responded to this requestId",
            dryRun: config.dryRun,
            responded: false,
          });
          continue;
        }
        const decision = (claim.decision ?? retryDecision) === "accept" ? "decline" : (claim.decision ?? retryDecision);
        const reason = (claim.decision ?? retryDecision) === "accept" ? UNBOUND_ACCEPT_GAP : retryReason;
        const responded = await deliverClaim(dependencies, {
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          decision,
          reason,
          leaseId: claim.leaseId,
          action: retryAction,
        }, config.dryRun);
        state = await dependencies.loadState();
        decisions.push({
          action: config.dryRun ? "dry_run" : decision === "decline" && actionlessAccept ? "denied_unidentifiable" : "judged",
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          provider: candidate.provider,
          runtimeMode: candidate.runtimeMode,
          command: candidate.command,
          decision,
          reason,
          dryRun: config.dryRun,
          responded,
        });
        continue;
      }

      if (candidate.snapshotGap || candidate.requestId == null) {
        decisions.push({
          action: "skipped_snapshot_gap",
          threadId: candidate.threadId,
          requestId: null,
          provider: candidate.provider,
          runtimeMode: candidate.runtimeMode,
          command: null,
          decision: null,
          reason: MISSING_SNAPSHOT_GAP,
          dryRun: config.dryRun,
          responded: false,
        });
        continue;
      }

      if (!candidate.identifiable || !candidate.command) {
        const claim = await claimOrSkip(dependencies, {
          requestId: candidate.requestId,
          threadId: candidate.threadId,
          decision: "decline",
          at: now,
          action: candidateAction(candidate),
        }, config.dryRun);
        if (!config.dryRun && claim.status === "duplicate") {
          decisions.push({
            action: "skipped_duplicate",
            threadId: candidate.threadId,
            requestId: candidate.requestId,
            provider: candidate.provider,
            runtimeMode: candidate.runtimeMode,
            command: null,
            decision: "decline",
            reason: "already responded to this requestId",
            dryRun: config.dryRun,
            responded: false,
          });
          continue;
        }
        const denyReason = candidate.gapReason ?? MISSING_COMMAND_GAP;
        const responded = await deliverClaim(dependencies, {
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          decision: "decline",
          reason: denyReason,
          leaseId: claim.leaseId,
          action: candidateAction(candidate),
        }, config.dryRun);
        if (claim.status !== "duplicate") state = await dependencies.loadState();
        decisions.push({
          action: config.dryRun ? "dry_run" : "denied_unidentifiable",
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          provider: candidate.provider,
          runtimeMode: candidate.runtimeMode,
          command: null,
          decision: "decline",
          reason: denyReason,
          dryRun: config.dryRun,
          responded,
        });
        continue;
      }

      requireIdentifiableApproval({
        requestId: candidate.requestId,
        requestKind: candidate.requestKind === "file-read" || candidate.requestKind === "file-change" ? candidate.requestKind : "command",
        createdAt: candidate.createdAt ?? now,
        command: candidate.command,
        toolName: candidate.toolName,
        cwd: candidate.cwd,
        identifiable: true,
      });

      const history = await dependencies.taskHistory(candidate.threadId, HISTORY_TURNS);
      const lastUserMessage = lastUserMessageText(history.messages ?? []);
      const executionCwd = candidate.cwd ?? candidate.worktreePath;
      const judged = await dependencies.judge({
        model: config.model,
        modelReasoningEffort: config.modelReasoningEffort,
        timeoutMs: config.judgeTimeoutMs,
        lastUserMessage,
        action: {
          requestKind: candidate.requestKind,
          command: candidate.command,
          cwd: executionCwd,
          toolName: candidate.toolName,
        },
        cwd: executionCwd,
      });
      const failClosed = judged.ok
        ? judged.assessment
        : { outcome: "deny" as const, rationale: judged.reason };
      const judgedDecision: ApprovalDecision = failClosed.outcome === "allow" ? "accept" : "decline";
      const claim = await claimOrSkip(dependencies, {
        requestId: candidate.requestId,
        threadId: candidate.threadId,
        decision: judgedDecision,
        at: now,
        action: candidateAction(candidate),
      }, config.dryRun);
      if (!config.dryRun && claim.status === "duplicate") {
        decisions.push({
          action: "skipped_duplicate",
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          provider: candidate.provider,
          runtimeMode: candidate.runtimeMode,
          command: candidate.command,
          decision: judgedDecision,
          reason: "already responded to this requestId",
          dryRun: config.dryRun,
          responded: false,
        });
        continue;
      }
      const currentAction = candidateAction(candidate);
      const storedAccept = claim.status === "retry" && claim.decision === "accept";
      const identityMismatch = Boolean(storedAccept && (!claim.action || !sameApprovalAction(claim.action, currentAction)));
      const decision: ApprovalDecision = "decline";
      const deliverAction = storedAccept && claim.action && !identityMismatch ? claim.action : currentAction;
      const reason = identityMismatch
        ? "stored accept identity does not match the current action"
        : judgedDecision === "accept"
          ? UNBOUND_ACCEPT_GAP
          : failClosed.rationale;
      const responded = await deliverClaim(dependencies, {
        threadId: candidate.threadId,
        requestId: candidate.requestId,
        decision,
        reason,
        leaseId: claim.leaseId,
        action: deliverAction,
      }, config.dryRun);
      if (claim.status !== "duplicate") state = await dependencies.loadState();
      decisions.push({
        action: config.dryRun ? "dry_run" : "judged",
        threadId: candidate.threadId,
        requestId: candidate.requestId,
        provider: candidate.provider,
        runtimeMode: candidate.runtimeMode,
        command: candidate.command,
        decision,
        reason,
        dryRun: config.dryRun,
        responded,
      });
    }

    await dependencies.recordPoll(now, null);
    return {
      ok: true,
      enabled: true,
      dryRun: config.dryRun,
      model: config.model,
      modelReasoningEffort: config.modelReasoningEffort,
      scanned: candidates.length,
      decisions,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dependencies.recordPoll(now, message);
    return {
      ok: false,
      enabled: true,
      dryRun: config.dryRun,
      model: config.model,
      modelReasoningEffort: config.modelReasoningEffort,
      scanned: 0,
      decisions: [],
      error: message,
    };
  }
}

export async function loadGuardianState(path = defaultGuardianStatePath()): Promise<GuardianState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as GuardianState;
    if ((parsed.schema !== 1 && parsed.schema !== 2 && parsed.schema !== 3 && parsed.schema !== 4) || !parsed.responded || typeof parsed.responded !== "object") {
      return emptyGuardianState();
    }
    return {
      schema: STATE_SCHEMA,
      responded: normalizeClaims(parsed.responded),
      lastPollAt: typeof parsed.lastPollAt === "string" ? parsed.lastPollAt : null,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyGuardianState();
    throw error;
  }
}

async function writeGuardianStateAtomic(state: GuardianState, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function newOwnershipToken(): string {
  return `${Date.now().toString(16)}.${randomBytes(8).toString("hex")}`;
}

export function guardianDeliveryLockPath(statePath: string, threadId: string, requestId: string): string {
  const safe = `${encodeURIComponent(threadId)}.${encodeURIComponent(requestId)}`.replace(/[^A-Za-z0-9._%-]+/g, "_").slice(0, 180) || "request";
  return `${statePath}.delivery.${safe}.lock`;
}

export async function withGuardianStateLock<T>(
  path: string,
  body: () => Promise<T>,
): Promise<T> {
  return withExclusiveFileLock(`${path}.lock`, body);
}

export async function withGuardianDeliveryLock<T>(
  threadId: string,
  requestId: string,
  body: () => Promise<T>,
  path = defaultGuardianStatePath(),
): Promise<T> {
  return withExclusiveFileLock(guardianDeliveryLockPath(path, threadId, requestId), body);
}

export async function mergeGuardianState(
  path: string,
  patch: { lastPollAt?: string | null; lastError?: string | null },
): Promise<GuardianState> {
  return withGuardianStateLock(path, async () => {
    const current = await loadGuardianState(path);
    const next: GuardianState = {
      ...current,
      lastPollAt: patch.lastPollAt !== undefined ? patch.lastPollAt : current.lastPollAt,
      lastError: patch.lastError !== undefined ? patch.lastError : current.lastError,
    };
    await writeGuardianStateAtomic(next, path);
    return next;
  });
}

function leaseExpired(claim: GuardianClaim, nowMs: number): boolean {
  if (!claim.leaseUntil) return true;
  const until = Date.parse(claim.leaseUntil);
  return !Number.isFinite(until) || until <= nowMs;
}

function writeClaimState(
  state: GuardianState,
  key: string,
  claim: GuardianClaim,
): GuardianState {
  return {
    schema: STATE_SCHEMA,
    lastPollAt: state.lastPollAt,
    lastError: state.lastError,
    responded: { ...state.responded, [key]: claim },
  };
}

export async function claimGuardianRequest(
  input: { requestId: string; threadId: string; decision: ApprovalDecision; at: string; action?: ApprovalActionIdentity },
  path = defaultGuardianStatePath(),
  options: { now?: () => number; leaseMs?: number } = {},
): Promise<ClaimResult> {
  return withGuardianStateLock(path, async () => {
    const nowMs = options.now?.() ?? Date.now();
    const leaseMs = options.leaseMs ?? GUARDIAN_CLAIM_LEASE_MS;
    const state = await loadGuardianState(path);
    const key = guardianClaimKey(input.threadId, input.requestId);
    const existing = state.responded[key];
    if (existing?.status === "completed" && existing.decision !== "accept") {
      return { status: "duplicate", decision: existing.decision };
    }
    if (existing?.status === "completed" && existing.decision === "accept") {
      const leaseId = newOwnershipToken();
      const action = input.action ?? existing.action;
      await writeGuardianStateAtomic(writeClaimState(state, key, {
        threadId: input.threadId,
        decision: "decline",
        at: input.at,
        status: "pending",
        leaseId,
        leaseUntil: new Date(nowMs + leaseMs).toISOString(),
        attempt: (existing.attempt ?? 1) + 1,
        ...(action ? { action } : {}),
      }), path);
      return { status: "claimed", decision: "decline", leaseId, action };
    }
    if (existing?.status === "pending") {
      if (existing.threadId !== input.threadId) return { status: "duplicate", decision: existing.decision, leaseId: existing.leaseId };
      if (!leaseExpired(existing, nowMs)) return { status: "duplicate", decision: existing.decision, leaseId: existing.leaseId };
      const liveHolder = await tryExclusiveFileLock(guardianDeliveryLockPath(path, input.threadId, input.requestId), async () => undefined);
      if (!liveHolder.ok) return { status: "duplicate", decision: existing.decision, leaseId: existing.leaseId, action: existing.action };
      const storedAction = existing.action;
      const requestedAction = input.action;
      const identityMismatch = existing.decision === "accept" &&
        hasCompleteActionIdentity(storedAction) &&
        requestedAction !== undefined &&
        !sameApprovalAction(storedAction, requestedAction);
      const actionlessAccept = existing.decision === "accept" && !hasCompleteActionIdentity(existing.action);
      const currentDeny = input.decision === "decline" && existing.decision === "accept";
      const decision = actionlessAccept || identityMismatch || currentDeny ? "decline" : existing.decision;
      const action = actionlessAccept || identityMismatch ? input.action : existing.action;
      const leaseId = newOwnershipToken();
      await writeGuardianStateAtomic(writeClaimState(state, key, {
        ...existing,
        decision,
        ...(action ? { action } : {}),
        leaseId,
        leaseUntil: new Date(nowMs + leaseMs).toISOString(),
        attempt: (existing.attempt ?? 0) + 1,
      }), path);
      return { status: "retry", decision, leaseId, action };
    }
    const leaseId = newOwnershipToken();
    await writeGuardianStateAtomic(writeClaimState(state, key, {
      threadId: input.threadId,
      decision: input.decision,
      at: input.at,
      status: "pending",
      leaseId,
      leaseUntil: new Date(nowMs + leaseMs).toISOString(),
      attempt: 1,
      ...(input.action ? { action: input.action } : {}),
    }), path);
    return { status: "claimed", decision: input.decision, leaseId, action: input.action };
  });
}

export async function renewGuardianLease(
  requestId: string,
  leaseId: string,
  path = defaultGuardianStatePath(),
  options: { now?: () => number; leaseMs?: number; threadId: string },
): Promise<boolean> {
  return withGuardianStateLock(path, async () => {
    const nowMs = options.now?.() ?? Date.now();
    const leaseMs = options.leaseMs ?? GUARDIAN_CLAIM_LEASE_MS;
    const state = await loadGuardianState(path);
    const key = guardianClaimKey(options.threadId, requestId);
    const existing = state.responded[key];
    if (!existing || existing.status !== "pending" || existing.leaseId !== leaseId) return false;
    await writeGuardianStateAtomic(writeClaimState(state, key, {
      ...existing,
      leaseUntil: new Date(nowMs + leaseMs).toISOString(),
    }), path);
    return true;
  });
}

export async function completeGuardianRequest(
  requestId: string,
  leaseId: string,
  path = defaultGuardianStatePath(),
  threadId = "",
  decision?: ApprovalDecision,
): Promise<boolean> {
  return withGuardianStateLock(path, async () => {
    const state = await loadGuardianState(path);
    const existing = threadId
      ? state.responded[guardianClaimKey(threadId, requestId)]
      : undefined;
    if (!existing || existing.leaseId !== leaseId) return false;
    if (existing.status === "completed") return true;
    await writeGuardianStateAtomic(writeClaimState(state, guardianClaimKey(existing.threadId, requestId), {
      ...existing,
      status: "completed",
      ...(decision ? { decision } : {}),
      leaseUntil: undefined,
    }), path);
    return true;
  });
}

export async function releaseGuardianRequest(
  requestId: string,
  leaseId: string,
  path = defaultGuardianStatePath(),
  threadId = "",
): Promise<void> {
  await withGuardianStateLock(path, async () => {
    const state = await loadGuardianState(path);
    const existing = threadId
      ? state.responded[guardianClaimKey(threadId, requestId)]
      : undefined;
    if (!existing || existing.status !== "pending" || existing.leaseId !== leaseId) return;
    await writeGuardianStateAtomic(writeClaimState(state, guardianClaimKey(existing.threadId, requestId), {
      ...existing,
      leaseUntil: new Date(0).toISOString(),
    }), path);
  });
}

export async function reconcileGuardianRequests(
  liveRequestIds: Iterable<string>,
  path = defaultGuardianStatePath(),
): Promise<number> {
  return withGuardianStateLock(path, async () => {
    const state = await loadGuardianState(path);
    const live = new Set(liveRequestIds);
    const responded = { ...state.responded };
    let completed = 0;
    for (const [requestId, claim] of Object.entries(responded)) {
      if (claim.status !== "pending" || live.has(requestId)) continue;
      responded[requestId] = { ...claim, status: "completed", leaseId: undefined, leaseUntil: undefined };
      completed++;
    }
    if (completed === 0) return 0;
    await writeGuardianStateAtomic({
      schema: STATE_SCHEMA,
      lastPollAt: state.lastPollAt,
      lastError: state.lastError,
      responded,
    }, path);
    return completed;
  });
}

export function buildCodexJudgeCommand(input: {
  model: string;
  modelReasoningEffort: string;
  policyPath: string;
  schemaPath: string;
  lastMessagePath: string;
  prompt: string;
}): string[] {
  return [
    "codex",
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "--color",
    "never",
    "-m",
    input.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(input.modelReasoningEffort)}`,
    "-c",
    `model_instructions_file=${JSON.stringify(input.policyPath)}`,
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.lastMessagePath,
    input.prompt,
  ];
}

export async function runCodexJudge(input: JudgeInput): Promise<JudgeResult> {
  const which = await Bun.$`command -v codex`.nothrow().quiet();
  if (which.exitCode !== 0 || !which.text().trim()) {
    return { ok: false, reason: "codex exec is unavailable; denying fail-closed" };
  }
  const staging = await mkdtemp(join(tmpdir(), "t3-auto-guardian-"));
  try {
    const policyPath = join(staging, "policy.md");
    const schemaPath = join(staging, "schema.json");
    const lastMessagePath = join(staging, "last-message.txt");
    await writeFile(policyPath, officialGuardianPolicyPrompt());
    await writeFile(schemaPath, `${JSON.stringify(GUARDIAN_OUTPUT_SCHEMA, null, 2)}\n`);
    const prompt = buildGuardianUserPrompt({
      lastUserMessage: input.lastUserMessage,
      action: input.action,
    });
    const process = Bun.spawn(buildCodexJudgeCommand({
      model: input.model,
      modelReasoningEffort: input.modelReasoningEffort,
      policyPath,
      schemaPath,
      lastMessagePath,
      prompt,
    }), {
      cwd: input.cwd && input.cwd.trim() ? input.cwd : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => process.kill(), input.timeoutMs);
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    clearTimeout(timeout);
    let lastMessage = "";
    try {
      lastMessage = await readFile(lastMessagePath, "utf8");
    } catch {
      lastMessage = stdout;
    }
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `codex exec exited ${exitCode}`;
      return { ok: false, reason: `codex exec failed: ${detail.slice(0, 500)}`, raw: lastMessage };
    }
    const decoded = decodeGuardianAssessment(lastMessage);
    if (!decoded.ok) return { ok: false, reason: decoded.reason, raw: lastMessage };
    return { ok: true, assessment: decoded.assessment, raw: lastMessage };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function createDefaultGuardianDependencies(
  request: (payload: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>,
): GuardianDependencies {
  const call = async (payload: Record<string, unknown>): Promise<unknown> => {
    const response = await request(payload);
    if (!response.ok) throw new Error(response.error || "t3-orchestrationd request failed");
    return response.result;
  };
  return {
    listTaskApprovals: async (projectId) => call({
      op: "tasks.approvals",
      ...(projectId ? { projectId } : {}),
    }) as Promise<ApprovalList>,
    resolveTaskApproval: async (input) => call({
      op: input.decision === "accept" ? "tasks.approve" : "tasks.deny",
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.expected ? { expected: input.expected } : {}),
    }),
    taskHistory: async (threadId, turns) => call({
      op: "tasks.history",
      threadId,
      turns,
    }) as Promise<HistoryResult>,
    judge: runCodexJudge,
    now: () => new Date().toISOString(),
    loadState: () => loadGuardianState(),
    recordPoll: (at, error) => mergeGuardianState(defaultGuardianStatePath(), { lastPollAt: at, lastError: error }).then(() => undefined),
    claimRequest: (input) => claimGuardianRequest(input),
    withDeliveryLock: (threadId, requestId, body) => withGuardianDeliveryLock(threadId, requestId, body),
    renewRequest: (requestId, leaseId, threadId) => renewGuardianLease(requestId, leaseId, defaultGuardianStatePath(), { threadId }),
    completeRequest: (requestId, leaseId, threadId, decision) => completeGuardianRequest(requestId, leaseId, defaultGuardianStatePath(), threadId, decision),
    releaseRequest: (requestId, leaseId, threadId) => releaseGuardianRequest(requestId, leaseId, defaultGuardianStatePath(), threadId),
    reconcileRequests: (liveRequestIds) => reconcileGuardianRequests(liveRequestIds).then(() => undefined),
  };
}

export async function runGuardianLoop(
  dependencies: GuardianDependencies,
  config: GuardianConfig,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  while (shouldContinue()) {
    const report = await runGuardianCycle(dependencies, config);
    if (!report.ok) console.error(report.error ?? "guardian cycle failed");
    else console.log(JSON.stringify(report));
    if (!shouldContinue()) break;
    await sleep(config.pollIntervalMs);
  }
}
