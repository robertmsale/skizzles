#!/usr/bin/env bun
import { childArgsFromArgv, resolveCursorAgent } from "./resolve-agent.ts";
import { DEFAULT_MAX_RETRIES, runSupervisor } from "./supervisor.ts";

const USAGE = `t3-cursor-acp [acp ...]
Supervisor in front of cursor-agent acp. Accepts the same argv T3 already launches.
Set T3 Cursor Binary path to this command; T3 still passes acp. The shim execs the
real cursor-agent from a resolved path (T3_CURSOR_ACP_BIN or the versioned install),
never through a PATH loop back to itself.`;

export async function cliMain(argv: string[], env = process.env): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const childArgs = childArgsFromArgv(argv);
  const childCommand = resolveCursorAgent({ env, argv0: process.argv[1] });
  const retries = parseRetries(env.T3_CURSOR_ACP_MAX_RETRIES);
  return runSupervisor({
    childCommand,
    childArgs,
    io: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
    maxRetries: retries,
  });
}

export const MAX_RETRY_OVERRIDE = DEFAULT_MAX_RETRIES;

export function parseRetries(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_MAX_RETRIES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_RETRY_OVERRIDE) {
    throw new Error(`T3_CURSOR_ACP_MAX_RETRIES must be an integer from 0 through ${MAX_RETRY_OVERRIDE}`);
  }
  return parsed;
}

if (import.meta.main) {
  try {
    process.exit(await cliMain(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
