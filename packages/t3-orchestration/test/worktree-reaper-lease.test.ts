import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireWorktreeGate,
  assertWorktreeNotLeased,
  cleanLeaseLockPath,
  defaultProcessStartKey,
  holdExclusiveCleanLease,
  isLiveLeaseRecord,
  parseLeaseRecord,
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
      startKey: defaultProcessStartKey(process.pid),
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

  test("reclaims a verified-stale lease whose recorded pid is dead", async () => {
    const root = `/tmp/t3-reaper-lease-${crypto.randomUUID()}`;
    const path = `${root}/worktree`;
    await mkdir(join(root, "worktree-reaper-leases"), { recursive: true });
    await writeFile(cleanLeaseLockPath(path, root), `${JSON.stringify({
      token: "stale",
      threadId: "dead-owner",
      path,
      role: "clean",
      pid: 2147483647,
      startKey: "gone",
      acquiredAt: "now",
    })}\n`);
    expect(await readLiveCleanLease(path, root)).toBeNull();
    const idle = { id: "task", settled: true, deleted: false };
    const lease = await holdExclusiveCleanLease(idle, path, async () => idle, () => false, { home: root, pollMs: 5 });
    expect(await readLiveCleanLease(path, root)).toMatchObject({ threadId: "task", role: "clean", pid: process.pid });
    await lease.release();
  });

  test("reclaims a malformed lock and a reused-pid record without unlinking a replacement", async () => {
    const root = `/tmp/t3-reaper-lease-${crypto.randomUUID()}`;
    const path = `${root}/worktree`;
    await mkdir(join(root, "worktree-reaper-leases"), { recursive: true });
    await writeFile(cleanLeaseLockPath(path, root), "{not-a-lease\n");
    const first = await acquireWorktreeGate(path, "task", "clean", { home: root });
    await first.release();

    await writeFile(cleanLeaseLockPath(path, root), `${JSON.stringify({
      token: "reused",
      threadId: "old",
      path,
      role: "clean",
      pid: process.pid,
      startKey: "not-this-process-start",
      acquiredAt: "now",
    })}\n`);
    expect(await readLiveCleanLease(path, root)).toBeNull();
    const replacement = await acquireWorktreeGate(path, "task", "clean", { home: root });
    const lockPath = cleanLeaseLockPath(path, root);
    const previous = JSON.parse(await Bun.file(lockPath).text()) as { token: string };
    await rm(lockPath);
    await writeFile(lockPath, `${JSON.stringify({
      token: "other-owner",
      threadId: "other",
      path,
      role: "clean",
      pid: process.pid,
      startKey: previous,
      acquiredAt: "now",
    })}\n`);
    await replacement.release();
    const remaining = JSON.parse(await Bun.file(lockPath).text()) as { token: string; threadId: string };
    expect(remaining).toMatchObject({ token: "other-owner", threadId: "other" });
  });

  test("treats a missing startKey as not live even when the pid probe succeeds", async () => {
    const record = parseLeaseRecord({
      token: "legacy",
      threadId: "old-owner",
      path: "/repo/worktree",
      role: "clean",
      pid: process.pid,
      startKey: null,
      acquiredAt: "now",
    });
    expect(record).not.toBeNull();
    expect(isLiveLeaseRecord(record!, {
      processProbe: () => undefined,
      processStartKey: () => "some-other-process",
    })).toBe(false);

    const root = `/tmp/t3-reaper-lease-${crypto.randomUUID()}`;
    const path = `${root}/worktree`;
    await mkdir(join(root, "worktree-reaper-leases"), { recursive: true });
    await writeFile(cleanLeaseLockPath(path, root), `${JSON.stringify({
      token: "legacy",
      threadId: "old-owner",
      path,
      role: "clean",
      pid: process.pid,
      startKey: null,
      acquiredAt: "now",
    })}\n`);
    expect(await readLiveCleanLease(path, root, {
      processProbe: () => undefined,
      processStartKey: () => "some-other-process",
    })).toBeNull();
    const lease = await acquireWorktreeGate(path, "task", "clean", { home: root });
    expect(await readLiveCleanLease(path, root)).toMatchObject({ threadId: "task", pid: process.pid });
    await lease.release();
  });

  test("recovers an orphan reclaim claim instead of stranding the lease", async () => {
    const root = `/tmp/t3-reaper-lease-${crypto.randomUUID()}`;
    const path = `${root}/worktree`;
    const lockPath = cleanLeaseLockPath(path, root);
    await mkdir(join(root, "worktree-reaper-leases"), { recursive: true });
    await writeFile(lockPath, "{not-a-lease\n");
    await writeFile(`${lockPath}.reclaim`, `${JSON.stringify({
      pid: 2147483647,
      startKey: "dead-claimant",
      token: "orphan",
      createdAt: "now",
    })}\n`);
    const lease = await acquireWorktreeGate(path, "task", "clean", { home: root });
    expect(await readLiveCleanLease(path, root)).toMatchObject({ threadId: "task" });
    await lease.release();
  });

  test("stale reclaim does not unlink a replacement lease installed after the identity check", async () => {
    const root = `/tmp/t3-reaper-lease-${crypto.randomUUID()}`;
    const path = `${root}/worktree`;
    const lockPath = cleanLeaseLockPath(path, root);
    await mkdir(join(root, "worktree-reaper-leases"), { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({
      token: "stale",
      threadId: "dead-owner",
      path,
      role: "clean",
      pid: 2147483647,
      startKey: "gone",
      acquiredAt: "now",
    })}\n`);
    const replacement = {
      token: "replacement",
      threadId: "live-owner",
      path,
      role: "clean" as const,
      pid: process.pid,
      startKey: defaultProcessStartKey(process.pid),
      acquiredAt: "now",
    };
    await expect(acquireWorktreeGate(path, "task", "clean", {
      home: root,
      beforeUnlink: async () => {
        await rm(lockPath, { force: true });
        await writeFile(lockPath, `${JSON.stringify(replacement)}\n`);
      },
    })).rejects.toThrow(/reserved for artifact cleanup/);
    expect(JSON.parse(await Bun.file(lockPath).text())).toMatchObject({ token: "replacement", threadId: "live-owner" });
  });
});
