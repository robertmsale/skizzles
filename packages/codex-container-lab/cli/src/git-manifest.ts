import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { canonicalRoot, describeSyncFile, guardedPath, safeRelativePath, sha256, type SyncFile } from "./files";

const execFileAsync = promisify(execFile);

export interface GitManifest {
  root: string;
  digest: string;
  files: Record<string, SyncFile>;
}

const MAX_SYNC_FILES = 20_000;
const MAX_SYNC_TOTAL_BYTES = 512 * 1024 * 1024;

export async function eligibleGitPaths(root: string): Promise<string[]> {
  const canonical = await canonicalRoot(root);
  const { stdout } = await execFileAsync(
    "git",
    ["-C", canonical, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  const values = stdout.toString("utf8").split("\0").filter(Boolean).map(safeRelativePath);
  const unique = [...new Set(values)].sort((a, b) => a.localeCompare(b));
  if (unique.length > MAX_SYNC_FILES) throw new Error(`Git workspace exceeds ${MAX_SYNC_FILES} synchronized paths`);
  return unique;
}

export async function buildGitManifest(root: string): Promise<GitManifest> {
  const canonical = await canonicalRoot(root);
  const files: Record<string, SyncFile> = {};
  let totalBytes = 0;
  for (const relative of await eligibleGitPaths(canonical)) {
    try {
      const stat = await lstat(await guardedPath(canonical, relative));
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      const file = await describeSyncFile(canonical, relative);
      totalBytes += file.size;
      if (totalBytes > MAX_SYNC_TOTAL_BYTES) throw new Error("Git workspace exceeds 512 MiB synchronization limit");
      files[relative] = file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A tracked deletion is represented by absence from the working-tree manifest.
    }
  }
  return { root: canonical, digest: manifestDigest(files), files };
}

export function manifestDigest(files: Record<string, SyncFile>): string {
  const compact = Object.keys(files).sort().map((name) => {
    const file = files[name]!;
    return [name, file.kind, file.sha256, file.size, file.mode];
  });
  return sha256(JSON.stringify(compact));
}
