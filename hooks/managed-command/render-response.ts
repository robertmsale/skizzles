import { isManagedCommand } from "./classify-command.ts";
import { parseScriptCommands } from "./parse-script.ts";

type HookEvent = {
  hook_event_name?: unknown;
  permission_mode?: unknown;
  tool_name?: unknown;
  tool_input?: Record<string, unknown>;
};

const maximumScriptLength = 64 * 1024;
const bypassPermissionsMode = "bypassPermissions";

/**
 * Converts an eligible PreToolUse event into the exact hook response expected
 * by Codex. Undefined means passthrough without a permission decision.
 */
export function renderManagedCommandResponse(raw: string): string | undefined {
  const event = parseHookEvent(raw);
  if (
    !event
    || event.hook_event_name !== "PreToolUse"
    || event.permission_mode !== bypassPermissionsMode
  ) {
    return undefined;
  }

  const command = commandFrom(event.tool_input);
  const commands = command ? parseScriptCommands(command.value) : undefined;
  if (
    !command
    || command.value.length === 0
    || command.value.length > maximumScriptLength
    || !commands?.every(isManagedCommand)
  ) {
    return undefined;
  }

  const encoded = encodedScriptArgument(command.value);
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...event.tool_input,
        [command.key]: `${runner()} run --json ${encoded}`,
      },
    },
  });
}

function parseHookEvent(raw: string): HookEvent | undefined {
  try {
    return JSON.parse(raw) as HookEvent;
  } catch {
    return undefined;
  }
}

function commandFrom(input: Record<string, unknown> | undefined):
  | { key: "cmd" | "command"; value: string }
  | undefined {
  if (!input) return undefined;
  const hasCmd = Object.hasOwn(input, "cmd");
  const hasCommand = Object.hasOwn(input, "command");
  if (hasCmd === hasCommand) return undefined;
  const key = hasCmd ? "cmd" : "command";
  const value = input[key];
  return typeof value === "string" ? { key, value } : undefined;
}

/**
 * Plugin hooks run with PLUGIN_ROOT set by Codex. Keeping the placeholder in
 * the rewritten command lets the eventual shell expand the staged plugin path
 * instead of baking a machine-specific directory into distributable output.
 */
function runner(): string {
  return 'bun "${PLUGIN_ROOT}/runtime/codex-command.ts"';
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Keeps the original script visible to permission reviewers while protecting
 * it from expansion by the outer shell that launches the supervisor. The
 * runner parses the canonical JSON string before handing the exact script to
 * the invoking shell.
 */
function encodedScriptArgument(value: string): string {
  return shellSingleQuote(JSON.stringify(value));
}
