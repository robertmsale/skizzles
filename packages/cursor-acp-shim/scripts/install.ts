#!/usr/bin/env bun
import { chmod, copyFile, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");

const flags = new Set(process.argv.slice(2));
const uninstall = flags.has("--uninstall");
const unsupported = [...flags].filter((flag) => flag !== "--uninstall");
if (unsupported.length > 0) throw new Error(`Unknown installer option ${unsupported[0]}`);

const sourceRoot = resolve(import.meta.dir, "..");
const binName = "t3-cursor-acp";
const dataRoot = resolve(process.env.XDG_DATA_HOME?.trim() || join(home, ".local/share"));
const installRoot = resolve(process.env.T3_CURSOR_ACP_INSTALL_ROOT?.trim() || join(dataRoot, "skizzles/cursor-acp-shim"));
const binDir = join(home, ".local/bin");
const linkPath = join(binDir, binName);
const runtimeCli = join(installRoot, "src/cli.ts");
const sourceFiles = [
  "src/cli.ts",
  "src/fingerprint.ts",
  "src/framing.ts",
  "src/resolve-agent.ts",
  "src/supervisor.ts",
  "package.json",
  "README.md",
];

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function ownedLink(): Promise<boolean> {
  try {
    const target = await readlink(linkPath);
    return resolve(dirname(linkPath), target) === runtimeCli;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

if (uninstall) {
  if (await ownedLink()) await rm(linkPath);
  else {
    try {
      await lstat(linkPath);
      throw new Error(`Refusing to uninstall unowned ${linkPath}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  await rm(installRoot, { recursive: true, force: true });
  process.stdout.write(`uninstalled ${binName}\n`);
  process.exit(0);
}

await mkdir(join(installRoot, "src"), { recursive: true, mode: 0o755 });
await mkdir(binDir, { recursive: true, mode: 0o755 });
for (const relative of sourceFiles) {
  const destination = join(installRoot, relative);
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(join(sourceRoot, relative), destination);
}
await chmod(runtimeCli, 0o755);

try {
  const existing = await lstat(linkPath);
  if (existing.isSymbolicLink()) {
    if (!(await ownedLink())) throw new Error(`Refusing to replace unowned ${linkPath}`);
    await rm(linkPath);
  } else {
    throw new Error(`Refusing to replace non-symlink ${linkPath}`);
  }
} catch (error) {
  if (!isMissing(error)) throw error;
}
await symlink(runtimeCli, linkPath);
process.stdout.write(`installed ${linkPath} -> ${runtimeCli}\n`);
process.stdout.write("Point T3 Cursor Binary path at this command. Do not replace ~/.local/bin/agent.\n");
