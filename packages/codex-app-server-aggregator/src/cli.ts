#!/usr/bin/env bun
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AggregatorDaemon, connectStdio } from "./daemon.ts";
import { DEFAULT_IMAGE, DockerBackendFactory, type HostGatewayMode } from "./docker.ts";
import { CodexHostBackendFactory } from "./host.ts";
import { AggregatorState } from "./state.ts";

const DEFAULT_RUNTIME_DIRECTORY = join(tmpdir(), `skizzles-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
export const DEFAULT_SOCKET_PATH = join(DEFAULT_RUNTIME_DIRECTORY, "codex-app-server.sock");
export const DEFAULT_DATABASE_PATH = join(homedir(), ".local", "state", "skizzles", "codex-app-server.sqlite3");
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 8788;

const USAGE = `codex-app-server-aggregator serve [options]
codex-app-server-aggregator connect [--socket PATH]

serve runs one persistent app-server peer on a mode-0600 Unix socket.
connect relays headerless JSON-RPC JSONL between stdio and that socket.
serve also exposes versioned REST resources for one-off HTTP clients.

Serve options:
  --socket PATH               Unix socket (default: ${DEFAULT_SOCKET_PATH})
  --database PATH             SQLite database (default: ${DEFAULT_DATABASE_PATH})
  --http-host HOST            REST bind host (default: ${DEFAULT_HTTP_HOST})
  --http-port PORT            REST port, or 0 for an ephemeral port (default: ${DEFAULT_HTTP_PORT})
  --http-token-env NAME       Read the REST bearer token from this environment variable
  --image IMAGE               Container image (default: ${DEFAULT_IMAGE})
  --codex-home-template DIR   Read-only seed copied to in-container CODEX_HOME
  --provider-command COMMAND  Trusted command started inside each container
  --provider-ready-url URL    Wait for this provider URL before app-server
  --pass-env NAME             Pass an auth/provider env var (repeatable)
  --docker PATH               Docker CLI path (default: docker)
  --host-codex PATH           Host Codex-compatible CLI (default: codex)
  --container-host HOST       Host name visible inside containers (default: host.docker.internal)
  --host-gateway-mode MODE    auto, native, or host-gateway (default: auto)
  -h, --help                  Show this help`;

export type CliOptions = {
  mode: "connect";
  socketPath: string;
} | {
  mode: "serve";
  socketPath: string;
  databasePath: string;
  image: string;
  codexHomeTemplate: string | undefined;
  providerCommand: string | undefined;
  providerReadyUrl: string | undefined;
  passEnv: string[];
  dockerBinary: string;
  hostCodexBinary: string;
  containerHost: string;
  hostGatewayMode: HostGatewayMode;
  httpHost: string;
  httpPort: number;
  httpTokenEnv: string | undefined;
};

export async function cliMain(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const options = parseArgs(argv);
  if (options.mode === "connect") return connectStdio(options.socketPath);

  const state = new AggregatorState(options.databasePath);
  const containerFactory = new DockerBackendFactory(options);
  const hostFactory = new CodexHostBackendFactory({ codexBinary: options.hostCodexBinary });
  const daemon = new AggregatorDaemon({
    socketPath: options.socketPath,
    state,
    containerFactory,
    hostFactory,
    removeOrphan: (machine) => containerFactory.remove(machine.containerId!),
    inspectContainer: (containerId) => containerFactory.inspect(containerId),
    http: {
      hostname: options.httpHost,
      port: options.httpPort,
      staticDirectory: resolve(dirname(fileURLToPath(import.meta.url)), "../dist"),
      ...resolveHttpToken(options.httpTokenEnv),
    },
    log: (message) => process.stderr.write(`${message}\n`),
  });
  await daemon.start();
  process.stderr.write(`codex-app-server aggregator listening on ${options.socketPath}\n`);
  process.stderr.write(`codex-app-server REST API listening on ${daemon.httpUrl?.origin}\n`);
  await waitForShutdownSignal();
  await daemon.close();
  return 0;
}

export function parseArgs(argv: string[]): CliOptions {
  const [mode, ...args] = argv;
  if (mode !== "serve" && mode !== "connect") throw new Error("expected serve or connect");
  const passEnv: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!flag.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`invalid argument: ${flag}`);
    if (flag === "--pass-env") passEnv.push(value);
    else if ([
      "--socket",
      "--database",
      "--http-host",
      "--http-port",
      "--http-token-env",
      "--image",
      "--codex-home-template",
      "--provider-command",
      "--provider-ready-url",
      "--docker",
      "--host-codex",
      "--container-host",
      "--host-gateway-mode",
    ].includes(flag)) values.set(flag, value);
    else throw new Error(`unknown option: ${flag}`);
    index++;
  }
  const socketPath = resolve(values.get("--socket") ?? DEFAULT_SOCKET_PATH);
  if (mode === "connect") {
    const invalid = [...values.keys()].filter((key) => key !== "--socket");
    if (invalid.length || passEnv.length) throw new Error("connect accepts only --socket");
    return { mode, socketPath };
  }
  return {
    mode,
    socketPath,
    databasePath: resolve(values.get("--database") ?? DEFAULT_DATABASE_PATH),
    image: values.get("--image") ?? DEFAULT_IMAGE,
    codexHomeTemplate: values.get("--codex-home-template"),
    providerCommand: values.get("--provider-command"),
    providerReadyUrl: values.get("--provider-ready-url"),
    passEnv,
    dockerBinary: values.get("--docker") ?? "docker",
    hostCodexBinary: values.get("--host-codex") ?? "codex",
    containerHost: values.get("--container-host") ?? "host.docker.internal",
    hostGatewayMode: parseHostGatewayMode(values.get("--host-gateway-mode") ?? "auto"),
    httpHost: values.get("--http-host") ?? DEFAULT_HTTP_HOST,
    httpPort: parsePort(values.get("--http-port") ?? String(DEFAULT_HTTP_PORT)),
    httpTokenEnv: values.get("--http-token-env"),
  };
}

function parseHostGatewayMode(value: string): HostGatewayMode {
  if (value === "auto" || value === "native" || value === "host-gateway") return value;
  throw new Error("--host-gateway-mode must be auto, native, or host-gateway");
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("--http-port must be an integer from 0 through 65535");
  return port;
}

function resolveHttpToken(name: string | undefined): { token?: string } {
  if (!name) return {};
  const token = process.env[name];
  if (!token) throw new Error(`REST bearer token environment variable is empty or unset: ${name}`);
  return { token };
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolveSignal();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

if (import.meta.main) {
  try {
    process.exit(await cliMain(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
