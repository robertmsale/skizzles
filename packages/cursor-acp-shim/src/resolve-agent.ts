import { lstatSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const BINARY_NAMES = ["cursor-agent", "agent"] as const;

export type ResolveAgentOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  argv0?: string;
  execPath?: string;
};

export function childArgsFromArgv(argv: string[]): string[] {
  const args = [...argv];
  if (args[0] === "cursor-agent" || args[0] === "agent") args.shift();
  if (args.length === 0) return ["acp"];
  return args;
}

export function resolveCursorAgent(options: ResolveAgentOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const self = realExisting(options.execPath) ?? realExisting(options.argv0);
  const override = env.T3_CURSOR_ACP_BIN?.trim() || env.CURSOR_AGENT_BIN?.trim();
  if (override) {
    const resolved = realExisting(override);
    if (!resolved) throw new Error(`Cursor agent binary does not exist: ${override}`);
    if (self && samePath(resolved, self)) {
      throw new Error("T3_CURSOR_ACP_BIN resolves to the shim; set it to the real cursor-agent binary");
    }
    return resolved;
  }
  const versioned = latestVersionedAgent(home, self);
  if (versioned) return versioned;
  for (const name of BINARY_NAMES) {
    const fromPath = lookupOnPath(name, env.PATH ?? "", self);
    if (fromPath) return fromPath;
  }
  throw new Error("Unable to resolve the real cursor-agent binary; set T3_CURSOR_ACP_BIN to its path");
}

function latestVersionedAgent(home: string, self: string | undefined): string | undefined {
  const root = join(home, ".local/share/cursor-agent/versions");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return undefined;
  }
  const candidates = names
    .map((name) => join(root, name, "cursor-agent"))
    .map((path) => ({ path, real: realExisting(path) }))
    .filter((entry): entry is { path: string; real: string } => Boolean(entry.real))
    .filter((entry) => !self || !samePath(entry.real, self))
    .sort((a, b) => b.path.localeCompare(a.path));
  return candidates[0]?.real;
}

function lookupOnPath(name: string, pathValue: string, self: string | undefined): string | undefined {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    const real = realExisting(candidate);
    if (real && (!self || !samePath(real, self))) return real;
  }
  return undefined;
}

function realExisting(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const absolute = isAbsolute(path) ? path : join(process.cwd(), path);
    const stats = lstatSync(absolute);
    if (stats.isDirectory()) return undefined;
    return realpathSync(absolute);
  } catch {
    return undefined;
  }
}

function samePath(left: string, right: string): boolean {
  return left === right;
}
