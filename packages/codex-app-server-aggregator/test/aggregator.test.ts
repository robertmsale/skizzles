import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerAggregator } from "../src/aggregator.ts";
import type { BackendFactory, BackendTransport } from "../src/backend.ts";
import { CONTAINER_WORKSPACE } from "../src/docker.ts";
import type { MessageSink } from "../src/jsonl.ts";
import { ProjectRegistry } from "../src/projects.ts";
import type { RpcId, RpcMessage } from "../src/protocol.ts";
import { AggregatorState, type RegisteredProject, type StoredThread } from "../src/state.ts";

const HOST_PROJECT_A = join(tmpdir(), "skizzles-aggregator-project-a");
const HOST_PROJECT_B = join(tmpdir(), "skizzles-aggregator-project-b");

describe("Codex app-server aggregation", () => {
  test("allows initialization to retry after a failed provisioning attempt", async () => {
    const harness = createHarness();
    harness.factory.createFailures = 1;
    const params = {
      clientInfo: { name: "test", title: "Test", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    };

    await harness.aggregator.handle({ method: "initialize", id: "failed-init", params });
    expect(errorFor(harness.output.messages, "failed-init")).toEqual({
      code: -32603,
      message: "fake provisioning failure",
    });
    await harness.aggregator.handle({ method: "initialize", id: "retry-init", params });
    expect(resultFor(harness.output.messages, "retry-init")).toMatchObject({ platformOs: "linux" });
    await harness.aggregator.close();
  });

  test("preserves minted thread ids, forces container cwd, and answers topology reads itself", async () => {
    const harness = createHarness();
    await initialize(harness);

    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    await harness.aggregator.handle({ method: "thread/start", id: 3, params: { cwd: HOST_PROJECT_B } });

    const firstId = harness.factory.threadId(0);
    const secondId = harness.factory.threadId(1);
    expect(resultFor(harness.output.messages, 2)).toMatchObject({ thread: { id: firstId, cwd: HOST_PROJECT_A } });
    expect(resultFor(harness.output.messages, 3)).toMatchObject({ thread: { id: secondId, cwd: HOST_PROJECT_B } });
    expect(harness.factory.transports[0]!.request("thread/start")?.params).toMatchObject({ cwd: CONTAINER_WORKSPACE });
    expect(harness.factory.transports[1]!.request("thread/start")?.params).toMatchObject({ cwd: CONTAINER_WORKSPACE });
    expect(harness.factory.projects.map((project) => project.cloneUrl)).toEqual([
      "https://example.test/project-a.git",
      "https://example.test/project-b.git",
    ]);

    await harness.aggregator.handle({
      method: "thread/list",
      id: 4,
      params: { limit: 10 },
    });
    const listed = resultFor(harness.output.messages, 4) as { data: Array<{ id: string }> };
    expect(listed.data.map((thread) => thread.id).sort()).toEqual([firstId, secondId].sort());
    expect(harness.factory.transports.every((transport) => transport.request("thread/list") === undefined)).toBe(true);
    await harness.aggregator.handle({ method: "thread/list", id: "cwd-list", params: { cwd: HOST_PROJECT_B } });
    expect(resultFor(harness.output.messages, "cwd-list")).toMatchObject({ data: [{ id: secondId, cwd: HOST_PROJECT_B }] });
    expect(harness.state.threads().map((thread) => [thread.threadId, thread.projectCwd]).sort()).toEqual([
      [firstId, HOST_PROJECT_A],
      [secondId, HOST_PROJECT_B],
    ].sort());

    await harness.aggregator.handle({ method: "thread/fork", id: 5, params: { threadId: firstId } });
    const forkId = harness.factory.forkId(0);
    expect(resultFor(harness.output.messages, 5)).toMatchObject({ thread: { id: forkId, forkedFromId: firstId } });
    await harness.aggregator.handle({ method: "turn/start", id: 6, params: { threadId: forkId, input: [] } });
    expect(harness.factory.transports[0]!.request("turn/start")).toBeDefined();
    expect(harness.factory.transports[1]!.request("turn/start")).toBeUndefined();

    await harness.aggregator.close();
  });

  test("rejects an unknown cwd without provisioning a container", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({
      method: "thread/start",
      id: 2,
      params: { cwd: join(tmpdir(), "skizzles-unregistered-project") },
    });

    expect(errorFor(harness.output.messages, 2)).toEqual({
      code: -32004,
      message: "thread/start cwd is not a registered project",
    });
    expect(harness.factory.transports).toHaveLength(1);
    expect(harness.factory.transports[0]!.request("thread/start")).toBeUndefined();
    await harness.aggregator.close();
  });

  test("archives through the machine belonging to the selected project", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    await harness.aggregator.handle({ method: "thread/start", id: 3, params: { cwd: HOST_PROJECT_B } });

    await harness.aggregator.handle({
      method: "thread/archive",
      id: 4,
      params: { threadId: harness.factory.threadId(1) },
    });
    expect(harness.factory.transports[0]!.request("thread/archive")).toBeUndefined();
    expect(harness.factory.transports[0]!.destroyed).toBe(false);
    expect(harness.factory.transports[1]!.request("thread/archive")).toBeDefined();
    expect(harness.factory.transports[1]!.destroyed).toBe(true);
    await harness.aggregator.close();
  });

  test("refuses to remove a project with active container-backed threads", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    await harness.aggregator.handle({
      method: "skizzles/project/remove",
      id: 3,
      params: { cwd: HOST_PROJECT_A },
    });

    expect(errorFor(harness.output.messages, 3)).toEqual({ code: -32005, message: "project has active threads" });
    expect(harness.registry.list().map((project) => project.cwd)).toContain(HOST_PROJECT_A);
    expect(harness.factory.transports[0]!.destroyed).toBe(false);
    await harness.aggregator.close();
  });

  test("serializes project removal with delayed thread provisioning", async () => {
    const harness = createHarness();
    await initialize(harness);
    harness.factory.pauseNextCreate = true;

    const starting = harness.aggregator.handle({
      method: "thread/start",
      id: 2,
      params: { cwd: HOST_PROJECT_B },
    });
    await waitFor(() => harness.factory.createBlocked);
    const removing = harness.aggregator.handle({
      method: "skizzles/project/remove",
      id: 3,
      params: { cwd: HOST_PROJECT_B },
    });
    await Bun.sleep(0);
    harness.factory.releaseCreate();
    await Promise.all([starting, removing]);

    expect(resultFor(harness.output.messages, 2)).toMatchObject({ thread: { cwd: HOST_PROJECT_B } });
    expect(errorFor(harness.output.messages, 3)).toEqual({ code: -32005, message: "project has active threads" });
    expect(harness.registry.list().map((project) => project.cwd)).toContain(HOST_PROJECT_B);
    expect(harness.factory.transports[1]!.destroyed).toBe(false);
    await harness.aggregator.close();
  });

  test("replaces an unused warm backend after the registered origin changes", async () => {
    const projectCwd = realpathSync(mkdtempSync(join(tmpdir(), "skizzles-aggregator-origin-")));
    const oldOrigin = "https://example.test/owner/old.git";
    const newOrigin = "https://example.test/owner/new.git";
    await runGit("init", projectCwd);
    await runGit("-C", projectCwd, "remote", "add", "origin", oldOrigin);
    const harness = createHarness([{ cwd: projectCwd, cloneUrl: oldOrigin }]);
    try {
      await initialize(harness);
      expect(harness.factory.projects.map((project) => project.cloneUrl)).toEqual([oldOrigin]);

      await runGit("-C", projectCwd, "remote", "set-url", "origin", newOrigin);
      await harness.aggregator.handle({
        method: "skizzles/project/add",
        id: 2,
        params: { cwd: projectCwd },
      });
      expect(resultFor(harness.output.messages, 2)).toMatchObject({ project: { cloneUrl: newOrigin } });
      expect(harness.factory.transports[0]!.destroyed).toBe(true);

      await harness.aggregator.handle({ method: "thread/start", id: 3, params: { cwd: projectCwd } });
      expect(harness.factory.projects.map((project) => project.cloneUrl)).toEqual([oldOrigin, newOrigin]);
      expect(harness.factory.transports[1]!.request("thread/start")).toBeDefined();
    } finally {
      await harness.aggregator.close();
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  test("does not reorder backend initialization notifications ahead of the initialize result", async () => {
    const harness = createHarness();
    await initialize(harness);
    expect(harness.output.messages[0]).toMatchObject({ id: 1, result: { platformOs: "linux" } });
    expect(harness.output.messages[1]).toMatchObject({ method: "configWarning" });
    await harness.aggregator.close();
  });

  test("does not route aggregate or mutating global requests to an arbitrary container", async () => {
    const harness = createHarness();
    await initialize(harness);

    await harness.aggregator.handle({ method: "project/list", id: 2, params: {} });
    expect(errorFor(harness.output.messages, 2)?.message).toContain("aggregate topology method");
    await harness.aggregator.handle({ method: "config/value/write", id: 3, params: {} });
    expect(errorFor(harness.output.messages, 3)?.message).toContain("no thread routing key");
    await harness.aggregator.close();
  });

  test("correlates colliding backend approval ids without changing approval payloads", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    await harness.aggregator.handle({ method: "thread/start", id: 3, params: { cwd: HOST_PROJECT_A } });

    harness.factory.transports[0]!.emit({
      method: "item/commandExecution/requestApproval",
      id: 7,
      params: { threadId: harness.factory.threadId(0), command: "echo one" },
    });
    harness.factory.transports[1]!.emit({
      method: "item/commandExecution/requestApproval",
      id: 7,
      params: { threadId: harness.factory.threadId(1), command: "echo two" },
    });
    await waitFor(() => approvalRequests(harness.output.messages).length === 2);

    const approvals = approvalRequests(harness.output.messages);
    expect(approvals[0]!.id).not.toBe(approvals[1]!.id);
    expect(approvals.map((message) => message.params)).toEqual([
      { threadId: harness.factory.threadId(0), command: "echo one" },
      { threadId: harness.factory.threadId(1), command: "echo two" },
    ]);

    await harness.aggregator.handle({ id: approvals[0]!.id, result: { decision: "accept" } });
    await harness.aggregator.handle({ id: approvals[1]!.id, result: { decision: "decline" } });
    expect(harness.factory.transports[0]!.response(7)).toEqual({ id: 7, result: { decision: "accept" } });
    expect(harness.factory.transports[1]!.response(7)).toEqual({ id: 7, result: { decision: "decline" } });

    await harness.aggregator.close();
  });

  test("removes a drained container after archive and retains an archived topology record", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    const threadId = harness.factory.threadId(0);

    await harness.aggregator.handle({ method: "thread/archive", id: 3, params: { threadId } });
    expect(resultFor(harness.output.messages, 3)).toEqual({});
    expect(harness.output.messages).toContainEqual(expect.objectContaining({
      method: "thread/archived",
      params: { threadId },
    }));
    expect(harness.factory.transports[0]!.destroyed).toBe(true);

    await harness.aggregator.handle({
      method: "thread/list",
      id: 4,
      params: { archived: true },
    });
    expect(resultFor(harness.output.messages, 4)).toMatchObject({
      data: [{ id: threadId, status: { type: "notLoaded" } }],
    });
    await harness.aggregator.handle({ method: "thread/read", id: 5, params: { threadId, includeTurns: false } });
    expect(resultFor(harness.output.messages, 5)).toMatchObject({ thread: { id: threadId } });
    await harness.aggregator.handle({ method: "thread/unarchive", id: 6, params: { threadId } });
    expect(resultFor(harness.output.messages, 6)).toEqual({});
    await harness.aggregator.handle({ method: "thread/unarchive", id: "unarchive-again", params: { threadId } });
    expect(resultFor(harness.output.messages, "unarchive-again")).toEqual({});
    expect(harness.factory.transports[0]!.request("thread/unarchive")).toBeUndefined();
    expect(harness.factory.transports).toHaveLength(1);
    await harness.aggregator.handle({ method: "thread/list", id: 7, params: { archived: true } });
    expect(resultFor(harness.output.messages, 7)).toMatchObject({ data: [{ id: threadId }] });
    await harness.aggregator.handle({ method: "thread/list", id: 8, params: {} });
    expect(resultFor(harness.output.messages, 8)).toEqual({ data: [], nextCursor: null, backwardsCursor: null });
    await harness.aggregator.handle({ method: "thread/unarchive", id: 9, params: { threadId: "unknown-thread" } });
    expect(errorFor(harness.output.messages, 9)).toEqual({ code: -32004, message: "unknown thread: unknown-thread" });
    await harness.aggregator.close();
  });

  test("archives and deletes recovered threads without their removed backends", async () => {
    const archivedId = "0198f100-7000-7000-8000-000000000000";
    const deletedId = "0198f100-7000-7000-8000-000000000001";
    const recovered = [archivedId, deletedId].map((threadId): StoredThread => ({
      threadId,
      machineId: `recovered-${threadId}`,
      projectCwd: HOST_PROJECT_A,
      snapshot: { ...threadSnapshot(threadId, 10), cwd: HOST_PROJECT_A },
      loaded: false,
      archived: false,
      deleted: false,
    }));
    const harness = createHarness(undefined, recovered);
    await initialize(harness);

    expect(harness.state.threads().every((thread) => !("turns" in (thread.snapshot ?? {})))).toBe(true);
    await harness.aggregator.handle({
      method: "thread/read",
      id: "recovered-read",
      params: { threadId: archivedId, includeTurns: false },
    });
    const recoveredRead = resultFor(harness.output.messages, "recovered-read") as { thread: Record<string, unknown> };
    expect(recoveredRead.thread).not.toHaveProperty("turns");

    await harness.aggregator.handle({ method: "thread/archive", id: 2, params: { threadId: archivedId } });
    await harness.aggregator.handle({ method: "thread/delete", id: 3, params: { threadId: deletedId } });

    expect(resultFor(harness.output.messages, 2)).toEqual({});
    expect(resultFor(harness.output.messages, 3)).toEqual({});
    expect(harness.output.messages).toContainEqual(expect.objectContaining({
      method: "thread/archived",
      params: { threadId: archivedId },
    }));
    expect(harness.output.messages).toContainEqual(expect.objectContaining({
      method: "thread/deleted",
      params: { threadId: deletedId },
    }));
    expect(harness.factory.transports[0]!.request("thread/archive")).toBeUndefined();
    expect(harness.factory.transports[0]!.request("thread/delete")).toBeUndefined();
    expect(harness.state.threads()).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: archivedId, archived: true, deleted: false }),
      expect.objectContaining({ threadId: deletedId, archived: false, deleted: true }),
    ]));
    await harness.aggregator.close();
  });

  test("waits for backend cascade notifications before removing a fork-bearing container", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    const threadId = harness.factory.threadId(0);
    await harness.aggregator.handle({ method: "thread/fork", id: 3, params: { threadId } });
    harness.factory.archiveMode = "cascade";

    await harness.aggregator.handle({ method: "thread/archive", id: 4, params: { threadId } });
    await waitFor(() => harness.factory.transports[0]!.destroyed);
    await harness.aggregator.handle({
      method: "thread/list",
      id: 5,
      params: { archived: true },
    });
    const listed = resultFor(harness.output.messages, 5) as { data: Array<{ id: string }> };
    expect(listed.data.map((thread) => thread.id).sort()).toEqual([
      threadId,
      harness.factory.forkId(0),
    ].sort());
    await harness.aggregator.close();
  });

  test("does not let an archive notification overtake its backend response", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    const threadId = harness.factory.threadId(0);
    harness.factory.archiveMode = "notificationFirst";

    await harness.aggregator.handle({ method: "thread/archive", id: 3, params: { threadId } });
    expect(resultFor(harness.output.messages, 3)).toEqual({});
    expect(harness.factory.transports[0]!.destroyed).toBe(true);
    await harness.aggregator.close();
  });

  test("retries a failed transport teardown during aggregate close", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    const transport = harness.factory.transports[0]!;
    transport.destroyFailures = 1;

    await expect(harness.aggregator.handle({
      method: "thread/archive",
      id: 3,
      params: { threadId: harness.factory.threadId(0) },
    })).rejects.toThrow("fake destroy failure");
    expect(transport.destroyCalls).toBe(1);
    await harness.aggregator.close();
    expect(transport.destroyCalls).toBe(2);
    expect(transport.destroyed).toBe(true);
  });

  test("returns a backend error without stranding a timed pending call when transport write fails", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    harness.factory.transports[0]!.writeFailures = 1;

    await harness.aggregator.handle({
      method: "turn/start",
      id: 3,
      params: { threadId: harness.factory.threadId(0), input: [] },
    });
    expect(errorFor(harness.output.messages, 3)).toEqual({
      code: -32003,
      message: "backend request failed: turn/start",
    });
    await harness.aggregator.close();
  });

  test("includes non-interactive descendants when a relation filter supplies the topology", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    const parentId = harness.factory.threadId(0);
    const childId = `${parentId}-child`;
    harness.factory.transports[0]!.emit({
      method: "thread/started",
      params: {
        thread: {
          ...threadSnapshot(childId, 1),
          parentThreadId: parentId,
          source: { subAgent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
        },
      },
    });
    await waitFor(() => harness.output.messages.some((message) =>
      "method" in message && message.method === "thread/started"
      && (message.params as { thread?: { id?: string } } | undefined)?.thread?.id === childId));

    await harness.aggregator.handle({ method: "thread/list", id: 3, params: {} });
    expect((resultFor(harness.output.messages, 3) as { data: Array<{ id: string }> }).data)
      .toEqual([expect.objectContaining({ id: parentId })]);
    await harness.aggregator.handle({
      method: "thread/list",
      id: 4,
      params: { ancestorThreadId: parentId },
    });
    expect(resultFor(harness.output.messages, 4)).toMatchObject({ data: [{ id: childId }] });
    await harness.aggregator.close();
  });

  test("coalesces concurrent representative-backend provisioning", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    await harness.aggregator.handle({
      method: "thread/archive",
      id: 3,
      params: { threadId: harness.factory.threadId(0) },
    });

    harness.factory.initializeDelayMs = 5;
    const modelList = harness.aggregator.handle({ method: "model/list", id: 4, params: {} });
    await waitFor(() => harness.factory.transports[1]?.request("initialize") !== undefined);
    const configRead = harness.aggregator.handle({ method: "config/read", id: 5, params: {} });
    await Promise.all([modelList, configRead]);
    expect(harness.factory.transports).toHaveLength(2);
    expect(resultFor(harness.output.messages, 4)).toEqual({});
    expect(resultFor(harness.output.messages, 5)).toEqual({});
    await harness.aggregator.close();
  });

  test("excludes a closed thread from loaded topology while its backend remains ready", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    const parentId = harness.factory.threadId(0);
    await harness.aggregator.handle({ method: "thread/fork", id: 3, params: { threadId: parentId } });
    const forkId = harness.factory.forkId(0);

    await harness.aggregator.handle({ method: "thread/loaded/list", id: 4, params: {} });
    expect(resultFor(harness.output.messages, 4)).toEqual({
      data: [parentId, forkId].sort(),
      nextCursor: null,
    });

    harness.factory.transports[0]!.emit({ method: "thread/closed", params: { threadId: parentId } });
    await waitFor(() => harness.output.messages.some((message) =>
      "method" in message && message.method === "thread/closed"));
    await harness.aggregator.handle({ method: "thread/loaded/list", id: 5, params: {} });
    expect(resultFor(harness.output.messages, 5)).toEqual({ data: [forkId], nextCursor: null });
    expect(harness.factory.transports[0]!.destroyed).toBe(false);
    await harness.aggregator.close();
  });

  test("refreshes preview and activity timestamps before aggregate list filtering and sorting", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    await harness.aggregator.handle({ method: "thread/start", id: 3, params: { cwd: HOST_PROJECT_A } });
    const activeId = harness.factory.threadId(0);
    const otherId = harness.factory.threadId(1);
    harness.factory.transports[0]!.emit({
      method: "thread/started",
      params: { thread: { ...threadSnapshot(activeId, 0), preview: "" } },
    });
    harness.factory.transports[0]!.emit({
      method: "turn/started",
      params: {
        threadId: activeId,
        turn: { id: "turn-1", items: [], startedAt: 100, completedAt: null },
      },
      emittedAtMs: 100_000,
    });
    harness.factory.transports[0]!.emit({
      method: "item/completed",
      params: {
        threadId: activeId,
        turnId: "turn-1",
        completedAtMs: 110_000,
        item: {
          type: "userMessage",
          id: "user-1",
          clientId: null,
          content: [{
            type: "text",
            text: "ignored model context\n## My request for Codex: fresh searchable request",
            text_elements: [],
          }],
        },
      },
      emittedAtMs: 110_000,
    });
    harness.factory.transports[0]!.emit({
      method: "turn/completed",
      params: {
        threadId: activeId,
        turn: { id: "turn-1", items: [], startedAt: 100, completedAt: 120 },
      },
      emittedAtMs: 120_000,
    });
    harness.factory.transports[0]!.emit({
      method: "item/started",
      params: {
        threadId: activeId,
        turnId: "turn-1",
        startedAtMs: 90_000,
        item: { type: "plan", id: "late-item", text: "out-of-order event" },
      },
      emittedAtMs: 90_000,
    });
    await waitFor(() => harness.output.messages.some((message) =>
      "method" in message && message.method === "item/started"
      && (message.params as { item?: { id?: string } } | undefined)?.item?.id === "late-item"));

    await harness.aggregator.handle({ method: "thread/list", id: 4, params: { searchTerm: "searchable" } });
    expect(resultFor(harness.output.messages, 4)).toMatchObject({
      data: [{ id: activeId, preview: "fresh searchable request", updatedAt: 120, recencyAt: 100 }],
    });
    await harness.aggregator.handle({ method: "thread/list", id: 5, params: { sortKey: "updated_at" } });
    expect((resultFor(harness.output.messages, 5) as { data: Array<{ id: string }> }).data[0]?.id).toBe(activeId);
    await harness.aggregator.handle({ method: "thread/list", id: 6, params: { sortKey: "recency_at" } });
    expect((resultFor(harness.output.messages, 6) as { data: Array<{ id: string }> }).data.map((thread) => thread.id))
      .toEqual([activeId, otherId]);
    await harness.aggregator.close();
  });

  test("keeps topology notifications enabled internally while honoring the client opt-out", async () => {
    const harness = createHarness();
    await initialize(harness, {
      experimentalApi: true,
      optOutNotificationMethods: [
        "configWarning",
        ...TOPOLOGY_NOTIFICATION_METHODS,
      ],
    });

    expect(harness.factory.transports[0]!.request("initialize")?.params).toMatchObject({
      capabilities: { optOutNotificationMethods: ["configWarning"] },
    });
    expect(harness.output.messages.some((message) => "method" in message && message.method === "configWarning")).toBe(false);

    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    const parentId = harness.factory.threadId(0);
    const childId = `${parentId}-child`;
    harness.factory.transports[0]!.emit({
      method: "thread/started",
      params: {
        thread: {
          ...threadSnapshot(childId, 1),
          parentThreadId: parentId,
          source: { subAgent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
        },
      },
    });
    await waitForThread(harness, parentId, childId);
    await harness.aggregator.handle({ method: "turn/start", id: 3, params: { threadId: childId, input: [] } });
    expect(resultFor(harness.output.messages, 3)).toEqual({});

    harness.factory.archiveMode = "cascade";
    await harness.aggregator.handle({ method: "thread/archive", id: 4, params: { threadId: parentId } });
    harness.factory.transports[0]!.emit({ method: "thread/archived", params: { threadId: childId } });
    await waitFor(() => harness.factory.transports[0]!.destroyed);
    expect(harness.output.messages.some((message) =>
      "method" in message && TOPOLOGY_NOTIFICATION_METHODS.has(message.method))).toBe(false);
    await harness.aggregator.close();
  });

  test("answers thread/start when later backend provisioning rejects", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: HOST_PROJECT_A } });
    harness.factory.createFailures = 1;

    await harness.aggregator.handle({ method: "thread/start", id: 3, params: { cwd: HOST_PROJECT_A } });
    expect(errorFor(harness.output.messages, 3)).toEqual({
      code: -32603,
      message: "failed to provision app-server backend",
    });
    expect(harness.factory.transports).toHaveLength(1);
    await harness.aggregator.close();
  });
});

const TOPOLOGY_NOTIFICATION_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "thread/archived",
  "thread/deleted",
  "thread/closed",
  "thread/name/updated",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
]);

class CaptureSink implements MessageSink {
  readonly messages: RpcMessage[] = [];

  async send(message: RpcMessage): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}

class FakeFactory implements BackendFactory {
  readonly transports: FakeTransport[] = [];
  readonly projects: RegisteredProject[] = [];
  archiveMode: "missing" | "cascade" | "notificationFirst" = "missing";
  initializeDelayMs = 0;
  createFailures = 0;
  pauseNextCreate = false;
  createBlocked = false;
  private releaseBlockedCreate: (() => void) | undefined;

  async create(project: RegisteredProject): Promise<BackendTransport> {
    if (this.createFailures > 0) {
      this.createFailures--;
      throw new Error("fake provisioning failure");
    }
    if (this.pauseNextCreate) {
      this.pauseNextCreate = false;
      this.createBlocked = true;
      await new Promise<void>((resolve) => { this.releaseBlockedCreate = resolve; });
      this.createBlocked = false;
      this.releaseBlockedCreate = undefined;
    }
    const index = this.transports.length;
    this.projects.push(project);
    const transport = new FakeTransport(index, (message) => this.handle(index, message));
    this.transports.push(transport);
    return transport;
  }

  releaseCreate(): void {
    const release = this.releaseBlockedCreate;
    if (!release) throw new Error("no fake provisioning call is blocked");
    release();
  }

  threadId(index: number): string {
    return `0198f00${index}-7000-7000-8000-00000000000${index}`;
  }

  forkId(index: number): string {
    return `0198f00${index}-7001-7000-8000-00000000000${index}`;
  }

  private async handle(index: number, message: RpcMessage): Promise<void> {
    if (!("method" in message) || !("id" in message)) return;
    const transport = this.transports[index]!;
    if (message.method === "initialize") {
      if (this.initializeDelayMs > 0) await Bun.sleep(this.initializeDelayMs);
      transport.initialized = true;
      transport.emit({
        id: message.id,
        result: {
          userAgent: "fake-codex/0.149.1",
          codexHome: "/codex-home",
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      transport.emit({ method: "configWarning", params: { summary: "fake warning", details: null } });
      return;
    }
    if (!transport.initialized) {
      transport.emit({ id: message.id, error: { code: -32000, message: "Not initialized" } });
      return;
    }
    if (message.method === "thread/start") {
      const thread = threadSnapshot(this.threadId(index), index);
      transport.emit({ id: message.id, result: { thread, cwd: CONTAINER_WORKSPACE } });
      transport.emit({ method: "thread/started", params: { thread } });
      return;
    }
    if (message.method === "thread/fork") {
      const sourceId = (message.params as { threadId: string }).threadId;
      const thread = { ...threadSnapshot(this.forkId(index), index), forkedFromId: sourceId };
      transport.emit({ id: message.id, result: { thread, cwd: CONTAINER_WORKSPACE } });
      transport.emit({ method: "thread/started", params: { thread } });
      return;
    }
    if (message.method === "thread/archive" || message.method === "thread/delete") {
      const threadId = (message.params as { threadId: string }).threadId;
      if (this.archiveMode === "notificationFirst") {
        transport.emit({ method: "thread/archived", params: { threadId } });
        await Bun.sleep(0);
        transport.emit({ id: message.id, result: {} });
        return;
      }
      if (this.archiveMode === "cascade") {
        transport.emit({ id: message.id, result: {} });
        transport.emit({ method: "thread/archived", params: { threadId } });
        transport.emit({ method: "thread/archived", params: { threadId: this.forkId(index) } });
        return;
      }
      transport.emit({
        id: message.id,
        error: { code: -32600, message: `no rollout found for thread id ${threadId}` },
      });
      return;
    }
    transport.emit({ id: message.id, result: {} });
  }
}

class FakeTransport implements BackendTransport {
  readonly machineId: string;
  readonly containerId: string;
  readonly workspace = CONTAINER_WORKSPACE;
  readonly ready = Promise.resolve();
  readonly stdout: ReadableStream<Uint8Array>;
  readonly writes: RpcMessage[] = [];
  destroyed = false;
  destroyCalls = 0;
  destroyFailures = 0;
  initialized = false;
  writeFailures = 0;
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  constructor(readonly index: number, private readonly onWrite: (message: RpcMessage) => Promise<void>) {
    this.machineId = `machine-${index}`;
    this.containerId = `container-${index}`;
    this.stdout = new ReadableStream<Uint8Array>({ start: (controller) => { this.controller = controller; } });
  }

  async write(line: string): Promise<void> {
    if (this.writeFailures > 0) {
      this.writeFailures--;
      throw new Error("fake write failure");
    }
    const message = JSON.parse(line) as RpcMessage;
    this.writes.push(structuredClone(message));
    await this.onWrite(message);
  }

  emit(message: RpcMessage): void {
    this.controller.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }

  async destroy(): Promise<void> {
    this.destroyCalls++;
    if (this.destroyFailures > 0) {
      this.destroyFailures--;
      throw new Error("fake destroy failure");
    }
    if (this.destroyed) return;
    this.destroyed = true;
    this.controller.close();
  }

  request(method: string): Extract<RpcMessage, { method: string; id: RpcId }> | undefined {
    return this.writes.find((message): message is Extract<RpcMessage, { method: string; id: RpcId }> =>
      "method" in message && "id" in message && message.method === method);
  }

  response(id: RpcId): RpcMessage | undefined {
    return this.writes.find((message) => !("method" in message) && "id" in message && message.id === id);
  }
}

function createHarness(projects: Array<{ cwd: string; cloneUrl: string }> = [
  { cwd: HOST_PROJECT_A, cloneUrl: "https://example.test/project-a.git" },
  { cwd: HOST_PROJECT_B, cloneUrl: "https://example.test/project-b.git" },
], threads: StoredThread[] = []) {
  const factory = new FakeFactory();
  const output = new CaptureSink();
  const state = new AggregatorState(":memory:");
  for (const project of projects) state.saveProject(project);
  for (const thread of threads) state.saveThread(thread);
  const registry = new ProjectRegistry(state);
  const aggregator = new AppServerAggregator({ factory, registry, state, output });
  return { factory, output, aggregator, registry, state };
}

async function initialize(
  harness: ReturnType<typeof createHarness>,
  capabilities: Record<string, unknown> = { experimentalApi: true },
): Promise<void> {
  await harness.aggregator.handle({
    method: "initialize",
    id: 1,
    params: {
      clientInfo: { name: "test", title: "Test", version: "0.1.0" },
      capabilities,
    },
  });
  expect(resultFor(harness.output.messages, 1)).toMatchObject({ codexHome: "/codex-home", platformOs: "linux" });
  await harness.aggregator.handle({ method: "initialized" });
}

async function waitForThread(
  harness: ReturnType<typeof createHarness>,
  ancestorThreadId: string,
  threadId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = `list-${attempt}`;
    await harness.aggregator.handle({ method: "thread/list", id, params: { ancestorThreadId } });
    const result = resultFor(harness.output.messages, id) as { data: Array<{ id: string }> };
    if (result.data.some((thread) => thread.id === threadId)) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for topology thread ${threadId}`);
}

function threadSnapshot(id: string, index: number) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: `thread ${index}`,
    modelProvider: "openai",
    createdAt: index + 1,
    updatedAt: index + 1,
    recencyAt: index + 1,
    status: { type: "idle" },
    cwd: CONTAINER_WORKSPACE,
    source: "vscode",
    turns: [],
  };
}

function resultFor(messages: RpcMessage[], id: RpcId): unknown {
  const message = messages.find((candidate) => !("method" in candidate) && "id" in candidate && candidate.id === id);
  if (!message || !("result" in message)) throw new Error(`missing result for ${String(id)}`);
  return message.result;
}

function errorFor(messages: RpcMessage[], id: RpcId): { code: number; message: string } | undefined {
  const message = messages.find((candidate) => !("method" in candidate) && "id" in candidate && candidate.id === id);
  return message && "error" in message ? message.error : undefined;
}

function approvalRequests(messages: RpcMessage[]) {
  return messages.filter((message): message is Extract<RpcMessage, { method: string; id: RpcId }> =>
    "method" in message && "id" in message && message.method === "item/commandExecution/requestApproval");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("timed out waiting for fake app-server event");
}

async function runGit(...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args[0] ?? "command"} failed`);
}
