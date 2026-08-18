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

// packages/t3-orchestration/src/remote-config.ts
var exports_remote_config = {};
__export(exports_remote_config, {
  resolveRemoteConfigPath: () => resolveRemoteConfigPath,
  requireLocalReaperTransport: () => requireLocalReaperTransport,
  normalizeRemoteUrl: () => normalizeRemoteUrl,
  configuredRemoteUrl: () => configuredRemoteUrl,
  configureRemoteUrl: () => configureRemoteUrl,
  clearRemoteUrl: () => clearRemoteUrl,
  REMOTE_CONFIG_PATH: () => REMOTE_CONFIG_PATH
});
import { chmod, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join as join2, resolve } from "path";
function resolveRemoteConfigPath(rawSelector = process.env.T3_ORCHESTRATION_REMOTE_CONFIG, homeDirectory = process.env.HOME ?? home2) {
  const explicit = rawSelector?.trim();
  if (!explicit)
    return join2(homeDirectory, ".config/t3-orchestration/client.json");
  return resolve(explicit);
}
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
var home2, REMOTE_CONFIG_PATH;
var init_remote_config = __esm(() => {
  home2 = process.env.HOME ?? (() => {
    throw new Error("HOME is required");
  })();
  REMOTE_CONFIG_PATH = resolveRemoteConfigPath();
});

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

// packages/t3-orchestration/src/worktree-reaper.ts
var exports_worktree_reaper = {};
__export(exports_worktree_reaper, {
  writeReaperState: () => writeReaperState,
  taskTargetIdentityChanged: () => taskTargetIdentityChanged,
  shouldSkipUnchanged: () => shouldSkipUnchanged,
  resolveRegisteredWorktree: () => resolveRegisteredWorktree,
  resolveOccupiedWorktrees: () => resolveOccupiedWorktrees,
  readReaperState: () => readReaperState,
  parseGitWorktreePorcelain: () => parseGitWorktreePorcelain,
  otherTaskOccupyingPath: () => otherTaskOccupyingPath,
  normalizeBranch: () => normalizeBranch,
  isUnknownOperationError: () => isUnknownOperationError,
  isRunningTask: () => isRunningTask,
  isLivenessUnavailable: () => isLivenessUnavailable,
  isFlutterPubspec: () => isFlutterPubspec,
  isCleanableLifecycle: () => isCleanableLifecycle,
  formatReaperLogs: () => formatReaperLogs,
  discoverCleanTargets: () => discoverCleanTargets,
  defaultStatePath: () => defaultStatePath,
  createDefaultReaperDependencies: () => createDefaultReaperDependencies,
  cleanSettledWorktrees: () => cleanSettledWorktrees,
  REAPER_LAUNCH_AGENT_LABEL: () => REAPER_LAUNCH_AGENT_LABEL,
  ORCHESTRATION_LAUNCH_AGENT_LABEL: () => ORCHESTRATION_LAUNCH_AGENT_LABEL
});
import { lstat, mkdir as mkdir2, readdir, readFile as readFile3, realpath as realpath2, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname2, join as join4, resolve as resolve3 } from "path";
import { homedir as homedir2 } from "os";
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
function isFlutterPubspec(text) {
  return /(?:^|\n)flutter:\s*(?:$|\n)/.test(text) || /sdk:\s*flutter/.test(text);
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
      const child = join4(directory, name);
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
  if (!await deps.isDirectory(join4(directory, strategy.artifactDir)))
    return false;
  if (!strategy.requireText)
    return true;
  try {
    return new RegExp(strategy.requireText.pattern).test(await deps.readText(join4(directory, strategy.requireText.file)));
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
        artifactDir: join4(directory, strategy.artifactDir),
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
  const listing = await deps.listCleanableTasks();
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
  const occupied = await resolveOccupiedWorktrees(listing.occupied, deps.realpath);
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
    try {
      for (const target of plan.targets)
        await deps.runClean(target.command, target.directory);
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
    const child = join4(path, entry.name);
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
function defaultStatePath(home3 = process.env.HOME || homedir2()) {
  const t3Home = resolve3(process.env.T3_HOME?.trim() || join4(home3, ".t3"));
  return join4(t3Home, "worktree-reaper-state.json");
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
  await mkdir2(dirname2(path), { recursive: true, mode: 448 });
  await writeFile2(path, `${JSON.stringify(state, null, 2)}
`, { mode: 384 });
}
function isUnknownOperationError(error) {
  return Boolean(error && error.startsWith("Unknown operation:"));
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
      const listed = response.result;
      if ((listed.moreRecent ?? 0) > 0)
        truncated = true;
      for (const task of listed.tasks ?? []) {
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
        const result = dedicated.result;
        const tasks = (result.tasks ?? []).filter((task) => isCleanableLifecycle(task));
        return {
          tasks,
          truncated: result.truncated === true,
          occupied: Array.isArray(result.occupied) ? result.occupied : occupiedFromTasks(tasks)
        };
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
    readText: (path) => readFile3(path, "utf8"),
    measureBytes: directorySize,
    async runClean(command, directory) {
      const env = { ...Bun.env };
      if (command[0] === "cargo")
        delete env.CARGO_TARGET_DIR;
      const result = await Bun.$`${command}`.cwd(directory).env(env).nothrow().quiet();
      if (result.exitCode !== 0) {
        throw new Error(`${command.join(" ")} failed in ${directory}: ${result.stderr.toString().trim() || result.stdout.toString().trim() || `exit ${result.exitCode}`}`);
      }
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
var REAPER_LAUNCH_AGENT_LABEL = "io.github.skizzles.t3-worktree-reaper", ORCHESTRATION_LAUNCH_AGENT_LABEL = "io.github.t3-orchestration.daemon", SKIP_DIRECTORY_NAMES;
var init_worktree_reaper = __esm(() => {
  init_worktree_reaper_config();
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
init_remote_config();
import { connect } from "net";
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

// packages/t3-orchestration/src/cli.ts
init_remote_config();
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
t3ctl worktrees clean-settled [--dry-run] [--config PATH]`;
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
    const { requireLocalReaperTransport: requireLocalReaperTransport2 } = await Promise.resolve().then(() => (init_remote_config(), exports_remote_config));
    await requireLocalReaperTransport2();
    const { cleanSettledWorktrees: cleanSettledWorktrees2, createDefaultReaperDependencies: createDefaultReaperDependencies2, formatReaperLogs: formatReaperLogs2 } = await Promise.resolve().then(() => (init_worktree_reaper(), exports_worktree_reaper));
    const { loadReaperConfig: loadReaperConfig2 } = await Promise.resolve().then(() => (init_worktree_reaper_config(), exports_worktree_reaper_config));
    const loaded = await loadReaperConfig2(option("config"));
    const report = await cleanSettledWorktrees2(createDefaultReaperDependencies2((command) => daemonRequest(command)), {
      dryRun: payload.dryRun === true,
      config: loaded.config,
      configPath: loaded.path
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
