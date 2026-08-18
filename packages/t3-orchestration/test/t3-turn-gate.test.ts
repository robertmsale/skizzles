import { describe, expect, test } from "bun:test";
import { acquireWorktreeGate } from "../src/worktree-reaper-lease.ts";
import { dispatch, isExistingTaskTurnStart, rawDispatch, taskTurnCommand } from "../src/t3.ts";
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

  test("t3ctl send/dispatch holds the gate through T3 transmit so a cleaner cannot acquire mid-start", async () => {
    const root = `/tmp/t3-turn-gate-${crypto.randomUUID()}`;
    const path = `${root}/shared`;
    const started: string[] = [];
    let cleanerAcquiredDuringDispatch = false;
    await dispatch(taskTurnCommand(thread, "continue"), {
      home: root,
      resolvePath: async () => path,
      dispatchCommand: async () => {
        started.push("transmit");
        try {
          await acquireWorktreeGate(path, "task-A", "clean", { home: root });
          cleanerAcquiredDuringDispatch = true;
        } catch (error) {
          expect(String(error)).toMatch(/turn start in progress/);
        }
        return { sequence: 1 };
      },
    });
    expect(started).toEqual(["transmit"]);
    expect(cleanerAcquiredDuringDispatch).toBe(false);
  });

  test("in-process rawDispatch thread.turn.start refuses a worktree reserved for cleanup", async () => {
    const root = `/tmp/t3-turn-gate-${crypto.randomUUID()}`;
    const path = `${root}/shared`;
    const clean = await acquireWorktreeGate(path, "task-A", "clean", { home: root });
    const transmitted: unknown[] = [];
    await expect(rawDispatch({
      type: "thread.turn.start",
      threadId: "task-A",
      message: { messageId: "m", role: "user", text: "continue", attachments: [] },
    }, {
      home: root,
      resolvePath: async () => path,
      dispatchCommand: async (command) => {
        transmitted.push(command);
        return { sequence: 1 };
      },
    })).rejects.toThrow(/reserved for artifact cleanup/);
    expect(transmitted).toEqual([]);
    await clean.release();
  });
});
