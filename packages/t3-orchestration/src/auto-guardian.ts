import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  MISSING_COMMAND_GAP,
  MISSING_SNAPSHOT_GAP,
  requireIdentifiableApproval,
  type ApprovalDecision,
  type ProjectedApproval,
  type UnidentifiableApproval,
} from "./approval-projection.ts";
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
const STATE_SCHEMA = 2;
const HISTORY_TURNS = 10;
const LOCK_RETRY_MS = 10;
const LOCK_ATTEMPTS = 500;

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
  scanned: number;
  decisions: GuardianDecisionRecord[];
  error?: string;
};

export type GuardianClaim = {
  threadId: string;
  decision: ApprovalDecision;
  at: string;
  status: "pending" | "completed";
  ownerPid?: number;
};

export type GuardianState = {
  schema: 1 | 2;
  responded: Record<string, GuardianClaim>;
  lastPollAt: string | null;
  lastError: string | null;
};

export type ClaimResult = {
  status: "claimed" | "duplicate" | "retry";
  decision?: ApprovalDecision;
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
  }): Promise<unknown>;
  taskHistory(threadId: string, turns: number): Promise<HistoryResult>;
  judge(input: JudgeInput): Promise<JudgeResult>;
  now(): string;
  loadState(): Promise<GuardianState>;
  recordPoll(at: string, error: string | null): Promise<void>;
  claimRequest(input: { requestId: string; threadId: string; decision: ApprovalDecision; at: string }): Promise<ClaimResult>;
  completeRequest(requestId: string): Promise<void>;
};

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
  for (const [requestId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const claim = entry as { threadId?: unknown; decision?: unknown; at?: unknown; status?: unknown; ownerPid?: unknown };
    if (typeof claim.threadId !== "string" || (claim.decision !== "accept" && claim.decision !== "decline")) continue;
    if (typeof claim.at !== "string") continue;
    claims[requestId] = {
      threadId: claim.threadId,
      decision: claim.decision,
      at: claim.at,
      status: claim.status === "pending" ? "pending" : "completed",
      ...(typeof claim.ownerPid === "number" ? { ownerPid: claim.ownerPid } : {}),
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

export function isGuardianEligible(target: { provider: string; providerDriver?: string | null; runtimeMode: string }): { eligible: boolean; action?: GuardianAction; reason?: string } {
  if (isCodexDriver(target.providerDriver) || isCodexProvider(target.provider)) {
    return { eligible: false, action: "skipped_codex", reason: "provider is Codex or not a known non-Codex Auto harness" };
  }
  if (!isAutoRuntime(target.runtimeMode)) {
    return { eligible: false, action: "skipped_runtime", reason: `runtimeMode ${target.runtimeMode} is not auto` };
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
  }));
  return [...identifiable, ...unidentifiable].sort((left, right) =>
    (left.createdAt ?? "").localeCompare(right.createdAt ?? "") ||
    left.threadId.localeCompare(right.threadId) ||
    (left.requestId ?? "").localeCompare(right.requestId ?? ""),
  );
}

async function claimOrSkip(
  dependencies: GuardianDependencies,
  input: { requestId: string; threadId: string; decision: ApprovalDecision; at: string },
  dryRun: boolean,
): Promise<ClaimResult> {
  if (dryRun) return { status: "claimed" };
  return dependencies.claimRequest(input);
}

async function respond(
  dependencies: GuardianDependencies,
  input: { threadId: string; requestId: string; decision: ApprovalDecision; reason: string },
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;
  await dependencies.resolveTaskApproval({
    threadId: input.threadId,
    requestId: input.requestId,
    decision: input.decision,
    reason: input.reason,
  });
  return true;
}

export async function runGuardianCycle(
  dependencies: GuardianDependencies,
  config: GuardianConfig,
): Promise<GuardianCycleReport> {
  const now = dependencies.now();
  let state = await dependencies.loadState();
  if (!config.enabled) {
    await dependencies.recordPoll(now, null);
    return { ok: true, enabled: false, dryRun: config.dryRun, model: config.model, scanned: 0, decisions: [] };
  }

  try {
    const list = await dependencies.listTaskApprovals();
    const candidates = candidatesFromApprovalList(list);
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

      const existing = candidate.requestId ? state.responded[candidate.requestId] : undefined;
      if (existing?.status === "completed") {
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
        const claim = await claimOrSkip(dependencies, {
          requestId: candidate.requestId,
          threadId: candidate.threadId,
          decision: existing.decision,
          at: now,
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
        const responded = await respond(dependencies, {
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          decision: existing.decision,
          reason: "retrying incomplete guardian claim",
        }, config.dryRun);
        if (!config.dryRun && responded) await dependencies.completeRequest(candidate.requestId);
        state = await dependencies.loadState();
        decisions.push({
          action: config.dryRun ? "dry_run" : "judged",
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          provider: candidate.provider,
          runtimeMode: candidate.runtimeMode,
          command: candidate.command,
          decision: existing.decision,
          reason: "retrying incomplete guardian claim",
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
        const responded = await respond(dependencies, {
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          decision: "decline",
          reason: MISSING_COMMAND_GAP,
        }, config.dryRun);
        if (!config.dryRun && responded) await dependencies.completeRequest(candidate.requestId);
        if (claim.status !== "duplicate") state = await dependencies.loadState();
        decisions.push({
          action: config.dryRun ? "dry_run" : "denied_unidentifiable",
          threadId: candidate.threadId,
          requestId: candidate.requestId,
          provider: candidate.provider,
          runtimeMode: candidate.runtimeMode,
          command: null,
          decision: "decline",
          reason: MISSING_COMMAND_GAP,
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
      const judged = await dependencies.judge({
        model: config.model,
        timeoutMs: config.judgeTimeoutMs,
        lastUserMessage,
        action: {
          requestKind: candidate.requestKind,
          command: candidate.command,
          cwd: candidate.cwd,
          toolName: candidate.toolName,
        },
        cwd: candidate.cwd ?? candidate.worktreePath,
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
      const decision = claim.status === "retry" && claim.decision ? claim.decision : judgedDecision;
      const responded = await respond(dependencies, {
        threadId: candidate.threadId,
        requestId: candidate.requestId,
        decision,
        reason: failClosed.rationale,
      }, config.dryRun);
      if (!config.dryRun && responded) await dependencies.completeRequest(candidate.requestId);
      if (claim.status !== "duplicate") state = await dependencies.loadState();
      decisions.push({
        action: config.dryRun ? "dry_run" : "judged",
        threadId: candidate.threadId,
        requestId: candidate.requestId,
        provider: candidate.provider,
        runtimeMode: candidate.runtimeMode,
        command: candidate.command,
        decision,
        reason: failClosed.rationale,
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
      scanned: 0,
      decisions: [],
      error: message,
    };
  }
}

export async function loadGuardianState(path = defaultGuardianStatePath()): Promise<GuardianState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as GuardianState;
    if ((parsed.schema !== 1 && parsed.schema !== 2) || !parsed.responded || typeof parsed.responded !== "object") {
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

function lockOwnerAlive(pidText: string): boolean {
  const pid = Number(pidText.trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function withGuardianStateLock<T>(path: string, body: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.write(Buffer.from(`${process.pid}\n`));
        return await body();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        try {
          const owner = await readFile(lockPath, "utf8");
          if (!lockOwnerAlive(owner)) await rm(lockPath, { force: true });
        } catch {
          /* lock raced away */
        }
        await Bun.sleep(LOCK_RETRY_MS);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Timed out waiting for T3 auto guardian state lock ${lockPath}`);
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

export async function claimGuardianRequest(
  input: { requestId: string; threadId: string; decision: ApprovalDecision; at: string },
  path = defaultGuardianStatePath(),
): Promise<ClaimResult> {
  return withGuardianStateLock(path, async () => {
    const state = await loadGuardianState(path);
    const existing = state.responded[input.requestId];
    if (existing?.status === "completed") return { status: "duplicate", decision: existing.decision };
    if (existing?.status === "pending") {
      if (existing.ownerPid && lockOwnerAlive(String(existing.ownerPid))) {
        return { status: "duplicate", decision: existing.decision };
      }
      return { status: "retry", decision: existing.decision };
    }
    await writeGuardianStateAtomic({
      schema: STATE_SCHEMA,
      lastPollAt: state.lastPollAt,
      lastError: state.lastError,
      responded: {
        ...state.responded,
        [input.requestId]: {
          threadId: input.threadId,
          decision: input.decision,
          at: input.at,
          status: "pending",
          ownerPid: process.pid,
        },
      },
    }, path);
    return { status: "claimed", decision: input.decision };
  });
}

export async function completeGuardianRequest(requestId: string, path = defaultGuardianStatePath()): Promise<void> {
  await withGuardianStateLock(path, async () => {
    const state = await loadGuardianState(path);
    const existing = state.responded[requestId];
    if (!existing) return;
    await writeGuardianStateAtomic({
      schema: STATE_SCHEMA,
      lastPollAt: state.lastPollAt,
      lastError: state.lastError,
      responded: {
        ...state.responded,
        [requestId]: { ...existing, status: "completed" },
      },
    }, path);
  });
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
    const process = Bun.spawn([
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
      `model_instructions_file=${JSON.stringify(policyPath)}`,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      lastMessagePath,
      prompt,
    ], {
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
    completeRequest: (requestId) => completeGuardianRequest(requestId),
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
