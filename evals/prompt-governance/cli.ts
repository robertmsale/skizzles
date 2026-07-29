import { resolve } from "node:path";
import { requireAbsolutePath, resolveRealPath } from "./fs";
import { reviewPilot, runCalibration, runPilot } from "./runner";

const repositoryRoot = resolve(import.meta.dir, "../..");

if (import.meta.main) {
  try {
    const output = await main(process.argv.slice(2));
    console.log(output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

export async function main(args: readonly string[]): Promise<string> {
  const [command, artifactArgument, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    return usage();
  }
  if (!artifactArgument) throw new Error(`${command} requires an absolute artifact root`);
  const artifactRoot = await resolveRealPath(requireAbsolutePath(artifactArgument, "artifact root"));
  const realRepositoryRoot = await resolveRealPath(repositoryRoot);
  assertArtifactRootOutsideRepository(artifactRoot, realRepositoryRoot);
  const codexBinary = optionValue(rest, "--codex-binary");
  if (command === "calibrate") {
    rejectUnknown(rest, ["--codex-binary"]);
    return runCalibration(repositoryRoot, artifactRoot, codexBinary);
  }
  if (command === "pilot") {
    const execute = rest.includes("--execute") || rest.includes("execute=true");
    const repetitionsText = optionValue(rest, "--repetitions") ?? "3";
    const repetitions = Number(repetitionsText);
    const confirmRunsText = optionValue(rest, "--confirm-runs");
    const confirmRuns = confirmRunsText === undefined ? undefined : Number(confirmRunsText);
    rejectUnknown(rest, ["--execute", "execute=true", "--repetitions", "--confirm-runs", "--codex-binary"]);
    return runPilot({
      repositoryRoot,
      artifactRoot,
      execute,
      repetitions,
      ...(confirmRuns === undefined ? {} : { confirmRuns }),
      ...(codexBinary ? { codexBinary } : {}),
    });
  }
  if (command === "review") {
    rejectUnknown(rest, []);
    return reviewPilot(artifactRoot);
  }
  throw new Error(`Unknown prompt evaluation command: ${command}`);
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    const prefix = `${name}=`;
    const inline = args.find((value) => value.startsWith(prefix));
    return inline?.slice(prefix.length);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function rejectUnknown(args: readonly string[], accepted: readonly string[]): void {
  const values = new Set(accepted);
  for (const argument of args) {
    if (argument.startsWith("--") && !values.has(argument) && !accepted.some((name) => argument.startsWith(`${name}=`))) {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
}

function assertArtifactRootOutsideRepository(artifactRoot: string, realRepositoryRoot: string): void {
  const root = `${realRepositoryRoot}/`;
  if (artifactRoot === realRepositoryRoot || artifactRoot.startsWith(root)) {
    throw new Error(`artifact root must be outside the product checkout: ${artifactRoot}`);
  }
}

function usage(): string {
  return [
    "Usage:",
    "  bun evals/prompt-governance/cli.ts calibrate <absolute-artifact-root>",
    "  bun evals/prompt-governance/cli.ts pilot <absolute-artifact-root> [--execute --confirm-runs 24] [--repetitions N]",
    "  bun evals/prompt-governance/cli.ts review <absolute-artifact-root>",
    "",
    "pilot is dry-run by default; --execute is required to start Codex processes.",
  ].join("\n");
}
