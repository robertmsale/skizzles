import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanupLabLabels } from "../compose/cleanup";
import { defaultDockerRunner, type DockerRunner } from "../compose/docker-runner";
import { internalImageTag } from "../compose/definition";
import { withFileLock } from "../storage/locks";
import { exactDirectoryChain } from "../storage/safe-path";
import { recoverLabSync } from "../workspace/recovery";
import { DEFAULT_LAB_TTL_MS, ownerDirectory, readLab, removeLabState, writeLab, type Clock, type StateRoots } from "../storage/state";
import { boundedRemove } from "./cleanup-utils";

export type ThreadState = "active" | "archived" | "uncertain";
export type RetentionOptions = {
  now?: Clock;
  ttlMs?: number;
  beforeRecheck?: (ownerKey: string) => void | Promise<void>;
};

export function isExpiredActivity(
  value: string | undefined,
  clock: Clock | undefined,
  ttlMs: number | undefined,
): boolean {
  const now = (clock ?? (() => new Date()))();
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  const ttl = ttlMs ?? DEFAULT_LAB_TTL_MS;
  if (!Number.isFinite(nowMs)) throw new Error("retention clock returned an invalid date");
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("retention TTL is invalid");
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return false;
  return nowMs - timestamp > ttl;
}

export async function cleanupExpiredLab(
  roots: StateRoots,
  snapshot: import("../storage/records").LabMetadata,
  docker: DockerRunner,
  database: Database,
  options: RetentionOptions,
  owner: string,
  stateReader: (database: Database, owner: string) => ThreadState,
): Promise<void> {
  await ensureOwnerSafetyDirectories(roots, snapshot.ownerKey);
  const activityLock = join(ownerDirectory(roots.stateRoot, owner), ".locks", `activity-${snapshot.id}`);
  const labLock = join(ownerDirectory(roots.stateRoot, owner), ".locks", `lab-${snapshot.id}`);
  let previous: { state: import("../storage/records").LabMetadata["state"]; updatedAt: string; error?: string } | undefined;
  let claimed: import("../storage/records").LabMetadata | undefined;
  await withFileLock(activityLock, async () => {
    await ensureOwnerSafetyDirectories(roots, snapshot.ownerKey);
    await withFileLock(labLock, async () => {
      await ensureOwnerSafetyDirectories(roots, snapshot.ownerKey);
      const current = await readLab(roots, owner, snapshot.id);
      await validateReaperLab(roots, owner, current.ownerKey, current);
      if (!isExpiredActivity(current.lastActivityAt, options.now, options.ttlMs)) {
        throw new Error("lab activity was refreshed before cleanup");
      }
      let state: ThreadState;
      try { state = stateReader(database, owner); }
      catch { throw new Error("thread row could not be rechecked before cleanup"); }
      if (state !== "active") throw new Error("thread archival state changed before cleanup");
      previous = { state: current.state, updatedAt: current.updatedAt, error: current.error };
      current.state = "destroying";
      current.updatedAt = new Date().toISOString();
      await writeLab(roots, current);
      claimed = current;
    }, { attempts: 600, delayMs: 50 });
    try {
      await options.beforeRecheck?.(snapshot.ownerKey);
      await withFileLock(labLock, async () => {
        await ensureOwnerSafetyDirectories(roots, snapshot.ownerKey);
        const current = await readLab(roots, owner, snapshot.id);
        await validateReaperLab(roots, owner, current.ownerKey, current);
        if (!isExpiredActivity(current.lastActivityAt, options.now, options.ttlMs)) {
          throw new Error("lab activity was refreshed before cleanup");
        }
        let state: ThreadState;
        try { state = stateReader(database, owner); }
        catch { throw new Error("thread row could not be rechecked immediately before cleanup"); }
        if (state !== "active") throw new Error("thread archival state changed before cleanup");
        claimed = current;
      }, { attempts: 600, delayMs: 50 });
      if (!claimed) throw new Error("lab claim disappeared before cleanup");
      await cleanupLabLabels(claimed, claimed.modeKind === "dockerfile", docker);
      await withFileLock(labLock, async () => {
        await ensureOwnerSafetyDirectories(roots, snapshot.ownerKey);
        const current = await readLab(roots, owner, snapshot.id);
        await validateReaperLab(roots, owner, current.ownerKey, current);
        await recoverLabSync(roots, current);
        if (!await exactDirectoryChain(roots.stateRoot, ["owners", current.ownerKey], "owner state directory")) {
          throw new Error("owner state directory disappeared");
        }
        if (!await exactDirectoryChain(roots.stateRoot, ["owners", current.ownerKey, "labs"], "owner labs directory")) {
          throw new Error("owner labs directory disappeared");
        }
        if (await exactDirectoryChain(roots.runtimeRoot, [current.ownerKey, current.id], "lab runtime directory")) {
          await boundedRemove(current.runtimeRoot, 100_000);
        }
        await removeLabState(roots.stateRoot, owner, current.id);
      }, { attempts: 600, delayMs: 50 });
    } catch (error) {
      if (previous) {
        await withFileLock(labLock, async () => {
          try {
            const current = await readLab(roots, owner, snapshot.id);
            if (current.state === "destroying") {
              current.state = previous!.state;
              current.updatedAt = previous!.updatedAt;
              current.error = previous!.error;
              await writeLab(roots, current);
            }
          } catch { /* retain fail-closed if state cannot be read */ }
        }, { attempts: 600, delayMs: 50 });
      }
      throw error;
    }
  }, { attempts: 600, delayMs: 50 });
}

export async function validateReaperLab(
  roots: StateRoots,
  owner: string,
  ownerKey: string,
  lab: import("../storage/records").LabMetadata,
): Promise<void> {
  const expectedRuntime = resolve(roots.runtimeRoot, ownerKey, lab.id);
  if (lab.owner !== owner || lab.ownerKey !== ownerKey || resolve(lab.runtimeRoot) !== expectedRuntime ||
      resolve(lab.workspace) !== join(expectedRuntime, "workspace")) {
    throw new Error("lab ownership or runtime containment is invalid");
  }
  if (lab.modeKind === "dockerfile" && lab.managedImage !== internalImageTag(ownerKey, lab.id)) {
    throw new Error("managed Dockerfile image identity is invalid");
  }
  const runtimePresent = await exactDirectoryChain(
    roots.runtimeRoot,
    [ownerKey, lab.id],
    "lab runtime directory",
  );
  if (runtimePresent) {
    await exactDirectoryChain(
      roots.runtimeRoot,
      [ownerKey, lab.id, "workspace"],
      "lab workspace",
    );
  }
}

export async function ensureGlobalLockDirectory(roots: StateRoots): Promise<void> {
  const path = join(roots.stateRoot, ".locks");
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!await exactDirectoryChain(roots.stateRoot, [".locks"], "global lock directory")) {
    throw new Error("global lock directory disappeared");
  }
}

export async function ensureOwnerSafetyDirectories(roots: StateRoots, ownerKey: string): Promise<void> {
  if (!await exactDirectoryChain(roots.stateRoot, ["owners", ownerKey], "owner state directory")) {
    throw new Error("owner state directory disappeared");
  }
  if (!await exactDirectoryChain(roots.stateRoot, ["owners", ownerKey, "labs"], "owner labs directory")) {
    throw new Error("owner labs directory disappeared");
  }
  const locks = join(roots.stateRoot, "owners", ownerKey, ".locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  if (!await exactDirectoryChain(roots.stateRoot, ["owners", ownerKey, ".locks"], "owner lock directory")) {
    throw new Error("owner lock directory disappeared");
  }
}
