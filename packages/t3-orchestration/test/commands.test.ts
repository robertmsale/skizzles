import { describe, expect, test } from "bun:test";
import { executeCommand, requireRemoteSafeCommand, type CommandDependencies } from "../src/commands.ts";
import type { T3Thread } from "../src/protocol.ts";

const thread: T3Thread = {
  id: "target",
  projectId: "other-project",
  title: "Target",
  modelSelection: { instanceId: "codex", model: "model", options: [{ id: "reasoningEffort", value: "high" }] },
  runtimeMode: "auto",
  interactionMode: "default",
  worktreePath: "/tmp/worktree",
  branch: "t3code/target",
  session: null,
};

function dependencies(overrides: Partial<CommandDependencies> = {}): CommandDependencies {
  return {
    resolveCallerProject: async () => { throw new Error("caller resolution must not run"); },
    importProjects: async () => "imported",
    projectList: async () => "projects",
    taskList: async (options) => options,
    taskWait: async (input) => input,
    createTask: async (input) => input,
    sendTask: async (threadId, message) => ({ threadId, message }),
    taskStatus: async () => thread,
    taskHistory: async (threadId, turns, before) => ({ threadId, turns, before }),
    renameTask: async (threadId, title) => ({ threadId, title }),
    archiveTask: async (threadId, archived) => ({ threadId, archived }),
    pinTask: async (threadId, pinned) => ({ threadId, pinned }),
    settleTask: async (threadId, settled) => ({ threadId, settled }),
    interruptTask: async (threadId) => ({ threadId }),
    listTaskApprovals: async (projectId) => ({ projectId }),
    resolveTaskApproval: async (input) => input,
    listCleanableWorktrees: async () => ({ tasks: [], count: 0, truncated: false, occupied: [] }),
    ...overrides,
  };
}

describe("daemon command routing", () => {
  test("send, status, and bounded history accept any known task id without caller mapping", async () => {
    const deps = dependencies();
    expect(await executeCommand({ op: "tasks.send", threadId: "other", message: "hello" }, deps)).toEqual({ threadId: "other", message: "hello" });
    expect(await executeCommand({ op: "tasks.status", threadId: "other" }, deps)).toEqual(thread);
    expect(await executeCommand({ op: "tasks.history", threadId: "other", turns: 4, before: "cursor" }, deps)).toEqual({ threadId: "other", turns: 4, before: "cursor" });
  });

  test("task creation resolves the current project from the caller's working directory", async () => {
    const seen: unknown[] = [];
    const deps = dependencies({ resolveCallerProject: async (cwd) => { seen.push(cwd); return "own-project"; } });
    expect(await executeCommand({ op: "tasks.create", callerCwd: "/work/tree", projectId: "current", title: "Child", message: "work", provider: "claude" }, deps)).toEqual({
      projectId: "own-project",
      title: "Child",
      message: "work",
      provider: "claude",
    });
    expect(seen).toEqual(["/work/tree"]);
  });

  test("the remote gateway admits creation only with an explicit project", () => {
    expect(() => requireRemoteSafeCommand({ op: "tasks.create", projectId: "current" })).toThrow("needs --project");
    expect(() => requireRemoteSafeCommand({ op: "tasks.create", projectId: "current", callerCwd: "/etc" })).toThrow("needs --project");
    expect(requireRemoteSafeCommand({ op: "tasks.create", projectId: "p", callerCwd: "/etc" })).toEqual({ op: "tasks.create", projectId: "p" });
    expect(requireRemoteSafeCommand({ op: "tasks.list" })).toEqual({ op: "tasks.list" });
  });

  test("an explicit project is honored from any caller without resolution", async () => {
    expect(await executeCommand({ op: "tasks.create", callerCwd: "/elsewhere", projectId: "other-project", title: "Child", message: "work", model: "sol" }, dependencies())).toEqual({
      projectId: "other-project",
      title: "Child",
      message: "work",
      model: "sol",
    });
  });

  test("external handoff creation retains explicit project ingress", async () => {
    expect(await executeCommand({ op: "handoff.create", projectId: "destination", title: "Ingress", message: "work" }, dependencies())).toEqual({
      projectId: "destination",
      title: "Ingress",
      message: "work",
    });
    expect(await executeCommand({
      op: "handoff.create",
      projectId: "destination",
      title: "Ingress",
      message: "work",
      provider: "codex",
      model: "xai/grok-4.6",
    }, dependencies())).toEqual({
      projectId: "destination",
      title: "Ingress",
      message: "work",
      provider: "codex",
      model: "xai/grok-4.6",
    });
  });

  test("routes listing, waiting, and task lifecycle operations without caller mapping", async () => {
    const deps = dependencies();
    expect(await executeCommand({ op: "tasks.list", limit: 25, includeSettled: false, includeArchived: true }, deps)).toEqual({
      limit: 25,
      includeSettled: false,
      includeArchived: true,
    });
    expect(await executeCommand({ op: "tasks.wait", threadIds: ["one", "two"], timeoutMs: 0, after: { one: "cursor" } }, deps)).toEqual({
      threadIds: ["one", "two"], timeoutMs: 0, after: { one: "cursor" },
    });
    expect(await executeCommand({ op: "tasks.title", threadId: "one", title: "Renamed" }, deps)).toEqual({ threadId: "one", title: "Renamed" });
    expect(await executeCommand({ op: "tasks.archive", threadId: "one" }, deps)).toEqual({ threadId: "one", archived: true });
    expect(await executeCommand({ op: "tasks.unarchive", threadId: "one" }, deps)).toEqual({ threadId: "one", archived: false });
    expect(await executeCommand({ op: "tasks.pin", threadId: "one" }, deps)).toEqual({ threadId: "one", pinned: true });
    expect(await executeCommand({ op: "tasks.unpin", threadId: "one" }, deps)).toEqual({ threadId: "one", pinned: false });
    expect(await executeCommand({ op: "tasks.settle", threadId: "one" }, deps)).toEqual({ threadId: "one", settled: true });
    expect(await executeCommand({ op: "tasks.unsettle", threadId: "one" }, deps)).toEqual({ threadId: "one", settled: false });
    expect(await executeCommand({ op: "tasks.interrupt", threadId: "one" }, deps)).toEqual({ threadId: "one" });
    expect(await executeCommand({ op: "tasks.approvals", projectId: "project" }, deps)).toEqual({ projectId: "project" });
    expect(await executeCommand({ op: "tasks.approve", threadId: "one", requestId: "req-1" }, deps)).toEqual({
      threadId: "one", requestId: "req-1", decision: "accept",
    });
    expect(await executeCommand({ op: "tasks.deny", threadId: "one", reason: "too broad" }, deps)).toEqual({
      threadId: "one", decision: "decline", reason: "too broad",
    });
    expect(await executeCommand({ op: "worktrees.listCleanable" }, deps)).toEqual({ tasks: [], count: 0, truncated: false, occupied: [] });
  });
});

test("creation forwards effort but follow-up overrides fail before dispatch", async () => {
  const deps = dependencies({ resolveCallerProject: async () => "p" });
  for (const op of ["tasks.create", "handoff.create"]) {
    expect(await executeCommand({ op, projectId: "p", title: "t", message: "m", model: "sol", reasoningEffort: "xhigh" }, deps)).toMatchObject({ model: "sol", reasoningEffort: "xhigh" });
  }
  for (const override of [{ model: "sol" }, { reasoningEffort: "high" }]) {
    await expect(executeCommand({ op: "tasks.send", threadId: "t", message: "m", ...override }, deps)).rejects.toThrow("creation-only");
  }
  for (const reasoningEffort of ["", null, 1]) await expect(executeCommand({ op: "handoff.create", reasoningEffort }, deps)).rejects.toThrow("nonempty");
});
