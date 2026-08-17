import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type CleanStrategy = {
  name: string;
  enabled: boolean;
  markers: string[];
  artifactDir: string;
  command: string[];
  match: string[];
  requireText?: { file: string; pattern: string };
};

export type ExtraCommand = {
  match: string;
  command: string[];
};

export type ProjectOverride = {
  id?: string;
  workspaceRoot?: string;
  enabled: boolean;
  strategies?: string[];
  extraCommands: ExtraCommand[];
  denyPaths: string[];
};

export type ReaperConfig = {
  enabled: boolean;
  includeProjects: string[];
  denyPaths: string[];
  strategies: CleanStrategy[];
  extraCommands: ExtraCommand[];
  projects: ProjectOverride[];
};

export type ProjectPolicy = {
  enabled: boolean;
  reason?: string;
  strategies: CleanStrategy[];
  extraCommands: ExtraCommand[];
  denyPaths: string[];
};

const DEFAULT_FLUTTER_PATTERN = String.raw`(?:^|\n)flutter:\s*(?:$|\n)|sdk:\s*flutter`;

export function defaultReaperConfig(): ReaperConfig {
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
        match: [],
      },
      {
        name: "flutter",
        enabled: true,
        markers: ["pubspec.yaml"],
        artifactDir: "build",
        command: ["flutter", "clean"],
        match: [],
        requireText: { file: "pubspec.yaml", pattern: DEFAULT_FLUTTER_PATTERN },
      },
    ],
  };
}

export function defaultReaperConfigPath(home = process.env.HOME || homedir()): string {
  const configRoot = resolve(process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config"));
  return join(configRoot, "skizzles/t3-worktree-reaper.toml");
}

function asStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
}

function asCommand(value: unknown, label: string): string[] {
  const command = asStringArray(value, label);
  if (command.length === 0) throw new Error(`${label} must include an executable`);
  return command;
}

function parseStrategy(value: unknown, index: number): CleanStrategy {
  if (!value || typeof value !== "object") throw new Error(`strategies[${index}] must be a table`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") throw new Error(`strategies[${index}].name is required`);
  if (typeof raw.artifact_dir !== "string" || raw.artifact_dir.trim() === "") {
    throw new Error(`strategies[${index}].artifact_dir is required`);
  }
  if (raw.artifact_dir.includes("..") || raw.artifact_dir.includes("/") || raw.artifact_dir.includes("\\")) {
    throw new Error(`strategies[${index}].artifact_dir must be a single relative directory name`);
  }
  let requireText: CleanStrategy["requireText"];
  if (raw.require_text !== undefined) {
    if (!raw.require_text || typeof raw.require_text !== "object") throw new Error(`strategies[${index}].require_text must be a table`);
    const text = raw.require_text as Record<string, unknown>;
    if (typeof text.file !== "string" || text.file.trim() === "" || typeof text.pattern !== "string" || text.pattern.trim() === "") {
      throw new Error(`strategies[${index}].require_text needs file and pattern`);
    }
    if (text.file.includes("..") || isAbsolute(text.file)) throw new Error(`strategies[${index}].require_text.file must be a relative file name`);
    requireText = { file: text.file.trim(), pattern: text.pattern };
  }
  return {
    name: raw.name.trim(),
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    markers: asStringArray(raw.markers, `strategies[${index}].markers`),
    artifactDir: raw.artifact_dir.trim(),
    command: asCommand(raw.command, `strategies[${index}].command`),
    match: asStringArray(raw.match, `strategies[${index}].match`),
    ...(requireText ? { requireText } : {}),
  };
}

function parseExtraCommand(value: unknown, label: string): ExtraCommand {
  if (!value || typeof value !== "object") throw new Error(`${label} must be a table`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.match !== "string" || raw.match.trim() === "") throw new Error(`${label}.match is required`);
  return { match: raw.match.trim().replaceAll("\\", "/"), command: asCommand(raw.command, `${label}.command`) };
}

function parseProject(value: unknown, index: number): ProjectOverride {
  if (!value || typeof value !== "object") throw new Error(`projects[${index}] must be a table`);
  const raw = value as Record<string, unknown>;
  const extra = raw.extra_commands === undefined
    ? []
    : Array.isArray(raw.extra_commands)
      ? raw.extra_commands.map((entry, extraIndex) => parseExtraCommand(entry, `projects[${index}].extra_commands[${extraIndex}]`))
      : (() => { throw new Error(`projects[${index}].extra_commands must be an array`); })();
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const workspaceRoot = typeof raw.workspace_root === "string" && raw.workspace_root.trim() ? raw.workspace_root.trim() : undefined;
  if (!id && !workspaceRoot) throw new Error(`projects[${index}] needs id or workspace_root`);
  return {
    ...(id ? { id } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    ...(raw.strategies === undefined ? {} : { strategies: asStringArray(raw.strategies, `projects[${index}].strategies`) }),
    extraCommands: extra,
    denyPaths: asStringArray(raw.deny_paths, `projects[${index}].deny_paths`),
  };
}

export function parseReaperConfig(text: string): ReaperConfig {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`Worktree reaper config is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Worktree reaper config must be a TOML table");
  const raw = parsed as Record<string, unknown>;
  const defaults = defaultReaperConfig();
  const strategies = raw.strategies === undefined
    ? defaults.strategies
    : Array.isArray(raw.strategies)
      ? raw.strategies.map((entry, index) => parseStrategy(entry, index))
      : (() => { throw new Error("strategies must be an array of tables"); })();
  const names = strategies.map((entry) => entry.name);
  if (new Set(names).size !== names.length) throw new Error("strategy names must be unique");
  const extraCommands = raw.extra_commands === undefined
    ? []
    : Array.isArray(raw.extra_commands)
      ? raw.extra_commands.map((entry, index) => parseExtraCommand(entry, `extra_commands[${index}]`))
      : (() => { throw new Error("extra_commands must be an array of tables"); })();
  const projects = raw.projects === undefined
    ? []
    : Array.isArray(raw.projects)
      ? raw.projects.map((entry, index) => parseProject(entry, index))
      : (() => { throw new Error("projects must be an array of tables"); })();
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("enabled must be a boolean");
  return {
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    includeProjects: asStringArray(raw.include_projects, "include_projects"),
    denyPaths: asStringArray(raw.deny_paths, "deny_paths"),
    strategies,
    extraCommands,
    projects,
  };
}

export async function loadReaperConfig(explicitPath?: string): Promise<{ config: ReaperConfig; path: string | null }> {
  const configured = explicitPath?.trim() || process.env.T3_WORKTREE_REAPER_CONFIG?.trim();
  const path = configured || defaultReaperConfigPath();
  try {
    return { config: parseReaperConfig(await readFile(path, "utf8")), path };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      if (configured) throw new Error(`Worktree reaper config is missing: ${path}`);
      return { config: defaultReaperConfig(), path: null };
    }
    throw error;
  }
}

export function normalizeRelative(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function matchRelativeGlob(relativePath: string, pattern: string): boolean {
  const path = normalizeRelative(relativePath);
  const glob = normalizeRelative(pattern);
  if (glob === "" || glob === "**") return path !== ".." && !path.startsWith("../");
  let source = "^";
  for (let index = 0; index < glob.length; ) {
    if (glob.startsWith("**", index)) {
      source += ".*";
      index += 2;
      if (glob[index] === "/") index++;
      continue;
    }
    const character = glob[index]!;
    if (character === "*") source += "[^/]*";
    else if ("\\^$+?.()|[]{}".includes(character)) source += `\\${character}`;
    else source += character;
    index++;
  }
  source += "$";
  return new RegExp(source).test(path);
}

export function matchesAnyGlob(relativePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => matchRelativeGlob(relativePath, pattern));
}

function selectorMatches(task: { projectId: string; projectTitle?: string | null; workspaceRoot?: string | null }, selector: string): boolean {
  const value = selector.trim();
  if (!value) return false;
  return task.projectId === value || task.projectTitle === value || task.workspaceRoot === value;
}

export function resolveProjectPolicy(
  task: { projectId: string; projectTitle?: string | null; workspaceRoot?: string | null },
  config: ReaperConfig,
): ProjectPolicy {
  if (!config.enabled) return { enabled: false, reason: "reaper disabled by host config", strategies: [], extraCommands: [], denyPaths: [] };
  if (config.includeProjects.length > 0 && !config.includeProjects.some((selector) => selectorMatches(task, selector))) {
    return { enabled: false, reason: "project is not in include_projects", strategies: [], extraCommands: [], denyPaths: [] };
  }
  const matches = config.projects.filter((project) => {
    if (project.id && selectorMatches(task, project.id)) return true;
    if (project.workspaceRoot && task.workspaceRoot === project.workspaceRoot) return true;
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
    strategies = named.map((name) => config.strategies.find((strategy) => strategy.name === name)!).filter((strategy) => strategy.enabled);
  }
  return {
    enabled: true,
    strategies,
    extraCommands: [...config.extraCommands, ...(override?.extraCommands ?? [])],
    denyPaths: [...config.denyPaths, ...(override?.denyPaths ?? [])],
  };
}

export function relativeInside(parent: string, child: string): string | undefined {
  const rel = relative(parent, child);
  if (rel === "") return "";
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

export function isDeniedPath(path: string, denyPaths: string[]): boolean {
  return denyPaths.some((deny) => path === deny || path.startsWith(`${deny}${sep}`) || path.startsWith(`${deny}/`));
}

export function expandUserPath(path: string, home = process.env.HOME || homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export async function resolveDenyPaths(
  paths: string[],
  realpathFn: (path: string) => Promise<string> = realpath,
): Promise<string[]> {
  const resolved: string[] = [];
  for (const path of paths) {
    const absolute = resolve(expandUserPath(path));
    try {
      resolved.push(await realpathFn(absolute));
    } catch {
      resolved.push(absolute);
    }
  }
  return resolved;
}

export function assertCommandStaysInside(command: string[], cwd: string, worktree: string): void {
  for (const argument of command.slice(1)) {
    if (!argument.startsWith("/") && !argument.includes("..")) continue;
    const candidate = resolve(cwd, argument);
    if (relativeInside(worktree, candidate) === undefined) {
      throw new Error(`extra command argument escapes the worktree: ${argument}`);
    }
  }
}
