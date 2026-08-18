import { spawn } from "node:child_process";
import { lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  assertAllowedCleanCommand,
  defaultReaperConfig,
  isDeniedPath,
  matchesAnyGlob,
  relativeInside,
  resolveDenyPaths,
  resolveProjectPolicy,
  type CleanStrategy,
  type ReaperConfig,
} from "./worktree-reaper-config.ts";
import type { OccupiedWorktree } from "./task-projection.ts";
import {
  holdExclusiveCleanLease,
  inspectPathIdentity,
  type CleanLease,
  type LockIdentity,
} from "./worktree-reaper-lease.ts";

export type { OccupiedWorktree, CleanLease };

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
  projectTitle?: string | null;
  phase: string;
  sessionStatus: string | null;
  latestTurnState: string | null;
  backgroundLiveness?: "working" | "monitoring" | "unknown" | null;
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
  configPath: string | null;
  scanned: number;
  cleaned: number;
  skipped: number;
  failed: number;
  bytesFreed: number;
  tasks: ReaperTaskResult[];
};

export type CleanableTaskListing = {
  tasks: CleanableTask[];
  truncated: boolean;
  occupied: OccupiedWorktree[];
};

export type ReaperDependencies = {
  listCleanableTasks(): Promise<CleanableTaskListing>;
  readTask(threadId: string): Promise<CleanableTask>;
  listGitWorktrees(workspaceRoot: string): Promise<GitWorktree[]>;
  realpath(path: string): Promise<string>;
  pathExists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  readDirectoryNames(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  measureBytes(path: string): Promise<number>;
  statIdentity(path: string): Promise<LockIdentity | undefined>;
  runClean(command: string[], directory: string, signal?: AbortSignal, binding?: CleanIdentityBinding): Promise<void>;
  holdCleanLease(task: CleanableTask, path: string): Promise<CleanLease>;
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
  return task.sessionStatus === "running" || task.sessionStatus === "starting"
    || task.latestTurnState === "running"
    || task.phase === "running" || task.phase === "starting"
    || task.backgroundLiveness === "working" || task.backgroundLiveness === "monitoring";
}

export function isLivenessUnavailable(task: CleanableTask): boolean {
  return task.backgroundLiveness !== null
    && task.backgroundLiveness !== "working"
    && task.backgroundLiveness !== "monitoring";
}

export function isCleanableLifecycle(task: CleanableTask): boolean {
  return !task.deleted && (task.settled === true || task.archived === true);
}

export function taskTargetIdentityChanged(before: CleanableTask, after: CleanableTask): boolean {
  return before.projectId !== after.projectId
    || (before.workspaceRoot ?? "") !== (after.workspaceRoot ?? "")
    || (before.worktreePath ?? "") !== (after.worktreePath ?? "")
    || (before.branch ?? "") !== (after.branch ?? "");
}

export function otherTaskOccupyingPath(
  taskId: string,
  path: string,
  occupied: OccupiedWorktree[],
): OccupiedWorktree | undefined {
  return occupied.find((entry) => entry.id !== taskId && entry.path === path);
}

export async function resolveOccupiedWorktrees(
  occupied: OccupiedWorktree[],
  realpathFn: (path: string) => Promise<string>,
): Promise<OccupiedWorktree[]> {
  const resolved: OccupiedWorktree[] = [];
  const seen = new Set<string>();
  const add = (id: string, path: string) => {
    const key = `${id}\0${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    resolved.push({ id, path });
  };
  for (const entry of occupied) {
    const id = entry.id?.trim();
    const raw = entry.path?.trim();
    if (!id || !raw) continue;
    add(id, raw);
    try {
      add(id, await realpathFn(raw));
    } catch {
      // Keep the unresolved claim so a matching raw path still fails closed.
    }
  }
  return resolved;
}

export function resolveRegisteredWorktree(
  task: Pick<CleanableTask, "id" | "branch" | "worktreePath" | "workspaceRoot">,
  worktrees: GitWorktree[],
  resolvedPaths: Map<string, string>,
  occupied: Array<{ id: string; path: string }> = [],
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
    const taskBranch = normalizeBranch(task.branch);
    const claimedBranch = normalizeBranch(match.branch);
    if (!taskBranch || !claimedBranch || taskBranch !== claimedBranch) {
      return {
        ok: false,
        reason: `claimed worktreePath branch ${claimedBranch ?? "(none)"} does not match task branch ${taskBranch ?? "(none)"}`,
        failClosed: true,
      };
    }
    const owner = otherTaskOccupyingPath(task.id, resolvedClaim, occupied);
    if (owner) {
      return { ok: false, reason: `worktree ${resolvedClaim} is owned by another task ${owner.id}`, failClosed: true };
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
  const matchedPath = matches[0]!.path;
  const owner = otherTaskOccupyingPath(task.id, matchedPath, occupied);
  if (owner) {
    return { ok: false, reason: `worktree ${matchedPath} is owned by another task ${owner.id}`, failClosed: true };
  }
  return { ok: true, path: matchedPath };
}

export function shouldSkipUnchanged(state: ReaperState, threadId: string, path: string, currentBytes: number): boolean {
  const previous = state.threads[threadId];
  return Boolean(previous && previous.path === path && previous.bytesAfter === currentBytes);
}

export function isFlutterPubspec(text: string): boolean {
  return /(?:^|\n)flutter:\s*(?:$|\n)/.test(text) || /sdk:\s*flutter/.test(text);
}

export type CleanTarget = {
  strategy: string;
  directory: string;
  artifactDir: string;
  artifactName: string;
  command: string[];
};

export type CleanIdentityBinding = {
  directoryIdentity: LockIdentity;
  artifactDir: string;
  artifactName: string;
  artifactIdentity: LockIdentity;
};

export function sameFsIdentity(left: LockIdentity | undefined, right: LockIdentity | undefined): boolean {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

async function walkDirectories(
  worktree: string,
  deps: Pick<ReaperDependencies, "isDirectory" | "readDirectoryNames">,
): Promise<string[]> {
  const directories = [worktree];
  const queue = [worktree];
  const seen = new Set<string>([worktree]);
  while (queue.length) {
    const directory = queue.shift()!;
    for (const name of await deps.readDirectoryNames(directory)) {
      if (SKIP_DIRECTORY_NAMES.has(name)) continue;
      const child = join(directory, name);
      if (seen.has(child) || !await deps.isDirectory(child)) continue;
      seen.add(child);
      directories.push(child);
      queue.push(child);
    }
  }
  return directories;
}

async function strategyMatchesDirectory(
  strategy: CleanStrategy,
  worktree: string,
  directory: string,
  names: string[],
  deps: Pick<ReaperDependencies, "isDirectory" | "readText">,
): Promise<boolean> {
  const relative = relativeInside(worktree, directory);
  if (relative === undefined) return false;
  if (!matchesAnyGlob(relative, strategy.match)) return false;
  if (!strategy.markers.every((marker) => names.includes(marker))) return false;
  if (!await deps.isDirectory(join(directory, strategy.artifactDir))) return false;
  if (!strategy.requireText) return true;
  try {
    return new RegExp(strategy.requireText.pattern).test(await deps.readText(join(directory, strategy.requireText.file)));
  } catch {
    return false;
  }
}

export async function discoverCleanTargets(
  worktree: string,
  strategies: CleanStrategy[],
  deps: Pick<ReaperDependencies, "isDirectory" | "readDirectoryNames" | "readText">,
): Promise<CleanTarget[]> {
  const targets: CleanTarget[] = [];
  for (const directory of await walkDirectories(worktree, deps)) {
    const names = await deps.readDirectoryNames(directory);
    for (const strategy of strategies) {
      if (!await strategyMatchesDirectory(strategy, worktree, directory, names, deps)) continue;
      targets.push({
        strategy: strategy.name,
        directory,
        artifactDir: join(directory, strategy.artifactDir),
        artifactName: strategy.artifactDir,
        command: strategy.command,
      });
    }
  }
  return targets;
}

type IdentifiedCleanTarget = CleanTarget & {
  directoryIdentity: LockIdentity;
  artifactIdentity: LockIdentity;
};

type CleanPlan =
  | { ok: true; path: string; pathIdentity: LockIdentity; targets: IdentifiedCleanTarget[]; artifactDirs: string[]; bytesBefore: number }
  | { ok: false; action: ReaperAction; reason: string; path?: string };

async function planClean(
  task: CleanableTask,
  config: ReaperConfig,
  deps: ReaperDependencies,
  worktreesByRoot: Map<string, GitWorktree[]>,
  occupied: OccupiedWorktree[],
): Promise<CleanPlan> {
  const policy = resolveProjectPolicy(task, config);
  if (!policy.enabled) return { ok: false, action: "skipped", reason: policy.reason ?? "project disabled by host config" };
  const workspaceRoot = task.workspaceRoot?.trim();
  if (!workspaceRoot) return { ok: false, action: "failed", reason: "project workspaceRoot is missing" };
  let worktrees = worktreesByRoot.get(workspaceRoot);
  if (!worktrees) {
    try {
      worktrees = await deps.listGitWorktrees(workspaceRoot);
    } catch (error) {
      return { ok: false, action: "failed", reason: `git worktree list failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    worktreesByRoot.set(workspaceRoot, worktrees);
  }
  const resolvedPaths = new Map<string, string>();
  try {
    resolvedPaths.set(workspaceRoot, await deps.realpath(workspaceRoot));
  } catch (error) {
    return { ok: false, action: "skipped", reason: `workspaceRoot is not resolvable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (task.worktreePath?.trim()) {
    try {
      resolvedPaths.set(task.worktreePath, await deps.realpath(task.worktreePath));
    } catch (error) {
      return { ok: false, action: "skipped", reason: `claimed worktreePath is not resolvable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  for (const worktree of worktrees) {
    try {
      resolvedPaths.set(worktree.path, await deps.realpath(worktree.path));
    } catch {
      // Stale git worktree entries must not fail a settled task that still has a live path.
    }
  }
  const resolved = resolveRegisteredWorktree(task, worktrees, resolvedPaths, occupied);
  if (!resolved.ok) return { ok: false, action: resolved.failClosed ? "failed" : "skipped", reason: resolved.reason };
  const denyPaths = await resolveDenyPaths(policy.denyPaths, resolved.path, deps.realpath);
  if (isDeniedPath(resolved.path, denyPaths)) {
    return { ok: false, action: "skipped", path: resolved.path, reason: "worktree is denied by host config" };
  }
  const targets = (await discoverCleanTargets(resolved.path, policy.strategies, deps))
    .filter((target) => !isDeniedPath(target.directory, denyPaths) && !isDeniedPath(target.artifactDir, denyPaths));
  try {
    for (const target of targets) assertAllowedCleanCommand(target.command, target.artifactName);
  } catch (error) {
    return { ok: false, action: "failed", path: resolved.path, reason: error instanceof Error ? error.message : String(error) };
  }
  const pathIdentity = await deps.statIdentity(resolved.path);
  if (!pathIdentity) {
    return { ok: false, action: "failed", path: resolved.path, reason: "could not identify registered worktree inode" };
  }
  const identified: IdentifiedCleanTarget[] = [];
  for (const target of targets) {
    const directoryIdentity = await deps.statIdentity(target.directory);
    if (!directoryIdentity) {
      return { ok: false, action: "failed", path: resolved.path, reason: `could not identify clean directory inode ${target.directory}` };
    }
    const artifactIdentity = await deps.statIdentity(target.artifactDir);
    if (!artifactIdentity) {
      return { ok: false, action: "failed", path: resolved.path, reason: `could not identify artifact directory inode ${target.artifactDir}` };
    }
    identified.push({ ...target, directoryIdentity, artifactIdentity });
  }
  const artifactDirs = identified.map((target) => target.artifactDir);
  let bytesBefore = 0;
  for (const directory of artifactDirs) bytesBefore += await deps.measureBytes(directory);
  return { ok: true, path: resolved.path, pathIdentity, targets: identified, artifactDirs, bytesBefore };
}

async function assertPlanIdentities(
  plan: Extract<CleanPlan, { ok: true }>,
  deps: ReaperDependencies,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pathIdentity = await deps.statIdentity(plan.path);
  if (!sameFsIdentity(pathIdentity, plan.pathIdentity)) {
    return { ok: false, reason: `worktree ${plan.path} was replaced after planning` };
  }
  for (const target of plan.targets) {
    const directoryIdentity = await deps.statIdentity(target.directory);
    if (!sameFsIdentity(directoryIdentity, target.directoryIdentity)) {
      return { ok: false, reason: `clean directory ${target.directory} was replaced after planning` };
    }
    const artifactIdentity = await deps.statIdentity(target.artifactDir);
    if (!sameFsIdentity(artifactIdentity, target.artifactIdentity)) {
      return { ok: false, reason: `artifact directory ${target.artifactDir} was replaced after planning` };
    }
  }
  return { ok: true };
}

export async function cleanSettledWorktrees(deps: ReaperDependencies, options: {
  dryRun: boolean;
  config?: ReaperConfig;
  configPath?: string | null;
}): Promise<ReaperReport> {
  const config = options.config ?? defaultReaperConfig();
  const report: ReaperReport = {
    ok: true,
    dryRun: options.dryRun,
    configPath: options.configPath ?? null,
    scanned: 0,
    cleaned: 0,
    skipped: 0,
    failed: 0,
    bytesFreed: 0,
    tasks: [],
  };
  if (!config.enabled) {
    return report;
  }
  const state = await deps.readState();
  let listing: CleanableTaskListing;
  try {
    listing = await deps.listCleanableTasks();
    if (typeof listing.truncated !== "boolean") {
      throw new Error("cleanable-task listing omitted or malformed truncated; refusing incomplete cleanup");
    }
    listing = { ...listing, occupied: parseOccupiedWorktrees(listing.occupied) };
  } catch (error) {
    report.ok = false;
    report.failed = 1;
    report.tasks.push({
      threadId: "enumeration",
      action: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
    return report;
  }
  report.scanned = listing.tasks.length;
  if (listing.truncated) {
    report.ok = false;
    report.failed = 1;
    report.tasks.push({
      threadId: "enumeration",
      action: "failed",
      reason: `cleanable-task enumeration truncated at ${listing.tasks.length}; refusing incomplete cleanup`,
    });
    return report;
  }
  const tasks = listing.tasks;
  let occupied = await resolveOccupiedWorktrees(listing.occupied, deps.realpath);
  const worktreesByRoot = new Map<string, GitWorktree[]>();

  const refreshOccupancy = async (
    task: CleanableTask,
    path: string,
  ): Promise<{ ok: true; occupied: OccupiedWorktree[] } | { ok: false; action: ReaperAction; path: string; reason: string }> => {
    let fresh: CleanableTaskListing;
    try {
      fresh = await deps.listCleanableTasks();
      if (typeof fresh.truncated !== "boolean") {
        throw new Error("cleanable-task listing omitted or malformed truncated; refusing incomplete cleanup");
      }
      fresh = { ...fresh, occupied: parseOccupiedWorktrees(fresh.occupied) };
    } catch (error) {
      return {
        ok: false,
        action: "failed",
        path,
        reason: `could not revalidate occupancy: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (fresh.truncated) {
      return {
        ok: false,
        action: "failed",
        path,
        reason: `cleanable-task enumeration truncated at ${fresh.tasks.length}; refusing incomplete cleanup`,
      };
    }
    const nextOccupied = await resolveOccupiedWorktrees(fresh.occupied, deps.realpath);
    const freshTask = fresh.tasks.find((entry) => entry.id === task.id);
    if (!freshTask) {
      return { ok: false, action: "failed", path, reason: "task is no longer listed as cleanable" };
    }
    if (!isCleanableLifecycle(freshTask)) {
      return { ok: false, action: "skipped", path, reason: "not settled or archived" };
    }
    if (isRunningTask(freshTask) || isLivenessUnavailable(freshTask)) {
      return {
        ok: false,
        action: "skipped",
        path,
        reason: isLivenessUnavailable(freshTask) ? "liveness unavailable" : "task is running",
      };
    }
    if (taskTargetIdentityChanged(task, freshTask)) {
      return { ok: false, action: "failed", path, reason: "task identity changed during occupancy refresh" };
    }
    const owner = otherTaskOccupyingPath(task.id, path, nextOccupied);
    if (owner) {
      return { ok: false, action: "failed", path, reason: `worktree ${path} is owned by another task ${owner.id}` };
    }
    return { ok: true, occupied: nextOccupied };
  };

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
    if (isRunningTask(task) || isLivenessUnavailable(task)) {
      record({
        threadId: task.id,
        action: "skipped",
        reason: isLivenessUnavailable(task) ? "liveness unavailable" : "task is running",
      });
      continue;
    }
    let plan = await planClean(task, config, deps, worktreesByRoot, occupied);
    if (!plan.ok) {
      record({ threadId: task.id, action: plan.action, path: plan.path, reason: plan.reason });
      continue;
    }
    if (plan.targets.length === 0 || plan.bytesBefore === 0) {
      if (!options.dryRun) {
        state.threads[task.id] = { path: plan.path, bytesAfter: 0, cleanedAt: deps.now() };
      }
      record({
        threadId: task.id,
        action: "unchanged",
        path: plan.path,
        bytesBefore: 0,
        bytesAfter: 0,
        bytesFreed: 0,
        reason: "no matching artifacts",
      });
      continue;
    }
    if (shouldSkipUnchanged(state, task.id, plan.path, plan.bytesBefore)) {
      record({
        threadId: task.id,
        action: "unchanged",
        path: plan.path,
        bytesBefore: plan.bytesBefore,
        bytesAfter: plan.bytesBefore,
        bytesFreed: 0,
        reason: "already cleaned at recorded size",
      });
      continue;
    }
    let current = task;
    try {
      current = await deps.readTask(task.id);
    } catch (error) {
      record({
        threadId: task.id,
        action: "failed",
        path: plan.path,
        reason: `could not revalidate task: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (isRunningTask(current) || isLivenessUnavailable(current)) {
      record({
        threadId: task.id,
        action: "skipped",
        path: plan.path,
        reason: isLivenessUnavailable(current) ? "liveness unavailable" : "task is running",
      });
      continue;
    }
    if (!isCleanableLifecycle(current)) {
      record({ threadId: task.id, action: "skipped", path: plan.path, reason: "not settled or archived" });
      continue;
    }
    if (taskTargetIdentityChanged(task, current)) {
      plan = await planClean(current, config, deps, worktreesByRoot, occupied);
      if (!plan.ok) {
        record({ threadId: task.id, action: "failed", path: plan.path, reason: `task identity changed: ${plan.reason}` });
        continue;
      }
      if (plan.targets.length === 0 || plan.bytesBefore === 0) {
        record({
          threadId: task.id,
          action: "unchanged",
          path: plan.path,
          bytesBefore: 0,
          bytesAfter: 0,
          bytesFreed: 0,
          reason: "no matching artifacts",
        });
        continue;
      }
    }
    let lease: CleanLease;
    try {
      lease = await deps.holdCleanLease(current, plan.path);
    } catch (error) {
      record({
        threadId: task.id,
        action: "failed",
        path: plan.path,
        reason: `could not acquire clean lease: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    try {
      if (lease.signal.aborted) {
        record({ threadId: task.id, action: "failed", path: plan.path, reason: "task resumed during clean lease" });
        continue;
      }
      const refreshed = await refreshOccupancy(current, plan.path);
      if (!refreshed.ok) {
        record({
          threadId: task.id,
          action: "failed",
          path: refreshed.path ?? plan.path,
          reason: refreshed.reason,
        });
        continue;
      }
      if (lease.signal.aborted) {
        record({ threadId: task.id, action: "failed", path: plan.path, reason: "task resumed during clean lease" });
        continue;
      }
      occupied = refreshed.occupied;
      const bound = await assertPlanIdentities(plan, deps);
      if (!bound.ok) {
        record({ threadId: task.id, action: "failed", path: plan.path, reason: bound.reason });
        continue;
      }
      if (options.dryRun) {
        record({
          threadId: task.id,
          action: "would-clean",
          path: plan.path,
          bytesBefore: plan.bytesBefore,
          bytesAfter: 0,
          bytesFreed: plan.bytesBefore,
        });
        continue;
      }
      let aborted:
        | { ok: false; action: ReaperAction; path: string; reason: string }
        | undefined;
      try {
        for (const target of plan.targets) {
          if (lease.signal.aborted) {
            aborted = { ok: false, action: "failed", path: plan.path, reason: "task resumed during clean lease" };
            break;
          }
          const stillBound = await assertPlanIdentities(plan, deps);
          if (!stillBound.ok) {
            aborted = { ok: false, action: "failed", path: plan.path, reason: stillBound.reason };
            break;
          }
          await deps.runClean(target.command, target.directory, lease.signal, {
            directoryIdentity: target.directoryIdentity,
            artifactDir: target.artifactDir,
            artifactName: target.artifactName,
            artifactIdentity: target.artifactIdentity,
          });
        }
      } catch (error) {
        record({
          threadId: task.id,
          action: "failed",
          path: plan.path,
          bytesBefore: plan.bytesBefore,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (aborted) {
        record({ threadId: task.id, action: aborted.action, path: aborted.path, reason: aborted.reason });
        continue;
      }
      if (lease.signal.aborted) {
        record({ threadId: task.id, action: "failed", path: plan.path, reason: "task resumed during clean lease" });
        continue;
      }
      try {
        const after = await deps.readTask(current.id);
        if (isRunningTask(after) || isLivenessUnavailable(after) || !isCleanableLifecycle(after) || taskTargetIdentityChanged(current, after)) {
          record({
            threadId: task.id,
            action: "failed",
            path: plan.path,
            reason: "task resumed during cleanup",
          });
          continue;
        }
      } catch (error) {
        record({
          threadId: task.id,
          action: "failed",
          path: plan.path,
          reason: `could not confirm task after cleanup: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      let bytesAfter = 0;
      for (const directory of plan.artifactDirs) {
        if (await deps.pathExists(directory)) bytesAfter += await deps.measureBytes(directory);
      }
      const bytesFreed = Math.max(0, plan.bytesBefore - bytesAfter);
      state.threads[task.id] = { path: plan.path, bytesAfter, cleanedAt: deps.now() };
      record({
        threadId: task.id,
        action: "cleaned",
        path: plan.path,
        bytesBefore: plan.bytesBefore,
        bytesAfter,
        bytesFreed,
      });
    } finally {
      await lease.release();
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseOccupiedWorktrees(value: unknown): OccupiedWorktree[] {
  if (!Array.isArray(value)) {
    throw new Error("worktrees.listCleanable omitted occupied; refusing mixed-version occupancy");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`worktrees.listCleanable occupied[${index}] is malformed`);
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const path = typeof entry.path === "string" ? entry.path.trim() : "";
    if (!id || !path) throw new Error(`worktrees.listCleanable occupied[${index}] is malformed`);
    return { id, path };
  });
}

export function parseListCleanableResult(result: unknown): CleanableTaskListing {
  if (!isRecord(result)) throw new Error("worktrees.listCleanable result is malformed");
  if (typeof result.truncated !== "boolean") {
    throw new Error("worktrees.listCleanable omitted or malformed truncated; refusing incomplete cleanup");
  }
  if (!Array.isArray(result.tasks)) throw new Error("worktrees.listCleanable omitted tasks");
  return {
    tasks: (result.tasks as CleanableTask[]).filter((task) => isCleanableLifecycle(task)),
    truncated: result.truncated,
    occupied: parseOccupiedWorktrees(result.occupied),
  };
}

export function taskListEnumerationTruncated(moreRecent: unknown): boolean {
  return !Number.isInteger(moreRecent) || (moreRecent as number) < 0 || (moreRecent as number) > 0;
}

const IDENTITY_BOUND_CLEAN_EVAL = `
const spec = JSON.parse(process.env.T3_REAPER_CLEAN_SPEC ?? "null");
if (!spec || !Array.isArray(spec.command) || spec.command.length === 0) {
  process.stderr.write("clean refused: missing identity-bound launch spec\\n");
  process.exit(76);
}
const { fstatSync, lstatSync, readdirSync } = await import("node:fs");
const { lstat, writeFile } = await import("node:fs/promises");
const { dlopen, ptr } = await import("bun:ffi");
const sameIdentity = (info, dev, ino) => info && BigInt(info.dev) === BigInt(dev) && BigInt(info.ino) === BigInt(ino);
const cwd = await lstat(".", { bigint: true });
if (!sameIdentity(cwd, spec.directoryDev, spec.directoryIno)) {
  process.stderr.write("clean directory was replaced after planning\\n");
  process.exit(77);
}
let artifact;
let directory;
try {
  artifact = fstatSync(3, { bigint: true });
  directory = fstatSync(4, { bigint: true });
} catch {
  process.stderr.write("artifact directory was replaced after planning\\n");
  process.exit(78);
}
if (!artifact.isDirectory() || !sameIdentity(artifact, spec.artifactDev, spec.artifactIno)) {
  process.stderr.write("artifact directory was replaced after planning\\n");
  process.exit(78);
}
if (!directory.isDirectory() || !sameIdentity(directory, spec.directoryDev, spec.directoryIno)) {
  process.stderr.write("clean directory was replaced after planning\\n");
  process.exit(77);
}
if (spec.hookReadyPath && spec.hookDonePath) {
  await writeFile(spec.hookReadyPath, "ready\\n");
  const deadline = Date.now() + 5000;
  const { access } = await import("node:fs/promises");
  while (Date.now() < deadline) {
    try { await access(spec.hookDonePath); break; } catch { await Bun.sleep(5); }
  }
}
const libName = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
const libc = dlopen(libName, {
  fchdir: { args: ["i32"], returns: "i32" },
  execvp: { args: ["ptr", "ptr"], returns: "i32" },
});
const bindFd = spec.command[0] === "flutter" ? 4 : 3;
if (libc.symbols.fchdir(bindFd) !== 0) {
  process.stderr.write("could not bind cleaner to approved inode\\n");
  process.exit(78);
}
const stillArtifact = fstatSync(3, { bigint: true });
const stillDirectory = fstatSync(4, { bigint: true });
if (!sameIdentity(stillArtifact, spec.artifactDev, spec.artifactIno)) {
  process.stderr.write("artifact directory was replaced after planning\\n");
  process.exit(78);
}
if (!sameIdentity(stillDirectory, spec.directoryDev, spec.directoryIno)) {
  process.stderr.write("clean directory was replaced after planning\\n");
  process.exit(77);
}
if (spec.command[0] === "flutter") {
  const named = lstatSync(spec.artifactName, { bigint: true });
  if (!named.isDirectory() || !sameIdentity(named, spec.artifactDev, spec.artifactIno)) {
    process.stderr.write("artifact directory was replaced after planning\\n");
    process.exit(78);
  }
}
const argv = spec.command[0] === "cargo"
  ? ["cargo", "clean", "--target-dir", "."]
  : spec.command[0] === "rm"
    ? (() => {
      const flags = spec.command.slice(1, -1);
      const names = readdirSync(".").filter((name) => name !== "." && name !== "..");
      return ["rm", ...flags, ...(names.length > 0 ? names : ["--"])];
    })()
    : spec.command;
const bins = argv.map((value) => Buffer.from(String(value) + "\\0"));
const argvPtrs = new BigUint64Array(bins.length + 1);
for (let i = 0; i < bins.length; i++) argvPtrs[i] = BigInt(ptr(bins[i]));
argvPtrs[bins.length] = 0n;
libc.symbols.execvp(ptr(bins[0]), ptr(argvPtrs));
process.stderr.write("could not execute " + argv[0] + "\\n");
process.exit(127);
`;

export async function runIdentityBoundClean(
  command: string[],
  directory: string,
  binding: CleanIdentityBinding,
  signal?: AbortSignal,
  hooks: { afterParentBound?: () => Promise<void>; afterArtifactBound?: () => Promise<void> } = {},
): Promise<void> {
  if (signal?.aborted) throw new Error("clean aborted: task resumed");
  if (!binding.artifactName.trim()) {
    throw new Error("clean refused: missing artifact identity binding");
  }
  const directoryHandle = await open(directory, "r");
  try {
    const directoryStat = await directoryHandle.stat({ bigint: true });
    const directoryIdentity = { dev: directoryStat.dev, ino: directoryStat.ino };
    if (!sameFsIdentity(directoryIdentity, binding.directoryIdentity)) {
      throw new Error(`clean directory ${directory} was replaced after planning`);
    }
    const artifactHandle = await open(binding.artifactDir, "r");
    try {
      const artifactStat = await artifactHandle.stat({ bigint: true });
      const artifactIdentity = { dev: artifactStat.dev, ino: artifactStat.ino };
      if (!sameFsIdentity(artifactIdentity, binding.artifactIdentity)) {
        throw new Error(`artifact directory ${binding.artifactDir} was replaced after planning`);
      }
      if (hooks.afterParentBound) await hooks.afterParentBound();
      if (signal?.aborted) throw new Error("clean aborted: task resumed");
      const hookRoot = hooks.afterArtifactBound
        ? join(directory, `.t3-reaper-hook-${process.pid}-${crypto.randomUUID()}`)
        : "";
      if (hookRoot) await mkdir(hookRoot, { recursive: true, mode: 0o700 });
      const hookReadyPath = hookRoot ? join(hookRoot, "ready") : "";
      const hookDonePath = hookRoot ? join(hookRoot, "done") : "";
      const env = { ...Bun.env };
      if (command[0] === "cargo") delete env.CARGO_TARGET_DIR;
      env.T3_REAPER_CLEAN_SPEC = JSON.stringify({
        command,
        artifactName: binding.artifactName,
        hookReadyPath,
        hookDonePath,
        directoryDev: String(binding.directoryIdentity.dev),
        directoryIno: String(binding.directoryIdentity.ino),
        artifactDev: String(binding.artifactIdentity.dev),
        artifactIno: String(binding.artifactIdentity.ino),
      });
      const child = spawn(process.execPath, ["--eval", IDENTITY_BOUND_CLEAN_EVAL], {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "pipe", artifactHandle.fd, directoryHandle.fd],
      });
      const abort = () => {
        try { child.kill(); } catch { /* already exited */ }
      };
      signal?.addEventListener("abort", abort, { once: true });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      const exited = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      try {
        if (hooks.afterArtifactBound && hookReadyPath && hookDonePath) {
          const ready = await Promise.race([
            (async () => {
              const started = Date.now();
              while (!(await Bun.file(hookReadyPath).exists())) {
                if (Date.now() - started > 5_000) return false;
                await Bun.sleep(5);
              }
              return true;
            })(),
            exited.then(() => false),
          ]);
          if (ready) {
            await hooks.afterArtifactBound();
            await writeFile(hookDonePath, "done\n");
          }
        }
        const exitCode = await exited;
        if (signal?.aborted) throw new Error("clean aborted: task resumed");
        if (exitCode === 77) throw new Error(`clean directory ${directory} was replaced after planning`);
        if (exitCode === 78) throw new Error(`artifact directory ${binding.artifactDir} was replaced after planning`);
        if (exitCode !== 0) {
          throw new Error(`${command.join(" ")} failed in ${directory}: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`);
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        if (hookRoot) await rm(hookRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    } finally {
      await artifactHandle.close();
    }
  } finally {
    await directoryHandle.close();
  }
}

export function createDefaultReaperDependencies(
  request: (payload: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>,
): ReaperDependencies {
  const occupiedFromTasks = (tasks: CleanableTask[]): OccupiedWorktree[] =>
    tasks.flatMap((task) => {
      const path = task.worktreePath?.trim();
      if (task.deleted || !path) return [];
      return [{ id: task.id, path }];
    });

  const listFromTasks = async (): Promise<CleanableTaskListing> => {
    const projectsResponse = await request({ op: "projects.list" });
    if (!projectsResponse.ok) throw new Error(projectsResponse.error ?? "projects.list failed");
    const projects = (projectsResponse.result as { projects?: Array<{ id: string; workspaceRoot: string }> }).projects ?? [];
    const roots = new Map(projects.map((project) => [project.id, project.workspaceRoot]));
    const seen = new Set<string>();
    const tasks: CleanableTask[] = [];
    let truncated = false;
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
      if (!isRecord(response.result) || !Array.isArray(response.result.tasks)) {
        throw new Error("tasks.list omitted tasks; refusing incomplete cleanup");
      }
      if (taskListEnumerationTruncated(response.result.moreRecent)) truncated = true;
      for (const task of response.result.tasks as CleanableTask[]) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        tasks.push({
          ...task,
          workspaceRoot: task.workspaceRoot ?? roots.get(task.projectId) ?? null,
        });
      }
    }
    return {
      tasks: tasks.filter((task) => isCleanableLifecycle(task)),
      truncated,
      occupied: occupiedFromTasks(tasks),
    };
  };

  return {
    async listCleanableTasks() {
      const dedicated = await request({ op: "worktrees.listCleanable" });
      if (dedicated.ok) {
        return parseListCleanableResult(dedicated.result);
      }
      if (!isUnknownOperationError(dedicated.error)) {
        throw new Error(dedicated.error ?? "worktrees.listCleanable failed");
      }
      return listFromTasks();
    },
    async readTask(threadId) {
      const response = await request({ op: "tasks.status", threadId });
      if (!response.ok) throw new Error(response.error ?? `tasks.status failed for ${threadId}`);
      return response.result as CleanableTask;
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
    statIdentity: inspectPathIdentity,
    async runClean(command, directory, signal, binding) {
      if (!binding) throw new Error("clean refused: missing directory and artifact identity binding");
      await runIdentityBoundClean(command, directory, binding, signal);
    },
    holdCleanLease(task, path) {
      return holdExclusiveCleanLease(task, path, async (threadId) => {
        const response = await request({ op: "tasks.status", threadId });
        if (!response.ok) throw new Error(response.error ?? `tasks.status failed for ${threadId}`);
        return response.result as CleanableTask;
      }, (current) => (
        isRunningTask(current as CleanableTask)
        || isLivenessUnavailable(current as CleanableTask)
        || !isCleanableLifecycle(current as CleanableTask)
        || taskTargetIdentityChanged(task, current as CleanableTask)
      ));
    },
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
