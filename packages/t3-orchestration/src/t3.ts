import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { $ } from "bun";
import { origin, token, taskProviderDefaults } from "./config.ts";
import {
  approvalRespondCommand,
  derivePendingApprovals,
  projectPendingApprovalList,
  requireIdentifiableApproval,
  selectPendingApproval,
  threadActivities,
  type ApprovalDecision,
} from "./approval-projection.ts";
import { mergeArchivedTasks, projectCleanableWorktrees, projectProjects, projectTaskList, projectTask, waitForTasks, type TaskListOptions, type TaskWaitInput } from "./task-projection.ts";
import { requireSelection, type ModelSelection, type ShellSnapshot, type Snapshot, type T3Thread, type ThreadSnapshot } from "./protocol.ts";

async function request(path: string, init: RequestInit = {}, maxBodyBytes = 2_000_000): Promise<any> {
  const response = await fetch(`${await origin()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.body) throw new Error(`${init.method ?? "GET"} ${path} returned no body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBodyBytes) {
      await reader.cancel();
      throw new Error(`${init.method ?? "GET"} ${path} response exceeded ${maxBodyBytes} bytes`);
    }
    chunks.push(next.value);
  }
  const body = new TextDecoder().decode(Buffer.concat(chunks));
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

export const snapshot = (): Promise<Snapshot> => request("/api/orchestration/snapshot");
export const shellSnapshot = (): Promise<ShellSnapshot> => request("/api/orchestration/shell", {}, 2_000_000);
export const threadSnapshot = (id: string, turnLimit: number, beforeCursor?: string): Promise<ThreadSnapshot> => {
  if (!Number.isInteger(turnLimit) || turnLimit < 1 || turnLimit > 10) throw new Error("History --turns must be an integer from 1 through 10");
  const query = new URLSearchParams({ turnLimit: String(turnLimit) });
  if (beforeCursor?.trim()) query.set("beforeCursor", beforeCursor.trim());
  return request(`/api/orchestration/threads/${encodeURIComponent(id)}?${query}`, {}, 512_000);
};
export function projectThread(result: ThreadSnapshot): T3Thread {
  const source = result.thread;
  return {
    id: source.id,
    projectId: source.projectId,
    title: source.title,
    modelSelection: source.modelSelection,
    runtimeMode: source.runtimeMode,
    interactionMode: source.interactionMode,
    worktreePath: source.worktreePath,
    branch: source.branch,
    latestTurn: source.latestTurn ?? null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    archivedAt: source.archivedAt ?? null,
    settledOverride: source.settledOverride ?? null,
    settledAt: source.settledAt ?? null,
    pinnedAt: source.pinnedAt ?? null,
    pinOrderKey: source.pinOrderKey ?? null,
    deletedAt: source.deletedAt ?? null,
    session: source.session ? {
      status: source.session.status,
      threadId: source.session.threadId ?? null,
      activeTurnId: source.session.activeTurnId ?? null,
      lastError: source.session.lastError ?? null,
      updatedAt: source.session.updatedAt,
    } : null,
  };
}
export const thread = async (id: string): Promise<T3Thread> => projectThread(await threadSnapshot(id, 1));

export const projectList = async () => projectProjects(await snapshot());
export const taskList = async (options: TaskListOptions) => {
  const shell = await shellSnapshot();
  const source = options.includeArchived ? mergeArchivedTasks(shell, await snapshot()) : shell;
  return projectTaskList(source, options);
};
export const taskWait = async (input: TaskWaitInput) => waitForTasks(
  input,
  shellSnapshot,
  Bun.sleep,
  Date.now,
  async (threadIds) => {
    const full = await snapshot();
    const ids = new Set(threadIds);
    return full.threads.filter((entry) => ids.has(entry.id));
  },
);
export const taskStatus = async (id: string) => {
  const shell = await shellSnapshot();
  const active = shell.threads.find((entry) => entry.id === id);
  if (active) return projectTask(active, new Map(shell.projects.map((project) => [project.id, project])));
  const [result, full] = await Promise.all([threadSnapshot(id, 1), snapshot()]);
  return projectTask(result.thread, new Map(full.projects.map((project) => [project.id, project])));
};
export const listCleanableWorktrees = async () => {
  const [shell, full] = await Promise.all([shellSnapshot(), snapshot()]);
  return projectCleanableWorktrees(mergeArchivedTasks(shell, full));
};

const HISTORY_MESSAGE_CHAR_LIMIT = 8_000;
const HISTORY_TOTAL_CHAR_LIMIT = 32_000;

export function projectTaskHistory(result: ThreadSnapshot) {
  let remaining = HISTORY_TOTAL_CHAR_LIMIT;
  let messagesOmitted = 0;
  const messages = [];
  for (const message of result.thread.messages.toReversed()) {
    if (remaining <= 0) {
      messagesOmitted++;
      continue;
    }
    const source = typeof message.text === "string" ? message.text : "";
    const available = Math.min(HISTORY_MESSAGE_CHAR_LIMIT, remaining);
    const text = source.slice(0, available);
    messages.push({
      role: message.role,
      text,
      textTruncated: text.length < source.length,
      turnId: message.turnId,
      createdAt: message.createdAt,
    });
    remaining -= text.length;
  }
  messages.reverse();
  return {
    thread: {
      id: result.thread.id,
      projectId: result.thread.projectId,
      title: result.thread.title,
      sessionStatus: result.thread.session?.status ?? null,
    },
    page: result.page ?? null,
    messages,
    messagesOmitted,
  };
}

export async function taskHistory(id: string, turnLimit: number, beforeCursor?: string) {
  return projectTaskHistory(await threadSnapshot(id, turnLimit, beforeCursor));
}
const BOOTSTRAP_TIMEOUT_MS = 180_000;

export function bootstrapRpcRequest(
  requestId: string,
  payload: Record<string, unknown>,
  tag = "orchestration.dispatchCommand",
) {
  return {
    _tag: "Request" as const,
    id: requestId,
    tag,
    payload,
    headers: [],
  };
}

export function bootstrapRpcResponse(frame: string, requestId: string):
  | { type: "ignore"; description: string }
  | { type: "success"; value: unknown }
  | { type: "failure"; message: string } {
  let response: {
    _tag?: unknown;
    requestId?: unknown;
    exit?: { _tag?: unknown; value?: unknown; cause?: unknown };
  };
  try {
    response = JSON.parse(frame);
  } catch {
    return { type: "failure", message: "T3 WebSocket bootstrap returned malformed JSON" };
  }
  const description = `${String(response._tag)} requestId=${String(response.requestId)}`;
  if (response._tag !== "Exit" || response.requestId !== requestId) {
    return { type: "ignore", description };
  }
  if (response.exit?._tag === "Success") return { type: "success", value: response.exit.value };
  return { type: "failure", message: `T3 WebSocket dispatch failed: ${JSON.stringify(response.exit?.cause ?? response.exit)}` };
}

async function requestRpc(
  tag: string,
  payload: Record<string, unknown>,
): Promise<any> {
  const base = await origin();
  const ticketResponse = await fetch(`${base}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token()}` },
  });
  if (!ticketResponse.ok) throw new Error(`T3 WebSocket ticket failed (${ticketResponse.status}): ${await ticketResponse.text()}`);
  const ticket = (await ticketResponse.json()) as { ticket?: unknown };
  if (typeof ticket.ticket !== "string" || !ticket.ticket) throw new Error("T3 WebSocket ticket response was invalid");
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = new URLSearchParams({ wsTicket: ticket.ticket }).toString();
  const requestId = id();
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    let lastFrame = "none";
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() => {
        socket.close();
        reject(new Error("T3 WebSocket bootstrap dispatch timed out after 180 seconds"));
      });
    }, BOOTSTRAP_TIMEOUT_MS);
    socket.addEventListener("open", () => socket.send(JSON.stringify(bootstrapRpcRequest(requestId, payload, tag))));
    socket.addEventListener("message", (event) => {
      const response = bootstrapRpcResponse(String(event.data), requestId);
      if (response.type === "ignore") {
        lastFrame = response.description;
        return;
      }
      finish(() => {
        socket.close();
        if (response.type === "success") resolve(response.value);
        else reject(new Error(response.message));
      });
    });
    socket.addEventListener("error", () => finish(() => reject(new Error("T3 WebSocket dispatch failed to connect"))));
    socket.addEventListener("close", (event) => finish(() => reject(new Error(`T3 WebSocket bootstrap closed before acknowledging the command (code ${event.code}${event.reason ? `: ${event.reason}` : ""}; last frame: ${lastFrame})`))));
  });
}

export const requiresRpcDispatch = (command: Record<string, unknown>): boolean =>
  (command.type === "thread.turn.start" && Boolean(command.bootstrap)) || command.type === "thread.archive" || command.type === "thread.settle";

export const dispatch = (command: Record<string, unknown>) =>
  requiresRpcDispatch(command)
    ? requestRpc("orchestration.dispatchCommand", command)
    : request("/api/orchestration/dispatch", { method: "POST", body: JSON.stringify(command) });

type ProviderCatalogEntry = {
  instanceId?: unknown;
  driver?: unknown;
  enabled?: unknown;
  installed?: unknown;
  status?: unknown;
  availability?: unknown;
  models?: unknown;
};

export function requireAvailableProviderSelection(
  config: unknown,
  selection: ModelSelection,
): string {
  const providers = config && typeof config === "object" && "providers" in config
    ? (config as { providers?: unknown }).providers
    : undefined;
  if (!Array.isArray(providers)) throw new Error("T3 provider catalog is unavailable");
  const provider = providers.find((entry): entry is ProviderCatalogEntry =>
    Boolean(entry && typeof entry === "object" && (entry as ProviderCatalogEntry).instanceId === selection.instanceId)
  );
  if (!provider) throw new Error(`T3 provider '${selection.instanceId}' is not configured`);
  if (typeof provider.driver !== "string" || provider.driver.trim() === "") {
    throw new Error(`T3 provider '${selection.instanceId}' has no driver identity`);
  }
  if (provider.enabled !== true || provider.installed !== true || provider.status !== "ready" || provider.availability === "unavailable") {
    throw new Error(`T3 provider '${selection.instanceId}' is not ready`);
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  const hasModel = models.some((model) => model && typeof model === "object" && (model as { slug?: unknown }).slug === selection.model);
  if (!hasModel) throw new Error(`T3 provider '${selection.instanceId}' does not expose model '${selection.model}'`);
  return provider.driver;
}

async function preflightProviderSelection(selection: ModelSelection): Promise<string> {
  const config = await requestRpc("server.getConfig", {});
  return requireAvailableProviderSelection(config, selection);
}

function now() { return new Date().toISOString(); }
function id() { return randomUUID(); }

export async function importProjects(): Promise<{ imported: string[]; skipped: string[] }> {
  const state = await Bun.file(`${process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`}/.codex-global-state.json`).json() as { "local-projects"?: Record<string, unknown> };
  const roots = new Map<string, string>();
  for (const [key, value] of Object.entries(state["local-projects"] ?? {})) {
    const title = (value && typeof value === "object" && "name" in value && typeof value.name === "string") ? value.name : key;
    const rawRoots = value && typeof value === "object" && "rootPaths" in value && Array.isArray(value.rootPaths)
      ? value.rootPaths.filter((root): root is string => typeof root === "string")
      : [];
    for (const root of rawRoots) {
      let real: string;
      try { real = await realpath(root); } catch { continue; }
      const git = await $`git -C ${real} rev-parse --show-toplevel`.nothrow().quiet();
      if (git.exitCode !== 0) continue;
      const canonical = git.text().trim();
      if (!canonical) continue;
      roots.set(canonical, title === "codex" && rawRoots.length > 1 ? canonical.split("/").at(-1) ?? title : title);
    }
  }
  const current = await snapshot();
  const active = new Set<string>();
  for (const project of current.projects.filter((entry) => !entry.deletedAt)) {
    try { active.add(await realpath(project.workspaceRoot)); } catch { /* stale T3 project */ }
  }
  const imported: string[] = [], skipped: string[] = [];
  for (const [workspaceRoot, title] of roots) {
    if (active.has(workspaceRoot)) { skipped.push(workspaceRoot); continue; }
    await dispatch({ type: "project.create", commandId: id(), projectId: id(), title, workspaceRoot, createWorkspaceRootIfMissing: false, defaultModelSelection: null, createdAt: now() });
    imported.push(workspaceRoot);
  }
  return { imported, skipped };
}

async function gitBaseBranch(workspaceRoot: string): Promise<string> {
  const originHead = await $`git -C ${workspaceRoot} symbolic-ref --quiet --short refs/remotes/origin/HEAD`.nothrow().quiet();
  if (originHead.exitCode === 0 && originHead.text().trim()) return originHead.text().trim().replace(/^origin\//, "");
  const current = await $`git -C ${workspaceRoot} branch --show-current`.quiet();
  const branch = current.text().trim();
  if (!branch) throw new Error(`Could not determine a Git base branch for ${workspaceRoot}`);
  return branch;
}

export async function createTask(input: { projectId: string; title: string; message: string; baseBranch?: string; provider?: string }): Promise<{ sequence: number; threadId: string; model: ModelSelection; worktreeRequired: true }> {
  const selection = await taskProviderDefaults(input.provider);
  await preflightProviderSelection(selection);
  const projects = await snapshot();
  const project = projects.projects.find((entry) => entry.id === input.projectId && !entry.deletedAt);
  if (!project) throw new Error(`Active T3 project not found: ${input.projectId}`);
  const threadId = id(), createdAt = now();
  const baseBranch = input.baseBranch ?? await gitBaseBranch(project.workspaceRoot);
  const result = await dispatch({
    type: "thread.turn.start", commandId: id(), threadId,
    message: { messageId: id(), role: "user", text: input.message, attachments: [] },
    modelSelection: selection, runtimeMode: "auto", interactionMode: "default", createdAt,
    bootstrap: {
      createThread: { projectId: project.id, title: input.title, modelSelection: selection, runtimeMode: "auto", interactionMode: "default", branch: baseBranch, worktreePath: null, createdAt },
      prepareWorktree: { projectCwd: project.workspaceRoot, baseBranch, branch: `t3code/${id().replaceAll("-", "").slice(0, 8)}`, startFromOrigin: true },
      runSetupScript: true,
    },
  });
  let created: T3Thread | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    await Bun.sleep(1000);
    created = await thread(threadId);
    if (created.worktreePath) break;
  }
  if (!created?.worktreePath) throw new Error(`T3 accepted task ${threadId} without creating a worktree`);
  const projectRoot = await realpath(project.workspaceRoot);
  const worktreeRoot = await realpath(created.worktreePath);
  if (worktreeRoot === projectRoot) throw new Error(`T3 task ${threadId} resolved to the primary checkout, not a worktree`);
  const worktrees = (await $`git -C ${projectRoot} worktree list --porcelain`.quiet()).text();
  if (!worktrees.split("\n").some((line) => line === `worktree ${worktreeRoot}`)) throw new Error(`T3 task ${threadId} path is not a registered Git worktree`);
  return { sequence: result.sequence, threadId, model: selection, worktreeRequired: true };
}

export function taskTurnCommand(target: T3Thread, message: string, commandId = id(), messageId = id(), createdAt = now(), providerDriver = target.modelSelection.instanceId) {
  const selection = requireSelection(target.modelSelection, providerDriver);
  return { type: "thread.turn.start", commandId, threadId: target.id, message: { messageId, role: "user", text: message, attachments: [] }, modelSelection: selection, runtimeMode: target.runtimeMode, interactionMode: target.interactionMode, createdAt };
}

export async function sendTask(threadId: string, message: string): Promise<{ sequence: number }> {
  const target = await thread(threadId);
  const selection = requireSelection(target.modelSelection);
  const providerDriver = await preflightProviderSelection(selection);
  return dispatch(taskTurnCommand(target, message, id(), id(), now(), providerDriver));
}

export function taskTitleCommand(threadId: string, title: string, commandId = id()) {
  return { type: "thread.meta.update", commandId, threadId, title };
}

export function taskApprovalRespondCommand(
  threadId: string,
  requestId: string,
  decision: ApprovalDecision,
  commandId = id(),
  createdAt = now(),
) {
  return approvalRespondCommand(threadId, requestId, decision, commandId, createdAt);
}

export function taskLifecycleCommand(
  action: "archive" | "unarchive" | "pin" | "unpin" | "settle" | "unsettle" | "interrupt",
  threadId: string,
  commandId = id(),
  createdAt = now(),
) {
  switch (action) {
    case "archive": return { type: "thread.archive", commandId, threadId };
    case "unarchive": return { type: "thread.unarchive", commandId, threadId };
    case "pin": return { type: "thread.pin", commandId, threadId };
    case "unpin": return { type: "thread.unpin", commandId, threadId };
    case "settle": return { type: "thread.settle", commandId, threadId };
    case "unsettle": return { type: "thread.unsettle", commandId, threadId, reason: "user" };
    case "interrupt": return { type: "thread.turn.interrupt", commandId, threadId, createdAt };
  }
}

export async function renameTask(threadId: string, title: string): Promise<{ sequence: number }> {
  return dispatch(taskTitleCommand(threadId, title));
}

export async function archiveTask(threadId: string, archived: boolean): Promise<{ sequence: number }> {
  return dispatch(taskLifecycleCommand(archived ? "archive" : "unarchive", threadId));
}

export async function pinTask(threadId: string, pinned: boolean): Promise<{ sequence: number }> {
  return dispatch(taskLifecycleCommand(pinned ? "pin" : "unpin", threadId));
}

export async function settleTask(threadId: string, settled: boolean): Promise<{ sequence: number }> {
  return dispatch(taskLifecycleCommand(settled ? "settle" : "unsettle", threadId));
}

export async function interruptTask(threadId: string): Promise<{ sequence: number }> {
  return dispatch(taskLifecycleCommand("interrupt", threadId));
}

const APPROVAL_TURN_WINDOW = 10;

export async function listTaskApprovals(projectId?: string) {
  const shell = await shellSnapshot();
  const candidates = shell.threads.filter((thread) =>
    !thread.deletedAt &&
    !thread.archivedAt &&
    thread.hasPendingApprovals &&
    (!projectId || thread.projectId === projectId)
  );
  const snapshots = new Map<string, ThreadSnapshot>();
  await Promise.all(candidates.map(async (thread) => {
    snapshots.set(thread.id, await threadSnapshot(thread.id, APPROVAL_TURN_WINDOW));
  }));
  return projectPendingApprovalList(candidates, snapshots);
}

export async function resolveTaskApproval(input: {
  threadId: string;
  requestId?: string;
  decision: ApprovalDecision;
  reason?: string;
}): Promise<{ sequence: number; threadId: string; requestId: string; decision: ApprovalDecision; command: string | null; reason?: string }> {
  const snapshot = await threadSnapshot(input.threadId, APPROVAL_TURN_WINDOW);
  const pending = derivePendingApprovals(threadActivities(snapshot));
  const selected = selectPendingApproval(pending, input.requestId);
  if (input.decision === "accept") requireIdentifiableApproval(selected);
  const result = await dispatch(taskApprovalRespondCommand(input.threadId, selected.requestId, input.decision));
  return {
    sequence: result.sequence,
    threadId: input.threadId,
    requestId: selected.requestId,
    decision: input.decision,
    command: selected.command,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}
