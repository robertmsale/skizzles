import { join } from "node:path";
import { $ } from "bun";
import type { ModelSelection } from "./protocol.ts";

const home = process.env.HOME ?? (() => { throw new Error("HOME is required"); })();
export const CODEX_HOME = process.env.CODEX_HOME ?? join(home, ".codex");
export const T3_HOME = process.env.T3_HOME ?? join(home, ".t3");
export const SOCKET_PATH = process.env.T3_ORCHESTRATION_SOCKET ?? join(T3_HOME, "t3-orchestration.sock");
export const DEFAULT_TAILSCALE_GATEWAY_PORT = 43_773;

export function parseTailscaleGatewayPort(value: string | undefined): number {
  const normalized = value?.trim();
  if (!normalized) return DEFAULT_TAILSCALE_GATEWAY_PORT;
  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("T3_ORCHESTRATION_HTTP_PORT must be an integer from 1024 through 65535");
  }
  return port;
}

export const TAILSCALE_GATEWAY_PORT = parseTailscaleGatewayPort(process.env.T3_ORCHESTRATION_HTTP_PORT);
export const TAILSCALE_ALLOWED_USERS = (process.env.T3_ORCHESTRATION_TAILSCALE_USERS ?? "")
  .split(",")
  .map((login) => login.trim().toLowerCase())
  .filter(Boolean);
export const KEYCHAIN_SERVICE = "t3-orchestration";
export const KEYCHAIN_ACCOUNT = process.env.T3_ORCHESTRATION_KEYCHAIN_ACCOUNT ?? "access-token";

// Friendly names for T3 provider instances; any other value is passed through
// as a literal T3 instanceId and checked against the live catalog.
const PROVIDER_ALIASES: Record<string, string> = {
  "": "codex",
  openai: "codex",
  claude: "claudeAgent",
  "claude-code": "claudeAgent",
};

// Harnesses whose T3 tasks boot Full Access. Other instances boot Auto so
// their approvals stay visible to the coordinator and guardian.
const FULL_ACCESS_INSTANCES = new Set(["codex", "claudeAgent", "grok", "cursor"]);

export type TaskProviderRequest = { instanceId: string; model?: string; options: ModelSelection["options"] };

export function taskProviderInstance(provider?: string): string {
  const key = provider?.trim() ?? "";
  return PROVIDER_ALIASES[key.toLowerCase()] ?? key;
}

export async function origin(): Promise<string> {
  const path = join(T3_HOME, "userdata/server-runtime.json");
  const runtime = await Bun.file(path).json() as { origin?: unknown };
  if (typeof runtime.origin !== "string" || !/^https?:\/\//.test(runtime.origin)) throw new Error(`Invalid T3 runtime origin in ${path}`);
  return runtime.origin.replace(/\/$/, "");
}

export async function token(): Promise<string> {
  const result = await $`security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`.quiet();
  const value = result.text().trim();
  if (!value) throw new Error("No T3 token. Run t3ctl auth configure.");
  return value;
}

// Codex creation without --model follows the top-level defaults in
// CODEX_HOME/config.toml. Anything it leaves out (or a missing file) falls back
// to the live T3 catalog. model_provider (for example codex-lb) is resolved by
// Codex itself and never becomes T3's instanceId.
export async function codexDefaults(): Promise<TaskProviderRequest> {
  const file = Bun.file(join(CODEX_HOME, "config.toml"));
  const parsed = await file.exists() ? Bun.TOML.parse(await file.text()) as Record<string, unknown> : {};
  const setting = (key: string): string | undefined => {
    const value = parsed[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new Error(`config.toml ${key} must be a nonempty string`);
    return value;
  };
  const model = setting("model");
  const effort = setting("model_reasoning_effort");
  const serviceTier = setting("service_tier");
  return {
    instanceId: "codex",
    ...(model ? { model } : {}),
    options: [
      ...(effort ? [{ id: "reasoningEffort", value: effort }] : []),
      ...(serviceTier ? [{ id: "serviceTier", value: serviceTier }] : []),
    ],
  };
}

export async function taskProviderDefaults(provider: string | undefined, model?: string): Promise<TaskProviderRequest> {
  const instanceId = taskProviderInstance(provider);
  const override = model?.trim();
  // Omitting --model for Codex keeps the user's config.toml defaults. Every other
  // case leaves the model and options to the live T3 catalog; --model never
  // reads or writes config.toml.
  if (instanceId === "codex" && !override) return codexDefaults();
  return { instanceId, ...(override ? { model: override } : {}), options: [] };
}

export function taskRuntimeMode(instanceId: string): "auto" | "full-access" {
  return FULL_ACCESS_INSTANCES.has(instanceId) ? "full-access" : "auto";
}
