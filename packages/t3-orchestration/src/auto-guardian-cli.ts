#!/usr/bin/env bun
import { daemonRequest } from "./client.ts";
import { configuredRemoteUrl } from "./remote-config.ts";
import { defaultGuardianConfigPath, loadGuardianConfig } from "./auto-guardian-config.ts";
import {
  createDefaultGuardianDependencies,
  defaultGuardianStatePath,
  loadGuardianState,
  runGuardianCycle,
  runGuardianLoop,
} from "./auto-guardian.ts";
import { POLICY_DELTAS, POLICY_SOURCE } from "./auto-guardian-policy.ts";

const USAGE = `t3-auto-guardian {run|once|status} [--config PATH] [--dry-run]
T3 Auto guardian. Watches runtimeMode=auto threads whose resolved driver is grok, cursor, or opencode and judges pending approvals with one-shot codex exec. Skips Codex, missing, and unknown drivers. Host config: ~/.config/skizzles/t3-auto-guardian.toml`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  console.log(JSON.stringify({
    help: USAGE,
    policySource: POLICY_SOURCE,
    policyDeltas: POLICY_DELTAS,
  }));
  process.exit(0);
}

const action = args[0];
const rest = args.slice(1);
let configPath: string | undefined;
let dryRunFlag = false;
const unknown: string[] = [];
for (let index = 0; index < rest.length; index++) {
  const argument = rest[index]!;
  if (argument === "--dry-run") {
    dryRunFlag = true;
    continue;
  }
  if (argument === "--config") {
    configPath = rest[++index];
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
if (!["run", "once", "status"].includes(action ?? "")) {
  console.error(`Usage:\n  ${USAGE}`);
  process.exit(1);
}

try {
  if (await configuredRemoteUrl()) {
    throw new Error("t3-auto-guardian is host-local and refuses remote t3ctl mode; it only talks to the existing local t3-orchestrationd socket");
  }
  const loaded = await loadGuardianConfig(configPath);
  const config = dryRunFlag ? { ...loaded.config, dryRun: true } : loaded.config;
  if (action === "status") {
    const state = await loadGuardianState();
    console.log(JSON.stringify({
      enabled: config.enabled,
      dryRun: config.dryRun,
      model: config.model,
      modelReasoningEffort: config.modelReasoningEffort,
      pollIntervalMs: config.pollIntervalMs,
      configPath: loaded.path ?? defaultGuardianConfigPath(),
      statePath: defaultGuardianStatePath(),
      lastPollAt: state.lastPollAt,
      lastError: state.lastError,
      responded: Object.keys(state.responded).length,
      policySource: POLICY_SOURCE,
    }, null, 2));
    process.exit(0);
  }
  const dependencies = createDefaultGuardianDependencies((payload) => daemonRequest(payload));
  if (action === "once") {
    const report = await runGuardianCycle(dependencies, config);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }
  let running = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { running = false; });
  }
  await runGuardianLoop(dependencies, config, Bun.sleep, () => running);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
