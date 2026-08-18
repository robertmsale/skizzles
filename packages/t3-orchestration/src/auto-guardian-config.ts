import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { OFFICIAL_AUTO_REVIEW_MODEL } from "./auto-guardian-policy.ts";

export type GuardianConfig = {
  enabled: boolean;
  pollIntervalMs: number;
  model: string;
  dryRun: boolean;
  includeProjects: string[];
  excludeProjects: string[];
  judgeTimeoutMs: number;
};

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_JUDGE_TIMEOUT_MS = 120_000;
export const MIN_POLL_INTERVAL_MS = 1_000;
export const MAX_POLL_INTERVAL_MS = 3_600_000;
export const MIN_JUDGE_TIMEOUT_MS = 5_000;
export const MAX_JUDGE_TIMEOUT_MS = 600_000;

export function defaultGuardianConfig(): GuardianConfig {
  return {
    enabled: true,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    model: OFFICIAL_AUTO_REVIEW_MODEL,
    dryRun: false,
    includeProjects: [],
    excludeProjects: [],
    judgeTimeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
  };
}

export function defaultGuardianConfigPath(home = process.env.HOME || homedir()): string {
  const configRoot = resolve(process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config"));
  return join(configRoot, "skizzles/t3-auto-guardian.toml");
}

function asStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
}

function asBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function asBoundedInteger(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export function parseGuardianConfig(text: string): GuardianConfig {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`T3 auto guardian config is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("T3 auto guardian config must be a TOML table");
  const raw = parsed as Record<string, unknown>;
  const knownKeys = new Set([
    "enabled",
    "poll_interval_ms",
    "model",
    "dry_run",
    "include_projects",
    "exclude_projects",
    "judge_timeout_ms",
  ]);
  const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`T3 auto guardian config contained unknown keys: ${unknownKeys.join(", ")}`);
  }
  const defaults = defaultGuardianConfig();
  const model = raw.model === undefined
    ? defaults.model
    : typeof raw.model === "string" && raw.model.trim()
      ? raw.model.trim()
      : (() => { throw new Error("model must be a non-empty string"); })();
  return {
    enabled: asBoolean(raw.enabled, "enabled", defaults.enabled),
    pollIntervalMs: asBoundedInteger(raw.poll_interval_ms, "poll_interval_ms", defaults.pollIntervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS),
    model,
    dryRun: asBoolean(raw.dry_run, "dry_run", defaults.dryRun),
    includeProjects: asStringArray(raw.include_projects, "include_projects"),
    excludeProjects: asStringArray(raw.exclude_projects, "exclude_projects"),
    judgeTimeoutMs: asBoundedInteger(raw.judge_timeout_ms, "judge_timeout_ms", defaults.judgeTimeoutMs, MIN_JUDGE_TIMEOUT_MS, MAX_JUDGE_TIMEOUT_MS),
  };
}

export async function loadGuardianConfig(explicitPath?: string): Promise<{ config: GuardianConfig; path: string | null }> {
  const configured = explicitPath?.trim() || process.env.T3_AUTO_GUARDIAN_CONFIG?.trim();
  const path = configured || defaultGuardianConfigPath();
  try {
    return { config: parseGuardianConfig(await readFile(path, "utf8")), path };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      if (configured) throw new Error(`T3 auto guardian config is missing: ${path}`);
      return { config: defaultGuardianConfig(), path: null };
    }
    throw error;
  }
}

export function selectorMatches(
  target: { projectId: string; projectTitle?: string | null; workspaceRoot?: string | null },
  selector: string,
): boolean {
  const value = selector.trim();
  if (!value) return false;
  return target.projectId === value || target.projectTitle === value || target.workspaceRoot === value;
}

export function projectAllowed(
  target: { projectId: string; projectTitle?: string | null; workspaceRoot?: string | null },
  config: GuardianConfig,
): { allowed: boolean; reason?: string } {
  if (config.includeProjects.length > 0 && !config.includeProjects.some((selector) => selectorMatches(target, selector))) {
    return { allowed: false, reason: "project is not in include_projects" };
  }
  if (config.excludeProjects.some((selector) => selectorMatches(target, selector))) {
    return { allowed: false, reason: "project is in exclude_projects" };
  }
  return { allowed: true };
}
