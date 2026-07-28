#!/usr/bin/env bun

/**
 * Routes only confidently-recognized, potentially noisy commands through the
 * command-output supervisor. The classifier handles a conservative shell
 * subset and rewrites only after Codex explicitly bypasses native approvals.
 * Uncertainty always means passthrough.
 */
type HookEvent = {
  hook_event_name?: unknown;
  permission_mode?: unknown;
  tool_name?: unknown;
  tool_input?: Record<string, unknown>;
};

export {};

const maximumScriptLength = 64 * 1024;
const bypassPermissionsMode = "bypassPermissions";

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
  const hasCmd = Object.hasOwn(input, "cmd");
  const hasCommand = Object.hasOwn(input, "command");
  if (hasCmd === hasCommand) return undefined;
  const key = hasCmd ? "cmd" : "command";
  const value = input[key];
  return typeof value === "string" ? { key, value } : undefined;
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
  return isContainerLabRun(normalized) || isKnownManagedCommand(normalized);
}

function isKnownManagedCommand(command: SimpleCommand): boolean {
  const { words, uncertain } = command;
  const [program, subcommand, third] = words;
  const isCertain = (index: number) => uncertain[index] === false;

  if (!isCertain(0)) return false;

  if (program === "bun") {
    return (subcommand === "test" && isCertain(1))
      || (subcommand === "run" && isCertain(1) && third === "test" && isCertain(2));
  }
  if (program === "just") return subcommand === "test" && isCertain(1);
  if (program === "flutter") {
    return isCertain(1) && ["test", "analyze", "drive", "build"].includes(subcommand!);
  }
  if (program === "dart") {
    return isCertain(1) && ["test", "analyze"].includes(subcommand!);
  }
  if (program === "cargo") {
    const actionIndex = subcommand?.startsWith("+") ? 2 : 1;
    if (!isCertain(actionIndex)) return false;
    const action = words[actionIndex];
    return action === "nextest"
      ? words[actionIndex + 1] === "run" && isCertain(actionIndex + 1)
      : ["build", "b", "check", "c", "test", "t", "clippy", "bench", "doc", "llvm-cov"].includes(action!);
  }
  if (program === "xcodebuild") return isXcodeBuildOrTest(command);
  if (program === "swift") return isCertain(1) && ["build", "test"].includes(subcommand!);
  if (program === "gradle" || program === "gradlew") {
    return words.slice(1).some((word, index) => isCertain(index + 1) && isGradleBuildOrTestTask(word));
  }
  return false;
}

const containerLabGlobalOptions = new Set([
  "--owner",
  "--state-root",
  "--runtime-root",
]);
const containerLabRunOptions = new Set([
  "--lab",
  "--cwd",
  "--env",
  "--timeout-seconds",
]);
const repeatableContainerLabRunOptions = new Set(["--env"]);

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
  if (words[index] !== "run" || uncertain[index]) return false;

  const separator = words.indexOf("--", index + 1);
  if (
    separator < 0
    || uncertain[separator]
    || separator === words.length - 1
  ) {
    return false;
  }

  const seenOptions = new Set<string>();
  for (let optionIndex = index + 1; optionIndex < separator; optionIndex += 2) {
    const option = words[optionIndex]!;
    const value = words[optionIndex + 1];
    if (
      !containerLabRunOptions.has(option)
      || uncertain[optionIndex]
      || value === undefined
      || optionIndex + 1 >= separator
      || value.startsWith("--")
      || uncertain[optionIndex + 1]
      || (seenOptions.has(option) && !repeatableContainerLabRunOptions.has(option))
      || !isValidContainerLabRunOption(option, value)
    ) {
      return false;
    }
    seenOptions.add(option);
  }
  if (!seenOptions.has("--lab")) return false;

  const innerCommand = {
    words: words.slice(separator + 1),
    uncertain: uncertain.slice(separator + 1),
  };
  const normalizedInner = normalizeCommand(innerCommand);
  return normalizedInner !== undefined && isKnownManagedCommand(normalizedInner);
}

function isValidContainerLabRunOption(option: string, value: string): boolean {
  if (option === "--cwd") {
    return value.length > 0
      && !value.startsWith("/")
      && !value.includes("\\")
      && !/^[A-Za-z]:/.test(value)
      && !value.split("/").includes("..");
  }
  if (option === "--env") return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
  if (option === "--timeout-seconds") {
    return /^[0-9]+$/.test(value) && Number(value) <= 7_200;
  }
  return value.length > 0;
}

const xcodeApprovalActions = new Set([
  "archive",
  "-archivepath",
  "-exportarchive",
  "-exportpath",
  "install",
]);

const xcodeActions = new Set([
  "analyze",
  "archive",
  "build",
  "build-for-testing",
  "clean",
  "install",
  "test",
  "test-without-building",
]);

const safeXcodeActions = new Set([
  "analyze",
  "build",
  "build-for-testing",
  "test",
  "test-without-building",
]);

function isXcodeBuildOrTest(command: SimpleCommand): boolean {
  for (const [index, word] of command.words.entries()) {
    const normalized = word.toLowerCase();
    if (xcodeApprovalActions.has(normalized)) return false;
    if (xcodeActions.has(normalized) && (command.uncertain[index] || !safeXcodeActions.has(normalized))) {
      return false;
    }
  }
  return true;
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
        if (word.endsWith("=")) return undefined;
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
  if (launcher === "fvm") {
    if (!isCertain(index)) return undefined;
    index += 1;
  }
  else if (launcher === "rustup" && words[index + 1] === "run" && words[index + 2]) {
    if (!isCertain(index) || !isCertain(index + 1)) return undefined;
    index += 3;
  }
  else if (launcher === "xcrun") {
    if (!isCertain(index)) return undefined;
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

const raw = await Bun.stdin.text();
let event: HookEvent;
try {
  event = JSON.parse(raw) as HookEvent;
} catch {
  process.exit(0);
}

if (
  event.hook_event_name !== "PreToolUse"
  || event.permission_mode !== bypassPermissionsMode
) {
  process.exit(0);
}
const command = commandFrom(event.tool_input);
const commands = command ? simpleCommands(command.value) : undefined;
if (
  !command ||
  command.value.length === 0 ||
  command.value.length > maximumScriptLength ||
  !commands?.every(isRecognized)
) {
  process.exit(0);
}

const encoded = encodedScriptArgument(command.value);
console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...event.tool_input,
        [command.key]: `${runner()} run --json ${encoded}`,
      },
    },
  }),
);
