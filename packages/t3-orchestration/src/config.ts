import { join } from "node:path";
import { $ } from "bun";
import { requireSelection, type ModelSelection } from "./protocol.ts";

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

export type TaskProvider = "codex" | "grok" | "cursor";

const GROK_DEFAULT_MODEL = "grok-4.6";
const CURSOR_INSTANCE_ID = "cursor";
const CURSOR_DEFAULT_MODEL = "grok-4.6";
const CURSOR_REASONING_OPTION_ID = "reasoning";
const CURSOR_REASONING_HIGH = "high";
const CURSOR_FAST_MODE_OPTION_ID = "fastMode";
const SUPPORTED_PROVIDERS = "codex, grok, cursor";

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

export async function codexDefaults(): Promise<ModelSelection> {
  const text = await Bun.file(join(CODEX_HOME, "config.toml")).text();
  const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  const model = parsed.model;
  const effort = parsed.model_reasoning_effort;
  const provider = parsed.model_provider;
  const serviceTier = parsed.service_tier;
  if (typeof model !== "string" || typeof effort !== "string" || typeof provider !== "string") {
    throw new Error("config.toml must define model, model_reasoning_effort, and model_provider");
  }
  // T3's installed Codex adapter is addressed as `codex`; the upstream
  // model_provider (for example codex-lb) is resolved by Codex itself from
  // CODEX_HOME/config.toml. Never put that upstream id in T3's instanceId.
  if (provider.length === 0) throw new Error("config.toml model_provider is empty");
  const selection = requireSelection({
    instanceId: "codex",
    model,
    options: [
      { id: "reasoningEffort", value: effort },
      ...(typeof serviceTier === "string" ? [{ id: "serviceTier", value: serviceTier }] : []),
    ],
  });
  if (!selection.options.some((entry) => entry.id === "reasoningEffort")) {
    throw new Error("Codex default reasoning effort is missing");
  }
  return selection;
}

export function applyTaskModelOverride(selection: ModelSelection, model?: string): ModelSelection {
  const override = model?.trim();
  if (!override) return selection;
  return requireSelection({ ...selection, model: override });
}

export async function taskProviderDefaults(provider: string | undefined, model?: string): Promise<ModelSelection> {
  const override = model?.trim();
  switch (provider?.trim().toLowerCase() || "codex") {
    case "codex":
    case "openai":
      // `--model` tells T3 to use that catalog slug. Do not open
      // CODEX_HOME/config.toml to copy reasoningEffort or serviceTier.
      // Hypothesis (verified against T3 contracts): ModelSelection.options is
      // optional; Codex session runtime falls back to catalog current/default,
      // then "medium". applyCatalogSelectionDefaults fills catalog currents
      // during preflight. Omit --model keeps Rob's config.toml defaults.
      if (override) {
        return { instanceId: "codex", model: override, options: [] };
      }
      return codexDefaults();
    case "grok":
      // T3's Grok ACP provider currently exposes no model option descriptors.
      // Reasoning is owned by the installed Grok harness, not by task creators.
      return applyTaskModelOverride(
        requireSelection({ instanceId: "grok", model: GROK_DEFAULT_MODEL, options: [] }),
        model,
      );
    case "cursor":
      // Discovered from this machine's live T3 catalog: instanceId `cursor`,
      // model slug `grok-4.6` ("Cursor Grok 4.6"), option id `reasoning`
      // value `high`, and boolean `fastMode`. Catalog currentValue for
      // fastMode is true; pin false so `--provider cursor` is Grok 4.6 High,
      // not High Fast.
      return applyTaskModelOverride(requireSelection({
        instanceId: CURSOR_INSTANCE_ID,
        model: CURSOR_DEFAULT_MODEL,
        options: [
          { id: CURSOR_REASONING_OPTION_ID, value: CURSOR_REASONING_HIGH },
          { id: CURSOR_FAST_MODE_OPTION_ID, value: false },
        ],
      }), model);
    default:
      throw new Error(`Unsupported task provider '${provider}'. Supported providers: ${SUPPORTED_PROVIDERS}`);
  }
}

export function taskRuntimeMode(provider?: string): "auto" | "full-access" {
  switch (provider?.trim().toLowerCase() || "codex") {
    case "grok":
    case "cursor":
      return "full-access";
    case "codex":
    case "openai":
    default:
      return "auto";
  }
}
