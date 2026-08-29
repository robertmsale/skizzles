#!/usr/bin/env bun
import {
  AggregatorHttpClient,
  AggregatorHttpError,
  DEFAULT_AGGREGATOR_HTTP_URL,
  DEFAULT_AGGREGATOR_TOKEN_ENV,
  DEFAULT_HTTP_TIMEOUT_MS,
  type FetchLike,
} from "./http-client.ts";

const USAGE = `codex-app-server-ctl [global options] health
codex-app-server-ctl [global options] projects {list|add CWD|remove CWD}
codex-app-server-ctl [global options] threads list [filters]
codex-app-server-ctl [global options] threads start CWD [--params JSON]
codex-app-server-ctl [global options] threads read ID [--no-turns]
codex-app-server-ctl [global options] threads send ID (--message TEXT|--stdin) [--params JSON]
codex-app-server-ctl [global options] threads {archive|delete} ID
codex-app-server-ctl [global options] threads {fork|resume} ID [--params JSON]
codex-app-server-ctl [global options] threads interrupt ID --turn-id TURN_ID [--params JSON]
codex-app-server-ctl [global options] events list [--after N] [--stream ID] [--limit N]
codex-app-server-ctl [global options] requests list
codex-app-server-ctl [global options] requests respond ID (--result JSON|--error JSON)
codex-app-server-ctl [global options] requests {approve|approve-session|deny|cancel} ID

Global options:
  --url URL             REST origin (default: $SKIZZLES_AGGREGATOR_URL or ${DEFAULT_AGGREGATOR_HTTP_URL})
  --token-env NAME      Read bearer token from NAME (default: ${DEFAULT_AGGREGATOR_TOKEN_ENV})
  --timeout-ms N        Request timeout (default: ${DEFAULT_HTTP_TIMEOUT_MS})
  -h, --help            Show this help

Thread list filters:
  --cwd PATH            Exact host CWD filter (repeatable)
  --archived            List archived threads
  --limit N             Page size
  --cursor CURSOR       Pagination cursor
  --search TEXT         Preview/title search
  --sort-key KEY        created_at, updated_at, or recency_at
  --sort-direction DIR  asc or desc
  --parent ID           Direct parent filter
  --ancestor ID         Descendant filter`;

export type HttpCommand = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
};

export type HttpCliConfig = {
  baseUrl: string;
  tokenEnv: string;
  timeoutMs: number;
  command: HttpCommand;
};

export type HttpCliDependencies = {
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  readStdin?: () => Promise<string>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

export async function httpCliMain(argv: string[], dependencies: HttpCliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
  try {
    const global = extractGlobalOptions(argv);
    if (global.help) {
      stdout(`${USAGE}\n`);
      return 0;
    }
    const env = dependencies.env ?? process.env;
    const config = await parseHttpCliArgs(argv, {
      env,
      readStdin: dependencies.readStdin ?? readStdin,
    });
    const explicitTokenEnv = global.tokenEnv !== undefined;
    const token = env[config.tokenEnv]?.trim();
    if (explicitTokenEnv && !token) throw new Error(`bearer token environment variable is empty or unset: ${config.tokenEnv}`);
    const client = new AggregatorHttpClient({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(token ? { token } : {}),
    });
    const value = await client.request(config.command.method, config.command.path, config.command.body);
    stdout(`${JSON.stringify(value, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof AggregatorHttpError) {
      stderr(`${JSON.stringify({ status: error.status, body: error.body }, null, 2)}\n`);
    } else {
      stderr(`${JSON.stringify({
        error: {
          kind: "client_error",
          message: error instanceof Error ? error.message : String(error),
        },
      }, null, 2)}\n`);
    }
    return 1;
  }
}

export async function parseHttpCliArgs(
  argv: string[],
  dependencies: { env?: Record<string, string | undefined>; readStdin?: () => Promise<string> } = {},
): Promise<HttpCliConfig> {
  const env = dependencies.env ?? process.env;
  const global = extractGlobalOptions(argv);
  const baseUrl = global.url ?? (env.SKIZZLES_AGGREGATOR_URL?.trim() || DEFAULT_AGGREGATOR_HTTP_URL);
  const tokenEnv = global.tokenEnv ?? DEFAULT_AGGREGATOR_TOKEN_ENV;
  const timeoutMs = positiveInteger(global.timeoutMs ?? String(DEFAULT_HTTP_TIMEOUT_MS), "--timeout-ms");
  const command = await commandFor(global.args, dependencies.readStdin ?? readStdin);
  return { baseUrl, tokenEnv, timeoutMs, command };
}

async function commandFor(argv: string[], readInput: () => Promise<string>): Promise<HttpCommand> {
  const [group, action, ...args] = argv;
  if (group === "health" && action === undefined) return { method: "GET", path: "/healthz" };
  const parsed = parseCommandOptions(args);

  if (group === "projects" && action === "list") {
    exactPositionals(parsed, 0);
    assertOptions(parsed, []);
    return { method: "GET", path: "/v1/projects" };
  }
  if (group === "projects" && (action === "add" || action === "remove")) {
    exactPositionals(parsed, 1);
    assertOptions(parsed, []);
    const cwd = requiredPositional(parsed, 0, "project CWD");
    return action === "add"
      ? { method: "POST", path: "/v1/projects", body: { cwd } }
      : { method: "DELETE", path: `/v1/projects?cwd=${encodeURIComponent(cwd)}` };
  }
  if (group === "threads" && action === "list") {
    exactPositionals(parsed, 0);
    assertOptions(parsed, ["cwd", "archived", "limit", "cursor", "search", "sort-key", "sort-direction", "parent", "ancestor"]);
    return { method: "GET", path: `/v1/threads${threadListQuery(parsed)}` };
  }
  if (group === "threads" && action === "start") {
    exactPositionals(parsed, 1);
    assertOptions(parsed, ["params"]);
    return {
      method: "POST",
      path: "/v1/threads",
      body: { ...jsonObjectOption(parsed, "params"), cwd: requiredPositional(parsed, 0, "project CWD") },
    };
  }
  if (group === "threads" && action === "read") {
    exactPositionals(parsed, 1);
    assertOptions(parsed, ["no-turns"]);
    const id = encodeURIComponent(requiredPositional(parsed, 0, "thread ID"));
    return { method: "GET", path: `/v1/threads/${id}?includeTurns=${parsed.flags.has("no-turns") ? "false" : "true"}` };
  }
  if (group === "threads" && action === "send") {
    exactPositionals(parsed, 1);
    assertOptions(parsed, ["message", "stdin", "params"]);
    const hasMessage = parsed.options.has("message");
    const hasStdin = parsed.flags.has("stdin");
    if (hasMessage === hasStdin) throw new Error("threads send requires exactly one of --message or --stdin");
    const message = hasMessage ? requiredOption(parsed, "message") : stripOneTrailingNewline(await readInput());
    if (!message.trim()) throw new Error("thread message must not be empty");
    const id = encodeURIComponent(requiredPositional(parsed, 0, "thread ID"));
    return {
      method: "POST",
      path: `/v1/threads/${id}/turns`,
      body: {
        ...jsonObjectOption(parsed, "params"),
        input: [{ type: "text", text: message, text_elements: [] }],
      },
    };
  }
  if (group === "threads" && ["archive", "delete", "fork", "resume"].includes(action ?? "")) {
    exactPositionals(parsed, 1);
    assertOptions(parsed, action === "fork" || action === "resume" ? ["params"] : []);
    const id = encodeURIComponent(requiredPositional(parsed, 0, "thread ID"));
    if (action === "delete") return { method: "DELETE", path: `/v1/threads/${id}` };
    if (action === "archive") return { method: "POST", path: `/v1/threads/${id}/archive` };
    return { method: "POST", path: `/v1/threads/${id}/${action}`, body: jsonObjectOption(parsed, "params") };
  }
  if (group === "threads" && action === "interrupt") {
    exactPositionals(parsed, 1);
    assertOptions(parsed, ["turn-id", "params"]);
    const id = encodeURIComponent(requiredPositional(parsed, 0, "thread ID"));
    return {
      method: "POST",
      path: `/v1/threads/${id}/interrupt`,
      body: { ...jsonObjectOption(parsed, "params"), turnId: requiredOption(parsed, "turn-id") },
    };
  }
  if (group === "events" && action === "list") {
    exactPositionals(parsed, 0);
    assertOptions(parsed, ["after", "stream", "limit"]);
    const query = new URLSearchParams();
    copyOption(parsed, query, "after");
    copyOption(parsed, query, "stream");
    copyOption(parsed, query, "limit");
    return { method: "GET", path: `/v1/events${query.size ? `?${query}` : ""}` };
  }
  if (group === "requests" && action === "list") {
    exactPositionals(parsed, 0);
    assertOptions(parsed, []);
    return { method: "GET", path: "/v1/server-requests" };
  }
  if (group === "requests" && action === "respond") {
    exactPositionals(parsed, 1);
    assertOptions(parsed, ["result", "error"]);
    const hasResult = parsed.options.has("result");
    const hasError = parsed.options.has("error");
    if (hasResult === hasError) throw new Error("requests respond requires exactly one of --result or --error");
    const body = hasResult
      ? { result: jsonOption(parsed, "result") }
      : { error: jsonOption(parsed, "error") };
    return responseCommand(requiredPositional(parsed, 0, "server request ID"), body);
  }
  if (group === "requests" && ["approve", "approve-session", "deny", "cancel"].includes(action ?? "")) {
    exactPositionals(parsed, 1);
    assertOptions(parsed, []);
    const decision = action === "approve" ? "accept"
      : action === "approve-session" ? "acceptForSession"
      : action === "deny" ? "decline"
      : "cancel";
    return responseCommand(requiredPositional(parsed, 0, "server request ID"), { result: { decision } });
  }
  throw new Error(`Usage:\n  ${USAGE.replaceAll("\n", "\n  ")}`);
}

function responseCommand(id: string, body: unknown): HttpCommand {
  return {
    method: "POST",
    path: `/v1/server-requests/${encodeURIComponent(id)}/responses`,
    body,
  };
}

type ParsedCommandOptions = {
  positionals: string[];
  options: Map<string, string[]>;
  flags: Set<string>;
};

function parseCommandOptions(argv: string[]): ParsedCommandOptions {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  const booleanOptions = new Set(["archived", "no-turns", "stdin"]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (booleanOptions.has(name)) {
      flags.add(name);
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`missing value for --${name}`);
    options.set(name, [...options.get(name) ?? [], value]);
  }
  return { positionals, options, flags };
}

function extractGlobalOptions(argv: string[]): {
  args: string[];
  help: boolean;
  url?: string;
  tokenEnv?: string;
  timeoutMs?: string;
} {
  const values = new Map<string, string>();
  let help = false;
  let index = 0;
  while (index < argv.length) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      help = true;
      index++;
      continue;
    }
    if (!["--url", "--token-env", "--timeout-ms"].includes(argument)) break;
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${argument}`);
    values.set(argument, value);
    index += 2;
  }
  return {
    args: argv.slice(index),
    help,
    ...(values.has("--url") ? { url: values.get("--url")! } : {}),
    ...(values.has("--token-env") ? { tokenEnv: values.get("--token-env")! } : {}),
    ...(values.has("--timeout-ms") ? { timeoutMs: values.get("--timeout-ms")! } : {}),
  };
}

function threadListQuery(parsed: ParsedCommandOptions): string {
  const query = new URLSearchParams();
  for (const cwd of parsed.options.get("cwd") ?? []) query.append("cwd", cwd);
  if (parsed.flags.has("archived")) query.set("archived", "true");
  copyOption(parsed, query, "limit");
  copyOption(parsed, query, "cursor");
  copyOption(parsed, query, "search", "searchTerm");
  copyOption(parsed, query, "sort-key", "sortKey");
  copyOption(parsed, query, "sort-direction", "sortDirection");
  copyOption(parsed, query, "parent", "parentThreadId");
  copyOption(parsed, query, "ancestor", "ancestorThreadId");
  return query.size ? `?${query}` : "";
}

function copyOption(parsed: ParsedCommandOptions, query: URLSearchParams, option: string, key = option): void {
  const value = parsed.options.get(option)?.at(-1);
  if (value !== undefined) query.set(key, value);
}

function assertOptions(parsed: ParsedCommandOptions, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = [...parsed.options.keys(), ...parsed.flags].find((name) => !allowedSet.has(name));
  if (unexpected) throw new Error(`unknown option: --${unexpected}`);
}

function exactPositionals(parsed: ParsedCommandOptions, expected: number): void {
  if (parsed.positionals.length !== expected) throw new Error(`expected ${expected} positional argument${expected === 1 ? "" : "s"}`);
}

function requiredPositional(parsed: ParsedCommandOptions, index: number, label: string): string {
  const value = parsed.positionals[index]?.trim();
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function requiredOption(parsed: ParsedCommandOptions, name: string): string {
  const value = parsed.options.get(name)?.at(-1);
  if (value === undefined || !value.trim()) throw new Error(`missing required --${name}`);
  return value;
}

function jsonObjectOption(parsed: ParsedCommandOptions, name: string): Record<string, unknown> {
  if (!parsed.options.has(name)) return {};
  const value = jsonOption(parsed, name);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`--${name} must be a JSON object`);
  return value as Record<string, unknown>;
}

function jsonOption(parsed: ParsedCommandOptions, name: string): unknown {
  const raw = requiredOption(parsed, name);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`--${name} must be valid JSON`);
  }
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function stripOneTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

if (import.meta.main) process.exit(await httpCliMain(process.argv.slice(2)));
