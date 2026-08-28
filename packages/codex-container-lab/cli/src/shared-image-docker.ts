import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LabConfig, SharedImageProfile } from "./config";
import type { DockerRunner } from "./docker";
import { withFileLock } from "./locks";
import type { CommandResult } from "./process";
import {
  SHARED_IMAGE_BUILDER_DRIVER,
  SHARED_IMAGE_BUILDER_NAME,
  fingerprintSharedImage,
  hasExactSharedImageLabels,
  materializeSharedImageSnapshot,
  sharedImageLabels,
  type SharedImageFingerprint,
} from "./shared-image";
import {
  ensureSharedImageRecord,
  isImageId,
  labReferencesDigest,
  listAllLabManifests,
  listSharedImageRecords,
  readSharedImageRecord,
  recordSharedImageLease,
  sharedImageBuilderLockPath,
  sharedImageGcLockPath,
  sharedImageRecordPath,
  withSharedImageDigestLock,
  type SharedImageRecord,
} from "./shared-image-state";
import type { StateRoots } from "./state";
import type { SharedImageReference } from "./types";

const BUILD_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_IMAGE_MAX_AGE_MS = 168 * 60 * 60 * 1000;
const DEFAULT_CACHE_BUDGET_BYTES = 20 * 1024 * 1024 * 1024;

export type SharedImageEnsureOptions = {
  stateRoot: string;
  repoHash: string;
  profile: SharedImageProfile;
  repoRoot: string;
  docker: DockerRunner;
  builderName?: string;
  now?: Date;
  signal?: AbortSignal;
  lease?: { owner: string; labId: string };
};

export type SharedImageGcMode = "plan" | "apply";

export type SharedImageGcFinding = {
  code: string;
  detail: string;
};

export type SharedImageGcResult = {
  mode: SharedImageGcMode;
  considered: number;
  eligible: number;
  removed: number;
  retained: number;
  bytes: number;
  findings: SharedImageGcFinding[];
};

export type SharedCacheGcResult = {
  mode: SharedImageGcMode;
  builder: string;
  bytes: number;
  reclaimableBytes?: number;
  applied: boolean;
  findings: SharedImageGcFinding[];
};

export type SharedImageInventory = {
  cataloged: number;
  present: number;
  activeLeases: number;
  eligible: number;
  bytes: number;
  reclaimableBytes: number;
  untracked: number;
};

export async function ensureSharedEnvironmentImage(options: SharedImageEnsureOptions): Promise<SharedImageReference> {
  const fingerprint = await fingerprintSharedImage(options.repoRoot, options.profile);
  const now = options.now ?? new Date();
  const builderName = options.builderName ?? SHARED_IMAGE_BUILDER_NAME;
  return await withSharedImageDigestLock(options.stateRoot, fingerprint.digest, async () => {
    await ensureSharedImageRecord(options.stateRoot, {
      digest: fingerprint.digest,
      profile: options.profile.name,
      repoHash: options.repoHash,
      platform: options.profile.platform,
      tag: fingerprint.tag,
    }, now);
    const existing = await inspectCatalogedSharedImage(options.docker, {
      digest: fingerprint.digest,
      profile: options.profile.name,
      platform: options.profile.platform,
      tag: fingerprint.tag,
    });
    if (existing) {
      await ensureSharedImageRecord(options.stateRoot, {
        digest: fingerprint.digest,
        profile: options.profile.name,
        repoHash: options.repoHash,
        platform: options.profile.platform,
        tag: fingerprint.tag,
        imageId: existing.imageId,
      }, now);
      return await finishEnsuredSharedImage(options, existing, now);
    }
    await ensureSharedImageBuilder(options.docker, options.stateRoot, builderName);
    const createdAt = now.toISOString();
    const imageId = await buildSharedImage(options.docker, {
      profile: options.profile,
      fingerprint,
      digest: fingerprint.digest,
      repoHash: options.repoHash,
      tag: fingerprint.tag,
      createdAt,
      builderName,
      signal: options.signal,
    });
    const verified = await inspectCatalogedSharedImage(options.docker, {
      digest: fingerprint.digest,
      profile: options.profile.name,
      platform: options.profile.platform,
      tag: fingerprint.tag,
    });
    if (!verified || verified.imageId !== imageId) {
      throw new Error("shared image build did not produce a verifiable image identity");
    }
    await ensureSharedImageRecord(options.stateRoot, {
      digest: fingerprint.digest,
      profile: options.profile.name,
      repoHash: options.repoHash,
      platform: options.profile.platform,
      tag: fingerprint.tag,
      imageId,
    }, now);
    return await finishEnsuredSharedImage(options, verified, now);
  }, options.signal);
}

async function finishEnsuredSharedImage(
  options: SharedImageEnsureOptions,
  reference: SharedImageReference,
  now: Date,
): Promise<SharedImageReference> {
  if (options.lease) {
    await recordSharedImageLease(
      options.stateRoot,
      reference,
      options.lease.owner,
      options.lease.labId,
      { repoHash: options.repoHash, platform: options.profile.platform },
      now,
    );
  }
  return reference;
}

export async function ensureLabSharedImages(
  config: LabConfig,
  options: {
    stateRoot: string;
    repoHash: string;
    docker: DockerRunner;
    builderName?: string;
    now?: Date;
    signal?: AbortSignal;
    owner: string;
    labId: string;
  },
): Promise<SharedImageReference[]> {
  const references: SharedImageReference[] = [];
  for (const profile of config.sharedImages) {
    references.push(await ensureSharedEnvironmentImage({
      stateRoot: options.stateRoot,
      repoHash: options.repoHash,
      profile,
      repoRoot: config.repoRoot,
      docker: options.docker,
      builderName: options.builderName,
      now: options.now,
      signal: options.signal,
      lease: { owner: options.owner, labId: options.labId },
    }));
  }
  return references;
}

export async function inspectCatalogedSharedImage(
  docker: DockerRunner,
  expected: {
    digest: string;
    profile: string;
    repoHash?: string;
    platform: string;
    tag: string;
  },
): Promise<SharedImageReference | undefined> {
  const inspected = await docker.run([
    "image", "inspect", "--format",
    '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"size":{{json .Size}}}',
    expected.tag,
  ], { allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  if (inspected.code !== 0) {
    if (isExactMissingImage(inspected, expected.tag)) return undefined;
    throw new Error("unable to inspect shared image ownership");
  }
  let image: unknown;
  try { image = JSON.parse(inspected.stdout.toString()); }
  catch { throw new Error("invalid shared image ownership inspection"); }
  if (!isRecord(image) || typeof image.id !== "string" || !isImageId(image.id) || !isRecord(image.labels) ||
      !hasExactSharedImageLabels(image.labels, expected)) {
    throw new Error("refusing shared image with mismatched provenance labels");
  }
  return {
    profile: expected.profile,
    digest: expected.digest,
    imageId: image.id,
    tag: expected.tag,
  };
}

export async function inventorySharedImageBuilderCache(
  docker: DockerRunner,
): Promise<{ present: boolean; namespaceOwned: boolean; bytes: number; reclaimableBytes?: number }> {
  const inspected = await inspectSharedImageBuilder(docker);
  if (inspected !== "matching") {
    return { present: false, namespaceOwned: false, bytes: 0 };
  }
  const usage = await sharedBuilderCacheUsage(docker, SHARED_IMAGE_BUILDER_NAME);
  return {
    present: true,
    namespaceOwned: true,
    bytes: usage.bytes,
    ...(usage.reclaimableBytes === undefined ? {} : { reclaimableBytes: usage.reclaimableBytes }),
  };
}

export async function inventorySharedImages(
  roots: StateRoots,
  docker: DockerRunner,
  policy: { maxAgeMs?: number; budgetBytes?: number } = {},
  now = new Date(),
): Promise<SharedImageInventory> {
  const records = await listSharedImageRecords(roots.stateRoot);
  const labs = await listAllLabManifests(roots);
  let present = 0;
  let activeLeases = 0;
  let eligible = 0;
  let bytes = 0;
  let reclaimableBytes = 0;
  for (const record of records) {
    activeLeases += record.leases.length;
    const inspection = record.imageId
      ? await inspectImageById(docker, record)
      : undefined;
    if (inspection?.present) {
      present += 1;
      bytes += inspection.size;
      if (isEligibleForGc(record, labs, policy, now)) {
        eligible += 1;
        reclaimableBytes += inspection.size;
      }
    }
  }
  const untracked = await countUntrackedSharedImages(docker, records);
  return {
    cataloged: records.length,
    present,
    activeLeases,
    eligible,
    bytes,
    reclaimableBytes,
    untracked,
  };
}

export async function gcSharedImages(
  roots: StateRoots,
  docker: DockerRunner,
  options: {
    mode: SharedImageGcMode;
    maxAgeMs?: number;
    budgetBytes?: number;
    now?: Date;
  },
): Promise<SharedImageGcResult> {
  const now = options.now ?? new Date();
  const findings: SharedImageGcFinding[] = [];
  return await withFileLock(sharedImageGcLockPath(roots.stateRoot), async () => {
    let records: SharedImageRecord[];
    let labs;
    try {
      records = await listSharedImageRecords(roots.stateRoot);
      labs = await listAllLabManifests(roots);
    } catch (error) {
      return {
        mode: options.mode,
        considered: 0,
        eligible: 0,
        removed: 0,
        retained: 0,
        bytes: 0,
        findings: [boundedFinding("state-unavailable", error)],
      };
    }
    const policy = { maxAgeMs: options.maxAgeMs ?? DEFAULT_IMAGE_MAX_AGE_MS, budgetBytes: options.budgetBytes };
    let eligible = 0;
    let removed = 0;
    let retained = 0;
    let bytes = 0;
    const overBudget = await catalogOverBudget(docker, records, labs, policy, now);
    for (const record of records) {
      const result = await withSharedImageDigestLock(roots.stateRoot, record.digest, async () => {
        const current = await readSharedImageRecord(roots.stateRoot, record.digest);
        if (!current) return { action: "missing" as const, size: 0 };
        const liveLabs = await listAllLabManifests(roots);
        const inspection = current.imageId ? await inspectImageById(docker, current) : { present: false, size: 0, finding: undefined };
        if (inspection.finding) {
          findings.push(inspection.finding);
          return { action: "retain" as const, size: 0 };
        }
        const eligibleNow = isEligibleForGc(current, liveLabs, policy, now) ||
          (overBudget.has(current.digest) && current.leases.length === 0 && !liveLabs.some((lab) => labReferencesDigest(lab, current.digest)));
        if (!eligibleNow) return { action: "retain" as const, size: inspection.size };
        if (!inspection.present) {
          if (options.mode === "apply") await rmCatalogIfUnleased(roots.stateRoot, current.digest);
          return { action: "eligible-absent" as const, size: 0 };
        }
        if (options.mode === "plan") return { action: "eligible" as const, size: inspection.size };
        const removedImage = await removeVerifiedSharedImage(docker, current);
        if (!removedImage.ok) {
          findings.push(removedImage.finding);
          return { action: "retain" as const, size: inspection.size };
        }
        const remaining = await inspectImageById(docker, current);
        if (remaining.present) {
          findings.push({ code: "remove-incomplete", detail: "shared image remained after verified removal" });
          return { action: "retain" as const, size: inspection.size };
        }
        await rmCatalogIfUnleased(roots.stateRoot, current.digest);
        return { action: "removed" as const, size: inspection.size };
      });
      if (result.action === "retain") retained += 1;
      if (result.action === "eligible" || result.action === "eligible-absent" || result.action === "removed") eligible += 1;
      if (result.action === "removed") removed += 1;
      if (result.action === "eligible" || result.action === "removed") bytes += result.size;
    }
    return {
      mode: options.mode,
      considered: records.length,
      eligible,
      removed: options.mode === "apply" ? removed : 0,
      retained,
      bytes,
      findings: findings.slice(0, 8),
    };
  }, { attempts: 600, delayMs: 50 });
}

export async function gcSharedImageCache(
  docker: DockerRunner,
  options: {
    stateRoot: string;
    mode: SharedImageGcMode;
    budgetBytes?: number;
  },
): Promise<SharedCacheGcResult> {
  const builderName = SHARED_IMAGE_BUILDER_NAME;
  const findings: SharedImageGcFinding[] = [];
  return await withFileLock(sharedImageGcLockPath(options.stateRoot), async () => {
    return await withFileLock(sharedImageBuilderLockPath(options.stateRoot), async () => {
      const inspected = await inspectSharedImageBuilder(docker, builderName);
      if (inspected === "missing") {
        return {
          mode: options.mode,
          builder: builderName,
          bytes: 0,
          applied: false,
          findings: [{ code: "builder-absent", detail: "shared image builder is not present" }],
        };
      }
      if (inspected === "mismatch") {
        return {
          mode: options.mode,
          builder: builderName,
          bytes: 0,
          applied: false,
          findings: [{ code: "builder-mismatch", detail: "refusing a foreign or default builder namespace" }],
        };
      }
      const usage = await sharedBuilderCacheUsage(docker, builderName);
      if (usage.finding) findings.push(usage.finding);
      const budget = options.budgetBytes ?? DEFAULT_CACHE_BUDGET_BYTES;
      if (options.mode === "plan") {
        return {
          mode: options.mode,
          builder: builderName,
          bytes: usage.bytes,
          reclaimableBytes: usage.reclaimableBytes,
          applied: false,
          findings: findings.slice(0, 8),
        };
      }
      const pruned = await docker.run([
        "buildx", "prune", "--builder", builderName, "--force", "--keep-storage", String(budget),
      ], { allowFailure: true, timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 });
      if (pruned.code !== 0) {
        findings.push({ code: "cache-gc-failed", detail: "shared image builder cache GC did not complete" });
        return { mode: options.mode, builder: builderName, bytes: usage.bytes, applied: false, findings: findings.slice(0, 8) };
      }
      const after = await sharedBuilderCacheUsage(docker, builderName);
      return {
        mode: options.mode,
        builder: builderName,
        bytes: after.bytes,
        reclaimableBytes: after.reclaimableBytes,
        applied: true,
        findings: findings.slice(0, 8),
      };
    });
  }, { attempts: 600, delayMs: 50 });
}

export async function ensureSharedImageBuilder(
  docker: DockerRunner,
  stateRoot: string,
  builderName = SHARED_IMAGE_BUILDER_NAME,
): Promise<void> {
  await withFileLock(sharedImageBuilderLockPath(stateRoot), async () => {
    const existing = await inspectSharedImageBuilder(docker, builderName);
    if (existing === "matching") return;
    if (existing === "mismatch") throw new Error("refusing a foreign or default shared-image builder namespace");
    const created = await docker.run([
      "buildx", "create",
      "--name", builderName,
      "--driver", SHARED_IMAGE_BUILDER_DRIVER,
      "--bootstrap",
    ], { allowFailure: true, timeoutMs: 120_000, maxOutputBytes: 64 * 1024 });
    if (created.code !== 0) {
      const raced = await inspectSharedImageBuilder(docker, builderName);
      if (raced !== "matching") throw new Error("failed to create the shared image builder");
      return;
    }
    const verified = await inspectSharedImageBuilder(docker, builderName);
    if (verified !== "matching") throw new Error("shared image builder identity could not be verified");
  }, { attempts: 600, delayMs: 50 });
}

export async function inspectSharedImageBuilder(
  docker: DockerRunner,
  builderName = SHARED_IMAGE_BUILDER_NAME,
): Promise<"missing" | "matching" | "mismatch"> {
  if (builderName === "default" || builderName === "") return "mismatch";
  const inspected = await docker.run(["buildx", "inspect", builderName], {
    allowFailure: true, timeoutMs: 20_000, maxOutputBytes: 64 * 1024,
  });
  if (inspected.code !== 0) {
    const diagnostic = inspected.stderr.toString();
    if (/no builder|not found|does not exist/i.test(diagnostic) && inspected.stdout.toString().trim() === "") {
      return "missing";
    }
    return "mismatch";
  }
  const text = `${inspected.stdout.toString()}\n${inspected.stderr.toString()}`;
  const name = text.match(/^\s*Name:\s+(\S+)/m)?.[1];
  const driver = text.match(/^\s*Driver:\s+(\S+)/m)?.[1];
  if (name !== builderName || driver !== SHARED_IMAGE_BUILDER_DRIVER) return "mismatch";
  return "matching";
}

async function buildSharedImage(
  docker: DockerRunner,
  options: {
    profile: SharedImageProfile;
    fingerprint: SharedImageFingerprint;
    digest: string;
    repoHash: string;
    tag: string;
    createdAt: string;
    builderName: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "skizzles-shared-image-"));
  const iidFile = join(directory, "iid");
  let snapshot: { root: string; context: string; dockerfile: string } | undefined;
  try {
    snapshot = await materializeSharedImageSnapshot(options.profile, options.fingerprint);
    const labels = sharedImageLabels({
      profile: options.profile.name,
      digest: options.digest,
      repoHash: options.repoHash,
      platform: options.profile.platform,
      createdAt: options.createdAt,
    });
    const args = [
      "buildx", "build",
      "--builder", options.builderName,
      "--load",
      "--platform", options.profile.platform,
      "--file", snapshot.dockerfile,
      "--tag", options.tag,
      "--iidfile", iidFile,
      "--provenance=false",
      "--sbom=false",
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      ...Object.entries(options.profile.buildArgs).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
    ];
    if (options.profile.target) args.push("--target", options.profile.target);
    args.push(snapshot.context);
    const built = await docker.run(args, {
      allowFailure: true,
      timeoutMs: BUILD_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
      stdoutCapture: "tail",
      stderrCapture: "tail",
      signal: options.signal,
    });
    if (built.code !== 0) throw new Error("shared image build failed");
    const imageId = (await readFile(iidFile, "utf8")).trim();
    if (!isImageId(imageId) && !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
      const prefixed = imageId.startsWith("sha256:") ? imageId : `sha256:${imageId}`;
      if (!isImageId(prefixed)) throw new Error("shared image build produced an invalid image id");
      return prefixed;
    }
    return imageId.startsWith("sha256:") ? imageId : `sha256:${imageId}`;
  } finally {
    if (snapshot) await rm(snapshot.root, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

async function inspectImageById(
  docker: DockerRunner,
  record: SharedImageRecord,
): Promise<{ present: boolean; size: number; finding?: SharedImageGcFinding }> {
  if (!record.imageId) return { present: false, size: 0 };
  const inspected = await docker.run([
    "image", "inspect", "--format",
    '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"size":{{json .Size}},"repotags":{{json .RepoTags}}}',
    record.imageId,
  ], { allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  if (inspected.code !== 0) {
    if (isExactMissingImage(inspected, record.imageId) || isExactMissingImage(inspected, record.tag)) {
      return { present: false, size: 0 };
    }
    return { present: false, size: 0, finding: { code: "inspect-uncertain", detail: "shared image inspection was uncertain" } };
  }
  let image: unknown;
  try { image = JSON.parse(inspected.stdout.toString()); }
  catch {
    return { present: false, size: 0, finding: { code: "inspect-invalid", detail: "shared image inspection was invalid" } };
  }
  if (!isRecord(image) || image.id !== record.imageId || !isRecord(image.labels) ||
      !hasExactSharedImageLabels(image.labels, record) ||
      typeof image.size !== "number" || !Number.isFinite(image.size) || image.size < 0) {
    return { present: true, size: 0, finding: { code: "label-mismatch", detail: "shared image labels or identity drifted" } };
  }
  const tags = Array.isArray(image.repotags) ? image.repotags.filter((value): value is string => typeof value === "string") : [];
  if (!tags.includes(record.tag)) {
    return { present: true, size: 0, finding: { code: "tag-drift", detail: "shared image tag does not match the catalog" } };
  }
  return { present: true, size: image.size };
}

async function removeVerifiedSharedImage(
  docker: DockerRunner,
  record: SharedImageRecord,
): Promise<{ ok: true } | { ok: false; finding: SharedImageGcFinding }> {
  if (!record.imageId) return { ok: false, finding: { code: "missing-id", detail: "shared image catalog has no image id" } };
  try {
    const rechecked = await inspectCatalogedSharedImage(docker, record);
    const verified = await inspectImageById(docker, record);
    if (verified.finding) return { ok: false, finding: verified.finding };
    if (!verified.present) return { ok: true };
    if (rechecked && rechecked.imageId !== record.imageId) {
      return { ok: false, finding: { code: "id-drift", detail: "shared image identity drifted before removal" } };
    }
  } catch {
    return { ok: false, finding: { code: "revalidate-failed", detail: "shared image revalidation failed" } };
  }
  const removed = await docker.run(["image", "rm", "--no-prune", record.imageId], {
    allowFailure: true, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024,
  });
  if (removed.code !== 0) {
    return { ok: false, finding: { code: "remove-failed", detail: "verified shared image removal failed" } };
  }
  return { ok: true };
}

async function rmCatalogIfUnleased(stateRoot: string, digest: string): Promise<void> {
  const current = await readSharedImageRecord(stateRoot, digest);
  if (!current || current.leases.length > 0) return;
  await rm(sharedImageRecordPath(stateRoot, digest), { force: true });
}

function isEligibleForGc(
  record: SharedImageRecord,
  labs: { sharedImages?: SharedImageReference[] }[],
  policy: { maxAgeMs?: number; budgetBytes?: number },
  now: Date,
): boolean {
  if (record.leases.length > 0) return false;
  if (labs.some((lab) => labReferencesDigest(lab as never, record.digest))) return false;
  const age = now.getTime() - Date.parse(record.lastUsedAt);
  if (!Number.isFinite(age) || age < (policy.maxAgeMs ?? DEFAULT_IMAGE_MAX_AGE_MS)) return false;
  return true;
}

async function catalogOverBudget(
  docker: DockerRunner,
  records: SharedImageRecord[],
  labs: { sharedImages?: SharedImageReference[] }[],
  policy: { maxAgeMs?: number; budgetBytes?: number },
  now: Date,
): Promise<Set<string>> {
  const selected = new Set<string>();
  if (policy.budgetBytes === undefined) return selected;
  const unused: Array<{ digest: string; lastUsedAt: number; size: number }> = [];
  let total = 0;
  for (const record of records) {
    const inspection = record.imageId ? await inspectImageById(docker, record) : undefined;
    if (!inspection?.present) continue;
    total += inspection.size;
    if (record.leases.length === 0 && !labs.some((lab) => labReferencesDigest(lab as never, record.digest))) {
      unused.push({ digest: record.digest, lastUsedAt: Date.parse(record.lastUsedAt), size: inspection.size });
    }
  }
  if (total <= policy.budgetBytes) return selected;
  unused.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  let remaining = total;
  for (const record of unused) {
    if (remaining <= policy.budgetBytes) break;
    selected.add(record.digest);
    remaining -= record.size;
  }
  return selected;
}

async function countUntrackedSharedImages(docker: DockerRunner, records: SharedImageRecord[]): Promise<number> {
  const listed = await docker.run([
    "image", "ls", "-q", "--no-trunc",
    "--filter", "label=io.openai.skizzles.shared-image.managed=true",
  ], { allowFailure: true, timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 });
  if (listed.code !== 0) return 0;
  const ids = [...new Set(listed.stdout.toString().trim().split("\n").filter(Boolean))];
  if (ids.length > 1_000) return ids.length;
  const known = new Set(records.map((record) => record.imageId).filter((value): value is string => value !== undefined));
  let untracked = 0;
  for (const id of ids) {
    const imageId = id.startsWith("sha256:") ? id : `sha256:${id}`;
    if (known.has(imageId) || known.has(id)) continue;
    untracked += 1;
  }
  return untracked;
}

async function sharedBuilderCacheUsage(
  docker: DockerRunner,
  builderName: string,
): Promise<{ bytes: number; reclaimableBytes?: number; finding?: SharedImageGcFinding }> {
  const usage = await docker.run(["buildx", "du", "--builder", builderName], {
    allowFailure: true, timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
  });
  if (usage.code !== 0) {
    return { bytes: 0, finding: { code: "cache-inventory-unavailable", detail: "shared image builder cache inventory was unavailable" } };
  }
  const text = usage.stdout.toString();
  const total = parseBuildxSize(text);
  if (total === undefined) {
    return { bytes: 0, finding: { code: "cache-inventory-invalid", detail: "shared image builder cache inventory was invalid" } };
  }
  return { bytes: total.bytes, reclaimableBytes: total.reclaimableBytes };
}

function parseBuildxSize(text: string): { bytes: number; reclaimableBytes?: number } | undefined {
  const match = text.match(/total[^\n]*?(\d+(?:\.\d+)?)\s*([KMGTPE]?i?B)/i) ??
    text.match(/(\d+(?:\.\d+)?)\s*([KMGTPE]?i?B)[^\n]*total/i);
  if (!match) return undefined;
  const bytes = decodeSize(match[1]!, match[2]!);
  if (bytes === undefined) return undefined;
  const reclaimable = text.match(/reclaimable[^\n]*?(\d+(?:\.\d+)?)\s*([KMGTPE]?i?B)/i);
  return {
    bytes,
    reclaimableBytes: reclaimable ? decodeSize(reclaimable[1]!, reclaimable[2]!) : undefined,
  };
}

function decodeSize(value: string, unit: string): number | undefined {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const factor: Record<string, number> = {
    B: 1, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4,
    KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4,
  };
  const multiplier = factor[unit.toUpperCase()];
  return multiplier === undefined ? undefined : Math.round(amount * multiplier);
}

function isExactMissingImage(result: CommandResult, reference: string): boolean {
  if (result.stdout.toString().trim() !== "") return false;
  const diagnostic = result.stderr.toString().trim();
  return diagnostic === `Error: No such image: ${reference}` ||
    diagnostic === `Error response from daemon: No such image: ${reference}`;
}

function boundedFinding(code: string, error: unknown): SharedImageGcFinding {
  const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? code;
  return { code, detail: detail.slice(0, 160) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
