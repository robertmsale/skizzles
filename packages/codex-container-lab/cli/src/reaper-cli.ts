#!/usr/bin/env bun
import { join } from "node:path";
import { homedir } from "node:os";
import { reapArchivedOwners, type ReaperResult } from "./archive-reaper";
import { redactPublicText } from "./public-output";
import { resolveRoots } from "./state";

export const REAPER_OUTPUT_MAX_BYTES = 1_536;

export type ReaperCliOutput = {
  ok: boolean;
  cleaned: number;
  retained: number;
  issues?: string[];
};

export async function reaperMain(args = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if (parsed.help) {
      writeOutput({ help: reaperHelp() });
      return 0;
    }
    const result = await reapArchivedOwners({
      dbPath: parsed.dbPath ?? join(homedir(), ".codex", "state_5.sqlite"),
      roots: resolveRoots({ stateRoot: parsed.stateRoot, runtimeRoot: parsed.runtimeRoot }),
    });
    const output = reaperOutput(result);
    if (output) writeOutput(output);
    return result.ok ? 0 : 1;
  } catch (error) {
    writeError("USAGE", error);
    return 2;
  }
}

/**
 * Converts internal reaper state to the deliberately small public CLI contract.
 * Owner identifiers and internal paths must never cross this boundary.
 */
export function reaperOutput(result: ReaperResult): ReaperCliOutput | undefined {
  const exceptionalRetentions = result.retainedOwners.filter((item) => item.reason !== "thread is active");
  if (result.ok && result.archivedOwnersCleaned.length === 0 && result.errors.length === 0 &&
      exceptionalRetentions.length === 0) return undefined;

  const issues = distinctBounded([
    ...exceptionalRetentions.map((item) => `retained: ${item.reason}`),
    ...result.errors.map((error) => `error: ${error}`),
  ]);
  return {
    ok: result.ok,
    cleaned: result.archivedOwnersCleaned.length,
    retained: result.retainedOwners.length,
    ...(issues.length > 0 ? { issues } : {}),
  };
}

function writeError(code: "USAGE", error: unknown): void {
  writeOutput({ error: { code, message: boundedRedacted(error instanceof Error ? error.message : String(error), 240) } }, process.stderr);
}

function writeOutput(value: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  let serialized = JSON.stringify(value);
  if (Buffer.byteLength(`${serialized}\n`, "utf8") > REAPER_OUTPUT_MAX_BYTES) {
    serialized = JSON.stringify({ ok: false, cleaned: 0, retained: 0, issues: ["details truncated"] });
  }
  stream.write(`${serialized}\n`);
}

function distinctBounded(items: string[]): string[] {
  const details: string[] = [];
  for (const item of items) {
    const detail = boundedRedacted(item, 160);
    if (detail.length > 0 && !details.includes(detail)) details.push(detail);
    if (details.length === 6) break;
  }
  return details;
}

function boundedRedacted(value: string, maxBytes: number): string {
  return redactPublicText(value, maxBytes, 6);
}

function parseArgs(args: string[]): { dbPath?: string; stateRoot?: string; runtimeRoot?: string; help: boolean } {
  const parsed: { dbPath?: string; stateRoot?: string; runtimeRoot?: string; help: boolean } = { help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--db") parsed.dbPath = requiredValue(args, ++index, arg);
    else if (arg === "--state-root") parsed.stateRoot = requiredValue(args, ++index, arg);
    else if (arg === "--runtime-root") parsed.runtimeRoot = requiredValue(args, ++index, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function reaperHelp(): string {
  return "codex-container-lab-reaper [--db PATH] [--state-root PATH] [--runtime-root PATH]";
}

if (import.meta.main) process.exit(await reaperMain());
