import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TreeEntry, TreeSnapshot } from "./types";

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeText(path: string, text: string): Promise<void> {
  await ensureDirectory(dirname(path));
  await writeFile(path, text, "utf8");
}

export async function writeAtomicText(path: string, text: string): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function readCappedText(path: string, capBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    const buffer = Buffer.alloc(Math.min(metadata.size, capBytes));
    if (buffer.byteLength > 0) await handle.read(buffer, 0, buffer.byteLength, 0);
    return { text: new TextDecoder().decode(buffer), bytes: metadata.size, truncated: metadata.size > capBytes };
  } finally {
    await handle.close();
  }
}

export function redactSensitiveText(text: string): string {
  return text.split(/(\r?\n)/).map((line) => {
    if (/^\r?\n$/.test(line)) return line;
    try {
      const parsed: unknown = JSON.parse(line);
      return JSON.stringify(redactJsonValue(parsed));
    } catch {
      return redactPlainText(line);
    }
  }).join("");
}

function redactJsonValue(value: unknown, key = ""): unknown {
  if (isSecretKey(key)) return "<redacted>";
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactJsonValue(child, childKey)]));
  if (typeof value === "string") {
    try {
      const nested = JSON.parse(value) as unknown;
      if (nested && typeof nested === "object") return JSON.stringify(redactJsonValue(nested));
    } catch {
      // Plain text values are sanitized by the non-JSON path below.
    }
    return redactPlainText(value);
  }
  return value;
}

function redactPlainText(text: string): string {
  const keyPattern = "[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*";
  const valuePattern = "(\\\"[^\\\"]*\\\"|'[^']*'|Bearer\\s+(?:[A-Za-z0-9._~+/=-]+|<redacted>)|[^\\s,;}]+)";
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
    .replace(new RegExp(`((?<![A-Za-z0-9_-])${keyPattern}\\s*[:=]\\s*)${valuePattern}`, "gi"), (_match, prefix: string, value: string) => {
      const key = prefix.replace(/\s*[:=]\s*$/, "").trim();
      return isSecretKey(key) ? `${prefix}<redacted>` : `${prefix}${value}`;
    })
    .replace(new RegExp(`([?&]${keyPattern}=)([^&\\s]+)`, "gi"), (_match, prefix: string, value: string) => {
      const key = prefix.slice(1, -1);
      return isSecretKey(key) ? `${prefix}<redacted>` : `${prefix}${value}`;
    });
}

function isSecretKey(key: string): boolean {
  const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
  // Usage telemetry is intentionally not secret material. Keep these names
  // visible even though they contain the word "token".
  if (/^(?:input|output|total|prompt|completion|cached|reasoning|cacheread|cachewrite)(?:input|output)?tokens?(?:count|usage)?$/.test(normalized) || normalized === "tokencount") return false;
  if (new Set(["apikey", "accesstoken", "refreshtoken", "password", "secret", "authorization", "credential", "privatekey", "clientsecret", "token"]).has(normalized)) return true;
  return /(?:apikey|token|secret|password|credential|authorization|privatekey|clientsecret|accesstoken|refreshtoken)/.test(normalized);
}

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function requireAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path: ${path}`);
  return resolve(path);
}

export async function resolveRealPath(path: string): Promise<string> {
  const suffix: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      const real = await realpath(current);
      return resolve(real, ...suffix.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export function assertContained(root: string, path: string, label = "path"): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes its root: ${path}`);
  }
  return resolvedPath;
}

export async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) result.push(relative(root, full));
    }
  }
  await visit(root);
  return result.sort();
}

export const MAX_FIXTURE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FIXTURE_TOTAL_BYTES = 32 * 1024 * 1024;

export async function snapshotTree(root: string, limits = { maxFileBytes: MAX_FIXTURE_FILE_BYTES, maxTotalBytes: MAX_FIXTURE_TOTAL_BYTES }): Promise<TreeSnapshot> {
  const entries: Record<string, TreeEntry> = {};
  let totalBytes = 0;
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(current, entry.name);
      const rel = relative(root, full);
      const metadata = await lstat(full);
      if (metadata.isDirectory()) {
        await visit(full);
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(full);
        entries[rel] = { kind: "symlink", sha256: sha256(target), byteLength: Buffer.byteLength(target), target };
      } else if (metadata.isFile()) {
        if (metadata.size > limits.maxFileBytes) throw new Error(`fixture file exceeds ${limits.maxFileBytes} bytes: ${rel}`);
        totalBytes += metadata.size;
        if (totalBytes > limits.maxTotalBytes) throw new Error(`fixture tree exceeds ${limits.maxTotalBytes} bytes`);
        const content = await readFile(full);
        entries[rel] = { kind: "file", sha256: sha256(content), byteLength: content.byteLength };
      }
    }
  }
  await visit(root);
  return Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right, "en")));
}

export function snapshotHash(snapshot: TreeSnapshot): string {
  return sha256(JSON.stringify(snapshot));
}

export function changedSnapshotPaths(baseline: TreeSnapshot, current: TreeSnapshot): string[] {
  const paths = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  return [...paths].filter((path) => JSON.stringify(baseline[path]) !== JSON.stringify(current[path])).sort();
}
