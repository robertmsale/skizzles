import { describe, expect, test } from "bun:test";
import { AppServerAggregator } from "../src/aggregator.ts";
import type { BackendFactory, BackendTransport } from "../src/backend.ts";
import { CONTAINER_WORKSPACE } from "../src/docker.ts";
import type { MessageSink } from "../src/jsonl.ts";
import type { RpcId, RpcMessage } from "../src/protocol.ts";

describe("Codex app-server aggregation", () => {
  test("preserves minted thread ids, forces container cwd, and answers topology reads itself", async () => {
    const harness = createHarness();
    await initialize(harness);

    await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: "/host/worktree" } });
    await harness.aggregator.handle({ method: "thread/start", id: 3, params: { cwd: "/another/host/worktree" } });

    const firstId = harness.factory.threadId(0);
    const secondId = harness.factory.threadId(1);
    expect(resultFor(harness.output.messages, 2)).toMatchObject({ thread: { id: firstId } });
    expect(resultFor(harness.output.messages, 3)).toMatchObject({ thread: { id: secondId } });
    expect(harness.factory.transports[0]!.request("thread/start")?.params).toMatchObject({ cwd: CONTAINER_WORKSPACE });
    expect(harness.factory.transports[1]!.request("thread/start")?.params).toMatchObject({ cwd: CONTAINER_WORKSPACE });

    await harness.aggregator.handle({
      method: "thread/list",
      id: 4,
      params: { limit: 10 },
    });
    const listed = resultFor(harness.output.messages, 4) as { data: Array<{ id: string }> };
    expect(listed.data.map((thread) => thread.id).sort()).toEqual([firstId, secondId].sort());
    expect(harness.factory.transports.every((transport) => transport.request("thread/list") === undefined)).toBe(true);

    await harness.aggregator.handle({ method: "thread/fork", id: 5, params: { threadId: firstId } });
    const forkId = harness.factory.forkId(0);
    expect(resultFor(harness.output.messages, 5)).toMatchObject({ thread: { id: forkId, forkedFromId: firstId } });
    await harness.aggregator.handle({ method: "turn/start", id: 6, params: { threadId: forkId, input: [] } });
    expect(harness.factory.transports[0]!.request("turn/start")).toBeDefined();
    expect(harness.factory.transports[1]!.request("turn/start")).toBeUndefined();

    await harness.aggregator.close();
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
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: {} });
    await harness.aggregator.handle({ method: "thread/start", id: 3, params: {} });

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
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: {} });
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
    await harness.aggregator.close();
  });

  test("waits for backend cascade notifications before removing a fork-bearing container", async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: {} });
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
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: {} });
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
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: {} });
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
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: {} });
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
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: {} });
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
    await harness.aggregator.handle({ method: "thread/start", id: 2, params: {} });
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
});

class CaptureSink implements MessageSink {
  readonly messages: RpcMessage[] = [];

  async send(message: RpcMessage): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}

class FakeFactory implements BackendFactory {
  readonly transports: FakeTransport[] = [];
  archiveMode: "missing" | "cascade" | "notificationFirst" = "missing";
  initializeDelayMs = 0;

  async create(): Promise<BackendTransport> {
    const index = this.transports.length;
    const transport = new FakeTransport(index, (message) => this.handle(index, message));
    this.transports.push(transport);
    return transport;
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

function createHarness() {
  const factory = new FakeFactory();
  const output = new CaptureSink();
  const aggregator = new AppServerAggregator({ factory, output });
  return { factory, output, aggregator };
}

async function initialize(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.aggregator.handle({
    method: "initialize",
    id: 1,
    params: {
      clientInfo: { name: "test", title: "Test", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    },
  });
  expect(resultFor(harness.output.messages, 1)).toMatchObject({ codexHome: "/codex-home", platformOs: "linux" });
  await harness.aggregator.handle({ method: "initialized" });
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
