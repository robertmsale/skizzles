import { describe, expect, test } from "bun:test";
import { projectTaskHistory, projectThread, taskTurnCommand } from "../src/t3.ts";
import type { ThreadSnapshot, T3Message, T3Thread } from "../src/protocol.ts";

const baseThread: T3Thread = {
  id: "target",
  projectId: "project",
  title: "Target",
  modelSelection: { instanceId: "codex", model: "model", options: [{ id: "reasoningEffort", value: "high" }] },
  runtimeMode: "auto",
  interactionMode: "default",
  worktreePath: "/tmp/worktree",
  branch: "t3code/target",
  latestTurn: null,
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  deletedAt: null,
  session: { status: "idle", threadId: "codex-thread", activeTurnId: null, lastError: null, updatedAt: "2026-08-12T00:00:00Z" },
};

const message = (id: string, text: string): T3Message => ({
  id,
  role: id.startsWith("u") ? "user" : "assistant",
  text,
  turnId: "turn",
  streaming: false,
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
});

const snapshot = (messages: T3Message[]): ThreadSnapshot => ({
  snapshotSequence: 10,
  thread: { ...baseThread, messages },
  page: { beforeCursor: "older", hasMore: true, snapshotSequence: 10, threadSequence: 9 },
});

describe("task history projection", () => {
  test("status strips messages and activity from the raw thread snapshot", () => {
    const raw = snapshot([message("u1", "private conversation")]) as ThreadSnapshot & { thread: { activities: unknown[] } };
    raw.thread.activities = [{ type: "tool" }];
    expect(projectThread(raw)).toEqual(baseThread);
  });

  test("returns conversation messages without raw activity or model data", () => {
    expect(projectTaskHistory(snapshot([message("u1", "question"), message("a1", "answer")]))).toEqual({
      thread: { id: "target", projectId: "project", title: "Target", sessionStatus: "idle" },
      page: { beforeCursor: "older", hasMore: true, snapshotSequence: 10, threadSequence: 9 },
      messages: [
        { role: "user", text: "question", textTruncated: false, turnId: "turn", createdAt: "2026-08-12T00:00:00Z" },
        { role: "assistant", text: "answer", textTruncated: false, turnId: "turn", createdAt: "2026-08-12T00:00:00Z" },
      ],
      messagesOmitted: 0,
    });
  });

  test("caps individual and aggregate text while preserving the newest messages", () => {
    const projected = projectTaskHistory(snapshot([
      message("a1", "a".repeat(20_000)),
      message("a2", "b".repeat(20_000)),
      message("a3", "c".repeat(20_000)),
      message("a4", "d".repeat(20_000)),
      message("a5", "e".repeat(20_000)),
    ]));
    expect(projected.messages.map(({ text, textTruncated }) => ({ length: text.length, textTruncated }))).toEqual([
      { length: 8_000, textTruncated: true },
      { length: 8_000, textTruncated: true },
      { length: 8_000, textTruncated: true },
      { length: 8_000, textTruncated: true },
    ]);
    expect(projected.messages[0]?.text[0]).toBe("b");
    expect(projected.messagesOmitted).toBe(1);
  });
});

describe("task message delivery", () => {
  test("replays the recipient model and runtime settings without caller overrides", () => {
    expect(taskTurnCommand(baseThread, "follow up", "command", "message", "now")).toEqual({
      type: "thread.turn.start",
      commandId: "command",
      threadId: "target",
      message: { messageId: "message", role: "user", text: "follow up", attachments: [] },
      modelSelection: baseThread.modelSelection,
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: "now",
    });
  });

  test("allows optionless Grok replay but rejects optionless Codex replay", () => {
    const grokThread = {
      ...baseThread,
      modelSelection: { instanceId: "grok", model: "grok-4.6", options: [] },
    };
    expect(taskTurnCommand(grokThread, "continue").modelSelection).toEqual(
      grokThread.modelSelection,
    );
    expect(taskTurnCommand({
      ...baseThread,
      modelSelection: { instanceId: "grok", model: "grok-4.6" },
    } as typeof baseThread, "continue").modelSelection).toEqual({
      instanceId: "grok", model: "grok-4.6", options: [],
    });

    expect(() => taskTurnCommand({
      ...baseThread,
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol", options: [] },
    }, "continue")).toThrow("Codex reasoning effort is missing");

    expect(() => taskTurnCommand({
      ...baseThread,
      modelSelection: { instanceId: "codex_personal", model: "gpt-5.6-sol", options: [] },
    }, "continue", "command", "message", "now", "codex")).toThrow("Codex reasoning effort is missing");
  });

  test("replays a Cursor thread's saved Grok 4.6 High selection", () => {
    const cursorThread = {
      ...baseThread,
      modelSelection: { instanceId: "cursor", model: "grok-4.6", options: [{ id: "reasoning", value: "high" }, { id: "fastMode", value: false }] },
    };
    expect(taskTurnCommand(cursorThread, "continue").modelSelection).toEqual(cursorThread.modelSelection);
  });
});
