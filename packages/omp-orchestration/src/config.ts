import { isAbsolute, join, resolve } from "node:path";

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

export function projectStateRoot(projectId: string): string {
  return join(ORCHESTRATION_HOME, "projects", projectId);
}
