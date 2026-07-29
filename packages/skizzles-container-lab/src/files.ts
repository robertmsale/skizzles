import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type SyncFileKind = "file" | "symlink";

export interface SyncFile {
  path: string;
  kind: SyncFileKind;
  sha256: string;
  size: number;
  mode: number;
}

export const MAX_SYNC_FILE_BYTES = 64 * 1024 * 1024;

export function safeRelativePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\")) {
    throw new Error(`Unsafe synchronization path: ${JSON.stringify(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || path.posix.isAbsolute(value) || value === "." || value === ".." || value.startsWith("../")) {
    throw new Error(`Unsafe synchronization path: ${JSON.stringify(value)}`);
  }
  return value;
}

export function safeStateName(value: string, label = "identifier"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

export async function canonicalRoot(root: string): Promise<string> {
  const resolved = await realpath(root);
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) throw new Error(`Synchronization root is not a directory: ${root}`);
  return resolved;
}

/** Resolve a relative path without permitting an existing parent symlink. */
export async function guardedPath(root: string, relative: string, createParents = false): Promise<string> {
  safeRelativePath(relative);
  const canonical = await canonicalRoot(root);
  const parts = relative.split("/");
  let parent = canonical;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    try {
      const stat = await lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe synchronization parent for ${relative}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!createParents) break;
      await mkdir(parent);
    }
  }
  const result = path.join(canonical, ...parts);
  if (result !== canonical && !result.startsWith(`${canonical}${path.sep}`)) {
    throw new Error(`Synchronization path escapes its root: ${relative}`);
  }
  return result;
}

export async function describeSyncFile(root: string, relative: string): Promise<SyncFile> {
  const absolute = await guardedPath(root, relative);
  const stat = await lstat(absolute);
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) {
    const target = await readlink(absolute);
    const bytes = Buffer.from(target);
    return { path: relative, kind: "symlink", sha256: sha256(bytes), size: bytes.byteLength, mode };
  }
  if (!stat.isFile()) throw new Error(`Eligible Git path is not a regular file or symlink: ${relative}`);
  if (stat.size > MAX_SYNC_FILE_BYTES) throw new Error(`Eligible Git file exceeds 64 MiB synchronization limit: ${relative}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
  return { path: relative, kind: "file", sha256: hash.digest("hex"), size: stat.size, mode };
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function removeIfPresent(file: string, options: { recursive?: boolean } = {}): Promise<void> {
  await rm(file, { force: true, recursive: options.recursive ?? false });
}
