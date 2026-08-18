import { createHash } from "node:crypto";
import { link, lstat, mkdir, open, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type LockIdentity = { dev: bigint; ino: bigint };

export type CleanLeaseTask = {
  id: string;
  projectId?: string;
  phase?: string;
  sessionStatus?: string | null;
  latestTurnState?: string | null;
  backgroundLiveness?: "working" | "monitoring" | "unknown" | null;
  archived?: boolean;
  deleted?: boolean;
  settled?: boolean;
  branch?: string | null;
  worktreePath?: string | null;
  workspaceRoot?: string | null;
};

export type WorktreeGateRole = "clean" | "turn-start";

export type CleanLease = {
  token: string;
  path: string;
  threadId: string;
  role: WorktreeGateRole;
  signal: AbortSignal;
  abort(): void;
  release(): Promise<void>;
};

export type CleanLeaseRecord = {
  token: string;
  threadId: string;
  path: string;
  role: WorktreeGateRole;
  pid: number;
  startKey: string | null;
  acquiredAt: string;
};

export type LeaseProcessFns = {
  processProbe?: (pid: number) => void;
  processStartKey?: (pid: number) => string | null;
};

export function cleanLeaseHome(home = process.env.T3_HOME?.trim() || join(process.env.HOME || homedir(), ".t3")): string {
  return join(home, "worktree-reaper-leases");
}

export function cleanLeaseLockPath(worktreePath: string, home?: string): string {
  const digest = createHash("sha256").update(worktreePath).digest("hex");
  return join(cleanLeaseHome(home), digest);
}

export function defaultProcessProbe(pid: number): void {
  process.kill(pid, 0);
}

export function defaultProcessStartKey(pid: number): string | null {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  const text = result.stdout.toString().trim();
  return text || null;
}

function isLivePid(pid: number, processProbe: (pid: number) => void): boolean {
  try {
    processProbe(pid);
    return true;
  } catch {
    return false;
  }
}

export function parseLeaseRecord(value: unknown): CleanLeaseRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CleanLeaseRecord>;
  if (
    typeof raw.token !== "string" || raw.token.trim() === ""
    || typeof raw.threadId !== "string" || raw.threadId.trim() === ""
    || typeof raw.path !== "string" || raw.path.trim() === ""
    || (raw.role !== "clean" && raw.role !== "turn-start")
    || !Number.isInteger(raw.pid) || (raw.pid ?? 0) <= 0
  ) {
    return null;
  }
  return {
    token: raw.token,
    threadId: raw.threadId,
    path: raw.path,
    role: raw.role,
    pid: raw.pid!,
    startKey: typeof raw.startKey === "string" || raw.startKey === null ? raw.startKey : null,
    acquiredAt: typeof raw.acquiredAt === "string" ? raw.acquiredAt : "",
  };
}

export function isLiveLeaseRecord(
  record: CleanLeaseRecord,
  fns: LeaseProcessFns = {},
): boolean {
  const processProbe = fns.processProbe ?? defaultProcessProbe;
  const processStartKey = fns.processStartKey ?? defaultProcessStartKey;
  if (typeof record.startKey !== "string" || record.startKey.trim() === "") return false;
  if (!isLivePid(record.pid, processProbe)) return false;
  const currentStart = processStartKey(record.pid);
  if (currentStart === null || currentStart !== record.startKey) return false;
  return true;
}

function lockIdentity(info: { dev: bigint; ino: bigint }): LockIdentity | undefined {
  if (info.dev < 0n || info.ino <= 0n) return undefined;
  return { dev: info.dev, ino: info.ino };
}

function sameLockIdentity(left: LockIdentity | undefined, right: LockIdentity | undefined): boolean {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

async function hasIdentity(path: string, expected: LockIdentity): Promise<boolean> {
  try {
    const current = lockIdentity(await lstat(path, { bigint: true }));
    return Boolean(current && current.dev === expected.dev && current.ino === expected.ino);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readLiveCleanLease(
  worktreePath: string,
  home?: string,
  fns: LeaseProcessFns = {},
): Promise<CleanLeaseRecord | null> {
  const path = cleanLeaseLockPath(worktreePath, home);
  try {
    const record = parseLeaseRecord(JSON.parse(await Bun.file(path).text()));
    if (!record || !isLiveLeaseRecord(record, fns)) return null;
    return record;
  } catch {
    return null;
  }
}

async function inspectLock(
  lockPath: string,
  fns: LeaseProcessFns,
): Promise<{ identity: LockIdentity | undefined; record: CleanLeaseRecord | null; live: boolean }> {
  try {
    const identity = lockIdentity(await lstat(lockPath, { bigint: true }));
    let record: CleanLeaseRecord | null = null;
    try {
      record = parseLeaseRecord(JSON.parse(await Bun.file(lockPath).text()));
    } catch {
      record = null;
    }
    return { identity, record, live: Boolean(record && isLiveLeaseRecord(record, fns)) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return { identity: undefined, record: null, live: false };
    }
    throw error;
  }
}

type ReclaimClaimRecord = {
  pid: number;
  startKey: string | null;
  token: string;
  createdAt: string;
};

function reclaimClaimPath(lockPath: string): string {
  return `${lockPath}.reclaim`;
}

function parseReclaimClaim(value: unknown): ReclaimClaimRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ReclaimClaimRecord>;
  if (
    !Number.isInteger(raw.pid) || (raw.pid ?? 0) <= 0
    || typeof raw.token !== "string" || raw.token.trim() === ""
    || typeof raw.createdAt !== "string"
  ) {
    return null;
  }
  return {
    pid: raw.pid!,
    startKey: typeof raw.startKey === "string" ? raw.startKey : null,
    token: raw.token,
    createdAt: raw.createdAt,
  };
}

function isLiveReclaimClaim(record: ReclaimClaimRecord, fns: LeaseProcessFns): boolean {
  return isLiveLeaseRecord({
    token: record.token,
    threadId: "reclaim",
    path: "reclaim",
    role: "clean",
    pid: record.pid,
    startKey: record.startKey,
    acquiredAt: record.createdAt,
  }, fns);
}

export async function inspectPathIdentity(path: string): Promise<LockIdentity | undefined> {
  try {
    return lockIdentity(await lstat(path, { bigint: true }));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function unlinkIfSameIdentity(
  path: string,
  inspected: LockIdentity,
  hooks: {
    afterStat?: () => Promise<void>;
    afterMoved?: (trash: string) => Promise<void>;
    afterVerified?: (trash: string) => Promise<void>;
    afterMismatch?: (trash: string) => Promise<void>;
  } = {},
): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  try {
    const opened = lockIdentity(await handle.stat({ bigint: true }));
    if (!opened || opened.dev !== inspected.dev || opened.ino !== inspected.ino) return false;
    if (hooks.afterStat) await hooks.afterStat();
    const trash = `${path}.unlinking-${process.pid}-${crypto.randomUUID()}`;
    try {
      await rename(path, trash);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    const movedAtRename = await inspectOpenIdentity(trash);
    if (hooks.afterMoved) await hooks.afterMoved(trash);
    if (!sameLockIdentity(movedAtRename, inspected)) {
      if (hooks.afterMismatch) await hooks.afterMismatch(trash);
      await restoreNamedIdentity(trash, path, movedAtRename);
      return false;
    }
    if (hooks.afterVerified) await hooks.afterVerified(trash);
    const stillMoved = await inspectOpenIdentity(trash);
    if (!sameLockIdentity(stillMoved, inspected)) {
      return false;
    }
    await disposeNamedIdentity(trash, inspected);
    return true;
  } finally {
    await handle.close();
  }
}

async function restoreNamedIdentity(
  source: string,
  destination: string,
  expected: LockIdentity | undefined,
): Promise<void> {
  if (!expected) return;
  const current = await inspectOpenIdentity(source);
  if (!sameLockIdentity(current, expected)) return;
  try {
    await link(source, destination);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "EEXIST") throw error;
    return;
  }
  const published = await inspectOpenIdentity(destination);
  if (!sameLockIdentity(published, expected)) return;
  const stillSource = await inspectOpenIdentity(source);
  if (sameLockIdentity(stillSource, expected)) {
    await disposeNamedIdentity(source, expected);
  }
}

async function disposeNamedIdentity(path: string, inspected: LockIdentity): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return true;
    }
    throw error;
  }
  try {
    const opened = lockIdentity(await handle.stat({ bigint: true }));
    if (!sameLockIdentity(opened, inspected)) return false;
    const secret = `${path}.gc-${process.pid}-${crypto.randomUUID()}`;
    try {
      await rename(path, secret);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        return true;
      }
      throw error;
    }
    const moved = await inspectOpenIdentity(secret);
    if (!sameLockIdentity(moved, inspected)) {
      try {
        await link(secret, path);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
        if (code !== "EEXIST") throw error;
      }
      return false;
    }
    const held = lockIdentity(await handle.stat({ bigint: true }));
    const named = await inspectOpenIdentity(secret);
    if (!sameLockIdentity(held, inspected) || !sameLockIdentity(named, inspected) || !held) {
      return false;
    }
    try {
      await unlink(secret);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        return true;
      }
      throw error;
    }
    return true;
  } finally {
    await handle.close();
  }
}

async function inspectOpenIdentity(path: string): Promise<LockIdentity | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    return lockIdentity(await handle.stat({ bigint: true }));
  } finally {
    await handle.close();
  }
}

async function recoverOrphanReclaimClaim(lockPath: string, fns: LeaseProcessFns): Promise<boolean> {
  const claimPath = reclaimClaimPath(lockPath);
  try {
    const identity = lockIdentity(await lstat(claimPath, { bigint: true }));
    if (!identity) return false;
    let record: ReclaimClaimRecord | null = null;
    try {
      record = parseReclaimClaim(JSON.parse(await Bun.file(claimPath).text()));
    } catch {
      record = null;
    }
    if (record && isLiveReclaimClaim(record, fns)) return false;
    return await unlinkIfSameIdentity(claimPath, identity);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

export async function withReclaimMutex<T>(
  lockPath: string,
  fn: () => Promise<T>,
  fns: LeaseProcessFns = {},
  hooks: { beforeUnlink?: () => Promise<void> } = {},
): Promise<T> {
  const token = crypto.randomUUID();
  const claimPath = reclaimClaimPath(lockPath);
  const processStartKey = fns.processStartKey ?? defaultProcessStartKey;
  const startKey = processStartKey(process.pid);
  if (typeof startKey !== "string" || startKey.trim() === "") {
    throw new Error("could not record process start key for worktree lease reclaim");
  }
  const record: ReclaimClaimRecord = {
    pid: process.pid,
    startKey,
    token,
    createdAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    await recoverOrphanReclaimClaim(lockPath, fns);
    const candidate = `${claimPath}.candidate-${process.pid}-${token}-${attempt}`;
    await writeFile(candidate, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    const candidateIdentity = lockIdentity(await lstat(candidate, { bigint: true }));
    let claimed = false;
    try {
      if (!candidateIdentity) throw new Error("could not identity a reclaim claim candidate");
      try {
        await link(candidate, claimPath);
        claimed = true;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
        if (code === "EEXIST" || code === "ENOTEMPTY") {
          if (attempt === 2) throw new Error(`worktree lease reclaim is busy at ${lockPath}`);
          continue;
        }
        throw error;
      }
      if (!await hasIdentity(claimPath, candidateIdentity)) {
        if (attempt === 2) throw new Error(`worktree lease reclaim is busy at ${lockPath}`);
        continue;
      }
      if (hooks.beforeUnlink) await hooks.beforeUnlink();
      return await fn();
    } finally {
      await rm(candidate, { force: true });
      if (claimed && candidateIdentity) await unlinkIfSameIdentity(claimPath, candidateIdentity);
    }
  }
  throw new Error(`worktree lease reclaim is busy at ${lockPath}`);
}

async function reclaimStaleLock(
  lockPath: string,
  inspected: LockIdentity,
  fns: LeaseProcessFns,
  hooks: { beforeUnlink?: () => Promise<void> } = {},
): Promise<boolean> {
  return await withReclaimMutex(lockPath, async () => {
    if (!await hasIdentity(lockPath, inspected)) return false;
    return await unlinkIfSameIdentity(lockPath, inspected);
  }, fns, hooks);
}

function reservationError(path: string, existing: CleanLeaseRecord | null, requested: WorktreeGateRole): Error {
  if (existing?.role === "clean" || (existing == null && requested === "clean")) {
    return new Error(
      existing
        ? `worktree ${path} is reserved for artifact cleanup by task ${existing.threadId}`
        : `worktree ${path} already has a clean lease`,
    );
  }
  if (existing?.role === "turn-start") {
    return new Error(`worktree ${path} has a turn start in progress for task ${existing.threadId}`);
  }
  return new Error(`worktree ${path} already has a clean lease`);
}

export async function acquireWorktreeGate(
  path: string,
  threadId: string,
  role: WorktreeGateRole,
  options: { now?: () => string; home?: string; beforeUnlink?: () => Promise<void> } & LeaseProcessFns = {},
): Promise<CleanLease> {
  const token = crypto.randomUUID();
  const lockPath = cleanLeaseLockPath(path, options.home);
  await mkdir(cleanLeaseHome(options.home), { recursive: true, mode: 0o700 });
  const processStartKey = options.processStartKey ?? defaultProcessStartKey;
  const startKey = processStartKey(process.pid);
  if (typeof startKey !== "string" || startKey.trim() === "") {
    throw new Error("could not record process start key for worktree lease");
  }
  const record: CleanLeaseRecord = {
    token,
    threadId,
    path,
    role,
    pid: process.pid,
    startKey,
    acquiredAt: (options.now ?? (() => new Date().toISOString()))(),
  };
  const fns: LeaseProcessFns = {
    processProbe: options.processProbe,
    processStartKey: options.processStartKey,
  };
  let acquiredIdentity: LockIdentity | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = `${lockPath}.candidate-${process.pid}-${token}-${attempt}`;
    await writeFile(candidate, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await link(candidate, lockPath);
      acquiredIdentity = lockIdentity(await lstat(lockPath, { bigint: true }));
      break;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code !== "EEXIST") throw error;
      const inspected = await inspectLock(lockPath, fns);
      if (inspected.live) throw reservationError(path, inspected.record, role);
      if (!inspected.identity) {
        if (attempt === 2) throw reservationError(path, inspected.record, role);
        continue;
      }
      const reclaimed = await reclaimStaleLock(lockPath, inspected.identity, fns, { beforeUnlink: options.beforeUnlink });
      if (!reclaimed && attempt === 2) throw reservationError(path, await readLiveCleanLease(path, options.home, fns), role);
    } finally {
      await rm(candidate, { force: true });
    }
  }
  if (!acquiredIdentity) throw reservationError(path, await readLiveCleanLease(path, options.home, fns), role);
  const heldIdentity = acquiredIdentity;
  const controller = new AbortController();
  return {
    token,
    path,
    threadId,
    role,
    signal: controller.signal,
    abort() {
      if (!controller.signal.aborted) controller.abort();
    },
    async release() {
      if (!controller.signal.aborted) controller.abort();
      try {
        await withReclaimMutex(lockPath, async () => {
          const current = parseLeaseRecord(JSON.parse(await Bun.file(lockPath).text()));
          if (!current || current.token !== token) return;
          if (!await hasIdentity(lockPath, heldIdentity)) return;
          await unlinkIfSameIdentity(lockPath, heldIdentity);
        }, fns);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return;
        if (error instanceof SyntaxError) return;
      }
    },
  };
}

export async function withWorktreeGate<T>(
  path: string,
  threadId: string,
  role: WorktreeGateRole,
  fn: (gate: CleanLease) => Promise<T>,
  options: { now?: () => string; home?: string } & LeaseProcessFns = {},
): Promise<T> {
  const gate = await acquireWorktreeGate(path, threadId, role, options);
  try {
    return await fn(gate);
  } finally {
    await gate.release();
  }
}

export async function assertWorktreeNotLeased(worktreePath: string | null | undefined, home?: string): Promise<void> {
  const path = worktreePath?.trim();
  if (!path) return;
  const lease = await readLiveCleanLease(path, home);
  if (lease) {
    throw new Error(`worktree ${path} is reserved for artifact cleanup by task ${lease.threadId}`);
  }
}

export async function holdExclusiveCleanLease(
  task: CleanLeaseTask,
  path: string,
  readTask: (threadId: string) => Promise<CleanLeaseTask>,
  isViolated: (current: CleanLeaseTask) => boolean,
  options: { pollMs?: number; now?: () => string; home?: string } & LeaseProcessFns = {},
): Promise<CleanLease> {
  const gate = await acquireWorktreeGate(path, task.id, "clean", options);
  let stopped = false;
  const pollMs = options.pollMs ?? 25;
  const watch = (async () => {
    while (!stopped && !gate.signal.aborted) {
      try {
        const current = await readTask(task.id);
        if (isViolated(current)) {
          gate.abort();
          return;
        }
      } catch {
        gate.abort();
        return;
      }
      await Bun.sleep(pollMs);
    }
  })();

  return {
    ...gate,
    async release() {
      stopped = true;
      await watch.catch(() => undefined);
      await gate.release();
    },
  };
}
