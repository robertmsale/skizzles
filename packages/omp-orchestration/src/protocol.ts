export const SERVICE_SCHEMA = 1;
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

export type MaintainerState = "stopped" | "starting" | "ready" | "busy" | "failed";
export type JobState = "running" | "completed" | "failed" | "aborted" | "publishing" | "published" | "publish_failed";
export type ApprovalState = "pending" | "approved" | "denied" | "cancelled";

export interface Project {
  id: string;
  name: string;
  cwd: string;
  remote: string | null;
  baseBranch: string;
  model: string | null;
  thinking: string | null;
  autoPublish: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Maintainer {
  projectId: string;
  state: MaintainerState;
  pid: number | null;
  sessionId: string | null;
  sessionFile: string | null;
  startedAt: number | null;
  heartbeatAt: number | null;
  restartCount: number;
  lastError: string | null;
}

export interface Job {
  id: string;
  projectId: string;
  agent: string;
  description: string | null;
  assignment: string | null;
  status: JobState;
  parentToolCallId: string | null;
  sessionFile: string | null;
  baseSha: string | null;
  branchName: string;
  progress: unknown;
  error: string | null;
  prUrl: string | null;
  prNumber: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface Approval {
  id: string;
  projectId: string;
  method: string;
  title: string | null;
  request: unknown;
  status: ApprovalState;
  response: unknown;
  createdAt: number;
  resolvedAt: number | null;
}

export interface JournalEvent {
  sequence: number;
  projectId: string | null;
  kind: string;
  payload: unknown;
  createdAt: number;
}

export type DaemonResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code: string };

export class ServiceError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message);
    this.name = "ServiceError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(value: unknown, label: string, maximum = 1_000_000): string {
  if (typeof value !== "string" || !value.trim() || /\0/.test(value) || value.length > maximum) {
    throw new ServiceError(`${label} is invalid`, "invalid_request");
  }
  return value.trim();
}

export function optionalString(value: unknown, label: string, maximum = 1_000_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, label, maximum);
}

export function requireProjectId(value: unknown): string {
  const id = requiredString(value, "project id", 64);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(id)) {
    throw new ServiceError("project id must use lowercase letters, numbers, dots, dashes, or underscores", "invalid_request");
  }
  return id;
}
