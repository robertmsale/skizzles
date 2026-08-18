import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPathIdentity } from "../src/worktree-reaper-lease.ts";
import {
  bindCleanerToHeldArtifact,
  cleanSettledWorktrees,
  createDefaultReaperDependencies,
  discoverCleanTargets,
  runIdentityBoundClean,
  isLivenessUnavailable,
  isCleanableLifecycle,
  isFlutterPubspec,
  isRunningTask,
  parseGitWorktreePorcelain,
  parseListCleanableResult,
  resolveRegisteredWorktree,
  shouldSkipUnchanged,
  taskListEnumerationTruncated,
  taskTargetIdentityChanged,
  type CleanableTask,
  type GitWorktree,
  type OccupiedWorktree,
  type ReaperDependencies,
  type ReaperState,
} from "../src/worktree-reaper.ts";
import { defaultReaperConfig, parseReaperConfig } from "../src/worktree-reaper-config.ts";
import { CLEANABLE_TASK_CAP, mergeArchivedTasks, projectCleanableWorktrees, projectOccupiedWorktrees, projectTask } from "../src/task-projection.ts";
import type { T3Thread } from "../src/protocol.ts";

const porcelain = `worktree /repo
HEAD abc
branch refs/heads/master

worktree /repo/.t3/worktrees/repo/t3code-task
HEAD def
branch refs/heads/t3code/task

worktree /repo/.t3/worktrees/repo/other
HEAD ghi
branch refs/heads/t3code/other
`;

function resolved(paths: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(paths));
}

function task(overrides: Partial<CleanableTask> = {}): CleanableTask {
  return {
    id: "thread-1",
    projectId: "project",
    projectTitle: "acme",
    phase: "completed",
    sessionStatus: "ready",
    latestTurnState: "completed",
    backgroundLiveness: null,
    archived: false,
    deleted: false,
    settled: true,
    branch: "t3code/task",
    worktreePath: "/repo/.t3/worktrees/repo/t3code-task",
    workspaceRoot: "/repo",
    ...overrides,
  };
}

function worktrees(): GitWorktree[] {
  return parseGitWorktreePorcelain(porcelain);
}

function pathMap(): Map<string, string> {
  return resolved({
    "/repo": "/repo",
    "/repo/.t3/worktrees/repo/t3code-task": "/repo/.t3/worktrees/repo/t3code-task",
    "/repo/.t3/worktrees/repo/other": "/repo/.t3/worktrees/repo/other",
  });
}

describe("git worktree matching", () => {
  test("parses porcelain worktrees and strips refs/heads", () => {
    expect(worktrees()).toEqual([
      { path: "/repo", branch: "master", bare: false },
      { path: "/repo/.t3/worktrees/repo/t3code-task", branch: "t3code/task", bare: false },
      { path: "/repo/.t3/worktrees/repo/other", branch: "t3code/other", bare: false },
    ]);
  });

  test("prefers a claimed registered worktreePath", () => {
    expect(resolveRegisteredWorktree(task(), worktrees(), pathMap())).toEqual({
      ok: true,
      path: "/repo/.t3/worktrees/repo/t3code-task",
    });
  });

  test("matches a unique branch when worktreePath is absent", () => {
    expect(resolveRegisteredWorktree(task({ worktreePath: null }), worktrees(), pathMap())).toEqual({
      ok: true,
      path: "/repo/.t3/worktrees/repo/t3code-task",
    });
  });

  test("refuses the project primary checkout even when T3 claims it", () => {
    expect(resolveRegisteredWorktree(task({ worktreePath: "/repo" }), worktrees(), pathMap())).toEqual({
      ok: false,
      reason: "refusing to clean project primary checkout /repo",
      failClosed: true,
    });
  });

  test("fails closed when the claimed path is not a registered worktree", () => {
    const paths = pathMap();
    paths.set("/tmp/not-a-worktree", "/tmp/not-a-worktree");
    expect(resolveRegisteredWorktree(task({ worktreePath: "/tmp/not-a-worktree" }), worktrees(), paths)).toEqual({
      ok: false,
      reason: "claimed worktreePath is not a registered git worktree: /tmp/not-a-worktree",
      failClosed: true,
    });
  });

  test("fails closed on ambiguous branch matches", () => {
    const duplicate: GitWorktree[] = [
      ...worktrees(),
      { path: "/repo/.t3/worktrees/repo/t3code-task-dup", branch: "t3code/task", bare: false },
    ];
    const paths = pathMap();
    paths.set("/repo/.t3/worktrees/repo/t3code-task-dup", "/repo/.t3/worktrees/repo/t3code-task-dup");
    expect(resolveRegisteredWorktree(task({ worktreePath: null }), duplicate, paths)).toMatchObject({
      ok: false,
      failClosed: true,
    });
    expect(resolveRegisteredWorktree(task({ worktreePath: null }), duplicate, paths).reason).toContain("ambiguous worktree match");
  });

  test("fails closed when the claimed path is registered on another task branch", () => {
    const resolved = resolveRegisteredWorktree(task({
      branch: "t3code/settled-A",
      worktreePath: "/repo/.t3/worktrees/repo/other",
    }), worktrees(), pathMap());
    expect(resolved).toEqual({
      ok: false,
      reason: "claimed worktreePath branch t3code/other does not match task branch t3code/settled-A",
      failClosed: true,
    });
  });

  test("fails closed when another live task already owns the claimed path", () => {
    const resolved = resolveRegisteredWorktree(
      task(),
      worktrees(),
      pathMap(),
      [{ id: "running-B", path: "/repo/.t3/worktrees/repo/t3code-task" }],
    );
    expect(resolved).toEqual({
      ok: false,
      reason: "worktree /repo/.t3/worktrees/repo/t3code-task is owned by another task running-B",
      failClosed: true,
    });
  });
});

describe("lifecycle gates", () => {
  test("only settled or archived non-deleted tasks are cleanable", () => {
    expect(isCleanableLifecycle(task())).toBe(true);
    expect(isCleanableLifecycle(task({ settled: false, archived: true }))).toBe(true);
    expect(isCleanableLifecycle(task({ settled: false, archived: false }))).toBe(false);
    expect(isCleanableLifecycle(task({ deleted: true }))).toBe(false);
  });

  test("skips session, turn, or phase running", () => {
    expect(isRunningTask(task({ sessionStatus: "running" }))).toBe(true);
    expect(isRunningTask(task({ sessionStatus: "starting" }))).toBe(true);
    expect(isRunningTask(task({ latestTurnState: "running" }))).toBe(true);
    expect(isRunningTask(task({ phase: "running" }))).toBe(true);
    expect(isRunningTask(task({ phase: "starting" }))).toBe(true);
    expect(isRunningTask(task({ phase: "archived", backgroundLiveness: "working" }))).toBe(true);
    expect(isRunningTask(task({ phase: "archived", backgroundLiveness: "monitoring" }))).toBe(true);
    expect(isRunningTask(task({ phase: "completed", sessionStatus: "ready", latestTurnState: "completed" }))).toBe(false);
    expect(isLivenessUnavailable(task({ archived: true, backgroundLiveness: "unknown" }))).toBe(true);
    expect(isLivenessUnavailable(task({ settled: true, archived: false, backgroundLiveness: "unknown" }))).toBe(true);
    expect(isLivenessUnavailable(task({ backgroundLiveness: "paused" as "unknown" }))).toBe(true);
    expect(isLivenessUnavailable(task({ archived: true, backgroundLiveness: null }))).toBe(false);
  });
});

describe("artifact discovery", () => {
  test("detects Flutter pubspecs and ignores non-Flutter packages", () => {
    expect(isFlutterPubspec("name: app\nflutter:\n  uses-material-design: true\n")).toBe(true);
    expect(isFlutterPubspec("environment:\n  sdk: flutter\n")).toBe(true);
    expect(isFlutterPubspec("name: shared\nenvironment:\n  sdk: ^3.0.0\n")).toBe(false);
  });

  test("finds cargo target and flutter build directories from the tree", async () => {
    const root = `/tmp/t3-reaper-discover-${crypto.randomUUID()}`;
    const files = new Map<string, string>([
      [join(root, "Cargo.toml"), "[workspace]\n"],
      [join(root, "services/api/Cargo.toml"), "[package]\nname = \"api\"\n"],
      [join(root, "apps/mobile/pubspec.yaml"), "name: app\nflutter:\n  uses-material-design: true\n"],
    ]);
    const directories = new Set([
      root,
      join(root, "services"),
      join(root, "services/api"),
      join(root, "services/api/target"),
      join(root, "apps"),
      join(root, "apps/mobile"),
      join(root, "apps/mobile/build"),
      join(root, "apps/mobile/.dart_tool"),
    ]);
    const names: Record<string, string[]> = {
      [root]: ["Cargo.toml", "README.md", "apps", "services"],
      [join(root, "services")]: ["api"],
      [join(root, "services/api")]: ["Cargo.toml", "target"],
      [join(root, "apps")]: ["mobile"],
      [join(root, "apps/mobile")]: ["pubspec.yaml", "build", ".dart_tool"],
    };
    const found = await discoverCleanTargets(root, defaultReaperConfig().strategies, {
      isDirectory: async (path) => directories.has(path),
      readDirectoryNames: async (path) => names[path] ?? [],
      readText: async (path) => files.get(path) ?? "",
    });
    expect(found.map((entry) => ({ strategy: entry.strategy, directory: entry.directory })).sort((left, right) => left.directory.localeCompare(right.directory))).toEqual([
      { strategy: "flutter", directory: join(root, "apps/mobile") },
      { strategy: "cargo", directory: join(root, "services/api") },
    ]);
  });
});

describe("cleanSettledWorktrees", () => {
  function deps(overrides: Partial<ReaperDependencies> & {
    tasks?: CleanableTask[];
    truncated?: boolean;
    occupied?: OccupiedWorktree[];
  } = {}): ReaperDependencies & { runs: Array<{ command: string[]; directory: string }>; states: ReaperState[] } {
    const runs: Array<{ command: string[]; directory: string }> = [];
    const states: ReaperState[] = [];
    let state: ReaperState = { version: 1, threads: {} };
    const base: ReaperDependencies = {
      listCleanableTasks: async () => ({
        tasks: overrides.tasks ?? [task()],
        truncated: overrides.truncated ?? false,
        occupied: overrides.occupied ?? [],
      }),
      listGitWorktrees: async () => worktrees(),
      realpath: async (path) => path,
      pathExists: async (path) => path.endsWith("/target") || path.endsWith("/build") || !path.split("/").pop()?.includes("."),
      isDirectory: async (path) => {
        const name = path.split("/").pop() ?? "";
        return name === "target" || name === "build" || name === "apps" || name === "mobile" || path.endsWith("t3code-task");
      },
      readDirectoryNames: async (path) => {
        if (path === "/repo/.t3/worktrees/repo/t3code-task") return ["Cargo.toml", "target", "apps"];
        if (path === "/repo/.t3/worktrees/repo/t3code-task/apps") return ["mobile"];
        if (path === "/repo/.t3/worktrees/repo/t3code-task/apps/mobile") return ["pubspec.yaml", "build"];
        return [];
      },
      readText: async (path) => path.endsWith("pubspec.yaml") ? "name: app\nflutter:\n" : "[package]\n",
      measureBytes: async (path) => path.endsWith("target") || path.endsWith("build") || path.endsWith(".dart_tool") ? 1_000 : 0,
      statIdentity: async () => ({ dev: 1n, ino: 1n }),
      runClean: async (command, directory) => { runs.push({ command, directory }); },
      holdCleanLease: async (entry, path) => {
        const controller = new AbortController();
        return {
          token: "test-lease",
          path,
          threadId: entry.id,
          role: "clean" as const,
          signal: controller.signal,
          abort: () => controller.abort(),
          release: async () => undefined,
        };
      },
      readTask: async (threadId) => (overrides.tasks ?? [task()]).find((entry) => entry.id === threadId) ?? task({ id: threadId }),
      readState: async () => state,
      writeState: async (next) => { state = next; states.push(next); },
      now: () => "2026-08-17T00:00:00.000Z",
    };
    return { ...base, ...overrides, runs, states };
  }

  test("skips running tasks before touching a worktree", async () => {
    const harness = deps({ tasks: [task({ sessionStatus: "running", phase: "running" })] });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report).toMatchObject({ ok: true, cleaned: 0, skipped: 1, failed: 0 });
    expect(report.tasks[0]).toMatchObject({ action: "skipped", reason: "task is running" });
    expect(harness.runs).toEqual([]);
  });

  test("ignores stale missing sibling worktrees when the claimed path is live", async () => {
    const harness = deps({
      listGitWorktrees: async () => [
        ...worktrees(),
        { path: "/tmp/stale-linked-worktree", branch: "codex/stale", bare: false },
      ],
      realpath: async (path) => {
        if (path === "/tmp/stale-linked-worktree") throw new Error(`path does not exist: ${path}`);
        return path;
      },
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: true });
    expect(report.ok).toBe(true);
    expect(report.tasks[0]).toMatchObject({
      action: "would-clean",
      path: "/repo/.t3/worktrees/repo/t3code-task",
    });
  });

  test("refuses the primary checkout and does not clean", async () => {
    const harness = deps({ tasks: [task({ worktreePath: "/repo" })] });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(false);
    expect(report.tasks[0]).toMatchObject({ action: "failed", reason: "refusing to clean project primary checkout /repo" });
    expect(harness.runs).toEqual([]);
  });

  test("dry-run reports bytes without invoking cleaners or writing state", async () => {
    const harness = deps();
    const report = await cleanSettledWorktrees(harness, { dryRun: true });
    expect(report).toMatchObject({ ok: true, dryRun: true, cleaned: 1, bytesFreed: 2_000 });
    expect(report.tasks[0]).toMatchObject({
      action: "would-clean",
      threadId: "thread-1",
      path: "/repo/.t3/worktrees/repo/t3code-task",
      bytesFreed: 2_000,
    });
    expect(harness.runs).toEqual([]);
    expect(harness.states).toEqual([]);
  });

  test("cleans detected cargo and flutter artifact roots and records last size", async () => {
    const harness = deps();
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(true);
    expect(harness.runs).toEqual([
      { command: ["cargo", "clean", "--target-dir", "target"], directory: "/repo/.t3/worktrees/repo/t3code-task" },
      { command: ["flutter", "clean"], directory: "/repo/.t3/worktrees/repo/t3code-task/apps/mobile" },
    ]);
    expect(harness.states.at(-1)?.threads["thread-1"]).toEqual({
      path: "/repo/.t3/worktrees/repo/t3code-task",
      bytesAfter: 2_000,
      cleanedAt: "2026-08-17T00:00:00.000Z",
    });
    expect(report.tasks[0]?.action).toBe("cleaned");
  });

  test("reruns are cheap when recorded size is unchanged", async () => {
    const harness = deps({
      readState: async () => ({
        version: 1,
        threads: {
          "thread-1": { path: "/repo/.t3/worktrees/repo/t3code-task", bytesAfter: 2_000, cleanedAt: "earlier" },
        },
      }),
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.tasks[0]).toMatchObject({ action: "unchanged", reason: "already cleaned at recorded size" });
    expect(harness.runs).toEqual([]);
    expect(shouldSkipUnchanged({
      version: 1,
      threads: { "thread-1": { path: "/repo/.t3/worktrees/repo/t3code-task", bytesAfter: 2_000, cleanedAt: "earlier" } },
    }, "thread-1", "/repo/.t3/worktrees/repo/t3code-task", 2_000)).toBe(true);
  });

  test("skips a project disabled in host config", async () => {
    const harness = deps();
    const report = await cleanSettledWorktrees(harness, {
      dryRun: false,
      config: parseReaperConfig(`
[[projects]]
id = "acme"
enabled = false
`),
    });
    expect(report.tasks[0]).toMatchObject({ action: "skipped", reason: "project disabled by host config" });
    expect(harness.runs).toEqual([]);
  });

  test("refuses a denied worktree path", async () => {
    const harness = deps();
    const report = await cleanSettledWorktrees(harness, {
      dryRun: false,
      config: parseReaperConfig(`
deny_paths = ["/repo/.t3/worktrees/repo/t3code-task"]
`),
    });
    expect(report.tasks[0]).toMatchObject({ action: "skipped", reason: "worktree is denied by host config" });
    expect(harness.runs).toEqual([]);
  });

  test("resolves relative deny_paths against the worktree, not process cwd", async () => {
    const harness = deps();
    const report = await cleanSettledWorktrees(harness, {
      dryRun: false,
      config: parseReaperConfig(`deny_paths = ["apps/mobile"]\n`),
    });
    expect(report.ok).toBe(true);
    expect(harness.runs).toEqual([
      { command: ["cargo", "clean", "--target-dir", "target"], directory: "/repo/.t3/worktrees/repo/t3code-task" },
    ]);
  });

  test("runs extra host commands only against a named artifact directory", async () => {
    const harness = deps({
      isDirectory: async (path) => {
        const name = path.split("/").pop() ?? "";
        return name === "target" || name === "build" || name === ".dart_tool" || name === "apps" || name === "mobile" || path.endsWith("t3code-task");
      },
      readDirectoryNames: async (path) => {
        if (path === "/repo/.t3/worktrees/repo/t3code-task") return ["Cargo.toml", "target", "apps"];
        if (path === "/repo/.t3/worktrees/repo/t3code-task/apps") return ["mobile"];
        if (path === "/repo/.t3/worktrees/repo/t3code-task/apps/mobile") return ["pubspec.yaml", "build", ".dart_tool"];
        return [];
      },
    });
    const report = await cleanSettledWorktrees(harness, {
      dryRun: false,
      config: parseReaperConfig(`
[[extra_commands]]
match = "apps/mobile"
artifact_dir = ".dart_tool"
command = ["rm", "-rf", ".dart_tool"]
`),
    });
    expect(report.ok).toBe(true);
    expect(harness.runs.at(-1)).toEqual({
      command: ["rm", "-rf", ".dart_tool"],
      directory: "/repo/.t3/worktrees/repo/t3code-task/apps/mobile",
    });
  });

  test("skips archived tasks with live background work", async () => {
    const harness = deps({
      tasks: [task({ archived: true, settled: true, phase: "archived", backgroundLiveness: "working" })],
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.tasks[0]).toMatchObject({ action: "skipped", reason: "task is running" });
    expect(harness.runs).toEqual([]);
  });

  test("does not clean archived-only snapshot rows that lost background liveness", async () => {
    const archived: T3Thread = {
      id: "archived-live",
      projectId: "project",
      title: "Archived",
      modelSelection: { instanceId: "codex", model: "model", options: [{ id: "reasoningEffort", value: "high" }] },
      runtimeMode: "auto",
      interactionMode: "default",
      worktreePath: "/repo/.t3/worktrees/repo/t3code-task",
      branch: "t3code/task",
      archivedAt: "now",
      settledOverride: "settled",
      session: { status: "stopped" },
    };
    expect(Object.hasOwn(archived, "backgroundLiveness")).toBe(false);
    const listed = projectCleanableWorktrees(mergeArchivedTasks({
      snapshotSequence: 1,
      projects: [{ id: "project", title: "acme", workspaceRoot: "/repo" }],
      threads: [],
      updatedAt: "now",
    }, {
      snapshotSequence: 2,
      projects: [{ id: "project", title: "acme", workspaceRoot: "/repo" }],
      threads: [archived],
    }));
    expect(listed.tasks[0]).toMatchObject({ id: "archived-live", backgroundLiveness: "unknown", archived: true });
    const harness = deps({ tasks: listed.tasks.map((entry) => ({
      id: entry.id,
      projectId: entry.projectId,
      projectTitle: entry.projectTitle,
      phase: entry.phase,
      sessionStatus: entry.sessionStatus,
      latestTurnState: entry.latestTurnState,
      backgroundLiveness: entry.backgroundLiveness,
      archived: entry.archived,
      deleted: entry.deleted,
      settled: entry.settled,
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      workspaceRoot: entry.workspaceRoot,
    })) });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.tasks[0]).toMatchObject({ action: "skipped", reason: "liveness unavailable" });
    expect(harness.runs).toEqual([]);
  });

  test("skips settled tasks whose projected liveness is an unrecognized runtime value", async () => {
    const listed = projectTask({
      id: "settled-paused",
      projectId: "project",
      title: "Settled",
      modelSelection: { instanceId: "codex", model: "model", options: [{ id: "reasoningEffort", value: "high" }] },
      runtimeMode: "auto",
      interactionMode: "default",
      worktreePath: "/repo/.t3/worktrees/repo/t3code-task",
      branch: "t3code/task",
      settledOverride: "settled",
      archivedAt: null,
      backgroundLiveness: "paused" as "unknown",
      session: { status: "ready" },
    }, new Map([["project", { id: "project", title: "acme", workspaceRoot: "/repo" }]]));
    expect(listed.backgroundLiveness).toBe("unknown");
    const harness = deps({
      tasks: [{
        id: listed.id,
        projectId: listed.projectId,
        projectTitle: listed.projectTitle,
        phase: listed.phase,
        sessionStatus: listed.sessionStatus,
        latestTurnState: listed.latestTurnState,
        backgroundLiveness: listed.backgroundLiveness,
        archived: listed.archived,
        deleted: listed.deleted,
        settled: listed.settled,
        branch: listed.branch,
        worktreePath: listed.worktreePath,
        workspaceRoot: listed.workspaceRoot,
      }],
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.tasks[0]).toMatchObject({ action: "skipped", reason: "liveness unavailable" });
    expect(harness.runs).toEqual([]);
  });

  test("skips settled non-archived tasks whose liveness is unknown", async () => {
    const harness = deps({
      tasks: [task({ archived: false, settled: true, phase: "completed", backgroundLiveness: "unknown" })],
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.tasks[0]).toMatchObject({ action: "skipped", reason: "liveness unavailable" });
    expect(harness.runs).toEqual([]);
  });

  test("skips archived tasks whose projected liveness is unknown", async () => {
    const harness = deps({
      tasks: [task({ archived: true, settled: true, phase: "archived", backgroundLiveness: "unknown" })],
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.tasks[0]).toMatchObject({ action: "skipped", reason: "liveness unavailable" });
    expect(harness.runs).toEqual([]);
  });

  test("re-resolves when the fresh task identity no longer matches the listed target", async () => {
    const harness = deps({
      readTask: async () => task({
        worktreePath: "/repo/.t3/worktrees/repo/other",
        branch: "t3code/other",
      }),
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(taskTargetIdentityChanged(
      task(),
      task({ worktreePath: "/repo/.t3/worktrees/repo/other", branch: "t3code/other" }),
    )).toBe(true);
    expect(report.tasks[0]).toMatchObject({
      action: "unchanged",
      path: "/repo/.t3/worktrees/repo/other",
      reason: "no matching artifacts",
    });
    expect(harness.runs).toEqual([]);
  });

  test("revalidates lifecycle immediately before cleaning", async () => {
    const harness = deps({
      readTask: async () => task({ sessionStatus: "running", latestTurnState: "running", phase: "running" }),
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.tasks[0]).toMatchObject({ action: "skipped", reason: "task is running" });
    expect(harness.runs).toEqual([]);
  });

  test("falls back to tasks.list when the running daemon lacks worktrees.listCleanable", async () => {
    const ops: string[] = [];
    const listedDeps = createDefaultReaperDependencies(async (payload) => {
      ops.push(String(payload.op));
      if (payload.op === "worktrees.listCleanable") return { ok: false, error: "Unknown operation: worktrees.listCleanable" };
      if (payload.op === "projects.list") return { ok: true, result: { projects: [{ id: "project", workspaceRoot: "/repo" }] } };
      if (payload.op === "tasks.list") {
        return {
          ok: true,
          result: {
            tasks: [
              task({ id: "settled", workspaceRoot: null }),
              task({ id: "active", settled: false, archived: false }),
            ],
            moreRecent: 0,
          },
        };
      }
      return { ok: false, error: `unexpected ${String(payload.op)}` };
    });
    const listed = await listedDeps.listCleanableTasks();
    expect(ops).toEqual(["worktrees.listCleanable", "projects.list", "tasks.list"]);
    expect(listed.truncated).toBe(false);
    expect(listed.occupied).toEqual([
      { id: "settled", path: "/repo/.t3/worktrees/repo/t3code-task" },
      { id: "active", path: "/repo/.t3/worktrees/repo/t3code-task" },
    ]);
    expect(listed.tasks.map((entry) => ({ id: entry.id, workspaceRoot: entry.workspaceRoot }))).toEqual([
      { id: "settled", workspaceRoot: "/repo" },
    ]);
  });

  test("treats a truncated tasks.list fallback as an incomplete enumeration", async () => {
    const listedDeps = createDefaultReaperDependencies(async (payload) => {
      if (payload.op === "worktrees.listCleanable") return { ok: false, error: "Unknown operation: worktrees.listCleanable" };
      if (payload.op === "projects.list") return { ok: true, result: { projects: [{ id: "project", workspaceRoot: "/repo" }] } };
      if (payload.op === "tasks.list") {
        return {
          ok: true,
          result: {
            tasks: [task({ id: "settled" })],
            moreRecent: 1,
          },
        };
      }
      return { ok: false, error: `unexpected ${String(payload.op)}` };
    });
    const listed = await listedDeps.listCleanableTasks();
    expect(listed.truncated).toBe(true);
    expect(listed.tasks.map((entry) => entry.id)).toEqual(["settled"]);
  });

  test("does not clean another task's registered worktree when a settled task claims it", async () => {
    const runningPath = "/repo/.t3/worktrees/repo/running-B";
    const harness = deps({
      tasks: [task({
        id: "settled-A",
        branch: "t3code/settled-A",
        worktreePath: runningPath,
      })],
      occupied: [{ id: "running-B", path: runningPath }],
      listGitWorktrees: async () => [
        ...worktrees(),
        { path: runningPath, branch: "t3code/running-B", bare: false },
      ],
      realpath: async (path) => path,
      isDirectory: async (path) => path === runningPath || path.endsWith("/target"),
      readDirectoryNames: async (path) => path === runningPath ? ["Cargo.toml", "target"] : [],
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(false);
    expect(report.tasks[0]).toMatchObject({
      threadId: "settled-A",
      action: "failed",
      reason: "claimed worktreePath branch t3code/running-B does not match task branch t3code/settled-A",
    });
    expect(harness.runs).toEqual([]);
  });

  test("does not clean a matching-branch claim already owned by another live task", async () => {
    const runningPath = "/repo/.t3/worktrees/repo/running-B";
    const harness = deps({
      tasks: [task({
        id: "settled-A",
        branch: "t3code/running-B",
        worktreePath: runningPath,
      })],
      occupied: [{ id: "running-B", path: runningPath }],
      listGitWorktrees: async () => [
        ...worktrees(),
        { path: runningPath, branch: "t3code/running-B", bare: false },
      ],
      realpath: async (path) => path,
      isDirectory: async (path) => path === runningPath || path.endsWith("/target"),
      readDirectoryNames: async (path) => path === runningPath ? ["Cargo.toml", "target"] : [],
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(false);
    expect(report.tasks[0]).toMatchObject({
      threadId: "settled-A",
      action: "failed",
      reason: `worktree ${runningPath} is owned by another task running-B`,
    });
    expect(harness.runs).toEqual([]);
  });

  test("fails closed at the cleanable-task cap instead of omitting the oldest worktree", async () => {
    const snapshot = {
      snapshotSequence: 1,
      projects: [{ id: "project", title: "acme", workspaceRoot: "/repo" }],
      threads: Array.from({ length: CLEANABLE_TASK_CAP + 1 }, (_, index) => ({
        id: `settled-${index}`,
        projectId: "project",
        title: `Settled ${index}`,
        modelSelection: { instanceId: "codex", model: "model", options: [{ id: "reasoningEffort", value: "high" }] },
        runtimeMode: "auto" as const,
        interactionMode: "default" as const,
        worktreePath: `/repo/.t3/worktrees/repo/t3code-${index}`,
        branch: `t3code/${index}`,
        settledOverride: "settled" as const,
        archivedAt: null,
        deletedAt: null,
        backgroundLiveness: null,
        session: { status: "ready" as const },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
      })),
    };
    const listed = projectCleanableWorktrees(snapshot);
    expect(listed.truncated).toBe(true);
    expect(listed.count).toBe(CLEANABLE_TASK_CAP);
    expect(listed.tasks).toHaveLength(CLEANABLE_TASK_CAP);
    expect(listed.tasks.some((entry) => entry.id === "settled-0")).toBe(false);
    expect(listed.occupied).toHaveLength(CLEANABLE_TASK_CAP + 1);
    const harness = deps({
      tasks: listed.tasks.map((entry) => ({
        id: entry.id,
        projectId: entry.projectId,
        projectTitle: entry.projectTitle,
        phase: entry.phase,
        sessionStatus: entry.sessionStatus,
        latestTurnState: entry.latestTurnState,
        backgroundLiveness: entry.backgroundLiveness,
        archived: entry.archived,
        deleted: entry.deleted,
        settled: entry.settled,
        branch: entry.branch,
        worktreePath: entry.worktreePath,
        workspaceRoot: entry.workspaceRoot,
      })),
      truncated: listed.truncated,
      occupied: listed.occupied,
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report).toMatchObject({
      ok: false,
      scanned: CLEANABLE_TASK_CAP,
      cleaned: 0,
      failed: 1,
    });
    expect(report.tasks[0]).toMatchObject({
      threadId: "enumeration",
      action: "failed",
      reason: `cleanable-task enumeration truncated at ${CLEANABLE_TASK_CAP}; refusing incomplete cleanup`,
    });
    expect(harness.runs).toEqual([]);
  });

  test("fails closed when a successful listCleanable response omits occupancy proof", async () => {
    expect(() => parseListCleanableResult({
      tasks: [task({ id: "settled-A", branch: "t3code/task", worktreePath: "/repo/.t3/worktrees/repo/shared" })],
      count: 1,
      truncated: false,
    })).toThrow(/omitted occupied/);
    expect(() => parseListCleanableResult({
      tasks: [task()],
      truncated: 1,
      occupied: [],
    })).toThrow(/malformed truncated/);
    expect(() => parseListCleanableResult({
      tasks: [task()],
      occupied: [],
    })).toThrow(/malformed truncated/);
    expect(taskListEnumerationTruncated(undefined)).toBe(true);
    expect(taskListEnumerationTruncated(1)).toBe(true);
    expect(taskListEnumerationTruncated(0)).toBe(false);

    const shared = "/repo/.t3/worktrees/repo/shared";
    const settledA = task({
      id: "settled-A",
      branch: "t3code/task",
      worktreePath: shared,
    });
    const base = createDefaultReaperDependencies(async (payload) => {
      if (payload.op === "worktrees.listCleanable") {
        return {
          ok: true,
          result: { tasks: [settledA], count: 1, truncated: false },
        };
      }
      return { ok: false, error: `unexpected ${String(payload.op)}` };
    });
    const harness = deps({
      listCleanableTasks: async () => base.listCleanableTasks(),
      listGitWorktrees: async () => [
        { path: "/repo", branch: "master", bare: false },
        { path: shared, branch: "t3code/task", bare: false },
      ],
      isDirectory: async (path) => path === shared || path.endsWith("/target"),
      readDirectoryNames: async (path) => path === shared ? ["Cargo.toml", "target"] : [],
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(false);
    expect(report.cleaned).toBe(0);
    expect(report.tasks[0]).toMatchObject({
      threadId: "enumeration",
      action: "failed",
    });
    expect(report.tasks[0]?.reason).toMatch(/omitted occupied/);
    expect(harness.runs).toEqual([]);

    const numericTruncation = createDefaultReaperDependencies(async (payload) => {
      if (payload.op === "worktrees.listCleanable") {
        return { ok: true, result: { tasks: [settledA], truncated: 1, occupied: [] } };
      }
      return { ok: false, error: `unexpected ${String(payload.op)}` };
    });
    const numericReport = await cleanSettledWorktrees(deps({
      listCleanableTasks: async () => numericTruncation.listCleanableTasks(),
    }), { dryRun: false });
    expect(numericReport.ok).toBe(false);
    expect(numericReport.tasks[0]?.reason).toMatch(/malformed truncated/);
    expect(harness.runs).toEqual([]);
  });

  test("fails closed when tasks.list fallback omits moreRecent completeness proof", async () => {
    const listedDeps = createDefaultReaperDependencies(async (payload) => {
      if (payload.op === "worktrees.listCleanable") return { ok: false, error: "Unknown operation: worktrees.listCleanable" };
      if (payload.op === "projects.list") return { ok: true, result: { projects: [{ id: "project", workspaceRoot: "/repo" }] } };
      if (payload.op === "tasks.list") {
        return { ok: true, result: { tasks: [task({ id: "settled" })] } };
      }
      return { ok: false, error: `unexpected ${String(payload.op)}` };
    });
    const listed = await listedDeps.listCleanableTasks();
    expect(listed.truncated).toBe(true);
    const harness = deps({
      listCleanableTasks: async () => listed,
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(false);
    expect(report.tasks[0]).toMatchObject({
      threadId: "enumeration",
      action: "failed",
    });
    expect(harness.runs).toEqual([]);
  });

  test("does not clean when a newer full snapshot has an active owner missing from shell", async () => {
    const shared = "/repo/.t3/worktrees/repo/shared";
    const settledA = {
      id: "settled-A",
      projectId: "project",
      title: "Settled",
      modelSelection: { instanceId: "codex", model: "model", options: [{ id: "reasoningEffort", value: "high" }] },
      runtimeMode: "auto" as const,
      interactionMode: "default" as const,
      worktreePath: shared,
      branch: "t3code/task",
      settledOverride: "settled" as const,
      archivedAt: null,
      deletedAt: null,
      backgroundLiveness: null,
      session: { status: "ready" as const },
      createdAt: "2026-08-17T00:00:00Z",
      updatedAt: "2026-08-17T00:00:00Z",
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    const runningB = {
      ...settledA,
      id: "running-B",
      title: "Running",
      settledOverride: null,
      session: { status: "running" as const },
      updatedAt: "2026-08-17T00:00:01Z",
    };
    const listed = projectCleanableWorktrees(mergeArchivedTasks({
      snapshotSequence: 1,
      projects: [{ id: "project", title: "acme", workspaceRoot: "/repo", deletedAt: null }],
      threads: [settledA],
      updatedAt: "now",
    }, {
      snapshotSequence: 2,
      projects: [{ id: "project", title: "acme", workspaceRoot: "/repo", deletedAt: null }],
      threads: [settledA, runningB],
    }));
    expect(listed.occupied.map((entry) => entry.id)).toEqual(["settled-A", "running-B"]);
    const harness = deps({
      tasks: listed.tasks.map((entry) => ({
        id: entry.id,
        projectId: entry.projectId,
        projectTitle: entry.projectTitle,
        phase: entry.phase,
        sessionStatus: entry.sessionStatus,
        latestTurnState: entry.latestTurnState,
        backgroundLiveness: entry.backgroundLiveness,
        archived: entry.archived,
        deleted: entry.deleted,
        settled: entry.settled,
        branch: entry.branch,
        worktreePath: entry.worktreePath,
        workspaceRoot: entry.workspaceRoot,
      })),
      occupied: listed.occupied,
      listGitWorktrees: async () => [
        { path: "/repo", branch: "master", bare: false },
        { path: shared, branch: "t3code/task", bare: false },
      ],
      isDirectory: async (path) => path === shared || path.endsWith("/target"),
      readDirectoryNames: async (path) => path === shared ? ["Cargo.toml", "target"] : [],
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(false);
    expect(report.tasks[0]).toMatchObject({
      threadId: "settled-A",
      action: "failed",
      reason: `worktree ${shared} is owned by another task running-B`,
    });
    expect(harness.runs).toEqual([]);
  });

  test("revalidates occupancy after readTask before invoking a cleaner", async () => {
    const shared = "/repo/.t3/worktrees/repo/shared";
    const settledA = task({
      id: "settled-A",
      branch: "t3code/task",
      worktreePath: shared,
    });
    let listings = 0;
    const harness = deps({
      listCleanableTasks: async () => {
        listings += 1;
        return {
          tasks: [settledA],
          truncated: false,
          occupied: listings === 1
            ? [{ id: "settled-A", path: shared }]
            : [
              { id: "settled-A", path: shared },
              { id: "running-B", path: shared },
            ],
        };
      },
      listGitWorktrees: async () => [
        { path: "/repo", branch: "master", bare: false },
        { path: shared, branch: "t3code/task", bare: false },
      ],
      isDirectory: async (path) => path === shared || path.endsWith("/target"),
      readDirectoryNames: async (path) => path === shared ? ["Cargo.toml", "target"] : [],
      readTask: async () => settledA,
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(listings).toBeGreaterThan(1);
    expect(report.ok).toBe(false);
    expect(report.tasks[0]).toMatchObject({
      threadId: "settled-A",
      action: "failed",
      reason: `worktree ${shared} is owned by another task running-B`,
    });
    expect(harness.runs).toEqual([]);
  });

  test("does not clean when the same task leaves the cleanable list but still occupies the path", async () => {
    const shared = "/repo/.t3/worktrees/repo/shared";
    const settledA = task({
      id: "settled-A",
      branch: "t3code/task",
      worktreePath: shared,
    });
    let listings = 0;
    const harness = deps({
      listCleanableTasks: async () => {
        listings += 1;
        return {
          tasks: listings === 1 ? [settledA] : [],
          truncated: false,
          occupied: [{ id: "settled-A", path: shared }],
        };
      },
      listGitWorktrees: async () => [
        { path: "/repo", branch: "master", bare: false },
        { path: shared, branch: "t3code/task", bare: false },
      ],
      isDirectory: async (path) => path === shared || path.endsWith("/target"),
      readDirectoryNames: async (path) => path === shared ? ["Cargo.toml", "target"] : [],
      readTask: async () => settledA,
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(listings).toBeGreaterThan(1);
    expect(report.ok).toBe(false);
    expect(report.cleaned).toBe(0);
    expect(report.tasks[0]).toMatchObject({
      threadId: "settled-A",
      action: "failed",
      reason: "task is no longer listed as cleanable",
    });
    expect(harness.runs).toEqual([]);
  });

  test("does not clean when the same task is still listed but has resumed running", async () => {
    const shared = "/repo/.t3/worktrees/repo/shared";
    const settledA = task({
      id: "settled-A",
      branch: "t3code/task",
      worktreePath: shared,
    });
    const runningA = task({
      id: "settled-A",
      branch: "t3code/task",
      worktreePath: shared,
      sessionStatus: "running",
      latestTurnState: "running",
      phase: "running",
    });
    let listings = 0;
    const harness = deps({
      listCleanableTasks: async () => {
        listings += 1;
        return {
          tasks: [listings === 1 ? settledA : runningA],
          truncated: false,
          occupied: [{ id: "settled-A", path: shared }],
        };
      },
      listGitWorktrees: async () => [
        { path: "/repo", branch: "master", bare: false },
        { path: shared, branch: "t3code/task", bare: false },
      ],
      isDirectory: async (path) => path === shared || path.endsWith("/target"),
      readDirectoryNames: async (path) => path === shared ? ["Cargo.toml", "target"] : [],
      readTask: async () => settledA,
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(listings).toBeGreaterThan(1);
    expect(report.ok).toBe(false);
    expect(report.cleaned).toBe(0);
    expect(report.tasks[0]).toMatchObject({
      threadId: "settled-A",
      action: "failed",
      reason: "task is running",
    });
    expect(harness.runs).toEqual([]);
  });

  test("does not clean when the task resumes after the lease is held and before the cleaner", async () => {
    const shared = "/repo/.t3/worktrees/repo/shared";
    const settledA = task({
      id: "settled-A",
      branch: "t3code/task",
      worktreePath: shared,
    });
    const runningA = task({
      id: "settled-A",
      branch: "t3code/task",
      worktreePath: shared,
      sessionStatus: "running",
      latestTurnState: "running",
      phase: "running",
    });
    let leased = false;
    const order: string[] = [];
    const harness = deps({
      listCleanableTasks: async () => {
        order.push("list");
        return {
          tasks: [leased ? runningA : settledA],
          truncated: false,
          occupied: [{ id: "settled-A", path: shared }],
        };
      },
      listGitWorktrees: async () => [
        { path: "/repo", branch: "master", bare: false },
        { path: shared, branch: "t3code/task", bare: false },
      ],
      isDirectory: async (path) => path === shared || path.endsWith("/target"),
      readDirectoryNames: async (path) => path === shared ? ["Cargo.toml", "target"] : [],
      readTask: async () => leased ? runningA : settledA,
      holdCleanLease: async (entry, path) => {
        order.push("lease");
        leased = true;
        const controller = new AbortController();
        return {
          token: "lease",
          path,
          threadId: entry.id,
          role: "clean" as const,
          signal: controller.signal,
          abort: () => controller.abort(),
          release: async () => { order.push("release"); },
        };
      },
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(order[0]).toBe("list");
    expect(order).toContain("lease");
    expect(order.indexOf("lease")).toBeLessThan(order.lastIndexOf("list"));
    expect(order).toContain("release");
    expect(report.ok).toBe(false);
    expect(report.cleaned).toBe(0);
    expect(report.tasks[0]).toMatchObject({
      threadId: "settled-A",
      action: "failed",
      reason: "task is running",
    });
    expect(harness.runs).toEqual([]);
  });

  test("does not report cleaned when the lease aborts while a cleaner would run", async () => {
    const shared = "/repo/.t3/worktrees/repo/shared";
    const settledA = task({
      id: "settled-A",
      branch: "t3code/task",
      worktreePath: shared,
    });
    const controller = new AbortController();
    const harness = deps({
      tasks: [settledA],
      occupied: [{ id: "settled-A", path: shared }],
      listGitWorktrees: async () => [
        { path: "/repo", branch: "master", bare: false },
        { path: shared, branch: "t3code/task", bare: false },
      ],
      isDirectory: async (path) => path === shared || path.endsWith("/target"),
      readDirectoryNames: async (path) => path === shared ? ["Cargo.toml", "target"] : [],
      holdCleanLease: async (entry, path) => ({
        token: "lease",
        path,
        threadId: entry.id,
        role: "clean" as const,
        signal: controller.signal,
        abort: () => controller.abort(),
        release: async () => undefined,
      }),
      runClean: async (_command, _directory, signal) => {
        controller.abort();
        if (signal?.aborted) throw new Error("clean aborted: task resumed");
        throw new Error("runClean continued after lease abort");
      },
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(false);
    expect(report.cleaned).toBe(0);
    expect(report.tasks[0]).toMatchObject({
      threadId: "settled-A",
      action: "failed",
      reason: "clean aborted: task resumed",
    });
    expect(harness.runs).toEqual([]);
  });

  test("does not clean an artifact directory replaced after planning", async () => {
    const shared = "/repo/.t3/worktrees/repo/shared";
    const artifact = `${shared}/target`;
    let artifactGeneration = 10n;
    const harness = deps({
      tasks: [task({
        id: "settled-A",
        branch: "t3code/task",
        worktreePath: shared,
      })],
      occupied: [{ id: "settled-A", path: shared }],
      listGitWorktrees: async () => [
        { path: "/repo", branch: "master", bare: false },
        { path: shared, branch: "t3code/task", bare: false },
      ],
      isDirectory: async (path) => path === shared || path.endsWith("/target"),
      readDirectoryNames: async (path) => path === shared ? ["Cargo.toml", "target"] : [],
      statIdentity: async (path) => (
        path === artifact ? { dev: 1n, ino: artifactGeneration } : { dev: 1n, ino: 1n }
      ),
      holdCleanLease: async (entry, path) => {
        artifactGeneration = 11n;
        const controller = new AbortController();
        return {
          token: "lease",
          path,
          threadId: entry.id,
          role: "clean" as const,
          signal: controller.signal,
          abort: () => controller.abort(),
          release: async () => undefined,
        };
      },
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(false);
    expect(report.cleaned).toBe(0);
    expect(report.tasks[0]).toMatchObject({
      threadId: "settled-A",
      action: "failed",
      reason: `artifact directory ${artifact} was replaced after planning`,
    });
    expect(harness.runs).toEqual([]);
  });

  test("does not clean a worktree path replaced after planning", async () => {
    const shared = "/repo/.t3/worktrees/repo/shared";
    let generation = 1n;
    const harness = deps({
      tasks: [task({
        id: "settled-A",
        branch: "t3code/task",
        worktreePath: shared,
      })],
      occupied: [{ id: "settled-A", path: shared }],
      listGitWorktrees: async () => [
        { path: "/repo", branch: "master", bare: false },
        { path: shared, branch: "t3code/task", bare: false },
      ],
      isDirectory: async (path) => path === shared || path.endsWith("/target"),
      readDirectoryNames: async (path) => path === shared ? ["Cargo.toml", "target"] : [],
      statIdentity: async () => ({ dev: 1n, ino: generation }),
      holdCleanLease: async (entry, path) => {
        generation = 2n;
        const controller = new AbortController();
        return {
          token: "lease",
          path,
          threadId: entry.id,
          role: "clean" as const,
          signal: controller.signal,
          abort: () => controller.abort(),
          release: async () => undefined,
        };
      },
    });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(false);
    expect(report.cleaned).toBe(0);
    expect(report.tasks[0]).toMatchObject({
      threadId: "settled-A",
      action: "failed",
      reason: `worktree ${shared} was replaced after planning`,
    });
    expect(harness.runs).toEqual([]);
  });
});

describe("identity-bound cleaner launch", () => {
  test("rewrites allowed cleaners onto the held artifact name", () => {
    expect(bindCleanerToHeldArtifact(["cargo", "clean", "--target-dir", "target"], "target", ".held")).toEqual([
      "cargo", "clean", "--target-dir", ".held",
    ]);
    expect(bindCleanerToHeldArtifact(["rm", "-rf", "target"], "target", ".held")).toEqual(["rm", "-rf", ".held"]);
    expect(bindCleanerToHeldArtifact(["flutter", "clean"], "build", ".held")).toEqual(["rm", "-rf", ".held"]);
  });

  test("runs the cleaner when directory and artifact inodes still match", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-reaper-launch-"));
    const directory = join(root, "crate");
    const artifactDir = join(directory, "target");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(directory, "Cargo.toml"), "[package]\nname=\"x\"\nversion=\"0.0.0\"\n");
    const directoryIdentity = await inspectPathIdentity(directory);
    const artifactIdentity = await inspectPathIdentity(artifactDir);
    expect(directoryIdentity).toBeDefined();
    expect(artifactIdentity).toBeDefined();
    await runIdentityBoundClean(
      [process.execPath, "--eval", "await Bun.write('launched', 'yes')"],
      directory,
      {
        directoryIdentity: directoryIdentity!,
        artifactDir,
        artifactName: "target",
        artifactIdentity: artifactIdentity!,
      },
    );
    expect(await Bun.file(join(directory, "launched")).text()).toBe("yes");
    await rm(root, { recursive: true, force: true });
  });

  test("refuses a cleaner when the worktree directory is replaced before spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-reaper-launch-"));
    const directory = join(root, "crate");
    const replacement = join(root, "replacement");
    const artifactDir = join(directory, "target");
    await mkdir(artifactDir, { recursive: true });
    await mkdir(join(replacement, "target"), { recursive: true });
    await writeFile(join(directory, "Cargo.toml"), "[package]\nname=\"x\"\nversion=\"0.0.0\"\n");
    await writeFile(join(replacement, "Cargo.toml"), "[package]\nname=\"x\"\nversion=\"0.0.0\"\n");
    const directoryIdentity = await inspectPathIdentity(directory);
    const artifactIdentity = await inspectPathIdentity(artifactDir);
    expect(directoryIdentity).toBeDefined();
    expect(artifactIdentity).toBeDefined();
    await rename(directory, join(root, "original-aside"));
    await rename(replacement, directory);
    await expect(runIdentityBoundClean(
      [process.execPath, "--eval", "await Bun.write('launched', 'yes')"],
      directory,
      {
        directoryIdentity: directoryIdentity!,
        artifactDir,
        artifactName: "target",
        artifactIdentity: artifactIdentity!,
      },
    )).rejects.toThrow(/clean directory .* was replaced after planning/);
    expect(await Bun.file(join(directory, "launched")).exists()).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("refuses a cleaner when the directory is replaced in the final check-to-launch window", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-reaper-launch-"));
    const directory = join(root, "crate");
    const replacement = join(root, "replacement");
    const artifactDir = join(directory, "target");
    await mkdir(artifactDir, { recursive: true });
    await mkdir(join(replacement, "target"), { recursive: true });
    await writeFile(join(directory, "Cargo.toml"), "[package]\nname=\"x\"\nversion=\"0.0.0\"\n");
    await writeFile(join(replacement, "Cargo.toml"), "[package]\nname=\"x\"\nversion=\"0.0.0\"\n");
    const directoryIdentity = await inspectPathIdentity(directory);
    const artifactIdentity = await inspectPathIdentity(artifactDir);
    expect(directoryIdentity).toBeDefined();
    expect(artifactIdentity).toBeDefined();
    await expect(runIdentityBoundClean(
      [process.execPath, "--eval", "await Bun.write('launched', 'yes')"],
      directory,
      {
        directoryIdentity: directoryIdentity!,
        artifactDir,
        artifactName: "target",
        artifactIdentity: artifactIdentity!,
      },
      undefined,
      {
        afterParentBound: async () => {
          await rename(directory, join(root, "original-aside"));
          await rename(replacement, directory);
        },
      },
    )).rejects.toThrow(/clean directory .* was replaced after planning/);
    expect(await Bun.file(join(directory, "launched")).exists()).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("refuses a cleaner when the artifact directory is replaced after planning", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-reaper-launch-"));
    const directory = join(root, "crate");
    const artifactDir = join(directory, "target");
    const replacement = join(root, "target-replacement");
    await mkdir(artifactDir, { recursive: true });
    await mkdir(replacement, { recursive: true });
    await writeFile(join(directory, "Cargo.toml"), "[package]\nname=\"x\"\nversion=\"0.0.0\"\n");
    const directoryIdentity = await inspectPathIdentity(directory);
    const artifactIdentity = await inspectPathIdentity(artifactDir);
    expect(directoryIdentity).toBeDefined();
    expect(artifactIdentity).toBeDefined();
    await rename(artifactDir, join(root, "target-aside"));
    await rename(replacement, artifactDir);
    await expect(runIdentityBoundClean(
      [process.execPath, "--eval", "await Bun.write('launched', 'yes')"],
      directory,
      {
        directoryIdentity: directoryIdentity!,
        artifactDir,
        artifactName: "target",
        artifactIdentity: artifactIdentity!,
      },
    )).rejects.toThrow(/artifact directory .* was replaced after planning/);
    expect(await Bun.file(join(directory, "launched")).exists()).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("does not clean a replacement installed after artifact lstat and before operand resolve", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-reaper-launch-"));
    const directory = join(root, "crate");
    const artifactDir = join(directory, "target");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(directory, "Cargo.toml"), "[package]\nname=\"x\"\nversion=\"0.0.0\"\n");
    await writeFile(join(artifactDir, "approved.txt"), "planned-inode\n");
    const directoryIdentity = await inspectPathIdentity(directory);
    const artifactIdentity = await inspectPathIdentity(artifactDir);
    expect(directoryIdentity).toBeDefined();
    expect(artifactIdentity).toBeDefined();
    await runIdentityBoundClean(
      ["rm", "-rf", "target"],
      directory,
      {
        directoryIdentity: directoryIdentity!,
        artifactDir,
        artifactName: "target",
        artifactIdentity: artifactIdentity!,
      },
      undefined,
      {
        afterArtifactBound: async () => {
          await mkdir(artifactDir, { recursive: true });
          await writeFile(join(artifactDir, "replacement.txt"), "unapproved-inode\n");
        },
      },
    );
    expect(await Bun.file(join(artifactDir, "replacement.txt")).text()).toBe("unapproved-inode\n");
    expect(await Bun.file(join(artifactDir, "approved.txt")).exists()).toBe(false);
    const leftoverHeld = (await readdir(directory)).filter((name) => name.startsWith(".t3-reaper-held-"));
    expect(leftoverHeld).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});
