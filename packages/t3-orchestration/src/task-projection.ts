import type { ShellSnapshot, Snapshot, T3Project, T3Thread, T3ThreadShell } from "./protocol.ts";

export type TaskPhase =
  | "waiting_for_approval"
  | "waiting_for_input"
  | "plan_ready"
  | "failed"
  | "starting"
  | "running"
  | "monitoring"
  | "completed"
  | "archived"
  | "deleted"
  | "stopped"
  | "idle";

export type TaskListOptions = {
  limit: number;
  projectId?: string;
  includeSettled: boolean;
  includeArchived: boolean;
};

export type TaskWaitInput = {
  threadIds: string[];
  timeoutMs: number;
  after: Record<string, string>;
};

export function taskPhase(thread: T3Thread | T3ThreadShell): TaskPhase {
  const shell = thread as Partial<T3ThreadShell>;
  if (thread.deletedAt) return "deleted";
  if (thread.archivedAt) return "archived";
  if (shell.hasPendingApprovals) return "waiting_for_approval";
  if (shell.hasPendingUserInput) return "waiting_for_input";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (thread.session?.status === "starting") return "starting";
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running") return "running";
  if (thread.interactionMode === "plan" && shell.hasActionableProposedPlan) return "plan_ready";
  if (shell.backgroundLiveness === "working") return "running";
  if (shell.backgroundLiveness === "monitoring") return "monitoring";
  if (thread.latestTurn?.state === "completed") return "completed";
  if (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt !== null) return "completed";
  if (thread.session?.status === "ready" || thread.session?.status === "idle") return "completed";
  if (thread.session?.status === "stopped" || thread.session?.status === "interrupted") return "stopped";
  return "idle";
}

export function taskCursor(thread: T3Thread | T3ThreadShell): string {
  const shell = thread as Partial<T3ThreadShell>;
  return Buffer.from(JSON.stringify([
    thread.updatedAt ?? null,
    thread.latestTurn?.turnId ?? null,
    thread.latestTurn?.state ?? null,
    thread.latestTurn?.completedAt ?? null,
    thread.session?.status ?? null,
    thread.session?.updatedAt ?? null,
    shell.hasPendingApprovals ?? false,
    shell.hasPendingUserInput ?? false,
    shell.hasActionableProposedPlan ?? false,
    shell.backgroundLiveness ?? null,
    thread.interactionMode,
    thread.archivedAt ?? null,
    thread.deletedAt ?? null,
  ])).toString("base64url");
}

function projectName(projects: Map<string, T3Project>, thread: T3Thread): string | null {
  return projects.get(thread.projectId)?.title ?? null;
}

export function projectedBackgroundLiveness(thread: T3Thread | T3ThreadShell): "working" | "monitoring" | "unknown" | null {
  if (!Object.hasOwn(thread, "backgroundLiveness")) return "unknown";
  const value = (thread as Partial<T3ThreadShell>).backgroundLiveness;
  if (value === null) return null;
  if (value === "working" || value === "monitoring" || value === "unknown") return value;
  return "unknown";
}

export function projectTask(thread: T3Thread | T3ThreadShell, projects: Map<string, T3Project>, pinnedIndex?: number) {
  const shell = thread as Partial<T3ThreadShell>;
  return {
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    projectTitle: projectName(projects, thread),
    phase: taskPhase(thread),
    sessionStatus: thread.session?.status ?? null,
    latestTurnState: thread.latestTurn?.state ?? null,
    pendingApproval: shell.hasPendingApprovals ?? false,
    pendingUserInput: shell.hasPendingUserInput ?? false,
    actionablePlan: shell.hasActionableProposedPlan ?? false,
    backgroundLiveness: projectedBackgroundLiveness(thread),
    pinnedIndex: pinnedIndex ?? null,
    archived: thread.archivedAt != null,
    deleted: thread.deletedAt != null,
    settled: thread.settledOverride === "settled",
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    workspaceRoot: projects.get(thread.projectId)?.workspaceRoot ?? null,
    updatedAt: thread.updatedAt ?? null,
    cursor: taskCursor(thread),
  };
}

const CLEANABLE_TASK_CAP = 5_000;

export function projectCleanableWorktrees(snapshot: Snapshot) {
  const projects = new Map(snapshot.projects.filter((project) => !project.deletedAt).map((project) => [project.id, project]));
  const visible = snapshot.threads.filter((thread) =>
    !thread.deletedAt && (thread.archivedAt != null || thread.settledOverride === "settled")
  ).sort(compareRecent);
  const truncated = visible.length > CLEANABLE_TASK_CAP;
  return {
    snapshotSequence: snapshot.snapshotSequence,
    tasks: visible.slice(0, CLEANABLE_TASK_CAP).map((thread) => projectTask(thread, projects)),
    count: Math.min(visible.length, CLEANABLE_TASK_CAP),
    truncated,
  };
}

function comparePinned(left: T3Thread, right: T3Thread): number {
  if (left.pinOrderKey && right.pinOrderKey) return left.pinOrderKey.localeCompare(right.pinOrderKey);
  if (left.pinOrderKey) return -1;
  if (right.pinOrderKey) return 1;
  return (left.pinnedAt ?? left.createdAt ?? "").localeCompare(right.pinnedAt ?? right.createdAt ?? "");
}

function compareRecent(left: T3Thread, right: T3Thread): number {
  return (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? "");
}

export function projectTaskList(snapshot: Snapshot, options: TaskListOptions) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
    throw new Error("Task list limit must be an integer from 1 through 200");
  }
  const projects = new Map(snapshot.projects.filter((project) => !project.deletedAt).map((project) => [project.id, project]));
  const visible = snapshot.threads.filter((thread) =>
    !thread.deletedAt &&
    (!options.projectId || thread.projectId === options.projectId) &&
    (options.includeArchived || !thread.archivedAt) &&
    (options.includeSettled || thread.settledOverride !== "settled")
  );
  const pinned = visible.filter((thread) => thread.pinnedAt).sort(comparePinned);
  const recent = visible.filter((thread) => !thread.pinnedAt).sort(compareRecent).slice(0, options.limit);
  return {
    snapshotSequence: snapshot.snapshotSequence,
    tasks: [
      ...pinned.map((thread, index) => projectTask(thread, projects, index + 1)),
      ...recent.map((thread) => projectTask(thread, projects)),
    ],
    pinnedCount: pinned.length,
    recentCount: recent.length,
    moreRecent: Math.max(0, visible.length - pinned.length - recent.length),
  };
}

export function projectProjects(snapshot: Snapshot) {
  const projects = snapshot.projects
    .filter((project) => !project.deletedAt)
    .sort((left, right) => left.title.localeCompare(right.title))
    .map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot }));
  return { projects, count: projects.length };
}

export function mergeArchivedTasks(shell: ShellSnapshot, full: Snapshot): Snapshot {
  const activeIds = new Set(shell.threads.map((thread) => thread.id));
  const archived = full.threads
    .filter((thread) => !activeIds.has(thread.id) && !thread.deletedAt && thread.archivedAt)
    .map((thread) => ({
      ...thread,
      backgroundLiveness: Object.hasOwn(thread, "backgroundLiveness")
        ? thread.backgroundLiveness ?? null
        : "unknown" as const,
    }));
  return {
    snapshotSequence: Math.max(shell.snapshotSequence, full.snapshotSequence),
    projects: full.projects,
    threads: [...shell.threads, ...archived],
    updatedAt: shell.updatedAt,
  };
}

function isWakePhase(phase: TaskPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "waiting_for_approval" || phase === "waiting_for_input" || phase === "plan_ready" || phase === "archived" || phase === "deleted";
}

export async function waitForTasks(
  input: TaskWaitInput,
  loadSnapshot: () => Promise<ShellSnapshot>,
  sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
  clock: () => number = Date.now,
  loadMissing?: (threadIds: string[]) => Promise<T3Thread[]>,
) {
  const uniqueIds = new Set(input.threadIds);
  if (uniqueIds.size !== input.threadIds.length || uniqueIds.size < 1 || uniqueIds.size > 8) {
    throw new Error("Task wait requires 1 through 8 unique task ids");
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 3_600_000) {
    throw new Error("Task wait timeout must be an integer from 0 through 3600000 milliseconds");
  }
  const unknownCursors = Object.keys(input.after).filter((threadId) => !uniqueIds.has(threadId));
  if (unknownCursors.length) throw new Error(`Wait cursor does not match a target task: ${unknownCursors.join(", ")}`);
  const deadline = clock() + input.timeoutMs;
  while (true) {
    const snapshot = await loadSnapshot();
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    const missing = input.threadIds.filter((threadId) => !byId.has(threadId));
    if (missing.length && loadMissing) {
      for (const thread of await loadMissing(missing)) byId.set(thread.id, thread as T3ThreadShell);
    }
    const unresolved = input.threadIds.filter((threadId) => !byId.has(threadId));
    if (unresolved.length) throw new Error(`T3 task not found: ${unresolved.join(", ")}`);
    const tasks = input.threadIds.map((threadId) => projectTask(byId.get(threadId)!, projects));
    const ready = tasks.filter((task) => isWakePhase(task.phase) && input.after[task.id] !== task.cursor);
    if (ready.length) return { timedOut: false, ready: ready.map((task) => task.id), tasks };
    const remaining = deadline - clock();
    if (remaining <= 0) return { timedOut: true, ready: [], tasks };
    await sleep(Math.min(1_000, remaining));
  }
}
