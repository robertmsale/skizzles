import { describe, expect, test } from "bun:test";
import { ApiError, boardApi, eventCursorRecovery } from "../src/web/api.ts";
import {
  afterSuccessfulReconciliation,
  appendSelectedDeltas,
  approvalResult,
  classifyThread,
  eventDelta,
  eventPageNeedsReconciliation,
  LatestRequest,
  projectRegistriesMatch,
  pruneIncorporatedDeltas,
  relativeTime,
  threadForSelection,
  threadHasSystemError,
  threadIsRunning,
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

  test("only active threads are running and system errors remain actionable errors", () => {
    expect(threadIsRunning({ ...baseThread, status: { type: "active" } })).toBe(true);
    expect(threadIsRunning({ ...baseThread, status: { type: "idle" } })).toBe(false);
    expect(threadIsRunning({ ...baseThread, status: { type: "notLoaded" } })).toBe(false);
    expect(threadIsRunning({ ...baseThread, status: { type: "systemError" } })).toBe(false);
    expect(threadHasSystemError({ ...baseThread, status: { type: "systemError" } })).toBe(true);
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

  test("keeps delta-only pages incremental and bounds output to the selected thread", () => {
    const deltas = Array.from({ length: 140 }, (_, index) => ({
      cursor: index + 1,
      event: {
        method: "item/agentMessage/delta",
        params: { threadId: index === 0 ? "other-thread" : "thread-1", itemId: `agent-${index}`, delta: String(index) },
      },
    }));
    const appended = appendSelectedDeltas(new Map(), deltas, "thread-1");
    expect(eventPageNeedsReconciliation(deltas)).toBe(false);
    expect(appended.size).toBe(128);
    expect(appended.has("agent-0")).toBe(false);
    expect(appended.has("agent-1")).toBe(false);
    expect(appended.get("agent-139")).toBe("139");
    expect(eventPageNeedsReconciliation([{
      cursor: 141,
      event: { method: "item/agentMessage/completed", params: { threadId: "thread-1", itemId: "agent-139" } },
    }])).toBe(true);
  });

  test("does not clear polling errors after failed reconciliation", async () => {
    let cleared = false;
    expect(await afterSuccessfulReconciliation(async () => false, () => { cleared = true; })).toBe(false);
    expect(cleared).toBe(false);
    expect(await afterSuccessfulReconciliation(async () => true, () => { cleared = true; })).toBe(true);
    expect(cleared).toBe(true);
  });

  test("prunes deltas incorporated by an authoritative thread snapshot", () => {
    const current = new Map([
      ["agent-complete", "Hello world"],
      ["agent-partial", "Partial response"],
      ["agent-pending", "Still streaming"],
    ]);
    const pruned = pruneIncorporatedDeltas({
      ...baseThread,
      turns: [{ id: "turn-1", items: [
        { id: "agent-complete", type: "agentMessage", text: "Hello world" },
        { id: "agent-partial", type: "agentMessage", text: "Partial" },
      ] }],
    }, current);
    expect(pruned.has("agent-complete")).toBe(false);
    expect(pruned.get("agent-partial")).toBe(" response");
    expect(pruned.get("agent-pending")).toBe("Still streaming");
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

  test("allows only the newest board or thread request to commit", () => {
    const requests = new LatestRequest();
    const first = requests.begin();
    const second = requests.begin();
    let rendered = "";
    expect(first.signal.aborted).toBe(true);
    expect(requests.commit(second, () => { rendered = "thread-b"; })).toBe(true);
    expect(requests.commit(first, () => { rendered = "thread-a"; })).toBe(false);
    expect(rendered).toBe("thread-b");
    expect(threadForSelection({ ...baseThread, turns: [{ id: "turn-a" }] }, "thread-b")).toBeNull();
    expect(threadForSelection({ ...baseThread, id: "thread-b" }, "thread-b")?.id).toBe("thread-b");
  });

  test("detects cross-client project registry additions, removals, and updates", () => {
    const project = { cwd: "/host/a", cloneUrl: "https://example.test/a.git", createdAt: 1, updatedAt: 1 };
    expect(projectRegistriesMatch([project], [project])).toBe(true);
    expect(projectRegistriesMatch([project], [])).toBe(false);
    expect(projectRegistriesMatch([project], [project, { ...project, cwd: "/host/b" }])).toBe(false);
    expect(projectRegistriesMatch([project], [{ ...project, updatedAt: 2 }])).toBe(false);
  });

  test("follows every loaded-thread cursor", async () => {
    const originalFetch = globalThis.fetch;
    const requested: URL[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input), "http://board.test");
      requested.push(url);
      return Response.json(url.searchParams.has("cursor")
        ? { data: ["thread-501"], nextCursor: null }
        : { data: ["thread-1"], nextCursor: "cursor-500" });
    }) as typeof fetch;
    try {
      const result = await boardApi.loaded();
      expect(result.data).toEqual(["thread-1", "thread-501"]);
      expect(requested).toHaveLength(2);
      expect(requested[0]?.searchParams.get("limit")).toBe("500");
      expect(requested[1]?.searchParams.get("cursor")).toBe("cursor-500");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
