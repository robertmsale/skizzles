import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanSettledWorktrees,
  createDefaultReaperDependencies,
  discoverArtifactRoots,
  isCleanableLifecycle,
  isFlutterPubspec,
  isRunningTask,
  parseGitWorktreePorcelain,
  resolveRegisteredWorktree,
  shouldSkipUnchanged,
  type CleanableTask,
  type GitWorktree,
  type ReaperDependencies,
  type ReaperState,
} from "../src/worktree-reaper.ts";

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
    phase: "completed",
    sessionStatus: "ready",
    latestTurnState: "completed",
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
    expect(isRunningTask(task({ latestTurnState: "running" }))).toBe(true);
    expect(isRunningTask(task({ phase: "running" }))).toBe(true);
    expect(isRunningTask(task({ phase: "completed", sessionStatus: "ready", latestTurnState: "completed" }))).toBe(false);
  });
});

describe("artifact discovery", () => {
  test("detects Flutter pubspecs and ignores non-Flutter packages", () => {
    expect(isFlutterPubspec("name: app\nflutter:\n  uses-material-design: true\n")).toBe(true);
    expect(isFlutterPubspec("environment:\n  sdk: flutter\n")).toBe(true);
    expect(isFlutterPubspec("name: shared\nenvironment:\n  sdk: ^3.0.0\n")).toBe(false);
  });

  test("finds cargo target and flutter build directories only", async () => {
    const root = `/tmp/t3-reaper-discover-${crypto.randomUUID()}`;
    await mkdir(join(root, "services/api/target"), { recursive: true });
    await mkdir(join(root, "clients/app/build"), { recursive: true });
    await mkdir(join(root, "clients/app/.dart_tool"), { recursive: true });
    await writeFile(join(root, "Cargo.toml"), "[workspace]\n");
    await writeFile(join(root, "services/api/Cargo.toml"), "[package]\nname = \"api\"\n");
    await writeFile(join(root, "clients/app/pubspec.yaml"), "name: app\nflutter:\n  uses-material-design: true\n");
    await writeFile(join(root, "README.md"), "docs\n");
    const files = new Map<string, string>([
      [join(root, "Cargo.toml"), "[workspace]\n"],
      [join(root, "services/api/Cargo.toml"), "[package]\nname = \"api\"\n"],
      [join(root, "clients/app/pubspec.yaml"), "name: app\nflutter:\n  uses-material-design: true\n"],
    ]);
    const directories = new Set([
      root,
      join(root, "services"),
      join(root, "services/api"),
      join(root, "services/api/target"),
      join(root, "clients"),
      join(root, "clients/app"),
      join(root, "clients/app/build"),
      join(root, "clients/app/.dart_tool"),
    ]);
    const names: Record<string, string[]> = {
      [root]: ["Cargo.toml", "README.md", "clients", "services"],
      [join(root, "services")]: ["api"],
      [join(root, "services/api")]: ["Cargo.toml", "target"],
      [join(root, "clients")]: ["app"],
      [join(root, "clients/app")]: ["pubspec.yaml", "build", ".dart_tool"],
    };
    const found = await discoverArtifactRoots(root, {
      pathExists: async (path) => directories.has(path) || files.has(path),
      isDirectory: async (path) => directories.has(path),
      readDirectoryNames: async (path) => names[path] ?? [],
      readText: async (path) => files.get(path) ?? "",
    });
    expect(found.cargo).toEqual([join(root, "services/api")]);
    expect(found.flutter).toEqual([join(root, "clients/app")]);
  });
});

describe("cleanSettledWorktrees", () => {
  function deps(overrides: Partial<ReaperDependencies> & { tasks?: CleanableTask[] } = {}): ReaperDependencies & { cargo: string[]; flutter: string[]; states: ReaperState[] } {
    const cargo: string[] = [];
    const flutter: string[] = [];
    const states: ReaperState[] = [];
    let state: ReaperState = { version: 1, threads: {} };
    const base: ReaperDependencies = {
      listCleanableTasks: async () => overrides.tasks ?? [task()],
      listGitWorktrees: async () => worktrees(),
      realpath: async (path) => path,
      pathExists: async (path) => path.endsWith("/target") || path.endsWith("/build") || !path.split("/").pop()?.includes("."),
      isDirectory: async (path) => {
        const name = path.split("/").pop() ?? "";
        return name === "target" || name === "build" || name === "clients" || name === "app" || path.endsWith("t3code-task");
      },
      readDirectoryNames: async (path) => {
        if (path === "/repo/.t3/worktrees/repo/t3code-task") return ["Cargo.toml", "target", "clients"];
        if (path === "/repo/.t3/worktrees/repo/t3code-task/clients") return ["app"];
        if (path === "/repo/.t3/worktrees/repo/t3code-task/clients/app") return ["pubspec.yaml", "build"];
        return [];
      },
      readText: async (path) => path.endsWith("pubspec.yaml") ? "name: app\nflutter:\n" : "[package]\n",
      measureBytes: async (path) => path.endsWith("target") || path.endsWith("build") ? 1_000 : 0,
      cargoClean: async (directory) => { cargo.push(directory); },
      flutterClean: async (directory) => { flutter.push(directory); },
      readState: async () => state,
      writeState: async (next) => { state = next; states.push(next); },
      now: () => "2026-08-17T00:00:00.000Z",
    };
    return { ...base, ...overrides, cargo, flutter, states };
  }

  test("skips running tasks before touching a worktree", async () => {
    const harness = deps({ tasks: [task({ sessionStatus: "running", phase: "running" })] });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report).toMatchObject({ ok: true, cleaned: 0, skipped: 1, failed: 0 });
    expect(report.tasks[0]).toMatchObject({ action: "skipped", reason: "task is running" });
    expect(harness.cargo).toEqual([]);
    expect(harness.flutter).toEqual([]);
  });

  test("refuses the primary checkout and does not clean", async () => {
    const harness = deps({ tasks: [task({ worktreePath: "/repo" })] });
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(false);
    expect(report.tasks[0]).toMatchObject({ action: "failed", reason: "refusing to clean project primary checkout /repo" });
    expect(harness.cargo).toEqual([]);
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
    expect(harness.cargo).toEqual([]);
    expect(harness.flutter).toEqual([]);
    expect(harness.states).toEqual([]);
  });

  test("cleans cargo and flutter artifact roots and records last size", async () => {
    const harness = deps();
    const report = await cleanSettledWorktrees(harness, { dryRun: false });
    expect(report.ok).toBe(true);
    expect(harness.cargo).toEqual(["/repo/.t3/worktrees/repo/t3code-task"]);
    expect(harness.flutter).toEqual(["/repo/.t3/worktrees/repo/t3code-task/clients/app"]);
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
    expect(harness.cargo).toEqual([]);
    expect(shouldSkipUnchanged({
      version: 1,
      threads: { "thread-1": { path: "/repo/.t3/worktrees/repo/t3code-task", bytesAfter: 2_000, cleanedAt: "earlier" } },
    }, "thread-1", "/repo/.t3/worktrees/repo/t3code-task", 2_000)).toBe(true);
  });

  test("falls back to tasks.list when the running daemon lacks worktrees.listCleanable", async () => {
    const ops: string[] = [];
    const deps = createDefaultReaperDependencies(async (payload) => {
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
          },
        };
      }
      return { ok: false, error: `unexpected ${String(payload.op)}` };
    });
    const listed = await deps.listCleanableTasks();
    expect(ops).toEqual(["worktrees.listCleanable", "projects.list", "tasks.list"]);
    expect(listed.map((entry) => ({ id: entry.id, workspaceRoot: entry.workspaceRoot }))).toEqual([
      { id: "settled", workspaceRoot: "/repo" },
    ]);
  });
});
