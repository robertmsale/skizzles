import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type Transfer = "link" | "copy";

export interface SkillsReceipt {
  version: 1;
  sourceRoot: string;
  transfer: Transfer;
  skills: Array<{ name: string; target: string }>;
}

export interface SkillsOptions {
  codexHome: string;
  sourceRoot: string;
  transfer: Transfer;
  dryRun?: boolean;
}

const receiptName = "skills-receipt.json";

export function skillsReceiptPath(codexHome: string): string {
  return join(resolve(codexHome), ".skizzles", receiptName);
}

export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function copyDirectoryExclusive(
  source: string,
  target: string,
  copyEntry: (source: string, target: string) => void = (from, to) => cpSync(from, to, { recursive: true }),
): void {
  mkdirSync(target);
  try {
    for (const name of readdirSync(source)) {
      if (name === ".DS_Store") continue;
      copyEntry(join(source, name), join(target, name));
    }
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function assertManagedParentsAreReal(rootInput: string, managedParents: string[]): void {
  const root = resolve(rootInput);
  for (const path of [root, ...managedParents.map((parent) => join(root, parent))]) {
    if (pathEntryExists(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to manage through a symlinked parent: ${path}`);
    }
  }
}

function publicSkills(sourceRoot: string): Array<{ name: string; source: string }> {
  const root = join(resolve(sourceRoot), "skills");
  if (!existsSync(root)) throw new Error(`canonical skills directory is missing: ${root}`);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
    .map((entry) => ({ name: entry.name, source: join(root, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function sameTree(left: string, right: string): boolean {
  if (!existsSync(left) || !existsSync(right)) return false;
  const leftStat = lstatSync(left);
  const rightStat = lstatSync(right);
  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) return false;
  if (leftStat.isDirectory() !== rightStat.isDirectory()) return false;
  if (leftStat.isDirectory()) {
    const leftNames = readdirSync(left).filter((name) => name !== ".DS_Store").sort();
    const rightNames = readdirSync(right).filter((name) => name !== ".DS_Store").sort();
    if (leftNames.join("\0") !== rightNames.join("\0")) return false;
    return leftNames.every((name) => sameTree(join(left, name), join(right, name)));
  }
  return readFileSync(left).equals(readFileSync(right));
}

function readReceipt(codexHome: string): SkillsReceipt {
  const path = skillsReceiptPath(codexHome);
  if (!existsSync(path)) throw new Error(`Skizzles skills receipt is missing: ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SkillsReceipt>;
  if (value.version !== 1 || (value.transfer !== "link" && value.transfer !== "copy") || !Array.isArray(value.skills)) {
    throw new Error(`invalid Skizzles skills receipt: ${path}`);
  }
  return value as SkillsReceipt;
}

export function installSkills(options: SkillsOptions): SkillsReceipt {
  const codexHome = resolve(options.codexHome);
  const sourceRoot = resolve(options.sourceRoot);
  assertManagedParentsAreReal(codexHome, ["skills", ".skizzles"]);
  const receiptPath = skillsReceiptPath(codexHome);
  if (pathEntryExists(receiptPath)) throw new Error(`Skizzles skills receipt already exists: ${receiptPath}`);

  const skills = publicSkills(sourceRoot).map(({ name, source }) => ({
    name,
    source,
    target: join(codexHome, "skills", name),
  }));
  if (skills.length === 0) throw new Error("no public skills were found");
  const conflict = skills.find(({ target }) => pathEntryExists(target));
  if (conflict) throw new Error(`refusing to replace existing skill: ${conflict.target}`);

  const receipt: SkillsReceipt = {
    version: 1,
    sourceRoot,
    transfer: options.transfer,
    skills: skills.map(({ name, target }) => ({ name, target })),
  };
  if (options.dryRun) return receipt;

  mkdirSync(join(codexHome, "skills"), { recursive: true });
  const created: string[] = [];
  try {
    for (const skill of skills) {
      if (options.transfer === "link") symlinkSync(skill.source, skill.target, "dir");
      else copyDirectoryExclusive(skill.source, skill.target);
      created.push(skill.target);
    }
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    for (const target of created.reverse()) rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return receipt;
}

export function uninstallSkills(
  codexHomeInput: string,
  dryRun = false,
  move: (from: string, to: string) => void = renameSync,
): SkillsReceipt {
  const codexHome = resolve(codexHomeInput);
  assertManagedParentsAreReal(codexHome, ["skills", ".skizzles"]);
  const receipt = readReceipt(codexHome);
  for (const skill of receipt.skills) {
    const target = resolve(skill.target);
    const expectedParent = join(codexHome, "skills");
    if (dirname(target) !== expectedParent || !pathEntryExists(target)) {
      throw new Error(`owned skill target is missing or outside CODEX_HOME: ${target}`);
    }
    const source = join(receipt.sourceRoot, "skills", skill.name);
    if (receipt.transfer === "link") {
      if (!lstatSync(target).isSymbolicLink()) throw new Error(`owned link changed type: ${target}`);
      const actual = resolve(dirname(target), readlinkSync(target));
      if (actual !== resolve(source)) throw new Error(`owned link target drifted: ${target}`);
    } else if (!sameTree(source, target)) {
      throw new Error(`owned copied skill drifted: ${target}`);
    }
  }
  if (dryRun) return receipt;
  const quarantine = join(codexHome, ".skizzles", `uninstall-${crypto.randomUUID()}`);
  mkdirSync(quarantine);
  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const skill of receipt.skills) {
      const destination = join(quarantine, skill.name);
      move(skill.target, destination);
      moved.push({ from: skill.target, to: destination });
    }
    const receiptPath = skillsReceiptPath(codexHome);
    const receiptDestination = join(quarantine, receiptName);
    move(receiptPath, receiptDestination);
    moved.push({ from: receiptPath, to: receiptDestination });
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

export function receiptSummary(receipt: SkillsReceipt): Record<string, unknown> {
  return {
    surface: "skills",
    transfer: receipt.transfer,
    sourceRoot: receipt.sourceRoot,
    skills: receipt.skills.map(({ name, target }) => ({ name, target: relative(process.cwd(), target) || target })),
  };
}
