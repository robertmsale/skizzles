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
  const command = canonicalCodexCommand(options);
  assertSafeCodexCommand(command);
  return command;
}

function canonicalCodexCommand(options: CodexCommandOptions): string[] {
  const fixtureRoot = resolve(options.fixtureRoot);
  return [
    options.codexBinary ?? "codex",
    "--ask-for-approval",
    "never",
    "exec",
    "--strict-config",
    "--ephemeral",
    "--ignore-rules",
    "--json",
    "--sandbox",
    "workspace-write",
    "-m",
    "gpt-5.6-sol",
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    "agents.enabled=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.hooks=false",
    "-c",
    "features.plugins=false",
    "-c",
    `model_instructions_file=${JSON.stringify(resolve(options.instructionFile))}`,
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "-c",
    'web_search="disabled"',
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    `shell_environment_policy.set={HOME=${JSON.stringify(fixtureRoot)}}`,
    "-c",
    'shell_environment_policy.include_only=["PATH","TMPDIR"]',
    "--cd",
    fixtureRoot,
    "-o",
    resolve(options.finalMessagePath),
  ];
}

export interface CommandControlDescriptor {
  readonly fixedFlags: readonly string[];
  readonly configControls: readonly string[];
}

export function commandControlDescriptor(command: readonly string[]): CommandControlDescriptor {
  const normalized = command.map((argument, index) => normalizeControlArgument(argument, index, command));
  const fixedFlags: string[] = [];
  const configControls: string[] = [];
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] === "-c") {
      if (normalized[index + 1]) configControls.push(normalized[index + 1]!);
      index += 1;
      continue;
    }
    if (normalized[index - 1] !== "-c") fixedFlags.push(normalized[index]!);
  }
  return { fixedFlags, configControls };
}

function normalizeControlArgument(argument: string, index: number, command: readonly string[]): string {
  const previous = command[index - 1];
  if (previous === "--cd") return "<fixture-root>";
  if (previous === "-o") return "<final-output>";
  if (argument.startsWith("model_instructions_file=")) return "model_instructions_file=<instruction-overlay>";
  if (argument.startsWith("shell_environment_policy.set=")) return argument.replace(/HOME=(?:"[^"]*"|'[^']*'|[^,}]+)/, "HOME=<fixture-root>");
  return argument;
}

export function assertSafeCodexCommand(command: readonly string[]): void {
  for (const argument of command) {
    if (forbiddenFlags.has(argument) || [...forbiddenFlags].some((flag) => argument.startsWith(`${flag}=`))) {
      throw new Error(`dangerous Codex flag is forbidden in prompt evaluation: ${argument}`);
    }
  }
  if (!command.includes("--strict-config") || !command.includes("--ephemeral") || !command.includes("--ignore-rules")) {
    throw new Error("prompt evaluation requires --strict-config, --ephemeral, and --ignore-rules");
  }
  const binaryIndex = 0;
  if (command[binaryIndex + 1] !== "--ask-for-approval" || command[binaryIndex + 2] !== "never" || command[binaryIndex + 3] !== "exec") {
    throw new Error("prompt evaluation requires top-level --ask-for-approval never before exec");
  }
  if (!command.includes("--sandbox") || command[command.indexOf("--sandbox") + 1] !== "workspace-write") {
    throw new Error("prompt evaluation requires workspace-write sandbox");
  }
  const fixtureRoot = valueAfter(command, "--cd");
  const finalMessagePath = valueAfter(command, "-o");
  const instructionOverride = command.find((argument) => argument.startsWith("model_instructions_file="));
  const instructionFile = parseJsonString(instructionOverride?.slice("model_instructions_file=".length));
  if (!fixtureRoot || !finalMessagePath || !instructionFile) throw new Error("prompt evaluation requires the canonical command layout");
  const expected = canonicalCodexCommand({ fixtureRoot, instructionFile, finalMessagePath, ...(command[0] ? { codexBinary: command[0] } : {}) });
  if (command.length !== expected.length || command.some((argument, index) => argument !== expected[index])) {
    throw new Error("prompt evaluation requires the canonical command and config override list");
  }
}

function valueAfter(command: readonly string[], flag: string): string | undefined {
  const index = command.indexOf(flag);
  return index >= 0 ? command[index + 1] : undefined;
}

function parseJsonString(value: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(value ?? "");
    return typeof parsed === "string" && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function commandText(command: readonly string[]): string {
  return command.map(shellQuote).join(" ");
}

function shellQuote(argument: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(argument)) return argument;
  return `'${argument.replaceAll("'", "'\\''")}'`;
}
