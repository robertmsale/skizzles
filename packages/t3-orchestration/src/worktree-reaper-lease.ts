import { createHash } from "node:crypto";
import { link, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type LockIdentity = { dev: bigint; ino: bigint };

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
  if (!isLivePid(record.pid, processProbe)) return false;
  const currentStart = processStartKey(record.pid);
  if (currentStart === null) return false;
  if (record.startKey && record.startKey !== currentStart) return false;
  return true;
}

function lockIdentity(info: { dev: bigint; ino: bigint }): LockIdentity | undefined {
  if (info.dev < 0n || info.ino <= 0n) return undefined;
  return { dev: info.dev, ino: info.ino };
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

async function reclaimStaleLock(lockPath: string, inspected: LockIdentity): Promise<boolean> {
  const token = crypto.randomUUID();
  const candidate = `${lockPath}.reclaim-candidate-${process.pid}-${token}`;
  const claimPath = `${lockPath}.reclaim`;
  await writeFile(candidate, `${JSON.stringify({ pid: process.pid, token })}\n`, { mode: 0o600, flag: "wx" });
  const candidateIdentity = lockIdentity(await lstat(candidate, { bigint: true }));
  let claimed = false;
  try {
    if (!candidateIdentity) return false;
    try {
      await link(candidate, claimPath);
      claimed = true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "EEXIST" || code === "ENOTEMPTY") return false;
      throw error;
    }
    if (!await hasIdentity(claimPath, candidateIdentity) || !await hasIdentity(lockPath, inspected)) {
      return false;
    }
    await rm(lockPath, { force: true });
    return !await hasIdentity(lockPath, inspected);
  } finally {
    await rm(candidate, { force: true });
    if (claimed && candidateIdentity) {
      if (await hasIdentity(claimPath, candidateIdentity)) await rm(claimPath, { force: true });
    }
  }
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
  options: { now?: () => string; home?: string } & LeaseProcessFns = {},
): Promise<CleanLease> {
  const token = crypto.randomUUID();
  const lockPath = cleanLeaseLockPath(path, options.home);
  await mkdir(cleanLeaseHome(options.home), { recursive: true, mode: 0o700 });
  const processStartKey = options.processStartKey ?? defaultProcessStartKey;
  const record: CleanLeaseRecord = {
    token,
    threadId,
    path,
    role,
    pid: process.pid,
    startKey: processStartKey(process.pid),
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
      const reclaimed = await reclaimStaleLock(lockPath, inspected.identity);
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
        const current = parseLeaseRecord(JSON.parse(await Bun.file(lockPath).text()));
        if (!current || current.token !== token) return;
        if (!await hasIdentity(lockPath, heldIdentity)) return;
        await rm(lockPath, { force: true });
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
