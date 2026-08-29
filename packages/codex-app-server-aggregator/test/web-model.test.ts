import { describe, expect, test } from "bun:test";
import { ApiError, boardApi, eventCursorRecovery } from "../src/web/api.ts";
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

  test("maps journal deltas and only protocol-compatible approval decisions", () => {
    expect(eventDelta({ method: "item/agentMessage/delta", params: { itemId: "agent-1", delta: "hello" } }))
      .toEqual({ itemId: "agent-1", delta: "hello" });
    const request = {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
    } as ServerRequestDto;
    expect(approvalResult(request, true)).toEqual({ decision: "accept" });
    expect(approvalResult(request, false)).toEqual({ decision: "decline" });
    expect(approvalResult({
      id: "input-1",
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", questions: [] },
    } as ServerRequestDto, true)).toBeNull();
    expect(approvalResult({
      id: "permissions-1",
      method: "item/permissions/requestApproval",
      params: { threadId: "thread-1" },
    } as ServerRequestDto, false)).toBeNull();
  });

  test("resumes an expired event journal at the server-provided retained boundary", () => {
    const error = new ApiError(410, "expired", {
      error: { code: "event_cursor_expired", oldestCursor: 41, streamId: "daemon-2", restarted: true },
    });
    expect(eventCursorRecovery(error)).toEqual({ after: 40, stream: "daemon-2" });
    expect(eventCursorRecovery(new ApiError(410, "malformed", { error: {} }))).toBeNull();
  });

  test("follows every thread-list cursor and forwards server-backed search", async () => {
    const originalFetch = globalThis.fetch;
    const requested: URL[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input), "http://board.test");
      requested.push(url);
      const cursor = url.searchParams.get("cursor");
      return Response.json(cursor
        ? { data: [{ ...baseThread, id: "thread-2" }], nextCursor: null, backwardsCursor: "cursor-1" }
        : { data: [baseThread], nextCursor: "cursor-1", backwardsCursor: null });
    }) as typeof fetch;
    try {
      const result = await boardApi.threads("/host/project", false, "build");
      expect(result.data.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
      expect(requested).toHaveLength(2);
      expect(requested[0]?.searchParams.get("searchTerm")).toBe("build");
      expect(requested[1]?.searchParams.get("cursor")).toBe("cursor-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
