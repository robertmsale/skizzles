import { describe, expect, test } from "bun:test";
import { ApiError, boardApi, eventCursorRecovery } from "../src/web/api.ts";
import {
  afterSuccessfulReconciliation,
  appendSelectedDeltas,
  approvalResult,
  classifyThread,
  clearOwnedError,
  DirtyThreadReads,
  eventDelta,
  eventMaterializesThread,
  eventPageNeedsReconciliation,
  eventPageNeedsSelectedThreadRead,
  LatestRequest,
  PendingFirstTurnThreads,
  projectRegistriesMatch,
  projectForThread,
  pruneIncorporatedDeltas,
  relativeTime,
  replaceOwnedError,
  threadForSelection,
  threadHasSystemError,
  threadIsRunning,
  threadTitle,
  timelineEntries,
} from "../src/web/model.ts";
import type { MachineDto, ServerRequestDto, ThreadDto } from "../src/web/types.ts";

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

  test("prefers a non-empty explicit thread name over its preview", () => {
    expect(threadTitle({ ...baseThread, name: "  Release   board  " })).toBe("Release board");
    expect(threadTitle({ ...baseThread, name: "  " })).toBe("Build the board");
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
    expect(timelineEntries({
      ...baseThread,
      turns: [{ id: "turn-2", items: [{ id: "cmd-live", type: "commandExecution", command: "bun test", aggregatedOutput: null }] }],
    }, new Map([["cmd-live", "running test suite"]]))[0]?.text).toBe("bun test\n\nrunning test suite");
  });

  test("preserves protocol-shaped file, MCP, function, and command activity", () => {
    const entries = timelineEntries({
      ...baseThread,
      turns: [{
        id: "turn-1",
        items: [
          {
            id: "file-1",
            type: "fileChange",
            status: "completed",
            changes: [{
              path: "src/web/model.ts",
              kind: { type: "update", move_path: null },
              diff: "@@ -1 +1 @@\n-old\n+new",
            }],
          },
          {
            id: "mcp-1",
            type: "mcpToolCall",
            server: "github",
            tool: "search_code",
            arguments: { query: "threadTitle" },
            result: { content: [{ type: "text", text: "1 match" }], structuredContent: null },
            error: null,
            status: "completed",
          },
          {
            id: "mcp-2",
            type: "mcpToolCall",
            server: "filesystem",
            tool: "read_file",
            arguments: { path: "/workspace/missing.txt" },
            result: null,
            error: { message: "File not found" },
            status: "failed",
          },
          { id: "function-1", type: "functionCallOutput", output: { ok: true, changed: 1 } },
          { id: "command-1", type: "commandExecution", command: "bun test", aggregatedOutput: "77 pass\n0 fail", status: "completed" },
        ],
      }],
    }, new Map());

    expect(entries.map(({ label, text }) => ({ label, text }))).toEqual([
      { label: "File changes", text: "Update · src/web/model.ts\n@@ -1 +1 @@\n-old\n+new" },
      {
        label: "MCP · github",
        text: "Tool: search_code\n\nArguments:\n{\n  \"query\": \"threadTitle\"\n}\n\nResult:\n{\n  \"content\": [\n    {\n      \"type\": \"text\",\n      \"text\": \"1 match\"\n    }\n  ],\n  \"structuredContent\": null\n}",
      },
      {
        label: "MCP · filesystem",
        text: "Tool: read_file\n\nArguments:\n{\n  \"path\": \"/workspace/missing.txt\"\n}\n\nError:\n{\n  \"message\": \"File not found\"\n}",
      },
      { label: "Function Call Output", text: "Output:\n{\n  \"ok\": true,\n  \"changed\": 1\n}" },
      { label: "Command", text: "bun test\n\n77 pass\n0 fail" },
    ]);
  });

  test("preserves image attachments in image-only and mixed user prompts", () => {
    const entries = timelineEntries({
      ...baseThread,
      turns: [{
        id: "turn-1",
        items: [
          { id: "image-only", type: "userMessage", content: [{ type: "image", url: "data:image/png;base64,ignored" }] },
          { id: "mixed", type: "userMessage", content: [{ type: "text", text: "Explain this" }, { type: "localImage", path: "/workspace/chart.png" }] },
        ],
      }],
    }, new Map());
    expect(entries.map((entry) => entry.text)).toEqual([
      "[Image attachment]",
      "Explain this\n[Image attachment]",
    ]);
  });

  test("preserves protocol reasoning summary arrays with content as fallback", () => {
    const entries = timelineEntries({
      ...baseThread,
      turns: [{
        id: "turn-1",
        items: [
          { id: "reasoning-summary", type: "reasoning", summary: ["Checked the protocol.", "Selected the safe path."], content: ["Hidden fallback."] },
          { id: "reasoning-content", type: "reasoning", summary: [], content: ["Fallback reasoning."] },
        ],
      }],
    }, new Map());
    expect(entries.map((entry) => entry.text)).toEqual([
      "Checked the protocol.\nSelected the safe path.",
      "Fallback reasoning.",
    ]);
  });

  test("retains the thread/start snapshot until a first-turn event materializes it", () => {
    const pending = new PendingFirstTurnThreads();
    pending.remember(baseThread);
    expect(pending.snapshot(baseThread.id)).toBe(baseThread);
    expect(eventMaterializesThread({ method: "thread/started", params: { thread: baseThread } })).toBe(false);
    expect(eventMaterializesThread({ method: "turn/started", params: { threadId: baseThread.id } })).toBe(true);
    expect(eventMaterializesThread({ method: "item/reasoning/summaryTextDelta", params: { threadId: baseThread.id } })).toBe(true);
    pending.materialized(baseThread.id);
    expect(pending.snapshot(baseThread.id)).toBeUndefined();
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
    const fileChange = {
      id: "file-change-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-change-item", reason: "Update files" },
    } as ServerRequestDto;
    expect(approvalResult(fileChange, true)).toBeNull();
    expect(approvalResult(fileChange, false)).toBeNull();
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

  test("keeps routine turn traffic local and bounds output to the selected thread", () => {
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
    }])).toBe(false);
    const lifecycle = [{
      cursor: 142,
      event: { method: "item/completed", params: { threadId: "thread-1", item: { id: "agent-139" } } },
    }];
    expect(eventPageNeedsReconciliation(lifecycle)).toBe(false);
    expect(eventPageNeedsSelectedThreadRead(lifecycle, "thread-1")).toBe(true);
    expect(eventPageNeedsSelectedThreadRead(lifecycle, "other-thread")).toBe(false);
    expect(eventPageNeedsReconciliation([{
      cursor: 143,
      event: { method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "active" } } },
    }])).toBe(true);
    const incidental = [
      { cursor: 144, event: { method: "thread/tokenUsage/updated", params: { threadId: "thread-1" } } },
      { cursor: 145, event: { method: "configWarning", params: { summary: "warning" } } },
    ];
    expect(eventPageNeedsReconciliation(incidental)).toBe(false);
    expect(eventPageNeedsSelectedThreadRead(incidental, "thread-1")).toBe(false);
  });

  test("does not clear polling errors after failed reconciliation", async () => {
    const dirty = new DirtyThreadReads();
    dirty.mark("thread-1");
    let cleared = false;
    expect(await afterSuccessfulReconciliation(async () => false, () => {
      cleared = true;
      dirty.resolve("thread-1");
    })).toBe(false);
    expect(cleared).toBe(false);
    expect(dirty.has("thread-1")).toBe(true);
    expect(await afterSuccessfulReconciliation(async () => true, () => {
      cleared = true;
      dirty.resolve("thread-1");
    })).toBe(true);
    expect(cleared).toBe(true);
    expect(dirty.has("thread-1")).toBe(false);
  });

  test("keeps read and mutation errors owned while background polling recovers", () => {
    const mutation = { owner: "mutation" as const, message: "Turn failed" };
    const read = { owner: "read" as const, message: "Thread read failed" };
    const background = { owner: "background" as const, message: "Poll failed" };
    expect(replaceOwnedError(mutation, background)).toBe(mutation);
    expect(replaceOwnedError(read, background)).toBe(read);
    expect(clearOwnedError(mutation, "background")).toBe(mutation);
    expect(clearOwnedError(mutation, "read")).toBe(mutation);
    expect(clearOwnedError(read, "read")).toBeNull();
    expect(clearOwnedError(background, "background")).toBeNull();
  });

  test("keeps a failed selected-thread read dirty until its retry succeeds", () => {
    const dirty = new DirtyThreadReads();
    dirty.mark("thread-1");
    expect(dirty.has("thread-1")).toBe(true);
    expect(dirty.has("thread-2")).toBe(false);

    // A failed retry leaves the marker intact; only an authoritative read resolves it.
    expect(dirty.has("thread-1")).toBe(true);
    dirty.resolve("thread-1");
    expect(dirty.has("thread-1")).toBe(false);
  });

  test("resolves aggregator-wide request threads to their project", () => {
    const machines: MachineDto[] = [{
      machineId: "machine-b",
      projectCwd: "/host/project-b",
      containerId: "container-b",
      state: "active",
      dockerStatus: "running",
      threadIds: ["thread-b"],
    }];
    expect(projectForThread(machines, "thread-b")).toBe("/host/project-b");
    expect(projectForThread(machines, "thread-a")).toBeUndefined();
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
