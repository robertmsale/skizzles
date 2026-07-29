import { resolve } from "node:path";

const forbiddenFlags = new Set([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
]);

/**
 * The installed CLI accepts this approval policy only before `exec`.
 * Keeping the rejected placement explicit prevents a future refactor from
 * silently moving it into the exec-scoped argument list.
 */
export const unsupportedApprovalPlacements = ["codex exec --ask-for-approval never"] as const;

export interface CodexCommandOptions {
  readonly fixtureRoot: string;
  readonly instructionFile: string;
  readonly finalMessagePath: string;
  readonly codexBinary?: string;
}

export function buildCodexCommand(options: CodexCommandOptions): string[] {
  const command = [
    options.codexBinary ?? "codex",
    "--ask-for-approval",
    "never",
    "exec",
    "--strict-config",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--sandbox",
    "workspace-write",
    "-m",
    "gpt-5.6-sol",
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    `model_instructions_file="${resolve(options.instructionFile)}"`,
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "-c",
    'web_search="disabled"',
    "-c",
    'shell_environment_policy.include_only=["PATH","HOME","TMPDIR"]',
    "--cd",
    resolve(options.fixtureRoot),
    "-o",
    resolve(options.finalMessagePath),
  ];
  assertSafeCodexCommand(command);
  return command;
}

export function assertSafeCodexCommand(command: readonly string[]): void {
  for (const argument of command) {
    if (forbiddenFlags.has(argument) || [...forbiddenFlags].some((flag) => argument.startsWith(`${flag}=`))) {
      throw new Error(`dangerous Codex flag is forbidden in prompt evaluation: ${argument}`);
    }
  }
  if (!command.includes("--strict-config") || !command.includes("--ephemeral") || !command.includes("--ignore-user-config") || !command.includes("--ignore-rules")) {
    throw new Error("prompt evaluation requires --strict-config, --ephemeral, --ignore-user-config, and --ignore-rules");
  }
  const binaryIndex = 0;
  if (command[binaryIndex + 1] !== "--ask-for-approval" || command[binaryIndex + 2] !== "never" || command[binaryIndex + 3] !== "exec") {
    throw new Error("prompt evaluation requires top-level --ask-for-approval never before exec");
  }
  if (!command.includes("--sandbox") || command[command.indexOf("--sandbox") + 1] !== "workspace-write") {
    throw new Error("prompt evaluation requires workspace-write sandbox");
  }
  for (const required of [
    "sandbox_workspace_write.network_access=false",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    'web_search="disabled"',
    'shell_environment_policy.include_only=["PATH","HOME","TMPDIR"]',
  ]) {
    if (!command.includes(required)) throw new Error(`prompt evaluation requires ${required}`);
  }
}

export function commandText(command: readonly string[]): string {
  return command.map(shellQuote).join(" ");
}

function shellQuote(argument: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(argument)) return argument;
  return `'${argument.replaceAll("'", "'\\''")}'`;
}
