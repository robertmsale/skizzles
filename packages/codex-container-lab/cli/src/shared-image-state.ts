import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson, safeStateName, writeJsonAtomic } from "./files";
import { withFileLock } from "./locks";
import {
  SHARED_IMAGE_KIND,
  SHARED_IMAGE_SCHEMA,
  isPlatform,
  sharedImageTag,
} from "./shared-image";
import { listOwnerManifests, ownerKey, readLab, type StateRoots } from "./state";
import type { LabMetadata, SharedImageReference } from "./types";

export const SHARED_IMAGE_RECORD_SCHEMA = "skizzles.shared-image.v1";

export type SharedImageLease = {
  ownerKey: string;
  labId: string;
  acquiredAt: string;
};

export type SharedImageRecord = {
  version: 1;
  schema: typeof SHARED_IMAGE_RECORD_SCHEMA;
  kind: typeof SHARED_IMAGE_KIND;
  digest: string;
  profile: string;
  repoHash: string;
  platform: string;
  tag: string;
  imageId?: string;
  createdAt: string;
  lastUsedAt: string;
  leases: SharedImageLease[];
};

export function sharedImagesDirectory(stateRoot: string): string {
  return join(stateRoot, "shared-images");
}

export function sharedImageRecordPath(stateRoot: string, digest: string): string {
  assertDigest(digest);
  return join(sharedImagesDirectory(stateRoot), `${digest}.json`);
}

export function sharedImageDigestLockPath(stateRoot: string, digest: string): string {
  assertDigest(digest);
  return join(stateRoot, ".locks", `shared-image-${digest}`);
}

export function sharedImageBuilderLockPath(stateRoot: string): string {
  return join(stateRoot, ".locks", "shared-image-builder");
}

export function sharedImageGcLockPath(stateRoot: string): string {
  return join(stateRoot, ".locks", "shared-images-gc");
}

export async function withSharedImageDigestLock<T>(
  stateRoot: string,
  digest: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await withFileLock(sharedImageDigestLockPath(stateRoot, digest), operation, {
    attempts: 3_600,
    delayMs: 500,
    staleMs: 45 * 60_000,
    signal,
  });
}

export async function readSharedImageRecord(stateRoot: string, digest: string): Promise<SharedImageRecord | undefined> {
  try {
    const value = await readJson<unknown>(sharedImageRecordPath(stateRoot, digest));
    return parseSharedImageRecord(value, digest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeSharedImageRecord(stateRoot: string, record: SharedImageRecord): Promise<void> {
  const parsed = parseSharedImageRecord(record, record.digest);
  await writeJsonAtomic(sharedImageRecordPath(stateRoot, parsed.digest), parsed);
}

export async function listSharedImageRecords(stateRoot: string): Promise<SharedImageRecord[]> {
  let names: string[];
  try { names = await readdir(sharedImagesDirectory(stateRoot)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: SharedImageRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) throw new Error(`unexpected shared image state entry: ${name}`);
    const digest = name.slice(0, -5);
    const record = await readSharedImageRecord(stateRoot, digest);
    if (!record) throw new Error(`shared image record disappeared: ${digest}`);
    records.push(record);
  }
  return records;
}

export async function summarizeSharedImageCatalog(
  stateRoot: string,
): Promise<{ cataloged: number; activeLeases: number }> {
  const records = await listSharedImageRecords(stateRoot);
  return {
    cataloged: records.length,
    activeLeases: records.reduce((sum, record) => sum + record.leases.length, 0),
  };
}

export async function ensureSharedImageRecord(
  stateRoot: string,
  reference: Omit<SharedImageRecord, "version" | "schema" | "kind" | "createdAt" | "lastUsedAt" | "leases"> & {
    createdAt?: string;
    lastUsedAt?: string;
    leases?: SharedImageLease[];
  },
  now = new Date(),
): Promise<SharedImageRecord> {
  const timestamp = now.toISOString();
  const existing = await readSharedImageRecord(stateRoot, reference.digest);
  if (existing) {
    if (existing.profile !== reference.profile || existing.platform !== reference.platform ||
        existing.tag !== reference.tag) {
      throw new Error("shared image catalog identity does not match the declared digest");
    }
    if (reference.imageId && existing.imageId && existing.imageId !== reference.imageId) {
      throw new Error("shared image catalog image identity drifted");
    }
    const next: SharedImageRecord = {
      ...existing,
      imageId: reference.imageId ?? existing.imageId,
      lastUsedAt: timestamp,
    };
    await writeSharedImageRecord(stateRoot, next);
    return next;
  }
  const created: SharedImageRecord = {
    version: 1,
    schema: SHARED_IMAGE_RECORD_SCHEMA,
    kind: SHARED_IMAGE_KIND,
    digest: reference.digest,
    profile: reference.profile,
    repoHash: reference.repoHash,
    platform: reference.platform,
    tag: reference.tag,
    imageId: reference.imageId,
    createdAt: reference.createdAt ?? timestamp,
    lastUsedAt: reference.lastUsedAt ?? timestamp,
    leases: reference.leases ?? [],
  };
  await writeSharedImageRecord(stateRoot, created);
  return created;
}

export async function acquireSharedImageLease(
  stateRoot: string,
  reference: SharedImageReference,
  owner: string,
  labId: string,
  extras: { repoHash: string; platform: string },
  now = new Date(),
): Promise<SharedImageRecord> {
  safeStateName(labId, "lab id");
  return await withSharedImageDigestLock(stateRoot, reference.digest, async () => {
    return await recordSharedImageLease(stateRoot, reference, owner, labId, extras, now);
  });
}

/** Caller must already hold the digest lock for `reference.digest`. */
export async function recordSharedImageLease(
  stateRoot: string,
  reference: SharedImageReference,
  owner: string,
  labId: string,
  extras: { repoHash: string; platform: string },
  now = new Date(),
): Promise<SharedImageRecord> {
  safeStateName(labId, "lab id");
  const timestamp = now.toISOString();
  const key = ownerKey(owner);
  const record = await ensureSharedImageRecord(stateRoot, {
    digest: reference.digest,
    profile: reference.profile,
    repoHash: extras.repoHash,
    platform: extras.platform,
    tag: reference.tag,
    imageId: reference.imageId,
  }, now);
  if (record.imageId !== reference.imageId || record.tag !== reference.tag) {
    throw new Error("shared image lease identity does not match the ensured image");
  }
  const leases = record.leases.filter((lease) => !(lease.ownerKey === key && lease.labId === labId));
  leases.push({ ownerKey: key, labId, acquiredAt: timestamp });
  const next: SharedImageRecord = { ...record, leases, lastUsedAt: timestamp, imageId: reference.imageId };
  await writeSharedImageRecord(stateRoot, next);
  return next;
}

export async function releaseSharedImageLease(
  stateRoot: string,
  reference: SharedImageReference,
  owner: string,
  labId: string,
  now = new Date(),
): Promise<SharedImageRecord | undefined> {
  safeStateName(labId, "lab id");
  const key = ownerKey(owner);
  return await withSharedImageDigestLock(stateRoot, reference.digest, async () => {
    const record = await readSharedImageRecord(stateRoot, reference.digest);
    if (!record) return undefined;
    const leases = record.leases.filter((lease) => !(lease.ownerKey === key && lease.labId === labId));
    const next: SharedImageRecord = { ...record, leases, lastUsedAt: now.toISOString() };
    await writeSharedImageRecord(stateRoot, next);
    return next;
  });
}

export async function releaseLabSharedImageLeases(
  stateRoot: string,
  lab: Pick<LabMetadata, "owner" | "id" | "sharedImages">,
  now = new Date(),
): Promise<void> {
  await releaseAllLeasesForLab(stateRoot, lab.owner, lab.id, now);
}

/** Release every catalog lease for this owner+lab, including crash windows
 * where lab metadata never recorded the shared-image reference. */
export async function releaseAllLeasesForLab(
  stateRoot: string,
  owner: string,
  labId: string,
  now = new Date(),
): Promise<void> {
  safeStateName(labId, "lab id");
  const key = ownerKey(owner);
  const timestamp = now.toISOString();
  for (const record of await listSharedImageRecords(stateRoot)) {
    if (!record.leases.some((lease) => lease.ownerKey === key && lease.labId === labId)) continue;
    await withSharedImageDigestLock(stateRoot, record.digest, async () => {
      const current = await readSharedImageRecord(stateRoot, record.digest);
      if (!current) return;
      const leases = current.leases.filter((lease) => !(lease.ownerKey === key && lease.labId === labId));
      if (leases.length === current.leases.length) return;
      await writeSharedImageRecord(stateRoot, { ...current, leases, lastUsedAt: timestamp });
    });
  }
}

export async function listAllLabManifests(roots: StateRoots): Promise<LabMetadata[]> {
  const labs: LabMetadata[] = [];
  for (const owner of await listOwnerManifests(roots.stateRoot)) {
    const directory = join(owner.directory, "labs");
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) throw new Error(`unexpected lab state entry: ${name}`);
      labs.push(await readLab(roots, owner.manifest.owner, name.slice(0, -5)));
    }
  }
  return labs;
}

export function labReferencesDigest(lab: LabMetadata, digest: string): boolean {
  return (lab.sharedImages ?? []).some((reference) => reference.digest === digest);
}

export function parseSharedImageRecord(value: unknown, digest: string): SharedImageRecord {
  if (!isRecord(value) || value.version !== 1 || value.schema !== SHARED_IMAGE_RECORD_SCHEMA ||
      value.kind !== SHARED_IMAGE_KIND || value.digest !== digest ||
      typeof value.profile !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.profile) ||
      typeof value.repoHash !== "string" || !/^[a-f0-9]{12}$/.test(value.repoHash) ||
      typeof value.platform !== "string" || !isPlatform(value.platform) ||
      value.tag !== sharedImageTag(digest) || !isDigest(digest) ||
      typeof value.createdAt !== "string" || !isTimestamp(value.createdAt) ||
      typeof value.lastUsedAt !== "string" || !isTimestamp(value.lastUsedAt) ||
      !Array.isArray(value.leases) || value.leases.length > 256) {
    throw new Error(`invalid shared image record: ${digest}`);
  }
  if (value.imageId !== undefined && (typeof value.imageId !== "string" || !isImageId(value.imageId))) {
    throw new Error(`invalid shared image record: ${digest}`);
  }
  const leases: SharedImageLease[] = [];
  const seen = new Set<string>();
  for (const lease of value.leases) {
    if (!isRecord(lease) || typeof lease.ownerKey !== "string" || !/^[a-f0-9]{64}$/.test(lease.ownerKey) ||
        typeof lease.labId !== "string" || typeof lease.acquiredAt !== "string" || !isTimestamp(lease.acquiredAt)) {
      throw new Error(`invalid shared image lease: ${digest}`);
    }
    safeStateName(lease.labId, "lab id");
    const identity = `${lease.ownerKey}:${lease.labId}`;
    if (seen.has(identity)) throw new Error(`duplicate shared image lease: ${digest}`);
    seen.add(identity);
    leases.push({ ownerKey: lease.ownerKey, labId: lease.labId, acquiredAt: lease.acquiredAt });
  }
  return {
    version: 1,
    schema: SHARED_IMAGE_RECORD_SCHEMA,
    kind: SHARED_IMAGE_KIND,
    digest,
    profile: value.profile,
    repoHash: value.repoHash,
    platform: value.platform,
    tag: value.tag,
    imageId: value.imageId,
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt,
    leases,
  };
}

export function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function isImageId(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function assertDigest(digest: string): void {
  if (!isDigest(digest)) throw new Error("shared image digest is invalid");
}

function isTimestamp(value: string): boolean {
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
