import { createHash } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

export type CleanLease = {
  token: string;
  path: string;
  threadId: string;
  signal: AbortSignal;
  release(): Promise<void>;
};

export type CleanLeaseRecord = {
  token: string;
  threadId: string;
  path: string;
  pid: number;
  acquiredAt: string;
};

export function cleanLeaseHome(home = process.env.T3_HOME?.trim() || join(process.env.HOME || homedir(), ".t3")): string {
  return join(home, "worktree-reaper-leases");
}

export function cleanLeaseLockPath(worktreePath: string, home?: string): string {
  const digest = createHash("sha256").update(worktreePath).digest("hex");
  return join(cleanLeaseHome(home), digest);
}

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readLiveCleanLease(worktreePath: string, home?: string): Promise<CleanLeaseRecord | null> {
  const path = cleanLeaseLockPath(worktreePath, home);
  try {
    const raw = JSON.parse(await Bun.file(path).text()) as Partial<CleanLeaseRecord>;
    if (
      typeof raw.token !== "string" || raw.token.trim() === ""
      || typeof raw.threadId !== "string" || raw.threadId.trim() === ""
      || typeof raw.path !== "string" || raw.path.trim() === ""
      || !Number.isInteger(raw.pid) || (raw.pid ?? 0) <= 0
    ) {
      return null;
    }
    if (!isLivePid(raw.pid!)) return null;
    return raw as CleanLeaseRecord;
  } catch {
    return null;
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
  options: { pollMs?: number; now?: () => string; home?: string } = {},
): Promise<CleanLease> {
  const token = crypto.randomUUID();
  const lockPath = cleanLeaseLockPath(path, options.home);
  await mkdir(cleanLeaseHome(options.home), { recursive: true, mode: 0o700 });
  const record: CleanLeaseRecord = {
    token,
    threadId: task.id,
    path,
    pid: process.pid,
    acquiredAt: (options.now ?? (() => new Date().toISOString()))(),
  };
  const candidate = `${lockPath}.candidate-${process.pid}-${token}`;
  await writeFile(candidate, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await link(candidate, lockPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "EEXIST") throw new Error(`worktree ${path} already has a clean lease`);
    throw error;
  } finally {
    await rm(candidate, { force: true });
  }

  const controller = new AbortController();
  let stopped = false;
  const pollMs = options.pollMs ?? 25;
  const watch = (async () => {
    while (!stopped && !controller.signal.aborted) {
      try {
        const current = await readTask(task.id);
        if (isViolated(current)) {
          controller.abort();
          return;
        }
      } catch {
        controller.abort();
        return;
      }
      await Bun.sleep(pollMs);
    }
  })();

  return {
    token,
    path,
    threadId: task.id,
    signal: controller.signal,
    async release() {
      stopped = true;
      if (!controller.signal.aborted) controller.abort();
      await watch.catch(() => undefined);
      await rm(lockPath, { force: true });
    },
  };
}
