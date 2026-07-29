import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { copyCanonicalFile } from "./canonical-inputs.ts";
import { exists, isNodeError, isObject, listFiles, readJsonObject } from "./file-tree.ts";
import { PackagingError } from "./packaging-error.ts";

const SOURCE_PATH = "packages/skizzles-container-lab";
const PROVENANCE = "a2f44416ef467d9f54b3cb228e3bd050987a3c4c";
const LAUNCHER = "skills/codex-container-lab/scripts/codex-container-lab";
const ENTRYPOINTS = ["src/cli.ts", "src/reaper-cli.ts"] as const;
const STATIC_INPUTS = [
  "LICENSE",
  "install/com.openai.codex-container-lab-reaper.plist",
  "docs/architecture.md",
  "docs/completion-contract.md",
  "docs/installation.md",
  "docs/manifest.md",
  "docs/safety.md",
  "run-contract.ts",
  "src/contracts/run.ts",
] as const;

export async function stageContainerLabRuntime(
  repoRoot: string,
  pluginRoot: string,
): Promise<void> {
  const sourceRoot = join(repoRoot, SOURCE_PATH);
  const destinationRoot = join(pluginRoot, SOURCE_PATH);
  const bundleRoot = join(destinationRoot, "src");
  await mkdir(bundleRoot, { recursive: true });

  for (const path of ENTRYPOINTS) {
    const destination = join(bundleRoot, path.split("/").at(-1)!);
    const build = Bun.spawnSync([
      process.execPath,
      "build",
      join(SOURCE_PATH, path),
      "--target=bun",
      "--format=esm",
      `--outfile=${destination}`,
    ], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (build.exitCode !== 0) {
      const details = Buffer.concat([
        Buffer.from(build.stdout),
        Buffer.from(build.stderr),
      ]).toString("utf8").trim();
      throw new PackagingError(`Unable to bundle Container Lab runtime ${path}:\n${details}`);
    }
  }

  const bundledFiles = await listFiles(bundleRoot);
  const expectedFiles = ENTRYPOINTS.map((path) => path.split("/").at(-1)!);
  if (
    bundledFiles.length !== expectedFiles.length ||
    expectedFiles.some((path) => !bundledFiles.includes(path))
  ) {
    throw new PackagingError(
      `Container Lab bundling produced unexpected files: ${bundledFiles.join(", ")}.`,
    );
  }
  await Promise.all(expectedFiles.map((path) => chmod(join(bundleRoot, path), 0o755)));

  for (const path of STATIC_INPUTS) {
    await copyCanonicalFile(
      join(sourceRoot, path),
      join(destinationRoot, path),
      `${SOURCE_PATH}/${path}`,
    );
  }
}

export async function validateContainerLabRuntime(pluginRoot: string): Promise<void> {
  const runtimeRoot = join(pluginRoot, SOURCE_PATH);
  for (const path of ENTRYPOINTS) {
    const bundledPath = join(runtimeRoot, path);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(bundledPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new PackagingError(`Container Lab runtime is missing ${path}.`);
      }
      throw error;
    }
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new PackagingError(
        `Container Lab runtime ${path} must be an executable regular file.`,
      );
    }
  }
}

export async function validateContainerLabDescriptor(
  repoRoot: string,
  pluginRoot: string,
): Promise<void> {
  const descriptor = await readJsonObject(
    join(repoRoot, "integrations/container-lab.json"),
    "Container Lab descriptor",
  );
  const packageMetadata = await readJsonObject(
    join(repoRoot, SOURCE_PATH, "package.json"),
    "Container Lab package metadata",
  );
  const bundled = descriptor.bundled;
  const ownership = descriptor.ownership;
  const expectedDocumentation = STATIC_INPUTS
    .filter((path) => path.startsWith("docs/"))
    .map((path) => `${SOURCE_PATH}/${path}`);
  const expected = {
    operationalEntrypoint: `${SOURCE_PATH}/src/cli.ts`,
    reaperEntrypoint: `${SOURCE_PATH}/src/reaper-cli.ts`,
    launcher: LAUNCHER,
    launchAgentTemplate: `${SOURCE_PATH}/install/com.openai.codex-container-lab-reaper.plist`,
  };

  if (
    descriptor.configuredRuntime !== packageMetadata.version ||
    !isObject(ownership) ||
    ownership.runtimeOwner !== "skizzles" ||
    ownership.canonicalSource !== SOURCE_PATH ||
    ownership.provenanceCommit !== PROVENANCE ||
    !isObject(bundled) ||
    Object.entries(expected).some(([key, value]) => bundled[key] !== value) ||
    !Array.isArray(bundled.documentation) ||
    !sameStrings(bundled.documentation, expectedDocumentation)
  ) {
    throw new PackagingError(
      "Container Lab descriptor must match the canonical package metadata and staged plugin inputs.",
    );
  }

  for (const path of [
    expected.operationalEntrypoint,
    expected.reaperEntrypoint,
    expected.launcher,
    expected.launchAgentTemplate,
    ...expectedDocumentation,
  ]) {
    if (!(await exists(join(repoRoot, path))) || !(await exists(join(pluginRoot, path)))) {
      throw new PackagingError(
        `Container Lab descriptor path is not a canonical and staged input: ${path}.`,
      );
    }
  }
}

function sameStrings(actual: unknown[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}
