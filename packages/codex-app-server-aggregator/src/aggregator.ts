import {
  BackendConnection,
  type BackendFactory,
  type BackendTransport,
  type HostBackendFactory,
} from "./backend.ts";
import {
  DEFAULT_EXECUTION_MODE,
  HOST_MACHINE_ID,
  isExecutionMode,
  type ExecutionMode,
} from "./execution.ts";
import type { MessageSink } from "./jsonl.ts";
import { ProjectRegistry } from "./projects.ts";
import {
  errorOutcome,
  idKey,
  isNotification,
  isRequest,
  isResponse,
  response,
  type RpcId,
  type RpcMessage,
  type RpcNotification,
  type RpcOutcome,
  type RpcRequest,
} from "./protocol.ts";
import { AggregatorState, type RegisteredProject } from "./state.ts";
import { Topology, type ThreadListParams } from "./topology.ts";

type ReverseRequest = { backend: BackendConnection; backendId: RpcId; outerId: RpcId };
type CreatedBackend = { connection: BackendConnection; outcome: RpcOutcome; activate: () => Promise<void> };
type BackendContext = { mode: ExecutionMode; project?: RegisteredProject | undefined };

export type AggregatorOptions = {
  containerFactory: BackendFactory;
  hostFactory: HostBackendFactory;
  registry: ProjectRegistry;
  state: AggregatorState;
  output: MessageSink;
  applyClientNotificationOptOuts?: boolean;
  onServerRequestSettled?: (id: RpcId) => void;
  log?: (message: string) => void;
};

export class AppServerAggregator {
  private readonly topology: Topology;
  private readonly backends = new Map<string, BackendConnection>();
  private readonly backendContexts = new Map<BackendConnection, BackendContext>();
  private readonly readyBackends = new Set<BackendConnection>();
  private readonly reverseRequests = new Map<string, ReverseRequest>();
  private readonly lifecycleCalls = new Map<BackendConnection, number>();
  private readonly containerFactory: BackendFactory;
  private readonly hostFactory: HostBackendFactory;
  private readonly registry: ProjectRegistry;
  private readonly state: AggregatorState;
  private readonly output: MessageSink;
  private readonly applyClientNotificationOptOuts: boolean;
  private readonly onServerRequestSettled: (id: RpcId) => void;
  private readonly log: (message: string) => void;
  private readonly projectLocks = new Map<string, Promise<void>>();
  private readonly clientOptOutNotifications = new Set<string>();
  private initialization?: Promise<RpcOutcome>;
  private initializeParams?: unknown;
  private hostBackend: BackendConnection | undefined;
  private initialized = false;
  private closed = false;

  constructor(options: AggregatorOptions) {
    this.containerFactory = options.containerFactory;
    this.hostFactory = options.hostFactory;
    this.registry = options.registry;
    this.state = options.state;
    this.output = options.output;
    this.applyClientNotificationOptOuts = options.applyClientNotificationOptOuts ?? true;
    this.onServerRequestSettled = options.onServerRequestSettled ?? (() => undefined);
    this.log = options.log ?? (() => undefined);
    this.topology = new Topology({
      threads: this.state.threads(),
      persist: (thread) => this.state.saveThread(thread),
    });
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
      const backend = backends[index]!;
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.log(`failed to close backend ${backend.machineId}: ${reason}`);
      } else {
        this.state.markMachine(backend.machineId, "removed");
      }
    });
    this.backends.clear();
    this.readyBackends.clear();
    this.backendContexts.clear();
    this.hostBackend = undefined;
    for (const reverse of this.reverseRequests.values()) this.onServerRequestSettled(reverse.outerId);
    this.reverseRequests.clear();
    this.lifecycleCalls.clear();
  }

  private async handleClientRequest(request: RpcRequest): Promise<void> {
    const requestParams = asRecord(request.params);
    if (request.method !== "thread/start" && Object.hasOwn(requestParams, "skizzlesExecutionMode")) {
      await this.output.send(response(request.id, errorOutcome(
        -32602,
        "skizzlesExecutionMode may only be selected when creating a new thread",
      )));
      return;
    }
    if (request.method.startsWith("skizzles/project/")) {
      await this.handleProjectRequest(request);
      return;
    }
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
      const result = this.topology.list(requestParams as ThreadListParams);
      await this.output.send(response(request.id, { result }));
      return;
    }
    if (request.method === "thread/loaded/list") {
      const result = this.topology.loaded(new Set([...this.readyBackends].map((backend) => backend.machineId)), {
        cursor: typeof requestParams.cursor === "string" ? requestParams.cursor : null,
        limit: typeof requestParams.limit === "number" ? requestParams.limit : null,
      });
      await this.output.send(response(request.id, { result }));
      return;
    }
    if (request.method === "thread/unarchive") {
      const threadId = requestParams.threadId;
      if (typeof threadId !== "string" || !this.topology.has(threadId)) {
        const detail = typeof threadId === "string" ? threadId : "missing thread id";
        await this.output.send(response(request.id, errorOutcome(-32004, `unknown thread: ${detail}`)));
        return;
      }
      await this.output.send(response(request.id, { result: {} }));
      return;
    }
    if (isAggregateTopologyMethod(request.method)) {
      await this.output.send(response(request.id, errorOutcome(
        -32004,
        `aggregate topology method is not implemented by this aggregator: ${request.method}`,
      )));
      return;
    }
    if (request.method === "thread/start") {
      await this.handleThreadStart(request);
      return;
    }

    const threadId = typeof requestParams.threadId === "string" ? requestParams.threadId : undefined;
    if (!threadId && !HOST_GLOBAL_READS.has(request.method)) {
      await this.output.send(response(request.id, errorOutcome(
        -32004,
        `request has no thread routing key and no aggregate behavior: ${request.method}`,
      )));
      return;
    }
    if (!threadId) {
      await this.handleHostRead(request);
      return;
    }

    const backend = this.backendForThread(threadId);
    if (!backend) {
      if ((request.method === "thread/archive" || request.method === "thread/delete") && this.topology.has(threadId)) {
        if (request.method === "thread/archive") this.topology.markArchived(threadId);
        else this.topology.markDeleted(threadId);
        await this.output.send(response(request.id, { result: {} }));
        await this.sendClientNotification({
          method: request.method === "thread/archive" ? "thread/archived" : "thread/deleted",
          params: { threadId },
          emittedAtMs: Date.now(),
        });
        return;
      }
      if (request.method === "thread/read" && requestParams.includeTurns !== true) {
        const thread = this.topology.snapshot(threadId);
        if (thread) {
          await this.output.send(response(request.id, { result: { thread } }));
          return;
        }
      }
      await this.output.send(response(request.id, errorOutcome(-32004, `unknown or unavailable thread: ${threadId}`)));
      return;
    }

    const projectCwd = this.topology.projectFor(threadId);
    const executionMode = this.topology.modeFor(threadId);
    if (!projectCwd || !executionMode || executionMode !== backend.kind) {
      await this.output.send(response(request.id, errorOutcome(-32004, `thread has an invalid backend binding: ${threadId}`)));
      return;
    }

    const lifecycleRequest = request.method === "thread/archive" || request.method === "thread/delete";
    if (lifecycleRequest) this.beginLifecycleCall(backend);
    let outcome: RpcOutcome;
    try {
      const rawOutcome = await backend.call(
        request.method,
        backendRoutedParams(backend, request.method, request.params),
      );
      outcome = externalizeOutcome(backend, rawOutcome, projectCwd);
    } finally {
      if (lifecycleRequest) this.endLifecycleCall(backend);
    }
    const synthesizedLifecycle = lifecycleRequest && isMissingRollout(outcome, threadId);
    if (synthesizedLifecycle) outcome = { result: {} };
    this.topology.observe(backend.machineId, projectCwd, response(request.id, outcome), executionMode);
    await this.output.send(response(request.id, outcome));

    if ("result" in outcome && request.method === "thread/archive") {
      this.topology.markArchived(threadId);
      if (synthesizedLifecycle) {
        await this.sendClientNotification({ method: "thread/archived", params: { threadId }, emittedAtMs: Date.now() });
      }
      await this.removeIfDrained(backend);
    } else if ("result" in outcome && request.method === "thread/delete") {
      this.topology.markDeleted(threadId);
      if (synthesizedLifecycle) {
        await this.sendClientNotification({ method: "thread/deleted", params: { threadId }, emittedAtMs: Date.now() });
      }
      await this.removeIfDrained(backend);
    }
  }

  private async handleProjectRequest(request: RpcRequest): Promise<void> {
    try {
      if (request.method === "skizzles/project/list") {
        await this.output.send(response(request.id, { result: { data: this.registry.list() } }));
        return;
      }
      const cwd = asRecord(request.params).cwd;
      if (typeof cwd !== "string") {
        await this.output.send(response(request.id, errorOutcome(-32602, "project cwd must be a string")));
        return;
      }
      if (request.method === "skizzles/project/add") {
        const projectCwd = await this.registry.canonicalCwd(cwd);
        await this.withProjectLock(projectCwd, async () => {
          const project = await this.registry.register(projectCwd);
          await this.output.send(response(request.id, { result: { project } }));
          await this.sendClientNotification({
            method: "skizzles/project/upsert",
            params: { project },
            emittedAtMs: Date.now(),
          });
        });
        return;
      }
      if (request.method === "skizzles/project/remove") {
        const project = await this.registry.find(cwd);
        if (!project) {
          const removed = await this.registry.remove(cwd);
          await this.output.send(response(request.id, { result: { removed } }));
          if (removed) {
            await this.sendClientNotification({
              method: "skizzles/project/removed",
              params: { cwd },
              emittedAtMs: Date.now(),
            });
          }
          return;
        }
        await this.withProjectLock(project.cwd, async () => {
          const current = await this.registry.find(project.cwd);
          if (!current) {
            await this.output.send(response(request.id, { result: { removed: false } }));
            return;
          }
          if (this.topology.hasLiveThreadsForProject(current.cwd)) {
            await this.output.send(response(request.id, errorOutcome(-32005, "project has active threads")));
            return;
          }
          const projectContainers = [...this.backendContexts.entries()]
            .filter(([, context]) => context.mode === "container" && context.project?.cwd === current.cwd)
            .map(([backend]) => backend);
          await Promise.all(projectContainers.map((backend) => this.removeIfDrained(backend)));
          const removed = await this.registry.remove(current.cwd);
          await this.output.send(response(request.id, { result: { removed } }));
          if (removed) {
            await this.sendClientNotification({
              method: "skizzles/project/removed",
              params: { cwd: current.cwd },
              emittedAtMs: Date.now(),
            });
          }
        });
        return;
      }
      await this.output.send(response(request.id, errorOutcome(-32601, `unknown extension method: ${request.method}`)));
    } catch (error) {
      await this.output.send(response(request.id, errorOutcome(
        -32602,
        error instanceof Error ? error.message : String(error),
      )));
    }
  }

  private async handleInitialize(request: RpcRequest): Promise<void> {
    if (this.initialization) {
      await this.output.send(response(request.id, errorOutcome(-32600, "Already initialized")));
      return;
    }
    this.initializeParams = request.params;
    if (this.applyClientNotificationOptOuts) {
      for (const method of initializeOptOutMethods(request.params)) this.clientOptOutNotifications.add(method);
    }
    this.initialization = (async () => {
      const staleHost = this.backends.get(HOST_MACHINE_ID);
      if (staleHost) {
        await this.discardBackend(staleHost);
        if (this.backends.has(HOST_MACHINE_ID)) {
          throw new Error("previous host app-server teardown must succeed before initialization can retry");
        }
      }
      const created = await this.createInitializedBackend("host", undefined, true);
      if ("error" in created.outcome) {
        await this.discardBackend(created.connection);
      } else {
        this.hostBackend = created.connection;
      }
      await this.output.send(response(request.id, created.outcome));
      if ("result" in created.outcome) await created.activate();
      return created.outcome;
    })().catch(async (error) => {
      const outcome = errorOutcome(-32603, error instanceof Error ? error.message : String(error));
      await this.output.send(response(request.id, outcome));
      return outcome;
    });
    const outcome = await this.initialization;
    if ("error" in outcome) {
      delete this.initialization;
      delete this.initializeParams;
    }
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
    const params = asRecord(request.params);
    const requestedMode = params.skizzlesExecutionMode;
    const executionMode = requestedMode === undefined ? DEFAULT_EXECUTION_MODE : requestedMode;
    if (!isExecutionMode(executionMode)) {
      await this.output.send(response(request.id, errorOutcome(
        -32602,
        "skizzlesExecutionMode must be either 'host' or 'container'",
      )));
      return;
    }

    const requestedCwd = params.cwd;
    let project: RegisteredProject | undefined;
    if (typeof requestedCwd === "string") {
      try {
        project = await this.registry.find(requestedCwd);
      } catch (error) {
        await this.output.send(response(request.id, errorOutcome(
          -32602,
          `invalid thread/start cwd: ${error instanceof Error ? error.message : String(error)}`,
        )));
        return;
      }
    }
    if (!project) {
      await this.output.send(response(request.id, errorOutcome(-32004, "thread/start cwd is not a registered project")));
      return;
    }
    if (executionMode === "container" && project.cloneUrl === null) {
      await this.output.send(response(request.id, errorOutcome(
        -32004,
        `project is host-only because it has no container-reachable Git origin: ${project.cwd}`,
      )));
      return;
    }

    await this.withProjectLock(project.cwd, async () => {
      const current = await this.registry.find(project!.cwd);
      if (!current) {
        await this.output.send(response(request.id, errorOutcome(-32004, "thread/start cwd is not a registered project")));
        return;
      }
      await this.startThread(request, current, executionMode);
    });
  }

  private async startThread(
    request: RpcRequest,
    project: RegisteredProject,
    executionMode: ExecutionMode,
  ): Promise<void> {
    let backend: BackendConnection;
    if (executionMode === "host") {
      if (!this.hostBackend || !this.readyBackends.has(this.hostBackend)) {
        await this.output.send(response(request.id, errorOutcome(-32004, "host app-server is unavailable")));
        return;
      }
      backend = this.hostBackend;
    } else {
      try {
        const created = await this.createInitializedBackend("container", project);
        if ("error" in created.outcome) {
          await this.discardBackend(created.connection);
          await this.output.send(response(request.id, created.outcome));
          return;
        }
        backend = created.connection;
        try {
          if (this.initialized) await backend.notify("initialized");
          await this.assertModelParity(backend);
        } catch (error) {
          await this.discardBackend(backend);
          await this.output.send(response(request.id, errorOutcome(
            -32603,
            error instanceof Error ? error.message : String(error),
          )));
          return;
        }
      } catch (error) {
        this.log(`failed to provision backend: ${error instanceof Error ? error.message : String(error)}`);
        await this.output.send(response(request.id, errorOutcome(
          -32603,
          `failed to provision app-server backend: ${error instanceof Error ? error.message : String(error)}`,
        )));
        return;
      }
    }

    const params = threadStartParams(request.params, backend, project.cwd);
    const rawOutcome = await backend.call("thread/start", params);
    const outcome = externalizeOutcome(backend, rawOutcome, project.cwd);
    this.topology.observe(backend.machineId, project.cwd, response(request.id, outcome), executionMode);
    await this.output.send(response(request.id, outcome));
    if ("error" in outcome && backend.disposable && !this.topology.hasLiveThreads(backend.machineId)) {
      await this.discardBackend(backend);
    }
  }

  private async createInitializedBackend(
    mode: ExecutionMode,
    project?: RegisteredProject,
    deferEvents = false,
  ): Promise<CreatedBackend> {
    let transport: BackendTransport | undefined;
    let connection: BackendConnection | undefined;
    try {
      transport = mode === "host"
        ? await this.hostFactory.create()
        : await this.containerFactory.create(requireProject(project));
      validateTransport(transport, mode);
      if (this.backends.has(transport.machineId)) throw new Error(`duplicate backend machine id: ${transport.machineId}`);
      this.state.saveMachine({
        machineId: transport.machineId,
        kind: mode,
        projectCwd: project?.cwd,
        containerId: transport.containerId,
      });

      let active = !deferEvents;
      const queued: Array<() => Promise<void>> = [];
      const forward = (operation: () => Promise<void>): Promise<void> => {
        if (active) return operation();
        queued.push(operation);
        return Promise.resolve();
      };
      connection = new BackendConnection(transport, {
        onNotification: (backend, notification) => forward(async () => {
          const context = this.contextForMessage(backend, notification);
          const outerNotification = context?.mode === "container" && context.project
            ? virtualizeNotification(notification, context.project.cwd)
            : notification;
          if (context?.project) {
            this.topology.observe(
              backend.machineId,
              context.project.cwd,
              outerNotification,
              context.mode,
            );
          }
          await this.sendClientNotification(outerNotification);
          if (
            backend.disposable &&
            (outerNotification.method === "thread/archived" || outerNotification.method === "thread/deleted")
          ) {
            queueMicrotask(() => {
              this.removeIfDrained(backend).catch((error) => {
                this.log(`failed to remove drained backend ${backend.machineId}: ${error instanceof Error ? error.message : String(error)}`);
              });
            });
          }
        }),
        onServerRequest: (backend, serverRequest) => forward(async () => {
          const outerId = `agg/server/${crypto.randomUUID()}`;
          this.reverseRequests.set(idKey(outerId), { backend, backendId: serverRequest.id, outerId });
          await this.output.send({ ...serverRequest, id: outerId });
        }),
        onLog: (backend, text) => this.log(`[${backend.machineId}] ${text.trimEnd()}`),
      });
      this.backends.set(connection.machineId, connection);
      this.backendContexts.set(connection, { mode, project });
      const outcome = await connection.initialize(backendInitializeParams(
        this.initializeParams,
        this.applyClientNotificationOptOuts,
      ));
      if ("result" in outcome) this.readyBackends.add(connection);
      return {
        connection,
        outcome,
        activate: async () => {
          if (active) return;
          active = true;
          for (const operation of queued.splice(0)) await operation();
        },
      };
    } catch (error) {
      if (connection) await this.discardBackend(connection);
      else if (transport) {
        try {
          await transport.destroy();
          this.state.markMachine(transport.machineId, "removed");
        } catch (closeError) {
          this.log(`failed to clean partial transport ${transport.machineId}: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        }
      }
      throw error;
    }
  }

  private async handleHostRead(request: RpcRequest): Promise<void> {
    const backend = this.hostBackend;
    if (!backend || !this.readyBackends.has(backend)) {
      await this.output.send(response(request.id, errorOutcome(-32004, "host app-server is unavailable")));
      return;
    }
    const outcome = await backend.call(request.method, request.params);
    await this.output.send(response(request.id, outcome));
  }

  private backendForThread(threadId: string): BackendConnection | undefined {
    const machineId = this.topology.machineFor(threadId);
    const backend = machineId ? this.backends.get(machineId) : undefined;
    if (!backend || !this.readyBackends.has(backend)) return undefined;
    return backend.kind === this.topology.modeFor(threadId) ? backend : undefined;
  }

  private contextForMessage(backend: BackendConnection, message: RpcMessage): BackendContext | undefined {
    const backendContext = this.backendContexts.get(backend);
    if (!backendContext || backendContext.mode === "container") return backendContext;

    const envelope = message as Record<string, unknown>;
    const params = asRecord(envelope.params);
    const result = asRecord(envelope.result);
    const thread = recordWithStringId(result.thread) ?? recordWithStringId(params.thread);
    const ids = [
      typeof params.threadId === "string" ? params.threadId : undefined,
      thread?.id,
      typeof result.reviewThreadId === "string" ? result.reviewThreadId : undefined,
      typeof thread?.parentThreadId === "string" ? thread.parentThreadId : undefined,
    ].filter((value): value is string => typeof value === "string");
    for (const threadId of ids) {
      const projectCwd = this.topology.projectFor(threadId);
      if (projectCwd) {
        const project = this.registry.list().find((candidate) => candidate.cwd === projectCwd);
        if (project) return { mode: "host", project };
      }
    }
    if (typeof thread?.cwd === "string") {
      const project = this.registry.list().find((candidate) => candidate.cwd === thread.cwd);
      if (project) return { mode: "host", project };
    }
    return { mode: "host" };
  }

  private async assertModelParity(container: BackendConnection): Promise<void> {
    const host = this.hostBackend;
    if (!host || !this.readyBackends.has(host)) throw new Error("cannot validate models without the host app-server");
    const [hostModels, containerModels] = await Promise.all([modelIds(host), modelIds(container)]);
    const onlyHost = [...hostModels].filter((id) => !containerModels.has(id)).sort();
    const onlyContainer = [...containerModels].filter((id) => !hostModels.has(id)).sort();
    if (!onlyHost.length && !onlyContainer.length) return;
    const details = [
      onlyHost.length ? `missing in container: ${summarizeIds(onlyHost)}` : undefined,
      onlyContainer.length ? `container-only: ${summarizeIds(onlyContainer)}` : undefined,
    ].filter((value): value is string => value !== undefined).join("; ");
    throw new Error(`host/container model catalogs do not match (${details})`);
  }

  private async handleClientResponse(id: RpcId, outcome: RpcOutcome): Promise<void> {
    const reverse = this.reverseRequests.get(idKey(id));
    if (!reverse) {
      this.log(`ignored client response for unknown server request ${String(id)}`);
      return;
    }
    this.reverseRequests.delete(idKey(id));
    this.onServerRequestSettled(reverse.outerId);
    await reverse.backend.respond(reverse.backendId, outcome);
  }

  private async removeIfDrained(backend: BackendConnection): Promise<void> {
    if (!backend.disposable) return;
    if ((this.lifecycleCalls.get(backend) ?? 0) > 0) return;
    if (this.topology.hasLiveThreads(backend.machineId)) return;
    await this.discardBackend(backend);
  }

  private async discardBackend(backend: BackendConnection): Promise<void> {
    this.readyBackends.delete(backend);
    this.lifecycleCalls.delete(backend);
    if (this.hostBackend === backend) this.hostBackend = undefined;
    for (const [key, reverse] of this.reverseRequests) {
      if (reverse.backend === backend) {
        this.reverseRequests.delete(key);
        this.onServerRequestSettled(reverse.outerId);
      }
    }
    try {
      await backend.close();
      this.state.markMachine(backend.machineId, "removed");
      this.backends.delete(backend.machineId);
      this.backendContexts.delete(backend);
    } catch (error) {
      this.log(`failed to clean backend ${backend.machineId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async withProjectLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectLocks.get(cwd) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.projectLocks.set(cwd, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.projectLocks.get(cwd) === queued) this.projectLocks.delete(cwd);
    }
  }

  private beginLifecycleCall(backend: BackendConnection): void {
    this.lifecycleCalls.set(backend, (this.lifecycleCalls.get(backend) ?? 0) + 1);
  }

  private endLifecycleCall(backend: BackendConnection): void {
    const remaining = (this.lifecycleCalls.get(backend) ?? 1) - 1;
    if (remaining > 0) this.lifecycleCalls.set(backend, remaining);
    else this.lifecycleCalls.delete(backend);
  }

  private async sendClientNotification(notification: RpcNotification): Promise<void> {
    if (this.clientOptOutNotifications.has(notification.method)) return;
    await this.output.send(notification);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function recordWithStringId(value: unknown): (Record<string, unknown> & { id: string }) | undefined {
  const record = asRecord(value);
  return typeof record.id === "string" ? record as Record<string, unknown> & { id: string } : undefined;
}

function requireProject(project: RegisteredProject | undefined): RegisteredProject {
  if (!project) throw new Error("container backend requires a registered project");
  return project;
}

function validateTransport(transport: BackendTransport, expectedMode: ExecutionMode): void {
  if (transport.kind !== expectedMode) {
    throw new Error(`backend factory returned ${transport.kind} transport for ${expectedMode} mode`);
  }
  if (expectedMode === "host") {
    if (transport.machineId !== HOST_MACHINE_ID) throw new Error(`host backend machine id must be ${HOST_MACHINE_ID}`);
    if (transport.containerId || transport.workspace || transport.disposable) {
      throw new Error("host backend transport has container-only properties");
    }
  } else if (!transport.containerId || !transport.workspace || !transport.disposable) {
    throw new Error("container backend transport is missing container lifecycle properties");
  }
}

function threadStartParams(value: unknown, backend: BackendConnection, projectCwd: string): Record<string, unknown> {
  const params = { ...asRecord(value) };
  delete params.skizzlesExecutionMode;
  params.cwd = backend.kind === "host" ? projectCwd : backend.workspace;
  if (backend.kind === "container" && Array.isArray(params.runtimeWorkspaceRoots)) {
    params.runtimeWorkspaceRoots = [backend.workspace];
  }
  return backend.kind === "container" ? enforceContainerAccess("thread/start", params) : params;
}

function backendRoutedParams(backend: BackendConnection, method: string, value: unknown): unknown {
  if (backend.kind === "host") return value;
  const params = { ...asRecord(value) };
  if ("cwd" in params) params.cwd = backend.workspace;
  if (Array.isArray(params.cwds)) params.cwds = params.cwds.map(() => backend.workspace);
  if (Array.isArray(params.runtimeWorkspaceRoots)) params.runtimeWorkspaceRoots = [backend.workspace];
  return enforceContainerAccess(method, params);
}

function enforceContainerAccess(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const routed = { ...params };
  delete routed.permissions;
  if (CONTAINER_SANDBOX_METHODS.has(method) || "sandbox" in routed) {
    routed.sandbox = "danger-full-access";
  }
  if (CONTAINER_POLICY_METHODS.has(method) || "sandboxPolicy" in routed) {
    routed.sandboxPolicy = { type: "dangerFullAccess" };
  }
  const config = optionalRecord(routed.config);
  if (config) {
    const forced: Record<string, unknown> = { ...config, sandbox_mode: "danger-full-access" };
    delete forced.permissions;
    delete forced.sandbox;
    delete forced.sandbox_policy;
    routed.config = forced;
  }
  return routed;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function externalizeOutcome(backend: BackendConnection, outcome: RpcOutcome, cwd: string): RpcOutcome {
  return backend.kind === "container" ? virtualizeOutcome(outcome, cwd) : outcome;
}

function virtualizeOutcome(outcome: RpcOutcome, cwd: string): RpcOutcome {
  return "result" in outcome ? { result: virtualizePayload(outcome.result, cwd) } : outcome;
}

function virtualizeNotification(notification: RpcNotification, cwd: string): RpcNotification {
  return { ...notification, params: virtualizePayload(notification.params, cwd) };
}

function virtualizePayload(value: unknown, cwd: string): unknown {
  const payload = asRecord(value);
  const thread = asRecord(payload.thread);
  if (typeof thread.id !== "string") return value;
  return { ...payload, thread: { ...thread, cwd } };
}

function initializeOptOutMethods(params: unknown): string[] {
  const capabilities = asRecord(asRecord(params).capabilities);
  const methods = capabilities.optOutNotificationMethods;
  return Array.isArray(methods) ? methods.filter((method): method is string => typeof method === "string") : [];
}

function backendInitializeParams(params: unknown, applyClientNotificationOptOuts: boolean): unknown {
  const root = asRecord(params);
  const capabilities = asRecord(root.capabilities);
  const methods = capabilities.optOutNotificationMethods;
  if (!Array.isArray(methods)) return params;
  const filtered = applyClientNotificationOptOuts
    ? methods.filter((method) => typeof method !== "string" || !TOPOLOGY_NOTIFICATION_METHODS.has(method))
    : methods.filter((method) => typeof method !== "string");
  if (filtered.length === methods.length) return params;
  return { ...root, capabilities: { ...capabilities, optOutNotificationMethods: filtered } };
}

async function modelIds(backend: BackendConnection): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const outcome = await backend.call("model/list", {
      includeHidden: true,
      ...(cursor === null ? {} : { cursor }),
    });
    if ("error" in outcome) throw new Error(`model/list failed on ${backend.kind}: ${outcome.error.message}`);
    const result = asRecord(outcome.result);
    if (!Array.isArray(result.data)) throw new Error(`model/list returned invalid data on ${backend.kind}`);
    for (const value of result.data) {
      const model = asRecord(value);
      if (typeof model.id !== "string") throw new Error(`model/list returned a model without an id on ${backend.kind}`);
      ids.add(model.id);
    }
    const next = result.nextCursor;
    if (next === null || next === undefined) return ids;
    if (typeof next !== "string" || seenCursors.has(next)) {
      throw new Error(`model/list returned an invalid cursor on ${backend.kind}`);
    }
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error(`model/list exceeded the pagination limit on ${backend.kind}`);
}

function summarizeIds(ids: string[]): string {
  const shown = ids.slice(0, 8).join(", ");
  return ids.length > 8 ? `${shown}, … (+${ids.length - 8})` : shown;
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

const CONTAINER_SANDBOX_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const CONTAINER_POLICY_METHODS = new Set(["turn/start", "thread/settings/update"]);

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

const HOST_GLOBAL_READS = new Set([
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
