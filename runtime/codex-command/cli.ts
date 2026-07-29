import {
  printRunStatus,
  printRunTail,
  searchRunOutput,
} from "./query-output.ts";
import { runManagedCommand } from "./run-command.ts";

export async function runCommandLine(arguments_: string[]): Promise<void> {
  try {
    const [subcommand, ...subcommandArguments] = arguments_;
    if (subcommand === "run") {
      if (subcommandArguments.length !== 2 || subcommandArguments[0] !== "--json") usage();
      process.exit(await runManagedCommand(decodeScript(subcommandArguments[1]!)));
    }
    if (subcommand === "status" && subcommandArguments.length === 1) {
      printRunStatus(subcommandArguments[0]!);
    } else if (
      subcommand === "tail"
      && (subcommandArguments.length === 1 || subcommandArguments.length === 2)
    ) {
      printRunTail(subcommandArguments[0]!, subcommandArguments[1]);
    } else if (subcommand === "errors" && subcommandArguments.length === 1) {
      printRunTail(subcommandArguments[0]!, "stderr");
    } else if (
      subcommand === "search"
      && (subcommandArguments.length === 1 || subcommandArguments.length === 2)
    ) {
      searchRunOutput(subcommandArguments[0]!, subcommandArguments[1]);
    } else {
      usage();
    }
  } catch (error) {
    console.error(
      `[codex-command] ${error instanceof Error ? error.message : "unexpected failure"}`,
    );
    process.exit(64);
  }
}

function usage(): never {
  console.error(
    "usage: codex-command run --json <script-json> | status <run-id> | tail <run-id> [stdout|stderr] | errors <run-id> | search <text> [run-id]",
  );
  process.exit(64);
}

function decodeScript(value: string): string {
  let result: unknown;
  try {
    result = JSON.parse(value);
  } catch {
    throw new Error("script is not valid JSON");
  }
  if (typeof result !== "string" || !result || JSON.stringify(result) !== value) {
    throw new Error("script JSON must be a canonical non-empty string");
  }
  return result;
}
