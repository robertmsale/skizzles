#!/usr/bin/env bun
import { AppServerAggregator } from "./aggregator.ts";
import { DEFAULT_IMAGE, DockerBackendFactory } from "./docker.ts";
import { readJsonLines, SerialMessageSink } from "./jsonl.ts";

const USAGE = `codex-app-server-aggregator --repo URL [options]

Headerless JSON-RPC 2.0 over stdio, matching codex app-server JSONL framing.

Options:
  --repo URL                  Repository cloned inside every container (required)
  --ref REF                   Git ref checked out after clone
  --image IMAGE               Container image (default: ${DEFAULT_IMAGE})
  --codex-home-template DIR   Read-only seed copied to in-container CODEX_HOME
  --provider-command COMMAND  Trusted command started inside each container
  --provider-ready-url URL    Wait for this provider URL before app-server
  --pass-env NAME             Pass an auth/provider env var (repeatable)
  --docker PATH               Docker CLI path (default: docker)
  -h, --help                  Show this help`;

type CliOptions = {
  repoUrl: string;
  repoRef: string | undefined;
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
  const sink = new SerialMessageSink((line) => new Promise<void>((resolve, reject) => {
    process.stdout.write(line, (error) => error ? reject(error) : resolve());
  }));
  const aggregator = new AppServerAggregator({
    factory: new DockerBackendFactory(options),
    output: sink,
    log: (message) => process.stderr.write(`${message}\n`),
  });
  const active = new Set<Promise<void>>();
  try {
    for await (const message of readJsonLines(Bun.stdin.stream())) {
      const work = aggregator.handle(message).catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      }).finally(() => active.delete(work));
      active.add(work);
    }
    await Promise.allSettled(active);
    return 0;
  } finally {
    await aggregator.close();
  }
}

export function parseArgs(argv: string[]): CliOptions {
  const passEnv: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`invalid argument: ${flag}`);
    if (flag === "--pass-env") passEnv.push(value);
    else if (["--repo", "--ref", "--image", "--codex-home-template", "--provider-command", "--provider-ready-url", "--docker"].includes(flag)) values.set(flag, value);
    else throw new Error(`unknown option: ${flag}`);
    index++;
  }
  const repoUrl = values.get("--repo");
  if (!repoUrl) throw new Error("--repo is required");
  return {
    repoUrl,
    repoRef: values.get("--ref"),
    image: values.get("--image") ?? DEFAULT_IMAGE,
    codexHomeTemplate: values.get("--codex-home-template"),
    providerCommand: values.get("--provider-command"),
    providerReadyUrl: values.get("--provider-ready-url"),
    passEnv,
    dockerBinary: values.get("--docker") ?? "docker",
  };
}

if (import.meta.main) {
  try {
    process.exit(await cliMain(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
