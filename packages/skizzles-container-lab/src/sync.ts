import { randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalRoot, describeSyncFile, guardedPath, readJson, safeStateName, sha256, writeJsonAtomic, type SyncFile } from "./files";
import { buildGitManifest, manifestDigest, type GitManifest } from "./git-manifest";
import { serializePublicJson } from "./public-json";

export type SyncDirection = "push" | "pull";

export interface SyncChange {
  path: string;
  action: "upsert" | "delete";
  file?: SyncFile;
}

export interface SyncConflict {
  path: string;
  baseline?: SyncFile;
  source?: SyncFile;
  target?: SyncFile;
}

export interface SyncComparison {
  changes: SyncChange[];
  conflicts: SyncConflict[];
}

export interface SyncIdentity {
  stateRoot: string;
  labId: string;
}

export interface PreviewSyncOptions extends SyncIdentity {
  direction: SyncDirection;
  sourceRoot: string;
  targetRoot: string;
  now?: Date;
  ttlMs?: number;
  maxEntries?: number;
}

export interface SyncPreview extends SyncComparison {
  token: string;
  expiresAt: string;
  sourceDigest: string;
  targetDigest: string;
}

export interface ApplySyncOptions extends PreviewSyncOptions {
  token: string;
  /** Must establish immediately before mutation that the lab is safe to change. */
  idleGuard: () => boolean | void | Promise<boolean | void>;
}

export interface RecoverSyncOptions extends SyncIdentity {
  /** Canonicalized before use; journals targeting any other root are rejected. */
  allowedTargetRoots: string[];
}

interface BaselineFile {
  version: 1;
  files: Record<string, SyncFile>;
}

interface StoredPreview extends SyncPreview {
  version: 1;
  labId: string;
  direction: SyncDirection;
  sourceRoot: string;
  targetRoot: string;
  binding: string;
  expectedTargets: Record<string, SyncFile | null>;
}

interface BackupRecord {
  path: string;
  existed: boolean;
  kind?: "file" | "symlink";
  mode?: number;
  backup?: string;
  original: SyncFile | null;
}

interface Journal {
  version: 1;
  state: "prepared" | "applied";
  targetRoot: string;
  baselinePath: string;
  newBaseline: BaselineFile;
  backups: BackupRecord[];
  mutatedPaths: string[];
  appliedStates: Record<string, SyncFile | null>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000;

export function compareManifests(
  baseline: Record<string, SyncFile>,
  source: Record<string, SyncFile>,
  target: Record<string, SyncFile>,
): SyncComparison {
  const changes: SyncChange[] = [];
  const conflicts: SyncConflict[] = [];
  const names = new Set([...Object.keys(baseline), ...Object.keys(source), ...Object.keys(target)]);
  for (const name of [...names].sort()) {
    const before = baseline[name];
    const from = source[name];
    const to = target[name];
    if (sameFile(from, to)) continue;
    const sourceChanged = !sameFile(from, before);
    const targetChanged = !sameFile(to, before);
    if (sourceChanged && targetChanged) {
      conflicts.push({ path: name, baseline: before, source: from, target: to });
    } else if (sourceChanged) {
      changes.push(from ? { path: name, action: "upsert", file: from } : { path: name, action: "delete" });
    }
  }
  return { changes, conflicts };
}

export async function initializeSyncBaseline(identity: SyncIdentity, root: string): Promise<void> {
  const state = await statePaths(identity);
  const manifest = await buildGitManifest(root);
  await writeJsonAtomic(state.baseline, { version: 1, files: manifest.files } satisfies BaselineFile);
}

export async function previewSync(options: PreviewSyncOptions): Promise<SyncPreview> {
  const state = await statePaths(options);
  const [source, target, baseline] = await Promise.all([
    buildGitManifest(options.sourceRoot),
    buildGitManifest(options.targetRoot),
    readRequiredJson<BaselineFile>(state.baseline, "Synchronization baseline is missing; initialize it when the lab is created"),
  ]);
  const comparison = compareManifests(baseline.files, source.files, target.files);
  if (options.maxEntries !== undefined && comparison.changes.length + comparison.conflicts.length > options.maxEntries) {
    throw new Error(`Synchronization preview has more than ${options.maxEntries} entries; reduce the change set before applying`);
  }
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date((options.now ?? new Date()).getTime() + (options.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
  const stored: StoredPreview = {
    version: 1,
    token,
    expiresAt,
    sourceDigest: source.digest,
    targetDigest: target.digest,
    ...comparison,
    labId: options.labId,
    direction: options.direction,
    sourceRoot: source.root,
    targetRoot: target.root,
    binding: previewBinding(options, source, target, expiresAt, token),
    expectedTargets: Object.fromEntries(comparison.changes.map((change) => [change.path, target.files[change.path] ?? null])),
  };
  // Public previews always provide maxEntries. Never persist their token when
  // the CLI could not expose every bounded path; internal provisioning previews
  // remain independent of the agent-facing response budget.
  if (options.maxEntries !== undefined) assertPublicPreviewFitsBudget(publicPreview(stored), options);
  await writeJsonAtomic(path.join(state.previews, `${token}.json`), stored);
  return publicPreview(stored);
}

export async function applySync(options: ApplySyncOptions): Promise<{ applied: number }> {
  const state = await statePaths(options);
  const previewPath = path.join(state.previews, `${safeStateName(options.token, "preview token")}.json`);
  const preview = await readRequiredJson<StoredPreview>(previewPath, "Unknown or already-used synchronization preview token");
  const [sourceRoot, targetRoot] = await Promise.all([canonicalRoot(options.sourceRoot), canonicalRoot(options.targetRoot)]);
  assertPreviewBinding(preview, options, sourceRoot, targetRoot);
  if ((options.now ?? new Date()).getTime() >= Date.parse(preview.expiresAt)) {
    throw new Error("Synchronization preview token has expired");
  }
  if (preview.conflicts.length) throw new Error("Synchronization preview contains conflicts");

  const [source, target] = await Promise.all([buildGitManifest(sourceRoot), buildGitManifest(targetRoot)]);
  if (source.digest !== preview.sourceDigest || target.digest !== preview.targetDigest) {
    throw new Error("Synchronization preview is stale; source or target changed");
  }
  if (preview.binding !== previewBinding(options, source, target, preview.expiresAt, options.token)) {
    throw new Error("Synchronization preview binding is invalid");
  }
  const idle = await options.idleGuard();
  if (idle === false) throw new Error("Synchronization apply requires an idle lab");

  // Rename is the single-use claim and is atomic against concurrent applies.
  const claimed = path.join(state.used, `${options.token}.json`);
  await rename(previewPath, claimed).catch(() => {
    throw new Error("Unknown or already-used synchronization preview token");
  });

  const journalId = randomUUID();
  const backupDir = path.join(state.backups, journalId);
  const journalPath = path.join(state.journals, `${journalId}.json`);
  await mkdir(backupDir, { recursive: true });
  const stagedRoot = path.join(backupDir, "source");
  const targetBackups = path.join(backupDir, "target");
  await mkdir(stagedRoot);
  await stageSources(sourceRoot, preview.changes, stagedRoot);
  await mkdir(targetBackups);
  let backups: BackupRecord[];
  try { backups = await backupTargets(targetRoot, preview.changes, preview.expectedTargets, targetBackups); }
  catch (error) { await rm(backupDir, { recursive: true, force: true }); throw error; }
  const journal: Journal = {
    version: 1,
    state: "prepared",
    targetRoot,
    baselinePath: state.baseline,
    newBaseline: { version: 1, files: source.files },
    backups,
    mutatedPaths: [],
    appliedStates: Object.fromEntries(preview.changes.map((change) => [change.path, change.file ?? null])),
  };
  await writeJsonAtomic(journalPath, journal);
  try {
    const [freshSource, freshTarget] = await Promise.all([buildGitManifest(sourceRoot), buildGitManifest(targetRoot)]);
    if (freshSource.digest !== preview.sourceDigest || freshTarget.digest !== preview.targetDigest) {
      throw new Error("Synchronization preview became stale before mutation");
    }
    const idleImmediatelyBeforeMutation = await options.idleGuard();
    if (idleImmediatelyBeforeMutation === false) throw new Error("Synchronization apply requires an idle lab");
    for (const change of preview.changes) await assertExpectedEntry(targetRoot, change.path, preview.expectedTargets[change.path] ?? null, "target");
    for (const change of preview.changes) {
      await assertExpectedEntry(targetRoot, change.path, preview.expectedTargets[change.path] ?? null, "target");
      journal.mutatedPaths.push(change.path);
      await writeJsonAtomic(journalPath, journal);
      await applyChange(stagedRoot, targetRoot, change);
    }
    journal.state = "applied";
    await writeJsonAtomic(journalPath, journal);
    await writeJsonAtomic(state.baseline, journal.newBaseline);
    await rm(journalPath, { force: true });
    await rm(backupDir, { recursive: true, force: true });
    return { applied: preview.changes.length };
  } catch (error) {
    try {
      await rollbackJournalSafely(targetRoot, journal);
      await rm(journalPath, { force: true });
      await rm(backupDir, { recursive: true, force: true });
    } catch (rollbackError) {
      throw new Error(`Synchronization apply failed and recovery state was retained: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`, { cause: error });
    }
    throw error;
  }
}

/** Recover interrupted applies. Prepared journals roll back; fully applied journals publish their baseline. */
export async function recoverSyncTransactions(options: RecoverSyncOptions): Promise<number> {
  const state = await statePaths(options);
  const allowedTargets = new Set(await Promise.all(options.allowedTargetRoots.map(canonicalRoot)));
  const glob = new Bun.Glob("*.json");
  let recovered = 0;
  for await (const name of glob.scan({ cwd: state.journals, onlyFiles: true })) {
    const journalPath = path.join(state.journals, name);
    const journal = await readRequiredJson<Journal>(journalPath, `Invalid synchronization journal ${name}`);
    const targetRoot = await canonicalRoot(journal.targetRoot);
    if (!allowedTargets.has(targetRoot)) throw new Error(`Synchronization journal targets a root not owned by this lab: ${targetRoot}`);
    const journalBaseline = path.join(await canonicalRoot(path.dirname(journal.baselinePath)), path.basename(journal.baselinePath));
    const expectedBaseline = path.join(await canonicalRoot(path.dirname(state.baseline)), path.basename(state.baseline));
    if (journalBaseline !== expectedBaseline) {
      throw new Error("Synchronization journal baseline does not belong to this lab");
    }
    if (journal.state === "applied") await writeJsonAtomic(state.baseline, journal.newBaseline);
    else await rollbackJournalSafely(targetRoot, journal);
    await rm(journalPath, { force: true });
    await rm(path.join(state.backups, path.basename(name, ".json")), { recursive: true, force: true });
    recovered++;
  }
  return recovered;
}

function sameFile(a?: SyncFile, b?: SyncFile): boolean {
  return a === b || (!!a && !!b && a.kind === b.kind && a.sha256 === b.sha256 && a.size === b.size && a.mode === b.mode);
}

async function statePaths(identity: Pick<SyncIdentity, "stateRoot" | "labId">) {
  safeStateName(identity.labId, "lab id");
  await mkdir(identity.stateRoot, { recursive: true, mode: 0o700 });
  const stateRoot = await canonicalRoot(identity.stateRoot);
  const root = path.join(stateRoot, "sync", identity.labId);
  const previews = path.join(root, "previews");
  const used = path.join(root, "used");
  const journals = path.join(root, "journals");
  const backups = path.join(root, "backups");
  for (const relative of ["sync", `sync/${identity.labId}`, `sync/${identity.labId}/previews`, `sync/${identity.labId}/used`, `sync/${identity.labId}/journals`, `sync/${identity.labId}/backups`]) {
    await ensureStateDirectory(stateRoot, relative);
  }
  return { root, previews, used, journals, backups, baseline: path.join(root, "baseline.json") };
}

async function ensureStateDirectory(stateRoot: string, relative: string): Promise<void> {
  const directory = await guardedPath(stateRoot, relative, true);
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe synchronization state directory: ${relative}`);
}

function previewBinding(options: Pick<PreviewSyncOptions, "labId" | "direction">, source: GitManifest, target: GitManifest, expiresAt: string, token: string): string {
  return sha256(JSON.stringify([token, options.labId, options.direction, source.root, target.root, source.digest, target.digest, expiresAt]));
}

function assertPreviewBinding(preview: StoredPreview, options: ApplySyncOptions, sourceRoot: string, targetRoot: string): void {
  if (preview.token !== options.token || preview.labId !== options.labId || preview.direction !== options.direction ||
      preview.sourceRoot !== sourceRoot || preview.targetRoot !== targetRoot) {
    throw new Error("Synchronization preview token does not match the requested lab, direction, or roots");
  }
}

function publicPreview(value: StoredPreview): SyncPreview {
  return { token: value.token, expiresAt: value.expiresAt, sourceDigest: value.sourceDigest, targetDigest: value.targetDigest, changes: value.changes, conflicts: value.conflicts };
}

export function publicSyncPreview(preview: SyncPreview, labId: string, direction: SyncDirection) {
  return {
    labId,
    direction,
    token: preview.token,
    expiresAt: preview.expiresAt,
    changes: preview.changes,
    conflicts: preview.conflicts,
    changeCount: preview.changes.length,
    conflictCount: preview.conflicts.length,
    truncated: false,
  };
}

function assertPublicPreviewFitsBudget(preview: SyncPreview, options: Pick<PreviewSyncOptions, "labId" | "direction">): void {
  try {
    serializePublicJson(publicSyncPreview(preview, options.labId, options.direction));
  } catch {
    throw new Error("Synchronization preview cannot be exposed within the 16 KiB public output budget; reduce the change set before applying");
  }
}

async function backupTargets(targetRoot: string, changes: SyncChange[], expected: Record<string, SyncFile | null>, backupDir: string): Promise<BackupRecord[]> {
  const records: BackupRecord[] = [];
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!;
    await assertExpectedEntry(targetRoot, change.path, expected[change.path] ?? null, "target");
    const target = await guardedPath(targetRoot, change.path);
    try {
      const stat = await lstat(target);
      const backup = path.join(backupDir, String(index));
      if (stat.isSymbolicLink()) {
        await symlink(await readlink(target), backup);
        records.push({ path: change.path, existed: true, kind: "symlink", mode: stat.mode & 0o777, backup, original: expected[change.path] ?? null });
      } else if (stat.isFile()) {
        await copyFile(target, backup);
        records.push({ path: change.path, existed: true, kind: "file", mode: stat.mode & 0o777, backup, original: expected[change.path] ?? null });
      } else {
        throw new Error(`Synchronization target is not a regular file or symlink: ${change.path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      records.push({ path: change.path, existed: false, original: null });
    }
  }
  return records;
}

async function stageSources(sourceRoot: string, changes: SyncChange[], stagedRoot: string): Promise<void> {
  for (const change of changes) {
    if (change.action === "delete") continue;
    if (!change.file) throw new Error(`Synchronization preview is missing file details for ${change.path}`);
    const source = await guardedPath(sourceRoot, change.path);
    const target = await guardedPath(stagedRoot, change.path, true);
    const stat = await lstat(source);
    if (change.file.kind === "symlink" && stat.isSymbolicLink()) {
      const link = await readlink(source);
      const bytes = Buffer.from(link);
      if (bytes.byteLength !== change.file.size || sha256(bytes) !== change.file.sha256) throw new Error("Synchronization preview is stale; source changed");
      await symlink(link, target);
    } else if (change.file.kind === "file" && stat.isFile()) {
      await copyFile(source, target);
      await chmod(target, change.file.mode);
      const staged = await describeSyncFile(stagedRoot, change.path);
      if (!sameFile(staged, change.file)) throw new Error("Synchronization preview is stale; source changed");
    } else {
      throw new Error(`Synchronization source changed type during apply: ${change.path}`);
    }
  }
}

async function applyChange(sourceRoot: string, targetRoot: string, change: SyncChange): Promise<void> {
  const target = await guardedPath(targetRoot, change.path, true);
  await rm(target, { force: true, recursive: false });
  if (change.action === "delete") return;
  const source = await guardedPath(sourceRoot, change.path);
  const stat = await lstat(source);
  if (change.file?.kind === "symlink" && stat.isSymbolicLink()) {
    await symlink(await readlink(source), target);
  } else if (change.file?.kind === "file" && stat.isFile()) {
    await copyFile(source, target);
    await chmod(target, change.file.mode);
  } else {
    throw new Error(`Synchronization source changed type during apply: ${change.path}`);
  }
}

async function assertExpectedEntry(root: string, relative: string, expected: SyncFile | null, side: string): Promise<void> {
  let actual: SyncFile | null = null;
  try { actual = await describeSyncFile(root, relative); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!sameFile(actual ?? undefined, expected ?? undefined)) throw new Error(`Synchronization ${side} changed after preview: ${relative}`);
}

async function restoreBackups(targetRoot: string, backups: BackupRecord[]): Promise<void> {
  for (const record of backups) {
    const target = await guardedPath(targetRoot, record.path, true);
    await rm(target, { force: true, recursive: false });
    if (!record.existed) continue;
    if (!record.backup) throw new Error(`Missing synchronization backup for ${record.path}`);
    if (record.kind === "symlink") await symlink(await readlink(record.backup), target);
    else {
      await copyFile(record.backup, target);
      if (record.mode !== undefined) await chmod(target, record.mode);
    }
  }
}

async function rollbackJournalSafely(targetRoot: string, journal: Journal): Promise<void> {
  const restorations: BackupRecord[] = [];
  for (const backup of journal.backups.filter((item) => journal.mutatedPaths.includes(item.path))) {
    let actual: SyncFile | null = null;
    try { actual = await describeSyncFile(targetRoot, backup.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const intended = journal.appliedStates[backup.path] ?? null;
    if (sameFile(actual ?? undefined, intended ?? undefined)) restorations.push(backup);
    else if (!sameFile(actual ?? undefined, backup.original ?? undefined)) {
      throw new Error(`recovery conflict at ${backup.path}; divergent target preserved`);
    }
  }
  await restoreBackups(targetRoot, restorations);
}

async function readRequiredJson<T>(file: string, message: string): Promise<T> {
  try {
    return await readJson<T>(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(message);
    throw error;
  }
}
