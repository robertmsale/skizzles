import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./locks";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("crash-recoverable file locks", () => {
  test("recovers stale missing and malformed owner records without inspecting an unrelated PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-lock-"));
    temporary.push(root);
    for (const [name, contents] of [["missing", undefined], ["malformed", "{not-json"]] as const) {
      const path = join(root, name);
      await mkdir(path);
      if (contents !== undefined) await writeFile(join(path, "owner.json"), contents);
      let entered = false;
      await withFileLock(path, async () => { entered = true; }, { attempts: 2, delayMs: 0, staleMs: 0 });
      expect(entered).toBe(true);
      expect(await Bun.file(join(path, "owner.json")).exists()).toBe(false);
    }
  });

  test("does not confuse an EEXIST thrown by the protected operation with lock contention", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-lock-operation-"));
    temporary.push(root);
    const error = Object.assign(new Error("operation collision"), { code: "EEXIST" });
    await expect(withFileLock(join(root, "lock"), async () => { throw error; })).rejects.toThrow("operation collision");
  });

  test("does not remove a new lock that replaces the inspected stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-lock-replaced-"));
    temporary.push(root);
    const path = join(root, "lock");
    await writeFile(path, JSON.stringify({ pid: 999_999, createdAt: new Date(0).toISOString() }));
    const replacement = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
    let entered = false;
    await expect(withFileLock(path, async () => { entered = true; }, {
      attempts: 1,
      delayMs: 0,
      staleMs: 0,
      processProbe: () => {
        unlinkSync(path);
        writeFileSync(path, replacement, { mode: 0o600 });
        throw Object.assign(new Error("stale process is absent"), { code: "ESRCH" });
      },
    })).rejects.toThrow("state is busy");
    expect(entered).toBe(false);
    expect(await readFile(path, "utf8")).toBe(replacement);
  });

  test("recovers an orphaned deterministic reclaim claim after its claimant crashed", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-lock-orphan-claim-"));
    temporary.push(root);
    const path = join(root, "lock");
    const stale = (pid: number) => JSON.stringify({ pid, createdAt: new Date(0).toISOString() });
    await writeFile(path, stale(999_991));
    await writeFile(`${path}.reclaim`, stale(999_992));
    let entered = false;

    await withFileLock(path, async () => { entered = true; }, {
      attempts: 2,
      delayMs: 0,
      staleMs: 0,
      processProbe: () => { throw Object.assign(new Error("process is absent"), { code: "ESRCH" }); },
    });

    expect(entered).toBe(true);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await Bun.file(`${path}.reclaim`).exists()).toBe(false);
  });
});
