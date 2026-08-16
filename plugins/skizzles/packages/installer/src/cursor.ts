import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  assertManagedParentsAreReal,
  copyDirectoryExclusive,
  pathEntryExists,
  type Transfer,
} from "./core";

interface InstalledEntry {
  source: string;
  target: string;
  kind: "directory" | "file";
  transfer: Transfer | "copy-only";
  fingerprint: string;
}

export interface CursorHarnessReceipt {
  version: 1;
  sourceRoot: string;
  cursorHome: string;
  transfer: Transfer;
  entries: InstalledEntry[];
}

export interface CursorHarnessOptions {
  cursorHome: string;
  sourceRoot: string;
  transfer: Transfer;
  dryRun?: boolean;
}

const receiptName = "cursor-receipt.json";
const pluginRelativeRoot = "plugins/local/skizzles";
const reservedCursorSkillDir = "skills-cursor";

export function cursorHarnessReceiptPath(cursorHome: string): string {
  return join(resolve(cursorHome), ".skizzles", receiptName);
}

function fingerprint(path: string): string {
  const hash = createHash("sha256");
  const visit = (current: string, prefix: string): void => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${prefix}\0${readlinkSync(current)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`dir\0${prefix}\0`);
      for (const name of readdirSync(current).filter((entry) => entry !== ".DS_Store").sort()) {
        visit(join(current, name), prefix ? `${prefix}/${name}` : name);
      }
      return;
    }
    hash.update(`file\0${prefix}\0`);
    hash.update(readFileSync(current));
    hash.update("\0");
  };
  visit(path, "");
  return hash.digest("hex");
}

function portableSkills(sourceRoot: string): string[] {
  const manifestPath = join(sourceRoot, "cursor/portable-skills.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: unknown;
    skills?: unknown;
  };
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.skills) ||
    manifest.skills.some((skill) => typeof skill !== "string" || skill.length === 0)
  ) {
    throw new Error(`invalid Cursor portable-skills manifest: ${manifestPath}`);
  }
  return [...new Set(manifest.skills as string[])].sort();
}

function plannedEntries(options: CursorHarnessOptions): InstalledEntry[] {
  const sourceRoot = resolve(options.sourceRoot);
  const cursorHome = resolve(options.cursorHome);
  const pluginRoot = join(sourceRoot, "cursor/plugin");
  const entries: InstalledEntry[] = [
    {
      source: join(pluginRoot, ".cursor-plugin/plugin.json"),
      target: join(cursorHome, pluginRelativeRoot, ".cursor-plugin/plugin.json"),
      kind: "file",
      transfer: "copy-only",
      fingerprint: "",
    },
    {
      source: join(pluginRoot, "rules/skizzles-cursor.md"),
      target: join(cursorHome, pluginRelativeRoot, "rules/skizzles-cursor.md"),
      kind: "file",
      transfer: "copy-only",
      fingerprint: "",
    },
  ];
  for (const skill of portableSkills(sourceRoot)) {
    if (skill === reservedCursorSkillDir) {
      throw new Error(`Cursor portable-skills manifest must not include reserved directory: ${skill}`);
    }
    entries.push({
      source: join(sourceRoot, "skills", skill),
      target: join(cursorHome, "skills", skill),
      kind: "directory",
      transfer: options.transfer,
      fingerprint: "",
    });
  }
  for (const entry of entries) {
    if (entry.target.includes(`${reservedCursorSkillDir}/`) || entry.target.endsWith(`/${reservedCursorSkillDir}`)) {
      throw new Error(`refusing to write Cursor's reserved built-in skill directory: ${entry.target}`);
    }
    if (!pathEntryExists(entry.source)) throw new Error(`canonical Cursor harness input is missing: ${entry.source}`);
    if (entry.kind === "directory" && !lstatSync(entry.source).isDirectory()) {
      throw new Error(`canonical Cursor harness directory is invalid: ${entry.source}`);
    }
    if (entry.kind === "file" && !lstatSync(entry.source).isFile()) {
      throw new Error(`canonical Cursor harness file is invalid: ${entry.source}`);
    }
    entry.fingerprint = fingerprint(entry.source);
  }
  return entries;
}

function readReceipt(cursorHome: string): CursorHarnessReceipt {
  const path = cursorHarnessReceiptPath(cursorHome);
  if (!existsSync(path)) throw new Error(`Skizzles Cursor harness receipt is missing: ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CursorHarnessReceipt>;
  if (
    value.version !== 1 ||
    typeof value.sourceRoot !== "string" ||
    typeof value.cursorHome !== "string" ||
    (value.transfer !== "link" && value.transfer !== "copy") ||
    !Array.isArray(value.entries)
  ) {
    throw new Error(`invalid Skizzles Cursor harness receipt: ${path}`);
  }
  return value as CursorHarnessReceipt;
}

function validateReceiptEntries(receipt: CursorHarnessReceipt, cursorHome: string): void {
  const sourceRoot = resolve(receipt.sourceRoot);
  const pluginTarget = join(cursorHome, pluginRelativeRoot);
  const fixedEntries = new Map<string, Omit<InstalledEntry, "fingerprint">>([
    [
      join(pluginTarget, ".cursor-plugin/plugin.json"),
      {
        source: join(sourceRoot, "cursor/plugin/.cursor-plugin/plugin.json"),
        target: join(pluginTarget, ".cursor-plugin/plugin.json"),
        kind: "file",
        transfer: "copy-only",
      },
    ],
    [
      join(pluginTarget, "rules/skizzles-cursor.md"),
      {
        source: join(sourceRoot, "cursor/plugin/rules/skizzles-cursor.md"),
        target: join(pluginTarget, "rules/skizzles-cursor.md"),
        kind: "file",
        transfer: "copy-only",
      },
    ],
  ]);
  const seen = new Set<string>();
  for (const entry of receipt.entries) {
    if (
      !entry ||
      typeof entry.source !== "string" ||
      typeof entry.target !== "string" ||
      (entry.kind !== "file" && entry.kind !== "directory") ||
      (entry.transfer !== "link" && entry.transfer !== "copy" && entry.transfer !== "copy-only") ||
      typeof entry.fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.fingerprint)
    ) {
      throw new Error("Cursor harness receipt contains an invalid entry");
    }
    const target = resolve(entry.target);
    if (seen.has(target)) throw new Error(`Cursor harness receipt contains a duplicate target: ${target}`);
    seen.add(target);
    const fixed = fixedEntries.get(target);
    if (fixed) {
      if (
        resolve(entry.source) !== fixed.source ||
        entry.kind !== fixed.kind ||
        entry.transfer !== fixed.transfer
      ) {
        throw new Error(`Cursor harness receipt entry does not match its owned target: ${target}`);
      }
      continue;
    }
    const skillRoot = join(cursorHome, "skills");
    const skillName = relative(skillRoot, target);
    if (
      entry.kind !== "directory" ||
      entry.transfer !== receipt.transfer ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skillName) ||
      skillName === reservedCursorSkillDir ||
      resolve(entry.source) !== join(sourceRoot, "skills", skillName)
    ) {
      throw new Error(`Cursor harness receipt contains an unexpected target: ${target}`);
    }
  }
  for (const target of fixedEntries.keys()) {
    if (!seen.has(target)) throw new Error(`Cursor harness receipt is missing an owned target: ${target}`);
  }
}

export function installCursorHarness(options: CursorHarnessOptions): CursorHarnessReceipt {
  const cursorHome = resolve(options.cursorHome);
  const sourceRoot = resolve(options.sourceRoot);
  assertManagedParentsAreReal(cursorHome, [
    "skills",
    reservedCursorSkillDir,
    "plugins",
    "plugins/local",
    pluginRelativeRoot,
    `${pluginRelativeRoot}/.cursor-plugin`,
    `${pluginRelativeRoot}/rules`,
    ".skizzles",
  ]);
  if (pathEntryExists(join(cursorHome, reservedCursorSkillDir)) && lstatSync(join(cursorHome, reservedCursorSkillDir)).isSymbolicLink()) {
    throw new Error(`refusing to manage through a symlinked parent: ${join(cursorHome, reservedCursorSkillDir)}`);
  }
  const receiptPath = cursorHarnessReceiptPath(cursorHome);
  if (pathEntryExists(receiptPath)) throw new Error(`Skizzles Cursor harness receipt already exists: ${receiptPath}`);
  const entries = plannedEntries({ ...options, cursorHome, sourceRoot });
  const conflict = entries.find(({ target }) => pathEntryExists(target));
  if (conflict) throw new Error(`refusing to replace existing Cursor harness target: ${conflict.target}`);
  const receipt: CursorHarnessReceipt = { version: 1, sourceRoot, cursorHome, transfer: options.transfer, entries };
  if (options.dryRun) return receipt;

  const created: string[] = [];
  try {
    for (const entry of entries) {
      mkdirSync(dirname(entry.target), { recursive: true });
      if (entry.transfer === "link") {
        symlinkSync(entry.source, entry.target, entry.kind === "directory" ? "dir" : "file");
      } else if (entry.kind === "directory") {
        copyDirectoryExclusive(entry.source, entry.target);
      } else {
        copyFileSync(entry.source, entry.target);
      }
      created.push(entry.target);
    }
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    for (const target of created.reverse()) rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return receipt;
}

export function uninstallCursorHarness(
  cursorHomeInput: string,
  dryRun = false,
  move: (from: string, to: string) => void = renameSync,
): CursorHarnessReceipt {
  const cursorHome = resolve(cursorHomeInput);
  assertManagedParentsAreReal(cursorHome, [
    "skills",
    reservedCursorSkillDir,
    "plugins",
    "plugins/local",
    pluginRelativeRoot,
    `${pluginRelativeRoot}/.cursor-plugin`,
    `${pluginRelativeRoot}/rules`,
    ".skizzles",
  ]);
  const receipt = readReceipt(cursorHome);
  if (resolve(receipt.cursorHome) !== cursorHome) throw new Error("Cursor harness receipt belongs to a different Cursor home");
  validateReceiptEntries(receipt, cursorHome);
  for (const entry of receipt.entries) {
    const target = resolve(entry.target);
    if (!pathEntryExists(target)) throw new Error(`owned Cursor harness target is missing: ${target}`);
    if (entry.transfer === "link") {
      if (!lstatSync(target).isSymbolicLink()) throw new Error(`owned Cursor harness link changed type: ${target}`);
      const actual = resolve(dirname(target), readlinkSync(target));
      if (actual !== resolve(entry.source)) throw new Error(`owned Cursor harness link target drifted: ${target}`);
    } else if (fingerprint(target) !== entry.fingerprint) {
      throw new Error(`owned Cursor harness target drifted: ${target}`);
    }
  }
  if (dryRun) return receipt;

  const quarantine = join(cursorHome, ".skizzles", `cursor-uninstall-${crypto.randomUUID()}`);
  mkdirSync(quarantine);
  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const [index, entry] of receipt.entries.entries()) {
      const to = join(quarantine, `${index}-${entry.target.split("/").at(-1)}`);
      move(entry.target, to);
      moved.push({ from: entry.target, to });
    }
    const receiptPath = cursorHarnessReceiptPath(cursorHome);
    const to = join(quarantine, receiptName);
    move(receiptPath, to);
    moved.push({ from: receiptPath, to });
  } catch (error) {
    for (const item of moved.reverse()) {
      if (pathEntryExists(item.to) && !pathEntryExists(item.from)) renameSync(item.to, item.from);
    }
    rmSync(quarantine, { recursive: true, force: true });
    throw error;
  }
  try { rmSync(quarantine, { recursive: true, force: true }); } catch {}
  return receipt;
}

export function cursorReceiptSummary(receipt: CursorHarnessReceipt): Record<string, unknown> {
  return {
    surface: "cursor",
    transfer: receipt.transfer,
    cursorHome: receipt.cursorHome,
    targets: receipt.entries.map(({ target, transfer }) => ({
      target: relative(process.cwd(), target) || target,
      transfer,
    })),
  };
}
