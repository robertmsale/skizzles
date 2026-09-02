#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, symlink, writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

type Receipt = {
  schema: 1;
  version: string;
  mode: "client" | "host";
  runtimeRoot: string;
  skillRoot: string;
  runtimeSha256: string;
  skillSha256: string;
  links: Array<{ path: string; target: string }>;
  launchAgent?: { path: string; sha256: string };
  httpTokenStored?: boolean;
};

const operatorHome = absoluteEnvironmentPath("HOME", process.env.HOME);
const args = new Set(process.argv.slice(2));
const clientOnly = args.delete("--client-only");
const uninstall = args.delete("--uninstall");
const tokenFromStdin = args.delete("--http-token-stdin");
if (args.size > 0) throw new Error(`unknown installer option ${[...args][0]}`);
if (clientOnly && tokenFromStdin) throw new Error("--http-token-stdin is only valid for a host install");

const sourceRoot = resolve(import.meta.dir, "..");
const skizzlesRoot = resolve(sourceRoot, "../..");
const dataHome = optionalEnvironmentPath("XDG_DATA_HOME", process.env.XDG_DATA_HOME) ?? join(operatorHome, ".local/share");
const installRoot = optionalEnvironmentPath("OMP_ORCHESTRATION_INSTALL_ROOT", process.env.OMP_ORCHESTRATION_INSTALL_ROOT) ?? join(dataHome, "skizzles/omp-orchestration");
assertSafeInstallRoot(installRoot, operatorHome, dataHome);
const runtimeRoot = join(installRoot, "runtime");
const skillRoot = join(installRoot, "skill");
const receiptPath = join(installRoot, "install-receipt.json");
const binRoot = join(operatorHome, ".local/bin");
const codexSkillsRoot = join(operatorHome, ".codex/skills");
const launchAgentLabel = "io.github.skizzles.omp-orchestration";
const launchAgentPath = join(operatorHome, "Library/LaunchAgents", `${launchAgentLabel}.plist`);
const mode = clientOnly ? "client" : "host";

const existingReceipt = await readReceipt();
if (uninstall) {
  if (!existingReceipt) throw new Error("OMP orchestration installation is not owned by this installer");
  await validateOwned(existingReceipt);
  if (existingReceipt.mode === "host") await bootout();
  for (const link of existingReceipt.links) await rm(link.path, { force: true });
  if (existingReceipt.launchAgent) await rm(existingReceipt.launchAgent.path, { force: true });
  if (existingReceipt.httpTokenStored) await deleteHttpToken();
  await rm(installRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ uninstalled: true, installRoot }, null, 2));
  process.exit(0);
}

if (existingReceipt) await validateOwned(existingReceipt);
else if (await optionalLstat(installRoot)) throw new Error(`refusing unowned installation directory ${installRoot}`);
const ompBinary = clientOnly ? undefined : await resolveOmpBinary();
const version = await packageVersion();
const links = [
  { path: join(binRoot, "ompctl"), target: join(runtimeRoot, "src/cli.ts") },
  { path: join(codexSkillsRoot, "omp-orchestration"), target: skillRoot },
  ...(clientOnly ? [] : [{ path: join(binRoot, "omp-orchestrationd"), target: join(runtimeRoot, "src/daemon.ts") }]),
];
for (const link of links) await assertReplaceableLink(link.path, link.target, existingReceipt);
if (!clientOnly) await assertReplaceableFile(launchAgentPath, existingReceipt?.launchAgent);
if (clientOnly && existingReceipt?.mode === "host") await bootout();

await mkdir(dirname(installRoot), { recursive: true, mode: 0o755 });
const stage = await mkdtemp(join(dirname(installRoot), ".skizzles-omp-install-"));
try {
  await copyTree(join(sourceRoot, "src"), join(stage, "runtime/src"));
  await copyTree(join(sourceRoot, "prompts"), join(stage, "runtime/prompts"));
  await mkdir(join(stage, "runtime/scripts"), { recursive: true, mode: 0o755 });
  await copyFile(join(sourceRoot, "scripts/launch.ts"), join(stage, "runtime/scripts/launch.ts"));
  await chmod(join(stage, "runtime/scripts/launch.ts"), 0o755);
  for (const name of ["package.json", "README.md"]) await copyFile(join(sourceRoot, name), join(stage, "runtime", name));
  await copyTree(join(skizzlesRoot, "skills/omp-orchestration"), join(stage, "skill"));
  if (existingReceipt) await rm(installRoot, { recursive: true, force: true });
  await rename(stage, installRoot);
} catch (error) {
  await rm(stage, { recursive: true, force: true });
  throw error;
}

await mkdir(binRoot, { recursive: true, mode: 0o755 });
await mkdir(codexSkillsRoot, { recursive: true, mode: 0o755 });
for (const link of links) await ensureLink(link.path, link.target, existingReceipt);
for (const stale of existingReceipt?.links ?? []) {
  if (!links.some((link) => link.path === stale.path)) await rm(stale.path, { force: true });
}

let launchAgent: Receipt["launchAgent"];
let httpTokenStored = existingReceipt?.httpTokenStored ?? false;
if (!clientOnly) {
  if (tokenFromStdin) { await storeHttpToken(); httpTokenStored = true; }
  const plist = launchAgentPlist(join(runtimeRoot, "scripts/launch.ts"), ompBinary!);
  await mkdir(dirname(launchAgentPath), { recursive: true, mode: 0o755 });
  await assertReplaceableFile(launchAgentPath, existingReceipt?.launchAgent);
  await writeFile(launchAgentPath, plist, { mode: 0o600 });
  launchAgent = { path: launchAgentPath, sha256: digest(plist) };
} else if (existingReceipt?.launchAgent) {
  await rm(existingReceipt.launchAgent.path, { force: true });
  if (httpTokenStored) { await deleteHttpToken(); httpTokenStored = false; }
}

const receipt: Receipt = {
  schema: 1,
  version,
  mode,
  runtimeRoot,
  skillRoot,
  runtimeSha256: await treeDigest(runtimeRoot),
  skillSha256: await treeDigest(skillRoot),
  links,
  ...(launchAgent ? { launchAgent } : {}),
  ...(httpTokenStored ? { httpTokenStored: true } : {}),
};
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
if (!clientOnly) await bootstrap();
console.log(JSON.stringify({ installed: true, mode, installRoot, links: links.map((link) => link.path), launchAgent: launchAgent?.path ?? null }, null, 2));

async function readReceipt(): Promise<Receipt | undefined> {
  try {
    const parsed = JSON.parse(await readFile(receiptPath, "utf8")) as Receipt;
    const expectedLinks = new Map<string, string>([
      [join(binRoot, "ompctl"), join(runtimeRoot, "src/cli.ts")],
      [join(codexSkillsRoot, "omp-orchestration"), skillRoot],
    ]);
    if (parsed.mode === "host") expectedLinks.set(join(binRoot, "omp-orchestrationd"), join(runtimeRoot, "src/daemon.ts"));
    if (
      parsed.schema !== 1 || (parsed.mode !== "client" && parsed.mode !== "host") ||
      parsed.runtimeRoot !== runtimeRoot || parsed.skillRoot !== skillRoot ||
      !/^[a-f0-9]{64}$/.test(parsed.runtimeSha256) || !/^[a-f0-9]{64}$/.test(parsed.skillSha256) ||
      !Array.isArray(parsed.links) || parsed.links.length !== expectedLinks.size ||
      new Set(parsed.links.map((link) => link.path)).size !== parsed.links.length ||
      parsed.links.some((link) => typeof link?.path !== "string" || typeof link?.target !== "string" || expectedLinks.get(link.path) !== link.target) ||
      (parsed.mode === "host" && (!parsed.launchAgent || parsed.launchAgent.path !== launchAgentPath || !/^[a-f0-9]{64}$/.test(parsed.launchAgent.sha256))) ||
      (parsed.mode === "client" && parsed.launchAgent !== undefined) ||
      (parsed.httpTokenStored !== undefined && typeof parsed.httpTokenStored !== "boolean")
    ) {
      throw new Error(`invalid OMP orchestration install receipt: ${receiptPath}`);
    }
    return parsed;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function validateOwned(receipt: Receipt): Promise<void> {
  if (await treeDigest(receipt.runtimeRoot) !== receipt.runtimeSha256) throw new Error(`managed runtime drifted: ${receipt.runtimeRoot}`);
  if (await treeDigest(receipt.skillRoot) !== receipt.skillSha256) throw new Error(`managed skill drifted: ${receipt.skillRoot}`);
  for (const link of receipt.links) {
    const metadata = await lstat(link.path).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
    if (!metadata?.isSymbolicLink() || await readlink(link.path) !== link.target) throw new Error(`managed link drifted: ${link.path}`);
  }
  if (receipt.launchAgent) {
    const contents = await readFile(receipt.launchAgent.path, "utf8").catch((error) => isMissing(error) ? "" : Promise.reject(error));
    if (!contents || digest(contents) !== receipt.launchAgent.sha256) throw new Error(`managed LaunchAgent drifted: ${receipt.launchAgent.path}`);
  }
}

async function ensureLink(path: string, target: string, receipt: Receipt | undefined): Promise<void> {
  const owned = receipt?.links.find((entry) => entry.path === path);
  const metadata = await lstat(path).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
  if (metadata) {
    if (!owned || !metadata.isSymbolicLink() || await readlink(path) !== owned.target) throw new Error(`refusing to replace unowned path ${path}`);
    if (owned.target === target) return;
    await rm(path);
  }
  await symlink(target, path);
}

async function assertReplaceableLink(path: string, target: string, receipt: Receipt | undefined): Promise<void> {
  const owned = receipt?.links.find((entry) => entry.path === path);
  const metadata = await lstat(path).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
  if (!metadata) return;
  if (!owned || !metadata.isSymbolicLink() || await readlink(path) !== owned.target || owned.target !== target) {
    throw new Error(`refusing to replace unowned path ${path}`);
  }
}

async function assertReplaceableFile(path: string, owned: Receipt["launchAgent"] | undefined): Promise<void> {
  const metadata = await lstat(path).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
  if (!metadata) return;
  if (!owned || !metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`refusing to replace unowned path ${path}`);
}

async function copyTree(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`source tree is invalid: ${source}`);
  await mkdir(destination, { recursive: true, mode: metadata.mode & 0o777 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const item = await lstat(from);
    if (item.isDirectory() && !item.isSymbolicLink()) await copyTree(from, to);
    else if (item.isFile() && !item.isSymbolicLink()) { await copyFile(from, to); await chmod(to, item.mode & 0o777); }
    else throw new Error(`source tree contains unsupported entry: ${from}`);
  }
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const metadata = await lstat(path);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        hash.update(`d\0${relativePath}\0${metadata.mode & 0o777}\0`);
        await visit(path, relativePath);
      } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
        hash.update(`f\0${relativePath}\0${metadata.mode & 0o777}\0`);
        hash.update(await readFile(path));
        hash.update("\0");
      } else throw new Error(`managed tree contains unsupported entry: ${path}`);
    }
  };
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`managed tree is invalid: ${root}`);
  await visit(root, "");
  return hash.digest("hex");
}

async function packageVersion(): Promise<string> {
  const value = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) throw new Error("package version is invalid");
  return value.version;
}

async function storeHttpToken(): Promise<void> {
  const token = (await new Response(Bun.stdin.stream()).text()).trim();
  if (!token || token.length < 24 || /[\0\r\n]/.test(token)) throw new Error("HTTP token from stdin must be at least 24 characters");
  const result = Bun.spawnSync(["security", "add-generic-password", "-U", "-s", "skizzles-omp-orchestration", "-a", "http-token", "-w", token], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "could not store HTTP token in Keychain");
}

async function deleteHttpToken(): Promise<void> {
  Bun.spawnSync(["security", "delete-generic-password", "-s", "skizzles-omp-orchestration", "-a", "http-token"], {
    stdout: "ignore", stderr: "ignore",
  });
}

function launchAgentPlist(launchPath: string, ompPath: string): string {
  const inherited = [
    "OMP_ORCHESTRATION_HOME", "OMP_ORCHESTRATION_SOCKET", "OMP_ORCHESTRATION_DATABASE",
    "OMP_ORCHESTRATION_HTTP_PORT", "OMP_ORCHESTRATION_HTTP_HOST", "OMP_ORCHESTRATION_HTTP_PROJECTS",
  ].flatMap((name) => process.env[name] ? [`<key>${name}</key><string>${xml(process.env[name]!)}</string>`] : []);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${launchAgentLabel}</string>\n<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(launchPath)}</string></array>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(operatorHome!)}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>OMP_BINARY</key><string>${xml(ompPath)}</string>${inherited.join("")}</dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string>\n<key>StandardOutPath</key><string>${xml(join(operatorHome!, "Library/Logs/omp-orchestrationd.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(join(operatorHome!, "Library/Logs/omp-orchestrationd.error.log"))}</string>\n</dict></plist>\n`;
}

async function resolveOmpBinary(): Promise<string> {
  const configured = process.env.OMP_BINARY?.trim();
  const candidate = configured ? configured.startsWith("/") ? configured : Bun.which(configured) : Bun.which("omp");
  if (!candidate || !candidate.startsWith("/") || /[\0\r\n]/.test(candidate)) {
    throw new Error("Could not resolve an absolute OMP binary; install omp or set OMP_BINARY to its absolute path");
  }
  try { await access(candidate, constants.X_OK); } catch { throw new Error(`OMP binary is not executable: ${candidate}`); }
  return candidate;
}

async function bootout(): Promise<void> {
  Bun.spawnSync(["launchctl", "bootout", `gui/${operatorUid()}/${launchAgentLabel}`], { stdout: "ignore", stderr: "ignore" });
}

async function bootstrap(): Promise<void> {
  await bootout();
  const result = Bun.spawnSync(["launchctl", "bootstrap", `gui/${operatorUid()}`, launchAgentPath], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "could not load OMP orchestration LaunchAgent");
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function operatorUid(): number { const uid = process.getuid?.(); if (uid === undefined) throw new Error("macOS user id is unavailable"); return uid; }
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

function absoluteEnvironmentPath(name: string, value: string | undefined): string {
  const path = value?.trim();
  if (!path || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error(`${name} must be an absolute path`);
  return resolve(path);
}

function optionalEnvironmentPath(name: string, value: string | undefined): string | undefined {
  return value?.trim() ? absoluteEnvironmentPath(name, value) : undefined;
}

function assertSafeInstallRoot(path: string, home: string, dataRoot: string): void {
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 3 || path === home || path === dataRoot) {
    throw new Error(`OMP_ORCHESTRATION_INSTALL_ROOT is too broad: ${path}`);
  }
}
