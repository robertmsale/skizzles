import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MISSING_COMMAND_GAP, MISSING_SNAPSHOT_GAP } from "../src/approval-projection.ts";
import { defaultGuardianConfig } from "../src/auto-guardian-config.ts";
import {
  candidatesFromApprovalList,
  claimGuardianRequest,
  completeGuardianRequest,
  emptyGuardianState,
  loadGuardianState,
  mergeGuardianState,
  reconcileGuardianRequests,
  releaseGuardianRequest,
  renewGuardianLease,
  isCodexProvider,
  isGuardianEligible,
  runGuardianCycle,
  type ApprovalList,
  type ClaimResult,
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
      const leaseUntil = existing?.leaseUntil ? Date.parse(existing.leaseUntil) : 0;
      if (existing?.status === "pending" && Number.isFinite(leaseUntil) && leaseUntil > Date.now()) {
        return { status: "duplicate", decision: existing.decision, leaseId: existing.leaseId };
      }
      if (existing?.status === "pending") {
        const leaseId = `retry-${input.requestId}`;
        state = {
          ...state,
          responded: {
            ...state.responded,
            [input.requestId]: {
              ...existing,
              leaseId,
              leaseUntil: new Date(Date.now() + 30_000).toISOString(),
              attempt: (existing.attempt ?? 0) + 1,
            },
          },
        };
        return { status: "retry", decision: existing.decision, leaseId };
      }
      const leaseId = `claim-${input.requestId}`;
      state = {
        ...state,
        responded: {
          ...state.responded,
          [input.requestId]: {
            threadId: input.threadId,
            decision: input.decision,
            at: input.at,
            status: "pending",
            leaseId,
            leaseUntil: new Date(Date.now() + 30_000).toISOString(),
            attempt: 1,
          },
        },
      };
      return { status: "claimed", decision: input.decision, leaseId };
    },
    renewRequest: async (requestId, leaseId) => {
      const existing = state.responded[requestId];
      if (!existing || existing.status !== "pending" || existing.leaseId !== leaseId) return false;
      state = {
        ...state,
        responded: {
          ...state.responded,
          [requestId]: { ...existing, leaseUntil: new Date(Date.now() + 30_000).toISOString() },
        },
      };
      return true;
    },
    completeRequest: async (requestId, leaseId) => {
      const existing = state.responded[requestId];
      if (!existing || existing.leaseId !== leaseId) return false;
      if (existing.status === "completed") return true;
      state = {
        ...state,
        responded: { ...state.responded, [requestId]: { ...existing, status: "completed", leaseUntil: undefined } },
      };
      return true;
    },
    releaseRequest: async (requestId, leaseId) => {
      const existing = state.responded[requestId];
      if (!existing || existing.status !== "pending" || existing.leaseId !== leaseId) return;
      state = {
        ...state,
        responded: { ...state.responded, [requestId]: { ...existing, leaseUntil: new Date(0).toISOString() } },
      };
    },
    reconcileRequests: async (liveRequestIds) => {
      const live = new Set(liveRequestIds);
      const responded = { ...state.responded };
      for (const [requestId, claim] of Object.entries(responded)) {
        if (claim.status === "pending" && !live.has(requestId)) {
          responded[requestId] = { ...claim, status: "completed", leaseId: undefined, leaseUntil: undefined };
        }
      }
      state = { ...state, responded };
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
    expect(isGuardianEligible({ provider: "grok", providerDriver: "grok", runtimeMode: "auto" }).eligible).toBe(true);
    expect(isGuardianEligible({ provider: "cursor", providerDriver: null, runtimeMode: "auto" })).toMatchObject({
      eligible: false,
      action: "skipped_codex",
    });
    expect(isGuardianEligible({ provider: "cursor", providerDriver: "codex", runtimeMode: "auto" })).toMatchObject({
      eligible: false,
      action: "skipped_codex",
    });
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

  test("skips allowlisted instance IDs when the driver is missing or Codex", async () => {
    const missing = fixture({
      list: { approvals: [approval({ providerDriver: null })], unidentifiable: [] },
    });
    expect((await runGuardianCycle(missing.deps, defaultGuardianConfig())).decisions[0]).toMatchObject({
      action: "skipped_codex",
      responded: false,
    });
    expect(missing.resolved).toEqual([]);
    const mismatched = fixture({
      list: { approvals: [approval({ provider: "cursor", providerDriver: "codex" })], unidentifiable: [] },
    });
    expect((await runGuardianCycle(mismatched.deps, defaultGuardianConfig())).decisions[0]).toMatchObject({
      action: "skipped_codex",
      responded: false,
    });
    expect(mismatched.resolved).toEqual([]);
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
        schema: 3,
        responded: { "req-1": { threadId: "cursor-task", decision: "accept", at: "2026-08-17T01:00:00Z", status: "pending", leaseUntil: new Date(0).toISOString() } },
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
        schema: 3,
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
        renewRequest: first.deps.renewRequest,
        completeRequest: first.deps.completeRequest,
        releaseRequest: first.deps.releaseRequest,
        reconcileRequests: first.deps.reconcileRequests,
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
      const claimed = await loadGuardianState(path);
      await completeGuardianRequest(input.requestId, claimed.responded["req-1"]!.leaseId!, path);
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

  test("releases a live-process lease after dispatch failure so the next cycle retries", async () => {
    const { deps, resolved } = fixture();
    let attempts = 0;
    deps.resolveTaskApproval = async (input) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient T3 dispatch failure");
      resolved.push(input);
      return { sequence: attempts, ...input };
    };
    const first = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(first.ok).toBe(true);
    expect(first.decisions[0]?.responded).toBe(false);
    expect(resolved).toEqual([]);
    const second = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(second.decisions[0]).toMatchObject({ action: "judged", responded: true, decision: "accept" });
    expect(resolved).toHaveLength(1);
  });

  test("reconciles a pending claim whose request left the snapshot after T3 accepted", async () => {
    const { deps, resolved } = fixture({
      list: { approvals: [], unidentifiable: [] },
      state: {
        schema: 3,
        responded: {
          "req-gone": {
            threadId: "cursor-task",
            decision: "accept",
            at: "2026-08-17T01:00:00Z",
            status: "pending",
            leaseId: "lease-1",
            leaseUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        },
        lastPollAt: null,
        lastError: null,
      },
    });
    const report = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(report.ok).toBe(true);
    expect(resolved).toEqual([]);
    expect((await deps.loadState()).responded["req-gone"]?.status).toBe("completed");
  });

  test("does not reconcile a live pending requestId across a snapshot gap", async () => {
    const { deps, resolved } = fixture({
      list: { approvals: [], unidentifiable: [unidentifiable({ requestId: null, reason: MISSING_SNAPSHOT_GAP })] },
      state: {
        schema: 3,
        responded: {
          "req-live": {
            threadId: "cursor-task",
            decision: "accept",
            at: "2026-08-17T01:00:00Z",
            status: "pending",
            leaseId: "lease-live",
            leaseUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        },
        lastPollAt: null,
        lastError: null,
      },
    });
    const report = await runGuardianCycle(deps, defaultGuardianConfig());
    expect(report.ok).toBe(true);
    expect(report.decisions[0]).toMatchObject({ action: "skipped_snapshot_gap", requestId: null });
    expect(resolved).toEqual([]);
    expect((await deps.loadState()).responded["req-live"]?.status).toBe("pending");
  });
});

describe("guardian lock and multi-process claims", () => {
  test("a live lock owner cannot overlap another process", async () => {
    const root = await mkdtemp("/tmp/t3-guardian-live-lock-");
    try {
      const path = join(root, "state.json");
      const eventsPath = join(root, "events.jsonl");
      const modulePath = resolve(import.meta.dir, "../src/auto-guardian.ts");
      const script = `
        import { appendFile } from "node:fs/promises";
        import { withGuardianStateLock } from ${JSON.stringify(modulePath)};
        const path = ${JSON.stringify(path)};
        const events = ${JSON.stringify(eventsPath)};
        const role = process.argv[1];
        const log = (phase) => appendFile(events, JSON.stringify({ role, phase, at: Date.now() }) + "\\n");
        if (role === "B") await Bun.sleep(35);
        await withGuardianStateLock(path, async () => {
          await log("enter");
          if (role === "A") await Bun.sleep(120);
          await log("leave");
        });
      `;
      const spawn = (role: string) => Bun.spawn(["bun", "-e", script, role], { stdout: "pipe", stderr: "pipe" });
      const first = spawn("A");
      const second = spawn("B");
      const [firstExit, secondExit, firstErr, secondErr] = await Promise.all([
        first.exited,
        second.exited,
        new Response(first.stderr).text(),
        new Response(second.stderr).text(),
      ]);
      expect(firstExit).toBe(0);
      expect(secondExit).toBe(0);
      expect(firstErr).toBe("");
      expect(secondErr).toBe("");
      const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { role: string; phase: string; at: number });
      const firstEnter = events.find((event) => event.role === "A" && event.phase === "enter")?.at;
      const firstLeave = events.find((event) => event.role === "A" && event.phase === "leave")?.at;
      const secondEnter = events.find((event) => event.role === "B" && event.phase === "enter")?.at;
      const secondLeave = events.find((event) => event.role === "B" && event.phase === "leave")?.at;
      expect(firstEnter).toBeGreaterThan(0);
      expect(firstLeave).toBeGreaterThan(0);
      expect(secondEnter).toBeGreaterThan(0);
      expect(secondLeave).toBeGreaterThan(0);
      const overlap = firstEnter! < secondLeave! && secondEnter! < firstLeave!;
      expect({ overlap, firstEnter, firstLeave, secondEnter, secondLeave }).toMatchObject({ overlap: false });
      expect(secondEnter).toBeGreaterThanOrEqual(firstLeave!);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers an abandoned lock file and then exclusive-creates", async () => {
    const root = await mkdtemp("/tmp/t3-guardian-empty-lock-");
    try {
      const path = join(root, "state.json");
      await writeFile(`${path}.lock`, "", { flag: "wx", mode: 0o600 });
      const result = await claimGuardianRequest({
        requestId: "req-1",
        threadId: "cursor-task",
        decision: "accept",
        at: "2026-08-17T02:00:00Z",
      }, path);
      expect(result.status).toBe("claimed");
      expect((await loadGuardianState(path)).responded["req-1"]?.status).toBe("pending");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("file lock serializes many unique claims without lost writes", async () => {
    const root = await mkdtemp("/tmp/t3-guardian-unique-");
    try {
      const path = join(root, "state.json");
      const count = 40;
      const results = await Promise.all(Array.from({ length: count }, (_, index) => claimGuardianRequest({
        requestId: `req-${index}`,
        threadId: "cursor-task",
        decision: "accept",
        at: "2026-08-17T02:00:00Z",
      }, path)));
      expect(results.every((result) => result.status === "claimed")).toBe(true);
      expect(Object.keys((await loadGuardianState(path)).responded)).toHaveLength(count);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("multi-process unique and same request IDs stay exclusive", async () => {
    const root = await mkdtemp("/tmp/t3-guardian-mp-");
    try {
      const path = join(root, "state.json");
      const modulePath = resolve(import.meta.dir, "../src/auto-guardian.ts");
      const run = async (requestId: string) => {
        const child = Bun.spawn([
          "bun",
          "-e",
          `import { claimGuardianRequest } from ${JSON.stringify(modulePath)}; const result = await claimGuardianRequest({ requestId: process.argv[1], threadId: "t", decision: "accept", at: "2026-08-17T02:00:00Z" }, ${JSON.stringify(path)}); console.log(JSON.stringify(result));`,
          requestId,
        ], { stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        return JSON.parse(stdout) as ClaimResult;
      };
      const unique = await Promise.all(Array.from({ length: 12 }, (_, index) => run(`unique-${index}`)));
      expect(unique.every((result) => result.status === "claimed")).toBe(true);
      expect(Object.keys((await loadGuardianState(path)).responded).filter((id) => id.startsWith("unique-"))).toHaveLength(12);
      const same = await Promise.all(Array.from({ length: 12 }, () => run("same-req")));
      expect(same.filter((result) => result.status === "claimed")).toHaveLength(1);
      expect(same.filter((result) => result.status === "duplicate")).toHaveLength(11);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expired lease takeover is written back so only one recoverer retries", async () => {
    const root = await mkdtemp("/tmp/t3-guardian-takeover-");
    try {
      const path = join(root, "state.json");
      const first = await claimGuardianRequest({
        requestId: "req-1",
        threadId: "cursor-task",
        decision: "accept",
        at: "2026-08-17T02:00:00Z",
      }, path, { now: () => 1_000, leaseMs: 10 });
      expect(first.status).toBe("claimed");
      const recoveries = await Promise.all([
        claimGuardianRequest({
          requestId: "req-1",
          threadId: "cursor-task",
          decision: "decline",
          at: "2026-08-17T02:00:01Z",
        }, path, { now: () => 2_000, leaseMs: 10_000 }),
        claimGuardianRequest({
          requestId: "req-1",
          threadId: "cursor-task",
          decision: "decline",
          at: "2026-08-17T02:00:01Z",
        }, path, { now: () => 2_000, leaseMs: 10_000 }),
      ]);
      expect(recoveries.filter((result) => result.status === "retry")).toHaveLength(1);
      expect(recoveries.filter((result) => result.status === "duplicate")).toHaveLength(1);
      expect((await loadGuardianState(path)).responded["req-1"]?.decision).toBe("accept");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("release then claim retries after a failed dispatch", async () => {
    const root = await mkdtemp("/tmp/t3-guardian-release-");
    try {
      const path = join(root, "state.json");
      const claimed = await claimGuardianRequest({
        requestId: "req-1",
        threadId: "cursor-task",
        decision: "accept",
        at: "2026-08-17T02:00:00Z",
      }, path);
      expect(claimed.leaseId).toBeTruthy();
      await releaseGuardianRequest("req-1", claimed.leaseId!, path);
      const retry = await claimGuardianRequest({
        requestId: "req-1",
        threadId: "cursor-task",
        decision: "accept",
        at: "2026-08-17T02:00:01Z",
      }, path);
      expect(retry.status).toBe("retry");
      await reconcileGuardianRequests([], path);
      expect((await loadGuardianState(path)).responded["req-1"]?.status).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expired owner cannot renew, deliver, or complete after a retry takeover", async () => {
    const root = await mkdtemp("/tmp/t3-guardian-lease-fence-");
    try {
      const path = join(root, "state.json");
      const first = await claimGuardianRequest({
        requestId: "req-1",
        threadId: "cursor-task",
        decision: "accept",
        at: "2026-08-17T02:00:00Z",
      }, path, { now: () => 1_000, leaseMs: 10 });
      expect(first.leaseId).toBeTruthy();
      const second = await claimGuardianRequest({
        requestId: "req-1",
        threadId: "cursor-task",
        decision: "decline",
        at: "2026-08-17T02:00:01Z",
      }, path, { now: () => 2_000, leaseMs: 10_000 });
      expect(second.status).toBe("retry");
      expect(second.leaseId).toBeTruthy();
      expect(second.leaseId).not.toBe(first.leaseId);
      expect(await renewGuardianLease("req-1", first.leaseId!, path)).toBe(false);
      expect(await completeGuardianRequest("req-1", first.leaseId!, path)).toBe(false);
      expect((await loadGuardianState(path)).responded["req-1"]).toMatchObject({
        status: "pending",
        leaseId: second.leaseId,
        decision: "accept",
      });
      const resolved: Array<Record<string, unknown>> = [];
      const report = await runGuardianCycle({
        listTaskApprovals: async () => ({ approvals: [approval()], unidentifiable: [] }),
        resolveTaskApproval: async (input) => {
          resolved.push(input);
          return input;
        },
        taskHistory: async () => ({ messages: [] }),
        judge: async () => ({ ok: true, assessment: { outcome: "allow", rationale: "unused" }, raw: "" }),
        now: () => "2026-08-17T02:00:02Z",
        loadState: () => loadGuardianState(path),
        recordPoll: async () => undefined,
        claimRequest: async () => ({ status: "retry", decision: "accept", leaseId: first.leaseId }),
        renewRequest: (requestId, leaseId) => renewGuardianLease(requestId, leaseId, path),
        completeRequest: (requestId, leaseId) => completeGuardianRequest(requestId, leaseId, path),
        releaseRequest: (requestId, leaseId) => releaseGuardianRequest(requestId, leaseId, path),
        reconcileRequests: async () => undefined,
      }, defaultGuardianConfig());
      expect(report.decisions[0]?.responded).toBe(false);
      expect(resolved).toEqual([]);
      expect(await renewGuardianLease("req-1", second.leaseId!, path)).toBe(true);
      expect(await completeGuardianRequest("req-1", second.leaseId!, path)).toBe(true);
      expect((await loadGuardianState(path)).responded["req-1"]?.status).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
