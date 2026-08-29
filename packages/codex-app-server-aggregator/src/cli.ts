#!/usr/bin/env bun
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AggregatorDaemon, connectStdio } from "./daemon.ts";
import { DEFAULT_IMAGE, DockerBackendFactory } from "./docker.ts";
import { AggregatorState } from "./state.ts";

const DEFAULT_RUNTIME_DIRECTORY = join(tmpdir(), `skizzles-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
export const DEFAULT_SOCKET_PATH = join(DEFAULT_RUNTIME_DIRECTORY, "codex-app-server.sock");
export const DEFAULT_DATABASE_PATH = join(homedir(), ".local", "state", "skizzles", "codex-app-server.sqlite3");

const USAGE = `codex-app-server-aggregator serve [options]
codex-app-server-aggregator connect [--socket PATH]

serve runs one persistent app-server peer on a mode-0600 Unix socket.
connect relays headerless JSON-RPC JSONL between stdio and that socket.

Serve options:
  --socket PATH               Unix socket (default: ${DEFAULT_SOCKET_PATH})
  --database PATH             SQLite database (default: ${DEFAULT_DATABASE_PATH})
  --image IMAGE               Container image (default: ${DEFAULT_IMAGE})
  --codex-home-template DIR   Read-only seed copied to in-container CODEX_HOME
  --provider-command COMMAND  Trusted command started inside each container
  --provider-ready-url URL    Wait for this provider URL before app-server
  --pass-env NAME             Pass an auth/provider env var (repeatable)
  --docker PATH               Docker CLI path (default: docker)
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
};

export async function cliMain(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const options = parseArgs(argv);
  if (options.mode === "connect") return connectStdio(options.socketPath);

  const state = new AggregatorState(options.databasePath);
  const factory = new DockerBackendFactory(options);
  const daemon = new AggregatorDaemon({
    socketPath: options.socketPath,
    state,
    factory,
    removeOrphan: (machine) => factory.remove(machine.containerId),
    log: (message) => process.stderr.write(`${message}\n`),
  });
  await daemon.start();
  process.stderr.write(`codex-app-server aggregator listening on ${options.socketPath}\n`);
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
      "--image",
      "--codex-home-template",
      "--provider-command",
      "--provider-ready-url",
      "--docker",
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
  };
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
