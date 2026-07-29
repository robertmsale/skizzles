import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { PackagingError } from "./packaging-error.ts";

export async function listFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new PackagingError(`${root} must be a directory.`);
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) throw new PackagingError(`${path} is an unsupported symlink.`);
      if (metadata.isDirectory()) await visit(absolutePath);
      else if (metadata.isFile()) files.push(path);
      else throw new PackagingError(`${path} is not a regular file or directory.`);
    }
  }

  await visit(root);
  return files;
}

export async function readJsonObject(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new PackagingError(`Unable to read ${label} at ${path}: ${String(error)}`);
  }
  if (!isObject(value)) throw new PackagingError(`${label} must contain a JSON object.`);
  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
