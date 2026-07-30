import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CACHE_PREFIX = "skizzles-prompt-governance-";
const CACHE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CACHE_COMMITMENT_PATTERN = /^[0-9a-f]{64}$/;
const CACHE_MARKER = ".skizzles-cache-owner";
const MARKER_VERSION = "skizzles-private-cache-v1";
const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;
const HANDLE_TOKEN = Symbol("verified-private-cache");

export interface CacheIdentity { readonly device: number; readonly inode: number; }
export interface CacheLocator { readonly id: string; readonly commitment: string; readonly identity: CacheIdentity; }

export interface VerifiedPrivateCache { readonly locator: CacheLocator; }
class VerifiedPrivateCacheImpl implements VerifiedPrivateCache {
  readonly locator: CacheLocator;
  readonly #brand = true;
  constructor(locator: CacheLocator, token: symbol) {
    if (token !== HANDLE_TOKEN) throw new Error("private-cache-integrity: handle construction is restricted");
    this.locator = freezeLocator(locator);
    Object.freeze(this);
  }
  static is(value: unknown): value is VerifiedPrivateCache { return value instanceof VerifiedPrivateCacheImpl && value.#brand; }
}

export function privateCachePath(id: string): string { assertCacheId(id); return join(tmpdir(), `${CACHE_PREFIX}${id}`); }

export async function createPrivateCache(id: string = randomUUID()): Promise<{ locator: CacheLocator; handle: VerifiedPrivateCache }> {
  assertCacheId(id);
  const root = privateCachePath(id);
  await mkdir(root, { mode: 0o700 });
  try {
    const capability = randomBytes(32).toString("hex");
    await writeFile(join(root, CACHE_MARKER), markerText(id, capability), { mode: 0o600, flag: "wx" });
    const locator = await locatorFromFilesystem(id, commitment(id, capability));
    return { locator, handle: newVerifiedHandle(locator) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function openPrivateCache(input: unknown): Promise<VerifiedPrivateCache> {
  const locator = parseCacheLocator(input);
  await verifyCacheLocator(locator);
  return newVerifiedHandle(locator);
}

export async function removePrivateCache(cache: VerifiedPrivateCache): Promise<void> {
  assertHandle(cache);
  const root = await verifyCacheLocator(cache.locator);
  await verifyCacheLocator(cache.locator);
  try { await rm(root, { recursive: true, force: false }); } catch (error) { throw new Error(`private-cache-cleanup: ${error instanceof Error ? error.message : String(error)}`); }
}

export function parseCacheLocator(input: unknown): CacheLocator {
  if (!isRecord(input) || Object.keys(input).sort().join(",") !== "commitment,id,identity") throw new Error("private-cache-integrity: cache locator shape is invalid");
  const identity = input.identity;
  if (!isRecord(identity) || Object.keys(identity).sort().join(",") !== "device,inode" || !isSafeNonNegativeInteger(identity.device) || !isSafeNonNegativeInteger(identity.inode)) throw new Error("private-cache-integrity: cache identity is invalid");
  if (typeof input.id !== "string" || !CACHE_ID_PATTERN.test(input.id) || typeof input.commitment !== "string" || !CACHE_COMMITMENT_PATTERN.test(input.commitment)) throw new Error("private-cache-integrity: cache locator values are invalid");
  return freezeLocator({ id: input.id, commitment: input.commitment, identity: { device: identity.device, inode: identity.inode } });
}

export function assertPrivateCachePath(cache: VerifiedPrivateCache, path: string): string {
  assertHandle(cache);
  const expected = privateCachePath(cache.locator.id);
  const resolved = resolve(path);
  if (resolved === expected || !resolved.startsWith(`${expected}/`)) throw new Error("private artifact escaped its execution cache");
  return resolved;
}

export function privateArtifactPath(cache: VerifiedPrivateCache, ...parts: string[]): string {
  assertHandle(cache);
  return assertPrivateCachePath(cache, join(privateCachePath(cache.locator.id), ...parts));
}

export async function ensurePrivateDirectory(cache: VerifiedPrivateCache, ...parts: string[]): Promise<string> {
  await verifyHandle(cache);
  let current = privateCachePath(cache.locator.id);
  for (const [index] of parts.entries()) {
    current = privateArtifactPath(cache, ...parts.slice(0, index + 1));
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("private-cache-integrity: nested path is not a real directory");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return current;
}

export async function assertCacheOutside(cache: VerifiedPrivateCache, publicRoot: string): Promise<void> {
  const cacheReal = await verifyHandle(cache);
  const publicReal = await realpath(publicRoot);
  if (cacheReal === publicReal || cacheReal.startsWith(`${publicReal}/`) || publicReal.startsWith(`${cacheReal}/`)) throw new Error("private execution cache aliases the public artifact root");
}

async function verifyHandle(cache: unknown): Promise<string> { assertHandle(cache); return verifyCacheLocator(cache.locator); }

async function verifyCacheLocator(locator: CacheLocator): Promise<string> {
  const root = privateCachePath(locator.id);
  let rootMetadata;
  try { rootMetadata = await lstat(root); } catch (error) {
    if (isMissing(error)) throw new Error("private-cache-missing: expected cache root is absent");
    throw new Error("private-cache-integrity: cache root changed");
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o777) !== 0o700 || rootMetadata.dev !== locator.identity.device || rootMetadata.ino !== locator.identity.inode) throw new Error("private-cache-integrity: cache root changed");
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== resolve(root) || resolve(await realpath(tmpdir())) !== resolve(tmpdir())) throw new Error("private-cache-integrity: cache canonical boundary changed");
  const markerPath = join(root, CACHE_MARKER);
  let markerMetadata;
  try { markerMetadata = await lstat(markerPath); } catch { throw new Error("private-cache-integrity: owner marker is invalid"); }
  if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink() || (markerMetadata.mode & 0o777) !== 0o600 || markerMetadata.size !== markerLength(locator.id)) throw new Error("private-cache-integrity: owner marker is invalid");
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (((fsConstants as unknown) as Record<string, number>).O_CLOEXEC ?? 0);
  const markerHandle = await open(markerPath, flags);
  try {
    const opened = await markerHandle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || opened.dev !== markerMetadata.dev || opened.ino !== markerMetadata.ino || opened.mode !== markerMetadata.mode || opened.size !== markerMetadata.size) throw new Error("private-cache-integrity: owner marker changed");
    const buffer = Buffer.alloc(markerLength(locator.id));
    const read = await markerHandle.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead !== buffer.length) throw new Error("private-cache-integrity: owner marker is truncated");
    const marker = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    const capability = parseMarker(marker, locator.id);
    const expected = Buffer.from(locator.commitment, "hex");
    const actual = Buffer.from(commitment(locator.id, capability), "hex");
    if (!timingSafeEqual(actual, expected)) throw new Error("private-cache-integrity: owner marker commitment changed");
  } finally { await markerHandle.close(); }
  return canonicalRoot;
}

async function locatorFromFilesystem(id: string, expectedCommitment: string): Promise<CacheLocator> {
  const root = privateCachePath(id);
  const metadata = await lstat(root);
  return freezeLocator({ id, commitment: expectedCommitment, identity: { device: metadata.dev, inode: metadata.ino } });
}

function parseMarker(value: string, id: string): string {
  const fields = value.split("\n");
  if (fields.length !== 4 || fields[0] !== MARKER_VERSION || fields[1] !== id || fields[3] !== "" || !CAPABILITY_PATTERN.test(fields[2] ?? "")) throw new Error("private-cache-integrity: owner marker encoding is invalid");
  return fields[2]!;
}
function markerText(id: string, capability: string): string { return `${MARKER_VERSION}\n${id}\n${capability}\n`; }
function markerLength(id: string): number { return Buffer.byteLength(markerText(id, "0".repeat(64))); }
function commitment(id: string, capability: string): string { return digest(`${MARKER_VERSION}\u0000${id}\u0000${capability}`); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function freezeLocator(locator: CacheLocator): CacheLocator { return Object.freeze({ id: locator.id, commitment: locator.commitment, identity: Object.freeze({ device: locator.identity.device, inode: locator.identity.inode }) }); }
function newVerifiedHandle(locator: CacheLocator): VerifiedPrivateCache { return new VerifiedPrivateCacheImpl(locator, HANDLE_TOKEN); }
function assertHandle(value: unknown): asserts value is VerifiedPrivateCache { if (!VerifiedPrivateCacheImpl.is(value)) throw new Error("private-cache-integrity: verified handle required"); }
function assertCacheId(id: string): void { if (!CACHE_ID_PATTERN.test(id)) throw new Error("private-cache-integrity: cache identifier is invalid"); }
function isSafeNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
