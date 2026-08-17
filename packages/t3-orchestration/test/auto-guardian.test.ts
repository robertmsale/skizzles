import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { MISSING_COMMAND_GAP, MISSING_SNAPSHOT_GAP } from "../src/approval-projection.ts";
import { defaultGuardianConfig } from "../src/auto-guardian-config.ts";
import {
  candidatesFromApprovalList,
  claimGuardianRequest,
  completeGuardianRequest,
  emptyGuardianState,
  loadGuardianState,
  mergeGuardianState,
  isCodexProvider,
  isGuardianEligible,
  runGuardianCycle,
  type ApprovalList,
  type GuardianDependencies,
  type GuardianState,
  type JudgeResult,
} from "../src/auto-guardian.ts";

function approval(overrides: Partial<ApprovalList["approvals"][number]> = {}): ApprovalList["approvals"][number] {
  return {
    threadId: "cursor-task",
    title: "Cursor work",
    projectId: "project",
    projectTitle: "acme",
    workspaceRoot: "/repo",
    provider: "cursor",
    providerDriver: "cursor",
    runtimeMode: "auto",
    requestId: "req-1",
    requestKind: "command",
    toolName: "Shell",
    command: "git status",
    cwd: "/worktree",
    worktreePath: "/worktree",
    createdAt: "2026-08-17T01:00:00Z",
    ...overrides,
  };
}

function unidentifiable(overrides: Partial<ApprovalList["unidentifiable"][number]> = {}): ApprovalList["unidentifiable"][number] {
  return {
    threadId: "grok-task",
    title: "Grok work",
    projectId: "project",
    projectTitle: "acme",
    workspaceRoot: "/repo",
    provider: "grok",
    providerDriver: "grok",
    runtimeMode: "auto",
    requestId: "opaque",
    reason: MISSING_COMMAND_GAP,
    createdAt: "2026-08-17T01:00:00Z",
    worktreePath: "/worktree",
    ...overrides,
  };
}

function fixture(options: {
  list?: ApprovalList;
  history?: Array<{ role: string; text: string }>;
  judge?: JudgeResult;
  state?: GuardianState;
} = {}): { deps: GuardianDependencies; resolved: Array<Record<string, unknown>>; judged: number } {
  const resolved: Array<Record<string, unknown>> = [];
  let judged = 0;
  let state = options.state ?? emptyGuardianState();
  const deps: GuardianDependencies = {
    listTaskApprovals: async () => options.list ?? { approvals: [approval()], unidentifiable: [] },
    resolveTaskApproval: async (input) => {
      resolved.push(input);
      return { sequence: resolved.length, ...input };
    },
    taskHistory: async () => ({ messages: options.history ?? [{ role: "user", text: "Push your branch" }] }),
    judge: async () => {
      judged += 1;
      return options.judge ?? { ok: true, assessment: { outcome: "allow", rationale: "local git status" }, raw: "" };
    },
    now: () => "2026-08-17T02:00:00Z",
    loadState: async () => state,
    recordPoll: async (at, error) => {
      state = { ...state, lastPollAt: at, lastError: error };
    },
    claimRequest: async (input) => {
      const existing = state.responded[input.requestId];
      if (existing?.status === "completed") return { status: "duplicate", decision: existing.decision };
      if (existing?.status === "pending") {
        if (existing.ownerPid === process.pid) return { status: "duplicate", decision: existing.decision };
        return { status: "retry", decision: existing.decision };
      }
      state = {
        ...state,
        responded: {
          ...state.responded,
          [input.requestId]: { threadId: input.threadId, decision: input.decision, at: input.at, status: "pending", ownerPid: process.pid },
        },
      };
      return { status: "claimed", decision: input.decision };
    },
    completeRequest: async (requestId) => {
      const existing = state.responded[requestId];
      if (!existing) return;
      state = {
        ...state,
        responded: { ...state.responded, [requestId]: { ...existing, status: "completed" } },
      };
    },
  };
  return { deps, resolved, get judged() { return judged; } };
}

describe("guardian eligibility filter", () => {
  test("skips Codex providers and non-auto runtime modes", () => {
    expect(isCodexProvider("codex")).toBe(true);
    expect(isCodexProvider("codex-lb")).toBe(true);
    expect(isCodexProvider("codex_personal")).toBe(true);
    expect(isCodexProvider("personal")).toBe(true);
    expect(isCodexProvider("cursor")).toBe(false);
    expect(isCodexProvider("grok")).toBe(false);
    expect(isCodexProvider("opencode")).toBe(false);
    expect(isGuardianEligible({ provider: "codex", runtimeMode: "auto" })).toMatchObject({
      eligible: false,
      action: "skipped_codex",
    });
    expect(isGuardianEligible({ provider: "personal", runtimeMode: "auto" }).eligible).toBe(false);
    expect(isGuardianEligible({ provider: "personal", providerDriver: "codex", runtimeMode: "auto" }).eligible).toBe(false);
    expect(isGuardianEligible({ provider: "cursor", providerDriver: "cursor", runtimeMode: "auto" }).eligible).toBe(true);
    expect(isGuardianEligible({ provider: "cursor", runtimeMode: "ask" }).eligible).toBe(false);
    expect(isGuardianEligible({ provider: "grok", runtimeMode: "auto" }).eligible).toBe(true);
  });

  test("keeps unidentifiable snapshot gaps distinct from missing commands", () => {
    const candidates = candidatesFromApprovalList({
      approvals: [approval()],
      unidentifiable: [
        unidentifiable(),
        unidentifiable({ requestId: null, reason: MISSING_SNAPSHOT_GAP }),
      ],
    });
    expect(candidates.map((entry) => ({ requestId: entry.requestId, snapshotGap: entry.snapshotGap, identifiable: entry.identifiable }))).toEqual([
      { requestId: "req-1", snapshotGap: false, identifiable: true },
      { requestId: null, snapshotGap: true, identifiable: false },
      { requestId: "opaque", snapshotGap: false, identifiable: false },
    ]);
  });
});

describe("guardian cycle", () => {
  test("never touches Codex auto threads", async () => {
    const { deps, resolved } = fixture({
      list: { approvals: [approval({ threadId: "codex-task", provider: "codex" })], unidentifiable: [] },
    });
    const report = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(report.decisions).toEqual([expect.objectContaining({ action: "skipped_codex", threadId: "codex-task", responded: false })]);
    expect(resolved).toEqual([]);
  });

  test("never touches custom Codex instance IDs identified by a codex_ prefix", async () => {
    const { deps, resolved } = fixture({
      list: { approvals: [approval({ threadId: "personal-codex", provider: "codex_personal" })], unidentifiable: [] },
    });
    const report = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(report.decisions[0]).toMatchObject({ action: "skipped_codex", threadId: "personal-codex", responded: false });
    expect(resolved).toEqual([]);
  });

  test("never judges a custom instance whose T3 driver is Codex", async () => {
    const { deps, resolved } = fixture({
      list: { approvals: [approval({ threadId: "personal", provider: "personal", providerDriver: "codex" })], unidentifiable: [] },
    });
    const report = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(report.decisions[0]).toMatchObject({ action: "skipped_codex", threadId: "personal", responded: false });
    expect(resolved).toEqual([]);
  });

  test("retries an incomplete claim instead of orphaning it", async () => {
    const { deps, resolved } = fixture({
      state: {
        schema: 2,
        responded: { "req-1": { threadId: "cursor-task", decision: "accept", at: "2026-08-17T01:00:00Z", status: "pending" } },
        lastPollAt: null,
        lastError: null,
      },
    });
    const report = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(report.decisions[0]).toMatchObject({
      action: "judged",
      decision: "accept",
      reason: "retrying incomplete guardian claim",
      responded: true,
    });
    expect(resolved).toEqual([expect.objectContaining({ requestId: "req-1", decision: "accept" })]);
  });

  test("denies unidentifiable approvals fail-closed", async () => {
    const { deps, resolved } = fixture({
      list: { approvals: [], unidentifiable: [unidentifiable()] },
    });
    const report = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(report.decisions[0]).toMatchObject({
      action: "denied_unidentifiable",
      decision: "decline",
      reason: MISSING_COMMAND_GAP,
      responded: true,
    });
    expect(resolved).toEqual([{
      threadId: "grok-task",
      requestId: "opaque",
      decision: "decline",
      reason: MISSING_COMMAND_GAP,
    }]);
  });

  test("skips snapshot gaps instead of guessing a request id", async () => {
    const { deps, resolved } = fixture({
      list: { approvals: [], unidentifiable: [unidentifiable({ requestId: null, reason: MISSING_SNAPSHOT_GAP })] },
    });
    const report = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(report.decisions[0]).toMatchObject({ action: "skipped_snapshot_gap", requestId: null, responded: false });
    expect(resolved).toEqual([]);
  });

  test("dedups on requestId and never responds twice", async () => {
    const { deps, resolved } = fixture({
      state: {
        schema: 2,
        responded: { "req-1": { threadId: "cursor-task", decision: "accept", at: "2026-08-17T01:00:00Z", status: "completed" } },
        lastPollAt: null,
        lastError: null,
      },
    });
    const report = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(report.decisions[0]).toMatchObject({ action: "skipped_duplicate", requestId: "req-1", responded: false });
    expect(resolved).toEqual([]);
  });

  test("claims requestId before respond so concurrent cycles cannot double-reply", async () => {
    const first = fixture();
    const second = {
      ...first,
      deps: {
        ...first.deps,
        listTaskApprovals: first.deps.listTaskApprovals,
        resolveTaskApproval: first.deps.resolveTaskApproval,
        taskHistory: first.deps.taskHistory,
        judge: first.deps.judge,
        now: first.deps.now,
        loadState: first.deps.loadState,
        recordPoll: first.deps.recordPoll,
        claimRequest: first.deps.claimRequest,
        completeRequest: first.deps.completeRequest,
      },
    };
    const [left, right] = await Promise.all([
      runGuardianCycle(first.deps, defaultGuardianConfig()),
      runGuardianCycle(second.deps, defaultGuardianConfig()),
    ]);
    const responded = [...left.decisions, ...right.decisions].filter((entry) => entry.responded);
    expect(responded).toHaveLength(1);
    expect(first.resolved).toHaveLength(1);
    expect(first.resolved[0]).toMatchObject({ requestId: "req-1", decision: "accept" });
  });

  test("dry-run judges but does not call thread.approval.respond", async () => {
    const { deps, resolved } = fixture();
    const report = await runGuardianCycle(deps, { ...defaultGuardianConfig(), dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.decisions[0]).toMatchObject({
      action: "dry_run",
      decision: "accept",
      reason: "local git status",
      responded: false,
    });
    expect(resolved).toEqual([]);
  });

  test("malformed judge output fails closed as decline", async () => {
    const { deps, resolved } = fixture({
      judge: { ok: false, reason: "guardian assessment contained unknown keys: extra" },
    });
    const report = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(report.decisions[0]).toMatchObject({
      action: "judged",
      decision: "decline",
      reason: "guardian assessment contained unknown keys: extra",
      responded: true,
    });
    expect(resolved[0]).toMatchObject({ decision: "decline", requestId: "req-1" });
  });

  test("recordPoll merge cannot drop a winning claim for a later cycle", async () => {
    const root = await mkdtemp("/tmp/t3-guardian-merge-");
    try {
      const path = join(root, "state.json");
      const input = { requestId: "req-1", threadId: "cursor-task", decision: "accept" as const, at: "2026-08-17T02:00:00Z" };
      expect((await claimGuardianRequest(input, path)).status).toBe("claimed");
      await mergeGuardianState(path, { lastPollAt: "2026-08-17T03:00:00Z", lastError: null });
      expect((await claimGuardianRequest(input, path)).status).toBe("duplicate");
      await completeGuardianRequest(input.requestId, path);
      expect((await claimGuardianRequest(input, path)).status).toBe("duplicate");
      const persisted = await loadGuardianState(path);
      expect(persisted.responded["req-1"]?.decision).toBe("accept");
      expect(persisted.responded["req-1"]?.status).toBe("completed");
      expect(persisted.lastPollAt).toBe("2026-08-17T03:00:00Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("file-locked claim admits only one owner for a requestId", async () => {
    const root = await mkdtemp("/tmp/t3-guardian-claim-");
    try {
      const path = join(root, "state.json");
      const input = { requestId: "req-1", threadId: "cursor-task", decision: "accept" as const, at: "2026-08-17T02:00:00Z" };
      const results = await Promise.all([
        claimGuardianRequest(input, path),
        claimGuardianRequest(input, path),
        claimGuardianRequest(input, path),
      ]);
      expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
      expect(results.filter((result) => result.status === "duplicate")).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not approve when the last user message is absent and the judge denies", async () => {
    const { deps, resolved } = fixture({
      history: [{ role: "assistant", text: "working" }],
      judge: { ok: true, assessment: { outcome: "deny", rationale: "no user authorization for network write" }, raw: "" },
    });
    const report = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(report.decisions[0]).toMatchObject({ decision: "decline", responded: true });
    expect(resolved[0]).toMatchObject({ decision: "decline" });
  });
});
