import { BackendConnection, type BackendFactory } from "./backend.ts";
import type { MessageSink } from "./jsonl.ts";
import {
  errorOutcome,
  idKey,
  isNotification,
  isRequest,
  isResponse,
  response,
  type RpcId,
  type RpcMessage,
  type RpcOutcome,
  type RpcRequest,
} from "./protocol.ts";
import { Topology, type ThreadListParams } from "./topology.ts";

type ReverseRequest = { backend: BackendConnection; backendId: RpcId };
type CreatedBackend = { connection: BackendConnection; outcome: RpcOutcome; activate: () => Promise<void> };

export type AggregatorOptions = {
  factory: BackendFactory;
  output: MessageSink;
  log?: (message: string) => void;
};

export class AppServerAggregator {
  private readonly topology = new Topology();
  private readonly backends = new Map<string, BackendConnection>();
  private readonly reverseRequests = new Map<string, ReverseRequest>();
  private readonly lifecycleCalls = new Map<BackendConnection, number>();
  private readonly factory: BackendFactory;
  private readonly output: MessageSink;
  private readonly log: (message: string) => void;
  private initialization?: Promise<RpcOutcome>;
  private initialActivation: (() => Promise<void>) | undefined;
  private initializeParams?: unknown;
  private warmBackend: BackendConnection | undefined;
  private globalBackendCreation: Promise<BackendConnection | undefined> | undefined;
  private initialized = false;
  private closed = false;

  constructor(options: AggregatorOptions) {
    this.factory = options.factory;
    this.output = options.output;
    this.log = options.log ?? (() => undefined);
  }

  async handle(message: RpcMessage): Promise<void> {
    if (this.closed) return;
    if (isResponse(message)) {
      await this.handleClientResponse(message.id, "error" in message ? { error: message.error } : { result: message.result });
      return;
    }
    if (isNotification(message)) {
      await this.handleClientNotification(message.method, message.params);
      return;
    }
    if (isRequest(message)) await this.handleClientRequest(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const backends = [...this.backends.values()];
    const results = await Promise.allSettled(backends.map((backend) => backend.close()));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.log(`failed to close backend ${backends[index]!.machineId}: ${reason}`);
      }
    });
    this.backends.clear();
    this.reverseRequests.clear();
    this.lifecycleCalls.clear();
  }

  private async handleClientRequest(request: RpcRequest): Promise<void> {
    if (request.method === "initialize") {
      await this.handleInitialize(request);
      return;
    }
    if (!this.initialization) {
      await this.output.send(response(request.id, errorOutcome(-32000, "Not initialized")));
      return;
    }
    await this.initialization;

    if (request.method === "thread/list") {
      const result = this.topology.list(asRecord(request.params) as ThreadListParams);
      await this.output.send(response(request.id, { result }));
      return;
    }
    if (request.method === "thread/loaded/list") {
      const params = asRecord(request.params);
      const result = this.topology.loaded(new Set(this.backends.keys()), {
        cursor: typeof params.cursor === "string" ? params.cursor : null,
        limit: typeof params.limit === "number" ? params.limit : null,
      });
      await this.output.send(response(request.id, { result }));
      return;
    }
    if (isAggregateTopologyMethod(request.method)) {
      await this.output.send(response(request.id, errorOutcome(
        -32004,
        `aggregate topology method is not implemented by this spike: ${request.method}`,
      )));
      return;
    }
    if (request.method === "thread/start") {
      await this.handleThreadStart(request);
      return;
    }

    const params = asRecord(request.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId && !REPRESENTATIVE_GLOBAL_READS.has(request.method)) {
      await this.output.send(response(request.id, errorOutcome(
        -32004,
        `request has no thread routing key and no aggregate behavior: ${request.method}`,
      )));
      return;
    }
    const backend = threadId ? this.backendForThread(threadId) : await this.globalBackend();
    if (!backend) {
      if (request.method === "thread/read" && threadId && params.includeTurns !== true) {
        const thread = this.topology.snapshot(threadId);
        if (thread) {
          await this.output.send(response(request.id, { result: { thread } }));
          return;
        }
      }
      const message = threadId ? `unknown or unavailable thread: ${threadId}` : "no app-server backend is available";
      await this.output.send(response(request.id, errorOutcome(-32004, message)));
      return;
    }

    const lifecycleRequest = threadId !== undefined
      && (request.method === "thread/archive" || request.method === "thread/delete");
    if (lifecycleRequest) this.beginLifecycleCall(backend);
    let outcome: RpcOutcome;
    try {
      outcome = await backend.call(request.method, request.params);
    } finally {
      if (lifecycleRequest) this.endLifecycleCall(backend);
    }
    const synthesizedLifecycle = threadId !== undefined
      && lifecycleRequest
      && isMissingRollout(outcome, threadId);
    if (synthesizedLifecycle) outcome = { result: {} };
    this.topology.observe(backend.machineId, response(request.id, outcome));
    await this.output.send(response(request.id, outcome));

    if ("result" in outcome && threadId && request.method === "thread/archive") {
      this.topology.markArchived(threadId);
      if (synthesizedLifecycle) {
        await this.output.send({ method: "thread/archived", params: { threadId }, emittedAtMs: Date.now() });
      }
      await this.removeIfDrained(backend);
    } else if ("result" in outcome && threadId && request.method === "thread/delete") {
      this.topology.markDeleted(threadId);
      if (synthesizedLifecycle) {
        await this.output.send({ method: "thread/deleted", params: { threadId }, emittedAtMs: Date.now() });
      }
      await this.removeIfDrained(backend);
    }
  }

  private async handleInitialize(request: RpcRequest): Promise<void> {
    if (this.initialization) {
      await this.output.send(response(request.id, errorOutcome(-32600, "Already initialized")));
      return;
    }
    this.initializeParams = request.params;
    this.initialization = this.createInitializedBackend(true).then(async (backend) => {
      if ("error" in backend.outcome) {
        await backend.connection.close();
        this.backends.delete(backend.connection.machineId);
      } else {
        this.warmBackend = backend.connection;
        this.initialActivation = backend.activate;
      }
      return backend.outcome;
    }).catch((error) => errorOutcome(-32603, error instanceof Error ? error.message : String(error)));
    const outcome = await this.initialization;
    await this.output.send(response(request.id, outcome));
    if ("result" in outcome) await this.initialActivation?.();
  }

  private async handleClientNotification(method: string, params: unknown): Promise<void> {
    if (method !== "initialized") {
      this.log(`ignored unsupported client notification ${method}`);
      return;
    }
    if (!this.initialization) return;
    const outcome = await this.initialization;
    if ("error" in outcome) return;
    this.initialized = true;
    await Promise.all([...this.backends.values()].map((backend) => backend.notify("initialized", params)));
  }

  private async handleThreadStart(request: RpcRequest): Promise<void> {
    let backend = this.warmBackend;
    this.warmBackend = undefined;
    if (!backend) {
      const created = await this.createInitializedBackend();
      if ("error" in created.outcome) {
        await created.connection.close();
        this.backends.delete(created.connection.machineId);
        await this.output.send(response(request.id, created.outcome));
        return;
      }
      backend = created.connection;
      if (this.initialized) await backend.notify("initialized");
    }
    const params: Record<string, unknown> = { ...asRecord(request.params), cwd: backend.workspace };
    if (Array.isArray(params.runtimeWorkspaceRoots)) params.runtimeWorkspaceRoots = [backend.workspace];
    const outcome = await backend.call("thread/start", params);
    this.topology.observe(backend.machineId, response(request.id, outcome));
    await this.output.send(response(request.id, outcome));
    if ("error" in outcome && !this.topology.hasLiveThreads(backend.machineId)) {
      await backend.close();
      this.backends.delete(backend.machineId);
    }
  }

  private async createInitializedBackend(deferEvents = false): Promise<CreatedBackend> {
    const transport = await this.factory.create();
    let active = !deferEvents;
    const queued: Array<() => Promise<void>> = [];
    const forward = (operation: () => Promise<void>): Promise<void> => {
      if (active) return operation();
      queued.push(operation);
      return Promise.resolve();
    };
    const connection = new BackendConnection(transport, {
      onNotification: (backend, notification) => forward(async () => {
        this.topology.observe(backend.machineId, notification);
        await this.output.send(notification);
        if (notification.method === "thread/archived" || notification.method === "thread/deleted") {
          queueMicrotask(() => {
            this.removeIfDrained(backend).catch((error) => {
              this.log(`failed to remove drained backend ${backend.machineId}: ${error instanceof Error ? error.message : String(error)}`);
            });
          });
        }
      }),
      onServerRequest: (backend, serverRequest) => forward(async () => {
        const outerId = `agg/server/${crypto.randomUUID()}`;
        this.reverseRequests.set(idKey(outerId), { backend, backendId: serverRequest.id });
        await this.output.send({ ...serverRequest, id: outerId });
      }),
      onLog: (backend, text) => this.log(`[${backend.machineId}] ${text.trimEnd()}`),
    });
    this.backends.set(connection.machineId, connection);
    const outcome = await connection.initialize(this.initializeParams);
    return {
      connection,
      outcome,
      activate: async () => {
        if (active) return;
        active = true;
        for (const operation of queued.splice(0)) await operation();
      },
    };
  }

  private async globalBackend(): Promise<BackendConnection | undefined> {
    if (this.warmBackend) return this.warmBackend;
    const running = this.backends.values().next().value as BackendConnection | undefined;
    if (running) return running;
    if (!this.globalBackendCreation) {
      const attempt = (async () => {
        const created = await this.createInitializedBackend();
        if ("error" in created.outcome) {
          await created.connection.close();
          this.backends.delete(created.connection.machineId);
          return undefined;
        }
        if (this.initialized) await created.connection.notify("initialized");
        this.warmBackend = created.connection;
        return created.connection;
      })();
      this.globalBackendCreation = attempt;
      attempt.finally(() => {
        if (this.globalBackendCreation === attempt) this.globalBackendCreation = undefined;
      }).catch(() => undefined);
    }
    return this.globalBackendCreation;
  }

  private backendForThread(threadId: string): BackendConnection | undefined {
    const machineId = this.topology.machineFor(threadId);
    return machineId ? this.backends.get(machineId) : undefined;
  }

  private async handleClientResponse(id: RpcId, outcome: RpcOutcome): Promise<void> {
    const reverse = this.reverseRequests.get(idKey(id));
    if (!reverse) {
      this.log(`ignored client response for unknown server request ${String(id)}`);
      return;
    }
    this.reverseRequests.delete(idKey(id));
    await reverse.backend.respond(reverse.backendId, outcome);
  }

  private async removeIfDrained(backend: BackendConnection): Promise<void> {
    if ((this.lifecycleCalls.get(backend) ?? 0) > 0) return;
    if (this.topology.hasLiveThreads(backend.machineId)) return;
    await backend.close();
    this.backends.delete(backend.machineId);
    this.lifecycleCalls.delete(backend);
    for (const [key, reverse] of this.reverseRequests) {
      if (reverse.backend === backend) this.reverseRequests.delete(key);
    }
    if (this.warmBackend === backend) this.warmBackend = undefined;
  }

  private beginLifecycleCall(backend: BackendConnection): void {
    this.lifecycleCalls.set(backend, (this.lifecycleCalls.get(backend) ?? 0) + 1);
  }

  private endLifecycleCall(backend: BackendConnection): void {
    const remaining = (this.lifecycleCalls.get(backend) ?? 1) - 1;
    if (remaining > 0) this.lifecycleCalls.set(backend, remaining);
    else this.lifecycleCalls.delete(backend);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isMissingRollout(outcome: RpcOutcome, threadId: string): boolean {
  return "error" in outcome
    && outcome.error.code === -32600
    && outcome.error.message === `no rollout found for thread id ${threadId}`;
}

function isAggregateTopologyMethod(method: string): boolean {
  return method === "thread/search"
    || method === "thread/searchOccurrences"
    || method.startsWith("project/")
    || method.startsWith("threadSection/");
}

const REPRESENTATIVE_GLOBAL_READS = new Set([
  "account/read",
  "account/rateLimits/read",
  "account/usage/read",
  "account/workspaceMessages/read",
  "app/installed",
  "app/list",
  "app/read",
  "collaborationMode/list",
  "config/read",
  "configRequirements/read",
  "experimentalFeature/list",
  "externalAgentConfig/detect",
  "externalAgentConfig/import/readHistories",
  "getAuthStatus",
  "hooks/list",
  "mcpServerStatus/list",
  "model/list",
  "modelProvider/capabilities/read",
  "permissionProfile/list",
  "plugin/installed",
  "plugin/list",
  "plugin/read",
  "plugin/search",
  "plugin/share/list",
  "plugin/skill/read",
  "server/diagnostics",
  "skills/list",
]);
