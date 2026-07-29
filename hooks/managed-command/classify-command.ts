import type { ParsedCommand } from "./parse-script.ts";
import {
  containerLabGlobalOptions,
  isManagedContainerLabRun,
  parseContainerLabRunArguments,
} from "../../packages/skizzles-container-lab/run-contract.ts";

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

const xcodeOptionsWithValues = new Set([
  "-arch",
  "-clonedsourcepackagesdirpath",
  "-configuration",
  "-deriveddatapath",
  "-destination",
  "-destination-timeout",
  "-enumerate-tests-format",
  "-enumerate-tests-output-path",
  "-enumerate-tests-style",
  "-maximum-concurrent-test-device-destinations",
  "-maximum-concurrent-test-simulator-destinations",
  "-only-testing",
  "-packageauthorizationprovider",
  "-parallel-testing-worker-count",
  "-project",
  "-resultbundlepath",
  "-resultstreampath",
  "-scheme",
  "-sdk",
  "-skip-testing",
  "-target",
  "-testlanguage",
  "-testplan",
  "-testregion",
  "-toolchain",
  "-workspace",
  "-xcconfig",
]);

export function isManagedCommand(command: ParsedCommand | undefined): boolean {
  if (!command || command.words.length < 2) return false;
  const normalized = normalizeCommand(command);
  if (!normalized || normalized.words.length === 0) return false;
  return isContainerLabRun(normalized) || isKnownManagedCommand(normalized);
}

function isKnownManagedCommand(command: ParsedCommand): boolean {
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

/**
 * Container Lab accepts a small set of global options before its command.
 * Recognize only that exact prefix and only a literal launcher invocation;
 * variables, substitutions, quotes, and unknown flags remain passthrough.
 */
function isContainerLabRun(command: ParsedCommand): boolean {
  const { words, uncertain } = command;
  const globalOptions = new Set<string>(containerLabGlobalOptions);
  let index: number;
  if (words[0] === "codex-container-lab" && !uncertain[0]) index = 1;
  else if (
    words[0] === "bun"
    && !uncertain[0]
    && basename(words[1] ?? "") === "codex-container-lab"
    && !uncertain[1]
  ) {
    index = 2;
  } else {
    return false;
  }

  while (index < words.length && globalOptions.has(words[index]!)) {
    if (
      uncertain[index]
      || words[index + 1] === undefined
      || words[index + 1]!.startsWith("--")
      || uncertain[index + 1]
    ) {
      return false;
    }
    index += 2;
  }
  if (words[index] !== "run" || uncertain[index]) return false;

  const separator = words.indexOf("--", index + 1);
  if (separator < 0 || uncertain[separator] || separator === words.length - 1) {
    return false;
  }

  if (uncertain.slice(index + 1, separator + 1).some(Boolean)) return false;
  const run = parseContainerLabRunArguments(words.slice(index + 1));
  if (!isManagedContainerLabRun(run)) return false;

  const innerCommand = {
    words: run.value.argv,
    uncertain: uncertain.slice(separator + 1),
  };
  const normalizedInner = normalizeCommand(innerCommand);
  return normalizedInner !== undefined && isKnownManagedCommand(normalizedInner);
}

function isXcodeBuildOrTest(command: ParsedCommand): boolean {
  let skipOptionValue = false;
  for (const [index, word] of command.words.entries()) {
    const normalized = word.toLowerCase();
    if (skipOptionValue) {
      skipOptionValue = false;
      continue;
    }
    if (xcodeApprovalActions.has(normalized)) return false;
    if (xcodeOptionsWithValues.has(normalized)) {
      skipOptionValue = true;
      continue;
    }
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

function normalizeCommand(command: ParsedCommand): ParsedCommand | undefined {
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
  } else if (launcher === "rustup" && words[index + 1] === "run" && words[index + 2]) {
    if (!isCertain(index) || !isCertain(index + 1)) return undefined;
    index += 3;
  } else if (launcher === "xcrun") {
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
