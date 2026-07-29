import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeSyncFile, type SyncFile } from "./files";
import { applySync, compareManifests, initializeSyncBaseline, previewSync, recoverSyncTransactions } from "./sync";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function file(pathname: string, hash: string): SyncFile {
  return { path: pathname, kind: "file", sha256: hash, size: 1, mode: 0o644 };
}

async function repo(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporary.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

async function fixture() {
  const source = await repo("container-lab-source-");
  const target = await repo("container-lab-target-");
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "container-lab-state-"));
  temporary.push(stateRoot);
  for (const root of [source, target]) {
    await writeFile(path.join(root, "file.txt"), "base\n");
    execFileSync("git", ["-C", root, "add", "file.txt"]);
  }
  const identity = { stateRoot, labId: "lab-1" };
  await initializeSyncBaseline(identity, target);
  return { source, target, ...identity };
}

describe("three-way comparison", () => {
  test("emits source-only updates and deletes", () => {
    const baseline = { a: file("a", "1"), b: file("b", "1") };
    const result = compareManifests(baseline, { a: file("a", "2") }, baseline);
    expect(result.changes.map(({ path, action }) => [path, action])).toEqual([["a", "upsert"], ["b", "delete"]]);
    expect(result.conflicts).toEqual([]);
  });

  test("reports divergent edits but leaves target-only edits alone", () => {
    const baseline = { a: file("a", "1"), b: file("b", "1") };
    const result = compareManifests(baseline, { a: file("a", "2"), b: baseline.b! }, { a: file("a", "3"), b: file("b", "2") });
    expect(result.conflicts.map(({ path }) => path)).toEqual(["a"]);
    expect(result.changes).toEqual([]);
  });
});

describe("guarded preview and apply", () => {
  test("applies content and mode, persists details, calls the idle guard, and consumes the token", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "updated\n");
    await chmod(path.join(state.source, "file.txt"), 0o755);
    let guarded = 0;
    const preview = await previewSync({ ...state, direction: "push", sourceRoot: state.source, targetRoot: state.target });
    const persisted = JSON.parse(await readFile(path.join(state.stateRoot, "sync", state.labId, "previews", `${preview.token}.json`), "utf8"));
    expect(persisted.changes).toHaveLength(1);

    expect(await applySync({ ...state, direction: "push", sourceRoot: state.source, targetRoot: state.target, token: preview.token, idleGuard: () => { guarded++; } })).toEqual({ applied: 1 });
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe("updated\n");
    expect(guarded).toBe(2);
    await expect(applySync({ ...state, direction: "push", sourceRoot: state.source, targetRoot: state.target, token: preview.token, idleGuard: () => {} })).rejects.toThrow("already-used");
  });

  test("rejects conflicts", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    await writeFile(path.join(state.target, "file.txt"), "target\n");
    const preview = await previewSync({ ...state, direction: "push", sourceRoot: state.source, targetRoot: state.target });
    expect(preview.conflicts.map(({ path }) => path)).toEqual(["file.txt"]);
    await expect(applySync({ ...state, direction: "push", sourceRoot: state.source, targetRoot: state.target, token: preview.token, idleGuard: () => {} })).rejects.toThrow("contains conflicts");
  });

  test("applies deletions and symlinks without following them", async () => {
    const state = await fixture();
    await rm(path.join(state.source, "file.txt"));
    await symlink("destination", path.join(state.source, "link"));
    const base = { ...state, direction: "push" as const, sourceRoot: state.source, targetRoot: state.target };
    const preview = await previewSync(base);
    expect(preview.changes.map(({ path, action }) => [path, action])).toEqual([["file.txt", "delete"], ["link", "upsert"]]);
    await applySync({ ...base, token: preview.token, idleGuard: () => {} });
    expect((await lstat(path.join(state.target, "link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(state.target, "link"))).toBe("destination");
    await expect(lstat(path.join(state.target, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a target parent changed into a symlink after preview", async () => {
    const state = await fixture();
    for (const root of [state.source, state.target]) {
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "nested", "file.txt"), "base\n");
      execFileSync("git", ["-C", root, "add", "nested/file.txt"]);
    }
    await initializeSyncBaseline(state, state.target);
    await writeFile(path.join(state.source, "nested", "file.txt"), "source\n");
    const base = { ...state, direction: "push" as const, sourceRoot: state.source, targetRoot: state.target };
    const preview = await previewSync(base);
    const outside = await mkdtemp(path.join(os.tmpdir(), "container-lab-outside-"));
    temporary.push(outside);
    await rm(path.join(state.target, "nested"), { recursive: true });
    await symlink(outside, path.join(state.target, "nested"));
    await expect(applySync({ ...base, token: preview.token, idleGuard: () => {} })).rejects.toThrow("Unsafe synchronization parent");
  });

  test("rejects stale, expired, direction-mismatched, lab-mismatched, and busy applies", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    const base = { ...state, direction: "push" as const, sourceRoot: state.source, targetRoot: state.target };

    const mismatch = await previewSync(base);
    await expect(applySync({ ...base, direction: "pull", token: mismatch.token, idleGuard: () => {} })).rejects.toThrow("does not match");
    await expect(applySync({ ...base, labId: "other", token: mismatch.token, idleGuard: () => {} })).rejects.toThrow("Unknown");

    const stale = await previewSync(base);
    await writeFile(path.join(state.source, "file.txt"), "changed again\n");
    await expect(applySync({ ...base, token: stale.token, idleGuard: () => {} })).rejects.toThrow("is stale");

    await writeFile(path.join(state.source, "file.txt"), "source\n");
    const expired = await previewSync({ ...base, now: new Date(0) });
    await expect(applySync({ ...base, token: expired.token, now: new Date(300_001), idleGuard: () => {} })).rejects.toThrow("expired");

    const busy = await previewSync(base);
    await expect(applySync({ ...base, token: busy.token, idleGuard: () => false })).rejects.toThrow("idle lab");
  });

  test("does not issue an apply token for a preview too large to expose", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    await expect(previewSync({ ...state, direction: "push", sourceRoot: state.source, targetRoot: state.target, maxEntries: 0 })).rejects.toThrow("reduce the change set");
  });

  test("rejects a target edit racing with staging and preserves it", async () => {
    const state = await fixture();
    await writeFile(path.join(state.source, "file.txt"), "source\n");
    const base = { ...state, direction: "push" as const, sourceRoot: state.source, targetRoot: state.target };
    const preview = await previewSync(base);
    let guards = 0;
    await expect(applySync({
      ...base,
      token: preview.token,
      idleGuard: async () => {
        guards++;
        if (guards === 1) await writeFile(path.join(state.target, "file.txt"), "racing target\n");
      },
    })).rejects.toThrow("target changed after preview");
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe("racing target\n");
  });
});

describe("transaction recovery", () => {
  test("rolls a prepared transaction back from its persisted backup", async () => {
    const state = await fixture();
    const syncRoot = path.join(state.stateRoot, "sync", state.labId);
    const backupDir = path.join(syncRoot, "backups", "crash");
    await mkdir(backupDir, { recursive: true });
    const backup = path.join(backupDir, "0");
    const original = await describeSyncFile(state.target, "file.txt");
    await copyFile(path.join(state.target, "file.txt"), backup);
    await writeFile(path.join(state.target, "file.txt"), "partial write\n");
    const applied = await describeSyncFile(state.target, "file.txt");
    await writeFile(path.join(syncRoot, "journals", "crash.json"), JSON.stringify({
      version: 1,
      state: "prepared",
      targetRoot: state.target,
      baselinePath: path.join(syncRoot, "baseline.json"),
      newBaseline: { version: 1, files: {} },
      backups: [{ path: "file.txt", existed: true, kind: "file", mode: 0o644, backup, original }],
      mutatedPaths: ["file.txt"],
      appliedStates: { "file.txt": applied },
    }));

    expect(await recoverSyncTransactions({ ...state, allowedTargetRoots: [state.target] })).toBe(1);
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe("base\n");
  });

  test("finishes baseline publication for a fully applied transaction", async () => {
    const state = await fixture();
    const syncRoot = path.join(state.stateRoot, "sync", state.labId);
    await writeFile(path.join(syncRoot, "journals", "applied.json"), JSON.stringify({
      version: 1,
      state: "applied",
      targetRoot: state.target,
      baselinePath: path.join(syncRoot, "baseline.json"),
      newBaseline: { version: 1, files: {} },
      backups: [],
      mutatedPaths: [],
      appliedStates: {},
    }));
    expect(await recoverSyncTransactions({ ...state, allowedTargetRoots: [state.target] })).toBe(1);
    expect(JSON.parse(await readFile(path.join(syncRoot, "baseline.json"), "utf8")).files).toEqual({});
  });

  test("preserves a divergent edit made after a crash and retains recovery state", async () => {
    const state = await fixture();
    const syncRoot = path.join(state.stateRoot, "sync", state.labId);
    const backupDir = path.join(syncRoot, "backups", "conflict");
    await mkdir(backupDir, { recursive: true });
    const backup = path.join(backupDir, "0");
    const original = await describeSyncFile(state.target, "file.txt");
    await copyFile(path.join(state.target, "file.txt"), backup);
    await writeFile(path.join(state.target, "file.txt"), "plugin write\n");
    const applied = await describeSyncFile(state.target, "file.txt");
    const journalPath = path.join(syncRoot, "journals", "conflict.json");
    await writeFile(journalPath, JSON.stringify({
      version: 1,
      state: "prepared",
      targetRoot: state.target,
      baselinePath: path.join(syncRoot, "baseline.json"),
      newBaseline: { version: 1, files: {} },
      backups: [{ path: "file.txt", existed: true, kind: "file", mode: 0o644, backup, original }],
      mutatedPaths: ["file.txt"],
      appliedStates: { "file.txt": applied },
    }));
    await writeFile(path.join(state.target, "file.txt"), "user after crash\n");
    await expect(recoverSyncTransactions({ ...state, allowedTargetRoots: [state.target] })).rejects.toThrow("recovery conflict");
    expect(await readFile(path.join(state.target, "file.txt"), "utf8")).toBe("user after crash\n");
    expect((await lstat(journalPath)).isFile()).toBe(true);
  });

  test("rejects journal roots and baseline paths outside the lab allowlist", async () => {
    const state = await fixture();
    const syncRoot = path.join(state.stateRoot, "sync", state.labId);
    const outside = await repo("container-lab-unowned-");
    const journal = {
      version: 1,
      state: "prepared",
      targetRoot: outside,
      baselinePath: path.join(syncRoot, "baseline.json"),
      newBaseline: { version: 1, files: {} },
      backups: [],
      mutatedPaths: [],
      appliedStates: {},
    };
    const journalPath = path.join(syncRoot, "journals", "unsafe.json");
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(recoverSyncTransactions({ ...state, allowedTargetRoots: [state.target] })).rejects.toThrow("not owned");

    journal.targetRoot = state.target;
    journal.baselinePath = path.join(state.stateRoot, "other-baseline.json");
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(recoverSyncTransactions({ ...state, allowedTargetRoots: [state.target] })).rejects.toThrow("does not belong");
  });
});
