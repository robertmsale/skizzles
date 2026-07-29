import { link, lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

type LockRecord = { pid: number; createdAt: string };
type LockIdentity = { dev: bigint; ino: bigint };

export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    delayMs?: number;
    staleMs?: number;
    processProbe?: (pid: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 100;
  const delayMs = options.delayMs ?? 50;
  const staleMs = options.staleMs ?? 5 * 60_000;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.signal?.aborted) throw new Error("operation was cancelled while waiting for a state lock");
    const candidate = `${path}.candidate-${process.pid}-${crypto.randomUUID()}`;
    let acquired = false;
    try {
      await writeFile(candidate, JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      } satisfies LockRecord), { mode: 0o600, flag: "wx" });
      try {
        // Linking a complete candidate record is atomic and never replaces an
        // existing lock, eliminating the mkdir-before-owner-record crash gap.
        await link(candidate, path);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" &&
            (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      }
      if (acquired) {
        const candidateInfo = await lstat(candidate, { bigint: true });
        const candidateIdentity = identity(candidateInfo);
        try { return await operation(); }
        finally {
          await claimAndRemoveLock(
            path, candidateIdentity, candidate, candidateIdentity,
            staleMs, options.processProbe ?? probeProcess,
          );
        }
      }
    } finally {
      await rm(candidate, { force: true });
    }
    await removeConfirmedStaleLock(path, staleMs, options.processProbe ?? probeProcess);
    if (attempt + 1 < attempts) {
      if (options.signal?.aborted) throw new Error("operation was cancelled while waiting for a state lock");
      await Bun.sleep(delayMs);
    }
  }
  throw new Error("state is busy; another process holds the operation lock");
}

async function removeConfirmedStaleLock(
  path: string,
  staleMs: number,
  processProbe: (pid: number) => void,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    try { handle = await open(path, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const info = await handle.stat({ bigint: true });
    const inspectedIdentity = identity(info);
    if (inspectedIdentity === undefined) return;
    let record: LockRecord | undefined;
    try {
      const contents = info.isDirectory()
        ? await readFile(`${path}/owner.json`, "utf8")
        : await handle.readFile({ encoding: "utf8" });
      const value = JSON.parse(contents) as unknown;
      if (isRecord(value) && typeof value.pid === "number" && Number.isInteger(value.pid) &&
          value.pid > 0 && typeof value.createdAt === "string") {
        record = value as LockRecord;
      }
    } catch {
      // A legacy lock with a missing or malformed record is reclaimable only
      // after its directory itself is stale and its exact identity is rechecked.
    }
    if (record === undefined) {
      if (Date.now() - Number(info.mtimeMs) < staleMs) return;
      await reclaimSameLock(path, inspectedIdentity, staleMs, processProbe);
      return;
    }
    const age = Date.now() - Date.parse(record.createdAt);
    if (!Number.isFinite(age) || age < staleMs) return;
    try {
      processProbe(record.pid);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
    }
    await reclaimSameLock(path, inspectedIdentity, staleMs, processProbe);
  } finally {
    await handle?.close();
  }
}

async function reclaimSameLock(
  path: string,
  inspected: LockIdentity,
  staleMs: number,
  processProbe: (pid: number) => void,
): Promise<void> {
  const candidate = `${path}.reclaim-candidate-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(candidate, JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    } satisfies LockRecord), { mode: 0o600, flag: "wx" });
    const candidateIdentity = identity(await lstat(candidate, { bigint: true }));
    await claimAndRemoveLock(path, inspected, candidate, candidateIdentity, staleMs, processProbe);
  } finally {
    await rm(candidate, { force: true });
  }
}

async function claimAndRemoveLock(
  path: string,
  inspected: LockIdentity | undefined,
  claimSource: string,
  claimIdentity: LockIdentity | undefined,
  staleMs: number,
  processProbe: (pid: number) => void,
): Promise<void> {
  if (inspected === undefined || claimIdentity === undefined) return;
  const claimPath = `${path}.reclaim`;
  let claimed = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // The deterministic claim serializes every operational unlink. Only the
        // process that linked its complete candidate here may remove the lock.
        await link(claimSource, claimPath);
        claimed = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" &&
            (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
        if (attempt > 0 || !await removeConfirmedOrphanClaim(claimPath, staleMs, processProbe)) return;
      }
    }
    if (!claimed) return;
    if (!await hasIdentity(claimPath, claimIdentity) || !await hasIdentity(path, inspected)) return;
    await rm(path, { recursive: true, force: true });
  } finally {
    // A crashed claimant fails closed. Cleanup here is limited to this exact
    // claim inode and never falls back to removing the operational lock.
    if (claimed) await removeIfSamePath(claimPath, claimIdentity);
  }
}

async function removeConfirmedOrphanClaim(
  claimPath: string,
  staleMs: number,
  processProbe: (pid: number) => void,
): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    try { handle = await open(claimPath, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const info = await handle.stat({ bigint: true });
    const inspected = identity(info);
    if (inspected === undefined || info.isDirectory()) return false;
    let value: unknown;
    try { value = JSON.parse(await handle.readFile({ encoding: "utf8" })); }
    catch { return false; }
    if (!isRecord(value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 ||
        typeof value.createdAt !== "string") return false;
    const age = Date.now() - Date.parse(value.createdAt);
    if (!Number.isFinite(age) || age < staleMs) return false;
    try {
      processProbe(value.pid);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    await handle.close();
    handle = undefined;
    await removeIfSamePath(claimPath, inspected);
    return !await hasIdentity(claimPath, inspected);
  } finally {
    await handle?.close();
  }
}

async function hasIdentity(path: string, expected: LockIdentity): Promise<boolean> {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const currentIdentity = identity(current);
  return currentIdentity !== undefined && currentIdentity.dev === expected.dev && currentIdentity.ino === expected.ino;
}

async function removeIfSamePath(path: string, inspected: LockIdentity): Promise<void> {
  if (!await hasIdentity(path, inspected)) return;
  await rm(path, { recursive: true, force: true });
}

function identity(info: { dev: bigint; ino: bigint }): LockIdentity | undefined {
  if (info.dev < 0n || info.ino <= 0n) return undefined;
  return { dev: info.dev, ino: info.ino };
}

function probeProcess(pid: number): void {
  process.kill(pid, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
