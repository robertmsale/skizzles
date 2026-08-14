#!/usr/bin/env bun

type JsonObject = Record<string, unknown>;

const allowedSubagentTypes = new Set([
  "skizzles-worker",
  "skizzles-explorer",
  "skizzles-reviewer",
]);
const forbiddenOverrides = ["model", "reasoning_effort", "effort", "thinking"];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deny(reason: string): void {
  console.log(JSON.stringify({ decision: "deny", reason }));
}

async function main(): Promise<void> {
  if (process.env.GROK_AGENT !== "skizzles-root") return;

  let event: unknown;
  try {
    event = JSON.parse(await Bun.stdin.text());
  } catch {
    return;
  }
  if (!isObject(event) || event.hookEventName !== "pre_tool_use" || event.toolName !== "spawn_subagent") return;
  if (event.toolInputTruncated === true) {
    deny("Skizzles cannot verify a truncated subagent request. Retry with a smaller prompt.");
    return;
  }
  if (!isObject(event.toolInput)) return;

  const subagentType = event.toolInput.subagent_type;
  if (typeof subagentType !== "string" || !allowedSubagentTypes.has(subagentType)) {
    deny("Select exactly one Skizzles role: skizzles-worker, skizzles-explorer, or skizzles-reviewer.");
    return;
  }
  if (forbiddenOverrides.some((key) => Object.hasOwn(event.toolInput, key))) {
    deny("Do not supply model or reasoning overrides. Skizzles subagents inherit the root session configuration.");
  }
}

await main();
