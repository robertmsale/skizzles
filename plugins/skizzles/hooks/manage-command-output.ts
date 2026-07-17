#!/usr/bin/env bun

/**
 * Routes only confidently-recognized, potentially noisy commands through the
 * command-output supervisor. This is intentionally a classifier, not a shell
 * parser or a security policy: uncertainty always means passthrough.
 */
type HookEvent = {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: Record<string, unknown>;
};

export {};

const maximumScriptLength = 64 * 1024;

/**
 * Plugin hooks run with PLUGIN_ROOT set by Codex. Keeping the placeholder in
 * the rewritten command lets the eventual shell expand the staged plugin path
 * instead of baking a machine-specific directory into distributable output.
 */
function runner(): string {
  return 'bun "${PLUGIN_ROOT}/runtime/codex-command.ts"';
}

function commandFrom(input: Record<string, unknown> | undefined):
  | { key: "cmd" | "command"; value: string }
  | undefined {
  if (!input) return undefined;
  for (const key of ["cmd", "command"] as const) {
    const value = input[key];
    if (typeof value === "string") return { key, value };
  }
}

/**
 * Returns unquoted words for every top-level simple command. This deliberately
 * handles only a small, well-understood shell subset: quotes and comments are
 * skipped, ordinary command separators split commands, and constructs such as
 * substitutions, grouping, or heredocs make the whole script ineligible.
 */
function simpleCommands(script: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inSingle = false;
  let inDouble = false;
  let atWordStart = true;
  let skipRedirectionTarget = false;

  const finishWord = () => {
    if (word) {
      if (skipRedirectionTarget) skipRedirectionTarget = false;
      else words.push(word);
    }
    word = "";
  };
  const finishCommand = () => {
    finishWord();
    if (skipRedirectionTarget) return false;
    if (words.length > 0) commands.push(words);
    words = [];
    return true;
  };

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;

    if (inSingle) {
      if (character === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (character === '"') inDouble = false;
      continue;
    }
    if (character === "\\" || character === "`" || character === "$" || character === "(" || character === ")") return undefined;
    if (character === "'") {
      inSingle = true;
      continue;
    }
    if (character === '"') {
      inDouble = true;
      continue;
    }
    if (character === "#" && atWordStart) {
      while (index + 1 < script.length && script[index + 1] !== "\n") index += 1;
      atWordStart = true;
      continue;
    }
    if (character === "\n" || character === ";") {
      if (!finishCommand()) return undefined;
      atWordStart = true;
      continue;
    }
    if (character === "&" || character === "|") {
      if (!finishCommand()) return undefined;
      if (script[index + 1] === character) index += 1;
      atWordStart = true;
      continue;
    }
    if (character === "<" || character === ">") {
      finishWord();
      if (skipRedirectionTarget || script[index + 1] === character) return undefined;
      skipRedirectionTarget = true;
      atWordStart = true;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      atWordStart = true;
      continue;
    }
    word += character;
    atWordStart = false;
  }

  if (inSingle || inDouble || !finishCommand()) return undefined;
  return commands.length > 0 ? commands : undefined;
}

function isRecognized(words: string[] | undefined): boolean {
  if (!words || words.length < 2) return false;
  const normalized = normalizeCommand(words);
  if (!normalized || normalized.length === 0) return false;

  const [program, subcommand, third] = normalized;

  if (program === "codex-container-lab") return subcommand === "run";
  if (program === "bun") {
    return subcommand === "test" || (subcommand === "run" && third === "test");
  }
  if (program === "just") return subcommand === "test";
  if (program === "flutter") {
    return ["test", "analyze", "drive", "build"].includes(subcommand!);
  }
  if (program === "dart") {
    return ["test", "analyze"].includes(subcommand!);
  }
  if (program === "cargo") {
    const action = subcommand?.startsWith("+") ? third : subcommand;
    return action === "nextest"
      ? normalized[normalized.indexOf(action) + 1] === "run"
      : ["build", "b", "check", "c", "test", "t", "clippy", "bench", "doc", "install", "llvm-cov"].includes(action!);
  }
  if (program === "xcodebuild") return true;
  if (program === "swift") return ["build", "test"].includes(subcommand!);
  if (program === "gradle" || program === "gradlew") {
    return normalized.slice(1).some(isGradleBuildOrTestTask);
  }
  return false;
}

function basename(program: string): string {
  return program.split("/").at(-1) ?? program;
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function normalizeCommand(words: string[]): string[] | undefined {
  let index = 0;
  while (isAssignment(words[index] ?? "")) index += 1;

  if (basename(words[index] ?? "") === "env") {
    index += 1;
    while (index < words.length) {
      const word = words[index]!;
      if (word === "--") {
        index += 1;
        break;
      }
      if (isAssignment(word) || ["-i", "--ignore-environment"].includes(word)) {
        index += 1;
        continue;
      }
      if (["-u", "--unset", "-C", "--chdir"].includes(word)) {
        index += 2;
        continue;
      }
      if (word.startsWith("--unset=") || word.startsWith("--chdir=")) {
        index += 1;
        continue;
      }
      if (word.startsWith("-")) return undefined;
      break;
    }
    while (isAssignment(words[index] ?? "")) index += 1;
  }

  const launcher = basename(words[index] ?? "");
  if (launcher === "fvm") index += 1;
  else if (launcher === "rustup" && words[index + 1] === "run" && words[index + 2]) index += 3;
  else if (launcher === "xcrun") {
    index += 1;
    while (index < words.length) {
      const option = words[index]!;
      if (option === "--") {
        index += 1;
        break;
      }
      if (["--sdk", "-sdk", "--toolchain", "-toolchain"].includes(option)) {
        index += 2;
        continue;
      }
      if (["--log", "-log", "--verbose", "-v", "--no-cache", "--run"].includes(option)) {
        index += 1;
        continue;
      }
      if (option.startsWith("-")) return undefined;
      break;
    }
  }

  if (index >= words.length) return undefined;
  return [basename(words[index]!), ...words.slice(index + 1)];
}

function isGradleBuildOrTestTask(word: string): boolean {
  if (word.startsWith("-")) return false;
  const task = word.split(":").at(-1)?.toLowerCase() ?? "";
  return ["build", "assemble", "bundle", "check", "test", "connected", "lint"].some(
    (prefix) => task === prefix || task.startsWith(prefix),
  );
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

const raw = await Bun.stdin.text();
let event: HookEvent;
try {
  event = JSON.parse(raw) as HookEvent;
} catch {
  process.exit(0);
}

if (event.hook_event_name !== "PreToolUse") process.exit(0);
const command = commandFrom(event.tool_input);
if (
  !command ||
  command.value.length === 0 ||
  command.value.length > maximumScriptLength ||
  !simpleCommands(command.value)?.some(isRecognized)
) {
  process.exit(0);
}

const encoded = base64Url(command.value);
console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...event.tool_input,
        [command.key]: `${runner()} run --base64url ${encoded}`,
      },
    },
  }),
);
