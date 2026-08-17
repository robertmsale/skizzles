import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const REAPER_LAUNCH_AGENT_LABEL = "io.github.skizzles.t3-worktree-reaper";
const ORCHESTRATION_LAUNCH_AGENT_LABEL = "io.github.t3-orchestration.daemon";

type TreeEntry = { path: string; sha256: string; mode: number };
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
if (flags.has("--client-only")) throw new Error("t3-worktree-reaper is host-only and refuses --client-only");
const unsupportedFlags = [...flags].filter((flag) => !["--uninstall"].includes(flag));
if (unsupportedFlags.length > 0) throw new Error(`Unknown installer option ${unsupportedFlags[0]}`);

const sourceRoot = resolve(import.meta.dir, "..");
const runtimeSource = join(sourceRoot, "src");
const bin = join(home, ".local/bin");
const t3Home = resolve(process.env.T3_HOME?.trim() || join(home, ".t3"));
const launchAgents = join(home, "Library/LaunchAgents");
const launchAgent = join(launchAgents, `${REAPER_LAUNCH_AGENT_LABEL}.plist`);
const orchestrationLaunchAgent = join(launchAgents, `${ORCHESTRATION_LAUNCH_AGENT_LABEL}.plist`);
const dataRoot = resolve(process.env.XDG_DATA_HOME?.trim() || join(home, ".local/share"));
const installRoot = resolve(process.env.T3_WORKTREE_REAPER_INSTALL_ROOT?.trim() || join(dataRoot, "skizzles/t3-worktree-reaper"));
const runtimeRoot = join(installRoot, "runtime");
const receiptPath = join(installRoot, "install-receipt.json");
const cliName = "worktree-reaper-cli.ts";

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
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

async function copyTree(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Runtime source must be a directory: ${source}`);
  await mkdir(destination, { recursive: true, mode: metadata.mode & 0o777 });
  await chmod(destination, metadata.mode & 0o777);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const entryMetadata = await lstat(sourcePath);
    if (entryMetadata.isDirectory() && !entryMetadata.isSymbolicLink()) {
      await copyTree(sourcePath, destinationPath);
      continue;
    }
    if (!entryMetadata.isFile() || entryMetadata.isSymbolicLink()) {
      throw new Error(`Refusing to copy non-regular runtime input ${sourcePath}`);
    }
    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, entryMetadata.mode & 0o777);
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
  return [{ path: join(bin, "t3-worktree-reaper"), target: join(runtimeRoot, cliName) }];
}

function expectedFiles(): string[] {
  return [launchAgent];
}

function sameEntries(left: TreeEntry[], right: TreeEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

async function validateReceipt(receipt: Receipt): Promise<void> {
  if (receipt.version !== 1 || receipt.schema !== 1) throw new Error("Install receipt has an unsupported schema");
  if (!/^\d+\.\d+\.\d+$/.test(receipt.runtimeVersion) || receipt.runtimeRoot !== runtimeRoot) {
    throw new Error("Install receipt does not belong to this T3 worktree reaper installation");
  }
  const links = expectedLinks();
  if (receipt.links.length !== links.length || receipt.links.some((entry, index) => entry.path !== links[index]?.path || entry.target !== links[index]?.target)) {
    throw new Error("Install receipt link ownership does not match this installation");
  }
  const files = expectedFiles();
  if (receipt.files.length !== files.length || receipt.files.some((entry, index) => entry.path !== files[index])) {
    throw new Error("Install receipt file ownership does not match this installation");
  }
  if (receipt.files.some((entry) => entry.path === orchestrationLaunchAgent)) {
    throw new Error("Install receipt must never own the t3-orchestration LaunchAgent");
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
  if (path === orchestrationLaunchAgent) throw new Error(`Refusing to write ${ORCHESTRATION_LAUNCH_AGENT_LABEL}`);
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
  const inheritedConfig = ["CODEX_HOME", "T3_HOME", "T3_ORCHESTRATION_SOCKET"].flatMap((name) =>
    process.env[name] ? [`<string>${name}=${escapeXml(process.env[name]!)}</string>`] : []
  );
  const launchPath = `${home}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${home}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${REAPER_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string><string>-i</string>
    <string>HOME=${escapeXml(home!)}</string><string>PATH=${escapeXml(launchPath)}</string>
    ${inheritedConfig.join("")}
    <string>${escapeXml(bunPath)}</string><string>${escapeXml(cliPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(runtimeRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>1800</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(join(t3Home, "t3-worktree-reaper.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(t3Home, "t3-worktree-reaper.err.log"))}</string>
</dict></plist>
`;
}

async function launchctlLoaded(domain: string): Promise<boolean> {
  return (await Bun.$`launchctl print ${domain}/${REAPER_LAUNCH_AGENT_LABEL}`.nothrow().quiet()).exitCode === 0;
}

async function launchctlDomain(): Promise<string> {
  const uid = Number(process.env.UID ?? (await Bun.$`id -u`.text()).trim());
  if (!Number.isInteger(uid) || uid < 0) throw new Error("Could not determine the current macOS user id");
  return `gui/${uid}`;
}

async function deactivateIfLoaded(): Promise<void> {
  const domain = await launchctlDomain();
  const service = `${domain}/${REAPER_LAUNCH_AGENT_LABEL}`;
  if (!await launchctlLoaded(domain)) return;
  const bootout = await Bun.$`launchctl bootout ${service}`.nothrow().quiet();
  if (bootout.exitCode !== 0) throw new Error(`Could not unload ${REAPER_LAUNCH_AGENT_LABEL}: ${bootout.stderr.toString().trim()}`);
  for (let attempt = 0; attempt < 50 && await launchctlLoaded(domain); attempt++) await Bun.sleep(100);
  if (await launchctlLoaded(domain)) throw new Error(`Timed out waiting for ${REAPER_LAUNCH_AGENT_LABEL} to unload`);
}

async function activate(): Promise<void> {
  const domain = await launchctlDomain();
  const service = `${domain}/${REAPER_LAUNCH_AGENT_LABEL}`;
  await deactivateIfLoaded();
  let bootstrapError = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const bootstrap = await Bun.$`launchctl bootstrap ${domain} ${launchAgent}`.nothrow().quiet();
    if (bootstrap.exitCode === 0) { bootstrapError = ""; break; }
    bootstrapError = bootstrap.stderr.toString().trim();
    await Bun.sleep(250);
  }
  if (bootstrapError) throw new Error(`Could not install ${REAPER_LAUNCH_AGENT_LABEL}: ${bootstrapError}`);
  const kickstart = await Bun.$`launchctl kickstart -k ${service}`.nothrow().quiet();
  if (kickstart.exitCode !== 0) throw new Error(`Could not start ${REAPER_LAUNCH_AGENT_LABEL}: ${kickstart.stderr.toString().trim()}`);
}

async function stageInstall(runtimeVersion: string, temporaryRoot: string): Promise<Receipt> {
  await lstat(join(runtimeSource, cliName));
  const stageRuntime = join(temporaryRoot, "runtime");
  await copyTree(runtimeSource, stageRuntime);
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
  if (plist.includes(ORCHESTRATION_LAUNCH_AGENT_LABEL)) {
    throw new Error("Refusing to write a reaper plist that mentions the orchestration daemon label");
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
  movedDestinations: Array<{ destination: string; backup?: string; installed: boolean }>,
  installedRoot: boolean,
): Promise<void> {
  for (const { destination, backup, installed } of movedDestinations.reverse()) {
    if (installed) await rm(destination, { force: true, recursive: true });
    if (backup) await rename(backup, destination);
  }
  if (installedRoot) await rm(installRoot, { force: true, recursive: true });
  if (previousInstall && await optionalLstat(previousInstall)) await rename(previousInstall, installRoot);
  await rm(transactionRoot, { force: true, recursive: true });
}

async function install(runtimeVersion: string, previous: Receipt | undefined): Promise<void> {
  const destinationLinks = expectedLinks();
  const destinationFiles = expectedFiles();
  for (const path of [...destinationLinks.map((entry) => entry.path), ...destinationFiles]) {
    await assertDestinationOwnership(path, previous);
  }
  await ensureDirectory(dirname(installRoot), 0o755);
  await ensureDirectory(dirname(join(bin, "t3-worktree-reaper")), 0o755);
  await ensureDirectory(launchAgents, 0o755);
  const domain = await launchctlDomain();
  const loaded = await launchctlLoaded(domain);
  if (loaded && !previous) throw new Error(`Refusing to replace loaded ${REAPER_LAUNCH_AGENT_LABEL} without an install receipt`);
  const previousLoaded = Boolean(previous) && loaded;

  const transactionRoot = await mkdtemp(join(dirname(installRoot), ".t3-worktree-reaper-transaction-"));
  const stagedRoot = join(transactionRoot, "new-install");
  const previousInstall = previous ? join(transactionRoot, "old-install") : undefined;
  const backupsRoot = join(transactionRoot, "backups");
  await mkdir(stagedRoot, { recursive: true, mode: 0o700 });
  await mkdir(backupsRoot, { recursive: true, mode: 0o700 });
  let receipt: Receipt;
  try {
    receipt = await stageInstall(runtimeVersion, stagedRoot);
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }
  const movedDestinations: Array<{ destination: string; backup?: string; installed: boolean }> = [];
  let installedRoot = false;
  try {
    if (previous && previousInstall) await rename(installRoot, previousInstall);
    await rename(stagedRoot, installRoot);
    installedRoot = true;
    for (const [index, link] of receipt.links.entries()) {
      const destination = link.path;
      const existing = await optionalLstat(destination);
      const backup = existing ? join(backupsRoot, `link-${index}`) : undefined;
      if (backup) await rename(destination, backup);
      const moved = { destination, backup, installed: false };
      movedDestinations.push(moved);
      await rename(join(installRoot, "staged-links", String(index)), destination);
      moved.installed = true;
    }
    for (const [index, file] of receipt.files.entries()) {
      const destination = file.path;
      if (destination === orchestrationLaunchAgent) throw new Error(`Refusing to write ${ORCHESTRATION_LAUNCH_AGENT_LABEL}`);
      const existing = await optionalLstat(destination);
      const backup = existing ? join(backupsRoot, `file-${index}`) : undefined;
      if (backup) await rename(destination, backup);
      const moved = { destination, backup, installed: false };
      movedDestinations.push(moved);
      await rename(join(installRoot, "launchAgent.plist"), destination);
      moved.installed = true;
    }
    await rm(join(installRoot, "staged-links"), { recursive: true, force: true });
    await activate();
  } catch (error) {
    let serviceRollbackError: unknown;
    if (!previousLoaded) {
      try { await deactivateIfLoaded(); }
      catch (cleanupError) { serviceRollbackError = cleanupError; }
    }
    try { await rollbackTransaction(transactionRoot, previousInstall, movedDestinations, installedRoot); }
    catch (rollbackError) {
      throw new AggregateError(
        serviceRollbackError ? [error, serviceRollbackError, rollbackError] : [error, rollbackError],
        "T3 worktree reaper install and filesystem rollback both failed",
      );
    }
    if (previousLoaded) {
      try { await activate(); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], "T3 worktree reaper install and service rollback both failed"); }
    }
    if (serviceRollbackError) throw new AggregateError([error, serviceRollbackError], "T3 worktree reaper install and service rollback both failed");
    throw error;
  }
  await rm(transactionRoot, { force: true, recursive: true }).catch(() => undefined);
  console.log(JSON.stringify({
    root: sourceRoot,
    mode: "host",
    installRoot,
    binaries: receipt.links.map((entry) => entry.path),
    launchAgent,
    launchAgentLabel: REAPER_LAUNCH_AGENT_LABEL,
  }));
}

async function uninstallInstallation(previous: Receipt | undefined): Promise<void> {
  if (!previous) throw new Error(`No T3 worktree reaper install receipt exists at ${receiptPath}`);
  await validateReceipt(previous);
  const domain = await launchctlDomain();
  const serviceWasLoaded = await launchctlLoaded(domain);
  if (serviceWasLoaded) {
    const bootout = await Bun.$`launchctl bootout ${domain}/${REAPER_LAUNCH_AGENT_LABEL}`.nothrow().quiet();
    if (bootout.exitCode !== 0) throw new Error(`Could not stop ${REAPER_LAUNCH_AGENT_LABEL}: ${bootout.stderr.toString().trim()}`);
  }
  const transactionRoot = await mkdtemp(join(dirname(installRoot), ".t3-worktree-reaper-uninstall-"));
  const movedDestinations: Array<{ destination: string; backup?: string }> = [];
  const installBackup = join(transactionRoot, "install");
  let movedInstall = false;
  try {
    for (const [index, link] of previous.links.entries()) {
      const backup = join(transactionRoot, `link-${index}`);
      await rename(link.path, backup);
      movedDestinations.push({ destination: link.path, backup });
    }
    for (const [index, file] of previous.files.entries()) {
      if (file.path === orchestrationLaunchAgent) throw new Error(`Refusing to remove ${ORCHESTRATION_LAUNCH_AGENT_LABEL}`);
      const backup = join(transactionRoot, `file-${index}`);
      await rename(file.path, backup);
      movedDestinations.push({ destination: file.path, backup });
    }
    await rename(installRoot, installBackup);
    movedInstall = true;
  } catch (error) {
    if (movedInstall) await rename(installBackup, installRoot);
    for (const { destination, backup } of movedDestinations.reverse()) {
      await rm(destination, { force: true, recursive: true });
      if (backup) await rename(backup, destination);
    }
    await rm(transactionRoot, { force: true, recursive: true });
    if (serviceWasLoaded) {
      try { await activate(); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], "T3 worktree reaper uninstall and service rollback both failed"); }
    }
    throw error;
  }
  await rm(transactionRoot, { force: true, recursive: true }).catch(() => undefined);
  console.log(JSON.stringify({ ok: true, uninstalled: true, installRoot, launchAgentLabel: REAPER_LAUNCH_AGENT_LABEL }));
}

const runtimeVersion = await readPackageVersion();
const previous = await readReceipt();
if (uninstall) await uninstallInstallation(previous);
else await install(runtimeVersion, previous);
