#!/usr/bin/env bun
// @bun

// packages/t3-orchestration/src/client.ts
import { connect } from "net";

// packages/t3-orchestration/src/config.ts
import { join } from "path";
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
var KEYCHAIN_ACCOUNT = process.env.T3_ORCHESTRATION_KEYCHAIN_ACCOUNT ?? "access-token";

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

// packages/t3-orchestration/src/worktree-reaper.ts
import { lstat, mkdir as mkdir2, readdir, readFile as readFile2, realpath, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname2, join as join3, resolve } from "path";
import { homedir } from "os";
var SKIP_DIRECTORY_NAMES = new Set([
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
  return task.sessionStatus === "running" || task.sessionStatus === "starting" || task.latestTurnState === "running" || task.phase === "running" || task.phase === "starting";
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
async function runCleanCommand(command, args, directory) {
  const result = await Bun.$`${command} ${args}`.cwd(directory).nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${directory}: ${result.stderr.toString().trim() || result.stdout.toString().trim() || `exit ${result.exitCode}`}`);
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
    cargoClean: async (directory) => {
      const env = { ...Bun.env };
      delete env.CARGO_TARGET_DIR;
      const result = await Bun.$`cargo clean --target-dir target`.cwd(directory).env(env).nothrow().quiet();
      if (result.exitCode !== 0) {
        throw new Error(`cargo clean --target-dir target failed in ${directory}: ${result.stderr.toString().trim() || result.stdout.toString().trim() || `exit ${result.exitCode}`}`);
      }
    },
    flutterClean: (directory) => runCleanCommand("flutter", ["clean"], directory),
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

// packages/t3-orchestration/src/worktree-reaper-cli.ts
var args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(JSON.stringify({ help: `t3-worktree-reaper [--dry-run]
Cleans cargo/flutter artifacts from settled or archived T3 worktrees. Does not delete worktrees or source.` }));
  process.exit(0);
}
var unknown = args.filter((argument) => argument !== "--dry-run");
if (unknown.length) {
  console.error(`Unknown option ${unknown[0]}`);
  process.exit(1);
}
try {
  if (await configuredRemoteUrl()) {
    throw new Error("t3-worktree-reaper is host-local and refuses remote t3ctl mode; it only talks to the existing local t3-orchestrationd socket");
  }
  const report = await cleanSettledWorktrees(createDefaultReaperDependencies((payload) => daemonRequest(payload)), {
    dryRun: args.includes("--dry-run")
  });
  console.log(JSON.stringify({ ...report, log: formatReaperLogs(report) }, null, 2));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
