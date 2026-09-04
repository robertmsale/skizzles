#!/usr/bin/env bun

/**
 * Allows native spawn defaults, explicit model/reasoning, context-free
 * fork_turns="none", and positive numbered context forks.
 * Denies full-history or omitted forks when model/reasoning overrides are
 * present, because the native surface disallows that combination.
 * This hook only denies invalid requests; it never rewrites tool arguments.
 */
type HookEvent = {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
};

type JsonObject = Record<string, unknown>;

export {};

const positiveForkTurns = /^[1-9][0-9]*$/;
const spawnAgentToolNames = new Set(["spawn_agent", "collaborationspawn_agent"]);
const modelReasoningOverrideNames = [
  "model",
  "reasoning_effort",
] as const;
const invalidInputReason = "spawn_agent input must be an object.";
const blankRoleReason =
  'If agent_type is set, use a non-empty role name; omit it to keep the native default.';
const overrideForkReason =
  'Explicit model/reasoning overrides require fork_turns="none" or a positive numbered context fork; the native surface disallows full-history and omitted forks with those overrides.';
const malformedForkReason =
  'Use fork_turns="none" for a context-free spawn, a positive numbered context fork (for example, "1"), or a native default ("all" or omitted without model/reasoning overrides).';

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasModelReasoningOverride(input: JsonObject): boolean {
  return modelReasoningOverrideNames.some((name) => Object.hasOwn(input, name));
}

function isAllowedExplicitFork(value: unknown): boolean {
  return value === "none" || (typeof value === "string" && positiveForkTurns.test(value));
}

function isNativeDefaultFork(value: unknown): boolean {
  return value === "all" || isAllowedExplicitFork(value);
}

function spawnDenialReason(input: unknown): string | undefined {
  if (!isJsonObject(input)) return invalidInputReason;

  if (Object.hasOwn(input, "agent_type")) {
    const agentType = input.agent_type;
    if (typeof agentType !== "string" || agentType.trim() === "") return blankRoleReason;
  }

  const overrides = hasModelReasoningOverride(input);
  const forkPresent = Object.hasOwn(input, "fork_turns");
  const forkTurns = input.fork_turns;

  if (overrides) {
    if (!forkPresent || forkTurns === "all" || !isAllowedExplicitFork(forkTurns)) return overrideForkReason;
    return undefined;
  }

  if (forkPresent && !isNativeDefaultFork(forkTurns)) return malformedForkReason;
  return undefined;
}

function isMultiAgentV2Spawn(input: unknown): input is JsonObject {
  return isJsonObject(input) && typeof input.task_name === "string";
}

function deny(reason: string): void {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
}

async function main(): Promise<void> {
  let event: unknown;
  try {
    event = JSON.parse(await Bun.stdin.text());
  } catch {
    return;
  }

  if (!isJsonObject(event)) return;
  const hookEvent = event as HookEvent;
  if (
    hookEvent.hook_event_name !== "PreToolUse" ||
    typeof hookEvent.tool_name !== "string" ||
    !spawnAgentToolNames.has(hookEvent.tool_name)
  ) return;
  if (!isMultiAgentV2Spawn(hookEvent.tool_input)) return;
  const reason = spawnDenialReason(hookEvent.tool_input);
  if (reason) deny(reason);
}

await main();
