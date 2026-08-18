import { describe, expect, test } from "bun:test";
import { acquireWorktreeGate } from "../src/worktree-reaper-lease.ts";
import { isExistingTaskTurnStart, startExistingTaskTurn, taskTurnCommand } from "../src/t3.ts";
import type { T3Thread } from "../src/protocol.ts";

const thread: T3Thread = {
  id: "task-A",
  projectId: "project",
  title: "Task",
  modelSelection: { instanceId: "codex", model: "model", options: [{ id: "reasoningEffort", value: "high" }] },
  runtimeMode: "auto",
  interactionMode: "default",
  worktreePath: "/repo/.t3/worktrees/repo/shared",
  branch: "t3code/task",
  session: { status: "ready" },
};

describe("existing-task turn-start gate", () => {
  test("treats non-bootstrap thread.turn.start as an existing-task ingress", () => {
    expect(isExistingTaskTurnStart(taskTurnCommand(thread, "continue"))).toBe(true);
    expect(isExistingTaskTurnStart({ type: "thread.turn.start", bootstrap: { createThread: {} } })).toBe(false);
    expect(isExistingTaskTurnStart({ type: "thread.archive" })).toBe(false);
  });

  test("holds the worktree gate across dispatch so a cleaner cannot acquire mid-start", async () => {
    const root = `/tmp/t3-turn-gate-${crypto.randomUUID()}`;
    const path = `${root}/shared`;
    const started: string[] = [];
    let cleanerAcquiredDuringDispatch = false;
    await startExistingTaskTurn(taskTurnCommand(thread, "continue"), {
      home: root,
      resolvePath: async () => path,
      dispatchCommand: async () => {
        started.push("dispatch");
        try {
          await acquireWorktreeGate(path, "task-A", "clean", { home: root });
          cleanerAcquiredDuringDispatch = true;
        } catch (error) {
          expect(String(error)).toMatch(/turn start in progress/);
        }
        return { sequence: 1 };
      },
    });
    expect(started).toEqual(["dispatch"]);
    expect(cleanerAcquiredDuringDispatch).toBe(false);
  });

  test("direct UI/thread.turn.start path refuses a worktree already reserved for cleanup", async () => {
    const root = `/tmp/t3-turn-gate-${crypto.randomUUID()}`;
    const path = `${root}/shared`;
    const clean = await acquireWorktreeGate(path, "task-A", "clean", { home: root });
    const dispatched: unknown[] = [];
    await expect(startExistingTaskTurn(taskTurnCommand(thread, "continue"), {
      home: root,
      resolvePath: async () => path,
      dispatchCommand: async (command) => {
        dispatched.push(command);
        return { sequence: 1 };
      },
    })).rejects.toThrow(/reserved for artifact cleanup/);
    expect(dispatched).toEqual([]);
    await clean.release();
  });
});
