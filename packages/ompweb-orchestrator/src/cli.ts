#!/usr/bin/env bun

import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, OmpwebClient, OmpwebError } from "./client.ts";

type Environment = Record<string, string | undefined>;

interface GlobalOptions {
  baseUrl: string;
  password: string | undefined;
  cookie: string | undefined;
  timeoutMs: number;
  commandArgs: string[];
}

const USAGE = `ompctl [--base-url URL] [--password PASSWORD | --cookie COOKIE] sessions COMMAND

Commands:
  ompctl sessions list
  ompctl sessions create --cwd PATH [--message TEXT]
  ompctl sessions send ID --message TEXT
  ompctl sessions history ID [--include-state]
  ompctl sessions status ID

Configuration:
  OMPWEB_URL         Base URL (default: ${DEFAULT_BASE_URL})
  OMPWEB_PASSWORD    Password used to obtain an HTTP-only session cookie
  OMPWEB_COOKIE      Existing omp_web_session cookie value or Cookie header pair
  OMPWEB_TIMEOUT_MS  Request timeout from 1 through 300000 (default: ${DEFAULT_TIMEOUT_MS})

Global flags override environment variables. Prefer environment variables over
credential flags so secrets do not enter shell history or process listings.`;

export async function execute(
  argv: string[],
  env: Environment = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  if (argv.includes("--help") || argv.includes("-h")) return { help: USAGE };
  const options = parseGlobalOptions(argv, env);
  const [resource, command, ...args] = options.commandArgs;
  if (resource !== "sessions" || command === undefined) throw usageError();

  const client = new OmpwebClient({
    baseUrl: options.baseUrl,
    password: options.password,
    cookie: options.cookie,
    timeoutMs: options.timeoutMs,
    fetch: fetchImpl,
  });

  switch (command) {
    case "list":
      assertNoArgs(args);
      return client.listSessions();
    case "create": {
      const flags = parseCommandFlags(args, new Set(["--cwd", "--message"]));
      return client.createSession({
        cwd: requiredFlag(flags, "--cwd"),
        ...(flags.has("--message") ? { message: requiredFlag(flags, "--message") } : {}),
      });
    }
    case "send": {
      const { id, rest } = sessionId(args);
      const flags = parseCommandFlags(rest, new Set(["--message"]));
      return client.sendMessage(id, requiredFlag(flags, "--message"));
    }
    case "history": {
      const { id, rest } = sessionId(args);
      const flags = parseCommandFlags(rest, new Set(), new Set(["--include-state"]));
      return client.history(id, flags.has("--include-state"));
    }
    case "status": {
      const { id, rest } = sessionId(args);
      assertNoArgs(rest);
      return client.status(id);
    }
    default:
      throw usageError();
  }
}

export function parseGlobalOptions(argv: string[], env: Environment): GlobalOptions {
  const commandArgs: string[] = [];
  const values = new Map<string, string>();
  const globalFlags = new Set(["--base-url", "--password", "--cookie", "--timeout-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!globalFlags.has(arg)) {
      commandArgs.push(arg);
      continue;
    }
    if (values.has(arg)) throw new OmpwebError(`Duplicate option ${arg}`, { code: "duplicate_option" });
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new OmpwebError(`${arg} requires a value`, { code: "option_value_required" });
    }
    values.set(arg, value);
    index += 1;
  }

  const timeoutValue = values.get("--timeout-ms") ?? env.OMPWEB_TIMEOUT_MS;
  const timeoutMs = timeoutValue === undefined || timeoutValue === "" ? DEFAULT_TIMEOUT_MS : Number(timeoutValue);
  return {
    baseUrl: values.get("--base-url") ?? env.OMPWEB_URL ?? DEFAULT_BASE_URL,
    password: values.get("--password") ?? nonemptyEnv(env.OMPWEB_PASSWORD),
    cookie: values.get("--cookie") ?? nonemptyEnv(env.OMPWEB_COOKIE),
    timeoutMs,
    commandArgs,
  };
}

function parseCommandFlags(
  args: string[],
  valueFlags: Set<string>,
  booleanFlags = new Set<string>(),
): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (values.has(arg)) throw new OmpwebError(`Duplicate option ${arg}`, { code: "duplicate_option" });
    if (booleanFlags.has(arg)) {
      values.set(arg, true);
      continue;
    }
    if (!valueFlags.has(arg)) throw new OmpwebError(`Unknown option ${arg}`, { code: "unknown_option" });
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new OmpwebError(`${arg} requires a value`, { code: "option_value_required" });
    }
    values.set(arg, value);
    index += 1;
  }
  return values;
}

function requiredFlag(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string") throw new OmpwebError(`${name} is required`, { code: "option_required" });
  return value;
}

function sessionId(args: string[]): { id: string; rest: string[] } {
  const [id, ...rest] = args;
  if (id === undefined || id.startsWith("--")) {
    throw new OmpwebError("session ID is required", { code: "session_id_required" });
  }
  return { id, rest };
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new OmpwebError(`Unexpected argument ${args[0]}`, { code: "unexpected_argument" });
}

function nonemptyEnv(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function usageError(): OmpwebError {
  return new OmpwebError(USAGE, { code: "usage" });
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof OmpwebError) {
    return {
      error: error.message,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await execute(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(errorPayload(error))}\n`);
    process.exit(1);
  }
}
