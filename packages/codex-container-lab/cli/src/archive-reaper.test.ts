import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { reapArchivedOwners, validateThreadsSchema } from "./archive-reaper";
import type { DockerRunner } from "./docker";
import type { CommandResult, RunOptions } from "./process";
import { ensureOwner, ownerKey, writeLab } from "./state";
import type { LabMetadata } from "./types";
import { withFileLock } from "./locks";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

class EmptyDocker implements DockerRunner {
  calls: string[][] = [];
  async run(args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  spawn(): ChildProcessWithoutNullStreams { throw new Error("reaper never spawns"); }
}

describe("archive reaper", () => {
  test("cleans archived exact owners and retains active and missing rows", async () => {
    const fixture = await roots();
    const archived = await createLabFixture(fixture, "thread-archived");
    await createLabFixture(fixture, "thread-active");
    await createLabFixture(fixture, "thread-missing");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath);
    db.run("INSERT INTO threads VALUES (?, 1, 10)", ["thread-archived"]);
    db.run("INSERT INTO threads VALUES (?, 0, NULL)", ["thread-active"]);
    db.close();
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker });
    expect(result.archivedOwnersCleaned).toEqual([archived.ownerKey]);
    expect(result.retainedOwners).toHaveLength(2);
    expect(docker.calls.every((args) => !args.includes("down"))).toBe(true);
  });

  test("schema mismatch and unavailable database fail closed without Docker", async () => {
    const fixture = await roots();
    await createLabFixture(fixture, "thread-safe");
    const malformed = join(fixture.root, "malformed.sqlite");
    const db = new Database(malformed);
    db.run("CREATE TABLE threads (id TEXT PRIMARY KEY)");
    db.close();
    const docker = new EmptyDocker();
    expect((await reapArchivedOwners({ dbPath: malformed, roots: fixture, docker })).ok).toBe(false);
    expect((await reapArchivedOwners({ dbPath: join(fixture.root, "missing.sqlite"), roots: fixture, docker })).ok).toBe(false);
    expect(docker.calls).toEqual([]);
  });

  test("rechecks immediately and retains an owner whose archive state changes", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-flip");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.close();
    let reads = 0;
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({
      dbPath, roots: fixture, docker,
      stateReader: () => ++reads === 1 ? "archived" : "active",
    });
    expect(result.archivedOwnersCleaned).toEqual([]);
    expect(result.retainedOwners[0]?.ownerKey).toBe(lab.ownerKey);
    expect(docker.calls).toEqual([]);
  });

  test("reads WAL state in place and validates the exact read-only schema", async () => {
    const fixture = await roots();
    const dbPath = join(fixture.root, "wal.sqlite");
    const writer = createDatabase(dbPath);
    writer.run("PRAGMA journal_mode=WAL");
    writer.run("INSERT INTO threads VALUES (?, 0, NULL)", ["thread-active"]);
    const reader = new Database(dbPath, { readonly: true, strict: true });
    expect(() => validateThreadsSchema(reader)).not.toThrow();
    expect(() => reader.run("UPDATE threads SET archived=1")).toThrow();
    reader.close(); writer.close();
  });

  test("a symlinked runtime owner is retained without outside deletion or Docker", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-symlink");
    const ownerRuntime = join(fixture.runtimeRoot, lab.ownerKey);
    const outside = join(fixture.root, "outside");
    await rm(ownerRuntime, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "keep");
    await symlink(outside, ownerRuntime, "dir");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.run("INSERT INTO threads VALUES (?, 1, 10)", [lab.owner]); db.close();
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker });
    expect(result.ok).toBe(false);
    expect(await Bun.file(join(outside, "sentinel")).text()).toBe("keep");
    expect(docker.calls).toEqual([]);
  });

  test("an initial query failure aborts the scan before cleanup", async () => {
    const fixture = await roots();
    await createLabFixture(fixture, "thread-query-error");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.close();
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker, stateReader: () => { throw new Error("busy"); } });
    expect(result.ok).toBe(false);
    expect(result.archivedOwnersCleaned).toEqual([]);
    expect(docker.calls).toEqual([]);
  });

  test("cleanup removes exact containers before waiting for activity, then removes filesystem state", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-active-cleanup");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.run("INSERT INTO threads VALUES (?, 1, 10)", [lab.owner]); db.close();
    const activity = join(fixture.stateRoot, "owners", lab.ownerKey, ".locks", `activity-${lab.id}`);
    let release!: () => void;
    const held = withFileLock(activity, async () => await new Promise<void>((resolve) => { release = resolve; }));
    await Bun.sleep(20);
    const docker = new EmptyDocker();
    let finished = false;
    const reaping = reapArchivedOwners({ dbPath, roots: fixture, docker }).then((result) => { finished = true; return result; });
    for (let attempt = 0; attempt < 100 && docker.calls.length === 0; attempt++) await Bun.sleep(10);
    expect(docker.calls.length).toBeGreaterThan(0);
    expect(finished).toBe(false);
    release();
    await held;
    expect((await reaping).archivedOwnersCleaned).toEqual([lab.ownerKey]);
  });
});

function createDatabase(path: string): Database {
  const db = new Database(path);
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER)");
  return db;
}

async function roots() {
  const root = await mkdtemp(join(tmpdir(), "container-lab-reaper-"));
  temporary.push(root);
  return { root, stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
}

async function createLabFixture(rootsValue: Awaited<ReturnType<typeof roots>>, owner: string): Promise<LabMetadata> {
  await ensureOwner(rootsValue.stateRoot, owner);
  const key = ownerKey(owner);
  const runtimeRoot = join(rootsValue.runtimeRoot, key, "lab-1");
  const sourceRoot = join(rootsValue.root, `${key}-source`);
  await mkdir(join(runtimeRoot, "workspace"), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  const lab: LabMetadata = {
    version: 1, id: "lab-1", name: "lab", owner, ownerKey: key, repoHash: "123456789abc",
    composeProject: "ccl-reaper", state: "failed", sourceRoot, runtimeRoot, workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(sourceRoot, ".codex-container-lab.yaml"), commandService: "dev", modeKind: "image",
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), endpoints: [], findings: [],
  };
  await writeLab(rootsValue, lab);
  return lab;
}
