import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAPER_OUTPUT_MAX_BYTES } from "./reaper-cli";
import { ensureOwner, ownerKey } from "./state";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("reaper CLI process output", () => {
  test("clean no-op emits no stdout, even when many active owners are retained", async () => {
    const fixture = await createFixture();
    const database = createThreadsDatabase(fixture.dbPath);
    for (let index = 0; index < 80; index++) {
      const owner = `active-owner-${index}`;
      await ensureOwner(fixture.stateRoot, owner);
      database.run("INSERT INTO threads (id, archived, archived_at) VALUES (?, 0, NULL)", [owner]);
    }
    database.close();

    const result = await runReaper(fixture);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });

  test("cleanup emits only compact counts with a measured serialized ceiling", async () => {
    const fixture = await createFixture();
    const owner = "archived-owner";
    await ensureOwner(fixture.stateRoot, owner);
    const database = createThreadsDatabase(fixture.dbPath);
    database.run("INSERT INTO threads (id, archived, archived_at) VALUES (?, 1, 1)", [owner]);
    database.close();

    const result = await runReaper(fixture);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(REAPER_OUTPUT_MAX_BYTES);
    expect(output).toEqual({ ok: true, cleaned: 1, retained: 0 });
    expect(result.stdout).not.toContain(ownerKey(owner));
    expect(result.stdout).not.toContain(owner);
  });

  test("exceptional output remains bounded and redacts fixture paths and owner keys", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.stateRoot, "owners"), { recursive: true });
    for (let index = 0; index < 300; index++) await mkdir(join(fixture.stateRoot, "owners", `invalid-${index}`));

    const result = await runReaper({ ...fixture, dbPath: join(fixture.root, "missing", "state.sqlite") });
    const output = JSON.parse(result.stdout) as { ok: boolean; cleaned: number; retained: number; issues?: string[] };

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(REAPER_OUTPUT_MAX_BYTES);
    expect(output.ok).toBe(false);
    expect(output.cleaned).toBe(0);
    expect(output.retained).toBe(0);
    expect(output.issues?.length).toBeGreaterThan(0);
    expect(result.stdout).not.toContain(fixture.root);
    expect(result.stdout).not.toMatch(/\b[a-f0-9]{64}\b/i);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "container-lab-reaper-cli-"));
  temporary.push(root);
  return {
    root,
    dbPath: join(root, "state.sqlite"),
    stateRoot: join(root, "state"),
    runtimeRoot: join(root, "runtime"),
  };
}

function createThreadsDatabase(path: string): Database {
  const database = new Database(path);
  database.run("CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER)");
  return database;
}

async function runReaper(fixture: { dbPath: string; stateRoot: string; runtimeRoot: string }) {
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "reaper-cli.ts"),
    "--db", fixture.dbPath,
    "--state-root", fixture.stateRoot,
    "--runtime-root", fixture.runtimeRoot,
  ], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
