#!/usr/bin/env bun

/**
 * Keeps spawn-agent children on an explicit role and a bounded context fork.
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
const denialReason =
  'Select a non-empty agent_type role and use the smallest useful positive numbered fork_turns (for example, "1"); do not use full-history or context-free forks.';

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deniesSpawn(input: unknown): boolean {
  if (!isJsonObject(input)) return true;

  const agentType = input.agent_type;
  const forkTurns = input.fork_turns;
  return typeof agentType !== "string" || agentType.trim() === "" ||
    typeof forkTurns !== "string" || !positiveForkTurns.test(forkTurns);
}

function isMultiAgentV2Spawn(input: unknown): input is JsonObject {
  return isJsonObject(input) && typeof input.task_name === "string";
}

function deny(): void {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: denialReason,
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
  if (hookEvent.hook_event_name !== "PreToolUse" || hookEvent.tool_name !== "spawn_agent") return;
  if (!isMultiAgentV2Spawn(hookEvent.tool_input)) return;
  if (deniesSpawn(hookEvent.tool_input)) deny();
}

await main();
