#!/usr/bin/env bun
import { StringDecoder } from "node:string_decoder";
import { ContainerLabService, isRepositoryRelativeRunCwd } from "./service";
import { serializePublicJson } from "./public-json";
import { redactPublicText } from "./public-output";
import { resolveOwner, resolveRoots } from "./state";

export { serializePublicJson } from "./public-json";

class UsageError extends Error {}

type CliIO = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

const processIO: CliIO = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export async function cliMain(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  io: CliIO = processIO,
): Promise<number> {
  try {
    const global = parseGlobal(args);
    if (global.help) {
      io.stdout(`${JSON.stringify({ help: helpText() })}\n`);
      return 0;
    }
    const owner = resolveOwner(global.owner, environment);
    const service = new ContainerLabService(owner, resolveRoots(global), undefined, environment);
    const controller = new AbortController();
    let signalExit: number | undefined;
    const interrupt = () => { signalExit = 130; if (!controller.signal.aborted) controller.abort("SIGINT"); };
    const terminate = () => { signalExit = 143; if (!controller.signal.aborted) controller.abort("SIGTERM"); };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      if (global.rest[0] === "run") {
        const run = parseRun(global.rest.slice(1));
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        const exitCode = await service.run(run.lab, run.argv, run.cwd, run.environment, run.timeoutSeconds, {
          stdout: (chunk) => io.stdout(stdoutDecoder.write(chunk)),
          stderr: (chunk) => io.stderr(stderrDecoder.write(chunk)),
          stdin: process.stdin,
        }, controller.signal);
        const stdoutTail = stdoutDecoder.end();
        const stderrTail = stderrDecoder.end();
        if (stdoutTail) io.stdout(stdoutTail);
        if (stderrTail) io.stderr(stderrTail);
        return exitCode;
      }
      const result = await dispatch(service, global.rest, controller.signal);
      writePublicJson(io, result);
      return signalExit ?? 0;
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    }
  } catch (error) {
    const usage = error instanceof UsageError;
    io.stderr(`${JSON.stringify({
      error: {
        code: usage ? "USAGE" : "OPERATION_FAILED",
        message: boundedError(error),
      },
    })}\n`);
    return usage ? 2 : 1;
  }
}

async function dispatch(service: ContainerLabService, args: string[], signal?: AbortSignal): Promise<unknown> {
  const [noun, verb, ...rest] = args;
  if (!noun) throw new UsageError("a command is required; use --help");
  if (noun === "health") {
    requireNoArgs([verb, ...rest].filter((value): value is string => value !== undefined));
    return await service.health();
  }
  if (noun === "lab") {
    if (verb === "create") {
      const flags = parseFlags(rest, new Set(["--name", "--source"]));
      return await service.createLab(flags.one("--name") ?? "lab", flags.one("--source") ?? process.cwd(), signal);
    }
    if (verb === "list") {
      requireNoArgs(rest);
      return await service.listLabs();
    }
    if (verb === "status") {
      const flags = parseFlags(rest, new Set(["--lab"]));
      return await service.labStatus(flags.required("--lab"));
    }
    if (verb === "destroy") {
      const flags = parseFlags(rest, new Set(["--lab"]));
      return await service.destroyLab(flags.required("--lab"));
    }
    if (verb === "destroy-all") {
      requireNoArgs(rest);
      return await service.destroyAll();
    }
    throw new UsageError("lab requires create, list, status, destroy, or destroy-all");
  }
  if (noun === "logs") {
    const remaining = verb === undefined ? rest : [verb, ...rest];
    const flags = parseFlags(remaining, new Set(["--lab", "--service", "--tail-lines"]));
    return await service.logs(
      flags.required("--lab"),
      flags.required("--service"),
      integerFlag(flags.one("--tail-lines"), "--tail-lines", 100),
    );
  }
  if (noun === "sync") {
    if (verb === "preview") {
      const flags = parseFlags(rest, new Set(["--lab", "--direction"]));
      return await service.preview(flags.required("--lab"), direction(flags.required("--direction")));
    }
    if (verb === "apply") {
      const flags = parseFlags(rest, new Set(["--lab", "--direction", "--token"]));
      return await service.apply(
        flags.required("--lab"),
        direction(flags.required("--direction")),
        flags.required("--token"),
      );
    }
    throw new UsageError("sync requires preview or apply");
  }
  throw new UsageError(`unknown command: ${noun}`);
}

function parseGlobal(args: string[]): {
  owner?: string;
  stateRoot?: string;
  runtimeRoot?: string;
  help: boolean;
  rest: string[];
} {
  const parsed: { owner?: string; stateRoot?: string; runtimeRoot?: string; help: boolean; rest: string[] } = {
    help: false,
    rest: [],
  };
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--owner") parsed.owner = requiredValue(args, ++index, arg);
    else if (arg === "--state-root") parsed.stateRoot = requiredValue(args, ++index, arg);
    else if (arg === "--runtime-root") parsed.runtimeRoot = requiredValue(args, ++index, arg);
    else break;
  }
  parsed.rest = args.slice(index);
  return parsed;
}

function parseFlags(args: string[], allowed: Set<string>, repeatable = new Set<string>()) {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (!allowed.has(flag)) throw new UsageError(`unknown argument: ${flag}`);
    const value = requiredValue(args, ++index, flag);
    const existing = values.get(flag) ?? [];
    if (existing.length && !repeatable.has(flag)) throw new UsageError(`${flag} may be provided only once`);
    existing.push(value);
    values.set(flag, existing);
  }
  return {
    one: (flag: string) => values.get(flag)?.[0],
    many: (flag: string) => values.get(flag) ?? [],
    required: (flag: string) => {
      const value = values.get(flag)?.[0];
      if (value === undefined) throw new UsageError(`${flag} is required`);
      return value;
    },
  };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} requires a value`);
  return value;
}

function requireNoArgs(args: string[]): void {
  if (args.length) throw new UsageError(`unexpected argument: ${args[0]}`);
}

function parseEnvironment(value: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator < 1) throw new UsageError("--env must be KEY=VALUE");
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function parseRun(args: string[]): {
  lab: string;
  cwd: string;
  environment: Record<string, string>;
  timeoutSeconds: number;
  argv: string[];
} {
  const separator = args.indexOf("--");
  if (separator < 0) throw new UsageError("run requires -- before the command argv");
  const flags = parseFlags(args.slice(0, separator), new Set(["--lab", "--cwd", "--env", "--timeout-seconds"]), new Set(["--env"]));
  const argv = args.slice(separator + 1);
  if (argv.length === 0) throw new UsageError("run requires a command after --");
  const cwd = flags.one("--cwd") ?? ".";
  if (!isRepositoryRelativeRunCwd(cwd)) {
    throw new UsageError("run --cwd must be a repository-relative workspace path, never an absolute container path");
  }
  return {
    lab: flags.required("--lab"),
    cwd,
    environment: Object.fromEntries(flags.many("--env").map(parseEnvironment)),
    timeoutSeconds: integerFlag(flags.one("--timeout-seconds"), "--timeout-seconds", 1800),
    argv,
  };
}

function integerFlag(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new UsageError(`${flag} must be an integer`);
  return Number(value);
}

function direction(value: string): "push" | "pull" {
  if (value !== "push" && value !== "pull") throw new UsageError("--direction must be push or pull");
  return value;
}

function boundedError(error: unknown): string {
  return redactPublicText(error instanceof Error ? error.message : String(error), 4_000, 8);
}

function writePublicJson(io: CliIO, value: unknown): void {
  const encoded = serializePublicJson(value);
  io.stdout(encoded);
}

function helpText(): string {
  return [
    "codex-container-lab [--owner THREAD_ID] [--state-root PATH] [--runtime-root PATH] COMMAND",
    "health",
    "lab create [--name NAME] [--source PATH]",
    "lab list | lab status --lab ID | lab destroy --lab ID | lab destroy-all",
    "run --lab ID [--cwd REPO_RELATIVE_PATH] [--env KEY=VALUE] [--timeout-seconds N] -- COMMAND...",
    "  --cwd is relative to the repository workspace root (default: .); never pass /workspace or another absolute container path",
    "  example: run --lab ID --cwd packages/api -- bun test",
    "logs --lab ID --service SERVICE [--tail-lines N]",
    "sync preview --lab ID --direction push|pull",
    "sync apply --lab ID --direction push|pull --token TOKEN",
  ].join("\n");
}

if (import.meta.main) process.exit(await cliMain());
