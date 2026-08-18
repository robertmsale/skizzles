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

// packages/t3-orchestration/src/worktree-reaper-config.ts
var exports_worktree_reaper_config = {};
__export(exports_worktree_reaper_config, {
  resolveProjectPolicy: () => resolveProjectPolicy,
  resolveDenyPaths: () => resolveDenyPaths,
  relativeInside: () => relativeInside,
  parseReaperConfig: () => parseReaperConfig,
  normalizeRelative: () => normalizeRelative,
  matchesAnyGlob: () => matchesAnyGlob,
  matchRelativeGlob: () => matchRelativeGlob,
  loadReaperConfig: () => loadReaperConfig,
  isDeniedPath: () => isDeniedPath,
  extraCommandToStrategy: () => extraCommandToStrategy,
  expandUserPath: () => expandUserPath,
  defaultReaperConfigPath: () => defaultReaperConfigPath,
  defaultReaperConfig: () => defaultReaperConfig,
  assertAllowedCleanCommand: () => assertAllowedCleanCommand,
  assertAllowedArtifact: () => assertAllowedArtifact,
  GENERATED_ARTIFACT_DIRS: () => GENERATED_ARTIFACT_DIRS
});
import { readFile as readFile2, realpath } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join as join3, relative, resolve as resolve2, sep } from "path";
function defaultReaperConfig() {
  return {
    enabled: true,
    includeProjects: [],
    denyPaths: [],
    extraCommands: [],
    projects: [],
    strategies: [
      {
        name: "cargo",
        enabled: true,
        markers: ["Cargo.toml"],
        artifactDir: "target",
        command: ["cargo", "clean", "--target-dir", "target"],
        match: []
      },
      {
        name: "flutter",
        enabled: true,
        markers: ["pubspec.yaml"],
        artifactDir: "build",
        command: ["flutter", "clean"],
        match: [],
        requireText: { file: "pubspec.yaml", pattern: DEFAULT_FLUTTER_PATTERN }
      }
    ]
  };
}
function defaultReaperConfigPath(home3 = process.env.HOME || homedir()) {
  const configRoot = resolve2(process.env.XDG_CONFIG_HOME?.trim() || join3(home3, ".config"));
  return join3(configRoot, "skizzles/t3-worktree-reaper.toml");
}
function asStringArray(value, label) {
  if (value === undefined)
    return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
}
function asCommand(value, label) {
  const command = asStringArray(value, label);
  if (command.length === 0)
    throw new Error(`${label} must include an executable`);
  return command;
}
function assertAllowedArtifact(artifactDir, label) {
  if (!GENERATED_ARTIFACT_DIRS.has(artifactDir)) {
    throw new Error(`${label} must be a generated artifact directory (${[...GENERATED_ARTIFACT_DIRS].join(", ")}), not ${artifactDir}`);
  }
}
function assertAllowedCleanCommand(command, artifactDir) {
  assertAllowedArtifact(artifactDir, "artifact_dir");
  const executable = command[0];
  if (!executable || executable.includes("/") || executable.includes("\\") || FORBIDDEN_EXEC.has(executable)) {
    throw new Error(`cleaner executable is not allowed: ${executable ?? "(missing)"}`);
  }
  for (const argument of command) {
    if (argument === "-c" || argument === "-C" || argument.startsWith("-C") || argument.startsWith("--git-") || argument.startsWith("--work-tree")) {
      throw new Error(`cleaner flag is not allowed: ${argument}`);
    }
  }
  if (executable === "cargo") {
    if (command.length !== 4 || command[1] !== "clean" || command[2] !== "--target-dir" || command[3] !== artifactDir) {
      throw new Error("cargo cleaner must be: cargo clean --target-dir <artifact_dir>");
    }
    return;
  }
  if (executable === "flutter") {
    if (command.length !== 2 || command[1] !== "clean")
      throw new Error("flutter cleaner must be: flutter clean");
    return;
  }
  if (executable === "rm") {
    const flags = command.slice(1, -1);
    const operand = command.at(-1);
    if (command.length < 3 || operand !== artifactDir || !flags.every((flag) => /^-[rf]+$/.test(flag))) {
      throw new Error("rm cleaner must be: rm -rf <artifact_dir>");
    }
    return;
  }
  throw new Error(`unsupported cleaner: ${executable}`);
}
function parseStrategy(value, index) {
  if (!value || typeof value !== "object")
    throw new Error(`strategies[${index}] must be a table`);
  const raw = value;
  if (typeof raw.name !== "string" || raw.name.trim() === "")
    throw new Error(`strategies[${index}].name is required`);
  if (typeof raw.artifact_dir !== "string" || raw.artifact_dir.trim() === "") {
    throw new Error(`strategies[${index}].artifact_dir is required`);
  }
  if (raw.artifact_dir.includes("..") || raw.artifact_dir.includes("/") || raw.artifact_dir.includes("\\")) {
    throw new Error(`strategies[${index}].artifact_dir must be a single relative directory name`);
  }
  let requireText;
  if (raw.require_text !== undefined) {
    if (!raw.require_text || typeof raw.require_text !== "object")
      throw new Error(`strategies[${index}].require_text must be a table`);
    const text = raw.require_text;
    if (typeof text.file !== "string" || text.file.trim() === "" || typeof text.pattern !== "string" || text.pattern.trim() === "") {
      throw new Error(`strategies[${index}].require_text needs file and pattern`);
    }
    if (text.file.includes("..") || isAbsolute(text.file))
      throw new Error(`strategies[${index}].require_text.file must be a relative file name`);
    requireText = { file: text.file.trim(), pattern: text.pattern };
  }
  const strategy = {
    name: raw.name.trim(),
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    markers: (() => {
      const markers = asStringArray(raw.markers, `strategies[${index}].markers`);
      const match = asStringArray(raw.match, `strategies[${index}].match`);
      if (markers.length === 0 && match.length === 0)
        throw new Error(`strategies[${index}] needs markers or match`);
      return markers;
    })(),
    artifactDir: raw.artifact_dir.trim(),
    command: asCommand(raw.command, `strategies[${index}].command`),
    match: asStringArray(raw.match, `strategies[${index}].match`),
    ...requireText ? { requireText } : {}
  };
  assertAllowedCleanCommand(strategy.command, strategy.artifactDir);
  return strategy;
}
function extraCommandToStrategy(extra, index) {
  return {
    name: `extra:${index}:${extra.match}`,
    enabled: true,
    markers: extra.markers,
    artifactDir: extra.artifactDir,
    command: extra.command,
    match: [extra.match]
  };
}
function parseExtraCommand(value, label) {
  if (!value || typeof value !== "object")
    throw new Error(`${label} must be a table`);
  const raw = value;
  if (typeof raw.match !== "string" || raw.match.trim() === "")
    throw new Error(`${label}.match is required`);
  if (typeof raw.artifact_dir !== "string" || raw.artifact_dir.trim() === "")
    throw new Error(`${label}.artifact_dir is required`);
  if (raw.artifact_dir.includes("..") || raw.artifact_dir.includes("/") || raw.artifact_dir.includes("\\")) {
    throw new Error(`${label}.artifact_dir must be a single relative directory name`);
  }
  const extra = {
    match: raw.match.trim().replaceAll("\\", "/"),
    artifactDir: raw.artifact_dir.trim(),
    command: asCommand(raw.command, `${label}.command`),
    markers: asStringArray(raw.markers, `${label}.markers`)
  };
  assertAllowedCleanCommand(extra.command, extra.artifactDir);
  return extra;
}
function parseProject(value, index) {
  if (!value || typeof value !== "object")
    throw new Error(`projects[${index}] must be a table`);
  const raw = value;
  const extra = raw.extra_commands === undefined ? [] : Array.isArray(raw.extra_commands) ? raw.extra_commands.map((entry, extraIndex) => parseExtraCommand(entry, `projects[${index}].extra_commands[${extraIndex}]`)) : (() => {
    throw new Error(`projects[${index}].extra_commands must be an array`);
  })();
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const workspaceRoot = typeof raw.workspace_root === "string" && raw.workspace_root.trim() ? raw.workspace_root.trim() : undefined;
  if (!id && !workspaceRoot)
    throw new Error(`projects[${index}] needs id or workspace_root`);
  return {
    ...id ? { id } : {},
    ...workspaceRoot ? { workspaceRoot } : {},
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    ...raw.strategies === undefined ? {} : { strategies: asStringArray(raw.strategies, `projects[${index}].strategies`) },
    extraCommands: extra,
    denyPaths: asStringArray(raw.deny_paths, `projects[${index}].deny_paths`)
  };
}
function parseReaperConfig(text) {
  let parsed;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`Worktree reaper config is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error("Worktree reaper config must be a TOML table");
  const raw = parsed;
  const defaults = defaultReaperConfig();
  const strategies = raw.strategies === undefined ? defaults.strategies : Array.isArray(raw.strategies) ? raw.strategies.map((entry, index) => parseStrategy(entry, index)) : (() => {
    throw new Error("strategies must be an array of tables");
  })();
  const names = strategies.map((entry) => entry.name);
  if (new Set(names).size !== names.length)
    throw new Error("strategy names must be unique");
  const extraCommands = raw.extra_commands === undefined ? [] : Array.isArray(raw.extra_commands) ? raw.extra_commands.map((entry, index) => parseExtraCommand(entry, `extra_commands[${index}]`)) : (() => {
    throw new Error("extra_commands must be an array of tables");
  })();
  const projects = raw.projects === undefined ? [] : Array.isArray(raw.projects) ? raw.projects.map((entry, index) => parseProject(entry, index)) : (() => {
    throw new Error("projects must be an array of tables");
  })();
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    throw new Error("enabled must be a boolean");
  return {
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    includeProjects: asStringArray(raw.include_projects, "include_projects"),
    denyPaths: asStringArray(raw.deny_paths, "deny_paths"),
    strategies,
    extraCommands,
    projects
  };
}
async function loadReaperConfig(explicitPath) {
  const configured = explicitPath?.trim() || process.env.T3_WORKTREE_REAPER_CONFIG?.trim();
  const path = configured || defaultReaperConfigPath();
  try {
    return { config: parseReaperConfig(await readFile2(path, "utf8")), path };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      if (configured)
        throw new Error(`Worktree reaper config is missing: ${path}`);
      return { config: defaultReaperConfig(), path: null };
    }
    throw error;
  }
}
function normalizeRelative(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
function matchRelativeGlob(relativePath, pattern) {
  const path = normalizeRelative(relativePath);
  const glob = normalizeRelative(pattern);
  if (glob === "" || glob === "**")
    return path !== ".." && !path.startsWith("../");
  let source = "^";
  for (let index = 0;index < glob.length; ) {
    if (glob.startsWith("**", index)) {
      source += ".*";
      index += 2;
      if (glob[index] === "/")
        index++;
      continue;
    }
    const character = glob[index];
    if (character === "*")
      source += "[^/]*";
    else if ("\\^$+?.()|[]{}".includes(character))
      source += `\\${character}`;
    else
      source += character;
    index++;
  }
  source += "$";
  return new RegExp(source).test(path);
}
function matchesAnyGlob(relativePath, patterns) {
  if (patterns.length === 0)
    return true;
  return patterns.some((pattern) => matchRelativeGlob(relativePath, pattern));
}
function selectorMatches(task, selector) {
  const value = selector.trim();
  if (!value)
    return false;
  return task.projectId === value || task.projectTitle === value || task.workspaceRoot === value;
}
function resolveProjectPolicy(task, config) {
  if (!config.enabled)
    return { enabled: false, reason: "reaper disabled by host config", strategies: [], extraCommands: [], denyPaths: [] };
  if (config.includeProjects.length > 0 && !config.includeProjects.some((selector) => selectorMatches(task, selector))) {
    return { enabled: false, reason: "project is not in include_projects", strategies: [], extraCommands: [], denyPaths: [] };
  }
  const matches = config.projects.filter((project) => {
    if (project.id && selectorMatches(task, project.id))
      return true;
    if (project.workspaceRoot && task.workspaceRoot === project.workspaceRoot)
      return true;
    return false;
  });
  if (matches.length > 1) {
    return { enabled: false, reason: `ambiguous project override for ${task.projectId}`, strategies: [], extraCommands: [], denyPaths: [] };
  }
  const override = matches[0];
  if (override && !override.enabled) {
    return { enabled: false, reason: "project disabled by host config", strategies: [], extraCommands: [], denyPaths: [] };
  }
  const named = override?.strategies;
  let strategies = config.strategies.filter((strategy) => strategy.enabled);
  if (named) {
    const unknown = named.filter((name) => !config.strategies.some((strategy) => strategy.name === name));
    if (unknown.length) {
      return { enabled: false, reason: `unknown strategy ${unknown.join(", ")}`, strategies: [], extraCommands: [], denyPaths: [] };
    }
    strategies = named.map((name) => config.strategies.find((strategy) => strategy.name === name)).filter((strategy) => strategy.enabled);
  }
  const extras = [...config.extraCommands, ...override?.extraCommands ?? []].map((extra, index) => extraCommandToStrategy(extra, index));
  return {
    enabled: true,
    strategies: [...strategies, ...extras],
    extraCommands: [],
    denyPaths: [...config.denyPaths, ...override?.denyPaths ?? []]
  };
}
function relativeInside(parent, child) {
  const rel = relative(parent, child);
  if (rel === "")
    return "";
  if (rel.startsWith("..") || isAbsolute(rel))
    return;
  return rel.split(sep).join("/");
}
function isDeniedPath(path, denyPaths) {
  return denyPaths.some((deny) => path === deny || path.startsWith(`${deny}${sep}`) || path.startsWith(`${deny}/`));
}
function expandUserPath(path, home3 = process.env.HOME || homedir()) {
  if (path === "~")
    return home3;
  if (path.startsWith("~/"))
    return join3(home3, path.slice(2));
  return path;
}
async function resolveDenyPaths(paths, worktree, realpathFn = realpath) {
  const resolved = [];
  for (const path of paths) {
    const expanded = expandUserPath(path);
    const absolute = isAbsolute(expanded) ? resolve2(expanded) : resolve2(worktree, expanded);
    try {
      resolved.push(await realpathFn(absolute));
    } catch {
      resolved.push(absolute);
    }
  }
  return resolved;
}
var DEFAULT_FLUTTER_PATTERN, FORBIDDEN_EXEC, GENERATED_ARTIFACT_DIRS;
var init_worktree_reaper_config = __esm(() => {
  DEFAULT_FLUTTER_PATTERN = String.raw`(?:^|\n)flutter:\s*(?:$|\n)|sdk:\s*flutter`;
  FORBIDDEN_EXEC = new Set([
    "sh",
    "bash",
    "zsh",
    "dash",
    "fish",
    "csh",
    "ksh",
    "env",
    "sudo",
    "git",
    "python",
    "python3",
    "node",
    "perl",
    "ruby",
    "osascript",
    "chmod",
    "chown",
    "mv",
    "cp",
    "dd",
    "find",
    "xargs",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "deno",
    "make",
    "cmake"
  ]);
  GENERATED_ARTIFACT_DIRS = new Set(["target", "build", ".dart_tool"]);
});

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
import { dirname, join as join2, resolve } from "path";
var home2 = process.env.HOME ?? (() => {
  throw new Error("HOME is required");
})();
function resolveRemoteConfigPath(rawSelector = process.env.T3_ORCHESTRATION_REMOTE_CONFIG, homeDirectory = process.env.HOME ?? home2) {
  const explicit = rawSelector?.trim();
  if (!explicit)
    return join2(homeDirectory, ".config/t3-orchestration/client.json");
  return resolve(explicit);
}
var REMOTE_CONFIG_PATH = resolveRemoteConfigPath();
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
  const path = resolveRemoteConfigPath();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed.url !== "string")
      throw new Error("Remote orchestration config is malformed");
    return normalizeRemoteUrl(parsed.url);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
}
async function requireLocalReaperTransport() {
  const explicit = process.env.T3_ORCHESTRATION_REMOTE_CONFIG?.trim();
  const path = resolveRemoteConfigPath();
  if (explicit) {
    try {
      await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`explicit remote orchestration config is unavailable: ${path}`);
      }
      throw error;
    }
  }
  if (await configuredRemoteUrl()) {
    throw new Error("t3-worktree-reaper is host-local and refuses remote t3ctl mode; it only talks to the existing local t3-orchestrationd socket");
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
  return new Promise((resolve2, reject) => {
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
          resolve2(JSON.parse(line));
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
init_worktree_reaper_config();
import { lstat as lstat2, mkdir as mkdir3, readdir, readFile as readFile3, realpath as realpath2, writeFile as writeFile3 } from "fs/promises";
import { dirname as dirname2, join as join5, resolve as resolve3 } from "path";
import { homedir as homedir3 } from "os";

// packages/t3-orchestration/src/worktree-reaper-lease.ts
import { createHash } from "crypto";
import { link, lstat, mkdir as mkdir2, rm as rm2, writeFile as writeFile2 } from "fs/promises";
import { homedir as homedir2 } from "os";
import { join as join4 } from "path";
function cleanLeaseHome(home3 = process.env.T3_HOME?.trim() || join4(process.env.HOME || homedir2(), ".t3")) {
  return join4(home3, "worktree-reaper-leases");
}
function cleanLeaseLockPath(worktreePath, home3) {
  const digest = createHash("sha256").update(worktreePath).digest("hex");
  return join4(cleanLeaseHome(home3), digest);
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
  if (!isLivePid(record.pid, processProbe))
    return false;
  const currentStart = processStartKey(record.pid);
  if (currentStart === null)
    return false;
  if (record.startKey && record.startKey !== currentStart)
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
async function readLiveCleanLease(worktreePath, home3, fns = {}) {
  const path = cleanLeaseLockPath(worktreePath, home3);
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
async function reclaimStaleLock(lockPath, inspected) {
  const token = crypto.randomUUID();
  const candidate = `${lockPath}.reclaim-candidate-${process.pid}-${token}`;
  const claimPath = `${lockPath}.reclaim`;
  await writeFile2(candidate, `${JSON.stringify({ pid: process.pid, token })}
`, { mode: 384, flag: "wx" });
  const candidateIdentity = lockIdentity(await lstat(candidate, { bigint: true }));
  let claimed = false;
  try {
    if (!candidateIdentity)
      return false;
    try {
      await link(candidate, claimPath);
      claimed = true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "EEXIST" || code === "ENOTEMPTY")
        return false;
      throw error;
    }
    if (!await hasIdentity(claimPath, candidateIdentity) || !await hasIdentity(lockPath, inspected)) {
      return false;
    }
    await rm2(lockPath, { force: true });
    return !await hasIdentity(lockPath, inspected);
  } finally {
    await rm2(candidate, { force: true });
    if (claimed && candidateIdentity) {
      if (await hasIdentity(claimPath, candidateIdentity))
        await rm2(claimPath, { force: true });
    }
  }
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
  const token = crypto.randomUUID();
  const lockPath = cleanLeaseLockPath(path, options.home);
  await mkdir2(cleanLeaseHome(options.home), { recursive: true, mode: 448 });
  const processStartKey = options.processStartKey ?? defaultProcessStartKey;
  const record = {
    token,
    threadId,
    path,
    role,
    pid: process.pid,
    startKey: processStartKey(process.pid),
    acquiredAt: (options.now ?? (() => new Date().toISOString()))()
  };
  const fns = {
    processProbe: options.processProbe,
    processStartKey: options.processStartKey
  };
  let acquiredIdentity;
  for (let attempt = 0;attempt < 3; attempt++) {
    const candidate = `${lockPath}.candidate-${process.pid}-${token}-${attempt}`;
    await writeFile2(candidate, `${JSON.stringify(record)}
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
      const reclaimed = await reclaimStaleLock(lockPath, inspected.identity);
      if (!reclaimed && attempt === 2)
        throw reservationError(path, await readLiveCleanLease(path, options.home, fns), role);
    } finally {
      await rm2(candidate, { force: true });
    }
  }
  if (!acquiredIdentity)
    throw reservationError(path, await readLiveCleanLease(path, options.home, fns), role);
  const heldIdentity = acquiredIdentity;
  const controller = new AbortController;
  return {
    token,
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
        const current = parseLeaseRecord(JSON.parse(await Bun.file(lockPath).text()));
        if (!current || current.token !== token)
          return;
        if (!await hasIdentity(lockPath, heldIdentity))
          return;
        await rm2(lockPath, { force: true });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return;
        if (error instanceof SyntaxError)
          return;
      }
    }
  };
}
async function holdExclusiveCleanLease(task, path, readTask, isViolated, options = {}) {
  const gate = await acquireWorktreeGate(path, task.id, "clean", options);
  let stopped = false;
  const pollMs = options.pollMs ?? 25;
  const watch = (async () => {
    while (!stopped && !gate.signal.aborted) {
      try {
        const current = await readTask(task.id);
        if (isViolated(current)) {
          gate.abort();
          return;
        }
      } catch {
        gate.abort();
        return;
      }
      await Bun.sleep(pollMs);
    }
  })();
  return {
    ...gate,
    async release() {
      stopped = true;
      await watch.catch(() => {
        return;
      });
      await gate.release();
    }
  };
}

// packages/t3-orchestration/src/worktree-reaper.ts
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
  return task.sessionStatus === "running" || task.sessionStatus === "starting" || task.latestTurnState === "running" || task.phase === "running" || task.phase === "starting" || task.backgroundLiveness === "working" || task.backgroundLiveness === "monitoring";
}
function isLivenessUnavailable(task) {
  return task.backgroundLiveness !== null && task.backgroundLiveness !== "working" && task.backgroundLiveness !== "monitoring";
}
function isCleanableLifecycle(task) {
  return !task.deleted && (task.settled === true || task.archived === true);
}
function taskTargetIdentityChanged(before, after) {
  return before.projectId !== after.projectId || (before.workspaceRoot ?? "") !== (after.workspaceRoot ?? "") || (before.worktreePath ?? "") !== (after.worktreePath ?? "") || (before.branch ?? "") !== (after.branch ?? "");
}
function otherTaskOccupyingPath(taskId, path, occupied) {
  return occupied.find((entry) => entry.id !== taskId && entry.path === path);
}
async function resolveOccupiedWorktrees(occupied, realpathFn) {
  const resolved = [];
  const seen = new Set;
  const add = (id, path) => {
    const key = `${id}\x00${path}`;
    if (seen.has(key))
      return;
    seen.add(key);
    resolved.push({ id, path });
  };
  for (const entry of occupied) {
    const id = entry.id?.trim();
    const raw = entry.path?.trim();
    if (!id || !raw)
      continue;
    add(id, raw);
    try {
      add(id, await realpathFn(raw));
    } catch {}
  }
  return resolved;
}
function resolveRegisteredWorktree(task, worktrees, resolvedPaths, occupied = []) {
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
    const taskBranch = normalizeBranch(task.branch);
    const claimedBranch = normalizeBranch(match.branch);
    if (!taskBranch || !claimedBranch || taskBranch !== claimedBranch) {
      return {
        ok: false,
        reason: `claimed worktreePath branch ${claimedBranch ?? "(none)"} does not match task branch ${taskBranch ?? "(none)"}`,
        failClosed: true
      };
    }
    const owner2 = otherTaskOccupyingPath(task.id, resolvedClaim, occupied);
    if (owner2) {
      return { ok: false, reason: `worktree ${resolvedClaim} is owned by another task ${owner2.id}`, failClosed: true };
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
  const matchedPath = matches[0].path;
  const owner = otherTaskOccupyingPath(task.id, matchedPath, occupied);
  if (owner) {
    return { ok: false, reason: `worktree ${matchedPath} is owned by another task ${owner.id}`, failClosed: true };
  }
  return { ok: true, path: matchedPath };
}
function shouldSkipUnchanged(state, threadId, path, currentBytes) {
  const previous = state.threads[threadId];
  return Boolean(previous && previous.path === path && previous.bytesAfter === currentBytes);
}
async function walkDirectories(worktree, deps) {
  const directories = [worktree];
  const queue = [worktree];
  const seen = new Set([worktree]);
  while (queue.length) {
    const directory = queue.shift();
    for (const name of await deps.readDirectoryNames(directory)) {
      if (SKIP_DIRECTORY_NAMES.has(name))
        continue;
      const child = join5(directory, name);
      if (seen.has(child) || !await deps.isDirectory(child))
        continue;
      seen.add(child);
      directories.push(child);
      queue.push(child);
    }
  }
  return directories;
}
async function strategyMatchesDirectory(strategy, worktree, directory, names, deps) {
  const relative2 = relativeInside(worktree, directory);
  if (relative2 === undefined)
    return false;
  if (!matchesAnyGlob(relative2, strategy.match))
    return false;
  if (!strategy.markers.every((marker) => names.includes(marker)))
    return false;
  if (!await deps.isDirectory(join5(directory, strategy.artifactDir)))
    return false;
  if (!strategy.requireText)
    return true;
  try {
    return new RegExp(strategy.requireText.pattern).test(await deps.readText(join5(directory, strategy.requireText.file)));
  } catch {
    return false;
  }
}
async function discoverCleanTargets(worktree, strategies, deps) {
  const targets = [];
  for (const directory of await walkDirectories(worktree, deps)) {
    const names = await deps.readDirectoryNames(directory);
    for (const strategy of strategies) {
      if (!await strategyMatchesDirectory(strategy, worktree, directory, names, deps))
        continue;
      targets.push({
        strategy: strategy.name,
        directory,
        artifactDir: join5(directory, strategy.artifactDir),
        artifactName: strategy.artifactDir,
        command: strategy.command
      });
    }
  }
  return targets;
}
async function planClean(task, config, deps, worktreesByRoot, occupied) {
  const policy = resolveProjectPolicy(task, config);
  if (!policy.enabled)
    return { ok: false, action: "skipped", reason: policy.reason ?? "project disabled by host config" };
  const workspaceRoot = task.workspaceRoot?.trim();
  if (!workspaceRoot)
    return { ok: false, action: "failed", reason: "project workspaceRoot is missing" };
  let worktrees = worktreesByRoot.get(workspaceRoot);
  if (!worktrees) {
    try {
      worktrees = await deps.listGitWorktrees(workspaceRoot);
    } catch (error) {
      return { ok: false, action: "failed", reason: `git worktree list failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    worktreesByRoot.set(workspaceRoot, worktrees);
  }
  const resolvedPaths = new Map;
  try {
    resolvedPaths.set(workspaceRoot, await deps.realpath(workspaceRoot));
  } catch (error) {
    return { ok: false, action: "skipped", reason: `workspaceRoot is not resolvable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (task.worktreePath?.trim()) {
    try {
      resolvedPaths.set(task.worktreePath, await deps.realpath(task.worktreePath));
    } catch (error) {
      return { ok: false, action: "skipped", reason: `claimed worktreePath is not resolvable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  for (const worktree of worktrees) {
    try {
      resolvedPaths.set(worktree.path, await deps.realpath(worktree.path));
    } catch {}
  }
  const resolved = resolveRegisteredWorktree(task, worktrees, resolvedPaths, occupied);
  if (!resolved.ok)
    return { ok: false, action: resolved.failClosed ? "failed" : "skipped", reason: resolved.reason };
  const denyPaths = await resolveDenyPaths(policy.denyPaths, resolved.path, deps.realpath);
  if (isDeniedPath(resolved.path, denyPaths)) {
    return { ok: false, action: "skipped", path: resolved.path, reason: "worktree is denied by host config" };
  }
  const targets = (await discoverCleanTargets(resolved.path, policy.strategies, deps)).filter((target) => !isDeniedPath(target.directory, denyPaths) && !isDeniedPath(target.artifactDir, denyPaths));
  try {
    for (const target of targets)
      assertAllowedCleanCommand(target.command, target.artifactName);
  } catch (error) {
    return { ok: false, action: "failed", path: resolved.path, reason: error instanceof Error ? error.message : String(error) };
  }
  const artifactDirs = targets.map((target) => target.artifactDir);
  let bytesBefore = 0;
  for (const directory of artifactDirs)
    bytesBefore += await deps.measureBytes(directory);
  return { ok: true, path: resolved.path, targets, artifactDirs, bytesBefore };
}
async function cleanSettledWorktrees(deps, options) {
  const config = options.config ?? defaultReaperConfig();
  const report = {
    ok: true,
    dryRun: options.dryRun,
    configPath: options.configPath ?? null,
    scanned: 0,
    cleaned: 0,
    skipped: 0,
    failed: 0,
    bytesFreed: 0,
    tasks: []
  };
  if (!config.enabled) {
    return report;
  }
  const state = await deps.readState();
  let listing;
  try {
    listing = await deps.listCleanableTasks();
    if (typeof listing.truncated !== "boolean") {
      throw new Error("cleanable-task listing omitted or malformed truncated; refusing incomplete cleanup");
    }
    listing = { ...listing, occupied: parseOccupiedWorktrees(listing.occupied) };
  } catch (error) {
    report.ok = false;
    report.failed = 1;
    report.tasks.push({
      threadId: "enumeration",
      action: "failed",
      reason: error instanceof Error ? error.message : String(error)
    });
    return report;
  }
  report.scanned = listing.tasks.length;
  if (listing.truncated) {
    report.ok = false;
    report.failed = 1;
    report.tasks.push({
      threadId: "enumeration",
      action: "failed",
      reason: `cleanable-task enumeration truncated at ${listing.tasks.length}; refusing incomplete cleanup`
    });
    return report;
  }
  const tasks = listing.tasks;
  let occupied = await resolveOccupiedWorktrees(listing.occupied, deps.realpath);
  const worktreesByRoot = new Map;
  const refreshOccupancy = async (task, path) => {
    let fresh;
    try {
      fresh = await deps.listCleanableTasks();
      if (typeof fresh.truncated !== "boolean") {
        throw new Error("cleanable-task listing omitted or malformed truncated; refusing incomplete cleanup");
      }
      fresh = { ...fresh, occupied: parseOccupiedWorktrees(fresh.occupied) };
    } catch (error) {
      return {
        ok: false,
        action: "failed",
        path,
        reason: `could not revalidate occupancy: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (fresh.truncated) {
      return {
        ok: false,
        action: "failed",
        path,
        reason: `cleanable-task enumeration truncated at ${fresh.tasks.length}; refusing incomplete cleanup`
      };
    }
    const nextOccupied = await resolveOccupiedWorktrees(fresh.occupied, deps.realpath);
    const freshTask = fresh.tasks.find((entry) => entry.id === task.id);
    if (!freshTask) {
      return { ok: false, action: "failed", path, reason: "task is no longer listed as cleanable" };
    }
    if (!isCleanableLifecycle(freshTask)) {
      return { ok: false, action: "skipped", path, reason: "not settled or archived" };
    }
    if (isRunningTask(freshTask) || isLivenessUnavailable(freshTask)) {
      return {
        ok: false,
        action: "skipped",
        path,
        reason: isLivenessUnavailable(freshTask) ? "liveness unavailable" : "task is running"
      };
    }
    if (taskTargetIdentityChanged(task, freshTask)) {
      return { ok: false, action: "failed", path, reason: "task identity changed during occupancy refresh" };
    }
    const owner = otherTaskOccupyingPath(task.id, path, nextOccupied);
    if (owner) {
      return { ok: false, action: "failed", path, reason: `worktree ${path} is owned by another task ${owner.id}` };
    }
    return { ok: true, occupied: nextOccupied };
  };
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
    if (isRunningTask(task) || isLivenessUnavailable(task)) {
      record({
        threadId: task.id,
        action: "skipped",
        reason: isLivenessUnavailable(task) ? "liveness unavailable" : "task is running"
      });
      continue;
    }
    let plan = await planClean(task, config, deps, worktreesByRoot, occupied);
    if (!plan.ok) {
      record({ threadId: task.id, action: plan.action, path: plan.path, reason: plan.reason });
      continue;
    }
    if (plan.targets.length === 0 || plan.bytesBefore === 0) {
      if (!options.dryRun) {
        state.threads[task.id] = { path: plan.path, bytesAfter: 0, cleanedAt: deps.now() };
      }
      record({
        threadId: task.id,
        action: "unchanged",
        path: plan.path,
        bytesBefore: 0,
        bytesAfter: 0,
        bytesFreed: 0,
        reason: "no matching artifacts"
      });
      continue;
    }
    if (shouldSkipUnchanged(state, task.id, plan.path, plan.bytesBefore)) {
      record({
        threadId: task.id,
        action: "unchanged",
        path: plan.path,
        bytesBefore: plan.bytesBefore,
        bytesAfter: plan.bytesBefore,
        bytesFreed: 0,
        reason: "already cleaned at recorded size"
      });
      continue;
    }
    let current = task;
    try {
      current = await deps.readTask(task.id);
    } catch (error) {
      record({
        threadId: task.id,
        action: "failed",
        path: plan.path,
        reason: `could not revalidate task: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }
    if (isRunningTask(current) || isLivenessUnavailable(current)) {
      record({
        threadId: task.id,
        action: "skipped",
        path: plan.path,
        reason: isLivenessUnavailable(current) ? "liveness unavailable" : "task is running"
      });
      continue;
    }
    if (!isCleanableLifecycle(current)) {
      record({ threadId: task.id, action: "skipped", path: plan.path, reason: "not settled or archived" });
      continue;
    }
    if (taskTargetIdentityChanged(task, current)) {
      plan = await planClean(current, config, deps, worktreesByRoot, occupied);
      if (!plan.ok) {
        record({ threadId: task.id, action: "failed", path: plan.path, reason: `task identity changed: ${plan.reason}` });
        continue;
      }
      if (plan.targets.length === 0 || plan.bytesBefore === 0) {
        record({
          threadId: task.id,
          action: "unchanged",
          path: plan.path,
          bytesBefore: 0,
          bytesAfter: 0,
          bytesFreed: 0,
          reason: "no matching artifacts"
        });
        continue;
      }
    }
    let lease;
    try {
      lease = await deps.holdCleanLease(current, plan.path);
    } catch (error) {
      record({
        threadId: task.id,
        action: "failed",
        path: plan.path,
        reason: `could not acquire clean lease: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }
    try {
      if (lease.signal.aborted) {
        record({ threadId: task.id, action: "failed", path: plan.path, reason: "task resumed during clean lease" });
        continue;
      }
      const refreshed = await refreshOccupancy(current, plan.path);
      if (!refreshed.ok) {
        record({
          threadId: task.id,
          action: "failed",
          path: refreshed.path ?? plan.path,
          reason: refreshed.reason
        });
        continue;
      }
      if (lease.signal.aborted) {
        record({ threadId: task.id, action: "failed", path: plan.path, reason: "task resumed during clean lease" });
        continue;
      }
      occupied = refreshed.occupied;
      if (options.dryRun) {
        record({
          threadId: task.id,
          action: "would-clean",
          path: plan.path,
          bytesBefore: plan.bytesBefore,
          bytesAfter: 0,
          bytesFreed: plan.bytesBefore
        });
        continue;
      }
      let aborted;
      try {
        for (const target of plan.targets) {
          if (lease.signal.aborted) {
            aborted = { ok: false, action: "failed", path: plan.path, reason: "task resumed during clean lease" };
            break;
          }
          await deps.runClean(target.command, target.directory, lease.signal);
        }
      } catch (error) {
        record({
          threadId: task.id,
          action: "failed",
          path: plan.path,
          bytesBefore: plan.bytesBefore,
          reason: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      if (aborted) {
        record({ threadId: task.id, action: aborted.action, path: aborted.path, reason: aborted.reason });
        continue;
      }
      if (lease.signal.aborted) {
        record({ threadId: task.id, action: "failed", path: plan.path, reason: "task resumed during clean lease" });
        continue;
      }
      try {
        const after = await deps.readTask(current.id);
        if (isRunningTask(after) || isLivenessUnavailable(after) || !isCleanableLifecycle(after) || taskTargetIdentityChanged(current, after)) {
          record({
            threadId: task.id,
            action: "failed",
            path: plan.path,
            reason: "task resumed during cleanup"
          });
          continue;
        }
      } catch (error) {
        record({
          threadId: task.id,
          action: "failed",
          path: plan.path,
          reason: `could not confirm task after cleanup: ${error instanceof Error ? error.message : String(error)}`
        });
        continue;
      }
      let bytesAfter = 0;
      for (const directory of plan.artifactDirs) {
        if (await deps.pathExists(directory))
          bytesAfter += await deps.measureBytes(directory);
      }
      const bytesFreed = Math.max(0, plan.bytesBefore - bytesAfter);
      state.threads[task.id] = { path: plan.path, bytesAfter, cleanedAt: deps.now() };
      record({
        threadId: task.id,
        action: "cleaned",
        path: plan.path,
        bytesBefore: plan.bytesBefore,
        bytesAfter,
        bytesFreed
      });
    } finally {
      await lease.release();
    }
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
    return await realpath2(path);
  } catch (error) {
    if (isMissing(error))
      throw new Error(`path does not exist: ${path}`);
    throw error;
  }
}
async function directorySize(path) {
  try {
    const metadata = await lstat2(path);
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
    const child = join5(path, entry.name);
    if (entry.isSymbolicLink())
      continue;
    if (entry.isDirectory())
      total += await directorySize(child);
    else if (entry.isFile()) {
      try {
        total += (await lstat2(child)).size;
      } catch (error) {
        if (!isMissing(error))
          throw error;
      }
    }
  }
  return total;
}
function defaultStatePath(home3 = process.env.HOME || homedir3()) {
  const t3Home = resolve3(process.env.T3_HOME?.trim() || join5(home3, ".t3"));
  return join5(t3Home, "worktree-reaper-state.json");
}
async function readReaperState(path = defaultStatePath()) {
  try {
    const parsed = JSON.parse(await readFile3(path, "utf8"));
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
  await mkdir3(dirname2(path), { recursive: true, mode: 448 });
  await writeFile3(path, `${JSON.stringify(state, null, 2)}
`, { mode: 384 });
}
function isUnknownOperationError(error) {
  return Boolean(error && error.startsWith("Unknown operation:"));
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function parseOccupiedWorktrees(value) {
  if (!Array.isArray(value)) {
    throw new Error("worktrees.listCleanable omitted occupied; refusing mixed-version occupancy");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(`worktrees.listCleanable occupied[${index}] is malformed`);
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const path = typeof entry.path === "string" ? entry.path.trim() : "";
    if (!id || !path)
      throw new Error(`worktrees.listCleanable occupied[${index}] is malformed`);
    return { id, path };
  });
}
function parseListCleanableResult(result) {
  if (!isRecord(result))
    throw new Error("worktrees.listCleanable result is malformed");
  if (typeof result.truncated !== "boolean") {
    throw new Error("worktrees.listCleanable omitted or malformed truncated; refusing incomplete cleanup");
  }
  if (!Array.isArray(result.tasks))
    throw new Error("worktrees.listCleanable omitted tasks");
  return {
    tasks: result.tasks.filter((task) => isCleanableLifecycle(task)),
    truncated: result.truncated,
    occupied: parseOccupiedWorktrees(result.occupied)
  };
}
function taskListEnumerationTruncated(moreRecent) {
  return !Number.isInteger(moreRecent) || moreRecent < 0 || moreRecent > 0;
}
function createDefaultReaperDependencies(request) {
  const occupiedFromTasks = (tasks) => tasks.flatMap((task) => {
    const path = task.worktreePath?.trim();
    if (task.deleted || !path)
      return [];
    return [{ id: task.id, path }];
  });
  const listFromTasks = async () => {
    const projectsResponse = await request({ op: "projects.list" });
    if (!projectsResponse.ok)
      throw new Error(projectsResponse.error ?? "projects.list failed");
    const projects = projectsResponse.result.projects ?? [];
    const roots = new Map(projects.map((project) => [project.id, project.workspaceRoot]));
    const seen = new Set;
    const tasks = [];
    let truncated = false;
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
      if (!isRecord(response.result) || !Array.isArray(response.result.tasks)) {
        throw new Error("tasks.list omitted tasks; refusing incomplete cleanup");
      }
      if (taskListEnumerationTruncated(response.result.moreRecent))
        truncated = true;
      for (const task of response.result.tasks) {
        if (seen.has(task.id))
          continue;
        seen.add(task.id);
        tasks.push({
          ...task,
          workspaceRoot: task.workspaceRoot ?? roots.get(task.projectId) ?? null
        });
      }
    }
    return {
      tasks: tasks.filter((task) => isCleanableLifecycle(task)),
      truncated,
      occupied: occupiedFromTasks(tasks)
    };
  };
  return {
    async listCleanableTasks() {
      const dedicated = await request({ op: "worktrees.listCleanable" });
      if (dedicated.ok) {
        return parseListCleanableResult(dedicated.result);
      }
      if (!isUnknownOperationError(dedicated.error)) {
        throw new Error(dedicated.error ?? "worktrees.listCleanable failed");
      }
      return listFromTasks();
    },
    async readTask(threadId) {
      const response = await request({ op: "tasks.status", threadId });
      if (!response.ok)
        throw new Error(response.error ?? `tasks.status failed for ${threadId}`);
      return response.result;
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
        await lstat2(path);
        return true;
      } catch (error) {
        if (isMissing(error))
          return false;
        throw error;
      }
    },
    async isDirectory(path) {
      try {
        const metadata = await lstat2(path);
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
    readText: (path) => readFile3(path, "utf8"),
    measureBytes: directorySize,
    async runClean(command, directory, signal) {
      if (signal?.aborted)
        throw new Error("clean aborted: task resumed");
      const env = { ...Bun.env };
      if (command[0] === "cargo")
        delete env.CARGO_TARGET_DIR;
      const proc = Bun.spawn(command, {
        cwd: directory,
        env,
        stdout: "pipe",
        stderr: "pipe"
      });
      const abort = () => {
        try {
          proc.kill();
        } catch {}
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const exitCode = await proc.exited;
        if (signal?.aborted)
          throw new Error("clean aborted: task resumed");
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          const stdout = await new Response(proc.stdout).text();
          throw new Error(`${command.join(" ")} failed in ${directory}: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`);
        }
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    holdCleanLease(task, path) {
      return holdExclusiveCleanLease(task, path, async (threadId) => {
        const response = await request({ op: "tasks.status", threadId });
        if (!response.ok)
          throw new Error(response.error ?? `tasks.status failed for ${threadId}`);
        return response.result;
      }, (current) => isRunningTask(current) || isLivenessUnavailable(current) || !isCleanableLifecycle(current) || taskTargetIdentityChanged(task, current));
    },
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
  console.log(JSON.stringify({ help: `t3-worktree-reaper [--dry-run] [--config PATH]
Cleans detected build artifacts from settled or archived T3 worktrees. Does not delete worktrees or source. Host config: ~/.config/skizzles/t3-worktree-reaper.toml` }));
  process.exit(0);
}
var configPath;
var unknown = [];
for (let index = 0;index < args.length; index++) {
  const argument = args[index];
  if (argument === "--dry-run")
    continue;
  if (argument === "--config") {
    configPath = args[++index];
    if (!configPath || configPath.startsWith("--")) {
      console.error("Missing value for --config");
      process.exit(1);
    }
    continue;
  }
  unknown.push(argument);
}
if (unknown.length) {
  console.error(`Unknown option ${unknown[0]}`);
  process.exit(1);
}
try {
  await requireLocalReaperTransport();
  const { loadReaperConfig: loadReaperConfig2 } = await Promise.resolve().then(() => (init_worktree_reaper_config(), exports_worktree_reaper_config));
  const loaded = await loadReaperConfig2(configPath);
  const report = await cleanSettledWorktrees(createDefaultReaperDependencies((payload) => daemonRequest(payload)), {
    dryRun: args.includes("--dry-run"),
    config: loaded.config,
    configPath: loaded.path
  });
  console.log(JSON.stringify({ ...report, log: formatReaperLogs(report) }, null, 2));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
