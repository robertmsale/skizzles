import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, parse, posix, relative, resolve, sep } from "node:path";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { composeCommandArgs, internalImageTag } from "./compose";
import { manifestName } from "./config";
import { readJson, safeStateName, writeJsonAtomic } from "./files";
import type { LabMetadata, OwnerManifest, PersistedLabRuntime } from "./types";

export type StateRoots = { stateRoot: string; runtimeRoot: string };
export type ReapedOwnerManifest = {
  version: 1;
  owner: string;
  ownerKey: string;
  reapedAt: string;
};

const LAB_STATES = new Set(["provisioning", "ready", "failed", "destroying"]);
const FINDING_SURFACES = new Set([
  "host-bind", "socket-bind", "privileged", "host-namespace", "device", "capability",
  "secret", "config", "fixed-port", "non-loopback-port",
]);

export function defaultStateRoot(): string {
  return join(homedir(), "Library", "Application Support", "OpenAI", "codex-container-lab");
}

export function defaultRuntimeRoot(): string {
  return join(tmpdir(), "codex-container-lab");
}

export function resolveRoots(options: { stateRoot?: string; runtimeRoot?: string } = {}): StateRoots {
  return {
    stateRoot: resolve(options.stateRoot ?? process.env.CODEX_CONTAINER_LAB_STATE_ROOT ?? defaultStateRoot()),
    runtimeRoot: resolve(options.runtimeRoot ?? process.env.CODEX_CONTAINER_LAB_RUNTIME_ROOT ?? defaultRuntimeRoot()),
  };
}

export function resolveOwner(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  const owner = explicit ?? environment.CODEX_THREAD_ID;
  if (owner === undefined || owner.length === 0) {
    throw new Error("owner is required: pass --owner THREAD_ID or set CODEX_THREAD_ID");
  }
  if (owner.includes("\0")) throw new Error("owner must not contain NUL");
  if (Buffer.byteLength(owner, "utf8") > 4096) throw new Error("owner must be at most 4096 UTF-8 bytes");
  return owner;
}

export function ownerKey(owner: string): string {
  return createHash("sha256").update(owner).digest("hex");
}

export function ownerDirectory(stateRoot: string, owner: string): string {
  return join(stateRoot, "owners", ownerKey(owner));
}

export function ownerRuntimeDirectory(runtimeRoot: string, owner: string): string {
  return join(runtimeRoot, ownerKey(owner));
}

export function ownerManifestPath(stateRoot: string, owner: string): string {
  return join(ownerDirectory(stateRoot, owner), "owner.json");
}

export function ownerLockPath(stateRoot: string, owner: string): string {
  return join(stateRoot, ".locks", `owner-${ownerKey(owner)}`);
}

export function reapedOwnerPath(stateRoot: string, owner: string): string {
  return join(stateRoot, "reaped", `${ownerKey(owner)}.json`);
}

export async function readReapedOwner(stateRoot: string, owner: string): Promise<ReapedOwnerManifest | undefined> {
  let value: unknown;
  try { value = await readJson<unknown>(reapedOwnerPath(stateRoot, owner)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!isRecord(value) || value.version !== 1 || value.owner !== owner || value.ownerKey !== ownerKey(owner) ||
      !isTimestamp(value.reapedAt)) {
    throw new Error("invalid reaped owner manifest");
  }
  return value as ReapedOwnerManifest;
}

export async function markOwnerReaped(stateRoot: string, owner: string): Promise<ReapedOwnerManifest> {
  const existing = await readReapedOwner(stateRoot, owner);
  if (existing) return existing;
  const manifest: ReapedOwnerManifest = {
    version: 1,
    owner,
    ownerKey: ownerKey(owner),
    reapedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(reapedOwnerPath(stateRoot, owner), manifest);
  return manifest;
}

export function labsDirectory(stateRoot: string, owner: string): string {
  return join(ownerDirectory(stateRoot, owner), "labs");
}

export function labManifestPath(stateRoot: string, owner: string, labId: string): string {
  safeStateName(labId, "lab id");
  return join(labsDirectory(stateRoot, owner), `${labId}.json`);
}

export function expectedLabRuntimeRoot(roots: StateRoots, owner: string, labId: string): string {
  safeStateName(labId, "lab id");
  return join(resolve(roots.runtimeRoot), ownerKey(owner), labId);
}

export async function ensureOwner(stateRoot: string, owner: string): Promise<OwnerManifest> {
  resolveOwner(owner, {});
  const directory = ownerDirectory(stateRoot, owner);
  await mkdir(join(directory, "labs"), { recursive: true, mode: 0o700 });
  const path = ownerManifestPath(stateRoot, owner);
  try {
    const existing = await readOwnerManifest(path);
    if (existing.owner !== owner || existing.ownerKey !== ownerKey(owner)) {
      throw new Error("owner hash collision or mismatched owner manifest");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manifest: OwnerManifest = {
    version: 1,
    owner,
    ownerKey: ownerKey(owner),
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path, manifest);
  return manifest;
}

export async function readOwnerManifest(path: string): Promise<OwnerManifest> {
  const value = await readJson<unknown>(path);
  if (!isRecord(value) || value.version !== 1 || typeof value.owner !== "string" ||
      typeof value.ownerKey !== "string" || !isTimestamp(value.createdAt)) {
    throw new Error(`invalid owner manifest: ${path}`);
  }
  resolveOwner(value.owner, {});
  if (value.ownerKey !== ownerKey(value.owner) || basename(resolve(path, "..")) !== value.ownerKey) {
    throw new Error(`owner manifest hash mismatch: ${path}`);
  }
  return value as OwnerManifest;
}

export async function listOwnerManifests(stateRoot: string): Promise<Array<{ directory: string; manifest: OwnerManifest }>> {
  const root = join(stateRoot, "owners");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const owners: Array<{ directory: string; manifest: OwnerManifest }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) throw new Error(`unexpected owner state entry: ${entry.name}`);
    const directory = join(root, entry.name);
    const manifest = await readOwnerManifest(join(directory, "owner.json"));
    owners.push({ directory, manifest });
  }
  return owners;
}

export async function writeLab(roots: StateRoots, lab: LabMetadata): Promise<void> {
  assertLabMetadata(lab, roots, lab.owner, lab.id);
  await writeJsonAtomic(labManifestPath(roots.stateRoot, lab.owner, lab.id), lab);
}

export async function readLab(roots: StateRoots, owner: string, labId: string): Promise<LabMetadata> {
  const value = await readJson<unknown>(labManifestPath(roots.stateRoot, owner, labId));
  assertLabMetadata(value, roots, owner, labId);
  return value;
}

export async function listLabs(roots: StateRoots, owner: string): Promise<LabMetadata[]> {
  const directory = labsDirectory(roots.stateRoot, owner);
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const labs: LabMetadata[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) throw new Error(`unexpected lab state entry: ${name}`);
    labs.push(await readLab(roots, owner, name.slice(0, -5)));
  }
  return labs;
}

export async function removeLabState(stateRoot: string, owner: string, labId: string): Promise<void> {
  await rm(labManifestPath(stateRoot, owner, labId), { force: true });
}

export async function assertReadyLabFilesystem(roots: StateRoots, lab: LabMetadata): Promise<void> {
  if (lab.state !== "ready" || !lab.runtime) throw new Error(`lab is not ready: ${lab.state}`);
  const configuredRuntime = await realDirectory(roots.runtimeRoot, "configured runtime root");
  const ownerRuntime = await realDirectory(join(roots.runtimeRoot, lab.ownerKey), "owner runtime root");
  const runtime = await realDirectory(lab.runtimeRoot, "lab runtime root");
  const workspace = await realDirectory(lab.workspace, "lab workspace");
  if (ownerRuntime !== join(configuredRuntime, lab.ownerKey) || runtime !== join(ownerRuntime, lab.id) || workspace !== join(runtime, "workspace")) {
    throw new Error("runtime or workspace resolved outside the configured runtime root");
  }
  const source = await realDirectory(lab.sourceRoot, "lab source root");
  await realFileInside(source, lab.manifestPath, "lab manifest");
  await realFileInside(runtime, lab.runtime.overrideFile, "Compose override");
  if (lab.runtime.baseFile) await realFileInside(runtime, lab.runtime.baseFile, "internal Compose base");
  const mode = lab.runtime.config.mode;
  if (mode.kind === "compose") {
    for (const path of mode.files) await realFileInside(source, path, "project Compose file");
  } else if (mode.kind === "dockerfile") {
    await realFileInside(source, mode.dockerfile, "project Dockerfile");
    await realDirectoryInside(source, mode.context, "Dockerfile context");
  }
}

export function assertLabMetadata(
  value: unknown,
  roots: StateRoots,
  owner: string,
  labId: string,
): asserts value is LabMetadata {
  try {
    safeStateName(labId, "lab id");
    resolveOwner(owner, {});
    if (!isRecord(value) || value.version !== 1 || value.id !== labId || value.owner !== owner ||
        value.ownerKey !== ownerKey(owner)) throw new Error("identity mismatch");
    if (typeof value.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value.name)) throw new Error("invalid name");
    if (typeof value.repoHash !== "string" || !/^[a-f0-9]{12}$/.test(value.repoHash)) throw new Error("invalid repository hash");
    if (typeof value.composeProject !== "string" || !/^ccl-[a-z0-9][a-z0-9-]{0,62}$/.test(value.composeProject)) throw new Error("invalid Compose project");
    if (typeof value.state !== "string" || !LAB_STATES.has(value.state)) throw new Error("invalid lifecycle state");
    const expectedRuntime = expectedLabRuntimeRoot(roots, owner, labId);
    if (!isNormalizedAbsolute(value.runtimeRoot) || value.runtimeRoot !== expectedRuntime) throw new Error("invalid runtime root");
    if (value.workspace !== join(expectedRuntime, "workspace")) throw new Error("invalid workspace root");
    if (!isNormalizedAbsolute(value.sourceRoot) || value.sourceRoot === parse(value.sourceRoot).root) throw new Error("invalid source root");
    if (value.manifestPath !== join(value.sourceRoot, manifestName)) throw new Error("invalid source manifest relationship");
    if (typeof value.commandService !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.commandService)) {
      throw new Error("invalid command service");
    }
    if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) throw new Error("invalid timestamps");
    if (!Array.isArray(value.endpoints) || !value.endpoints.every(isEndpoint)) throw new Error("invalid endpoints");
    if (!Array.isArray(value.findings) || !value.findings.every(isFinding)) throw new Error("invalid findings");
    if (value.modeKind !== undefined && value.modeKind !== "compose" && value.modeKind !== "dockerfile" && value.modeKind !== "image") {
      throw new Error("invalid mode kind");
    }
    if (value.error !== undefined && !isBoundedString(value.error, 4_000)) throw new Error("invalid error");
    if (value.runtime !== undefined) validatePersistedRuntime(value, value.runtime);
    if (value.state === "ready" && value.runtime === undefined) throw new Error("ready lab has no runtime");
    if (value.modeKind === "dockerfile") {
      if (value.managedImage !== internalImageTag(value.ownerKey, value.id)) throw new Error("invalid managed image");
    } else if (value.managedImage !== undefined) {
      throw new Error("unexpected managed image");
    }
  } catch (error) {
    throw new Error(`invalid lab manifest: ${labId}: ${message(error)}`);
  }
}

function validatePersistedRuntime(lab: Record<string, unknown>, runtime: unknown): asserts runtime is PersistedLabRuntime {
  if (!isRecord(runtime) || !isRecord(runtime.config)) throw new Error("invalid persisted runtime");
  const config = runtime.config;
  if (config.repoRoot !== lab.sourceRoot || config.manifestPath !== lab.manifestPath || !isRecord(config.mode) || !isRecord(config.runtime)) {
    throw new Error("runtime source identity mismatch");
  }
  const mode = config.mode;
    if (mode.kind !== lab.modeKind || mode.commandService !== lab.commandService ||
        typeof mode.commandService !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(mode.commandService)) {
    throw new Error("runtime mode identity mismatch");
  }
  if (mode.kind === "compose") {
    if (!Array.isArray(mode.files) || mode.files.length === 0 || !mode.files.every((path) => isPathInside(lab.sourceRoot as string, path))) {
      throw new Error("invalid Compose source files");
    }
  } else if (mode.kind === "dockerfile") {
    if (!isPathInside(lab.sourceRoot as string, mode.dockerfile) || !isPathInside(lab.sourceRoot as string, mode.context, true)) {
      throw new Error("invalid Dockerfile source paths");
    }
  } else if (mode.kind === "image") {
    if (!isBoundedString(mode.image, 1_024) || mode.image.includes("\0") || mode.image.trim() !== mode.image) throw new Error("invalid image name");
  } else {
    throw new Error("invalid runtime mode");
  }
  if (!isBoundedString(config.runtime.workspace, 1_024) || !posix.isAbsolute(config.runtime.workspace) ||
      posix.normalize(config.runtime.workspace) !== config.runtime.workspace || config.runtime.workspace === "/" ||
      !Array.isArray(config.runtime.shell) || config.runtime.shell.length === 0 || config.runtime.shell.length > 64 ||
      !config.runtime.shell.every((part) => isBoundedString(part, 4_096) && !part.includes("\0")) ||
      !posix.isAbsolute(config.runtime.shell[0]) || posix.normalize(config.runtime.shell[0]) !== config.runtime.shell[0]) throw new Error("invalid container runtime");
  if (!Array.isArray(config.ports) || !config.ports.every(isDeclaredPort)) throw new Error("invalid declared ports");
  if (!Array.isArray(config.forwardEnvironment) || config.forwardEnvironment.length > 64 ||
      !config.forwardEnvironment.every((key) => typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ||
      new Set(config.forwardEnvironment).size !== config.forwardEnvironment.length) {
    throw new Error("invalid forwarded environment");
  }
  const runtimeRoot = lab.runtimeRoot as string;
  const expectedOverride = join(runtimeRoot, "override.compose.yaml");
  const expectedBase = mode.kind === "compose" ? undefined : join(runtimeRoot, "base.compose.yaml");
  if (runtime.overrideFile !== expectedOverride || runtime.baseFile !== expectedBase ||
      !Array.isArray(runtime.findings) || !runtime.findings.every(isFinding) ||
      JSON.stringify(runtime.findings) !== JSON.stringify(lab.findings)) throw new Error("invalid runtime files or findings");
  const expectedArgs = composeCommandArgs(config as never, {
    projectName: lab.composeProject as string,
    overrideFile: expectedOverride,
    baseFile: expectedBase,
  });
  if (!Array.isArray(runtime.composeArgs) || runtime.composeArgs.length !== expectedArgs.length ||
      !runtime.composeArgs.every((arg, index) => arg === expectedArgs[index])) throw new Error("invalid Compose arguments");
}

function isPathInside(root: string, candidate: unknown, allowRoot = false): boolean {
  if (typeof candidate !== "string" || !isNormalizedAbsolute(candidate)) return false;
  const fromRoot = relative(root, candidate);
  return (allowRoot || fromRoot !== "") && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function isNormalizedAbsolute(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

function isEndpoint(value: unknown): boolean {
  return isRecord(value) && typeof value.name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.name) &&
    typeof value.service === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.service) &&
    typeof value.target === "number" && Number.isInteger(value.target) && value.target >= 1 && value.target <= 65_535 && isBoundedString(value.url, 2_048);
}

function isDeclaredPort(value: unknown): boolean {
  return isRecord(value) && typeof value.name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.name) &&
    typeof value.service === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.service) &&
    typeof value.target === "number" && Number.isInteger(value.target) && value.target >= 1 && value.target <= 65_535 &&
    (value.scheme === undefined || (typeof value.scheme === "string" && /^[a-z][a-z0-9+.-]*$/.test(value.scheme)));
}

function isFinding(value: unknown): boolean {
  return isRecord(value) && (value.service === undefined || isBoundedString(value.service, 128)) &&
    typeof value.surface === "string" && FINDING_SURFACES.has(value.surface) && isBoundedString(value.detail, 1_024);
}

async function realDirectory(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  return await realpath(path);
}

async function realFileInside(root: string, path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a real file`);
  assertCanonicalInside(root, await realpath(path), label, false);
}

async function realDirectoryInside(root: string, path: string, label: string): Promise<void> {
  const canonical = await realDirectory(path, label);
  assertCanonicalInside(root, canonical, label, true);
}

function assertCanonicalInside(root: string, candidate: string, label: string, allowRoot: boolean): void {
  const fromRoot = relative(root, candidate);
  if ((!allowRoot && fromRoot === "") || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} resolves outside its trusted root`);
  }
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
