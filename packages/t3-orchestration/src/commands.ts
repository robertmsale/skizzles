import type { TaskListOptions, TaskWaitInput } from "./task-projection.ts";

export type Caller = { codexThreadId: string; t3ThreadId: string; projectId: string };

export type CommandDependencies = {
  resolveCallerThread(correlationId: unknown): Caller;
  importProjects(): Promise<unknown>;
  projectList(): Promise<unknown>;
  taskList(options: TaskListOptions): Promise<unknown>;
  taskWait(input: TaskWaitInput): Promise<unknown>;
  createTask(input: { projectId: string; title: string; message: string; baseBranch?: string; provider?: string }): Promise<unknown>;
  sendTask(threadId: string, message: string): Promise<unknown>;
  taskStatus(threadId: string): Promise<unknown>;
  taskHistory(threadId: string, turns: number, before?: string): Promise<unknown>;
  renameTask(threadId: string, title: string): Promise<unknown>;
  archiveTask(threadId: string, archived: boolean): Promise<unknown>;
  pinTask(threadId: string, pinned: boolean): Promise<unknown>;
  settleTask(threadId: string, settled: boolean): Promise<unknown>;
  interruptTask(threadId: string): Promise<unknown>;
  listTaskApprovals(projectId?: string): Promise<unknown>;
  resolveTaskApproval(input: {
    threadId: string;
    requestId?: string;
    decision: "accept" | "decline";
    reason?: string;
    expected?: { requestKind: "command" | "file-read" | "file-change" | null; command: string | null; cwd: string | null; toolName: string | null };
  }): Promise<unknown>;
  listCleanableWorktrees(): Promise<unknown>;
};

function parseExpectedAction(value: unknown): {
  requestKind: "command" | "file-read" | "file-change" | null;
  command: string | null;
  cwd: string | null;
  toolName: string | null;
} | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected action identity is invalid");
  const record = value as Record<string, unknown>;
  const requestKind = record.requestKind === "command" || record.requestKind === "file-read" || record.requestKind === "file-change"
    ? record.requestKind
    : record.requestKind == null ? null : null;
  if (record.requestKind !== undefined && record.requestKind !== null && requestKind === null) {
    throw new Error("expected action identity is invalid");
  }
  return {
    requestKind,
    command: typeof record.command === "string" ? record.command : record.command == null ? null : (() => { throw new Error("expected action identity is invalid"); })(),
    cwd: typeof record.cwd === "string" ? record.cwd : record.cwd == null ? null : (() => { throw new Error("expected action identity is invalid"); })(),
    toolName: typeof record.toolName === "string" ? record.toolName : record.toolName == null ? null : (() => { throw new Error("expected action identity is invalid"); })(),
  };
}

export async function executeCommand(command: Record<string, unknown>, dependencies: CommandDependencies): Promise<unknown> {
  const caller = command.op === "tasks.create" ? dependencies.resolveCallerThread(command.callerThreadId) : null;
  const projectId = command.op === "tasks.create" && command.projectId === "current" ? caller?.projectId : command.projectId;
  if (caller && command.op === "tasks.create" && projectId !== caller.projectId) {
    throw new Error("A root may create tasks only in its own T3 project");
  }

  switch (command.op) {
    case "projects.import": return dependencies.importProjects();
    case "projects.list": return dependencies.projectList();
    case "handoff.create": return dependencies.createTask({
      projectId: String(command.projectId),
      title: String(command.title),
      message: String(command.message),
      ...(command.baseBranch ? { baseBranch: String(command.baseBranch) } : {}),
      ...(command.provider ? { provider: String(command.provider) } : {}),
    });
    case "tasks.create": return dependencies.createTask({
      projectId: String(projectId),
      title: String(command.title),
      message: String(command.message),
      ...(command.baseBranch ? { baseBranch: String(command.baseBranch) } : {}),
      ...(command.provider ? { provider: String(command.provider) } : {}),
    });
    case "tasks.list": return dependencies.taskList({
      limit: Number(command.limit),
      ...(command.projectId ? { projectId: String(command.projectId) } : {}),
      includeSettled: Boolean(command.includeSettled),
      includeArchived: Boolean(command.includeArchived),
    });
    case "tasks.wait": return dependencies.taskWait({
      threadIds: command.threadIds as string[],
      timeoutMs: Number(command.timeoutMs),
      after: command.after as Record<string, string>,
    });
    case "tasks.send": return dependencies.sendTask(String(command.threadId), String(command.message));
    case "tasks.status": return dependencies.taskStatus(String(command.threadId));
    case "tasks.history": return dependencies.taskHistory(
      String(command.threadId),
      Number(command.turns),
      command.before ? String(command.before) : undefined,
    );
    case "tasks.title": return dependencies.renameTask(String(command.threadId), String(command.title));
    case "tasks.archive": return dependencies.archiveTask(String(command.threadId), true);
    case "tasks.unarchive": return dependencies.archiveTask(String(command.threadId), false);
    case "tasks.pin": return dependencies.pinTask(String(command.threadId), true);
    case "tasks.unpin": return dependencies.pinTask(String(command.threadId), false);
    case "tasks.settle": return dependencies.settleTask(String(command.threadId), true);
    case "tasks.unsettle": return dependencies.settleTask(String(command.threadId), false);
    case "tasks.interrupt": return dependencies.interruptTask(String(command.threadId));
    case "tasks.approvals": return dependencies.listTaskApprovals(command.projectId ? String(command.projectId) : undefined);
    case "tasks.approve": return dependencies.resolveTaskApproval({
      threadId: String(command.threadId),
      ...(command.requestId ? { requestId: String(command.requestId) } : {}),
      decision: "accept",
      ...(command.expected !== undefined ? { expected: parseExpectedAction(command.expected) } : {}),
    });
    case "tasks.deny": return dependencies.resolveTaskApproval({
      threadId: String(command.threadId),
      ...(command.requestId ? { requestId: String(command.requestId) } : {}),
      decision: "decline",
      ...(command.reason ? { reason: String(command.reason) } : {}),
    });
    case "worktrees.listCleanable": return dependencies.listCleanableWorktrees();
    default: throw new Error(`Unknown operation: ${String(command.op)}`);
  }
}
