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

    await harness.aggregator.handle({ method: "thread/list", id: 4, params: { limit: 10 } });
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
    expect(harness.factory.transports[0]!.destroyed).toBe(true);

    await harness.aggregator.handle({ method: "thread/list", id: 4, params: { archived: true } });
    expect(resultFor(harness.output.messages, 4)).toMatchObject({
      data: [{ id: threadId, status: { type: "notLoaded" } }],
    });
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
      transport.emit({
        id: message.id,
        result: {
          userAgent: "fake-codex/0.149.1",
          codexHome: "/codex-home",
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
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
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  constructor(readonly index: number, private readonly onWrite: (message: RpcMessage) => Promise<void>) {
    this.machineId = `machine-${index}`;
    this.containerId = `container-${index}`;
    this.stdout = new ReadableStream<Uint8Array>({ start: (controller) => { this.controller = controller; } });
  }

  async write(line: string): Promise<void> {
    const message = JSON.parse(line) as RpcMessage;
    this.writes.push(structuredClone(message));
    await this.onWrite(message);
  }

  emit(message: RpcMessage): void {
    this.controller.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }

  async destroy(): Promise<void> {
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
    turns: [],
  };
}

function resultFor(messages: RpcMessage[], id: RpcId): unknown {
  const message = messages.find((candidate) => !("method" in candidate) && "id" in candidate && candidate.id === id);
  if (!message || !("result" in message)) throw new Error(`missing result for ${String(id)}`);
  return message.result;
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
