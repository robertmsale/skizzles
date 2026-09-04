import { isAbsolute, join, resolve } from "node:path";

export type AgentModelSelector = string | readonly string[];
export interface ModelRoutingPolicy {
  maintainerModel: string | undefined;
  maintainerThinking: string | undefined;
  agentModelOverrides: Readonly<Record<string, AgentModelSelector>>;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);

function requiredHome(): string {
  const value = process.env.HOME?.trim();
  if (!value || !isAbsolute(value)) throw new Error("HOME must be an absolute path");
  return value;
}

function absolutePath(value: string | undefined, fallback: string, label: string): string {
  const path = value?.trim() || fallback;
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error(`${label} must be an absolute path`);
  return resolve(path);
}

function parsePort(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("OMP_ORCHESTRATION_HTTP_PORT must be an integer from 1024 through 65535");
  }
  return port;
}

function parseAllowedProjects(value: string | undefined): ReadonlySet<string> | undefined {
  const projects = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return projects.length > 0 ? new Set(projects) : undefined;
}

export function parseModelRouting(env: Record<string, string | undefined>): ModelRoutingPolicy {
  const maintainerModel = optionalSelector(env.OMP_ORCHESTRATION_MAINTAINER_MODEL, "OMP_ORCHESTRATION_MAINTAINER_MODEL");
  const maintainerThinking = env.OMP_ORCHESTRATION_MAINTAINER_THINKING?.trim() || undefined;
  if (maintainerThinking && !THINKING_LEVELS.has(maintainerThinking)) {
    throw new Error("OMP_ORCHESTRATION_MAINTAINER_THINKING is invalid");
  }
  const rawOverrides = env.OMP_ORCHESTRATION_AGENT_MODELS?.trim();
  if (!rawOverrides) return { maintainerModel, maintainerThinking, agentModelOverrides: Object.freeze({}) };
  let parsed: unknown;
  try { parsed = JSON.parse(rawOverrides); }
  catch { throw new Error("OMP_ORCHESTRATION_AGENT_MODELS must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OMP_ORCHESTRATION_AGENT_MODELS must be a JSON object");
  }
  const overrides: Record<string, AgentModelSelector> = {};
  for (const [agent, value] of Object.entries(parsed)) {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(agent)) {
      throw new Error(`OMP_ORCHESTRATION_AGENT_MODELS contains invalid agent ${JSON.stringify(agent)}`);
    }
    if (typeof value === "string") {
      overrides[agent] = requiredSelector(value, `model selector for ${agent}`);
      continue;
    }
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`model selectors for ${agent} must be a string or non-empty string array`);
    }
    overrides[agent] = Object.freeze(value.map((selector) => {
      if (typeof selector !== "string") throw new Error(`model selectors for ${agent} must contain only strings`);
      return requiredSelector(selector, `model selector for ${agent}`);
    }));
  }
  return { maintainerModel, maintainerThinking, agentModelOverrides: Object.freeze(overrides) };
}

function optionalSelector(value: string | undefined, label: string): string | undefined {
  const selector = value?.trim();
  if (!selector) return undefined;
  if (selector.length > 255 || /[\0\r\n]/.test(selector)) throw new Error(`${label} is invalid`);
  return selector;
}

function requiredSelector(value: string, label: string): string {
  const selector = optionalSelector(value, label);
  if (!selector) throw new Error(`${label} is invalid`);
  return selector;
}

const userHome = requiredHome();
export const ORCHESTRATION_HOME = absolutePath(
  process.env.OMP_ORCHESTRATION_HOME,
  join(userHome, ".omp-orchestration"),
  "OMP_ORCHESTRATION_HOME",
);
export const SOCKET_PATH = absolutePath(
  process.env.OMP_ORCHESTRATION_SOCKET,
  join(ORCHESTRATION_HOME, "omp-orchestration.sock"),
  "OMP_ORCHESTRATION_SOCKET",
);
export const DATABASE_PATH = absolutePath(
  process.env.OMP_ORCHESTRATION_DATABASE,
  join(ORCHESTRATION_HOME, "state.sqlite"),
  "OMP_ORCHESTRATION_DATABASE",
);
export const OMP_BINARY = process.env.OMP_BINARY?.trim() || "omp";
export const HTTP_PORT = parsePort(process.env.OMP_ORCHESTRATION_HTTP_PORT);
export const HTTP_HOST = process.env.OMP_ORCHESTRATION_HTTP_HOST?.trim() || "127.0.0.1";
export const HTTP_TOKEN = process.env.OMP_ORCHESTRATION_HTTP_TOKEN?.trim() || undefined;
export const HTTP_ALLOWED_PROJECTS = parseAllowedProjects(process.env.OMP_ORCHESTRATION_HTTP_PROJECTS);
export const MODEL_ROUTING = parseModelRouting(process.env);

export function projectStateRoot(projectId: string): string {
  return join(ORCHESTRATION_HOME, "projects", projectId);
}
