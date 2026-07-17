import { Database } from "bun:sqlite";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DockerRunner } from "./docker";
import { cleanupLabLabels, defaultDockerRunner } from "./docker";
import { internalImageTag } from "./compose";
import { withFileLock } from "./locks";
import { recoverLabSync } from "./service";
import {
  listLabs, markOwnerReaped, ownerDirectory, ownerLockPath, readLab,
  readOwnerManifest, removeLabState, resolveRoots, writeLab, type StateRoots,
} from "./state";

type ThreadState = "active" | "archived" | "uncertain";

export type ReaperResult = {
  ok: boolean;
  archivedOwnersCleaned: string[];
  retainedOwners: Array<{ ownerKey: string; reason: string }>;
  errors: string[];
};

export type ReaperOptions = {
  dbPath: string;
  roots?: StateRoots;
  docker?: DockerRunner;
  beforeOwnerLock?: (ownerKey: string) => void | Promise<void>;
  beforeRecheck?: (ownerKey: string) => void | Promise<void>;
  stateReader?: (database: Database, owner: string) => ThreadState;
};

export async function reapArchivedOwners(options: ReaperOptions): Promise<ReaperResult> {
  const roots = options.roots ?? resolveRoots();
  const result: ReaperResult = { ok: true, archivedOwnersCleaned: [], retainedOwners: [], errors: [] };
  let database: Database | undefined;
  try {
    database = new Database(options.dbPath, { readonly: true, strict: true, safeIntegers: true });
    validateThreadsSchema(database);
  } catch (error) {
    database?.close();
    return {
      ok: false,
      archivedOwnersCleaned: [],
      retainedOwners: [],
      errors: [boundedMessage("Codex state database unavailable or incompatible", error)],
    };
  }
  try {
    const ownerRoot = join(roots.stateRoot, "owners");
    if (!await exactDirectoryChain(roots.stateRoot, ["owners"], "owner state root")) return result;
    let entries;
    try { entries = await readdir(ownerRoot, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
      throw error;
    }
    if (entries.length > 10_000) throw new Error("owner state exceeds bounded scan limit");
    const preflight: Array<{ owner: Awaited<ReturnType<typeof readOwnerManifest>>; state: ThreadState }> = [];
    for (const entry of entries) {
      const fallbackKey = /^[a-f0-9]{64}$/.test(entry.name) ? entry.name : "invalid";
      if (!entry.isDirectory()) {
        result.retainedOwners.push({ ownerKey: fallbackKey, reason: "invalid owner state entry" });
        result.ok = false;
        continue;
      }
      let owner: Awaited<ReturnType<typeof readOwnerManifest>>;
      try {
        if (!await exactDirectoryChain(roots.stateRoot, ["owners", entry.name], "owner state directory")) {
          throw new Error("owner state directory disappeared");
        }
        owner = await readOwnerManifest(join(ownerRoot, entry.name, "owner.json"));
      }
      catch (error) {
        result.retainedOwners.push({ ownerKey: fallbackKey, reason: "invalid owner manifest" });
        result.ok = false;
        continue;
      }
      let initial: ThreadState;
      try { initial = (options.stateReader ?? queryThreadState)(database, owner.owner); }
      catch (error) {
        return {
          ok: false,
          archivedOwnersCleaned: [],
          retainedOwners: [],
          errors: [boundedMessage("Codex state database query failed; no cleanup performed", error)],
        };
      }
      preflight.push({ owner, state: initial });
    }
    for (const { owner, state: initial } of preflight) {
      if (initial !== "archived") {
        result.retainedOwners.push({
          ownerKey: owner.ownerKey,
          reason: initial === "active" ? "thread is active" : "thread row is missing or inconsistent",
        });
        continue;
      }
      try {
        await options.beforeOwnerLock?.(owner.ownerKey);
        await withFileLock(ownerLockPath(roots.stateRoot, owner.owner), async () => {
          if (!await exactDirectoryChain(roots.stateRoot, ["owners", owner.ownerKey], "owner state directory")) {
            throw new Error("owner state directory disappeared");
          }
          const currentOwner = await readOwnerManifest(join(ownerRoot, owner.ownerKey, "owner.json"));
          if (currentOwner.owner !== owner.owner || currentOwner.ownerKey !== owner.ownerKey ||
              currentOwner.createdAt !== owner.createdAt) {
            throw new Error("owner state changed before archive cleanup");
          }
          const labs = await listLabs(roots, owner.owner);
          for (const lab of labs) await validateReaperLab(roots, owner.owner, owner.ownerKey, lab);
          for (const lab of labs) {
            await prepareExactLab(roots, lab, async (claimed) => {
              await cleanupExactLab(roots, claimed, options.docker ?? defaultDockerRunner, async () => {
                await options.beforeRecheck?.(owner.ownerKey);
                let rechecked: ThreadState;
                try { rechecked = (options.stateReader ?? queryThreadState)(database, owner.owner); }
                catch { throw new Error("thread row could not be rechecked immediately before cleanup"); }
                if (rechecked !== "archived") throw new Error("thread archival changed or became uncertain before cleanup");
              });
            });
          }
          if (labs.length === 0) await options.beforeRecheck?.(owner.ownerKey);
          let finalState: ThreadState;
          try { finalState = (options.stateReader ?? queryThreadState)(database, owner.owner); }
          catch { throw new Error("thread row could not be rechecked before final cleanup"); }
          if (finalState !== "archived") {
            throw new Error("thread archival changed or became uncertain before final cleanup");
          }
          await markOwnerReaped(roots.stateRoot, owner.owner);
          if (await exactDirectoryChain(roots.stateRoot, ["owners", owner.ownerKey], "owner state directory")) {
            await boundedRemove(join(ownerRoot, owner.ownerKey), 100_000);
          }
          if (await exactDirectoryChain(roots.runtimeRoot, [owner.ownerKey], "owner runtime directory")) {
            await boundedRemove(join(roots.runtimeRoot, owner.ownerKey), 100_000);
          }
          result.archivedOwnersCleaned.push(owner.ownerKey);
        }, { attempts: 600, delayMs: 50 });
      } catch (error) {
        result.ok = false;
        result.retainedOwners.push({ ownerKey: owner.ownerKey, reason: boundedMessage("cleanup retained", error) });
      }
    }
  } catch (error) {
    result.ok = false;
    result.errors.push(boundedMessage("archive scan failed closed", error));
  } finally {
    database.close();
  }
  result.archivedOwnersCleaned = result.archivedOwnersCleaned.slice(0, 10_000);
  result.retainedOwners = result.retainedOwners.slice(0, 10_000);
  result.errors = result.errors.slice(0, 100).map((item) => item.slice(0, 1000));
  return result;
}

export function validateThreadsSchema(database: Database): void {
  const rows = database.query("PRAGMA table_info(threads)").all() as Array<Record<string, unknown>>;
  if (rows.length === 0) throw new Error("required threads table is absent");
  const columns = new Map(rows.map((row) => [String(row.name), row]));
  const id = columns.get("id");
  const archived = columns.get("archived");
  const archivedAt = columns.get("archived_at");
  const defaultValue = String(archived?.dflt_value ?? "").replace(/[()'"]/g, "");
  if (String(id?.type).toUpperCase() !== "TEXT" || Number(id?.pk) !== 1 ||
      String(archived?.type).toUpperCase() !== "INTEGER" || Number(archived?.notnull) !== 1 ||
      defaultValue !== "0" ||
      String(archivedAt?.type).toUpperCase() !== "INTEGER" || Number(archivedAt?.notnull) !== 0) {
    throw new Error("required threads schema columns are absent or incompatible");
  }
}

export function readThreadState(database: Database, owner: string): ThreadState {
  try { return queryThreadState(database, owner); }
  catch { return "uncertain"; }
}

function queryThreadState(database: Database, owner: string): ThreadState {
  const rows = database.query("SELECT id, archived, archived_at FROM threads WHERE id = ? LIMIT 2").all(owner) as
    Array<{ id: string; archived: number | bigint; archived_at: number | bigint | null }>;
  if (rows.length !== 1 || rows[0]!.id !== owner) return "uncertain";
  const row = rows[0]!;
  const archived = typeof row.archived === "bigint" ? Number(row.archived) : row.archived;
  if (archived === 0 && row.archived_at === null) return "active";
  if (archived === 1 && row.archived_at !== null &&
      (typeof row.archived_at === "bigint" || Number.isInteger(row.archived_at))) return "archived";
  return "uncertain";
}

async function prepareExactLab(
  roots: StateRoots,
  snapshot: import("./types").LabMetadata,
  cleanup?: (claimed: import("./types").LabMetadata) => Promise<void>,
): Promise<void> {
  const lock = join(ownerDirectory(roots.stateRoot, snapshot.owner), ".locks", `lab-${snapshot.id}`);
  const claimed = await withFileLock(lock, async () => {
    const lab = await readLab(roots, snapshot.owner, snapshot.id);
    await validateReaperLab(roots, lab.owner, lab.ownerKey, lab);
    return lab;
  }, { attempts: 600, delayMs: 50 });
  await cleanup?.(claimed);
}

async function cleanupExactLab(
  roots: StateRoots,
  lab: import("./types").LabMetadata,
  docker: DockerRunner,
  authorize: () => Promise<void>,
): Promise<void> {
  const labLock = join(ownerDirectory(roots.stateRoot, lab.owner), ".locks", `lab-${lab.id}`);
  const activityLock = join(ownerDirectory(roots.stateRoot, lab.owner), ".locks", `activity-${lab.id}`);
  await authorize();
  let previous: { state: import("./types").LabMetadata["state"]; updatedAt: string; error?: string } | undefined;
  await withFileLock(labLock, async () => {
    const current = await readLab(roots, lab.owner, lab.id);
    await validateReaperLab(roots, current.owner, current.ownerKey, current);
    previous = { state: current.state, updatedAt: current.updatedAt, error: current.error };
    current.state = "destroying";
    current.updatedAt = new Date().toISOString();
    await writeLab(roots, current);
    lab = current;
  }, { attempts: 600, delayMs: 50 });
  try { await authorize(); }
  catch (error) {
    await withFileLock(labLock, async () => {
      const current = await readLab(roots, lab.owner, lab.id);
      if (current.state === "destroying" && previous) {
        current.state = previous.state;
        current.updatedAt = previous.updatedAt;
        current.error = previous.error;
        await writeLab(roots, current);
      }
    }, { attempts: 600, delayMs: 50 });
    throw error;
  }
  // Exact container removal terminates an attached exec before waiting for its
  // activity lock; filesystem and synchronization state remain untouched here.
  await cleanupLabLabels(lab, lab.modeKind === "dockerfile", docker);
  await withFileLock(activityLock, async () => await withFileLock(labLock, async () => {
    lab = await readLab(roots, lab.owner, lab.id);
    await validateReaperLab(roots, lab.owner, lab.ownerKey, lab);
    await authorize();
    await recoverLabSync(roots, lab);
    if (!await exactDirectoryChain(roots.stateRoot, ["owners", lab.ownerKey], "owner state directory")) {
      throw new Error("owner state directory disappeared");
    }
    await exactDirectoryChain(roots.runtimeRoot, [lab.ownerKey, lab.id], "lab runtime directory");
    await cleanupLabLabels(lab, lab.modeKind === "dockerfile", docker);
    if (await exactDirectoryChain(roots.runtimeRoot, [lab.ownerKey, lab.id], "lab runtime directory")) {
      await boundedRemove(lab.runtimeRoot, 100_000);
    }
    if (!await exactDirectoryChain(roots.stateRoot, ["owners", lab.ownerKey], "owner state directory")) {
      throw new Error("owner state directory disappeared");
    }
    await removeLabState(roots.stateRoot, lab.owner, lab.id);
  }, { attempts: 600, delayMs: 50 }), { attempts: 600, delayMs: 50 });
}

async function validateReaperLab(
  roots: StateRoots,
  owner: string,
  ownerKey: string,
  lab: import("./types").LabMetadata,
): Promise<void> {
  const expectedRuntime = resolve(roots.runtimeRoot, ownerKey, lab.id);
  if (lab.owner !== owner || lab.ownerKey !== ownerKey || resolve(lab.runtimeRoot) !== expectedRuntime ||
      resolve(lab.workspace) !== join(expectedRuntime, "workspace")) {
    throw new Error("lab ownership or runtime containment is invalid");
  }
  if (lab.modeKind === "dockerfile" && lab.managedImage !== internalImageTag(ownerKey, lab.id)) {
    throw new Error("managed Dockerfile image identity is invalid");
  }
  const runtimePresent = await exactDirectoryChain(
    roots.runtimeRoot,
    [ownerKey, lab.id],
    "lab runtime directory",
  );
  if (runtimePresent) {
    await exactDirectoryChain(
      roots.runtimeRoot,
      [ownerKey, lab.id, "workspace"],
      "lab workspace",
    );
  }
}

async function exactDirectoryChain(root: string, segments: string[], label: string): Promise<boolean> {
  let path = resolve(root);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`configured ${label} contains unsafe indirection`);
  let expected = await realpath(path);
  for (const segment of segments) {
    path = join(path, segment);
    expected = join(expected, segment);
    if (!await exactDirectory(path, expected, label)) return false;
  }
  return true;
}

async function exactDirectory(path: string, expected: string, label: string): Promise<boolean> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} contains unsafe indirection`);
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (canonical !== expected) throw new Error(`${label} is not exactly contained in its configured root`);
  return true;
}

async function boundedRemove(root: string, maxEntries: number): Promise<void> {
  let count = 0;
  async function scan(path: string): Promise<void> {
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return;
    }
    for (const name of await readdir(path)) {
      if (++count > maxEntries) throw new Error("cleanup path exceeds bounded entry limit");
      await scan(join(path, name));
    }
  }
  await scan(root);
  await rm(root, { recursive: true, force: true });
}

function boundedMessage(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message.split("\n").slice(-4).join(" ")}`.slice(0, 1000);
}
