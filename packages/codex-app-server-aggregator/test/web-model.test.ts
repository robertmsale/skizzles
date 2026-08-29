import { describe, expect, test } from "bun:test";
import {
  approvalResult,
  classifyThread,
  eventDelta,
  relativeTime,
  timelineEntries,
} from "../src/web/model.ts";
import type { ServerRequestDto, ThreadDto } from "../src/web/types.ts";

const baseThread: ThreadDto = {
  id: "thread-1",
  cwd: "/host/project",
  preview: "Build the board",
  status: { type: "idle" },
};

describe("board client mapping", () => {
  test("snapshot-only is never classified as live", () => {
    expect(classifyThread(baseThread, new Set(), false).lifecycle).toBe("snapshot");
    expect(classifyThread(baseThread, new Set([baseThread.id]), false).lifecycle).toBe("live");
    expect(classifyThread(baseThread, new Set([baseThread.id]), true).lifecycle).toBe("archived");
    expect(relativeTime(1_700_000_000, 1_700_000_120_000)).toBe("2m");
  });

  test("maps user, assistant, and command items into a stable timeline", () => {
    const entries = timelineEntries({
      ...baseThread,
      turns: [{
        id: "turn-1",
        items: [
          { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Ship it" }] },
          { id: "agent-1", type: "agentMessage", text: "Working" },
          { id: "cmd-1", type: "commandExecution", command: ["bun", "test"], status: "completed" },
        ],
      }],
    }, new Map([["agent-1", "…done"]]));
    expect(entries.map(({ role, label, text }) => ({ role, label, text }))).toEqual([
      { role: "user", label: "You", text: "Ship it" },
      { role: "assistant", label: "Codex", text: "Working…done" },
      { role: "tool", label: "Command", text: "bun test" },
    ]);
  });

  test("does not duplicate a streamed suffix already present in thread/read", () => {
    const entries = timelineEntries({
      ...baseThread,
      turns: [{ id: "turn-1", items: [{ id: "agent-1", type: "agentMessage", text: "Hello world" }] }],
    }, new Map([["agent-1", " world"]]));
    expect(entries[0]?.text).toBe("Hello world");
  });

  test("maps journal deltas and current approval decisions", () => {
    expect(eventDelta({ method: "item/agentMessage/delta", params: { itemId: "agent-1", delta: "hello" } }))
      .toEqual({ itemId: "agent-1", delta: "hello" });
    const request = {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
    } as ServerRequestDto;
    expect(approvalResult(request, true)).toEqual({ decision: "accept" });
    expect(approvalResult(request, false)).toEqual({ decision: "decline" });
  });
});
