import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupLabLabels } from "../compose/cleanup";
import { defaultDockerRunner, type DockerRunner } from "../compose/docker-runner";
import { withFileLock } from "../storage/locks";
import { exactDirectoryChain } from "../storage/safe-path";
import { recoverLabSync } from "../workspace/recovery";
import {
  listLabs, markOwnerReaped, ownerDirectory, ownerLockPath, readLab,
  readOwnerManifest, removeLabState, resolveRoots, writeLab, type Clock, type StateRoots,
} from "../storage/state";
import { boundedRemove } from "./cleanup-utils";
import {
  cleanupExpiredLab, ensureGlobalLockDirectory, ensureOwnerSafetyDirectories,
  isExpiredActivity, validateReaperLab,
} from "./retention";
import type { ThreadState } from "./retention";

export type ReaperResult = {
  ok: boolean;
  archivedOwnersCleaned: string[];
  expiredLabsCleaned: number;
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
  now?: Clock;
  ttlMs?: number;
};

export async function reapArchivedOwners(options: ReaperOptions): Promise<ReaperResult> {
  const roots = options.roots ?? resolveRoots();
  const result: ReaperResult = { ok: true, archivedOwnersCleaned: [], expiredLabsCleaned: 0, retainedOwners: [], errors: [] };
  let database: Database | undefined;
  try {
    database = new Database(options.dbPath, { readonly: true, strict: true, safeIntegers: true });
    validateThreadsSchema(database);
  } catch (error) {
    database?.close();
    return {
      ok: false,
      archivedOwnersCleaned: [],
      expiredLabsCleaned: 0,
      retainedOwners: [],
      errors: [boundedMessage("Codex state database unavailable or incompatible", error)],
    };
  }
  try {
    const ownerRoot = join(roots.stateRoot, "owners");
    if (!await exactDirectoryChain(roots.stateRoot, ["owners"], "owner state root")) return result;
    await ensureGlobalLockDirectory(roots);
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
        await ensureOwnerSafetyDirectories(roots, owner.ownerKey);
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
          expiredLabsCleaned: 0,
          retainedOwners: [],
          errors: [boundedMessage("Codex state database query failed; no cleanup performed", error)],
        };
      }
      preflight.push({ owner, state: initial });
    }
    for (const { owner, state: initial } of preflight) {
      if (initial !== "archived") {
        if (initial === "active") {
          try {
            await options.beforeOwnerLock?.(owner.ownerKey);
            await ensureOwnerSafetyDirectories(roots, owner.ownerKey);
            let cleanedForOwner = 0;
            let retainedForOwner = 0;
            let cleanupFailed = false;
            await withFileLock(ownerLockPath(roots.stateRoot, owner.owner), async () => {
              await ensureOwnerSafetyDirectories(roots, owner.ownerKey);
              let currentState: ThreadState;
              try { currentState = (options.stateReader ?? queryThreadState)(database!, owner.owner); }
              catch { throw new Error("thread row could not be rechecked before retention cleanup"); }
              if (currentState !== "active") throw new Error("thread archival state changed before retention cleanup");
              const labs = await listLabs(roots, owner.owner);
              for (const lab of labs) {
                if (!isExpiredActivity(lab.lastActivityAt, options.now, options.ttlMs)) {
                  retainedForOwner++;
                  continue;
                }
                try {
                  await cleanupExpiredLab(roots, lab, options.docker ?? defaultDockerRunner, database!, options, owner.owner,
                    options.stateReader ?? queryThreadState);
                  cleanedForOwner++;
                  result.expiredLabsCleaned++;
                } catch {
                  result.ok = false;
                  cleanupFailed = true;
                  retainedForOwner++;
                }
              }
            }, { attempts: 600, delayMs: 50 });
            if (retainedForOwner > 0 || cleanedForOwner === 0) {
              result.retainedOwners.push({ ownerKey: owner.ownerKey, reason: cleanupFailed ? "inactivity cleanup retained" : "thread is active" });
            }
          } catch {
            result.ok = false;
            result.retainedOwners.push({ ownerKey: owner.ownerKey, reason: "inactivity cleanup retained" });
          }
        } else {
          result.retainedOwners.push({ ownerKey: owner.ownerKey, reason: "thread row is missing or inconsistent" });
        }
        continue;
      }
      try {
        await options.beforeOwnerLock?.(owner.ownerKey);
        await ensureOwnerSafetyDirectories(roots, owner.ownerKey);
        await withFileLock(ownerLockPath(roots.stateRoot, owner.owner), async () => {
          await ensureOwnerSafetyDirectories(roots, owner.ownerKey);
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
  snapshot: import("../storage/records").LabMetadata,
  cleanup?: (claimed: import("../storage/records").LabMetadata) => Promise<void>,
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
  lab: import("../storage/records").LabMetadata,
  docker: DockerRunner,
  authorize: () => Promise<void>,
): Promise<void> {
  const labLock = join(ownerDirectory(roots.stateRoot, lab.owner), ".locks", `lab-${lab.id}`);
  const activityLock = join(ownerDirectory(roots.stateRoot, lab.owner), ".locks", `activity-${lab.id}`);
  await authorize();
  let previous: { state: import("../storage/records").LabMetadata["state"]; updatedAt: string; error?: string } | undefined;
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

function boundedMessage(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message.split("\n").slice(-4).join(" ")}`.slice(0, 1000);
}
