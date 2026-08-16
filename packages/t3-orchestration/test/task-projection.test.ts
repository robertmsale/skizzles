import { describe, expect, test } from "bun:test";
import { mergeArchivedTasks, projectProjects, projectTaskList, taskCursor, taskPhase, waitForTasks } from "../src/task-projection.ts";
import type { ShellSnapshot, Snapshot, T3ThreadShell } from "../src/protocol.ts";

const project = { id: "project", title: "Project", workspaceRoot: "/repo", deletedAt: null };
const thread = (overrides: Partial<T3ThreadShell> = {}): T3ThreadShell => ({
  id: "task",
  projectId: "project",
  title: "Task",
  modelSelection: { instanceId: "codex", model: "model", options: [{ id: "reasoningEffort", value: "high" }] },
  runtimeMode: "auto",
  interactionMode: "default",
  worktreePath: "/worktree",
  branch: "t3code/task",
  latestTurn: null,
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  deletedAt: null,
  session: { status: "running", updatedAt: "2026-08-12T00:00:00Z" },
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  backgroundLiveness: null,
  ...overrides,
});
const shell = (threads: T3ThreadShell[]): ShellSnapshot => ({ snapshotSequence: 10, projects: [project], threads, updatedAt: "now" });

describe("task list projection", () => {
  test("projects list excludes deleted projects and never embeds task state", () => {
    expect(projectProjects({
      snapshotSequence: 1,
      projects: [project, { id: "deleted", title: "Deleted", workspaceRoot: "/deleted", deletedAt: "now" }],
      threads: [thread()],
    })).toEqual({ projects: [{ id: "project", title: "Project", workspaceRoot: "/repo" }], count: 1 });
  });

  test("always includes pinned tasks in pin order and limits only recent tasks", () => {
    const snapshot: Snapshot = {
      snapshotSequence: 10,
      projects: [project],
      threads: [
        thread({ id: "recent-1", updatedAt: "2026-08-12T04:00:00Z" }),
        thread({ id: "pin-b", pinnedAt: "now", pinOrderKey: "b" }),
        thread({ id: "recent-2", updatedAt: "2026-08-12T03:00:00Z" }),
        thread({ id: "pin-a", pinnedAt: "now", pinOrderKey: "a" }),
      ],
    };
    const result = projectTaskList(snapshot, { limit: 1, includeArchived: false, includeSettled: false });
    expect(result.tasks.map(({ id, pinnedIndex }) => ({ id, pinnedIndex }))).toEqual([
      { id: "pin-a", pinnedIndex: 1 },
      { id: "pin-b", pinnedIndex: 2 },
      { id: "recent-1", pinnedIndex: null },
    ]);
    expect(result.moreRecent).toBe(1);
  });

  test("filters deleted, archived, settled, and other-project tasks by default", () => {
    const snapshot: Snapshot = {
      snapshotSequence: 10,
      projects: [project],
      threads: [
        thread({ id: "active" }),
        thread({ id: "deleted", deletedAt: "now" }),
        thread({ id: "archived", archivedAt: "now" }),
        thread({ id: "settled", settledOverride: "settled" }),
        thread({ id: "other", projectId: "other" }),
      ],
    };
    expect(projectTaskList(snapshot, { limit: 50, projectId: "project", includeArchived: false, includeSettled: false }).tasks.map((entry) => entry.id)).toEqual(["active"]);
  });

  test("merges archived rows without replacing shell-only live status", () => {
    const working = thread({ id: "working", backgroundLiveness: "working", session: { status: "ready" } });
    const degraded = thread({ id: "working", backgroundLiveness: undefined, session: { status: "ready" } });
    const archived = thread({ id: "archived", archivedAt: "now", session: { status: "stopped" } });
    const merged = mergeArchivedTasks(shell([working]), {
      snapshotSequence: 11,
      projects: [project],
      threads: [degraded, archived, thread({ id: "deleted", deletedAt: "now" })],
    });
    const result = projectTaskList(merged, { limit: 50, includeArchived: true, includeSettled: true });
    expect(result.tasks.map(({ id, phase, backgroundLiveness }) => ({ id, phase, backgroundLiveness }))).toEqual([
      { id: "working", phase: "running", backgroundLiveness: "working" },
      { id: "archived", phase: "archived", backgroundLiveness: null },
    ]);
  });

  test("rejects unbounded list requests from raw daemon clients", () => {
    expect(() => projectTaskList({ snapshotSequence: 1, projects: [project], threads: [] }, { limit: 201, includeArchived: false, includeSettled: false })).toThrow("1 through 200");
  });
});

describe("task wait projection", () => {
  test("uses T3 attention and completion precedence", () => {
    expect(taskPhase(thread({ hasPendingApprovals: true, session: { status: "running" } }))).toBe("waiting_for_approval");
    expect(taskPhase(thread({ hasPendingUserInput: true, session: { status: "error" } }))).toBe("waiting_for_input");
    expect(taskPhase(thread({ session: { status: "error" } }))).toBe("failed");
    expect(taskPhase(thread({ session: { status: "ready" } }))).toBe("completed");
    expect(taskPhase(thread({ interactionMode: "plan", hasActionableProposedPlan: true, session: { status: "ready" } }))).toBe("plan_ready");
    expect(taskPhase(thread({ backgroundLiveness: "working", session: { status: "ready" } }))).toBe("running");
    expect(taskPhase(thread({ backgroundLiveness: "monitoring", session: { status: "ready" } }))).toBe("monitoring");
  });

  test("returns an immediate compact snapshot at timeout zero", async () => {
    let loads = 0;
    const running = thread();
    const result = await waitForTasks({ threadIds: ["task"], timeoutMs: 0, after: {} }, async () => { loads++; return shell([running]); });
    expect(result).toMatchObject({ timedOut: true, ready: [], tasks: [{ id: "task", phase: "running" }] });
    expect(loads).toBe(1);
  });

  test("wakes on the first changed terminal among multiple tasks", async () => {
    const running = thread();
    const complete = thread({ id: "second", session: { status: "ready", updatedAt: "later" }, updatedAt: "later" });
    const result = await waitForTasks(
      { threadIds: ["task", "second"], timeoutMs: 100, after: { second: taskCursor(complete) } },
      async () => shell([running, { ...complete, updatedAt: "latest" }]),
    );
    expect(result).toMatchObject({ timedOut: false, ready: ["second"] });
  });

  test("suppresses an already-delivered terminal cursor", async () => {
    const complete = thread({ session: { status: "ready" } });
    const result = await waitForTasks({ threadIds: ["task"], timeoutMs: 0, after: { task: taskCursor(complete) } }, async () => shell([complete]));
    expect(result).toMatchObject({ timedOut: true, ready: [] });
  });

  test("waits for background work to finish before delivering completion", async () => {
    const working = thread({ backgroundLiveness: "working", session: { status: "ready" } });
    const complete = { ...working, backgroundLiveness: null, updatedAt: "later" };
    let calls = 0;
    const result = await waitForTasks(
      { threadIds: ["task"], timeoutMs: 10, after: {} },
      async () => shell([calls++ === 0 ? working : complete]),
      async () => undefined,
      () => calls,
    );
    expect(result).toMatchObject({ timedOut: false, ready: ["task"], tasks: [{ phase: "completed" }] });
  });

  test("resolves a task archived while waiting as a terminal state", async () => {
    const archived = thread({ archivedAt: "now", session: { status: "stopped" } });
    const result = await waitForTasks(
      { threadIds: ["task"], timeoutMs: 0, after: {} },
      async () => shell([]),
      Bun.sleep,
      Date.now,
      async () => [archived],
    );
    expect(result).toMatchObject({ timedOut: false, ready: ["task"], tasks: [{ phase: "archived", archived: true }] });
  });

  test("rejects unbounded waits and cursors for non-target tasks", async () => {
    await expect(waitForTasks({ threadIds: Array.from({ length: 9 }, (_, index) => String(index)), timeoutMs: 0, after: {} }, async () => shell([]))).rejects.toThrow("1 through 8");
    await expect(waitForTasks({ threadIds: ["task"], timeoutMs: 0, after: { other: "cursor" } }, async () => shell([thread()]))).rejects.toThrow("does not match");
  });
});
