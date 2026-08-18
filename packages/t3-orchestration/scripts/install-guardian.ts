import { createHash, randomUUID } from "node:crypto";
import { dlopen, FFIType, suffix } from "bun:ffi";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const GUARDIAN_LAUNCH_AGENT_LABEL = "io.github.skizzles.t3-auto-guardian";
const ORCHESTRATION_LAUNCH_AGENT_LABEL = "io.github.t3-orchestration.daemon";
const REAPER_LAUNCH_AGENT_LABEL = "io.github.skizzles.t3-worktree-reaper";

type TreeEntry = { path: string; sha256: string; mode: number };
type OwnedTreeEntry =
  | { path: string; kind: "file"; sha256: string; mode: number }
  | { path: string; kind: "link"; target: string }
  | { path: string; kind: "dir" };
type PathGeneration = { dev: string; ino: string; token: string };
type LinkEntry = { path: string; target: string };
type FileEntry = { path: string; sha256: string; mode: number };
type Receipt = {
  version: 1;
  schema: 1;
  runtimeVersion: string;
  runtimeRoot: string;
  runtime: TreeEntry[];
  links: LinkEntry[];
  files: FileEntry[];
};

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");

const flags = new Set(process.argv.slice(2));
const uninstall = flags.has("--uninstall");
if (flags.has("--client-only")) throw new Error("t3-auto-guardian is host-only and refuses --client-only");
const unsupportedFlags = [...flags].filter((flag) => !["--uninstall"].includes(flag));
if (unsupportedFlags.length > 0) throw new Error(`Unknown installer option ${unsupportedFlags[0]}`);

const sourceRoot = resolve(import.meta.dir, "..");
const runtimeSource = join(sourceRoot, "src");
const bin = join(home, ".local/bin");
const t3Home = resolve(process.env.T3_HOME?.trim() || join(home, ".t3"));
const launchAgents = join(home, "Library/LaunchAgents");
const launchAgent = join(launchAgents, `${GUARDIAN_LAUNCH_AGENT_LABEL}.plist`);
const orchestrationLaunchAgent = join(launchAgents, `${ORCHESTRATION_LAUNCH_AGENT_LABEL}.plist`);
const reaperLaunchAgent = join(launchAgents, `${REAPER_LAUNCH_AGENT_LABEL}.plist`);
const dataRoot = resolve(process.env.XDG_DATA_HOME?.trim() || join(home, ".local/share"));
const installRoot = resolve(process.env.T3_AUTO_GUARDIAN_INSTALL_ROOT?.trim() || join(dataRoot, "skizzles/t3-auto-guardian"));
const runtimeRoot = join(installRoot, "runtime");
const receiptPath = join(installRoot, "install-receipt.json");
const installerStateDir = join(home, ".local/share/skizzles");
const journalPath = join(installerStateDir, "t3-auto-guardian.journal");
const legacyJournalPath = join(dirname(installRoot), "t3-auto-guardian.journal");
const installerLockPath = join(installerStateDir, "t3-auto-guardian.installer.lock");
const cliName = "auto-guardian-cli.ts";
type JournalKind = "install" | "uninstall";
type DestinationArtifact =
  | { kind: "link"; target: string }
  | { kind: "file"; sha256: string; mode: number };
type JournalDestination = {
  destination: string;
  backup?: string;
  installed: boolean;
  artifact?: DestinationArtifact;
};
type InstallJournal = {
  version: 1;
  kind?: JournalKind;
  phase: string;
  transactionRoot: string;
  installRoot: string;
  previousInstall?: string;
  destinations: JournalDestination[];
  installedRoot: boolean;
  rootIdentity?: { dev: string; ino: string };
  rootTree?: OwnedTreeEntry[];
  transactionIdentity?: PathGeneration;
  transactionTree?: OwnedTreeEntry[];
  serviceWasLoaded?: boolean;
};
const TRANSACTION_TOKEN_NAME = ".skizzles-transaction";
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const INSTALLER_LOCK_ATTEMPTS = 600;
const INSTALLER_LOCK_RETRY_MS = 50;
const GUARDIAN_RUNTIME_FILES = [
  "auto-guardian-cli.ts",
  "auto-guardian.ts",
  "auto-guardian-config.ts",
  "auto-guardian-policy.ts",
  "approval-projection.ts",
  "client.ts",
  "config.ts",
  "exclusive-lock.ts",
  "protocol.ts",
  "remote-config.ts",
] as const;
const FORBIDDEN_RUNTIME_FILES = new Set(["cli.ts", "daemon.ts"]);

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

let flockSymbol: ((fd: number, operation: number) => number) | undefined;

function loadFlock(): (fd: number, operation: number) => number {
  if (flockSymbol) return flockSymbol;
  const candidates = process.platform === "darwin"
    ? ["libSystem.B.dylib", "libc.dylib"]
    : [`libc.${suffix}`, "libc.so.6", "libc.so"];
  let last: unknown;
  for (const candidate of candidates) {
    try {
      flockSymbol = dlopen(candidate, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      }).symbols.flock;
      return flockSymbol;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`flock is unavailable (${last instanceof Error ? last.message : String(last)})`);
}

async function withInstallerLock<T>(body: () => Promise<T>): Promise<T> {
  await mkdir(dirname(installerLockPath), { recursive: true, mode: 0o755 });
  const handle = await open(installerLockPath, "a", 0o600);
  try {
    const flock = loadFlock();
    for (let attempt = 0; attempt < INSTALLER_LOCK_ATTEMPTS; attempt++) {
      if (flock(handle.fd, LOCK_EX | LOCK_NB) === 0) {
        try {
          return await body();
        } finally {
          flock(handle.fd, LOCK_UN);
        }
      }
      await Bun.sleep(INSTALLER_LOCK_RETRY_MS);
    }
    throw new Error(`Timed out waiting for T3 auto guardian installer lock ${installerLockPath}`);
  } finally {
    await handle.close();
  }
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
    throw new Error("T3 orchestration package.json has no stable semantic version");
  }
  return packageJson.version;
}

async function ensureDirectory(path: string, modeBits: number): Promise<void> {
  const existing = await optionalLstat(path);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error(`Refusing to use non-directory path ${path}`);
  }
  if (existing) return;
  await mkdir(path, { recursive: true, mode: modeBits });
  await chmod(path, modeBits);
}

async function copyGuardianRuntime(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Runtime source must be a directory: ${source}`);
  await mkdir(destination, { recursive: true, mode: 0o755 });
  await chmod(destination, 0o755);
  let copiedCli = false;
  for (const name of GUARDIAN_RUNTIME_FILES) {
    if (FORBIDDEN_RUNTIME_FILES.has(name)) throw new Error(`Refusing to stage orchestration entrypoint ${name}`);
    const sourcePath = join(source, name);
    const existing = await optionalLstat(sourcePath);
    if (!existing) continue;
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Refusing to copy non-regular runtime input ${sourcePath}`);
    const destinationPath = join(destination, name);
    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, name === cliName ? 0o755 : Number(existing.mode) & 0o777);
    if (name === cliName) copiedCli = true;
  }
  if (!copiedCli) throw new Error(`Guardian runtime is missing ${cliName}`);
  for (const name of FORBIDDEN_RUNTIME_FILES) {
    if (await optionalLstat(join(destination, name))) {
      throw new Error(`Guardian runtime must not include ${name}`);
    }
  }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function snapshotTree(root: string): Promise<TreeEntry[]> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Managed runtime root is not a directory: ${root}`);
  const output: TreeEntry[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const entryMetadata = await lstat(path);
      if (entryMetadata.isDirectory() && !entryMetadata.isSymbolicLink()) {
        await visit(path, relativePath);
      } else if (entryMetadata.isFile() && !entryMetadata.isSymbolicLink()) {
        output.push({ path: relativePath, sha256: await sha256(path), mode: entryMetadata.mode & 0o777 });
      } else {
        throw new Error(`Managed runtime contains an unsupported entry ${path}`);
      }
    }
  };
  await visit(root, "");
  return output;
}

async function assertStableRoot(): Promise<void> {
  const metadata = await optionalLstat(installRoot);
  if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Managed install root is missing: ${installRoot}`);
  const entries = (await readdir(installRoot, { withFileTypes: true })).map((entry) => entry.name).sort();
  if (JSON.stringify(entries) !== JSON.stringify(["install-receipt.json", "runtime"])) {
    throw new Error(`Managed install root drifted under ${installRoot}`);
  }
}

function expectedLinks(): LinkEntry[] {
  return [{ path: join(bin, "t3-auto-guardian"), target: join(runtimeRoot, cliName) }];
}

function expectedFiles(): string[] {
  return [launchAgent];
}

function sameEntries(left: TreeEntry[], right: TreeEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function snapshotOwnedTree(root: string): Promise<OwnedTreeEntry[]> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Owned tree root is not a directory: ${root}`);
  const output: OwnedTreeEntry[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const entryMetadata = await lstat(path);
      if (entryMetadata.isDirectory() && !entryMetadata.isSymbolicLink()) {
        output.push({ path: relativePath, kind: "dir" });
        await visit(path, relativePath);
      } else if (entryMetadata.isSymbolicLink()) {
        output.push({ path: relativePath, kind: "link", target: await readlink(path) });
      } else if (entryMetadata.isFile()) {
        output.push({ path: relativePath, kind: "file", sha256: await sha256(path), mode: entryMetadata.mode & 0o777 });
      } else {
        throw new Error(`Owned tree contains an unsupported entry ${path}`);
      }
    }
  };
  await visit(root, "");
  return output;
}

async function writeTransactionIdentity(path: string): Promise<PathGeneration | undefined> {
  const token = randomUUID();
  await writeFile(join(path, TRANSACTION_TOKEN_NAME), `${token}\n`, { mode: 0o600 });
  const identity = await liveRootIdentity(path);
  return identity ? { ...identity, token } : undefined;
}

async function livePathMatchesGeneration(path: string, generation?: PathGeneration): Promise<boolean> {
  if (!generation) return false;
  const live = await liveRootIdentity(path);
  if (!live || live.dev !== generation.dev || live.ino !== generation.ino) return false;
  try {
    return (await readFile(join(path, TRANSACTION_TOKEN_NAME), "utf8")).trim() === generation.token;
  } catch {
    return false;
  }
}

async function assertLink(entry: LinkEntry): Promise<void> {
  const metadata = await optionalLstat(entry.path);
  if (!metadata) throw new Error(`Managed link is missing: ${entry.path}`);
  if (!metadata.isSymbolicLink()) throw new Error(`Managed link was replaced: ${entry.path}`);
  const target = await readlink(entry.path);
  if (target !== entry.target) throw new Error(`Managed link drifted: ${entry.path}`);
}

async function assertFile(entry: FileEntry): Promise<void> {
  const metadata = await optionalLstat(entry.path);
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Managed file is missing or replaced: ${entry.path}`);
  if ((Number(metadata.mode) & 0o777) !== entry.mode || await sha256(entry.path) !== entry.sha256) {
    throw new Error(`Managed file drifted: ${entry.path}`);
  }
}

function isForeignLaunchAgent(path: string): boolean {
  return path === orchestrationLaunchAgent || path === reaperLaunchAgent;
}

async function validateReceipt(receipt: Receipt): Promise<void> {
  if (receipt.version !== 1 || receipt.schema !== 1) throw new Error("Install receipt has an unsupported schema");
  if (!/^\d+\.\d+\.\d+$/.test(receipt.runtimeVersion) || receipt.runtimeRoot !== runtimeRoot) {
    throw new Error("Install receipt does not belong to this T3 auto guardian installation");
  }
  const links = expectedLinks();
  if (receipt.links.length !== links.length || receipt.links.some((entry, index) => entry.path !== links[index]?.path || entry.target !== links[index]?.target)) {
    throw new Error("Install receipt link ownership does not match this installation");
  }
  const files = expectedFiles();
  if (receipt.files.length !== files.length || receipt.files.some((entry, index) => entry.path !== files[index])) {
    throw new Error("Install receipt file ownership does not match this installation");
  }
  if (receipt.files.some((entry) => isForeignLaunchAgent(entry.path))) {
    throw new Error("Install receipt must never own the t3-orchestration or worktree-reaper LaunchAgent");
  }
  if (receipt.runtime.some((entry) => entry.path.startsWith("/") || entry.path.split("/").includes(".."))) {
    throw new Error("Install receipt contains an unsafe managed path");
  }
  await assertStableRoot();
  await Promise.all(receipt.links.map((entry) => assertLink(entry)));
  await Promise.all(receipt.files.map((entry) => assertFile(entry)));
  const runtime = await snapshotTree(runtimeRoot);
  if (!sameEntries(runtime, receipt.runtime)) throw new Error(`Managed runtime drifted under ${runtimeRoot}`);
}

function sameOwnedTree(left: OwnedTreeEntry[], right: OwnedTreeEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function writeJournal(journal: InstallJournal): Promise<void> {
  try { journal.transactionTree = await snapshotOwnedTree(journal.transactionRoot); }
  catch { journal.transactionTree = undefined; }
  if (journal.installedRoot) {
    try { journal.rootTree = await snapshotOwnedTree(journal.installRoot); }
    catch { /* keep the last successful root snapshot */ }
  }
  await mkdir(installerStateDir, { recursive: true, mode: 0o755 });
  const temporary = `${journalPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, journalPath);
}

async function readJournalFrom(path: string): Promise<InstallJournal | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as InstallJournal;
    if (parsed.version !== 1 || typeof parsed.transactionRoot !== "string" || typeof parsed.installRoot !== "string") {
      return undefined;
    }
    return parsed;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function clearJournalAt(path: string): Promise<void> {
  await rm(path, { force: true });
  await rm(`${path}.tmp`, { force: true });
}

async function clearJournal(): Promise<void> {
  await clearJournalAt(journalPath);
  if (legacyJournalPath !== journalPath) await clearJournalAt(legacyJournalPath);
}

async function crashIf(phase: string): Promise<void> {
  if (process.env.T3_AUTO_GUARDIAN_INSTALL_CRASH === phase) process.exit(75);
}

async function snapshotArtifact(path: string): Promise<DestinationArtifact | undefined> {
  const metadata = await optionalLstat(path);
  if (!metadata) return undefined;
  if (metadata.isSymbolicLink()) return { kind: "link", target: await readlink(path) };
  if (metadata.isFile() && !metadata.isSymbolicLink()) {
    return { kind: "file", sha256: await sha256(path), mode: Number(metadata.mode) & 0o777 };
  }
  return undefined;
}

function sameArtifact(left: DestinationArtifact, right: DestinationArtifact): boolean {
  if (left.kind === "link" && right.kind === "link") return left.target === right.target;
  if (left.kind === "file" && right.kind === "file") return left.sha256 === right.sha256 && left.mode === right.mode;
  return false;
}

async function liveIsJournalArtifact(path: string, artifact: DestinationArtifact | undefined): Promise<boolean> {
  if (!artifact) return false;
  const live = await snapshotArtifact(path);
  return Boolean(live && sameArtifact(live, artifact));
}

async function restoreDestinations(journal: Pick<InstallJournal, "kind" | "destinations">): Promise<void> {
  for (const destination of [...journal.destinations].reverse()) {
    const live = await optionalLstat(destination.destination);
    if (live && !(destination.installed && await liveIsJournalArtifact(destination.destination, destination.artifact))) {
      continue;
    }
    if (destination.backup && await optionalLstat(destination.backup)) {
      await rm(destination.destination, { force: true, recursive: true });
      await rename(destination.backup, destination.destination);
    } else if (destination.installed) {
      await rm(destination.destination, { force: true, recursive: true });
    }
  }
}

async function persistDestination(journal: InstallJournal, destinations: JournalDestination[], entry: JournalDestination): Promise<void> {
  const index = destinations.findIndex((item) => item.destination === entry.destination);
  if (index >= 0) destinations[index] = entry;
  else destinations.push(entry);
  journal.destinations = destinations.map((item) => ({ ...item }));
  journal.phase = journal.kind === "uninstall" ? journal.phase : "destinations-moved";
  await writeJournal(journal);
}

async function liveRootIdentity(path: string): Promise<{ dev: string; ino: string } | undefined> {
  const metadata = await optionalLstat(path);
  if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
}

async function liveRootIsJournaled(journal: Pick<InstallJournal, "installRoot" | "rootIdentity">): Promise<boolean> {
  if (!journal.rootIdentity) return false;
  const live = await liveRootIdentity(journal.installRoot);
  return Boolean(live && live.dev === journal.rootIdentity.dev && live.ino === journal.rootIdentity.ino);
}

async function liveTreeMatches(path: string, expected?: OwnedTreeEntry[]): Promise<boolean> {
  if (!expected) return false;
  try {
    return sameOwnedTree(await snapshotOwnedTree(path), expected);
  } catch {
    return false;
  }
}

async function liveRootMatchesJournaledTree(journal: Pick<InstallJournal, "installRoot" | "rootTree">): Promise<boolean> {
  return liveTreeMatches(journal.installRoot, journal.rootTree);
}

async function removeExactDirectory(
  path: string,
  identity: { dev: string; ino: string },
  expectedTree?: OwnedTreeEntry[],
): Promise<void> {
  const live = await liveRootIdentity(path);
  if (!live || live.dev !== identity.dev || live.ino !== identity.ino) return;
  if (expectedTree && !await liveTreeMatches(path, expectedTree)) return;
  const trash = `${path}.reclaim-${randomUUID()}`;
  try {
    await rename(path, trash);
  } catch {
    return;
  }
  const moved = await liveRootIdentity(trash);
  if (!moved || moved.dev !== identity.dev || moved.ino !== identity.ino || (expectedTree && !await liveTreeMatches(trash, expectedTree))) {
    if (!await optionalLstat(path)) await rename(trash, path).catch(() => undefined);
    return;
  }
  await rm(trash, { force: true, recursive: true }).catch(() => undefined);
}

async function journaledInstallRootIsExact(journal: Pick<InstallJournal, "installRoot" | "rootIdentity" | "rootTree">): Promise<boolean> {
  return await liveRootIsJournaled(journal) && await liveRootMatchesJournaledTree(journal);
}

async function removeJournaledInstallRoot(journal: InstallJournal): Promise<void> {
  if (journal.kind === "uninstall" || !journal.installedRoot) return;
  if (!journal.rootIdentity) return;
  if (!await journaledInstallRootIsExact(journal)) return;
  await removeExactDirectory(journal.installRoot, journal.rootIdentity, journal.rootTree);
}

async function removeJournaledTransactionRoot(
  journal: Pick<InstallJournal, "transactionRoot" | "transactionIdentity" | "transactionTree">,
): Promise<void> {
  if (!await livePathMatchesGeneration(journal.transactionRoot, journal.transactionIdentity)) return;
  if (!await liveTreeMatches(journal.transactionRoot, journal.transactionTree)) return;
  await removeExactDirectory(journal.transactionRoot, journal.transactionIdentity!, journal.transactionTree);
}

async function rollbackFromJournal(journal: InstallJournal): Promise<void> {
  await restoreDestinations(journal);
  if (journal.previousInstall && await optionalLstat(journal.previousInstall)) {
    if (await optionalLstat(journal.installRoot) && !await journaledInstallRootIsExact(journal)) return;
    if (await optionalLstat(journal.installRoot)) {
      if (!journal.rootIdentity) return;
      await removeExactDirectory(journal.installRoot, journal.rootIdentity, journal.rootTree);
    }
    if (await optionalLstat(journal.installRoot)) return;
    await rename(journal.previousInstall, journal.installRoot);
  } else {
    await removeJournaledInstallRoot(journal);
  }
  await removeJournaledTransactionRoot(journal);
}

async function recoverJournalAt(path: string): Promise<void> {
  const journal = await readJournalFrom(path);
  if (!journal) return;
  if (journal.phase !== "complete") {
    await rollbackFromJournal(journal);
    if (journal.serviceWasLoaded) await activate();
  } else await removeJournaledTransactionRoot(journal);
  await clearJournalAt(path);
}

async function recoverInterruptedInstall(): Promise<void> {
  await recoverJournalAt(journalPath);
  if (legacyJournalPath !== journalPath) await recoverJournalAt(legacyJournalPath);
}

async function readReceipt(): Promise<Receipt | undefined> {
  try {
    const parsed = JSON.parse(await readFile(receiptPath, "utf8")) as Receipt;
    await validateReceipt(parsed);
    return parsed;
  } catch (error) {
    if (isMissing(error)) {
      const rootMetadata = await optionalLstat(installRoot);
      if (rootMetadata) throw new Error(`Refusing unowned installation directory ${installRoot}`);
      return undefined;
    }
    if (error instanceof SyntaxError) throw new Error(`Install receipt is not valid JSON: ${receiptPath}`);
    throw error;
  }
}

async function assertDestinationOwnership(path: string, receipt: Receipt | undefined): Promise<void> {
  if (isForeignLaunchAgent(path)) throw new Error(`Refusing to write ${path === orchestrationLaunchAgent ? ORCHESTRATION_LAUNCH_AGENT_LABEL : REAPER_LAUNCH_AGENT_LABEL}`);
  const metadata = await optionalLstat(path);
  if (!metadata) return;
  if (!receipt || (!receipt.links.some((entry) => entry.path === path) && !receipt.files.some((entry) => entry.path === path))) {
    throw new Error(`Refusing to replace unowned path ${path}`);
  }
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function bunExecutable(): Promise<string> {
  const result = await Bun.$`command -v bun`.nothrow().quiet();
  const path = result.text().trim();
  if (result.exitCode !== 0 || !path || path.includes("\n")) throw new Error("Could not resolve a stable bun executable");
  return path;
}

function plistFor(cliPath: string, bunPath: string): string {
  const inheritedConfig = ["CODEX_HOME", "T3_HOME", "T3_ORCHESTRATION_SOCKET", "T3_AUTO_GUARDIAN_CONFIG"].flatMap((name) =>
    process.env[name] ? [`<string>${name}=${escapeXml(process.env[name]!)}</string>`] : []
  );
  const launchPath = `${home}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${home}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${GUARDIAN_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string><string>-i</string>
    <string>HOME=${escapeXml(home!)}</string><string>PATH=${escapeXml(launchPath)}</string>
    ${inheritedConfig.join("")}
    <string>${escapeXml(bunPath)}</string><string>${escapeXml(cliPath)}</string><string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(runtimeRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(join(t3Home, "t3-auto-guardian.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(t3Home, "t3-auto-guardian.err.log"))}</string>
</dict></plist>
`;
}

async function launchctlLoaded(domain: string): Promise<boolean> {
  return (await Bun.$`launchctl print ${domain}/${GUARDIAN_LAUNCH_AGENT_LABEL}`.nothrow().quiet()).exitCode === 0;
}

async function launchctlDomain(): Promise<string> {
  const uid = Number(process.env.UID ?? (await Bun.$`id -u`.text()).trim());
  if (!Number.isInteger(uid) || uid < 0) throw new Error("Could not determine the current macOS user id");
  return `gui/${uid}`;
}

async function deactivateIfLoaded(): Promise<void> {
  const domain = await launchctlDomain();
  const service = `${domain}/${GUARDIAN_LAUNCH_AGENT_LABEL}`;
  if (!await launchctlLoaded(domain)) return;
  const bootout = await Bun.$`launchctl bootout ${service}`.nothrow().quiet();
  if (bootout.exitCode !== 0) throw new Error(`Could not unload ${GUARDIAN_LAUNCH_AGENT_LABEL}: ${bootout.stderr.toString().trim()}`);
  for (let attempt = 0; attempt < 50 && await launchctlLoaded(domain); attempt++) await Bun.sleep(100);
  if (await launchctlLoaded(domain)) throw new Error(`Timed out waiting for ${GUARDIAN_LAUNCH_AGENT_LABEL} to unload`);
}

async function activate(): Promise<void> {
  const domain = await launchctlDomain();
  const service = `${domain}/${GUARDIAN_LAUNCH_AGENT_LABEL}`;
  await deactivateIfLoaded();
  let bootstrapError = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const bootstrap = await Bun.$`launchctl bootstrap ${domain} ${launchAgent}`.nothrow().quiet();
    if (bootstrap.exitCode === 0) { bootstrapError = ""; break; }
    bootstrapError = bootstrap.stderr.toString().trim();
    await Bun.sleep(250);
  }
  if (bootstrapError) throw new Error(`Could not install ${GUARDIAN_LAUNCH_AGENT_LABEL}: ${bootstrapError}`);
  const kickstart = await Bun.$`launchctl kickstart -k ${service}`.nothrow().quiet();
  if (kickstart.exitCode !== 0) throw new Error(`Could not start ${GUARDIAN_LAUNCH_AGENT_LABEL}: ${kickstart.stderr.toString().trim()}`);
}

async function stageInstall(runtimeVersion: string, temporaryRoot: string): Promise<Receipt> {
  await lstat(join(runtimeSource, cliName));
  const stageRuntime = join(temporaryRoot, "runtime");
  await copyGuardianRuntime(runtimeSource, stageRuntime);
  const linksDirectory = join(temporaryRoot, "staged-links");
  await mkdir(linksDirectory, { recursive: true, mode: 0o700 });
  for (const [index, link] of expectedLinks().entries()) {
    await symlink(link.target, join(linksDirectory, String(index)));
  }
  await ensureDirectory(t3Home, 0o700);
  await chmod(t3Home, 0o700);
  const launchPath = await bunExecutable();
  const stagedLaunchAgent = join(temporaryRoot, "launchAgent.plist");
  const plist = plistFor(join(runtimeRoot, cliName), launchPath);
  if (plist.includes(ORCHESTRATION_LAUNCH_AGENT_LABEL) || plist.includes(REAPER_LAUNCH_AGENT_LABEL)) {
    throw new Error("Refusing to write a guardian plist that mentions the orchestration daemon or worktree reaper label");
  }
  await writeFile(stagedLaunchAgent, plist, { mode: 0o644 });
  const receipt: Receipt = {
    version: 1,
    schema: 1,
    runtimeVersion,
    runtimeRoot,
    runtime: await snapshotTree(stageRuntime),
    links: expectedLinks(),
    files: [{ path: launchAgent, sha256: await sha256(stagedLaunchAgent), mode: 0o644 }],
  };
  await writeFile(join(temporaryRoot, "install-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

async function rollbackTransaction(
  transactionRoot: string,
  previousInstall: string | undefined,
  movedDestinations: JournalDestination[],
  installedRoot: boolean,
  placedRoot?: { dev: string; ino: string },
  rootTree?: OwnedTreeEntry[],
  transactionIdentity?: PathGeneration,
  transactionTree?: OwnedTreeEntry[],
): Promise<void> {
  await restoreDestinations({ kind: "install", destinations: movedDestinations });
  const placed = { installRoot, rootIdentity: placedRoot, rootTree };
  if (installedRoot && placedRoot && await journaledInstallRootIsExact(placed)) {
    await removeExactDirectory(installRoot, placedRoot, rootTree);
  }
  if (previousInstall && await optionalLstat(previousInstall)) {
    if (await optionalLstat(installRoot) && !(placedRoot && await journaledInstallRootIsExact(placed))) {
      await removeJournaledTransactionRoot({ transactionRoot, transactionIdentity, transactionTree });
      return;
    }
    if (await optionalLstat(installRoot)) {
      if (!placedRoot || !await journaledInstallRootIsExact(placed)) {
        await removeJournaledTransactionRoot({ transactionRoot, transactionIdentity, transactionTree });
        return;
      }
      await removeExactDirectory(installRoot, placedRoot, rootTree);
    }
    if (await optionalLstat(installRoot)) {
      await removeJournaledTransactionRoot({ transactionRoot, transactionIdentity, transactionTree });
      return;
    }
    await rename(previousInstall, installRoot);
  }
  await removeJournaledTransactionRoot({ transactionRoot, transactionIdentity, transactionTree });
}

async function install(runtimeVersion: string, previous: Receipt | undefined): Promise<void> {
  const destinationLinks = expectedLinks();
  const destinationFiles = expectedFiles();
  for (const path of [...destinationLinks.map((entry) => entry.path), ...destinationFiles]) {
    await assertDestinationOwnership(path, previous);
  }
  await ensureDirectory(dirname(installRoot), 0o755);
  await ensureDirectory(dirname(join(bin, "t3-auto-guardian")), 0o755);
  await ensureDirectory(launchAgents, 0o755);
  const domain = await launchctlDomain();
  const loaded = await launchctlLoaded(domain);
  if (loaded && !previous) throw new Error(`Refusing to replace loaded ${GUARDIAN_LAUNCH_AGENT_LABEL} without an install receipt`);
  const previousLoaded = Boolean(previous) && loaded;

  const transactionRoot = await mkdtemp(join(dirname(installRoot), ".t3-auto-guardian-transaction-"));
  const transactionIdentity = await writeTransactionIdentity(transactionRoot);
  const stagedRoot = join(transactionRoot, "new-install");
  const previousInstall = previous ? join(transactionRoot, "old-install") : undefined;
  const backupsRoot = join(transactionRoot, "backups");
  await mkdir(stagedRoot, { recursive: true, mode: 0o700 });
  await mkdir(backupsRoot, { recursive: true, mode: 0o700 });
  let receipt: Receipt;
  try {
    receipt = await stageInstall(runtimeVersion, stagedRoot);
  } catch (error) {
    const tree = await snapshotOwnedTree(transactionRoot).catch(() => undefined);
    await removeJournaledTransactionRoot({ transactionRoot, transactionIdentity, transactionTree: tree });
    throw error;
  }
  const movedDestinations: JournalDestination[] = [];
  let installedRoot = false;
  let placedRoot: { dev: string; ino: string } | undefined;
  const journal: InstallJournal = {
    version: 1,
    kind: "install",
    phase: "prepared",
    transactionRoot,
    installRoot,
    ...(previousInstall ? { previousInstall } : {}),
    destinations: [],
    installedRoot: false,
    ...(transactionIdentity ? { transactionIdentity } : {}),
  };
  await writeJournal(journal);
  try {
    if (previous && previousInstall) await rename(installRoot, previousInstall);
    journal.phase = "root-moved";
    await writeJournal(journal);
    await crashIf("root-moved");
    journal.installedRoot = true;
    journal.phase = "root-installed";
    await writeJournal(journal);
    await crashIf("root-installing");
    await rename(stagedRoot, installRoot);
    placedRoot = await liveRootIdentity(installRoot);
    journal.rootIdentity = placedRoot;
    try { journal.rootTree = await snapshotOwnedTree(installRoot); }
    catch { journal.rootTree = undefined; }
    await writeJournal(journal);
    installedRoot = true;
    await crashIf("root-installed");
    for (const [index, link] of receipt.links.entries()) {
      const destination = link.path;
      const existing = await optionalLstat(destination);
      const backup = existing ? join(backupsRoot, `link-${index}`) : undefined;
      const staged = join(installRoot, "staged-links", String(index));
      if (backup) {
        await persistDestination(journal, movedDestinations, { destination, backup, installed: false });
        await rename(destination, backup);
        await crashIf("link-backed-up");
        const artifact = await snapshotArtifact(staged);
        await persistDestination(journal, movedDestinations, { destination, backup, installed: true, artifact });
        await rename(staged, destination);
      } else {
        const artifact = await snapshotArtifact(staged);
        await persistDestination(journal, movedDestinations, { destination, installed: true, artifact });
        await rename(staged, destination);
      }
      await writeJournal(journal);
      await crashIf("link-installed");
    }
    for (const [index, file] of receipt.files.entries()) {
      const destination = file.path;
      if (isForeignLaunchAgent(destination)) throw new Error(`Refusing to write ${destination === orchestrationLaunchAgent ? ORCHESTRATION_LAUNCH_AGENT_LABEL : REAPER_LAUNCH_AGENT_LABEL}`);
      const existing = await optionalLstat(destination);
      const backup = existing ? join(backupsRoot, `file-${index}`) : undefined;
      const staged = join(installRoot, "launchAgent.plist");
      if (backup) {
        await persistDestination(journal, movedDestinations, { destination, backup, installed: false });
        await rename(destination, backup);
        await crashIf("plist-backed-up");
        const artifact = await snapshotArtifact(staged);
        await persistDestination(journal, movedDestinations, { destination, backup, installed: true, artifact });
        await rename(staged, destination);
      } else {
        const artifact = await snapshotArtifact(staged);
        await persistDestination(journal, movedDestinations, { destination, installed: true, artifact });
        await rename(staged, destination);
      }
      await writeJournal(journal);
      await crashIf("plist-installed");
    }
    await rm(join(installRoot, "staged-links"), { recursive: true, force: true });
    journal.phase = "destinations-moved";
    await writeJournal(journal);
    await activate();
    journal.phase = "complete";
    await writeJournal(journal);
  } catch (error) {
    let serviceRollbackError: unknown;
    if (!previousLoaded) {
      try { await deactivateIfLoaded(); }
      catch (cleanupError) { serviceRollbackError = cleanupError; }
    }
    try { await rollbackTransaction(transactionRoot, previousInstall, movedDestinations, installedRoot, placedRoot, journal.rootTree, journal.transactionIdentity, journal.transactionTree); }
    catch (rollbackError) {
      throw new AggregateError(
        serviceRollbackError ? [error, serviceRollbackError, rollbackError] : [error, rollbackError],
        "T3 auto guardian install and filesystem rollback both failed",
      );
    }
    if (previousLoaded) {
      try { await activate(); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], "T3 auto guardian install and service rollback both failed"); }
    }
    if (serviceRollbackError) throw new AggregateError([error, serviceRollbackError], "T3 auto guardian install and service rollback both failed");
    await clearJournal();
    throw error;
  }
  await removeJournaledTransactionRoot(journal);
  await clearJournal();
  console.log(JSON.stringify({
    root: sourceRoot,
    mode: "host",
    installRoot,
    binaries: receipt.links.map((entry) => entry.path),
    launchAgent,
    launchAgentLabel: GUARDIAN_LAUNCH_AGENT_LABEL,
  }));
}

async function uninstallInstallation(previous: Receipt | undefined): Promise<void> {
  if (!previous) throw new Error(`No T3 auto guardian install receipt exists at ${receiptPath}`);
  await validateReceipt(previous);
  const domain = await launchctlDomain();
  const serviceWasLoaded = await launchctlLoaded(domain);
  const transactionRoot = await mkdtemp(join(dirname(installRoot), ".t3-auto-guardian-uninstall-"));
  const transactionIdentity = await writeTransactionIdentity(transactionRoot);
  const installBackup = join(transactionRoot, "install");
  const movedDestinations: JournalDestination[] = [];
  const journal: InstallJournal = {
    version: 1,
    kind: "uninstall",
    phase: "prepared",
    transactionRoot,
    installRoot,
    destinations: [],
    installedRoot: false,
    serviceWasLoaded,
    ...(transactionIdentity ? { transactionIdentity } : {}),
  };
  await writeJournal(journal);
  await crashIf("uninstall-prepared");
  if (serviceWasLoaded) {
    const bootout = await Bun.$`launchctl bootout ${domain}/${GUARDIAN_LAUNCH_AGENT_LABEL}`.nothrow().quiet();
    if (bootout.exitCode !== 0) throw new Error(`Could not stop ${GUARDIAN_LAUNCH_AGENT_LABEL}: ${bootout.stderr.toString().trim()}`);
  }
  await crashIf("uninstall-bootout");
  try {
    for (const [index, link] of previous.links.entries()) {
      const backup = join(transactionRoot, `link-${index}`);
      await persistDestination(journal, movedDestinations, { destination: link.path, backup, installed: false });
      await rename(link.path, backup);
      await crashIf("uninstall-link-moved");
    }
    for (const [index, file] of previous.files.entries()) {
      if (isForeignLaunchAgent(file.path)) throw new Error(`Refusing to remove ${file.path === orchestrationLaunchAgent ? ORCHESTRATION_LAUNCH_AGENT_LABEL : REAPER_LAUNCH_AGENT_LABEL}`);
      const backup = join(transactionRoot, `file-${index}`);
      await persistDestination(journal, movedDestinations, { destination: file.path, backup, installed: false });
      await rename(file.path, backup);
      await crashIf("uninstall-plist-moved");
    }
    journal.previousInstall = installBackup;
    await writeJournal(journal);
    await rename(installRoot, installBackup);
    journal.phase = "root-moved";
    await writeJournal(journal);
    await crashIf("uninstall-root-moved");
    journal.phase = "complete";
    await writeJournal(journal);
  } catch (error) {
    try { await rollbackFromJournal(journal); }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "T3 auto guardian uninstall and filesystem rollback both failed");
    }
    if (serviceWasLoaded) {
      try { await activate(); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], "T3 auto guardian uninstall and service rollback both failed"); }
    }
    await clearJournal();
    throw error;
  }
  await removeJournaledTransactionRoot(journal);
  await clearJournal();
  console.log(JSON.stringify({ ok: true, uninstalled: true, installRoot, launchAgentLabel: GUARDIAN_LAUNCH_AGENT_LABEL }));
}

const runtimeVersion = await readPackageVersion();
await withInstallerLock(async () => {
  await recoverInterruptedInstall();
  const previous = await readReceipt();
  if (uninstall) await uninstallInstallation(previous);
  else await install(runtimeVersion, previous);
});
