import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import {
  assertDistributableName,
  assertDistributablePath,
} from "./distribution-policy.ts";
import { isNodeError } from "./file-tree.ts";
import { PackagingError } from "./packaging-error.ts";
import { TEMPLATE_PATH } from "./artifact-layout.ts";

const INSTALLER_PATH = "packages/skizzles-installer";
const CANONICAL_INPUTS = [
  ["skills", "skills"],
  ["hooks", "hooks"],
  ["scripts", "scripts"],
  ["runtime", "runtime"],
  ["integrations", "integrations"],
  ["assets", "assets"],
] as const;

export async function stageCanonicalInputs(
  repoRoot: string,
  destination: string,
): Promise<void> {
  await copyGitSelectedTree(repoRoot, TEMPLATE_PATH, destination, "plugin template");

  for (const [sourcePath, destinationPath] of CANONICAL_INPUTS) {
    const source = join(repoRoot, sourcePath);
    try {
      await lstat(source);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    await copyGitSelectedTree(
      repoRoot,
      sourcePath,
      join(destination, destinationPath),
      sourcePath,
    );
  }

  await copyCanonicalFile(
    join(repoRoot, INSTALLER_PATH, "package.json"),
    join(destination, INSTALLER_PATH, "package.json"),
    `${INSTALLER_PATH}/package.json`,
  );
  await copyGitSelectedTree(
    repoRoot,
    `${INSTALLER_PATH}/src`,
    join(destination, INSTALLER_PATH, "src"),
    `${INSTALLER_PATH}/src`,
  );
}

export async function copyGitSelectedTree(
  repoRoot: string,
  sourcePath: string,
  destinationRoot: string,
  label: string,
): Promise<void> {
  const sourceRoot = join(repoRoot, sourcePath);
  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory()) throw new PackagingError(`${label} must be a directory.`);
  await mkdir(destinationRoot, { recursive: true });

  const prefix = `${sourcePath}/`;
  for (const path of gitSelectedFiles(repoRoot, sourcePath)) {
    if (!path.startsWith(prefix)) {
      throw new PackagingError(`Git returned a path outside ${label}: ${path}.`);
    }
    const relativePath = path.slice(prefix.length);
    const source = join(repoRoot, path);
    const destination = join(destinationRoot, ...relativePath.split("/"));
    let sourceMetadata: Awaited<ReturnType<typeof lstat>>;
    try {
      sourceMetadata = await lstat(source);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    assertDistributablePath(relativePath, `${label}/${relativePath}`);
    if (sourceMetadata.isSymbolicLink()) {
      throw new PackagingError(
        `${label}/${relativePath} is a symlink; distributable inputs must be self-contained.`,
      );
    }
    if (!sourceMetadata.isFile()) {
      throw new PackagingError(`${label}/${relativePath} is not a regular file.`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, sourceMetadata.mode & 0o777);
  }
}

export async function copyCanonicalFile(
  source: string,
  destination: string,
  label: string,
): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PackagingError(`${label} must be a self-contained regular file.`);
  }
  assertDistributableName(source.split(sep).at(-1)!, label);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, metadata.mode & 0o777);
}

function gitSelectedFiles(repoRoot: string, sourcePath: string): string[] {
  const result = Bun.spawnSync([
    "git",
    "-C",
    repoRoot,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    sourcePath,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const details = result.stderr.toString("utf8").trim();
    throw new PackagingError(
      `Unable to enumerate Git-selected files for ${sourcePath}: ${details}`,
    );
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "")
    .sort((left, right) => left.localeCompare(right, "en"));
}
