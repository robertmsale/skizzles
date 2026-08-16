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
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";

type InstallMode = "client" | "host";
type TreeEntry = { path: string; sha256: string; mode: number };
type LinkEntry = { path: string; target: string };
type FileEntry = { path: string; sha256: string; mode: number };
type Receipt = {
  version: 1;
  runtimeVersion: string;
  mode: InstallMode;
  schema: 1;
  runtimeRoot: string;
  skillRoot: string;
  runtime: TreeEntry[];
  skill: TreeEntry[];
  links: LinkEntry[];
  files: FileEntry[];
};

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");

const flags = new Set(process.argv.slice(2));
const clientOnly = flags.has("--client-only");
const uninstall = flags.has("--uninstall");
const unsupportedFlags = [...flags].filter((flag) => !["--client-only", "--uninstall"].includes(flag));
if (unsupportedFlags.length > 0) throw new Error(`Unknown installer option ${unsupportedFlags[0]}`);

const mode: InstallMode = clientOnly ? "client" : "host";
const sourceRoot = resolve(import.meta.dir, "..");
const skizzlesRoot = resolve(sourceRoot, "../..");
const runtimeSource = join(sourceRoot, "src");
const skillSource = join(skizzlesRoot, "skills/t3-orchestration");
const bin = join(home, ".local/bin");
const skills = join(home, ".codex/skills");
const t3Home = resolve(process.env.T3_HOME?.trim() || join(home, ".t3"));
const socketPath = resolve(process.env.T3_ORCHESTRATION_SOCKET?.trim() || join(t3Home, "t3-orchestration.sock"));
const launchAgents = join(home, "Library/LaunchAgents");
const launchAgentLabel = "io.github.t3-orchestration.daemon";
const launchAgent = join(launchAgents, `${launchAgentLabel}.plist`);
const dataRoot = resolve(process.env.XDG_DATA_HOME?.trim() || join(home, ".local/share"));
const installRoot = resolve(process.env.T3_ORCHESTRATION_INSTALL_ROOT?.trim() || join(dataRoot, "skizzles/t3-orchestration"));
const runtimeRoot = join(installRoot, "runtime");
const skillRoot = join(installRoot, "skill");
const receiptPath = join(installRoot, "install-receipt.json");
const defaultTailscaleGatewayPort = 43_773;

function tailscaleGatewayPort(value: string | undefined): number {
  const normalized = value?.trim();
  if (!normalized) return defaultTailscaleGatewayPort;
  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("T3_ORCHESTRATION_HTTP_PORT must be an integer from 1024 through 65535");
  }
  return port;
}

const tailscaleGatewayPortNumber = tailscaleGatewayPort(process.env.T3_ORCHESTRATION_HTTP_PORT);

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
  if (JSON.stringify(entries) !== JSON.stringify(["install-receipt.json", "runtime", "skill"])) {
    throw new Error(`Managed install root drifted under ${installRoot}`);
  }
}

function expectedLinks(currentMode: InstallMode): LinkEntry[] {
  const links: LinkEntry[] = [
    { path: join(bin, "t3ctl"), target: join(runtimeRoot, "cli.ts") },
    { path: join(skills, "t3-orchestration"), target: skillRoot },
  ];
  if (currentMode === "host") links.push({ path: join(bin, "t3-orchestrationd"), target: join(runtimeRoot, "daemon.ts") });
  return links;
}

function expectedFiles(currentMode: InstallMode): string[] {
  return currentMode === "host" ? [launchAgent] : [];
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
  if (receipt.version !== 1 || receipt.schema !== 1 || (receipt.mode !== "client" && receipt.mode !== "host")) throw new Error("Install receipt has an unsupported schema");
  if (!/^\d+\.\d+\.\d+$/.test(receipt.runtimeVersion) || receipt.runtimeRoot !== runtimeRoot || receipt.skillRoot !== skillRoot) {
    throw new Error("Install receipt does not belong to this T3 orchestration installation");
  }
  const links = expectedLinks(receipt.mode);
  if (receipt.links.length !== links.length || receipt.links.some((entry, index) => entry.path !== links[index]?.path || entry.target !== links[index]?.target)) {
    throw new Error("Install receipt link ownership does not match this installation");
  }
  const files = expectedFiles(receipt.mode);
  if (receipt.files.length !== files.length || receipt.files.some((entry, index) => entry.path !== files[index])) {
    throw new Error("Install receipt file ownership does not match this installation");
  }
  if (receipt.runtime.some((entry) => entry.path.startsWith("/") || entry.path.split("/").includes("..")) || receipt.skill.some((entry) => entry.path.startsWith("/") || entry.path.split("/").includes(".."))) {
    throw new Error("Install receipt contains an unsafe managed path");
  }
  await assertStableRoot();
  await Promise.all(receipt.links.map((entry) => assertLink(entry)));
  await Promise.all(receipt.files.map((entry) => assertFile(entry)));
  const [runtime, skill] = await Promise.all([snapshotTree(runtimeRoot), snapshotTree(skillRoot)]);
  if (!sameEntries(runtime, receipt.runtime)) throw new Error(`Managed runtime drifted under ${runtimeRoot}`);
  if (!sameEntries(skill, receipt.skill)) throw new Error(`Managed skill drifted under ${skillRoot}`);
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

function plistFor(daemonPath: string, bunPath: string): string {
  const inheritedConfig = [
    "CODEX_HOME",
    "T3_HOME",
    "T3_ORCHESTRATION_SOCKET",
    "T3_ORCHESTRATION_HTTP_PORT",
    "T3_ORCHESTRATION_TAILSCALE_USERS",
    "T3_ORCHESTRATION_KEYCHAIN_ACCOUNT",
  ].flatMap((name) => process.env[name] ? [`<string>${name}=${escapeXml(process.env[name]!)}</string>`] : []);
  const launchPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${launchAgentLabel}</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string><string>-i</string>
    <string>HOME=${escapeXml(home!)}</string><string>PATH=${escapeXml(launchPath)}</string>
    ${inheritedConfig.join("")}
    <string>${escapeXml(bunPath)}</string><string>${escapeXml(daemonPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(runtimeRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(join(t3Home, "t3-orchestrationd.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(t3Home, "t3-orchestrationd.err.log"))}</string>
</dict></plist>
`;
}

async function launchctlLoaded(domain: string): Promise<boolean> {
  return (await Bun.$`launchctl print ${domain}/${launchAgentLabel}`.nothrow().quiet()).exitCode === 0;
}

async function launchctlDomain(): Promise<string> {
  const uid = Number(process.env.UID ?? (await Bun.$`id -u`.text()).trim());
  if (!Number.isInteger(uid) || uid < 0) throw new Error("Could not determine the current macOS user id");
  return `gui/${uid}`;
}

async function waitForSocket(path: string): Promise<boolean> {
  const probe = () => new Promise<boolean>((resolveProbe) => {
    const socket = connect(path);
    socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
    socket.once("error", () => { socket.destroy(); resolveProbe(false); });
  });
  let ready = await probe();
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    await Bun.sleep(100);
    ready = await probe();
  }
  return ready;
}

async function waitForGateway(port: number): Promise<boolean> {
  for (let attempt = 0; attempt <= 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(100),
      });
      await response.body?.cancel();
      return response.status === 200 && response.headers.get("x-t3-orchestration-gateway") === "1";
    } catch {
      if (attempt < 100) await Bun.sleep(100);
    }
  }
  return false;
}

async function deactivateHostIfLoaded(): Promise<void> {
  const domain = await launchctlDomain();
  const service = `${domain}/${launchAgentLabel}`;
  if (!await launchctlLoaded(domain)) return;
  const bootout = await Bun.$`launchctl bootout ${service}`.nothrow().quiet();
  if (bootout.exitCode !== 0) throw new Error(`Could not unload ${launchAgentLabel}: ${bootout.stderr.toString().trim()}`);
  for (let attempt = 0; attempt < 50 && await launchctlLoaded(domain); attempt++) await Bun.sleep(100);
  if (await launchctlLoaded(domain)) throw new Error(`Timed out waiting for ${launchAgentLabel} to unload`);
}

async function activateHost(): Promise<void> {
  const domain = await launchctlDomain();
  const service = `${domain}/${launchAgentLabel}`;
  await deactivateHostIfLoaded();
  let bootstrapError = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const bootstrap = await Bun.$`launchctl bootstrap ${domain} ${launchAgent}`.nothrow().quiet();
    if (bootstrap.exitCode === 0) { bootstrapError = ""; break; }
    bootstrapError = bootstrap.stderr.toString().trim();
    await Bun.sleep(250);
  }
  if (bootstrapError) throw new Error(`Could not install ${launchAgentLabel}: ${bootstrapError}`);
  const kickstart = await Bun.$`launchctl kickstart -k ${service}`.nothrow().quiet();
  if (kickstart.exitCode !== 0) throw new Error(`Could not start ${launchAgentLabel}: ${kickstart.stderr.toString().trim()}`);
  if (!await waitForSocket(socketPath)) throw new Error(`${launchAgentLabel} started but its Unix socket did not become ready`);
  if (process.env.T3_ORCHESTRATION_TAILSCALE_USERS?.trim()) {
    if (!await waitForGateway(tailscaleGatewayPortNumber)) {
      throw new Error(`${launchAgentLabel} started but its Tailscale gateway did not become ready on loopback port ${tailscaleGatewayPortNumber}`);
    }
  }
}

async function stageInstall(runtimeVersion: string, currentMode: InstallMode, temporaryRoot: string): Promise<Receipt> {
  await lstat(runtimeSource);
  await lstat(skillSource);
  const stageRuntime = join(temporaryRoot, "runtime");
  const stageSkill = join(temporaryRoot, "skill");
  await copyTree(runtimeSource, stageRuntime);
  await copyTree(skillSource, stageSkill);
  const linksDirectory = join(temporaryRoot, "staged-links");
  await mkdir(linksDirectory, { recursive: true, mode: 0o700 });
  for (const [index, link] of expectedLinks(currentMode).entries()) {
    await symlink(link.target, join(linksDirectory, String(index)));
  }
  const files: FileEntry[] = [];
  if (currentMode === "host") {
    await ensureDirectory(t3Home, 0o700);
    await chmod(t3Home, 0o700);
    const launchPath = await bunExecutable();
    const stagedLaunchAgent = join(temporaryRoot, "launchAgent.plist");
    await writeFile(stagedLaunchAgent, plistFor(join(runtimeRoot, "daemon.ts"), launchPath), { mode: 0o644 });
    files.push({ path: launchAgent, sha256: await sha256(stagedLaunchAgent), mode: 0o644 });
  }
  const receipt: Receipt = {
    version: 1,
    schema: 1,
    runtimeVersion,
    mode: currentMode,
    runtimeRoot,
    skillRoot,
    runtime: await snapshotTree(stageRuntime),
    skill: await snapshotTree(stageSkill),
    links: expectedLinks(currentMode),
    files,
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
  if (clientOnly && previous?.mode === "host") throw new Error("Client-only install refuses an existing host receipt; uninstall the host installation explicitly first");
  const destinationLinks = expectedLinks(mode);
  const destinationFiles = expectedFiles(mode);
  if (clientOnly) {
    for (const path of [join(bin, "t3-orchestrationd"), launchAgent]) {
      if (await optionalLstat(path)) throw new Error(`Client-only install refuses existing host artifact ${path}; remove the host installation explicitly first`);
    }
  }
  for (const path of [...destinationLinks.map((entry) => entry.path), ...destinationFiles]) await assertDestinationOwnership(path, previous);
  await ensureDirectory(dirname(installRoot), 0o755);
  await ensureDirectory(dirname(join(bin, "t3ctl")), 0o755);
  await ensureDirectory(dirname(join(skills, "t3-orchestration")), 0o755);
  if (!clientOnly) await ensureDirectory(launchAgents, 0o755);
  const hostDomain = !clientOnly ? await launchctlDomain() : undefined;
  const hostLoaded = hostDomain ? await launchctlLoaded(hostDomain) : false;
  if (hostLoaded && previous?.mode !== "host") {
    throw new Error(`Refusing to replace loaded ${launchAgentLabel} without a host install receipt`);
  }
  const previousHostLoaded = previous?.mode === "host" && hostLoaded;

  const transactionRoot = await mkdtemp(join(dirname(installRoot), ".t3-orchestration-transaction-"));
  const stagedRoot = join(transactionRoot, "new-install");
  const previousInstall = previous ? join(transactionRoot, "old-install") : undefined;
  const backupsRoot = join(transactionRoot, "backups");
  await mkdir(stagedRoot, { recursive: true, mode: 0o700 });
  await mkdir(backupsRoot, { recursive: true, mode: 0o700 });
  let receipt: Receipt;
  try {
    receipt = await stageInstall(runtimeVersion, mode, stagedRoot);
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
      const existing = await optionalLstat(destination);
      const backup = existing ? join(backupsRoot, `file-${index}`) : undefined;
      if (backup) await rename(destination, backup);
      const moved = { destination, backup, installed: false };
      movedDestinations.push(moved);
      await rename(join(installRoot, "launchAgent.plist"), destination);
      moved.installed = true;
    }
    await rm(join(installRoot, "staged-links"), { recursive: true, force: true });
    if (receipt.files.length > 0) await activateHost();
  } catch (error) {
    let serviceRollbackError: unknown;
    if (receipt.files.length > 0 && !previousHostLoaded) {
      try { await deactivateHostIfLoaded(); }
      catch (cleanupError) { serviceRollbackError = cleanupError; }
    }
    try { await rollbackTransaction(transactionRoot, previousInstall, movedDestinations, installedRoot); }
    catch (rollbackError) {
      throw new AggregateError(
        serviceRollbackError ? [error, serviceRollbackError, rollbackError] : [error, rollbackError],
        "T3 orchestration install and filesystem rollback both failed",
      );
    }
    if (previousHostLoaded) {
      try { await activateHost(); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], "T3 orchestration install and service rollback both failed"); }
    }
    if (serviceRollbackError) throw new AggregateError([error, serviceRollbackError], "T3 orchestration install and service rollback both failed");
    throw error;
  }
  await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
  console.log(JSON.stringify({
    root: sourceRoot,
    mode,
    installRoot,
    binaries: receipt.links.filter((entry) => entry.path.startsWith(bin)).map((entry) => entry.path),
    skill: join(skills, "t3-orchestration"),
    ...(receipt.files.length > 0 ? { launchAgent } : {}),
  }));
}

async function uninstallInstallation(previous: Receipt | undefined): Promise<void> {
  if (!previous) throw new Error(`No T3 orchestration install receipt exists at ${receiptPath}`);
  if (clientOnly && previous.mode === "host") throw new Error("Client-only uninstall refuses a host installation; use the host installer explicitly");
  await validateReceipt(previous);
  let domain: string | undefined;
  let serviceWasLoaded = false;
  if (previous.mode === "host") {
    domain = await launchctlDomain();
    serviceWasLoaded = await launchctlLoaded(domain);
    if (serviceWasLoaded) {
      const bootout = await Bun.$`launchctl bootout ${domain}/${launchAgentLabel}`.nothrow().quiet();
      if (bootout.exitCode !== 0) throw new Error(`Could not stop ${launchAgentLabel}: ${bootout.stderr.toString().trim()}`);
    }
  }
  const transactionRoot = await mkdtemp(join(dirname(installRoot), ".t3-orchestration-uninstall-"));
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
    await rm(transactionRoot, { recursive: true, force: true });
    if (serviceWasLoaded && domain) {
      try { await activateHost(); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], "T3 orchestration uninstall and service rollback both failed"); }
    }
    throw error;
  }
  await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
  console.log(JSON.stringify({ ok: true, uninstalled: true, installRoot }));
}

const runtimeVersion = await readPackageVersion();
const previous = await readReceipt();
if (uninstall) await uninstallInstallation(previous);
else await install(runtimeVersion, previous);
