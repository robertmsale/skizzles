import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { listFiles } from "./file-tree.ts";

export async function compareTrees(
  expectedRoot: string,
  actualRoot: string,
): Promise<string[]> {
  const expectedFiles = await listFiles(expectedRoot);
  const actualFiles = await listFiles(actualRoot);
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const differences: string[] = [];

  for (const path of expectedFiles) {
    if (!actualSet.has(path)) {
      differences.push(`missing ${path}`);
      continue;
    }
    const [expected, actual] = await Promise.all([
      readFile(join(expectedRoot, path)),
      readFile(join(actualRoot, path)),
    ]);
    if (!expected.equals(actual)) differences.push(`changed ${path}`);
    const [expectedMetadata, actualMetadata] = await Promise.all([
      lstat(join(expectedRoot, path)),
      lstat(join(actualRoot, path)),
    ]);
    if ((expectedMetadata.mode & 0o777) !== (actualMetadata.mode & 0o777)) {
      differences.push(`changed mode ${path}`);
    }
  }

  for (const path of actualFiles) {
    if (!expectedSet.has(path)) differences.push(`unexpected ${path}`);
  }

  return differences;
}
