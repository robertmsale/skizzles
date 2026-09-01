import { afterEach, describe, expect, test } from "bun:test";
import type { AppServerAggregator } from "../src/aggregator.ts";
import { AggregatorBridge } from "../src/bridge.ts";
import type { RpcOutcome, RpcRequest } from "../src/protocol.ts";
import { RestApiServer } from "../src/rest.ts";
import {
  SSE_HARD_EVENT_BYTES,
  SSE_HEARTBEAT_MS,
  SSE_MAX_QUEUE_BYTES,
  SseHeartbeatHub,
  SseSession,
  batchSseItems,
  encodeSseEvent,
  timelineEntryForStream,
  type SseIntervalScheduler,
  type TimelineEntryDto,
} from "../src/sse.ts";
import { AggregatorState } from "../src/state.ts";
import {
  eventPageNeedsReconciliation,
  eventPageNeedsSelectedThreadRead,
} from "../src/web/model.ts";

const servers: RestApiServer[] = [];
const states: AggregatorState[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  for (const state of states.splice(0)) state.close();
});

describe("aggregator SSE API", () => {
  test("keeps global snapshots authenticated and projects thread bindings, status, and pending requests", async () => {
    const { bridge, origin, state } = harness({ token: "sse-secret" });
    state.saveProject({ cwd: "/project", cloneUrl: "https://example.test/project.git" }, 1);
    state.saveMachine({ machineId: "host", kind: "host" }, 1);
    state.saveThread(storedThread("thread-1", { status: { type: "idle" } }), 1);
    const approval: RpcRequest = {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", command: "bun test" },
    };
    await bridge.send(approval);

    expect((await fetch(`${origin}/v1/app-state/stream`)).status).toBe(401);
    const response = await fetch(`${origin}/v1/app-state/stream`, {
      headers: { authorization: "Bearer sse-secret" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const reader = new SseReader(response);
    const snapshot = await reader.through("snapshot.end");
    expect(snapshot.slice(0, -1).every((event) => event.id === undefined)).toBe(true);
    expect(snapshot.at(-1)?.id).toMatch(/:\d+$/);
    const project = data(snapshot, "snapshot.projects").projects as Array<Record<string, unknown>>;
    expect(project).toEqual([{ cwd: "/project", cloneUrl: "https://example.test/project.git", createdAt: 1, updatedAt: 1 }]);
    const threads = data(snapshot, "snapshot.threads").threads as Array<Record<string, unknown>>;
    expect(threads[0]).toMatchObject({
      id: "thread-1",
      projectCwd: "/project",
      machineId: "host",
      executionMode: "host",
      loaded: true,
      archived: false,
      status: { type: "idle" },
    });
    const requests = data(snapshot, "snapshot.requests").requests as Array<Record<string, unknown>>;
    expect(requests[0]).toMatchObject({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      projectCwd: "/project",
    });

    bridge.settleServerRequest("approval-1");
    const resolved = await reader.nextEvent();
    expect(resolved.event).toBe("server-request.resolved");
    expect(resolved.data).toMatchObject({ id: "approval-1", threadId: "thread-1", projectCwd: "/project" });
    await reader.cancel();
    await waitFor(() => bridge.eventSubscriberCount === 0);
  });

  test("routes legacy conversationId approvals through selected-thread snapshots and live events", async () => {
    const { bridge, origin, state } = harness();
    state.saveProject({ cwd: "/project", cloneUrl: "https://example.test/project.git" }, 1);
    state.saveMachine({ machineId: "host", kind: "host" }, 1);
    state.saveThread(storedThread("thread-1"), 1);
    bridge.thread = { id: "thread-1", turns: [] };
    await bridge.send({
      id: "legacy-snapshot",
      method: "execCommandApproval",
      params: { conversationId: "thread-1", command: "bun test" },
    });

    const reader = new SseReader(await fetch(`${origin}/v1/threads/thread-1/stream`));
    const snapshot = await reader.through("snapshot.end");
    const requests = data(snapshot, "snapshot.requests").requests as Array<Record<string, unknown>>;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      id: "legacy-snapshot",
      method: "execCommandApproval",
      threadId: "thread-1",
      projectCwd: "/project",
      request: { params: { conversationId: "thread-1" } },
    });

    bridge.settleServerRequest("legacy-snapshot");
    expect(await reader.nextEvent()).toMatchObject({
      event: "server-request.resolved",
      data: { id: "legacy-snapshot", threadId: "thread-1", projectCwd: "/project" },
    });
    await bridge.send({
      id: "legacy-live",
      method: "applyPatchApproval",
      params: { conversationId: "thread-1", patch: "x".repeat(4_300_000) },
    });
    expect(await reader.nextEvent()).toMatchObject({
      event: "server-request.pending",
      data: {
        request: {
          id: "legacy-live",
          threadId: "thread-1",
          projectCwd: "/project",
          hydrationHref: "/v1/server-requests",
        },
      },
    });
    bridge.settleServerRequest("legacy-live");
    expect(await reader.nextEvent()).toMatchObject({
      event: "server-request.resolved",
      data: { id: "legacy-live", threadId: "thread-1", projectCwd: "/project" },
    });
    await reader.cancel();
  });

  test("streams the newest 50 finalized entries, buffers snapshot-time events, collapses deltas, and hydrates oversized items", async () => {
    const { bridge, origin, state } = harness();
    state.saveMachine({ machineId: "host", kind: "host" }, 1);
    state.saveThread(storedThread("thread-1"), 1);
    const items = Array.from({ length: 60 }, (_, index) => ({
      id: `item-${index}`,
      type: "agentMessage",
      text: index === 59 ? "x".repeat(SSE_HARD_EVENT_BYTES + 10_000) : `message ${index}`,
    }));
    bridge.thread = { id: "thread-1", turns: [{ id: "turn-1", status: "completed", items }] };
    bridge.pauseRead = true;

    const responsePromise = fetch(`${origin}/v1/threads/thread-1/stream?tail=50`);
    await waitFor(() => bridge.readStarted);
    for (let index = 0; index < 100; index++) {
      await bridge.send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", itemId: "live-item", delta: `secret-piece-${index}` },
      });
    }
    await bridge.send({
      method: "item/completed",
      params: { threadId: "thread-1", turnId: "live-turn", item: { id: "live-item", type: "agentMessage", text: "final" } },
    });
    await bridge.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "live-turn", status: "completed", items: [{ huge: "not streamed" }] } },
    });
    bridge.releaseRead();

    const reader = new SseReader(await responsePromise);
    const received = await reader.through("turn.completed");
    const snapshotEnd = received.findIndex((event) => event.event === "snapshot.end");
    const snapshotEntries = received
      .filter((event) => event.event === "snapshot.entries")
      .flatMap((event) => (event.data.entries ?? []) as Array<Record<string, unknown>>);
    expect(snapshotEntries).toHaveLength(50);
    expect(snapshotEntries[0]?.id).toBe("item-10");
    expect(snapshotEntries.at(-1)).toMatchObject({
      kind: "available",
      id: "item-59",
      hydrationHref: "/v1/threads/thread-1/entries/item-59",
    });
    expect(data(received, "snapshot.end").history).toEqual({
      count: 50,
      tail: 50,
      olderCursor: "entry:a",
      hasOlder: true,
    });

    const live = received.slice(snapshotEnd + 1);
    expect(live.filter((event) => event.event === "thread.responding")).toHaveLength(1);
    expect(live.map((event) => event.event)).toEqual(["thread.responding", "item.completed", "turn.completed"]);
    expect(live.map((event) => event.id?.split(":").at(-1))).toEqual(["1", "101", "102"]);
    expect(JSON.stringify(live)).not.toContain("secret-piece");
    expect(live.find((event) => event.event === "item.completed")?.data).toMatchObject({
      threadId: "thread-1",
      item: { id: "live-item", item: { text: "final" } },
    });

    const history = await fetchJson(`${origin}/v1/threads/thread-1/entries?before=entry:a&limit=5`);
    expect(history.body).toMatchObject({
      data: [{ id: "item-5" }, { id: "item-6" }, { id: "item-7" }, { id: "item-8" }, { id: "item-9" }],
      olderCursor: "entry:5",
      hasOlder: true,
    });
    const newest = await fetchJson(`${origin}/v1/threads/thread-1/entries?limit=1`);
    expect(newest.body).toMatchObject({
      data: [{ kind: "available", id: "item-59", hydrationHref: "/v1/threads/thread-1/entries/item-59" }],
    });
    const hydrated = await fetchJson(`${origin}/v1/threads/thread-1/entries/item-59`);
    expect((hydrated.body as { entry: { item: { text: string } } }).entry.item.text.length).toBeGreaterThan(SSE_HARD_EVENT_BYTES);
    expect(received.every((event) => event.bytes < SSE_HARD_EVENT_BYTES)).toBe(true);
    await reader.cancel();
  });

  test("filters and collapses snapshot-handoff traffic before applying subscription bounds", async () => {
    const { bridge, origin, state } = harness();
    state.saveMachine({ machineId: "host", kind: "host" }, 1);
    state.saveThread(storedThread("thread-1"), 1);
    bridge.thread = { id: "thread-1", turns: [] };
    bridge.pauseRead = true;

    const responsePromise = fetch(`${origin}/v1/threads/thread-1/stream`);
    await waitFor(() => bridge.readStarted);
    for (let index = 0; index < 2_001; index++) {
      await bridge.send({
        method: "item/agentMessage/delta",
        params: { threadId: "other-thread", itemId: "other-item", delta: `irrelevant-${index}` },
      });
    }
    for (let index = 0; index < 2_001; index++) {
      await bridge.send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", itemId: "selected-item", delta: `discarded-${index}` },
      });
    }
    const subscriberCountDuringSnapshot = bridge.eventSubscriberCount;
    bridge.releaseRead();

    const response = await responsePromise;
    expect(subscriberCountDuringSnapshot).toBe(1);
    expect(response.status).toBe(200);
    const reader = new SseReader(response);
    const received = await reader.through("thread.responding");
    expect(received.filter((event) => event.event === "thread.responding")).toHaveLength(1);
    expect(received.at(-1)?.data).toMatchObject({ threadId: "thread-1" });
    expect(JSON.stringify(received)).not.toContain("irrelevant-");
    expect(JSON.stringify(received)).not.toContain("discarded-");
    await reader.cancel();
  });

  test("does not seed deduplication from a status-less in-flight snapshot item", async () => {
    const { bridge, origin, state } = harness();
    state.saveMachine({ machineId: "host", kind: "host" }, 1);
    state.saveThread(storedThread("thread-1"), 1);
    bridge.thread = {
      id: "thread-1",
      turns: [
        {
          id: "settled-turn",
          status: "completed",
          items: [{ id: "settled-item", type: "agentMessage", text: "already final" }],
        },
        {
          id: "active-turn",
          status: "inProgress",
          items: [{ id: "active-item", type: "agentMessage", text: "partial" }],
        },
      ],
    };
    bridge.pauseRead = true;

    const responsePromise = fetch(`${origin}/v1/threads/thread-1/stream`);
    await waitFor(() => bridge.readStarted);
    await bridge.send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "active-turn",
        item: { id: "active-item", type: "agentMessage", text: "complete" },
      },
    });
    await bridge.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "active-turn", status: "completed" } },
    });
    bridge.releaseRead();

    const reader = new SseReader(await responsePromise);
    const received = await reader.through("turn.completed");
    const snapshotEnd = received.findIndex((event) => event.event === "snapshot.end");
    const snapshotEntries = received
      .slice(0, snapshotEnd)
      .filter((event) => event.event === "snapshot.entries")
      .flatMap((event) => (event.data.entries ?? []) as Array<Record<string, unknown>>);
    expect(snapshotEntries.map((entry) => entry.id)).toEqual(["settled-item"]);
    expect(JSON.stringify(snapshotEntries)).not.toContain("partial");

    const live = received.slice(snapshotEnd + 1);
    expect(live.map((event) => event.event)).toEqual(["item.completed", "turn.completed"]);
    expect(live.filter((event) => event.event === "item.completed")).toHaveLength(1);
    expect(live[0]?.data).toMatchObject({
      threadId: "thread-1",
      item: { id: "active-item", item: { text: "complete" } },
    });
    await reader.cancel();
  });

  test("retains prior status-less completions and opaque delta-named finalized payload keys", async () => {
    const { bridge, origin, state } = harness();
    state.saveMachine({ machineId: "host", kind: "host" }, 1);
    state.saveThread(storedThread("thread-1"), 1);
    const finalized = {
      id: "completed-before-selection",
      type: "functionCallOutput",
      output: {
        deltaCount: 3,
        nested: { deltaLabel: "opaque application data" },
      },
    };
    bridge.thread = {
      id: "thread-1",
      turns: [{ id: "active-turn", status: "inProgress", items: [finalized] }],
    };
    await bridge.send({
      method: "item/completed",
      params: { threadId: "thread-1", turnId: "active-turn", item: finalized },
    });

    const reader = new SseReader(await fetch(`${origin}/v1/threads/thread-1/stream`));
    const snapshot = await reader.through("snapshot.end");
    const entries = snapshot
      .filter((event) => event.event === "snapshot.entries")
      .flatMap((event) => (event.data.entries ?? []) as Array<Record<string, unknown>>);
    expect(entries).toEqual([expect.objectContaining({
      id: "completed-before-selection",
      item: expect.objectContaining({ output: finalized.output }),
    })]);
    expect(bridge.completedItemIds("thread-1")).toEqual(new Set(["completed-before-selection"]));

    const history = await fetchJson(`${origin}/v1/threads/thread-1/entries?limit=1`);
    expect(history.body).toMatchObject({ data: [{ item: { output: finalized.output } }] });
    const hydrated = await fetchJson(`${origin}/v1/threads/thread-1/entries/completed-before-selection`);
    expect(hydrated.body).toMatchObject({ entry: { item: { output: finalized.output } } });

    await bridge.send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "active-turn",
        item: {
          id: "completed-live",
          type: "functionCallOutput",
          output: { deltaCount: 4, deltaDescription: "also opaque" },
        },
      },
    });
    expect((await reader.nextEvent()).data).toMatchObject({
      item: { id: "completed-live", item: { output: { deltaCount: 4, deltaDescription: "also opaque" } } },
    });
    await reader.cancel();
    await bridge.send({ method: "thread/deleted", params: { threadId: "thread-1" } });
    expect(bridge.completedItemIds("thread-1").size).toBe(0);
  });

  test("streams a valid initial thread snapshot larger than the bounded live queue", async () => {
    const { bridge, origin, state } = harness();
    state.saveMachine({ machineId: "host", kind: "host" }, 1);
    state.saveThread(storedThread("thread-1"), 1);
    bridge.thread = {
      id: "thread-1",
      turns: [{
        id: "large-turn",
        status: "completed",
        items: Array.from({ length: 50 }, (_, index) => ({
          id: `large-${index}`,
          type: "agentMessage",
          text: `${index}:`.padEnd(350_000, "x"),
        })),
      }],
    };

    const response = await fetch(`${origin}/v1/threads/thread-1/stream?tail=50`);
    expect(response.status).toBe(200);
    const reader = new SseReader(response);
    const received = await reader.through("snapshot.end");
    const entries = received
      .filter((event) => event.event === "snapshot.entries")
      .flatMap((event) => (event.data.entries ?? []) as Array<Record<string, unknown>>);
    expect(entries).toHaveLength(50);
    expect(entries.every((entry) => entry.kind === "item")).toBe(true);
    expect(received.reduce((bytes, event) => bytes + event.bytes, 0)).toBeGreaterThan(SSE_MAX_QUEUE_BYTES);
    expect(received.every((event) => event.bytes < SSE_HARD_EVENT_BYTES)).toBe(true);
    await reader.cancel();
  });

  test("publishes HTTP-created threads to an already connected global stream", async () => {
    const { bridge, origin, state } = harness();
    state.saveMachine({ machineId: "host", kind: "host" }, 1);
    const hostile = await fetch(`${origin}/v1/app-state/stream`, {
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    });
    expect(hostile.status).toBe(403);
    expect(await hostile.json()).toMatchObject({ error: { code: "forbidden_origin" } });
    const reader = new SseReader(await fetch(`${origin}/v1/app-state/stream`));
    await reader.through("snapshot.end");

    const created = await fetchJson(`${origin}/v1/threads`, {
      method: "POST",
      body: JSON.stringify({ cwd: "/project", skizzlesExecutionMode: "host" }),
    });
    expect(created.status).toBe(201);
    const event = await reader.nextEvent();
    expect(event.event).toBe("thread.upsert");
    expect(event.data.thread).toMatchObject({ id: "http-thread", projectCwd: "/project", machineId: "host" });
    expect(bridge.eventSubscriberCount).toBe(1);
    await reader.cancel();
  });

  test("removes the subscriber immediately when a client aborts during thread snapshot construction", async () => {
    const { bridge, origin, state } = harness();
    state.saveMachine({ machineId: "host", kind: "host" }, 1);
    state.saveThread(storedThread("thread-1"), 1);
    bridge.pauseRead = true;
    const abort = new AbortController();
    const request = fetch(`${origin}/v1/threads/thread-1/stream`, { signal: abort.signal }).catch(() => undefined);
    await waitFor(() => bridge.readStarted && bridge.eventSubscriberCount === 1);
    abort.abort();
    await waitFor(() => bridge.eventSubscriberCount === 0);
    bridge.releaseRead();
    await request;
  });

  test("rejects invalid tail values before registering a journal subscriber", async () => {
    const { bridge, origin, state } = harness();
    state.saveMachine({ machineId: "host", kind: "host" }, 1);
    state.saveThread(storedThread("thread-1"), 1);

    expect(await fetchJson(`${origin}/v1/threads/thread-1/stream?tail=0`)).toEqual({
      status: 400,
      body: { error: { code: "bad_request", message: "tail must be a positive integer" } },
    });
    expect(await fetchJson(`${origin}/v1/threads/thread-1/stream?tail=51`)).toEqual({
      status: 400,
      body: { error: { code: "bad_request", message: "tail must not exceed 50" } },
    });
    expect(bridge.eventSubscriberCount).toBe(0);
    expect(bridge.readStarted).toBe(false);
  });

  test("replays Last-Event-ID cursors and snapshots transparently after expiry or restart", async () => {
    const first = harness();
    first.state.saveMachine({ machineId: "host", kind: "host" }, 1);
    first.state.saveThread(storedThread("thread-1"), 1);
    const initial = new SseReader(await fetch(`${first.origin}/v1/app-state/stream`));
    const initialFrames = await initial.through("snapshot.end");
    const snapshotId = initialFrames.at(-1)!.id!;
    await initial.cancel();

    await first.bridge.send({ method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "active" } } });
    await first.bridge.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    const replay = new SseReader(await fetch(`${first.origin}/v1/app-state/stream`, {
      headers: { "last-event-id": snapshotId },
    }));
    const replayed = await replay.through("turn.started");
    expect(replayed.map((event) => event.event)).toEqual(["stream.ready", "thread.status", "turn.started"]);
    expect(replayed.map((event) => event.id?.split(":").at(-1))).toEqual(["0", "1", "2"]);
    await replay.cancel();

    for (let index = 0; index < 2_001; index++) {
      await first.bridge.send({ method: "configWarning", params: { index } });
    }
    const expired = new SseReader(await fetch(`${first.origin}/v1/app-state/stream`, {
      headers: { "last-event-id": snapshotId },
    }));
    const expiredBegin = await expired.nextEvent();
    expect(expiredBegin.event).toBe("snapshot.begin");
    expect(expiredBegin.data.reset).toMatchObject({ reason: "cursor_expired", requestedCursor: 0 });
    await expired.cancel();

    const second = harness();
    const restarted = new SseReader(await fetch(`${second.origin}/v1/app-state/stream`, {
      headers: { "last-event-id": snapshotId },
    }));
    const restartedBegin = await restarted.nextEvent();
    expect(restartedBegin.event).toBe("snapshot.begin");
    expect(restartedBegin.data.reset).toMatchObject({ reason: "stream_restarted", requestedCursor: 0 });
    await restarted.cancel();
  });
});

describe("SSE transport bounds", () => {
  test("keeps a real Bun SSE connection alive beyond its default 10-second idle timeout", async () => {
    const heartbeatMilliseconds = 11_000;
    const { origin } = harness({ sseHeartbeatMilliseconds: heartbeatMilliseconds });
    const startedAt = performance.now();
    const reader = new SseReader(await fetch(`${origin}/v1/app-state/stream`));
    await reader.through("snapshot.end");
    expect(await reader.nextComment(heartbeatMilliseconds + 2_000)).toBe(": heartbeat");
    expect(performance.now() - startedAt).toBeGreaterThan(10_000);
    await reader.cancel();
  }, 15_000);

  test("uses one deterministic 15-second heartbeat timer and clears it after cancellation", async () => {
    let callback: (() => void) | undefined;
    let cleared = 0;
    const scheduler: SseIntervalScheduler = {
      setInterval: (next, milliseconds) => {
        expect(milliseconds).toBe(SSE_HEARTBEAT_MS);
        callback = next;
        return "timer";
      },
      clearInterval: (handle) => {
        expect(handle).toBe("timer");
        cleared += 1;
      },
    };
    const hub = new SseHeartbeatHub(SSE_HEARTBEAT_MS, scheduler);
    let session!: SseSession;
    session = new SseSession([encodeSseEvent("stream:0", "stream.ready", {})], {
      onClose: () => hub.remove(session),
    });
    const reader = session.response().body!.getReader();
    hub.add(session);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: stream.ready");
    callback!();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
    await reader.cancel();
    expect(hub.activeCount).toBe(0);
    expect(cleared).toBe(1);
  });

  test("fails a slow client instead of growing its queue and keeps every data event below the hard ceiling", async () => {
    let closed = 0;
    const session = new SseSession([], { maxQueueEvents: 2, maxQueueBytes: 64, onClose: () => { closed += 1; } });
    session.response();
    await Bun.sleep(0);
    const frame = new TextEncoder().encode("12345678");
    expect(session.enqueue(frame)).toBe(true);
    expect(session.enqueue(frame)).toBe(true);
    expect(session.enqueue(frame)).toBe(true);
    expect(session.enqueue(frame)).toBe(false);
    expect(closed).toBe(1);

    const oversized: TimelineEntryDto = {
      kind: "item",
      id: "huge",
      turnId: "turn",
      item: { id: "huge", text: "x".repeat(SSE_HARD_EVENT_BYTES) },
    };
    const available = timelineEntryForStream(oversized, "thread");
    expect(available.kind).toBe("available");
    const many = Array.from({ length: 20 }, (_, index) => ({ index, text: "x".repeat(100_000) }));
    const batches = batchSseItems("stream:0", "snapshot.entries", "entries", many);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.byteLength <= SSE_HARD_EVENT_BYTES)).toBe(true);
    expect(() => encodeSseEvent("stream:0", "item.completed", oversized)).toThrow("hard limit");
  });

  test("preserves oversized journal methods for polling while SSE emits bounded hydration events", async () => {
    const { bridge, origin, state } = harness();
    state.saveMachine({ machineId: "host", kind: "host" }, 1);
    state.saveThread(storedThread("thread-1", { status: { type: "idle" } }), 1);
    const reader = new SseReader(await fetch(`${origin}/v1/threads/thread-1/stream`));
    await reader.through("snapshot.end");
    const huge = "x".repeat(4 * 1024 * 1024 + 1_024);

    await bridge.send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "oversized-item", type: "functionCallOutput", output: { content: huge } },
      },
    });
    expect(await reader.nextEvent()).toMatchObject({
      event: "item.available",
      data: {
        threadId: "thread-1",
        item: {
          id: "oversized-item",
          turnId: "turn-1",
          hydrationHref: "/v1/threads/thread-1/entries/oversized-item",
        },
      },
    });

    await bridge.send({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "systemError", detail: huge } },
    });
    expect((await reader.nextEvent()).event).toBe("thread.upsert");

    const page = bridge.eventPage(0, 10);
    const itemRecord = page.data.find((record) => record.event.method === "item/completed");
    const statusRecord = page.data.find((record) => record.event.method === "thread/status/changed");
    expect(itemRecord?.event.params).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "oversized-item",
      oversizedBytes: expect.any(Number),
    });
    expect(statusRecord?.event.params).toMatchObject({
      threadId: "thread-1",
      oversizedBytes: expect.any(Number),
    });
    expect(page.data.some((record) => record.event.method === "skizzles/event/oversized")).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(page.data))).toBeLessThan(4_096);
    expect(eventPageNeedsSelectedThreadRead(itemRecord ? [itemRecord] : [], "thread-1")).toBe(true);
    expect(eventPageNeedsReconciliation(statusRecord ? [statusRecord] : [])).toBe(true);
    await reader.cancel();
  });
});

class TestBridge extends AggregatorBridge {
  thread: Record<string, unknown> = { id: "thread-1", turns: [] };
  pauseRead = false;
  readStarted = false;
  private releaseReadPromise: (() => void) | undefined;

  constructor(private readonly state: AggregatorState) {
    super();
    this.bind({ handle: async () => undefined } as unknown as AppServerAggregator);
  }

  override async ensureReady(): Promise<RpcOutcome> {
    return { result: {} };
  }

  override async call(method: string, params?: unknown): Promise<RpcOutcome> {
    if (method === "thread/read") {
      this.readStarted = true;
      if (this.pauseRead) await new Promise<void>((resolve) => { this.releaseReadPromise = resolve; });
      return { result: { thread: structuredClone(this.thread) } };
    }
    if (method === "thread/start") {
      const request = asRecord(params);
      const thread = { id: "http-thread", cwd: request.cwd, status: { type: "idle" }, turns: [] };
      this.state.saveThread({
        threadId: "http-thread",
        machineId: "host",
        projectCwd: typeof request.cwd === "string" ? request.cwd : "/project",
        executionMode: "host",
        snapshot: thread as Record<string, unknown> & { id: string },
        loaded: true,
        archived: false,
        deleted: false,
      });
      await this.send({ method: "thread/started", params: { thread } });
      return { result: { thread } };
    }
    return { result: {} };
  }

  releaseRead(): void {
    this.pauseRead = false;
    this.releaseReadPromise?.();
    this.releaseReadPromise = undefined;
  }
}

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";

  constructor(response: Response) {
    if (!response.body) throw new Error("SSE response has no body");
    this.reader = response.body.getReader();
  }

  async through(eventName: string): Promise<SseBlock[]> {
    const events: SseBlock[] = [];
    while (events.at(-1)?.event !== eventName) events.push(await this.nextEvent());
    return events;
  }

  async nextEvent(): Promise<SseBlock> {
    while (true) {
      const raw = await this.nextRawBlock(5_000);
      if (!raw.startsWith(":")) return parseBlock(raw);
    }
  }

  async nextComment(timeoutMilliseconds: number): Promise<string> {
    while (true) {
      const raw = await this.nextRawBlock(timeoutMilliseconds);
      if (raw.startsWith(":")) return raw;
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }

  private async nextRawBlock(timeoutMilliseconds: number): Promise<string> {
    while (true) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator >= 0) {
        const raw = this.buffer.slice(0, separator);
        this.buffer = this.buffer.slice(separator + 2);
        return raw;
      }
      const result = await Promise.race([
        this.reader.read(),
        Bun.sleep(timeoutMilliseconds).then(() => { throw new Error("timed out reading SSE frame"); }),
      ]);
      if (result.done) throw new Error("SSE stream ended before the expected frame");
      this.buffer += new TextDecoder().decode(result.value, { stream: true });
    }
  }
}

type SseBlock = {
  id?: string;
  event: string;
  data: Record<string, unknown>;
  bytes: number;
};

function parseBlock(raw: string): SseBlock {
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
  }
  const id = fields.get("id");
  return {
    ...(id === undefined ? {} : { id }),
    event: fields.get("event") ?? "message",
    data: JSON.parse(fields.get("data") ?? "{}") as Record<string, unknown>,
    bytes: Buffer.byteLength(`${raw}\n\n`),
  };
}

function data(events: SseBlock[], eventName: string): Record<string, unknown> {
  const event = events.find((candidate) => candidate.event === eventName);
  if (!event) throw new Error(`missing ${eventName}`);
  return event.data;
}

function harness(options: { token?: string; sseHeartbeatMilliseconds?: number } = {}): {
  bridge: TestBridge;
  origin: string;
  state: AggregatorState;
} {
  const state = new AggregatorState(":memory:");
  states.push(state);
  const bridge = new TestBridge(state);
  const server = new RestApiServer(bridge, {
    hostname: "127.0.0.1",
    port: 0,
    state,
    ...(options.token ? { token: options.token } : {}),
    ...(options.sseHeartbeatMilliseconds === undefined
      ? {}
      : { sseHeartbeatMilliseconds: options.sseHeartbeatMilliseconds }),
  });
  servers.push(server);
  return { bridge, origin: server.start().origin, state };
}

function storedThread(threadId: string, extra: Record<string, unknown> = {}) {
  return {
    threadId,
    machineId: "host",
    projectCwd: "/project",
    executionMode: "host" as const,
    snapshot: { id: threadId, cwd: "/project", ...extra },
    loaded: true,
    archived: false,
    deleted: false,
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  return { status: response.status, body: await response.json() };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("timed out waiting for test condition");
}
