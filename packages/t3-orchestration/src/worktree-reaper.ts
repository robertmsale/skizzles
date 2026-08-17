import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const REAPER_LAUNCH_AGENT_LABEL = "io.github.skizzles.t3-worktree-reaper";
export const ORCHESTRATION_LAUNCH_AGENT_LABEL = "io.github.t3-orchestration.daemon";

const SKIP_DIRECTORY_NAMES = new Set([
  ".git",
  ".dart_tool",
  ".idea",
  ".vscode",
  "node_modules",
  "target",
  "build",
  "Pods",
  ".symlinks",
]);

export type CleanableTask = {
  id: string;
  projectId: string;
  phase: string;
  sessionStatus: string | null;
  latestTurnState: string | null;
  archived: boolean;
  deleted: boolean;
  settled: boolean;
  branch: string | null;
  worktreePath?: string | null;
  workspaceRoot?: string | null;
};

export type GitWorktree = {
  path: string;
  branch: string | null;
  bare: boolean;
};

export type ResolvedWorktree =
  | { ok: true; path: string }
  | { ok: false; reason: string; failClosed: boolean };

export type ReaperAction =
  | "cleaned"
  | "would-clean"
  | "skipped"
  | "unchanged"
  | "failed";

export type ReaperTaskResult = {
  threadId: string;
  action: ReaperAction;
  path?: string;
  bytesBefore?: number;
  bytesAfter?: number;
  bytesFreed?: number;
  reason?: string;
};

export type ReaperState = {
  version: 1;
  threads: Record<string, { path: string; bytesAfter: number; cleanedAt: string }>;
};

export type ReaperReport = {
  ok: boolean;
  dryRun: boolean;
  scanned: number;
  cleaned: number;
  skipped: number;
  failed: number;
  bytesFreed: number;
  tasks: ReaperTaskResult[];
};

export type ReaperDependencies = {
  listCleanableTasks(): Promise<CleanableTask[]>;
  listGitWorktrees(workspaceRoot: string): Promise<GitWorktree[]>;
  realpath(path: string): Promise<string>;
  pathExists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  readDirectoryNames(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  measureBytes(path: string): Promise<number>;
  cargoClean(directory: string): Promise<void>;
  flutterClean(directory: string): Promise<void>;
  readState(): Promise<ReaperState>;
  writeState(state: ReaperState): Promise<void>;
  now(): string;
};

export function parseGitWorktreePorcelain(text: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  const finish = () => {
    if (current) worktrees.push(current);
    current = undefined;
  };
  for (const line of text.split("\n")) {
    if (line === "") {
      finish();
      continue;
    }
    if (line.startsWith("worktree ")) {
      finish();
      current = { path: line.slice("worktree ".length), branch: null, bare: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  finish();
  return worktrees;
}

export function normalizeBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

export function isRunningTask(task: CleanableTask): boolean {
  return task.sessionStatus === "running" || task.latestTurnState === "running" || task.phase === "running";
}

export function isCleanableLifecycle(task: CleanableTask): boolean {
  return !task.deleted && (task.settled === true || task.archived === true);
}

export function resolveRegisteredWorktree(
  task: Pick<CleanableTask, "id" | "branch" | "worktreePath" | "workspaceRoot">,
  worktrees: GitWorktree[],
  resolvedPaths: Map<string, string>,
): ResolvedWorktree {
  if (worktrees.length === 0) return { ok: false, reason: "project has no git worktrees", failClosed: true };
  const primary = worktrees[0];
  if (!primary || primary.bare) return { ok: false, reason: "project primary checkout is missing", failClosed: true };
  const primaryPath = resolvedPaths.get(primary.path);
  if (!primaryPath) return { ok: false, reason: "could not resolve primary checkout", failClosed: true };
  const workspaceRoot = task.workspaceRoot?.trim();
  const workspacePath = workspaceRoot ? resolvedPaths.get(workspaceRoot) : undefined;

  const registered = new Map<string, GitWorktree>();
  for (const worktree of worktrees) {
    const resolved = resolvedPaths.get(worktree.path);
    if (!resolved) continue;
    if (registered.has(resolved) && registered.get(resolved) !== worktree) {
      return { ok: false, reason: `ambiguous registered worktree path ${resolved}`, failClosed: true };
    }
    registered.set(resolved, worktree);
  }

  const claimed = task.worktreePath?.trim();
  if (claimed) {
    const resolvedClaim = resolvedPaths.get(claimed);
    if (!resolvedClaim) return { ok: false, reason: `claimed worktreePath is not resolvable: ${claimed}`, failClosed: true };
    const match = registered.get(resolvedClaim);
    if (!match) return { ok: false, reason: `claimed worktreePath is not a registered git worktree: ${resolvedClaim}`, failClosed: true };
    if (resolvedClaim === primaryPath || resolvedClaim === workspacePath) {
      return { ok: false, reason: `refusing to clean project primary checkout ${resolvedClaim}`, failClosed: true };
    }
    return { ok: true, path: resolvedClaim };
  }

  const branch = normalizeBranch(task.branch);
  if (!branch) return { ok: false, reason: "task has no worktreePath or branch", failClosed: true };
  const matches = worktrees
    .map((worktree) => ({ worktree, path: resolvedPaths.get(worktree.path) }))
    .filter((entry): entry is { worktree: GitWorktree; path: string } => {
      return Boolean(entry.path && normalizeBranch(entry.worktree.branch) === branch && entry.path !== primaryPath && entry.path !== workspacePath);
    });
  if (matches.length === 0) return { ok: false, reason: `no registered worktree matches branch ${branch}`, failClosed: false };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `ambiguous worktree match for branch ${branch}: ${matches.map((entry) => entry.path).join(", ")}`,
      failClosed: true,
    };
  }
  return { ok: true, path: matches[0]!.path };
}

export function shouldSkipUnchanged(state: ReaperState, threadId: string, path: string, currentBytes: number): boolean {
  const previous = state.threads[threadId];
  return Boolean(previous && previous.path === path && previous.bytesAfter === currentBytes);
}

export function isFlutterPubspec(text: string): boolean {
  return /(?:^|\n)flutter:\s*(?:$|\n)/.test(text) || /sdk:\s*flutter/.test(text);
}

export async function discoverArtifactRoots(
  worktree: string,
  deps: Pick<ReaperDependencies, "pathExists" | "isDirectory" | "readDirectoryNames" | "readText">,
): Promise<{ cargo: string[]; flutter: string[] }> {
  const cargo: string[] = [];
  const flutter: string[] = [];
  const queue = [worktree];
  const seen = new Set<string>();
  while (queue.length) {
    const directory = queue.shift()!;
    if (seen.has(directory)) continue;
    seen.add(directory);
    const names = await deps.readDirectoryNames(directory);
    if (names.includes("Cargo.toml") && await deps.isDirectory(join(directory, "target"))) {
      cargo.push(directory);
    }
    if (names.includes("pubspec.yaml") && await deps.isDirectory(join(directory, "build"))) {
      try {
        if (isFlutterPubspec(await deps.readText(join(directory, "pubspec.yaml")))) flutter.push(directory);
      } catch {
        // Unreadable pubspec is not a Flutter app we should clean.
      }
    }
    for (const name of names) {
      if (SKIP_DIRECTORY_NAMES.has(name)) continue;
      const child = join(directory, name);
      if (await deps.isDirectory(child)) queue.push(child);
    }
  }
  return { cargo, flutter };
}

export async function cleanSettledWorktrees(deps: ReaperDependencies, options: { dryRun: boolean }): Promise<ReaperReport> {
  const report: ReaperReport = {
    ok: true,
    dryRun: options.dryRun,
    scanned: 0,
    cleaned: 0,
    skipped: 0,
    failed: 0,
    bytesFreed: 0,
    tasks: [],
  };
  const state = await deps.readState();
  const tasks = await deps.listCleanableTasks();
  report.scanned = tasks.length;
  const worktreesByRoot = new Map<string, GitWorktree[]>();

  const record = (result: ReaperTaskResult) => {
    report.tasks.push(result);
    if (result.action === "cleaned" || result.action === "would-clean") {
      report.cleaned++;
      report.bytesFreed += result.bytesFreed ?? 0;
    } else if (result.action === "failed") {
      report.failed++;
      report.ok = false;
    } else {
      report.skipped++;
    }
  };

  for (const task of tasks) {
    if (!isCleanableLifecycle(task)) {
      record({ threadId: task.id, action: "skipped", reason: "not settled or archived" });
      continue;
    }
    if (isRunningTask(task)) {
      record({ threadId: task.id, action: "skipped", reason: "task is running" });
      continue;
    }
    const workspaceRoot = task.workspaceRoot?.trim();
    if (!workspaceRoot) {
      record({ threadId: task.id, action: "failed", reason: "project workspaceRoot is missing" });
      continue;
    }
    let worktrees = worktreesByRoot.get(workspaceRoot);
    if (!worktrees) {
      try {
        worktrees = await deps.listGitWorktrees(workspaceRoot);
      } catch (error) {
        record({
          threadId: task.id,
          action: "failed",
          reason: `git worktree list failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      worktreesByRoot.set(workspaceRoot, worktrees);
    }
    const resolvedPaths = new Map<string, string>();
    try {
      resolvedPaths.set(workspaceRoot, await deps.realpath(workspaceRoot));
    } catch (error) {
      record({
        threadId: task.id,
        action: "skipped",
        reason: `workspaceRoot is not resolvable: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (task.worktreePath?.trim()) {
      try {
        resolvedPaths.set(task.worktreePath, await deps.realpath(task.worktreePath));
      } catch (error) {
        record({
          threadId: task.id,
          action: "skipped",
          reason: `claimed worktreePath is not resolvable: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }
    for (const worktree of worktrees) {
      try {
        resolvedPaths.set(worktree.path, await deps.realpath(worktree.path));
      } catch {
        // Stale git worktree entries must not fail a settled task that still has a live path.
      }
    }
    const resolved = resolveRegisteredWorktree(task, worktrees, resolvedPaths);
    if (!resolved.ok) {
      record({
        threadId: task.id,
        action: resolved.failClosed ? "failed" : "skipped",
        reason: resolved.reason,
      });
      continue;
    }
    const artifactRoots = await discoverArtifactRoots(resolved.path, deps);
    const artifactDirs = [
      ...artifactRoots.cargo.map((directory) => join(directory, "target")),
      ...artifactRoots.flutter.map((directory) => join(directory, "build")),
    ];
    let bytesBefore = 0;
    for (const directory of artifactDirs) bytesBefore += await deps.measureBytes(directory);
    if (artifactDirs.length === 0 || bytesBefore === 0) {
      if (!options.dryRun) {
        state.threads[task.id] = { path: resolved.path, bytesAfter: 0, cleanedAt: deps.now() };
      }
      record({
        threadId: task.id,
        action: "unchanged",
        path: resolved.path,
        bytesBefore: 0,
        bytesAfter: 0,
        bytesFreed: 0,
        reason: "no cargo/flutter artifacts",
      });
      continue;
    }
    if (shouldSkipUnchanged(state, task.id, resolved.path, bytesBefore)) {
      record({
        threadId: task.id,
        action: "unchanged",
        path: resolved.path,
        bytesBefore,
        bytesAfter: bytesBefore,
        bytesFreed: 0,
        reason: "already cleaned at recorded size",
      });
      continue;
    }
    if (options.dryRun) {
      record({
        threadId: task.id,
        action: "would-clean",
        path: resolved.path,
        bytesBefore,
        bytesAfter: 0,
        bytesFreed: bytesBefore,
      });
      continue;
    }
    try {
      for (const directory of artifactRoots.cargo) await deps.cargoClean(directory);
      for (const directory of artifactRoots.flutter) await deps.flutterClean(directory);
    } catch (error) {
      record({
        threadId: task.id,
        action: "failed",
        path: resolved.path,
        bytesBefore,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    let bytesAfter = 0;
    for (const directory of artifactDirs) {
      if (await deps.pathExists(directory)) bytesAfter += await deps.measureBytes(directory);
    }
    const bytesFreed = Math.max(0, bytesBefore - bytesAfter);
    state.threads[task.id] = { path: resolved.path, bytesAfter, cleanedAt: deps.now() };
    record({
      threadId: task.id,
      action: "cleaned",
      path: resolved.path,
      bytesBefore,
      bytesAfter,
      bytesFreed,
    });
  }

  if (!options.dryRun) await deps.writeState(state);
  return report;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

async function optionalRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissing(error)) throw new Error(`path does not exist: ${path}`);
    throw error;
  }
}

async function directorySize(path: string): Promise<number> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return 0;
    if (metadata.isFile()) return metadata.size;
    if (!metadata.isDirectory()) return 0;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) {
      try {
        total += (await lstat(child)).size;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
  return total;
}

async function runCleanCommand(command: string, directory: string): Promise<void> {
  const result = await Bun.$`${command} clean`.cwd(directory).nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`${command} clean failed in ${directory}: ${result.stderr.toString().trim() || result.stdout.toString().trim() || `exit ${result.exitCode}`}`);
  }
}

export function defaultStatePath(home = process.env.HOME || homedir()): string {
  const t3Home = resolve(process.env.T3_HOME?.trim() || join(home, ".t3"));
  return join(t3Home, "worktree-reaper-state.json");
}

export async function readReaperState(path = defaultStatePath()): Promise<ReaperState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ReaperState;
    if (parsed.version !== 1 || !parsed.threads || typeof parsed.threads !== "object") {
      throw new Error(`Unsupported worktree reaper state at ${path}`);
    }
    return parsed;
  } catch (error) {
    if (isMissing(error)) return { version: 1, threads: {} };
    throw error;
  }
}

export async function writeReaperState(state: ReaperState, path = defaultStatePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function isUnknownOperationError(error: string | undefined): boolean {
  return Boolean(error && error.startsWith("Unknown operation:"));
}

export function createDefaultReaperDependencies(
  request: (payload: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>,
): ReaperDependencies {
  const listFromTasks = async (): Promise<CleanableTask[]> => {
    const projectsResponse = await request({ op: "projects.list" });
    if (!projectsResponse.ok) throw new Error(projectsResponse.error ?? "projects.list failed");
    const projects = (projectsResponse.result as { projects?: Array<{ id: string; workspaceRoot: string }> }).projects ?? [];
    const roots = new Map(projects.map((project) => [project.id, project.workspaceRoot]));
    const seen = new Set<string>();
    const tasks: CleanableTask[] = [];
    const projectIds = projects.length ? projects.map((project) => project.id) : [undefined];
    for (const projectId of projectIds) {
      const response = await request({
        op: "tasks.list",
        limit: 200,
        includeSettled: true,
        includeArchived: true,
        ...(projectId ? { projectId } : {}),
      });
      if (!response.ok) throw new Error(response.error ?? "tasks.list failed");
      const listed = (response.result as { tasks?: CleanableTask[] }).tasks ?? [];
      for (const task of listed) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        tasks.push({
          ...task,
          workspaceRoot: task.workspaceRoot ?? roots.get(task.projectId) ?? null,
        });
      }
    }
    return tasks.filter((task) => isCleanableLifecycle(task));
  };

  return {
    async listCleanableTasks() {
      const dedicated = await request({ op: "worktrees.listCleanable" });
      if (dedicated.ok) {
        return ((dedicated.result as { tasks?: CleanableTask[] }).tasks ?? []).filter((task) => isCleanableLifecycle(task));
      }
      if (!isUnknownOperationError(dedicated.error)) {
        throw new Error(dedicated.error ?? "worktrees.listCleanable failed");
      }
      return listFromTasks();
    },
    async listGitWorktrees(workspaceRoot) {
      const result = await Bun.$`git -C ${workspaceRoot} worktree list --porcelain`.nothrow().quiet();
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString().trim() || `git worktree list failed in ${workspaceRoot}`);
      }
      return parseGitWorktreePorcelain(result.text());
    },
    realpath: optionalRealpath,
    async pathExists(path) {
      try {
        await lstat(path);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async isDirectory(path) {
      try {
        const metadata = await lstat(path);
        return metadata.isDirectory() && !metadata.isSymbolicLink();
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async readDirectoryNames(path) {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.filter((entry) => !entry.isSymbolicLink()).map((entry) => entry.name);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },
    readText: (path) => readFile(path, "utf8"),
    measureBytes: directorySize,
    cargoClean: (directory) => runCleanCommand("cargo", directory),
    flutterClean: (directory) => runCleanCommand("flutter", directory),
    readState: readReaperState,
    writeState: writeReaperState,
    now: () => new Date().toISOString(),
  };
}

export function formatReaperLogs(report: ReaperReport): Array<Record<string, unknown>> {
  return report.tasks.map((task) => ({
    threadId: task.threadId,
    path: task.path ?? null,
    action: task.action,
    bytesFreed: task.bytesFreed ?? 0,
    ...(task.reason ? { reason: task.reason } : {}),
  }));
}
