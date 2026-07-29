import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type Transfer = "link" | "copy";
export type MovePath = (from: string, to: string) => void;

export interface QuarantinedPath {
  source: string;
  name: string;
}

export function canonicalExistingPath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
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

export function assertManagedParentsAreReal(rootInput: string, managedParents: string[]): void {
  const root = resolve(rootInput);
  for (const path of [root, ...managedParents.map((parent) => join(root, parent))]) {
    if (pathEntryExists(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to manage through a symlinked parent: ${path}`);
    }
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

export function removeOwnedPathsTransactionally(
  quarantineParent: string,
  quarantinePrefix: string,
  paths: QuarantinedPath[],
  move: MovePath = renameSync,
): void {
  const quarantine = join(quarantineParent, `${quarantinePrefix}-${crypto.randomUUID()}`);
  mkdirSync(quarantine);
  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const path of paths) {
      const to = join(quarantine, path.name);
      move(path.source, to);
      moved.push({ from: path.source, to });
    }
  } catch (error) {
    for (const item of moved.reverse()) {
      if (pathEntryExists(item.to) && !pathEntryExists(item.from)) renameSync(item.to, item.from);
    }
    rmSync(quarantine, { recursive: true, force: true });
    throw error;
  }
  try {
    rmSync(quarantine, { recursive: true, force: true });
  } catch {}
}
