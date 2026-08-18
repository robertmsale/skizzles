#!/usr/bin/env bun
// @bun

// packages/t3-orchestration/src/daemon.ts
import { connect, createServer as createServer2 } from "net";
import { chmodSync } from "fs";
import { lstat as lstat2, mkdir as mkdir2, unlink } from "fs/promises";
import { dirname } from "path";

// packages/t3-orchestration/src/config.ts
import { join } from "path";
var {$ } = globalThis.Bun;

// packages/t3-orchestration/src/protocol.ts
function requireSelection(value, providerDriver) {
  if (!value || typeof value !== "object")
    throw new Error("Model selection is missing");
  const candidate = value;
  if (typeof candidate.instanceId !== "string" || typeof candidate.model !== "string") {
    throw new Error("Model selection is malformed");
  }
  if (candidate.instanceId.trim() === "" || candidate.model.trim() === "")
    throw new Error("Model selection has an empty provider or model");
  const driver = providerDriver ?? candidate.instanceId;
  const rawOptions = candidate.options === undefined ? [] : candidate.options;
  if (!Array.isArray(rawOptions))
    throw new Error("Model selection is malformed");
  const options = rawOptions.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.trim() === "")
      throw new Error("Model selection contains a malformed option");
    if (!(typeof entry.value === "string" || typeof entry.value === "boolean" || typeof entry.value === "number"))
      throw new Error(`Model option '${entry.id}' has an invalid value`);
    return { id: entry.id, value: entry.value };
  });
  if (new Set(options.map((entry) => entry.id)).size !== options.length)
    throw new Error("Model selection contains duplicate options");
  if (driver === "codex" && !options.some((entry) => entry.id === "reasoningEffort")) {
    throw new Error("Codex reasoning effort is missing");
  }
  return { instanceId: candidate.instanceId, model: candidate.model, options };
}

// packages/t3-orchestration/src/config.ts
var home = process.env.HOME ?? (() => {
  throw new Error("HOME is required");
})();
var CODEX_HOME = process.env.CODEX_HOME ?? join(home, ".codex");
var T3_HOME = process.env.T3_HOME ?? join(home, ".t3");
var SOCKET_PATH = process.env.T3_ORCHESTRATION_SOCKET ?? join(T3_HOME, "t3-orchestration.sock");
var DEFAULT_TAILSCALE_GATEWAY_PORT = 43773;
function parseTailscaleGatewayPort(value) {
  const normalized = value?.trim();
  if (!normalized)
    return DEFAULT_TAILSCALE_GATEWAY_PORT;
  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("T3_ORCHESTRATION_HTTP_PORT must be an integer from 1024 through 65535");
  }
  return port;
}
var TAILSCALE_GATEWAY_PORT = parseTailscaleGatewayPort(process.env.T3_ORCHESTRATION_HTTP_PORT);
var TAILSCALE_ALLOWED_USERS = (process.env.T3_ORCHESTRATION_TAILSCALE_USERS ?? "").split(",").map((login) => login.trim().toLowerCase()).filter(Boolean);
var KEYCHAIN_SERVICE = "t3-orchestration";
var KEYCHAIN_ACCOUNT = process.env.T3_ORCHESTRATION_KEYCHAIN_ACCOUNT ?? "access-token";
var GROK_DEFAULT_MODEL = "grok-4.6";
var CURSOR_INSTANCE_ID = "cursor";
var CURSOR_DEFAULT_MODEL = "grok-4.6";
var CURSOR_REASONING_OPTION_ID = "reasoning";
var CURSOR_REASONING_HIGH = "high";
var CURSOR_FAST_MODE_OPTION_ID = "fastMode";
var SUPPORTED_PROVIDERS = "codex, grok, cursor";
async function origin() {
  const path = join(T3_HOME, "userdata/server-runtime.json");
  const runtime = await Bun.file(path).json();
  if (typeof runtime.origin !== "string" || !/^https?:\/\//.test(runtime.origin))
    throw new Error(`Invalid T3 runtime origin in ${path}`);
  return runtime.origin.replace(/\/$/, "");
}
async function token() {
  const result = await $`security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`.quiet();
  const value = result.text().trim();
  if (!value)
    throw new Error("No T3 token. Run t3ctl auth configure.");
  return value;
}
async function codexDefaults() {
  const text = await Bun.file(join(CODEX_HOME, "config.toml")).text();
  const parsed = Bun.TOML.parse(text);
  const model = parsed.model;
  const effort = parsed.model_reasoning_effort;
  const provider = parsed.model_provider;
  const serviceTier = parsed.service_tier;
  if (typeof model !== "string" || typeof effort !== "string" || typeof provider !== "string") {
    throw new Error("config.toml must define model, model_reasoning_effort, and model_provider");
  }
  if (provider.length === 0)
    throw new Error("config.toml model_provider is empty");
  const selection = requireSelection({
    instanceId: "codex",
    model,
    options: [
      { id: "reasoningEffort", value: effort },
      ...typeof serviceTier === "string" ? [{ id: "serviceTier", value: serviceTier }] : []
    ]
  });
  if (!selection.options.some((entry) => entry.id === "reasoningEffort")) {
    throw new Error("Codex default reasoning effort is missing");
  }
  return selection;
}
async function taskProviderDefaults(provider) {
  switch (provider?.trim().toLowerCase() || "codex") {
    case "codex":
    case "openai":
      return codexDefaults();
    case "grok":
      return requireSelection({ instanceId: "grok", model: GROK_DEFAULT_MODEL, options: [] });
    case "cursor":
      return requireSelection({
        instanceId: CURSOR_INSTANCE_ID,
        model: CURSOR_DEFAULT_MODEL,
        options: [
          { id: CURSOR_REASONING_OPTION_ID, value: CURSOR_REASONING_HIGH },
          { id: CURSOR_FAST_MODE_OPTION_ID, value: false }
        ]
      });
    default:
      throw new Error(`Unsupported task provider '${provider}'. Supported providers: ${SUPPORTED_PROVIDERS}`);
  }
}

// packages/t3-orchestration/src/t3.ts
import { randomUUID } from "crypto";
import { realpath } from "fs/promises";
var {$: $2 } = globalThis.Bun;

// packages/t3-orchestration/src/approval-projection.ts
var MISSING_COMMAND_GAP = "T3 did not expose the command or path for this pending approval. Refusing to approve blindly.";
var MISSING_SNAPSHOT_GAP = "T3 reports hasPendingApprovals, but the thread snapshot window did not include an approval.requested activity with a request id.";
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function asTrimmedString(value) {
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function threadActivities(snapshot) {
  const activities = snapshot.thread.activities;
  if (!Array.isArray(activities))
    return [];
  return activities.filter((activity) => Boolean(activity && typeof activity === "object" && typeof activity.kind === "string" && typeof activity.createdAt === "string"));
}
function requestKindFromRequestType(requestType) {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}
function requestKindFromPayload(payload) {
  if (!payload)
    return null;
  if (payload.requestKind === "command" || payload.requestKind === "file-read" || payload.requestKind === "file-change") {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload.requestType);
}
function isStalePendingRequestFailureDetail(detail) {
  const normalized = detail?.toLowerCase();
  if (!normalized)
    return false;
  return normalized.includes("stale pending approval request") || normalized.includes("unknown pending approval request") || normalized.includes("unknown pending permission request");
}
function compareActivitiesByOrder(left, right) {
  if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  if (left.sequence !== undefined && right.sequence === undefined)
    return 1;
  if (left.sequence === undefined && right.sequence !== undefined)
    return -1;
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  if (createdAt !== 0)
    return createdAt;
  return (left.id ?? "").localeCompare(right.id ?? "");
}
function extractCommand(payload) {
  if (!payload)
    return null;
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const input = asRecord(data?.input) ?? asRecord(item?.input);
  const result = asRecord(item?.result) ?? asRecord(data?.result);
  return asTrimmedString(payload.detail) ?? asTrimmedString(data?.command) ?? asTrimmedString(item?.command) ?? asTrimmedString(input?.command) ?? asTrimmedString(result?.command) ?? asTrimmedString(payload.path) ?? asTrimmedString(data?.path) ?? asTrimmedString(item?.path) ?? asTrimmedString(input?.path);
}
function extractCwd(payload) {
  if (!payload)
    return null;
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const input = asRecord(data?.input) ?? asRecord(item?.input);
  return asTrimmedString(payload.cwd) ?? asTrimmedString(payload.workingDirectory) ?? asTrimmedString(data?.cwd) ?? asTrimmedString(data?.workingDirectory) ?? asTrimmedString(item?.cwd) ?? asTrimmedString(input?.cwd);
}
function extractToolName(activity, payload) {
  if (!payload)
    return asTrimmedString(activity.summary);
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  return asTrimmedString(payload.title) ?? asTrimmedString(data?.toolName) ?? asTrimmedString(item?.tool) ?? asTrimmedString(payload.itemType) ?? asTrimmedString(activity.summary);
}
function derivePendingApprovals(activities) {
  const openByRequestId = new Map;
  for (const activity of [...activities].sort(compareActivitiesByOrder)) {
    const payload = asRecord(activity.payload);
    const requestId = asTrimmedString(payload?.requestId);
    if (!requestId)
      continue;
    const detail = asTrimmedString(payload?.detail);
    if (activity.kind === "approval.requested") {
      const command = extractCommand(payload);
      openByRequestId.set(requestId, {
        requestId,
        requestKind: requestKindFromPayload(payload),
        createdAt: activity.createdAt,
        command,
        toolName: extractToolName(activity, payload),
        cwd: extractCwd(payload),
        identifiable: command !== null
      });
      continue;
    }
    if (activity.kind === "approval.resolved") {
      openByRequestId.delete(requestId);
      continue;
    }
    if (activity.kind === "provider.approval.respond.failed" && isStalePendingRequestFailureDetail(detail)) {
      openByRequestId.delete(requestId);
    }
  }
  return [...openByRequestId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.requestId.localeCompare(right.requestId));
}
function selectPendingApproval(pending, requestId) {
  const selector = requestId?.trim();
  if (selector) {
    const match = pending.find((approval) => approval.requestId === selector);
    if (!match)
      throw new Error(`No pending approval matches request id ${selector}`);
    return match;
  }
  if (pending.length === 0) {
    throw new Error("This thread has no pending approval in the T3 thread snapshot");
  }
  if (pending.length > 1) {
    throw new Error(`Thread has ${pending.length} pending approvals; pass the request id from t3ctl tasks approvals`);
  }
  return pending[0];
}
function requireIdentifiableApproval(approval) {
  if (approval.identifiable && approval.command)
    return;
  throw new Error(MISSING_COMMAND_GAP);
}
function threadProvider(thread) {
  return thread.modelSelection.instanceId;
}
function projectPendingApprovalList(threads, snapshots) {
  const approvals = [];
  const unidentifiable = [];
  for (const thread of threads) {
    if (thread.deletedAt || thread.archivedAt || !thread.hasPendingApprovals)
      continue;
    const snapshot = snapshots.get(thread.id);
    const pending = snapshot ? derivePendingApprovals(threadActivities(snapshot)) : [];
    if (pending.length === 0) {
      unidentifiable.push({
        threadId: thread.id,
        title: thread.title,
        projectId: thread.projectId,
        provider: threadProvider(thread),
        requestId: null,
        reason: MISSING_SNAPSHOT_GAP,
        createdAt: thread.updatedAt ?? null,
        worktreePath: thread.worktreePath
      });
      continue;
    }
    for (const approval of pending) {
      if (approval.identifiable && approval.command) {
        approvals.push({
          threadId: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          provider: threadProvider(thread),
          requestId: approval.requestId,
          requestKind: approval.requestKind,
          toolName: approval.toolName,
          command: approval.command,
          cwd: approval.cwd ?? thread.worktreePath,
          worktreePath: thread.worktreePath,
          createdAt: approval.createdAt
        });
        continue;
      }
      unidentifiable.push({
        threadId: thread.id,
        title: thread.title,
        projectId: thread.projectId,
        provider: threadProvider(thread),
        requestId: approval.requestId,
        reason: MISSING_COMMAND_GAP,
        createdAt: approval.createdAt,
        worktreePath: thread.worktreePath
      });
    }
  }
  approvals.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.threadId.localeCompare(right.threadId) || left.requestId.localeCompare(right.requestId));
  unidentifiable.sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? "") || left.threadId.localeCompare(right.threadId));
  return { approvals, unidentifiable, count: approvals.length };
}
function approvalRespondCommand(threadId, requestId, decision, commandId, createdAt) {
  return {
    type: "thread.approval.respond",
    commandId,
    threadId,
    requestId,
    decision,
    createdAt
  };
}

// packages/t3-orchestration/src/task-projection.ts
function taskPhase(thread) {
  const shell = thread;
  if (thread.deletedAt)
    return "deleted";
  if (thread.archivedAt)
    return "archived";
  if (shell.hasPendingApprovals)
    return "waiting_for_approval";
  if (shell.hasPendingUserInput)
    return "waiting_for_input";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error")
    return "failed";
  if (thread.session?.status === "starting")
    return "starting";
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running")
    return "running";
  if (thread.interactionMode === "plan" && shell.hasActionableProposedPlan)
    return "plan_ready";
  if (shell.backgroundLiveness === "working")
    return "running";
  if (shell.backgroundLiveness === "monitoring")
    return "monitoring";
  if (thread.latestTurn?.state === "completed")
    return "completed";
  if (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt !== null)
    return "completed";
  if (thread.session?.status === "ready" || thread.session?.status === "idle")
    return "completed";
  if (thread.session?.status === "stopped" || thread.session?.status === "interrupted")
    return "stopped";
  return "idle";
}
function taskCursor(thread) {
  const shell = thread;
  return Buffer.from(JSON.stringify([
    thread.updatedAt ?? null,
    thread.latestTurn?.turnId ?? null,
    thread.latestTurn?.state ?? null,
    thread.latestTurn?.completedAt ?? null,
    thread.session?.status ?? null,
    thread.session?.updatedAt ?? null,
    shell.hasPendingApprovals ?? false,
    shell.hasPendingUserInput ?? false,
    shell.hasActionableProposedPlan ?? false,
    shell.backgroundLiveness ?? null,
    thread.interactionMode,
    thread.archivedAt ?? null,
    thread.deletedAt ?? null
  ])).toString("base64url");
}
function projectName(projects, thread) {
  return projects.get(thread.projectId)?.title ?? null;
}
function projectedBackgroundLiveness(thread) {
  if (!Object.hasOwn(thread, "backgroundLiveness"))
    return "unknown";
  const value = thread.backgroundLiveness;
  if (value === null)
    return null;
  if (value === "working" || value === "monitoring" || value === "unknown")
    return value;
  return "unknown";
}
function projectTask(thread, projects, pinnedIndex) {
  const shell = thread;
  return {
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    projectTitle: projectName(projects, thread),
    phase: taskPhase(thread),
    sessionStatus: thread.session?.status ?? null,
    latestTurnState: thread.latestTurn?.state ?? null,
    pendingApproval: shell.hasPendingApprovals ?? false,
    pendingUserInput: shell.hasPendingUserInput ?? false,
    actionablePlan: shell.hasActionableProposedPlan ?? false,
    backgroundLiveness: projectedBackgroundLiveness(thread),
    pinnedIndex: pinnedIndex ?? null,
    archived: thread.archivedAt != null,
    deleted: thread.deletedAt != null,
    settled: thread.settledOverride === "settled",
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    workspaceRoot: projects.get(thread.projectId)?.workspaceRoot ?? null,
    updatedAt: thread.updatedAt ?? null,
    cursor: taskCursor(thread)
  };
}
var CLEANABLE_TASK_CAP = 5000;
function projectOccupiedWorktrees(...snapshots) {
  const occupied = [];
  const seen = new Set;
  for (const snapshot of snapshots) {
    for (const thread of snapshot.threads) {
      const path = thread.worktreePath?.trim();
      if (thread.deletedAt || !path)
        continue;
      const key = `${thread.id}\x00${path}`;
      if (seen.has(key))
        continue;
      seen.add(key);
      occupied.push({ id: thread.id, path });
    }
  }
  return occupied;
}
function projectCleanableWorktrees(snapshot) {
  const projects = new Map(snapshot.projects.filter((project) => !project.deletedAt).map((project) => [project.id, project]));
  const visible = snapshot.threads.filter((thread) => !thread.deletedAt && (thread.archivedAt != null || thread.settledOverride === "settled")).sort(compareRecent);
  const truncated = visible.length > CLEANABLE_TASK_CAP;
  return {
    snapshotSequence: snapshot.snapshotSequence,
    tasks: visible.slice(0, CLEANABLE_TASK_CAP).map((thread) => projectTask(thread, projects)),
    count: Math.min(visible.length, CLEANABLE_TASK_CAP),
    truncated,
    occupied: projectOccupiedWorktrees(snapshot)
  };
}
function comparePinned(left, right) {
  if (left.pinOrderKey && right.pinOrderKey)
    return left.pinOrderKey.localeCompare(right.pinOrderKey);
  if (left.pinOrderKey)
    return -1;
  if (right.pinOrderKey)
    return 1;
  return (left.pinnedAt ?? left.createdAt ?? "").localeCompare(right.pinnedAt ?? right.createdAt ?? "");
}
function compareRecent(left, right) {
  return (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? "");
}
function projectTaskList(snapshot, options) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
    throw new Error("Task list limit must be an integer from 1 through 200");
  }
  const projects = new Map(snapshot.projects.filter((project) => !project.deletedAt).map((project) => [project.id, project]));
  const visible = snapshot.threads.filter((thread) => !thread.deletedAt && (!options.projectId || thread.projectId === options.projectId) && (options.includeArchived || !thread.archivedAt) && (options.includeSettled || thread.settledOverride !== "settled"));
  const pinned = visible.filter((thread) => thread.pinnedAt).sort(comparePinned);
  const recent = visible.filter((thread) => !thread.pinnedAt).sort(compareRecent).slice(0, options.limit);
  return {
    snapshotSequence: snapshot.snapshotSequence,
    tasks: [
      ...pinned.map((thread, index) => projectTask(thread, projects, index + 1)),
      ...recent.map((thread) => projectTask(thread, projects))
    ],
    pinnedCount: pinned.length,
    recentCount: recent.length,
    moreRecent: Math.max(0, visible.length - pinned.length - recent.length)
  };
}
function projectProjects(snapshot) {
  const projects = snapshot.projects.filter((project) => !project.deletedAt).sort((left, right) => left.title.localeCompare(right.title)).map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot }));
  return { projects, count: projects.length };
}
function mergeArchivedTasks(shell, full) {
  const activeIds = new Set(shell.threads.map((thread) => thread.id));
  const extras = full.threads.filter((thread) => !activeIds.has(thread.id) && !thread.deletedAt).map((thread) => ({
    ...thread,
    backgroundLiveness: Object.hasOwn(thread, "backgroundLiveness") ? thread.backgroundLiveness ?? null : "unknown"
  }));
  return {
    snapshotSequence: Math.max(shell.snapshotSequence, full.snapshotSequence),
    projects: full.projects,
    threads: [...shell.threads, ...extras],
    updatedAt: shell.updatedAt
  };
}
function isWakePhase(phase) {
  return phase === "completed" || phase === "failed" || phase === "waiting_for_approval" || phase === "waiting_for_input" || phase === "plan_ready" || phase === "archived" || phase === "deleted";
}
async function waitForTasks(input, loadSnapshot, sleep = Bun.sleep, clock = Date.now, loadMissing) {
  const uniqueIds = new Set(input.threadIds);
  if (uniqueIds.size !== input.threadIds.length || uniqueIds.size < 1 || uniqueIds.size > 8) {
    throw new Error("Task wait requires 1 through 8 unique task ids");
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 3600000) {
    throw new Error("Task wait timeout must be an integer from 0 through 3600000 milliseconds");
  }
  const unknownCursors = Object.keys(input.after).filter((threadId) => !uniqueIds.has(threadId));
  if (unknownCursors.length)
    throw new Error(`Wait cursor does not match a target task: ${unknownCursors.join(", ")}`);
  const deadline = clock() + input.timeoutMs;
  while (true) {
    const snapshot = await loadSnapshot();
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    const missing = input.threadIds.filter((threadId) => !byId.has(threadId));
    if (missing.length && loadMissing) {
      for (const thread of await loadMissing(missing))
        byId.set(thread.id, thread);
    }
    const unresolved = input.threadIds.filter((threadId) => !byId.has(threadId));
    if (unresolved.length)
      throw new Error(`T3 task not found: ${unresolved.join(", ")}`);
    const tasks = input.threadIds.map((threadId) => projectTask(byId.get(threadId), projects));
    const ready = tasks.filter((task) => isWakePhase(task.phase) && input.after[task.id] !== task.cursor);
    if (ready.length)
      return { timedOut: false, ready: ready.map((task) => task.id), tasks };
    const remaining = deadline - clock();
    if (remaining <= 0)
      return { timedOut: true, ready: [], tasks };
    await sleep(Math.min(1000, remaining));
  }
}

// packages/t3-orchestration/src/worktree-reaper-lease.ts
import { createHash } from "crypto";
import { link, lstat, mkdir, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join as join2 } from "path";
function cleanLeaseHome(home2 = process.env.T3_HOME?.trim() || join2(process.env.HOME || homedir(), ".t3")) {
  return join2(home2, "worktree-reaper-leases");
}
function cleanLeaseLockPath(worktreePath, home2) {
  const digest = createHash("sha256").update(worktreePath).digest("hex");
  return join2(cleanLeaseHome(home2), digest);
}
function defaultProcessProbe(pid) {
  process.kill(pid, 0);
}
function defaultProcessStartKey(pid) {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], {
    stdout: "pipe",
    stderr: "pipe"
  });
  if (result.exitCode !== 0)
    return null;
  const text = result.stdout.toString().trim();
  return text || null;
}
function isLivePid(pid, processProbe) {
  try {
    processProbe(pid);
    return true;
  } catch {
    return false;
  }
}
function parseLeaseRecord(value) {
  if (!value || typeof value !== "object")
    return null;
  const raw = value;
  if (typeof raw.token !== "string" || raw.token.trim() === "" || typeof raw.threadId !== "string" || raw.threadId.trim() === "" || typeof raw.path !== "string" || raw.path.trim() === "" || raw.role !== "clean" && raw.role !== "turn-start" || !Number.isInteger(raw.pid) || (raw.pid ?? 0) <= 0) {
    return null;
  }
  return {
    token: raw.token,
    threadId: raw.threadId,
    path: raw.path,
    role: raw.role,
    pid: raw.pid,
    startKey: typeof raw.startKey === "string" || raw.startKey === null ? raw.startKey : null,
    acquiredAt: typeof raw.acquiredAt === "string" ? raw.acquiredAt : ""
  };
}
function isLiveLeaseRecord(record, fns = {}) {
  const processProbe = fns.processProbe ?? defaultProcessProbe;
  const processStartKey = fns.processStartKey ?? defaultProcessStartKey;
  if (typeof record.startKey !== "string" || record.startKey.trim() === "")
    return false;
  if (!isLivePid(record.pid, processProbe))
    return false;
  const currentStart = processStartKey(record.pid);
  if (currentStart === null || currentStart !== record.startKey)
    return false;
  return true;
}
function lockIdentity(info) {
  if (info.dev < 0n || info.ino <= 0n)
    return;
  return { dev: info.dev, ino: info.ino };
}
async function hasIdentity(path, expected) {
  try {
    const current = lockIdentity(await lstat(path, { bigint: true }));
    return Boolean(current && current.dev === expected.dev && current.ino === expected.ino);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
async function readLiveCleanLease(worktreePath, home2, fns = {}) {
  const path = cleanLeaseLockPath(worktreePath, home2);
  try {
    const record = parseLeaseRecord(JSON.parse(await Bun.file(path).text()));
    if (!record || !isLiveLeaseRecord(record, fns))
      return null;
    return record;
  } catch {
    return null;
  }
}
async function inspectLock(lockPath, fns) {
  try {
    const identity = lockIdentity(await lstat(lockPath, { bigint: true }));
    let record = null;
    try {
      record = parseLeaseRecord(JSON.parse(await Bun.file(lockPath).text()));
    } catch {
      record = null;
    }
    return { identity, record, live: Boolean(record && isLiveLeaseRecord(record, fns)) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { identity: undefined, record: null, live: false };
    }
    throw error;
  }
}
function reclaimClaimPath(lockPath) {
  return `${lockPath}.reclaim`;
}
function parseReclaimClaim(value) {
  if (!value || typeof value !== "object")
    return null;
  const raw = value;
  if (!Number.isInteger(raw.pid) || (raw.pid ?? 0) <= 0 || typeof raw.token !== "string" || raw.token.trim() === "" || typeof raw.createdAt !== "string") {
    return null;
  }
  return {
    pid: raw.pid,
    startKey: typeof raw.startKey === "string" ? raw.startKey : null,
    token: raw.token,
    createdAt: raw.createdAt
  };
}
function isLiveReclaimClaim(record, fns) {
  return isLiveLeaseRecord({
    token: record.token,
    threadId: "reclaim",
    path: "reclaim",
    role: "clean",
    pid: record.pid,
    startKey: record.startKey,
    acquiredAt: record.createdAt
  }, fns);
}
async function unlinkIfSameIdentity(path, inspected) {
  if (!await hasIdentity(path, inspected))
    return false;
  await rm(path, { force: true });
  return !await hasIdentity(path, inspected);
}
async function recoverOrphanReclaimClaim(lockPath, fns) {
  const claimPath = reclaimClaimPath(lockPath);
  try {
    const identity = lockIdentity(await lstat(claimPath, { bigint: true }));
    if (!identity)
      return false;
    let record = null;
    try {
      record = parseReclaimClaim(JSON.parse(await Bun.file(claimPath).text()));
    } catch {
      record = null;
    }
    if (record && isLiveReclaimClaim(record, fns))
      return false;
    return await unlinkIfSameIdentity(claimPath, identity);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}
async function withReclaimMutex(lockPath, fn, fns = {}, hooks = {}) {
  const token2 = crypto.randomUUID();
  const claimPath = reclaimClaimPath(lockPath);
  const processStartKey = fns.processStartKey ?? defaultProcessStartKey;
  const record = {
    pid: process.pid,
    startKey: processStartKey(process.pid),
    token: token2,
    createdAt: new Date().toISOString()
  };
  for (let attempt = 0;attempt < 3; attempt++) {
    await recoverOrphanReclaimClaim(lockPath, fns);
    const candidate = `${claimPath}.candidate-${process.pid}-${token2}-${attempt}`;
    await writeFile(candidate, `${JSON.stringify(record)}
`, { mode: 384, flag: "wx" });
    const candidateIdentity = lockIdentity(await lstat(candidate, { bigint: true }));
    let claimed = false;
    try {
      if (!candidateIdentity)
        throw new Error("could not identity a reclaim claim candidate");
      try {
        await link(candidate, claimPath);
        claimed = true;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code === "EEXIST" || code === "ENOTEMPTY") {
          if (attempt === 2)
            throw new Error(`worktree lease reclaim is busy at ${lockPath}`);
          continue;
        }
        throw error;
      }
      if (!await hasIdentity(claimPath, candidateIdentity)) {
        if (attempt === 2)
          throw new Error(`worktree lease reclaim is busy at ${lockPath}`);
        continue;
      }
      if (hooks.beforeUnlink)
        await hooks.beforeUnlink();
      return await fn();
    } finally {
      await rm(candidate, { force: true });
      if (claimed && candidateIdentity)
        await unlinkIfSameIdentity(claimPath, candidateIdentity);
    }
  }
  throw new Error(`worktree lease reclaim is busy at ${lockPath}`);
}
async function reclaimStaleLock(lockPath, inspected, fns, hooks = {}) {
  return await withReclaimMutex(lockPath, async () => {
    if (!await hasIdentity(lockPath, inspected))
      return false;
    return await unlinkIfSameIdentity(lockPath, inspected);
  }, fns, hooks);
}
function reservationError(path, existing, requested) {
  if (existing?.role === "clean" || existing == null && requested === "clean") {
    return new Error(existing ? `worktree ${path} is reserved for artifact cleanup by task ${existing.threadId}` : `worktree ${path} already has a clean lease`);
  }
  if (existing?.role === "turn-start") {
    return new Error(`worktree ${path} has a turn start in progress for task ${existing.threadId}`);
  }
  return new Error(`worktree ${path} already has a clean lease`);
}
async function acquireWorktreeGate(path, threadId, role, options = {}) {
  const token2 = crypto.randomUUID();
  const lockPath = cleanLeaseLockPath(path, options.home);
  await mkdir(cleanLeaseHome(options.home), { recursive: true, mode: 448 });
  const processStartKey = options.processStartKey ?? defaultProcessStartKey;
  const startKey = processStartKey(process.pid);
  if (!startKey)
    throw new Error("could not record process start key for worktree lease");
  const record = {
    token: token2,
    threadId,
    path,
    role,
    pid: process.pid,
    startKey,
    acquiredAt: (options.now ?? (() => new Date().toISOString()))()
  };
  const fns = {
    processProbe: options.processProbe,
    processStartKey: options.processStartKey
  };
  let acquiredIdentity;
  for (let attempt = 0;attempt < 3; attempt++) {
    const candidate = `${lockPath}.candidate-${process.pid}-${token2}-${attempt}`;
    await writeFile(candidate, `${JSON.stringify(record)}
`, { mode: 384, flag: "wx" });
    try {
      await link(candidate, lockPath);
      acquiredIdentity = lockIdentity(await lstat(lockPath, { bigint: true }));
      break;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST")
        throw error;
      const inspected = await inspectLock(lockPath, fns);
      if (inspected.live)
        throw reservationError(path, inspected.record, role);
      if (!inspected.identity) {
        if (attempt === 2)
          throw reservationError(path, inspected.record, role);
        continue;
      }
      const reclaimed = await reclaimStaleLock(lockPath, inspected.identity, fns, { beforeUnlink: options.beforeUnlink });
      if (!reclaimed && attempt === 2)
        throw reservationError(path, await readLiveCleanLease(path, options.home, fns), role);
    } finally {
      await rm(candidate, { force: true });
    }
  }
  if (!acquiredIdentity)
    throw reservationError(path, await readLiveCleanLease(path, options.home, fns), role);
  const heldIdentity = acquiredIdentity;
  const controller = new AbortController;
  return {
    token: token2,
    path,
    threadId,
    role,
    signal: controller.signal,
    abort() {
      if (!controller.signal.aborted)
        controller.abort();
    },
    async release() {
      if (!controller.signal.aborted)
        controller.abort();
      try {
        await withReclaimMutex(lockPath, async () => {
          const current = parseLeaseRecord(JSON.parse(await Bun.file(lockPath).text()));
          if (!current || current.token !== token2)
            return;
          if (!await hasIdentity(lockPath, heldIdentity))
            return;
          await unlinkIfSameIdentity(lockPath, heldIdentity);
        }, fns);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return;
        if (error instanceof SyntaxError)
          return;
      }
    }
  };
}
async function withWorktreeGate(path, threadId, role, fn, options = {}) {
  const gate = await acquireWorktreeGate(path, threadId, role, options);
  try {
    return await fn(gate);
  } finally {
    await gate.release();
  }
}

// packages/t3-orchestration/src/t3.ts
async function request(path, init = {}, maxBodyBytes = 2000000) {
  const response = await fetch(`${await origin()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json", ...init.headers ?? {} }
  });
  if (!response.body)
    throw new Error(`${init.method ?? "GET"} ${path} returned no body`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done)
      break;
    size += next.value.byteLength;
    if (size > maxBodyBytes) {
      await reader.cancel();
      throw new Error(`${init.method ?? "GET"} ${path} response exceeded ${maxBodyBytes} bytes`);
    }
    chunks.push(next.value);
  }
  const body = new TextDecoder().decode(Buffer.concat(chunks));
  if (!response.ok)
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}
var snapshot = () => request("/api/orchestration/snapshot");
var shellSnapshot = () => request("/api/orchestration/shell", {}, 2000000);
var threadSnapshot = (id, turnLimit, beforeCursor) => {
  if (!Number.isInteger(turnLimit) || turnLimit < 1 || turnLimit > 10)
    throw new Error("History --turns must be an integer from 1 through 10");
  const query = new URLSearchParams({ turnLimit: String(turnLimit) });
  if (beforeCursor?.trim())
    query.set("beforeCursor", beforeCursor.trim());
  return request(`/api/orchestration/threads/${encodeURIComponent(id)}?${query}`, {}, 512000);
};
function projectThread(result) {
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
      updatedAt: source.session.updatedAt
    } : null
  };
}
var thread = async (id) => projectThread(await threadSnapshot(id, 1));
var projectList = async () => projectProjects(await snapshot());
var taskList = async (options) => {
  const shell = await shellSnapshot();
  const source = options.includeArchived ? mergeArchivedTasks(shell, await snapshot()) : shell;
  return projectTaskList(source, options);
};
var taskWait = async (input) => waitForTasks(input, shellSnapshot, Bun.sleep, Date.now, async (threadIds) => {
  const full = await snapshot();
  const ids = new Set(threadIds);
  return full.threads.filter((entry) => ids.has(entry.id));
});
var taskStatus = async (id) => {
  const shell = await shellSnapshot();
  const active = shell.threads.find((entry) => entry.id === id);
  if (active)
    return projectTask(active, new Map(shell.projects.map((project) => [project.id, project])));
  const [result, full] = await Promise.all([threadSnapshot(id, 1), snapshot()]);
  return projectTask(result.thread, new Map(full.projects.map((project) => [project.id, project])));
};
var listCleanableWorktrees = async () => {
  const [shell, full] = await Promise.all([shellSnapshot(), snapshot()]);
  const merged = mergeArchivedTasks(shell, full);
  return {
    ...projectCleanableWorktrees(merged),
    occupied: projectOccupiedWorktrees(shell, full)
  };
};
var HISTORY_MESSAGE_CHAR_LIMIT = 8000;
var HISTORY_TOTAL_CHAR_LIMIT = 32000;
function projectTaskHistory(result) {
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
      createdAt: message.createdAt
    });
    remaining -= text.length;
  }
  messages.reverse();
  return {
    thread: {
      id: result.thread.id,
      projectId: result.thread.projectId,
      title: result.thread.title,
      sessionStatus: result.thread.session?.status ?? null
    },
    page: result.page ?? null,
    messages,
    messagesOmitted
  };
}
async function taskHistory(id, turnLimit, beforeCursor) {
  return projectTaskHistory(await threadSnapshot(id, turnLimit, beforeCursor));
}
var BOOTSTRAP_TIMEOUT_MS = 180000;
function bootstrapRpcRequest(requestId, payload, tag = "orchestration.dispatchCommand") {
  return {
    _tag: "Request",
    id: requestId,
    tag,
    payload,
    headers: []
  };
}
function bootstrapRpcResponse(frame, requestId) {
  let response;
  try {
    response = JSON.parse(frame);
  } catch {
    return { type: "failure", message: "T3 WebSocket bootstrap returned malformed JSON" };
  }
  const description = `${String(response._tag)} requestId=${String(response.requestId)}`;
  if (response._tag !== "Exit" || response.requestId !== requestId) {
    return { type: "ignore", description };
  }
  if (response.exit?._tag === "Success")
    return { type: "success", value: response.exit.value };
  return { type: "failure", message: `T3 WebSocket dispatch failed: ${JSON.stringify(response.exit?.cause ?? response.exit)}` };
}
async function requestRpc(tag, payload) {
  const base = await origin();
  const ticketResponse = await fetch(`${base}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token()}` }
  });
  if (!ticketResponse.ok)
    throw new Error(`T3 WebSocket ticket failed (${ticketResponse.status}): ${await ticketResponse.text()}`);
  const ticket = await ticketResponse.json();
  if (typeof ticket.ticket !== "string" || !ticket.ticket)
    throw new Error("T3 WebSocket ticket response was invalid");
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = new URLSearchParams({ wsTicket: ticket.ticket }).toString();
  const requestId = id();
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    let lastFrame = "none";
    const finish = (callback) => {
      if (settled)
        return;
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
        if (response.type === "success")
          resolve(response.value);
        else
          reject(new Error(response.message));
      });
    });
    socket.addEventListener("error", () => finish(() => reject(new Error("T3 WebSocket dispatch failed to connect"))));
    socket.addEventListener("close", (event) => finish(() => reject(new Error(`T3 WebSocket bootstrap closed before acknowledging the command (code ${event.code}${event.reason ? `: ${event.reason}` : ""}; last frame: ${lastFrame})`))));
  });
}
var requiresRpcDispatch = (command) => command.type === "thread.turn.start" && Boolean(command.bootstrap) || command.type === "thread.archive" || command.type === "thread.settle";
function isExistingTaskTurnStart(command) {
  return command.type === "thread.turn.start" && !command.bootstrap;
}
var transmitDispatch = (command) => requiresRpcDispatch(command) ? requestRpc("orchestration.dispatchCommand", command) : request("/api/orchestration/dispatch", { method: "POST", body: JSON.stringify(command) });
async function resolveExistingTaskTurnPath(threadId, loadThread = thread) {
  const target = await loadThread(threadId);
  const claimed = target.worktreePath?.trim();
  if (!claimed)
    return `thread:${threadId}`;
  try {
    return await realpath(claimed);
  } catch {
    return claimed;
  }
}
async function startExistingTaskTurn(command, deps = {}) {
  const threadId = typeof command.threadId === "string" ? command.threadId.trim() : "";
  if (!threadId)
    throw new Error("thread.turn.start requires a thread id");
  const path = await (deps.resolvePath ?? resolveExistingTaskTurnPath)(threadId);
  return withWorktreeGate(path, threadId, "turn-start", async () => (deps.dispatchCommand ?? transmitDispatch)(command), { home: deps.home });
}
async function rawDispatch(command, deps = {}) {
  if (isExistingTaskTurnStart(command)) {
    return startExistingTaskTurn(command, { ...deps, dispatchCommand: deps.dispatchCommand ?? transmitDispatch });
  }
  return (deps.dispatchCommand ?? transmitDispatch)(command);
}
var dispatch = rawDispatch;
function requireAvailableProviderSelection(config, selection) {
  const providers = config && typeof config === "object" && "providers" in config ? config.providers : undefined;
  if (!Array.isArray(providers))
    throw new Error("T3 provider catalog is unavailable");
  const provider = providers.find((entry) => Boolean(entry && typeof entry === "object" && entry.instanceId === selection.instanceId));
  if (!provider)
    throw new Error(`T3 provider '${selection.instanceId}' is not configured`);
  if (typeof provider.driver !== "string" || provider.driver.trim() === "") {
    throw new Error(`T3 provider '${selection.instanceId}' has no driver identity`);
  }
  if (provider.enabled !== true || provider.installed !== true || provider.status !== "ready" || provider.availability === "unavailable") {
    throw new Error(`T3 provider '${selection.instanceId}' is not ready`);
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  const hasModel = models.some((model) => model && typeof model === "object" && model.slug === selection.model);
  if (!hasModel)
    throw new Error(`T3 provider '${selection.instanceId}' does not expose model '${selection.model}'`);
  return provider.driver;
}
async function preflightProviderSelection(selection) {
  const config = await requestRpc("server.getConfig", {});
  return requireAvailableProviderSelection(config, selection);
}
function now() {
  return new Date().toISOString();
}
function id() {
  return randomUUID();
}
async function importProjects() {
  const state = await Bun.file(`${process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`}/.codex-global-state.json`).json();
  const roots = new Map;
  for (const [key, value] of Object.entries(state["local-projects"] ?? {})) {
    const title = value && typeof value === "object" && "name" in value && typeof value.name === "string" ? value.name : key;
    const rawRoots = value && typeof value === "object" && "rootPaths" in value && Array.isArray(value.rootPaths) ? value.rootPaths.filter((root) => typeof root === "string") : [];
    for (const root of rawRoots) {
      let real;
      try {
        real = await realpath(root);
      } catch {
        continue;
      }
      const git = await $2`git -C ${real} rev-parse --show-toplevel`.nothrow().quiet();
      if (git.exitCode !== 0)
        continue;
      const canonical = git.text().trim();
      if (!canonical)
        continue;
      roots.set(canonical, title === "codex" && rawRoots.length > 1 ? canonical.split("/").at(-1) ?? title : title);
    }
  }
  const current = await snapshot();
  const active = new Set;
  for (const project of current.projects.filter((entry) => !entry.deletedAt)) {
    try {
      active.add(await realpath(project.workspaceRoot));
    } catch {}
  }
  const imported = [], skipped = [];
  for (const [workspaceRoot, title] of roots) {
    if (active.has(workspaceRoot)) {
      skipped.push(workspaceRoot);
      continue;
    }
    await dispatch({ type: "project.create", commandId: id(), projectId: id(), title, workspaceRoot, createWorkspaceRootIfMissing: false, defaultModelSelection: null, createdAt: now() });
    imported.push(workspaceRoot);
  }
  return { imported, skipped };
}
async function gitBaseBranch(workspaceRoot) {
  const originHead = await $2`git -C ${workspaceRoot} symbolic-ref --quiet --short refs/remotes/origin/HEAD`.nothrow().quiet();
  if (originHead.exitCode === 0 && originHead.text().trim())
    return originHead.text().trim().replace(/^origin\//, "");
  const current = await $2`git -C ${workspaceRoot} branch --show-current`.quiet();
  const branch = current.text().trim();
  if (!branch)
    throw new Error(`Could not determine a Git base branch for ${workspaceRoot}`);
  return branch;
}
async function createTask(input) {
  const selection = await taskProviderDefaults(input.provider);
  await preflightProviderSelection(selection);
  const projects = await snapshot();
  const project = projects.projects.find((entry) => entry.id === input.projectId && !entry.deletedAt);
  if (!project)
    throw new Error(`Active T3 project not found: ${input.projectId}`);
  const threadId = id(), createdAt = now();
  const baseBranch = input.baseBranch ?? await gitBaseBranch(project.workspaceRoot);
  const result = await dispatch({
    type: "thread.turn.start",
    commandId: id(),
    threadId,
    message: { messageId: id(), role: "user", text: input.message, attachments: [] },
    modelSelection: selection,
    runtimeMode: "auto",
    interactionMode: "default",
    createdAt,
    bootstrap: {
      createThread: { projectId: project.id, title: input.title, modelSelection: selection, runtimeMode: "auto", interactionMode: "default", branch: baseBranch, worktreePath: null, createdAt },
      prepareWorktree: { projectCwd: project.workspaceRoot, baseBranch, branch: `t3code/${id().replaceAll("-", "").slice(0, 8)}`, startFromOrigin: true },
      runSetupScript: true
    }
  });
  let created;
  for (let attempt = 0;attempt < 30; attempt++) {
    await Bun.sleep(1000);
    created = await thread(threadId);
    if (created.worktreePath)
      break;
  }
  if (!created?.worktreePath)
    throw new Error(`T3 accepted task ${threadId} without creating a worktree`);
  const projectRoot = await realpath(project.workspaceRoot);
  const worktreeRoot = await realpath(created.worktreePath);
  if (worktreeRoot === projectRoot)
    throw new Error(`T3 task ${threadId} resolved to the primary checkout, not a worktree`);
  const worktrees = (await $2`git -C ${projectRoot} worktree list --porcelain`.quiet()).text();
  if (!worktrees.split(`
`).some((line) => line === `worktree ${worktreeRoot}`))
    throw new Error(`T3 task ${threadId} path is not a registered Git worktree`);
  return { sequence: result.sequence, threadId, model: selection, worktreeRequired: true };
}
function taskTurnCommand(target, message, commandId = id(), messageId = id(), createdAt = now(), providerDriver = target.modelSelection.instanceId) {
  const selection = requireSelection(target.modelSelection, providerDriver);
  return { type: "thread.turn.start", commandId, threadId: target.id, message: { messageId, role: "user", text: message, attachments: [] }, modelSelection: selection, runtimeMode: target.runtimeMode, interactionMode: target.interactionMode, createdAt };
}
async function sendTask(threadId, message) {
  const target = await thread(threadId);
  const selection = requireSelection(target.modelSelection);
  const providerDriver = await preflightProviderSelection(selection);
  return await startExistingTaskTurn(taskTurnCommand(target, message, id(), id(), now(), providerDriver));
}
function taskTitleCommand(threadId, title, commandId = id()) {
  return { type: "thread.meta.update", commandId, threadId, title };
}
function taskApprovalRespondCommand(threadId, requestId, decision, commandId = id(), createdAt = now()) {
  return approvalRespondCommand(threadId, requestId, decision, commandId, createdAt);
}
function taskLifecycleCommand(action, threadId, commandId = id(), createdAt = now()) {
  switch (action) {
    case "archive":
      return { type: "thread.archive", commandId, threadId };
    case "unarchive":
      return { type: "thread.unarchive", commandId, threadId };
    case "pin":
      return { type: "thread.pin", commandId, threadId };
    case "unpin":
      return { type: "thread.unpin", commandId, threadId };
    case "settle":
      return { type: "thread.settle", commandId, threadId };
    case "unsettle":
      return { type: "thread.unsettle", commandId, threadId, reason: "user" };
    case "interrupt":
      return { type: "thread.turn.interrupt", commandId, threadId, createdAt };
  }
}
async function renameTask(threadId, title) {
  return dispatch(taskTitleCommand(threadId, title));
}
async function archiveTask(threadId, archived) {
  return dispatch(taskLifecycleCommand(archived ? "archive" : "unarchive", threadId));
}
async function pinTask(threadId, pinned) {
  return dispatch(taskLifecycleCommand(pinned ? "pin" : "unpin", threadId));
}
async function settleTask(threadId, settled) {
  return dispatch(taskLifecycleCommand(settled ? "settle" : "unsettle", threadId));
}
async function interruptTask(threadId) {
  return dispatch(taskLifecycleCommand("interrupt", threadId));
}
var APPROVAL_TURN_WINDOW = 10;
async function listTaskApprovals(projectId) {
  const shell = await shellSnapshot();
  const candidates = shell.threads.filter((thread2) => !thread2.deletedAt && !thread2.archivedAt && thread2.hasPendingApprovals && (!projectId || thread2.projectId === projectId));
  const snapshots = new Map;
  await Promise.all(candidates.map(async (thread2) => {
    snapshots.set(thread2.id, await threadSnapshot(thread2.id, APPROVAL_TURN_WINDOW));
  }));
  return projectPendingApprovalList(candidates, snapshots);
}
async function resolveTaskApproval(input) {
  const snapshot2 = await threadSnapshot(input.threadId, APPROVAL_TURN_WINDOW);
  const pending = derivePendingApprovals(threadActivities(snapshot2));
  const selected = selectPendingApproval(pending, input.requestId);
  if (input.decision === "accept")
    requireIdentifiableApproval(selected);
  const result = await dispatch(taskApprovalRespondCommand(input.threadId, selected.requestId, input.decision));
  return {
    sequence: result.sequence,
    threadId: input.threadId,
    requestId: selected.requestId,
    decision: input.decision,
    command: selected.command,
    ...input.reason ? { reason: input.reason } : {}
  };
}

// packages/t3-orchestration/src/identity.ts
import { Database } from "bun:sqlite";
import { join as join3 } from "path";
function rootProviderId(id2, db) {
  const edges = db.query("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges").all();
  const parentByChild = new Map(edges.map((edge) => [edge.child_thread_id, edge.parent_thread_id]));
  const seen = new Set;
  let current = id2;
  while (parentByChild.has(current)) {
    if (!seen.add(current))
      throw new Error("Codex spawn graph contains a cycle");
    current = parentByChild.get(current);
  }
  return current;
}
function resolveCallerThread(correlationId) {
  const codexThreadId = typeof correlationId === "string" ? correlationId.trim() : "";
  if (!codexThreadId)
    throw new Error("CODEX_THREAD_ID is required for task-to-task orchestration");
  const codexDb = new Database(join3(CODEX_HOME, "state_5.sqlite"), { readonly: true });
  const root = rootProviderId(codexThreadId, codexDb);
  codexDb.close();
  const t3Db = new Database(join3(T3_HOME, "userdata/state.sqlite"), { readonly: true });
  const rows = t3Db.query("SELECT thread_id, project_id FROM projection_threads WHERE json_extract((SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id = projection_threads.thread_id), '$.threadId') = ? AND deleted_at IS NULL").all(root);
  t3Db.close();
  if (rows.length !== 1)
    throw new Error(`Could not uniquely map Codex root ${root} to a live T3 task`);
  const row = rows[0];
  return { codexThreadId, t3ThreadId: row.thread_id, projectId: row.project_id };
}

// packages/t3-orchestration/src/commands.ts
async function executeCommand(command, dependencies) {
  const caller = command.op === "tasks.create" ? dependencies.resolveCallerThread(command.callerThreadId) : null;
  const projectId = command.op === "tasks.create" && command.projectId === "current" ? caller?.projectId : command.projectId;
  if (caller && command.op === "tasks.create" && projectId !== caller.projectId) {
    throw new Error("A root may create tasks only in its own T3 project");
  }
  switch (command.op) {
    case "projects.import":
      return dependencies.importProjects();
    case "projects.list":
      return dependencies.projectList();
    case "handoff.create":
      return dependencies.createTask({
        projectId: String(command.projectId),
        title: String(command.title),
        message: String(command.message),
        ...command.baseBranch ? { baseBranch: String(command.baseBranch) } : {},
        ...command.provider ? { provider: String(command.provider) } : {}
      });
    case "tasks.create":
      return dependencies.createTask({
        projectId: String(projectId),
        title: String(command.title),
        message: String(command.message),
        ...command.baseBranch ? { baseBranch: String(command.baseBranch) } : {},
        ...command.provider ? { provider: String(command.provider) } : {}
      });
    case "tasks.list":
      return dependencies.taskList({
        limit: Number(command.limit),
        ...command.projectId ? { projectId: String(command.projectId) } : {},
        includeSettled: Boolean(command.includeSettled),
        includeArchived: Boolean(command.includeArchived)
      });
    case "tasks.wait":
      return dependencies.taskWait({
        threadIds: command.threadIds,
        timeoutMs: Number(command.timeoutMs),
        after: command.after
      });
    case "tasks.send":
      return dependencies.sendTask(String(command.threadId), String(command.message));
    case "tasks.status":
      return dependencies.taskStatus(String(command.threadId));
    case "tasks.history":
      return dependencies.taskHistory(String(command.threadId), Number(command.turns), command.before ? String(command.before) : undefined);
    case "tasks.title":
      return dependencies.renameTask(String(command.threadId), String(command.title));
    case "tasks.archive":
      return dependencies.archiveTask(String(command.threadId), true);
    case "tasks.unarchive":
      return dependencies.archiveTask(String(command.threadId), false);
    case "tasks.pin":
      return dependencies.pinTask(String(command.threadId), true);
    case "tasks.unpin":
      return dependencies.pinTask(String(command.threadId), false);
    case "tasks.settle":
      return dependencies.settleTask(String(command.threadId), true);
    case "tasks.unsettle":
      return dependencies.settleTask(String(command.threadId), false);
    case "tasks.interrupt":
      return dependencies.interruptTask(String(command.threadId));
    case "tasks.approvals":
      return dependencies.listTaskApprovals(command.projectId ? String(command.projectId) : undefined);
    case "tasks.approve":
      return dependencies.resolveTaskApproval({
        threadId: String(command.threadId),
        ...command.requestId ? { requestId: String(command.requestId) } : {},
        decision: "accept"
      });
    case "tasks.deny":
      return dependencies.resolveTaskApproval({
        threadId: String(command.threadId),
        ...command.requestId ? { requestId: String(command.requestId) } : {},
        decision: "decline",
        ...command.reason ? { reason: String(command.reason) } : {}
      });
    case "worktrees.listCleanable":
      return dependencies.listCleanableWorktrees();
    default:
      throw new Error(`Unknown operation: ${String(command.op)}`);
  }
}

// packages/t3-orchestration/src/http-gateway.ts
import { createServer } from "http";
var MAX_BODY_BYTES = 1048576;
async function readBoundedBody(request2) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    request2.on("data", (chunk) => {
      if (oversized)
        return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    });
    request2.once("end", () => {
      if (oversized)
        reject(new Error("request exceeds 1 MiB"));
      else
        resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request2.once("error", reject);
  });
}
function send(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-t3-orchestration-gateway": "1",
    "x-content-type-options": "nosniff"
  });
  response.end(`${JSON.stringify(body)}
`);
}
function createTailscaleGateway(allowedLogins, execute) {
  const allowed = new Set(allowedLogins.map((login) => login.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0)
    throw new Error("Tailscale gateway requires at least one allowed login");
  return createServer(async (request2, response) => {
    if (request2.method === "GET" && request2.url === "/v1/health") {
      send(response, 200, { ok: true, result: { service: "t3-orchestrationd", schema: 1 } });
      return;
    }
    if (request2.method !== "POST" || request2.url !== "/v1/request") {
      send(response, 404, { ok: false, error: "not found" });
      return;
    }
    if (request2.headers.origin) {
      send(response, 403, { ok: false, error: "browser-origin requests are not allowed" });
      return;
    }
    if (request2.headers["x-forwarded-proto"] !== "https") {
      send(response, 401, { ok: false, error: "verified Tailscale HTTPS proxy required" });
      return;
    }
    const loginHeader = request2.headers["tailscale-user-login"];
    const login = typeof loginHeader === "string" ? loginHeader.trim().toLowerCase() : "";
    if (!login) {
      send(response, 401, { ok: false, error: "verified Tailscale user identity required" });
      return;
    }
    if (!allowed.has(login)) {
      send(response, 403, { ok: false, error: "Tailscale user is not authorized" });
      return;
    }
    if (request2.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      send(response, 415, { ok: false, error: "application/json required" });
      return;
    }
    try {
      const body = await readBoundedBody(request2);
      const command = JSON.parse(body);
      if (!command || typeof command !== "object" || typeof command.op !== "string") {
        throw new Error("command is malformed");
      }
      send(response, 200, { ok: true, result: await execute(command) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(response, message === "request exceeds 1 MiB" ? 413 : 200, { ok: false, error: message });
    }
  });
}

// packages/t3-orchestration/src/daemon.ts
var commandDependencies = {
  resolveCallerThread,
  importProjects,
  projectList,
  taskList,
  taskWait,
  createTask,
  sendTask,
  taskStatus,
  taskHistory,
  renameTask,
  archiveTask,
  pinTask,
  settleTask,
  interruptTask,
  listTaskApprovals,
  resolveTaskApproval,
  listCleanableWorktrees
};
var dispatch2 = (command) => executeCommand(command, commandDependencies);
var server = createServer2((socket) => {
  let buffer = "";
  let work = Promise.resolve();
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    if (buffer.length > 1048576) {
      socket.destroy(new Error("request exceeds 1 MiB"));
      return;
    }
    let newline = buffer.indexOf(`
`);
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf(`
`);
      work = work.then(async () => {
        try {
          const command = JSON.parse(line);
          const result = await dispatch2(command);
          socket.write(`${JSON.stringify({ ok: true, result })}
`);
        } catch (error) {
          socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}
`);
        }
      });
    }
  });
  socket.on("error", () => {
    return;
  });
  socket.on("close", () => {
    buffer = "";
  });
});
var gateway = TAILSCALE_ALLOWED_USERS.length > 0 ? createTailscaleGateway(TAILSCALE_ALLOWED_USERS, dispatch2) : undefined;
var shuttingDown = false;
var closeServer = (listener) => {
  if (!listener?.listening)
    return Promise.resolve();
  return new Promise((resolve) => listener.close(() => resolve()));
};
var shutdown = async (exitCode) => {
  if (shuttingDown)
    return;
  shuttingDown = true;
  await Promise.all([closeServer(gateway), closeServer(server)]);
  await unlink(SOCKET_PATH).catch(() => {
    return;
  });
  process.exit(exitCode);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void shutdown(0));
}
process.umask(63);
await mkdir2(dirname(SOCKET_PATH), { recursive: true, mode: 448 });
var prepareSocket = async (path, isLive) => {
  try {
    const existing = await lstat2(path);
    if (!existing.isSocket())
      throw new Error(`Refusing to replace non-socket path ${path}`);
    if (await isLive())
      throw new Error(`Daemon already running on ${path}`);
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT"))
      throw error;
  }
};
await prepareSocket(SOCKET_PATH, () => new Promise((resolve) => {
  const socket = connect(SOCKET_PATH);
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => {
    socket.destroy();
    resolve(false);
  });
}));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(SOCKET_PATH, () => {
    server.off("error", reject);
    chmodSync(SOCKET_PATH, 384);
    console.log(`t3-orchestrationd listening on ${SOCKET_PATH}`);
    resolve();
  });
});
server.on("error", (error) => {
  console.error(`t3-orchestrationd local socket failed: ${error.message}`);
  shutdown(1);
});
if (gateway) {
  try {
    await new Promise((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(TAILSCALE_GATEWAY_PORT, "127.0.0.1", () => {
        gateway.off("error", reject);
        console.log(`t3-orchestrationd Tailscale gateway listening on 127.0.0.1:${TAILSCALE_GATEWAY_PORT}`);
        resolve();
      });
    });
    gateway.on("error", (error) => {
      console.error(`t3-orchestrationd Tailscale gateway failed: ${error.message}`);
      shutdown(1);
    });
  } catch (error) {
    await Promise.all([closeServer(gateway), closeServer(server)]);
    await unlink(SOCKET_PATH).catch(() => {
      return;
    });
    throw error;
  }
}
