import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { reapArchivedOwners, validateThreadsSchema } from "./archive";
import { ContainerLabWorkflow } from "../lifecycle/workflow";
import type { DockerRunner } from "../compose/docker-runner";
import type { CommandResult, RunOptions } from "../execution/process";
import { ensureOwner, ownerKey, readLab, writeLab } from "../storage/state";
import type { LabMetadata } from "../storage/records";
import { withFileLock } from "../storage/locks";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

class EmptyDocker implements DockerRunner {
  calls: string[][] = [];
  runCalls: Array<{ args: string[]; options?: RunOptions }> = [];
  async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    this.runCalls.push({ args, options });
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  spawn(): ChildProcessWithoutNullStreams { throw new Error("reaper never spawns"); }
}

class FailingCleanupDocker extends EmptyDocker {
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    if (args[0] === "ps" && args[1] === "-aq") {
      this.calls.push(args);
      this.runCalls.push({ args, options });
      return { code: 0, stdout: Buffer.from("container-1\n"), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "rm" && args[1] === "-f") {
      this.calls.push(args);
      this.runCalls.push({ args, options });
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("failed") };
    }
    return await super.run(args, options);
  }
}

describe("archive reaper", () => {
  test("cleans only individually expired active labs and keeps the owner usable", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-expired");
    lab.lastActivityAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await writeLab(fixture, lab);
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath);
    db.run("INSERT INTO threads VALUES (?, 0, NULL)", [lab.owner]);
    db.close();
    const result = await reapArchivedOwners({
      dbPath, roots: fixture, docker: new EmptyDocker(),
      now: () => new Date("2020-01-09T00:00:00.000Z"),
    });
    expect(result.expiredLabsCleaned).toBe(1);
    expect(result.retainedOwners).toEqual([]);
    expect(await Bun.file(join(fixture.stateRoot, "owners", lab.ownerKey, "labs", `${lab.id}.json`)).exists()).toBe(false);
    expect(await Bun.file(join(fixture.stateRoot, "owners", lab.ownerKey, "owner.json")).exists()).toBe(true);
  });

  test("allows a replacement lab after one active-owner lab expires", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-recreate-after-ttl");
    lab.lastActivityAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await writeLab(fixture, lab);
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.run("INSERT INTO threads VALUES (?, 0, NULL)", [lab.owner]); db.close();
    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker: new EmptyDocker(), now: () => new Date("2020-01-09T00:00:00.000Z") });
    expect(result.expiredLabsCleaned).toBe(1);
    const replacement = await new ContainerLabWorkflow(lab.owner, fixture, new EmptyDocker()).createLab("replacement", process.cwd());
    expect(replacement.labId).not.toBe(lab.id);
    expect(await Bun.file(join(fixture.stateRoot, "owners", lab.ownerKey, "labs", `${replacement.labId}.json`)).exists()).toBe(true);
  });

  test("retains legacy, malformed, and future activity leases", async () => {
    const fixture = await roots();
    const owners = ["thread-legacy", "thread-malformed", "thread-parseable", "thread-equal", "thread-future"];
    const labs: LabMetadata[] = [];
    for (const owner of owners) {
      const lab = await createLabFixture(fixture, owner);
      if (owner.endsWith("malformed")) lab.lastActivityAt = "not-a-timestamp";
      if (owner.endsWith("parseable")) lab.lastActivityAt = "2020-01-01";
      if (owner.endsWith("equal")) lab.lastActivityAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
      if (owner.endsWith("future")) lab.lastActivityAt = new Date("2030-01-01T00:00:00.000Z").toISOString();
      await writeLab(fixture, lab);
      labs.push(lab);
    }
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath);
    for (const lab of labs) db.run("INSERT INTO threads VALUES (?, 0, NULL)", [lab.owner]);
    db.close();
    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker: new EmptyDocker(), now: () => new Date("2020-01-08T00:00:00.000Z") });
    expect(result.expiredLabsCleaned).toBe(0);
    expect(result.retainedOwners).toHaveLength(5);
  });

  test("retains on invalid retention clock", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-invalid-clock");
    lab.lastActivityAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await writeLab(fixture, lab);
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.run("INSERT INTO threads VALUES (?, 0, NULL)", [lab.owner]); db.close();
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker, now: () => new Date(Number.NaN) });
    expect(result.ok).toBe(false);
    expect(result.expiredLabsCleaned).toBe(0);
    expect(docker.calls).toEqual([]);
    expect(await Bun.file(join(fixture.stateRoot, "owners", lab.ownerKey, "labs", `${lab.id}.json`)).exists()).toBe(true);
  });

  test("retains a lab symlink without deleting outside state or calling Docker", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-labs-symlink");
    lab.lastActivityAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await writeLab(fixture, lab);
    const labs = join(fixture.stateRoot, "owners", lab.ownerKey, "labs");
    const outside = join(fixture.root, "outside-labs");
    await rm(labs, { recursive: true });
    await mkdir(outside);
    const sentinel = join(outside, "sentinel.json");
    await writeFile(sentinel, "keep");
    await symlink(outside, labs, "dir");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.run("INSERT INTO threads VALUES (?, 0, NULL)", [lab.owner]); db.close();
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker, now: () => new Date("2020-01-09T00:00:00.000Z") });
    expect(result.ok).toBe(false);
    expect(result.expiredLabsCleaned).toBe(0);
    expect(docker.calls).toEqual([]);
    expect(await Bun.file(sentinel).text()).toBe("keep");
  });

  test("retains a lock-parent symlink without outside mutation or Docker", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-lock-symlink");
    lab.lastActivityAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await writeLab(fixture, lab);
    const lockDirectory = join(fixture.stateRoot, "owners", lab.ownerKey, ".locks");
    const outside = join(fixture.root, "outside-locks");
    await rm(lockDirectory, { recursive: true, force: true });
    await mkdir(outside);
    const sentinel = join(outside, "sentinel");
    await writeFile(sentinel, "keep");
    await symlink(outside, lockDirectory, "dir");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.run("INSERT INTO threads VALUES (?, 0, NULL)", [lab.owner]); db.close();
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker, now: () => new Date("2020-01-09T00:00:00.000Z") });
    expect(result.ok).toBe(false);
    expect(result.expiredLabsCleaned).toBe(0);
    expect(docker.calls).toEqual([]);
    expect(await Bun.file(sentinel).text()).toBe("keep");
  });

  test("retains a global lock-root symlink without outside mutation or Docker", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-global-lock-symlink");
    lab.lastActivityAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await writeLab(fixture, lab);
    const lockRoot = join(fixture.stateRoot, ".locks");
    const outside = join(fixture.root, "outside-global-locks");
    await mkdir(outside);
    const sentinel = join(outside, "sentinel");
    await writeFile(sentinel, "keep");
    await symlink(outside, lockRoot, "dir");
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.run("INSERT INTO threads VALUES (?, 0, NULL)", [lab.owner]); db.close();
    const docker = new EmptyDocker();
    const result = await reapArchivedOwners({ dbPath, roots: fixture, docker, now: () => new Date("2020-01-09T00:00:00.000Z") });
    expect(result.ok).toBe(false);
    expect(result.expiredLabsCleaned).toBe(0);
    expect(docker.calls).toEqual([]);
    expect(await Bun.file(sentinel).text()).toBe("keep");
  });

  test("restores a retryable lab state when TTL Docker cleanup fails", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-cleanup-failure");
    lab.lastActivityAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await writeLab(fixture, lab);
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.run("INSERT INTO threads VALUES (?, 0, NULL)", [lab.owner]); db.close();
    const result = await reapArchivedOwners({
      dbPath, roots: fixture, docker: new FailingCleanupDocker(), now: () => new Date("2020-01-09T00:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    expect(result.expiredLabsCleaned).toBe(0);
    const retained = await readLab(fixture, lab.owner, lab.id);
    expect(retained.state).toBe(lab.state);
    expect(retained.lastActivityAt).toBe(lab.lastActivityAt);
  });

  test("rechecks freshness after taking the activity lock", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-final-freshness");
    lab.lastActivityAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await writeLab(fixture, lab);
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.run("INSERT INTO threads VALUES (?, 0, NULL)", [lab.owner]); db.close();
    const docker = new EmptyDocker();
    let refreshed = false;
    const result = await reapArchivedOwners({
      dbPath, roots: fixture, docker,
      now: () => new Date("2020-01-09T00:00:00.000Z"),
      beforeRecheck: async () => {
        if (refreshed) return;
        refreshed = true;
        await writeLab(fixture, { ...lab, lastActivityAt: new Date("2020-01-08T00:00:00.000Z").toISOString() });
      },
    });
    expect(result.expiredLabsCleaned).toBe(0);
    expect(docker.calls).toEqual([]);
    expect(await Bun.file(join(fixture.stateRoot, "owners", lab.ownerKey, "labs", `${lab.id}.json`)).exists()).toBe(true);
  });

  test("waits for an attached activity lock before any Docker cleanup", async () => {
    const fixture = await roots();
    const lab = await createLabFixture(fixture, "thread-activity-race");
    lab.lastActivityAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await writeLab(fixture, lab);
    const dbPath = join(fixture.root, "state.sqlite");
    const db = createDatabase(dbPath); db.run("INSERT INTO threads VALUES (?, 0, NULL)", [lab.owner]); db.close();
    const activity = join(fixture.stateRoot, "owners", lab.ownerKey, ".locks", `activity-${lab.id}`);
    let release!: () => void;
    const held = withFileLock(activity, async () => await new Promise<void>((resolve) => { release = resolve; }));
    await Bun.sleep(20);
    const docker = new EmptyDocker();
    const reaping = reapArchivedOwners({ dbPath, roots: fixture, docker, now: () => new Date("2020-01-09T00:00:00.000Z") });
    await Bun.sleep(60);
    expect(docker.calls).toEqual([]);
    release();
    await held;
    expect((await reaping).expiredLabsCleaned).toBe(1);
  });

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

  test("cleanup scrubs persisted secret names from every reaper Docker subprocess", async () => {
    const fixture = await roots();
    const secretName = "CODEX_CONTAINER_LAB_REAPER_TEST_SECRET";
    const previous = process.env[secretName];
    process.env[secretName] = "sentinel-reaper-token";
    try {
      const lab = await createLabFixture(fixture, "thread-secret-reaper", [secretName]);
      const dbPath = join(fixture.root, "state.sqlite");
      const db = createDatabase(dbPath);
      db.run("INSERT INTO threads VALUES (?, 1, 10)", [lab.owner]);
      db.close();
      const docker = new EmptyDocker();

      expect((await reapArchivedOwners({ dbPath, roots: fixture, docker })).archivedOwnersCleaned).toEqual([lab.ownerKey]);
      expect(docker.runCalls.length).toBeGreaterThan(0);
      expect(docker.runCalls.every((call) => !Object.hasOwn(call.options?.env ?? {}, secretName))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env[secretName];
      else process.env[secretName] = previous;
    }
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

async function createLabFixture(
  rootsValue: Awaited<ReturnType<typeof roots>>,
  owner: string,
  secretEnvironment: string[] = [],
): Promise<LabMetadata> {
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
    secretEnvironment,
  };
  await writeLab(rootsValue, lab);
  return lab;
}
