#!/usr/bin/env bun

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

type HookEvent = {
  hook_event_name?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
};

type JsonObject = Record<string, unknown>;

export {};

const directPrograms = new Set([
  "bazel", "carthage", "cmake", "dart", "flutter", "gradle", "gradlew",
  "just", "maestro", "make", "melos", "mint", "ninja", "patrol", "pod",
  "rustc", "rustdoc", "rustfmt", "swift", "swiftc", "tuist", "xcodebuild",
]);

const cargoActions = new Set([
  "bench", "build", "check", "clippy", "doc", "fetch", "fix", "fmt",
  "generate-lockfile", "llvm-cov", "metadata", "nextest", "test",
  "tree", "update",
]);

const packageManagerActions = new Set([
  "add", "build", "check", "ci", "install", "lint", "rebuild",
  "run", "test", "typecheck", "update",
]);

const forbiddenScriptName = /(?:^|[-_:/.=])(deploy|prod(?:uction)?|publish|release|ship)(?:$|[-_:/.=])/i;
const consequentialActionName = /^(?:deploy|publish|upload)|release$/i;
const safeGitActions = new Set([
  "add", "branch", "commit", "diff", "log", "ls-files", "merge",
  "rev-parse", "show", "status", "switch",
]);
const unsafeGitFlags = new Set([
  "-B", "-C", "-D", "-M", "-d", "-f", "-n", "--amend", "--delete",
  "--discard-changes", "--force", "--no-verify", "--orphan",
]);
const xcrunPrograms = new Set([
  "actool", "ibtool", "simctl", "swift", "swiftc", "xccov", "xcresulttool",
  "xcodebuild",
]);
const unsafeSimctlActions = new Set(["delete", "erase", "shutdown"]);
const consequentialActions = new Set(["deploy", "publish", "upload"]);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allow(): void {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  }));
}

function commandFrom(input: unknown): string | undefined {
  if (!isJsonObject(input)) return undefined;
  return typeof input.command === "string" ? input.command : undefined;
}

/**
 * Parse a deliberately small shell subset. Approval is granted only when every
 * top-level command is a simple argv list; pipes, redirects, substitutions,
 * grouping, heredocs, and background execution remain with Guardian.
 */
function simpleCommands(script: string): string[][] | undefined {
  if (script.length === 0 || script.length > 64 * 1024) return undefined;
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;

  const finishWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const finishCommand = () => {
    finishWord();
    if (words.length === 0) return false;
    commands.push(words);
    words = [];
    return true;
  };

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      else if (quote === '"' && (character === "$" || character === "`")) return undefined;
      else if (character === "\\" && quote === '"') {
        const next = script[++index];
        if (next === undefined) return undefined;
        word += next;
      } else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\") {
      const next = script[++index];
      if (next === undefined) return undefined;
      word += next;
      started = true;
      continue;
    }
    if (character === "`" || character === "$" || character === "(" || character === ")" ||
        character === "{" || character === "}" ||
        character === "<" || character === ">" || character === "|" || character === "#") return undefined;
    if (character === "&") {
      if (script[index + 1] !== "&" || !finishCommand()) return undefined;
      index += 1;
      continue;
    }
    if (character === ";" || character === "\n") {
      if (!finishCommand()) return undefined;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      continue;
    }
    word += character;
    started = true;
  }

  if (quote || !finishCommand()) return undefined;
  return commands;
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function normalizedWords(words: string[]): string[] | undefined {
  if (words.some(isAssignment) || basename(words[0] ?? "") === "env") return undefined;
  return words;
}

function isLiteralProgram(word: string): boolean {
  return word === "./gradlew" || (!word.includes("/") && !word.includes("\\"));
}

function hasExternalPathArgument(words: string[]): boolean {
  return words.slice(1).some((word) => {
    const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
    return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) ||
      value.startsWith("~") ||
      value === ".." || value.startsWith("../") || value.startsWith("..\\") ||
      value.includes("/../") || value.includes("\\..\\");
  });
}

function packageManagerCommand(words: string[]): boolean {
  const action = words[1];
  if (!action || !packageManagerActions.has(action)) return false;
  const arguments_ = words.slice(2);
  if (arguments_.some((word, index) =>
    ["-g", "--global", "--location=global"].includes(word) ||
    word.startsWith("--global=") ||
    /^-[A-Za-z]*g[A-Za-z]*$/.test(word) ||
    (word === "--location" && arguments_[index + 1] === "global"))) return false;
  if (action === "run" && words[2]?.startsWith("-")) return false;
  const script = action === "run" ? words[2] : action;
  return script !== undefined && !consequentialActionName.test(script) && !forbiddenScriptName.test(script);
}

function safeGitCommand(words: string[]): boolean {
  const action = words[1];
  if (!action || !safeGitActions.has(action)) return false;
  if (words.slice(2).some((word) => unsafeGitFlags.has(word))) return false;
  if (action === "branch" && words.slice(2).some((word) =>
    word.startsWith("-D") || word.startsWith("-d") || word.startsWith("--delete="))) return false;
  return true;
}

function safeSimpleCommand(input: string[]): boolean {
  const words = normalizedWords(input);
  if (!words || words.length === 0) return false;
  if (!isLiteralProgram(words[0]!) || hasExternalPathArgument(words)) return false;
  let program = basename(words[0]!);

  if (program === "fvm") {
    if (!isLiteralProgram(words[1] ?? "")) return false;
    program = basename(words[1] ?? "");
    words.splice(0, 1);
  } else if (program === "rustup" && words[1] === "run" && words[2]) {
    words.splice(0, 3);
    if (!isLiteralProgram(words[0] ?? "")) return false;
    program = basename(words[0] ?? "");
  }

  if (directPrograms.has(program)) {
    if (program === "pod" && words.includes("push")) return false;
    if (program === "xcodebuild" && words.includes("-exportArchive")) return false;
    if (program === "make" && words.some((word) => ["-C", "-f", "--directory", "--file", "--makefile"].includes(word) ||
      word.startsWith("--directory=") || word.startsWith("--file=") || word.startsWith("--makefile="))) return false;
    return !words.slice(1).some((word) => {
      const argument = word.toLowerCase();
      return consequentialActions.has(argument) || consequentialActionName.test(argument) ||
        forbiddenScriptName.test(argument);
    });
  }
  if (program === "cargo") {
    const action = words[1]?.startsWith("+") ? words[2] : words[1];
    return action !== undefined && cargoActions.has(action);
  }
  if (["bun", "npm", "pnpm", "yarn"].includes(program)) {
    return packageManagerCommand(words);
  }
  if (program === "corepack") {
    return words[1] !== undefined && ["bun", "npm", "pnpm", "yarn"].includes(words[1]) &&
      packageManagerCommand(words.slice(1));
  }
  if (program === "git") return safeGitCommand(words);
  if (program === "xcrun") {
    let index = 1;
    while (words[index]?.startsWith("-")) {
      if (["--sdk", "--toolchain"].includes(words[index]!) && words[index + 1]) index += 2;
      else index += 1;
    }
    const childWord = words[index] ?? "";
    if (!isLiteralProgram(childWord)) return false;
    const child = basename(childWord);
    if (!xcrunPrograms.has(child)) return false;
    if (child === "xcodebuild" && words.slice(index + 1).includes("-exportArchive")) return false;
    return child !== "simctl" || !words.slice(index + 1).some((word) => unsafeSimctlActions.has(word));
  }
  return false;
}

function safeShellCommand(command: string, cwd: string): boolean {
  const root = gitRootFor(cwd);
  const existing = nearestExistingPath(cwd);
  if (!root || !existing || !isWithin(root, realpathSync(existing))) return false;
  const commands = simpleCommands(command);
  return commands !== undefined && commands.every(safeSimpleCommand);
}

function patchPaths(patch: string, cwd: string): string[] | undefined {
  if (patch.length === 0 || patch.length > 2 * 1024 * 1024) return undefined;
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) ??
      line.match(/^\*\*\* Move to: (.+)$/);
    if (!match) continue;
    const path = match[1]!;
    if (path.trim() !== path || path.includes("\0")) return undefined;
    paths.push(resolve(cwd, path));
  }
  return paths.length > 0 ? paths : undefined;
}

function nearestExistingPath(path: string): string | undefined {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
  return candidate;
}

function gitRootFor(path: string): string | undefined {
  const existing = nearestExistingPath(path);
  if (!existing) return undefined;
  const resolvedExisting = realpathSync(existing);
  const probe = statSync(resolvedExisting).isDirectory() ? resolvedExisting : dirname(resolvedExisting);
  const result = Bun.spawnSync(["git", "-C", probe, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  const output = new TextDecoder().decode(result.stdout).trim();
  return output && isAbsolute(output) ? realpathSync(output) : undefined;
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function safeRepoPatch(patch: string, cwd: string): boolean {
  const paths = patchPaths(patch, cwd);
  if (!paths) return false;
  let expectedRoot: string | undefined;
  for (const path of paths) {
    const root = gitRootFor(path);
    const existing = nearestExistingPath(path);
    if (!root || !existing) return false;
    const canonicalTarget = resolve(realpathSync(existing), relative(existing, path));
    const relativeTarget = relative(root, canonicalTarget);
    if (!isWithin(root, canonicalTarget) || relativeTarget === ".git" || relativeTarget.startsWith(`.git${sep}`)) return false;
    if (expectedRoot && expectedRoot !== root) return false;
    expectedRoot = root;
  }
  return true;
}

async function main(): Promise<void> {
  let event: unknown;
  try {
    event = JSON.parse(await Bun.stdin.text());
  } catch {
    return;
  }
  if (!isJsonObject(event)) return;
  const hook = event as HookEvent;
  if (hook.hook_event_name !== "PermissionRequest" || typeof hook.tool_name !== "string") return;
  const command = commandFrom(hook.tool_input);
  if (!command) return;

  if (hook.tool_name === "Bash" && typeof hook.cwd === "string" && safeShellCommand(command, hook.cwd)) allow();
  else if (hook.tool_name === "apply_patch" && typeof hook.cwd === "string" && safeRepoPatch(command, hook.cwd)) allow();
}

await main();
