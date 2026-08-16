import { describe, expect, test } from "bun:test";
import { executeCommand, type CommandDependencies } from "../src/commands.ts";
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
    resolveCallerThread: () => { throw new Error("caller resolution must not run"); },
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

  test("task creation remains scoped to the mapped caller project", async () => {
    const deps = dependencies({
      resolveCallerThread: () => ({ codexThreadId: "codex", t3ThreadId: "t3", projectId: "own-project" }),
    });
    expect(await executeCommand({ op: "tasks.create", callerThreadId: "codex", projectId: "current", title: "Child", message: "work", provider: "grok" }, deps)).toEqual({
      projectId: "own-project",
      title: "Child",
      message: "work",
      provider: "grok",
    });
    await expect(executeCommand({ op: "tasks.create", callerThreadId: "codex", projectId: "other-project", title: "Child", message: "work" }, deps)).rejects.toThrow("only in its own T3 project");
  });

  test("external handoff creation retains explicit project ingress", async () => {
    expect(await executeCommand({ op: "handoff.create", projectId: "destination", title: "Ingress", message: "work" }, dependencies())).toEqual({
      projectId: "destination",
      title: "Ingress",
      message: "work",
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
  });
});
