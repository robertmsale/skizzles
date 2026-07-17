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
type SimpleCommand = { words: string[]; uncertain: boolean[] };

function simpleCommands(script: string): SimpleCommand[] | undefined {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let uncertainty: boolean[] = [];
  let word = "";
  let wordUncertain = false;
  let wordStarted = false;
  let inSingle = false;
  let inDouble = false;
  let atWordStart = true;
  let skipRedirectionTarget = false;

  const finishWord = () => {
    if (wordStarted) {
      if (skipRedirectionTarget) skipRedirectionTarget = false;
      else {
        words.push(word);
        uncertainty.push(wordUncertain);
      }
    }
    word = "";
    wordUncertain = false;
    wordStarted = false;
  };
  const finishCommand = () => {
    finishWord();
    if (skipRedirectionTarget) return false;
    if (words.length > 0) commands.push({ words, uncertain: uncertainty });
    words = [];
    uncertainty = [];
    return true;
  };

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;

    if (inSingle) {
      if (character === "'") inSingle = false;
      else word += character;
      continue;
    }
    if (inDouble) {
      if (character === '"') inDouble = false;
      else word += character;
      continue;
    }
    if (character === "\\" || character === "`" || character === "$" || character === "(" || character === ")") return undefined;
    if (character === "'") {
      wordStarted = true;
      wordUncertain = true;
      inSingle = true;
      continue;
    }
    if (character === '"') {
      wordStarted = true;
      wordUncertain = true;
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
    wordStarted = true;
    atWordStart = false;
  }

  if (inSingle || inDouble || !finishCommand()) return undefined;
  return commands.length > 0 ? commands : undefined;
}

function isRecognized(command: SimpleCommand | undefined): boolean {
  if (!command || command.words.length < 2) return false;
  const normalized = normalizeCommand(command);
  if (!normalized || normalized.words.length === 0) return false;
  const { words, uncertain } = normalized;

  const [program, subcommand, third] = words;

  if (isContainerLabRun(normalized)) return true;
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
      ? words[words.indexOf(action) + 1] === "run"
      : ["build", "b", "check", "c", "test", "t", "clippy", "bench", "doc", "install", "llvm-cov"].includes(action!);
  }
  if (program === "xcodebuild") return true;
  if (program === "swift") return ["build", "test"].includes(subcommand!);
  if (program === "gradle" || program === "gradlew") {
    return words.slice(1).some(isGradleBuildOrTestTask);
  }
  return false;
}

const containerLabGlobalOptions = new Set([
  "--owner",
  "--state-root",
  "--runtime-root",
]);

/**
 * Container Lab accepts a small set of global options before its command.
 * Recognize only that exact prefix and only a literal launcher invocation;
 * variables, substitutions, quotes, and unknown flags remain passthrough.
 */
function isContainerLabRun(command: SimpleCommand): boolean {
  const { words, uncertain } = command;
  let index: number;
  if (words[0] === "codex-container-lab" && !uncertain[0]) index = 1;
  else if (words[0] === "bun" && !uncertain[0] && basename(words[1] ?? "") === "codex-container-lab" && !uncertain[1]) index = 2;
  else return false;

  while (index < words.length && containerLabGlobalOptions.has(words[index]!)) {
    if (uncertain[index] || words[index + 1] === undefined || words[index + 1]!.startsWith("--") || uncertain[index + 1]) return false;
    index += 2;
  }
  return words[index] === "run" && !uncertain[index];
}

function basename(program: string): string {
  return program.split("/").at(-1) ?? program;
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function normalizeCommand(command: SimpleCommand): SimpleCommand | undefined {
  const { words, uncertain } = command;
  let index = 0;
  const isCertain = (tokenIndex: number) => !uncertain[tokenIndex];

  while (isAssignment(words[index] ?? "")) {
    if (!isCertain(index)) return undefined;
    index += 1;
  }

  if (basename(words[index] ?? "") === "env") {
    if (!isCertain(index)) return undefined;
    index += 1;
    while (index < words.length) {
      const word = words[index]!;
      if (!isCertain(index)) return undefined;
      if (word === "--") {
        index += 1;
        break;
      }
      if (isAssignment(word) || ["-i", "--ignore-environment"].includes(word)) {
        index += 1;
        continue;
      }
      if (["-u", "--unset", "-C", "--chdir"].includes(word)) {
        if (words[index + 1] === undefined || !isCertain(index + 1)) return undefined;
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
    while (isAssignment(words[index] ?? "")) {
      if (!isCertain(index)) return undefined;
      index += 1;
    }
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
  return {
    words: [basename(words[index]!), ...words.slice(index + 1)],
    uncertain: [uncertain[index] ?? false, ...uncertain.slice(index + 1)],
  };
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
