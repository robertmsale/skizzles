import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { OMP_BINARY, projectStateRoot } from "./config.ts";
import { checkedCommand, runCommand } from "./process.ts";
import { ServiceError, isRecord, type Approval, type JournalEvent, type Project } from "./protocol.ts";
import { ProjectRegistry, type RegisterProjectInput } from "./projects.ts";
import { PullRequestPublisher } from "./publisher.ts";
import { OmpRpcClient } from "./rpc.ts";
import { OrchestrationState } from "./state.ts";

const PERSISTED_FRAME_TYPES = new Set([
  "agent_start", "agent_end", "turn_start", "turn_end", "message_end", "tool_execution_end",
  "subagent_lifecycle", "subagent_progress", "notice", "goal_updated", "extension_ui_request",
]);
const BLOCKING_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

type Runtime = { project: Project; client: OmpRpcClient; stopping: boolean };

export class OmpManager {
  readonly projects: ProjectRegistry;
  readonly publisher: PullRequestPublisher;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly launching = new Map<string, Runtime>();
  private readonly starts = new Map<string, Promise<void>>();
  private launchQueue: Promise<void> = Promise.resolve();
  private readonly ingressDeliveries = new Map<number, Promise<void>>();
  private readonly eventEmitter = new EventEmitter();
  private shuttingDown = false;
  private readonly ompBinary: string;
  private readonly resolveProjectStateRoot: (projectId: string) => string;
  private readonly maintainerPromptPath: string;
  private readonly startupTimeoutMs: number;

  constructor(readonly state: OrchestrationState, options: {
    ompBinary?: string;
    projectStateRoot?: (projectId: string) => string;
    maintainerPromptPath?: string;
    startupTimeoutMs?: number;
  } = {}) {
    this.projects = new ProjectRegistry(state);
    this.publisher = new PullRequestPublisher(state);
    this.ompBinary = options.ompBinary ?? OMP_BINARY;
    this.resolveProjectStateRoot = options.projectStateRoot ?? projectStateRoot;
    this.maintainerPromptPath = options.maintainerPromptPath ?? resolve(import.meta.dir, "../prompts/maintainer.md");
    this.startupTimeoutMs = options.startupTimeoutMs ?? 45_000;
    this.eventEmitter.setMaxListeners(0);
  }

  async start(): Promise<void> {
    this.state.recoverMaintainers();
    const enabled = this.state.projects().filter((project) => project.enabled);
    await Promise.allSettled(enabled.map((project) => this.startProject(project.id)));
    for (const project of enabled.filter((candidate) => candidate.autoPublish)) {
      for (const job of this.state.jobs(project.id).filter((candidate) => candidate.status === "completed")) {
        void this.reconcileAndPublish(project, job.id);
      }
    }
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    const active = new Set([...this.runtimes.values(), ...this.launching.values()]);
    await Promise.allSettled([...active].map(async (runtime) => {
      runtime.stopping = true;
      await runtime.client.stop();
      this.state.saveMaintainer(runtime.project.id, { state: "stopped", pid: null, heartbeatAt: Date.now() });
    }));
    this.runtimes.clear();
    this.launching.clear();
    await Promise.allSettled([...this.starts.values()]);
  }

  async registerProject(input: RegisterProjectInput): Promise<Project> {
    const project = await this.projects.register(input);
    this.emit(this.state.appendEvent(project.id, "project.registered", project));
    await this.starts.get(project.id)?.catch(() => undefined);
    const previousRuntime = this.runtimes.get(project.id);
    if (previousRuntime) {
      previousRuntime.stopping = true;
      this.runtimes.delete(project.id);
      await previousRuntime.client.stop();
      this.state.saveMaintainer(project.id, { state: "stopped", pid: null, heartbeatAt: Date.now() });
    }
    await this.startProject(project.id);
    return project;
  }

  async removeProject(projectId: string): Promise<{ removed: boolean }> {
    await this.stopProject(projectId);
    const removed = this.state.removeProject(projectId);
    if (removed) this.emit(this.state.appendEvent(null, "project.removed", { projectId }));
    return { removed };
  }

  async startProject(projectId: string): Promise<void> {
    if (this.runtimes.has(projectId)) return;
    if (this.shuttingDown) throw new ServiceError("daemon is shutting down", "unavailable", 503);
    const project = this.requireProject(projectId);
    if (!project.enabled) throw new ServiceError("project is stopped", "unavailable", 503);
    const pending = this.starts.get(projectId);
    if (pending) return pending;
    const start = this.launchQueue.then(async () => {
      if (this.shuttingDown || !this.state.project(projectId)?.enabled) return;
      await this.launchProject(projectId);
    });
    this.launchQueue = start.catch(() => undefined);
    const tracked = start.finally(() => this.starts.delete(projectId));
    this.starts.set(projectId, tracked);
    return tracked;
  }

  async stopProject(projectId: string): Promise<void> {
    this.requireProject(projectId);
    this.state.setProjectEnabled(projectId, false);
    const launching = this.launching.get(projectId);
    if (launching) {
      launching.stopping = true;
      await launching.client.stop();
    }
    await this.starts.get(projectId)?.catch(() => undefined);
    const runtime = this.runtimes.get(projectId);
    if (!runtime) {
      this.state.saveMaintainer(projectId, { state: "stopped", pid: null, heartbeatAt: Date.now() });
      return;
    }
    runtime.stopping = true;
    this.runtimes.delete(projectId);
    await runtime.client.stop();
    this.state.saveMaintainer(projectId, { state: "stopped", pid: null, heartbeatAt: Date.now() });
    this.emit(this.state.appendEvent(projectId, "maintainer.stopped", { projectId }));
  }

  async enableProject(projectId: string): Promise<void> {
    this.requireProject(projectId);
    this.state.setProjectEnabled(projectId, true);
    await this.startProject(projectId);
  }

  async send(projectId: string, message: string): Promise<unknown> {
    const runtime = await this.requireRuntime(projectId);
    const response = await runtime.client.prompt(message);
    this.emit(this.state.appendEvent(projectId, "maintainer.message.accepted", { messageLength: message.length }));
    return response.data ?? null;
  }

  async status(projectId: string): Promise<unknown> {
    const project = this.requireProject(projectId);
    const maintainer = this.state.maintainer(projectId) ?? null;
    const runtime = this.runtimes.get(projectId);
    let rpcState: unknown = null;
    if (runtime) {
      try { rpcState = (await runtime.client.getState()).data ?? null; } catch {}
    }
    return { project, maintainer, rpcState };
  }

  async history(projectId: string, cursor?: string, limit = 50): Promise<unknown> {
    const runtime = await this.requireRuntime(projectId);
    return (await runtime.client.getMessagesPage(cursor, Math.max(1, Math.min(200, limit)))).data ?? null;
  }

  async subagents(projectId: string): Promise<unknown> {
    const runtime = await this.requireRuntime(projectId);
    return (await runtime.client.getSubagents()).data ?? null;
  }

  async abort(projectId: string): Promise<unknown> {
    const runtime = await this.requireRuntime(projectId);
    return (await runtime.client.abort()).data ?? null;
  }

  async acceptIngress(input: { projectId: string; source: string; sourceKey: string; kind: string; payload: unknown; message: string }): Promise<unknown> {
    this.requireProject(input.projectId);
    const accepted = this.state.acceptInbox(input);
    if (accepted.delivered) return accepted;
    if (!accepted.duplicate) {
      this.emit(this.state.appendEvent(input.projectId, "inbox.accepted", { inboxId: accepted.id, source: input.source, sourceKey: input.sourceKey, kind: input.kind }));
    }
    let delivery = this.ingressDeliveries.get(accepted.id);
    if (!delivery) {
      delivery = (async () => {
        await this.send(input.projectId, `[Ingress: ${input.source}/${input.kind} id=${input.sourceKey}]\n\n${input.message}`);
        this.state.markInboxDelivered(accepted.id);
        this.emit(this.state.appendEvent(input.projectId, "inbox.delivered", { inboxId: accepted.id }));
      })().finally(() => this.ingressDeliveries.delete(accepted.id));
      this.ingressDeliveries.set(accepted.id, delivery);
    }
    await delivery;
    return { ...accepted, delivered: true };
  }

  async publish(projectId: string, jobId: string): Promise<unknown> {
    const project = this.requireProject(projectId);
    const job = this.state.job(projectId, jobId);
    if (!job) throw new ServiceError("job not found", "not_found", 404);
    const published = await this.publisher.publish(project, job);
    this.emit(this.state.appendEvent(projectId, "job.published", published));
    void this.send(projectId, `[System notification] Subagent job ${jobId} was published as draft PR ${published.prUrl}.`).catch(() => undefined);
    return published;
  }

  approvals(projectId?: string): Approval[] { return this.state.approvals(projectId, true); }

  resolveApproval(projectId: string, approvalId: string, input: { approved: boolean; value?: string }): Approval {
    const approval = this.state.approval(projectId, approvalId);
    if (!approval) throw new ServiceError("approval not found", "not_found", 404);
    if (approval.status !== "pending") throw new ServiceError("approval is no longer pending", "conflict", 409);
    const runtime = this.runtimes.get(projectId);
    if (!runtime) throw new ServiceError("maintainer is unavailable", "unavailable", 503);
    const response = input.approved
      ? approval.method === "confirm" ? { confirmed: true } : input.value !== undefined ? { value: input.value } : { cancelled: true }
      : { cancelled: true };
    if (input.approved && approval.method !== "confirm" && input.value === undefined) {
      throw new ServiceError("this approval requires a value", "invalid_request");
    }
    runtime.client.respondToUi(approvalId, response);
    if (!this.state.resolveApproval(projectId, approvalId, input.approved ? "approved" : "denied", response)) {
      throw new ServiceError("approval resolution raced with another caller", "conflict", 409);
    }
    const resolved = this.state.approval(projectId, approvalId)!;
    this.emit(this.state.appendEvent(projectId, `approval.${resolved.status}`, resolved));
    return resolved;
  }

  events(after = 0, projectId?: string, limit = 200): JournalEvent[] { return this.state.events(after, projectId, limit); }

  waitForEvent(after: number, timeoutMs: number, projectId?: string): Promise<void> {
    if (this.state.events(after, projectId, 1).length > 0 || timeoutMs <= 0) return Promise.resolve();
    return new Promise((resolveWait) => {
      const finish = () => { clearTimeout(timer); this.eventEmitter.off("event", onEvent); resolveWait(); };
      const onEvent = (event: JournalEvent) => { if (event.sequence > after && (!projectId || event.projectId === projectId)) finish(); };
      const timer = setTimeout(finish, Math.min(58_000, timeoutMs));
      this.eventEmitter.on("event", onEvent);
    });
  }

  private async launchProject(projectId: string): Promise<void> {
    const project = this.requireProject(projectId);
    const previous = this.state.maintainer(projectId);
    this.state.saveMaintainer(projectId, { state: "starting", lastError: null, restartCount: previous?.restartCount ?? 0 });
    const root = this.resolveProjectStateRoot(projectId);
    const sessionRoot = resolve(root, "sessions");
    const configPath = resolve(root, "maintainer-config.yml");
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    await Bun.write(configPath, maintainerConfig());
    const promptPath = this.maintainerPromptPath;
    const command = [
      this.ompBinary,
      "--mode", "rpc",
      "--cwd", project.cwd,
      "--session-dir", sessionRoot,
      "--config", configPath,
      "--append-system-prompt", promptPath,
      "--approval-mode", "write",
      "--tools", "read,grep,glob,lsp,task,todo,web_search",
      "--no-title",
    ];
    if (project.model) command.push("--model", project.model);
    if (project.thinking) command.push("--thinking", project.thinking);
    if (previous?.sessionFile && existsSync(previous.sessionFile)) command.push("--resume", previous.sessionFile);
    const runtime: Runtime = {
      project,
      stopping: false,
      client: undefined as unknown as OmpRpcClient,
    };
    const client = new OmpRpcClient({
      command,
      cwd: project.cwd,
      startupTimeoutMs: this.startupTimeoutMs,
      onFrame: (frame) => this.handleFrame(project, frame),
      onExit: (code, stderr) => this.handleExit(runtime, code, stderr),
    });
    runtime.client = client;
    this.launching.set(projectId, runtime);
    try {
      const rpcState = await client.start();
      if (this.shuttingDown || !this.state.project(projectId)?.enabled) {
        runtime.stopping = true;
        await client.stop();
        this.state.saveMaintainer(projectId, { state: "stopped", pid: null, heartbeatAt: Date.now() });
        return;
      }
      this.runtimes.set(projectId, runtime);
      const data = isRecord(rpcState.data) ? rpcState.data : rpcState;
      this.state.saveMaintainer(projectId, {
        state: data.isStreaming === true ? "busy" : "ready",
        pid: client.pid ?? null,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
        sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : previous?.sessionFile ?? null,
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
        lastError: null,
      });
      this.emit(this.state.appendEvent(projectId, "maintainer.ready", { pid: client.pid, sessionId: data.sessionId }));
    } catch (error) {
      if (runtime.stopping || this.shuttingDown || !this.state.project(projectId)?.enabled) {
        this.state.saveMaintainer(projectId, { state: "stopped", pid: null, heartbeatAt: Date.now() });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const restartCount = (this.state.maintainer(projectId)?.restartCount ?? 0) + 1;
      this.state.saveMaintainer(projectId, { state: "failed", pid: null, heartbeatAt: Date.now(), restartCount, lastError: message });
      this.emit(this.state.appendEvent(projectId, "maintainer.failed", { error: message, restartCount }));
      this.scheduleRestart(projectId, restartCount);
      throw error;
    } finally {
      if (this.launching.get(projectId) === runtime) this.launching.delete(projectId);
    }
  }

  private async handleExit(runtime: Runtime, code: number, stderr: string): Promise<void> {
    if (this.runtimes.get(runtime.project.id)?.client === runtime.client) this.runtimes.delete(runtime.project.id);
    if (runtime.stopping || this.shuttingDown) return;
    const current = this.state.maintainer(runtime.project.id);
    const restartCount = (current?.restartCount ?? 0) + 1;
    this.state.saveMaintainer(runtime.project.id, { state: "failed", pid: null, heartbeatAt: Date.now(), restartCount, lastError: stderr || `OMP exited with code ${code}` });
    this.emit(this.state.appendEvent(runtime.project.id, "maintainer.exited", { code, restartCount, stderr }));
    if (!this.state.project(runtime.project.id)?.enabled) return;
    this.scheduleRestart(runtime.project.id, restartCount);
  }

  private async handleFrame(project: Project, frame: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    if (frame.type === "agent_start") this.state.saveMaintainer(project.id, { state: "busy", heartbeatAt: now });
    if (frame.type === "agent_end") this.state.saveMaintainer(project.id, { state: "ready", heartbeatAt: now });
    if (frame.type === "subagent_lifecycle" && isRecord(frame.payload)) {
      const baseSha = frame.payload.status === "started" ? await currentHead(project.cwd) : null;
      const job = this.state.saveJobLifecycle(project.id, frame.payload, baseSha, now);
      if (job && frame.payload.status === "completed" && project.autoPublish) void this.reconcileAndPublish(project, job.id);
    }
    if (frame.type === "subagent_progress" && isRecord(frame.payload)) this.state.saveJobProgress(project.id, frame.payload, now);
    if (frame.type === "extension_ui_request") this.handleUiRequest(project.id, frame, now);
    if (PERSISTED_FRAME_TYPES.has(String(frame.type))) this.emit(this.state.appendEvent(project.id, `omp.${String(frame.type)}`, frame, now));
    if (frame.type === "tool_execution_end" && project.autoPublish) {
      for (const job of this.state.jobs(project.id).filter((candidate) => candidate.status === "completed")) {
        void this.reconcileAndPublish(project, job.id);
      }
    }
  }

  private handleUiRequest(projectId: string, frame: Record<string, unknown>, now: number): void {
    if (frame.method === "cancel" && typeof frame.targetId === "string") {
      this.state.resolveApproval(projectId, frame.targetId, "cancelled", { cancelled: true }, now);
      return;
    }
    if (typeof frame.method === "string" && BLOCKING_UI_METHODS.has(frame.method)) this.state.saveApproval(projectId, frame, now);
  }

  private async reconcileAndPublish(project: Project, jobId: string): Promise<void> {
    for (const delay of [300, 1_000, 3_000]) {
      await Bun.sleep(delay);
      const job = this.state.job(project.id, jobId);
      if (!job || job.status !== "completed") return;
      const ref = await runCommand(["git", "show-ref", "--verify", `refs/heads/${job.branchName}`], { cwd: project.cwd });
      if (ref.exitCode !== 0) continue;
      try { await this.publish(project.id, jobId); } catch (error) {
        this.emit(this.state.appendEvent(project.id, "job.publish_failed", { jobId, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
  }

  private requireProject(projectId: string): Project {
    const project = this.state.project(projectId);
    if (!project) throw new ServiceError("project not found", "not_found", 404);
    return project;
  }

  private async requireRuntime(projectId: string): Promise<Runtime> {
    this.requireProject(projectId);
    await this.startProject(projectId);
    const runtime = this.runtimes.get(projectId);
    if (!runtime) throw new ServiceError("maintainer is unavailable", "unavailable", 503);
    return runtime;
  }

  private emit(event: JournalEvent): void { this.eventEmitter.emit("event", event); }

  private scheduleRestart(projectId: string, restartCount: number): void {
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(6, restartCount - 1));
    void (async () => {
      await Bun.sleep(delay);
      if (!this.shuttingDown && this.state.project(projectId)?.enabled) {
        await this.startProject(projectId).catch(() => undefined);
      }
    })();
  }
}

function maintainerConfig(): string {
  return `task:\n  isolation:\n    mode: apfs\n    apply: false\n    merge: branch\n    commits: generic\n  eager: true\n  batch: true\n  maxConcurrency: 4\nasync:\n  enabled: true\n  maxJobs: 8\n`;
}

async function currentHead(cwd: string): Promise<string | null> {
  try { return await checkedCommand(["git", "rev-parse", "HEAD"], { cwd }); } catch { return null; }
}
