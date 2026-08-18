import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireWorktreeGate,
  assertWorktreeNotLeased,
  cleanLeaseLockPath,
  holdExclusiveCleanLease,
  readLiveCleanLease,
  withWorktreeGate,
} from "../src/worktree-reaper-lease.ts";

describe("worktree clean lease", () => {
  test("refuses a second exclusive lease on the same worktree", async () => {
    const root = `/tmp/t3-reaper-lease-${crypto.randomUUID()}`;
    const path = `${root}/worktree`;
    const idle = { id: "task", settled: true, deleted: false, archived: false };
    const first = await holdExclusiveCleanLease(idle, path, async () => idle, () => false, { home: root, pollMs: 5 });
    await expect(holdExclusiveCleanLease(idle, path, async () => idle, () => false, { home: root })).rejects.toThrow("reserved for artifact cleanup");
    expect(await readLiveCleanLease(path, root)).toMatchObject({ threadId: "task", path, role: "clean", pid: process.pid });
    await first.release();
    expect(await readLiveCleanLease(path, root)).toBeNull();
    await assertWorktreeNotLeased(path, root);
  });

  test("aborts the lease signal when the task starts running", async () => {
    const root = `/tmp/t3-reaper-lease-${crypto.randomUUID()}`;
    const path = `${root}/worktree`;
    let running = false;
    const lease = await holdExclusiveCleanLease(
      { id: "task", settled: true, deleted: false },
      path,
      async () => ({ id: "task", settled: true, deleted: false, sessionStatus: running ? "running" : "ready" }),
      (current) => current.sessionStatus === "running",
      { home: root, pollMs: 5 },
    );
    running = true;
    const deadline = Date.now() + 500;
    while (!lease.signal.aborted && Date.now() < deadline) await Bun.sleep(5);
    expect(lease.signal.aborted).toBe(true);
    await lease.release();
  });

  test("send-path reservation check fails closed on a live lease", async () => {
    const root = `/tmp/t3-reaper-lease-${crypto.randomUUID()}`;
    const path = `${root}/worktree`;
    await mkdir(join(root, "worktree-reaper-leases"), { recursive: true });
    await writeFile(cleanLeaseLockPath(path, root), `${JSON.stringify({
      token: "tok",
      threadId: "task",
      path,
      role: "clean",
      pid: process.pid,
      acquiredAt: "now",
    })}\n`);
    await expect(assertWorktreeNotLeased(path, root)).rejects.toThrow("reserved for artifact cleanup");
  });

  test("turn-start and clean cannot interleave on the same worktree gate", async () => {
    const root = `/tmp/t3-reaper-lease-${crypto.randomUUID()}`;
    const path = `${root}/worktree`;
    let turnDispatch = 0;
    let cleanAcquiredDuringTurn = false;
    await withWorktreeGate(path, "task-A", "turn-start", async () => {
      turnDispatch += 1;
      try {
        await acquireWorktreeGate(path, "task-A", "clean", { home: root });
        cleanAcquiredDuringTurn = true;
      } catch (error) {
        expect(String(error)).toMatch(/turn start in progress/);
      }
    }, { home: root });
    expect(turnDispatch).toBe(1);
    expect(cleanAcquiredDuringTurn).toBe(false);

    const clean = await acquireWorktreeGate(path, "task-A", "clean", { home: root });
    let turnStarted = false;
    await expect(withWorktreeGate(path, "task-A", "turn-start", async () => {
      turnStarted = true;
    }, { home: root })).rejects.toThrow(/reserved for artifact cleanup/);
    expect(turnStarted).toBe(false);
    await clean.release();
  });
});
