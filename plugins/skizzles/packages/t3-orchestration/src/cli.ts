#!/usr/bin/env bun
// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

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
var exports_config = {};
__export(exports_config, {
  token: () => token,
  taskProviderDefaults: () => taskProviderDefaults,
  parseTailscaleGatewayPort: () => parseTailscaleGatewayPort,
  origin: () => origin,
  codexDefaults: () => codexDefaults,
  TAILSCALE_GATEWAY_PORT: () => TAILSCALE_GATEWAY_PORT,
  TAILSCALE_ALLOWED_USERS: () => TAILSCALE_ALLOWED_USERS,
  T3_HOME: () => T3_HOME,
  SOCKET_PATH: () => SOCKET_PATH,
  KEYCHAIN_SERVICE: () => KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT: () => KEYCHAIN_ACCOUNT,
  DEFAULT_TAILSCALE_GATEWAY_PORT: () => DEFAULT_TAILSCALE_GATEWAY_PORT,
  CODEX_HOME: () => CODEX_HOME
});
import { join } from "path";
var {$ } = globalThis.Bun;
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
var home, CODEX_HOME, T3_HOME, SOCKET_PATH, DEFAULT_TAILSCALE_GATEWAY_PORT = 43773, TAILSCALE_GATEWAY_PORT, TAILSCALE_ALLOWED_USERS, KEYCHAIN_SERVICE = "t3-orchestration", KEYCHAIN_ACCOUNT, GROK_DEFAULT_MODEL = "grok-4.6", CURSOR_INSTANCE_ID = "cursor", CURSOR_DEFAULT_MODEL = "grok-4.6", CURSOR_REASONING_OPTION_ID = "reasoning", CURSOR_REASONING_HIGH = "high", CURSOR_FAST_MODE_OPTION_ID = "fastMode", SUPPORTED_PROVIDERS = "codex, grok, cursor";
var init_config = __esm(() => {
  home = process.env.HOME ?? (() => {
    throw new Error("HOME is required");
  })();
  CODEX_HOME = process.env.CODEX_HOME ?? join(home, ".codex");
  T3_HOME = process.env.T3_HOME ?? join(home, ".t3");
  SOCKET_PATH = process.env.T3_ORCHESTRATION_SOCKET ?? join(T3_HOME, "t3-orchestration.sock");
  TAILSCALE_GATEWAY_PORT = parseTailscaleGatewayPort(process.env.T3_ORCHESTRATION_HTTP_PORT);
  TAILSCALE_ALLOWED_USERS = (process.env.T3_ORCHESTRATION_TAILSCALE_USERS ?? "").split(",").map((login) => login.trim().toLowerCase()).filter(Boolean);
  KEYCHAIN_ACCOUNT = process.env.T3_ORCHESTRATION_KEYCHAIN_ACCOUNT ?? "access-token";
});

// packages/t3-orchestration/src/worktree-reaper.ts
var exports_worktree_reaper = {};
__export(exports_worktree_reaper, {
  writeReaperState: () => writeReaperState,
  shouldSkipUnchanged: () => shouldSkipUnchanged,
  resolveRegisteredWorktree: () => resolveRegisteredWorktree,
  readReaperState: () => readReaperState,
  parseGitWorktreePorcelain: () => parseGitWorktreePorcelain,
  normalizeBranch: () => normalizeBranch,
  isUnknownOperationError: () => isUnknownOperationError,
  isRunningTask: () => isRunningTask,
  isFlutterPubspec: () => isFlutterPubspec,
  isCleanableLifecycle: () => isCleanableLifecycle,
  formatReaperLogs: () => formatReaperLogs,
  discoverArtifactRoots: () => discoverArtifactRoots,
  defaultStatePath: () => defaultStatePath,
  createDefaultReaperDependencies: () => createDefaultReaperDependencies,
  cleanSettledWorktrees: () => cleanSettledWorktrees,
  REAPER_LAUNCH_AGENT_LABEL: () => REAPER_LAUNCH_AGENT_LABEL,
  ORCHESTRATION_LAUNCH_AGENT_LABEL: () => ORCHESTRATION_LAUNCH_AGENT_LABEL
});
import { lstat, mkdir as mkdir2, readdir, readFile as readFile2, realpath, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname2, join as join3, resolve } from "path";
import { homedir } from "os";
function parseGitWorktreePorcelain(text) {
  const worktrees = [];
  let current;
  const finish = () => {
    if (current)
      worktrees.push(current);
    current = undefined;
  };
  for (const line of text.split(`
`)) {
    if (line === "") {
      finish();
      continue;
    }
    if (line.startsWith("worktree ")) {
      finish();
      current = { path: line.slice("worktree ".length), branch: null, bare: false };
      continue;
    }
    if (!current)
      continue;
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  finish();
  return worktrees;
}
function normalizeBranch(branch) {
  if (!branch)
    return null;
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}
function isRunningTask(task) {
  return task.sessionStatus === "running" || task.latestTurnState === "running" || task.phase === "running";
}
function isCleanableLifecycle(task) {
  return !task.deleted && (task.settled === true || task.archived === true);
}
function resolveRegisteredWorktree(task, worktrees, resolvedPaths) {
  if (worktrees.length === 0)
    return { ok: false, reason: "project has no git worktrees", failClosed: true };
  const primary = worktrees[0];
  if (!primary || primary.bare)
    return { ok: false, reason: "project primary checkout is missing", failClosed: true };
  const primaryPath = resolvedPaths.get(primary.path);
  if (!primaryPath)
    return { ok: false, reason: "could not resolve primary checkout", failClosed: true };
  const workspaceRoot = task.workspaceRoot?.trim();
  const workspacePath = workspaceRoot ? resolvedPaths.get(workspaceRoot) : undefined;
  const registered = new Map;
  for (const worktree of worktrees) {
    const resolved = resolvedPaths.get(worktree.path);
    if (!resolved)
      continue;
    if (registered.has(resolved) && registered.get(resolved) !== worktree) {
      return { ok: false, reason: `ambiguous registered worktree path ${resolved}`, failClosed: true };
    }
    registered.set(resolved, worktree);
  }
  const claimed = task.worktreePath?.trim();
  if (claimed) {
    const resolvedClaim = resolvedPaths.get(claimed);
    if (!resolvedClaim)
      return { ok: false, reason: `claimed worktreePath is not resolvable: ${claimed}`, failClosed: true };
    const match = registered.get(resolvedClaim);
    if (!match)
      return { ok: false, reason: `claimed worktreePath is not a registered git worktree: ${resolvedClaim}`, failClosed: true };
    if (resolvedClaim === primaryPath || resolvedClaim === workspacePath) {
      return { ok: false, reason: `refusing to clean project primary checkout ${resolvedClaim}`, failClosed: true };
    }
    return { ok: true, path: resolvedClaim };
  }
  const branch = normalizeBranch(task.branch);
  if (!branch)
    return { ok: false, reason: "task has no worktreePath or branch", failClosed: true };
  const matches = worktrees.map((worktree) => ({ worktree, path: resolvedPaths.get(worktree.path) })).filter((entry) => {
    return Boolean(entry.path && normalizeBranch(entry.worktree.branch) === branch && entry.path !== primaryPath && entry.path !== workspacePath);
  });
  if (matches.length === 0)
    return { ok: false, reason: `no registered worktree matches branch ${branch}`, failClosed: false };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `ambiguous worktree match for branch ${branch}: ${matches.map((entry) => entry.path).join(", ")}`,
      failClosed: true
    };
  }
  return { ok: true, path: matches[0].path };
}
function shouldSkipUnchanged(state, threadId, path, currentBytes) {
  const previous = state.threads[threadId];
  return Boolean(previous && previous.path === path && previous.bytesAfter === currentBytes);
}
function isFlutterPubspec(text) {
  return /(?:^|\n)flutter:\s*(?:$|\n)/.test(text) || /sdk:\s*flutter/.test(text);
}
async function discoverArtifactRoots(worktree, deps) {
  const cargo = [];
  const flutter = [];
  const queue = [worktree];
  const seen = new Set;
  while (queue.length) {
    const directory = queue.shift();
    if (seen.has(directory))
      continue;
    seen.add(directory);
    const names = await deps.readDirectoryNames(directory);
    if (names.includes("Cargo.toml") && await deps.isDirectory(join3(directory, "target"))) {
      cargo.push(directory);
    }
    if (names.includes("pubspec.yaml") && await deps.isDirectory(join3(directory, "build"))) {
      try {
        if (isFlutterPubspec(await deps.readText(join3(directory, "pubspec.yaml"))))
          flutter.push(directory);
      } catch {}
    }
    for (const name of names) {
      if (SKIP_DIRECTORY_NAMES.has(name))
        continue;
      const child = join3(directory, name);
      if (await deps.isDirectory(child))
        queue.push(child);
    }
  }
  return { cargo, flutter };
}
async function cleanSettledWorktrees(deps, options) {
  const report = {
    ok: true,
    dryRun: options.dryRun,
    scanned: 0,
    cleaned: 0,
    skipped: 0,
    failed: 0,
    bytesFreed: 0,
    tasks: []
  };
  const state = await deps.readState();
  const tasks = await deps.listCleanableTasks();
  report.scanned = tasks.length;
  const worktreesByRoot = new Map;
  const record = (result) => {
    report.tasks.push(result);
    if (result.action === "cleaned" || result.action === "would-clean") {
      report.cleaned++;
      report.bytesFreed += result.bytesFreed ?? 0;
    } else if (result.action === "failed") {
      report.failed++;
      report.ok = false;
    } else {
      report.skipped++;
    }
  };
  for (const task of tasks) {
    if (!isCleanableLifecycle(task)) {
      record({ threadId: task.id, action: "skipped", reason: "not settled or archived" });
      continue;
    }
    if (isRunningTask(task)) {
      record({ threadId: task.id, action: "skipped", reason: "task is running" });
      continue;
    }
    const workspaceRoot = task.workspaceRoot?.trim();
    if (!workspaceRoot) {
      record({ threadId: task.id, action: "failed", reason: "project workspaceRoot is missing" });
      continue;
    }
    let worktrees = worktreesByRoot.get(workspaceRoot);
    if (!worktrees) {
      try {
        worktrees = await deps.listGitWorktrees(workspaceRoot);
      } catch (error) {
        record({
          threadId: task.id,
          action: "failed",
          reason: `git worktree list failed: ${error instanceof Error ? error.message : String(error)}`
        });
        continue;
      }
      worktreesByRoot.set(workspaceRoot, worktrees);
    }
    const resolvedPaths = new Map;
    try {
      resolvedPaths.set(workspaceRoot, await deps.realpath(workspaceRoot));
    } catch (error) {
      record({
        threadId: task.id,
        action: "skipped",
        reason: `workspaceRoot is not resolvable: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }
    if (task.worktreePath?.trim()) {
      try {
        resolvedPaths.set(task.worktreePath, await deps.realpath(task.worktreePath));
      } catch (error) {
        record({
          threadId: task.id,
          action: "skipped",
          reason: `claimed worktreePath is not resolvable: ${error instanceof Error ? error.message : String(error)}`
        });
        continue;
      }
    }
    for (const worktree of worktrees) {
      try {
        resolvedPaths.set(worktree.path, await deps.realpath(worktree.path));
      } catch {}
    }
    const resolved = resolveRegisteredWorktree(task, worktrees, resolvedPaths);
    if (!resolved.ok) {
      record({
        threadId: task.id,
        action: resolved.failClosed ? "failed" : "skipped",
        reason: resolved.reason
      });
      continue;
    }
    const artifactRoots = await discoverArtifactRoots(resolved.path, deps);
    const artifactDirs = [
      ...artifactRoots.cargo.map((directory) => join3(directory, "target")),
      ...artifactRoots.flutter.map((directory) => join3(directory, "build"))
    ];
    let bytesBefore = 0;
    for (const directory of artifactDirs)
      bytesBefore += await deps.measureBytes(directory);
    if (artifactDirs.length === 0 || bytesBefore === 0) {
      if (!options.dryRun) {
        state.threads[task.id] = { path: resolved.path, bytesAfter: 0, cleanedAt: deps.now() };
      }
      record({
        threadId: task.id,
        action: "unchanged",
        path: resolved.path,
        bytesBefore: 0,
        bytesAfter: 0,
        bytesFreed: 0,
        reason: "no cargo/flutter artifacts"
      });
      continue;
    }
    if (shouldSkipUnchanged(state, task.id, resolved.path, bytesBefore)) {
      record({
        threadId: task.id,
        action: "unchanged",
        path: resolved.path,
        bytesBefore,
        bytesAfter: bytesBefore,
        bytesFreed: 0,
        reason: "already cleaned at recorded size"
      });
      continue;
    }
    if (options.dryRun) {
      record({
        threadId: task.id,
        action: "would-clean",
        path: resolved.path,
        bytesBefore,
        bytesAfter: 0,
        bytesFreed: bytesBefore
      });
      continue;
    }
    try {
      for (const directory of artifactRoots.cargo)
        await deps.cargoClean(directory);
      for (const directory of artifactRoots.flutter)
        await deps.flutterClean(directory);
    } catch (error) {
      record({
        threadId: task.id,
        action: "failed",
        path: resolved.path,
        bytesBefore,
        reason: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    let bytesAfter = 0;
    for (const directory of artifactDirs) {
      if (await deps.pathExists(directory))
        bytesAfter += await deps.measureBytes(directory);
    }
    const bytesFreed = Math.max(0, bytesBefore - bytesAfter);
    state.threads[task.id] = { path: resolved.path, bytesAfter, cleanedAt: deps.now() };
    record({
      threadId: task.id,
      action: "cleaned",
      path: resolved.path,
      bytesBefore,
      bytesAfter,
      bytesFreed
    });
  }
  if (!options.dryRun)
    await deps.writeState(state);
  return report;
}
function isMissing(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
async function optionalRealpath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissing(error))
      throw new Error(`path does not exist: ${path}`);
    throw error;
  }
}
async function directorySize(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink())
      return 0;
    if (metadata.isFile())
      return metadata.size;
    if (!metadata.isDirectory())
      return 0;
  } catch (error) {
    if (isMissing(error))
      return 0;
    throw error;
  }
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const child = join3(path, entry.name);
    if (entry.isSymbolicLink())
      continue;
    if (entry.isDirectory())
      total += await directorySize(child);
    else if (entry.isFile()) {
      try {
        total += (await lstat(child)).size;
      } catch (error) {
        if (!isMissing(error))
          throw error;
      }
    }
  }
  return total;
}
async function runCleanCommand(command, directory) {
  const result = await Bun.$`${command} clean`.cwd(directory).nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`${command} clean failed in ${directory}: ${result.stderr.toString().trim() || result.stdout.toString().trim() || `exit ${result.exitCode}`}`);
  }
}
function defaultStatePath(home3 = process.env.HOME || homedir()) {
  const t3Home = resolve(process.env.T3_HOME?.trim() || join3(home3, ".t3"));
  return join3(t3Home, "worktree-reaper-state.json");
}
async function readReaperState(path = defaultStatePath()) {
  try {
    const parsed = JSON.parse(await readFile2(path, "utf8"));
    if (parsed.version !== 1 || !parsed.threads || typeof parsed.threads !== "object") {
      throw new Error(`Unsupported worktree reaper state at ${path}`);
    }
    return parsed;
  } catch (error) {
    if (isMissing(error))
      return { version: 1, threads: {} };
    throw error;
  }
}
async function writeReaperState(state, path = defaultStatePath()) {
  await mkdir2(dirname2(path), { recursive: true, mode: 448 });
  await writeFile2(path, `${JSON.stringify(state, null, 2)}
`, { mode: 384 });
}
function isUnknownOperationError(error) {
  return Boolean(error && error.startsWith("Unknown operation:"));
}
function createDefaultReaperDependencies(request) {
  const listFromTasks = async () => {
    const projectsResponse = await request({ op: "projects.list" });
    if (!projectsResponse.ok)
      throw new Error(projectsResponse.error ?? "projects.list failed");
    const projects = projectsResponse.result.projects ?? [];
    const roots = new Map(projects.map((project) => [project.id, project.workspaceRoot]));
    const seen = new Set;
    const tasks = [];
    const projectIds = projects.length ? projects.map((project) => project.id) : [undefined];
    for (const projectId of projectIds) {
      const response = await request({
        op: "tasks.list",
        limit: 200,
        includeSettled: true,
        includeArchived: true,
        ...projectId ? { projectId } : {}
      });
      if (!response.ok)
        throw new Error(response.error ?? "tasks.list failed");
      const listed = response.result.tasks ?? [];
      for (const task of listed) {
        if (seen.has(task.id))
          continue;
        seen.add(task.id);
        tasks.push({
          ...task,
          workspaceRoot: task.workspaceRoot ?? roots.get(task.projectId) ?? null
        });
      }
    }
    return tasks.filter((task) => isCleanableLifecycle(task));
  };
  return {
    async listCleanableTasks() {
      const dedicated = await request({ op: "worktrees.listCleanable" });
      if (dedicated.ok) {
        return (dedicated.result.tasks ?? []).filter((task) => isCleanableLifecycle(task));
      }
      if (!isUnknownOperationError(dedicated.error)) {
        throw new Error(dedicated.error ?? "worktrees.listCleanable failed");
      }
      return listFromTasks();
    },
    async listGitWorktrees(workspaceRoot) {
      const result = await Bun.$`git -C ${workspaceRoot} worktree list --porcelain`.nothrow().quiet();
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString().trim() || `git worktree list failed in ${workspaceRoot}`);
      }
      return parseGitWorktreePorcelain(result.text());
    },
    realpath: optionalRealpath,
    async pathExists(path) {
      try {
        await lstat(path);
        return true;
      } catch (error) {
        if (isMissing(error))
          return false;
        throw error;
      }
    },
    async isDirectory(path) {
      try {
        const metadata = await lstat(path);
        return metadata.isDirectory() && !metadata.isSymbolicLink();
      } catch (error) {
        if (isMissing(error))
          return false;
        throw error;
      }
    },
    async readDirectoryNames(path) {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.filter((entry) => !entry.isSymbolicLink()).map((entry) => entry.name);
      } catch (error) {
        if (isMissing(error))
          return [];
        throw error;
      }
    },
    readText: (path) => readFile2(path, "utf8"),
    measureBytes: directorySize,
    cargoClean: (directory) => runCleanCommand("cargo", directory),
    flutterClean: (directory) => runCleanCommand("flutter", directory),
    readState: readReaperState,
    writeState: writeReaperState,
    now: () => new Date().toISOString()
  };
}
function formatReaperLogs(report) {
  return report.tasks.map((task) => ({
    threadId: task.threadId,
    path: task.path ?? null,
    action: task.action,
    bytesFreed: task.bytesFreed ?? 0,
    ...task.reason ? { reason: task.reason } : {}
  }));
}
var REAPER_LAUNCH_AGENT_LABEL = "io.github.skizzles.t3-worktree-reaper", ORCHESTRATION_LAUNCH_AGENT_LABEL = "io.github.t3-orchestration.daemon", SKIP_DIRECTORY_NAMES;
var init_worktree_reaper = __esm(() => {
  SKIP_DIRECTORY_NAMES = new Set([
    ".git",
    ".dart_tool",
    ".idea",
    ".vscode",
    "node_modules",
    "target",
    "build",
    "Pods",
    ".symlinks"
  ]);
});

// packages/t3-orchestration/src/client.ts
init_config();
import { connect } from "net";

// packages/t3-orchestration/src/remote-config.ts
import { chmod, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join as join2 } from "path";
var home2 = process.env.HOME ?? (() => {
  throw new Error("HOME is required");
})();
var REMOTE_CONFIG_PATH = process.env.T3_ORCHESTRATION_REMOTE_CONFIG ?? join2(home2, ".config/t3-orchestration/client.json");
function normalizeRemoteUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Remote orchestration URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:")
    throw new Error("Remote orchestration URL must use HTTPS");
  if (!url.hostname.toLowerCase().endsWith(".ts.net")) {
    throw new Error("Remote orchestration URL must use a Tailscale ts.net hostname");
  }
  if (url.username || url.password)
    throw new Error("Remote orchestration URL must not contain credentials");
  if (url.search || url.hash)
    throw new Error("Remote orchestration URL must not contain a query or fragment");
  if (url.pathname !== "/")
    throw new Error("Remote orchestration URL must not contain a path");
  return url.origin;
}
async function configuredRemoteUrl() {
  const environmentUrl = process.env.T3_ORCHESTRATION_REMOTE_URL?.trim();
  if (environmentUrl)
    return normalizeRemoteUrl(environmentUrl);
  try {
    const parsed = JSON.parse(await readFile(REMOTE_CONFIG_PATH, "utf8"));
    if (typeof parsed.url !== "string")
      throw new Error("Remote orchestration config is malformed");
    return normalizeRemoteUrl(parsed.url);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
}
async function configureRemoteUrl(input) {
  const url = normalizeRemoteUrl(input);
  const parent = dirname(REMOTE_CONFIG_PATH);
  await mkdir(parent, { recursive: true, mode: 448 });
  await chmod(parent, 448);
  const temporary = `${REMOTE_CONFIG_PATH}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ url }, null, 2)}
`, { mode: 384 });
  await rename(temporary, REMOTE_CONFIG_PATH);
  await chmod(REMOTE_CONFIG_PATH, 384);
  return url;
}
async function clearRemoteUrl() {
  await rm(REMOTE_CONFIG_PATH, { force: true });
}

// packages/t3-orchestration/src/client.ts
function daemonResponseTimeoutMs(payload) {
  if (payload.op !== "tasks.wait")
    return 240000;
  const waitTimeoutMs = Number(payload.timeoutMs);
  if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 3600000)
    return 240000;
  return waitTimeoutMs + 30000;
}
function daemonRequest(payload, socketPath = SOCKET_PATH, responseTimeoutMs = daemonResponseTimeoutMs(payload), remoteUrl) {
  if (remoteUrl)
    return remoteDaemonRequest(payload, remoteUrl, responseTimeoutMs);
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (callback) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() => {
        socket.destroy();
        reject(new Error(`t3-orchestrationd did not respond within ${responseTimeoutMs} milliseconds`));
      });
    }, responseTimeoutMs);
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf(`
`);
      if (newline < 0)
        return;
      const line = buffer.slice(0, newline);
      finish(() => {
        socket.end();
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error("t3-orchestrationd returned malformed JSON"));
        }
      });
    });
    socket.once("error", (error) => {
      finish(() => {
        const code = "code" in error ? String(error.code) : "";
        if (code === "ENOENT" || code === "ECONNREFUSED")
          reject(new Error("t3-orchestrationd is unavailable. From a full Skizzles checkout or plugin snapshot, run `bun run packages/t3-orchestration/scripts/install.ts` to install and start its LaunchAgent."));
        else
          reject(error);
      });
    });
    socket.once("end", () => finish(() => reject(new Error("t3-orchestrationd closed without a complete response"))));
    socket.write(`${JSON.stringify(payload)}
`);
  });
}
async function remoteDaemonRequest(payload, remoteUrl, responseTimeoutMs) {
  const endpoint = normalizeRemoteUrl(remoteUrl);
  const controller = new AbortController;
  const timeout = setTimeout(() => controller.abort(), responseTimeoutMs);
  try {
    const response = await fetch(`${endpoint}/v1/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("remote t3-orchestrationd redirect rejected");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 1048576)
      throw new Error("remote daemon response exceeds 1 MiB");
    const reader = response.body?.getReader();
    if (!reader)
      throw new Error("remote t3-orchestrationd returned an empty response");
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      size += value.byteLength;
      if (size > 1048576) {
        await reader.cancel();
        throw new Error("remote daemon response exceeds 1 MiB");
      }
      chunks.push(value);
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(combined);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("remote t3-orchestrationd returned malformed JSON");
    }
    if (!response.ok)
      throw new Error(body.error || `remote t3-orchestrationd failed with HTTP ${response.status}`);
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`remote t3-orchestrationd did not respond within ${responseTimeoutMs} milliseconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// packages/t3-orchestration/src/cli.ts
var USAGE = `t3ctl remote {configure --url HTTPS_URL|status|clear}
t3ctl projects {list|import}
t3ctl handoff create --project ID --title TITLE --message TEXT [--provider codex|grok|cursor]
t3ctl tasks create [--project ID] --title TITLE --message TEXT [--provider codex|grok|cursor]
t3ctl tasks list [--project ID] [--limit 1..200] [--include-settled] [--include-archived]
t3ctl tasks {read|history|status} ID
t3ctl tasks wait ID [ID ...] [--timeout-ms 0..3600000] [--after ID=CURSOR]
t3ctl tasks send ID --message TEXT
t3ctl tasks title ID --title TITLE
t3ctl tasks {archive|unarchive|pin|unpin|settle|unsettle|interrupt} ID
t3ctl tasks approvals [--project ID]
t3ctl tasks approve ID [REQUEST_ID]
t3ctl tasks deny ID [REQUEST_ID] [--reason TEXT]
t3ctl worktrees clean-settled [--dry-run]`;
var [group, action, ...args] = process.argv.slice(2);
if (group === "--help" || group === "-h") {
  console.log(JSON.stringify({ help: USAGE }));
  process.exit(0);
}
var booleanOptions = new Set(["include-settled", "include-archived", "dry-run"]);
var options = new Map;
var positionals = [];
for (let i = 0;i < args.length; i++) {
  const argument = args[i];
  if (!argument.startsWith("--")) {
    positionals.push(argument);
    continue;
  }
  const name = argument.slice(2);
  const value = booleanOptions.has(name) ? "true" : args[++i];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing value for --${name}`);
  options.set(name, [...options.get(name) ?? [], value]);
}
var option = (name) => options.get(name)?.at(-1);
var requiredPositional = (value, label) => {
  if (!value?.trim())
    throw new Error(`Missing ${label}`);
  return value;
};
if (group === "auth" && action === "configure") {
  const pairingToken = (await new Response(Bun.stdin.stream()).text()).trim();
  if (!pairingToken)
    throw new Error("Pipe a one-time T3 pairing token on stdin");
  const { origin: origin2 } = await Promise.resolve().then(() => (init_config(), exports_config));
  const response = await fetch(`${await origin2()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: pairingToken,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "orchestration:read orchestration:operate",
      client_label: "t3ctl",
      client_device_type: "bot",
      client_os: "macOS"
    })
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(`T3 pairing exchange failed (${response.status}): ${body}`);
  const accessToken = JSON.parse(body).access_token;
  if (typeof accessToken !== "string" || !accessToken)
    throw new Error("T3 pairing response did not contain an access token");
  const { KEYCHAIN_ACCOUNT: KEYCHAIN_ACCOUNT2, KEYCHAIN_SERVICE: KEYCHAIN_SERVICE2 } = await Promise.resolve().then(() => (init_config(), exports_config));
  const result = await Bun.$`security add-generic-password -U -s ${KEYCHAIN_SERVICE2} -a ${KEYCHAIN_ACCOUNT2} -w ${accessToken}`.nothrow().quiet();
  if (result.exitCode !== 0)
    throw new Error(`Could not store T3 token in Keychain: ${result.stderr.toString()}`);
  console.log(JSON.stringify({ ok: true, scopes: "orchestration:read orchestration:operate" }));
  process.exit(0);
}
if (group === "remote" && ["configure", "clear", "status"].includes(action ?? "")) {
  if (action === "configure") {
    const url = option("url")?.trim();
    if (!url)
      throw new Error("Missing required --url");
    console.log(JSON.stringify({ ok: true, url: await configureRemoteUrl(url), configPath: REMOTE_CONFIG_PATH }, null, 2));
  } else if (action === "clear") {
    await clearRemoteUrl();
    console.log(JSON.stringify({ ok: true, remote: false, configPath: REMOTE_CONFIG_PATH }, null, 2));
  } else {
    console.log(JSON.stringify({ ok: true, url: await configuredRemoteUrl() ?? null, configPath: REMOTE_CONFIG_PATH }, null, 2));
  }
  process.exit(0);
}
var required = (name) => {
  const value = option(name)?.trim();
  if (!value)
    throw new Error(`Missing required --${name}`);
  return value;
};
var turns = () => {
  const raw = option("turns")?.trim() || "3";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10)
    throw new Error("--turns must be an integer from 1 through 10");
  return value;
};
var boundedInteger = (name, fallback, minimum, maximum) => {
  const raw = option(name)?.trim() || String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
};
var waitAfter = () => Object.fromEntries((options.get("after") ?? []).map((entry) => {
  const separator = entry.indexOf("=");
  if (separator < 1 || separator === entry.length - 1)
    throw new Error("--after must use THREAD_ID=CURSOR");
  return [entry.slice(0, separator), entry.slice(separator + 1)];
}));
var waitIds = () => {
  const ids = [...new Set(positionals.map((value) => value.trim()).filter(Boolean))];
  if (ids.length < 1 || ids.length > 8)
    throw new Error("tasks wait requires 1 through 8 task ids");
  return ids;
};
var callerThreadId = process.env.CODEX_THREAD_ID?.trim();
var payload = group === "projects" && action === "import" ? { op: "projects.import" } : group === "projects" && action === "list" ? { op: "projects.list" } : group === "handoff" && action === "create" ? { op: "handoff.create", projectId: required("project"), title: required("title"), message: required("message"), baseBranch: option("base"), provider: option("provider") } : group === "tasks" && action === "create" ? { op: "tasks.create", callerThreadId, projectId: option("project")?.trim() || "current", title: required("title"), message: required("message"), baseBranch: option("base"), provider: option("provider") } : group === "tasks" && action === "list" ? { op: "tasks.list", limit: boundedInteger("limit", 50, 1, 200), projectId: option("project")?.trim(), includeSettled: option("include-settled") === "true", includeArchived: option("include-archived") === "true" } : group === "tasks" && action === "wait" ? { op: "tasks.wait", threadIds: waitIds(), timeoutMs: boundedInteger("timeout-ms", 120000, 0, 3600000), after: waitAfter() } : group === "tasks" && action === "send" ? { op: "tasks.send", threadId: requiredPositional(positionals[0], "thread id"), message: required("message") } : group === "tasks" && action === "status" ? { op: "tasks.status", threadId: requiredPositional(positionals[0], "thread id") } : group === "tasks" && (action === "history" || action === "read") ? { op: "tasks.history", threadId: requiredPositional(positionals[0], "thread id"), turns: turns(), before: option("before") } : group === "tasks" && action === "title" ? { op: "tasks.title", threadId: requiredPositional(positionals[0], "thread id"), title: required("title") } : group === "tasks" && ["archive", "unarchive", "pin", "unpin", "settle", "unsettle", "interrupt"].includes(action ?? "") ? { op: `tasks.${action}`, threadId: requiredPositional(positionals[0], "thread id") } : group === "tasks" && action === "approvals" ? { op: "tasks.approvals", projectId: option("project")?.trim() } : group === "tasks" && action === "approve" ? { op: "tasks.approve", threadId: requiredPositional(positionals[0], "thread id"), requestId: positionals[1]?.trim() } : group === "tasks" && action === "deny" ? { op: "tasks.deny", threadId: requiredPositional(positionals[0], "thread id"), requestId: positionals[1]?.trim(), reason: option("reason")?.trim() } : group === "worktrees" && action === "clean-settled" ? { op: "worktrees.clean-settled", dryRun: option("dry-run") === "true" } : (() => {
  throw new Error(`Usage:
  ${USAGE.replaceAll(`
`, `
  `)}`);
})();
try {
  if (payload.op === "worktrees.clean-settled") {
    const { cleanSettledWorktrees: cleanSettledWorktrees2, createDefaultReaperDependencies: createDefaultReaperDependencies2, formatReaperLogs: formatReaperLogs2 } = await Promise.resolve().then(() => (init_worktree_reaper(), exports_worktree_reaper));
    const remoteUrl = await configuredRemoteUrl();
    const report = await cleanSettledWorktrees2(createDefaultReaperDependencies2((command) => daemonRequest(command, undefined, undefined, remoteUrl)), {
      dryRun: payload.dryRun === true
    });
    console.log(JSON.stringify({ ...report, log: formatReaperLogs2(report) }, null, 2));
    process.exit(report.ok ? 0 : 1);
  }
  const result = await daemonRequest(payload, undefined, undefined, await configuredRemoteUrl());
  console.log(JSON.stringify(result.ok ? result.result : { error: result.error }, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
