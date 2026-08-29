import { BackendConnection, type BackendFactory, type BackendTransport } from "./backend.ts";
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
import { Topology, type ThreadListParams } from "./topology.ts";
import { AggregatorState, type RegisteredProject } from "./state.ts";

type ReverseRequest = { backend: BackendConnection; backendId: RpcId; outerId: RpcId };
type CreatedBackend = { connection: BackendConnection; outcome: RpcOutcome; activate: () => Promise<void> };

export type AggregatorOptions = {
  factory: BackendFactory;
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
  private readonly backendProjects = new Map<BackendConnection, RegisteredProject>();
  private readonly readyBackends = new Set<BackendConnection>();
  private readonly reverseRequests = new Map<string, ReverseRequest>();
  private readonly lifecycleCalls = new Map<BackendConnection, number>();
  private readonly factory: BackendFactory;
  private readonly registry: ProjectRegistry;
  private readonly state: AggregatorState;
  private readonly output: MessageSink;
  private readonly applyClientNotificationOptOuts: boolean;
  private readonly onServerRequestSettled: (id: RpcId) => void;
  private readonly log: (message: string) => void;
  private initialization?: Promise<RpcOutcome>;
  private initializeParams?: unknown;
  private readonly warmBackends = new Map<string, BackendConnection>();
  private readonly projectLocks = new Map<string, Promise<void>>();
  private readonly clientOptOutNotifications = new Set<string>();
  private initialized = false;
  private closed = false;

  constructor(options: AggregatorOptions) {
    this.factory = options.factory;
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
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.log(`failed to close backend ${backends[index]!.machineId}: ${reason}`);
      } else {
        this.state.markMachine(backends[index]!.machineId, "removed");
      }
    });
    this.backends.clear();
    this.readyBackends.clear();
    this.backendProjects.clear();
    this.warmBackends.clear();
    for (const reverse of this.reverseRequests.values()) this.onServerRequestSettled(reverse.outerId);
    this.reverseRequests.clear();
    this.lifecycleCalls.clear();
  }

  private async handleClientRequest(request: RpcRequest): Promise<void> {
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
      const result = this.topology.list(asRecord(request.params) as ThreadListParams);
      await this.output.send(response(request.id, { result }));
      return;
    }
    if (request.method === "thread/loaded/list") {
      const params = asRecord(request.params);
      const result = this.topology.loaded(new Set([...this.readyBackends].map((backend) => backend.machineId)), {
        cursor: typeof params.cursor === "string" ? params.cursor : null,
        limit: typeof params.limit === "number" ? params.limit : null,
      });
      await this.output.send(response(request.id, { result }));
      return;
    }
    if (request.method === "thread/unarchive") {
      const threadId = asRecord(request.params).threadId;
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

    const params = asRecord(request.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId && !REPRESENTATIVE_GLOBAL_READS.has(request.method)) {
      await this.output.send(response(request.id, errorOutcome(
        -32004,
        `request has no thread routing key and no aggregate behavior: ${request.method}`,
      )));
      return;
    }
    if (!threadId) {
      await this.handleRepresentativeRead(request, params);
      return;
    }
    const backend = this.backendForThread(threadId);
    if (!backend) {
      if (threadId && (request.method === "thread/archive" || request.method === "thread/delete") && this.topology.has(threadId)) {
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
      const rawOutcome = await backend.call(request.method, backendRoutedParams(backend, request.params));
      outcome = virtualizeOutcome(rawOutcome, this.projectForBackend(backend).cwd);
    } finally {
      if (lifecycleRequest) this.endLifecycleCall(backend);
    }
    const synthesizedLifecycle = threadId !== undefined
      && lifecycleRequest
      && isMissingRollout(outcome, threadId);
    if (synthesizedLifecycle) outcome = { result: {} };
    this.topology.observe(
      backend.machineId,
      this.projectForBackend(backend).cwd,
      response(request.id, outcome),
    );
    await this.output.send(response(request.id, outcome));

    if ("result" in outcome && threadId && request.method === "thread/archive") {
      this.topology.markArchived(threadId);
      if (synthesizedLifecycle) {
        await this.sendClientNotification({ method: "thread/archived", params: { threadId }, emittedAtMs: Date.now() });
      }
      await this.removeIfDrained(backend);
    } else if ("result" in outcome && threadId && request.method === "thread/delete") {
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
          const warm = this.warmBackends.get(project.cwd);
          if (warm && this.projectForBackend(warm).cloneUrl !== project.cloneUrl) {
            await this.removeIfDrained(warm);
          }
          await this.output.send(response(request.id, { result: { project } }));
        });
        return;
      }
      if (request.method === "skizzles/project/remove") {
        const project = await this.registry.find(cwd);
        if (!project) {
          const removed = await this.registry.remove(cwd);
          await this.output.send(response(request.id, { result: { removed } }));
          return;
        }
        await this.withProjectLock(project.cwd, async () => {
          const current = await this.registry.find(project.cwd);
          if (!current) {
            await this.output.send(response(request.id, { result: { removed: false } }));
            return;
          }
          const projectBackends = [...this.backendProjects.entries()]
            .filter(([, candidate]) => candidate.cwd === current.cwd)
            .map(([backend]) => backend);
          if (projectBackends.some((backend) => this.topology.hasLiveThreads(backend.machineId))) {
            await this.output.send(response(request.id, errorOutcome(-32005, "project has active threads")));
            return;
          }
          await Promise.all(projectBackends.map((backend) => this.removeIfDrained(backend)));
          const removed = await this.registry.remove(current.cwd);
          await this.output.send(response(request.id, { result: { removed } }));
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
    const project = this.registry.list()[0];
    if (!project) {
      await this.output.send(response(request.id, errorOutcome(
        -32004,
        "no projects are registered; call skizzles/project/add before initialize",
      )));
      return;
    }
    this.initialization = this.withProjectLock(project.cwd, async () => {
      const current = await this.registry.find(project.cwd);
      if (!current) {
        const outcome = errorOutcome(-32004, "initialization project is no longer registered");
        await this.output.send(response(request.id, outcome));
        return outcome;
      }
      const backend = await this.createInitializedBackend(current, true);
      if ("error" in backend.outcome) {
        this.backends.delete(backend.connection.machineId);
        this.backendProjects.delete(backend.connection);
        try {
          await backend.connection.close();
          this.state.markMachine(backend.connection.machineId, "removed");
        } catch (error) {
          this.log(`failed to clean initialization backend ${backend.connection.machineId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        this.warmBackends.set(current.cwd, backend.connection);
      }
      await this.output.send(response(request.id, backend.outcome));
      if ("result" in backend.outcome) await backend.activate();
      return backend.outcome;
    }).catch(async (error) => {
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
    const requestedCwd = asRecord(request.params).cwd;
    const project = typeof requestedCwd === "string" ? await this.registry.find(requestedCwd) : undefined;
    if (!project) {
      await this.output.send(response(request.id, errorOutcome(
        -32004,
        "thread/start cwd is not a registered project",
      )));
      return;
    }
    await this.withProjectLock(project.cwd, async () => {
      const current = await this.registry.find(project.cwd);
      if (!current) {
        await this.output.send(response(request.id, errorOutcome(
          -32004,
          "thread/start cwd is not a registered project",
        )));
        return;
      }
      await this.startThread(request, current);
    });
  }

  private async startThread(request: RpcRequest, project: RegisteredProject): Promise<void> {
    let backend = this.warmBackends.get(project.cwd);
    this.warmBackends.delete(project.cwd);
    if (!backend) {
      let created: CreatedBackend;
      try {
        created = await this.createInitializedBackend(project);
      } catch (error) {
        this.log(`failed to provision backend: ${error instanceof Error ? error.message : String(error)}`);
        await this.output.send(response(request.id, errorOutcome(-32603, "failed to provision app-server backend")));
        return;
      }
      if ("error" in created.outcome) {
        this.backends.delete(created.connection.machineId);
        this.backendProjects.delete(created.connection);
        try {
          await created.connection.close();
          this.state.markMachine(created.connection.machineId, "removed");
        } catch (error) {
          this.log(`failed to clean rejected backend ${created.connection.machineId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        await this.output.send(response(request.id, created.outcome));
        return;
      }
      backend = created.connection;
      if (this.initialized) {
        try {
          await backend.notify("initialized");
        } catch (error) {
          this.readyBackends.delete(backend);
          this.backends.delete(backend.machineId);
          this.backendProjects.delete(backend);
          try {
            await backend.close();
            this.state.markMachine(backend.machineId, "removed");
          } catch (closeError) {
            this.log(`failed to clean unnotified backend ${backend.machineId}: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
          }
          this.log(`failed to notify provisioned backend ${backend.machineId}: ${error instanceof Error ? error.message : String(error)}`);
          await this.output.send(response(request.id, errorOutcome(-32603, "failed to provision app-server backend")));
          return;
        }
      }
    }
    const params: Record<string, unknown> = { ...asRecord(request.params), cwd: backend.workspace };
    if (Array.isArray(params.runtimeWorkspaceRoots)) params.runtimeWorkspaceRoots = [backend.workspace];
    const rawOutcome = await backend.call("thread/start", params);
    const outcome = virtualizeOutcome(rawOutcome, project.cwd);
    this.topology.observe(backend.machineId, project.cwd, response(request.id, outcome));
    await this.output.send(response(request.id, outcome));
    if ("error" in outcome && !this.topology.hasLiveThreads(backend.machineId)) {
      this.readyBackends.delete(backend);
      await backend.close();
      this.state.markMachine(backend.machineId, "removed");
      this.backends.delete(backend.machineId);
      this.backendProjects.delete(backend);
    }
  }

  private async createInitializedBackend(project: RegisteredProject, deferEvents = false): Promise<CreatedBackend> {
    let transport: BackendTransport | undefined;
    let connection: BackendConnection | undefined;
    try {
      transport = await this.factory.create(project);
      this.state.saveMachine({
        machineId: transport.machineId,
        projectCwd: project.cwd,
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
          const outerNotification = virtualizeNotification(notification, project.cwd);
          this.topology.observe(backend.machineId, project.cwd, outerNotification);
          await this.sendClientNotification(outerNotification);
          if (outerNotification.method === "thread/archived" || outerNotification.method === "thread/deleted") {
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
      this.backendProjects.set(connection, project);
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
      if (connection) {
        this.readyBackends.delete(connection);
        this.backends.delete(connection.machineId);
        this.backendProjects.delete(connection);
        try {
          await connection.close();
          this.state.markMachine(connection.machineId, "removed");
        } catch (closeError) {
          this.log(`failed to clean partial backend ${connection.machineId}: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        }
      } else if (transport) {
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

  private async handleRepresentativeRead(request: RpcRequest, params: Record<string, unknown>): Promise<void> {
    const requested = representativeCwds(params);
    if ("error" in requested) {
      await this.output.send(response(request.id, errorOutcome(-32602, requested.error)));
      return;
    }
    let project: RegisteredProject | undefined;
    if (requested.cwds.length) {
      let projects: Array<RegisteredProject | undefined>;
      try {
        projects = await Promise.all(requested.cwds.map((cwd) => this.registry.find(cwd)));
      } catch (error) {
        await this.output.send(response(request.id, errorOutcome(
          -32602,
          error instanceof Error ? error.message : String(error),
        )));
        return;
      }
      const missing = requested.cwds.find((_cwd, index) => !projects[index]);
      if (missing) {
        await this.output.send(response(request.id, errorOutcome(
          -32004,
          `representative read cwd is not a registered project: ${missing}`,
        )));
        return;
      }
      const unique = new Map(projects.map((candidate) => [candidate!.cwd, candidate!]));
      if (unique.size > 1) {
        await this.output.send(response(request.id, errorOutcome(
          -32602,
          "representative read cannot span multiple registered projects",
        )));
        return;
      }
      project = unique.values().next().value as RegisteredProject;
    } else {
      const warm = this.warmBackends.values().next().value as BackendConnection | undefined;
      const running = this.readyBackends.values().next().value as BackendConnection | undefined;
      project = warm ? this.projectForBackend(warm) : running ? this.projectForBackend(running) : this.registry.list()[0];
    }
    if (!project) {
      await this.output.send(response(request.id, errorOutcome(-32004, "no app-server backend is available")));
      return;
    }

    await this.withProjectLock(project.cwd, async () => {
      const current = await this.registry.find(project.cwd);
      if (!current) {
        await this.output.send(response(request.id, errorOutcome(-32004, "representative read project is no longer registered")));
        return;
      }
      let warm = this.warmBackends.get(current.cwd);
      if (warm && this.projectForBackend(warm).cloneUrl !== current.cloneUrl) {
        await this.removeIfDrained(warm);
        warm = this.warmBackends.get(current.cwd);
      }
      const running = [...this.readyBackends].find((backend) => {
        const candidate = this.projectForBackend(backend);
        return candidate.cwd === current.cwd && candidate.cloneUrl === current.cloneUrl;
      });
      const backend = warm ?? running ?? await this.createRepresentativeBackend(current);
      if (!backend) {
        await this.output.send(response(request.id, errorOutcome(-32004, "no app-server backend is available")));
        return;
      }
      const rawOutcome = await backend.call(request.method, backendRoutedParams(backend, request.params));
      const outcome = virtualizeOutcome(rawOutcome, current.cwd);
      this.topology.observe(backend.machineId, current.cwd, response(request.id, outcome));
      await this.output.send(response(request.id, outcome));
    });
  }

  private async createRepresentativeBackend(project: RegisteredProject): Promise<BackendConnection | undefined> {
    let created: CreatedBackend;
    try {
      created = await this.createInitializedBackend(project);
    } catch (error) {
      this.log(`failed to provision representative backend: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    if ("error" in created.outcome) {
      this.backends.delete(created.connection.machineId);
      this.backendProjects.delete(created.connection);
      try {
        await created.connection.close();
        this.state.markMachine(created.connection.machineId, "removed");
      } catch (error) {
        this.log(`failed to clean representative backend ${created.connection.machineId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return undefined;
    }
    if (this.initialized) {
      try {
        await created.connection.notify("initialized");
      } catch (error) {
        this.readyBackends.delete(created.connection);
        this.backends.delete(created.connection.machineId);
        this.backendProjects.delete(created.connection);
        try {
          await created.connection.close();
          this.state.markMachine(created.connection.machineId, "removed");
        } catch (closeError) {
          this.log(`failed to clean unnotified representative backend ${created.connection.machineId}: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        }
        this.log(`failed to notify representative backend ${created.connection.machineId}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }
    this.warmBackends.set(project.cwd, created.connection);
    return created.connection;
  }

  private backendForThread(threadId: string): BackendConnection | undefined {
    const machineId = this.topology.machineFor(threadId);
    const backend = machineId ? this.backends.get(machineId) : undefined;
    return backend && this.readyBackends.has(backend) ? backend : undefined;
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
    if ((this.lifecycleCalls.get(backend) ?? 0) > 0) return;
    if (this.topology.hasLiveThreads(backend.machineId)) return;
    this.readyBackends.delete(backend);
    await backend.close();
    this.state.markMachine(backend.machineId, "removed");
    this.backends.delete(backend.machineId);
    const project = this.backendProjects.get(backend);
    this.backendProjects.delete(backend);
    this.lifecycleCalls.delete(backend);
    for (const [key, reverse] of this.reverseRequests) {
      if (reverse.backend === backend) {
        this.reverseRequests.delete(key);
        this.onServerRequestSettled(reverse.outerId);
      }
    }
    if (project && this.warmBackends.get(project.cwd) === backend) this.warmBackends.delete(project.cwd);
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

  private projectForBackend(backend: BackendConnection): RegisteredProject {
    const project = this.backendProjects.get(backend);
    if (!project) throw new Error(`backend ${backend.machineId} has no project`);
    return project;
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

function representativeCwds(params: Record<string, unknown>): { cwds: string[] } | { error: string } {
  const cwds: string[] = [];
  if (params.cwd !== undefined && params.cwd !== null) {
    if (typeof params.cwd !== "string") return { error: "representative read cwd must be a string" };
    cwds.push(params.cwd);
  }
  if (params.cwds !== undefined && params.cwds !== null) {
    if (!Array.isArray(params.cwds) || params.cwds.some((cwd) => typeof cwd !== "string")) {
      return { error: "representative read cwds must be an array of strings" };
    }
    cwds.push(...params.cwds as string[]);
  }
  return { cwds };
}

function backendRoutedParams(backend: BackendConnection, value: unknown): unknown {
  const params = asRecord(value);
  let changed = false;
  const routed = { ...params };
  if ("cwd" in params) {
    routed.cwd = backend.workspace;
    changed = true;
  }
  if (Array.isArray(params.cwds)) {
    routed.cwds = params.cwds.map(() => backend.workspace);
    changed = true;
  }
  if (Array.isArray(params.runtimeWorkspaceRoots)) {
    routed.runtimeWorkspaceRoots = [backend.workspace];
    changed = true;
  }
  return changed ? routed : value;
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
