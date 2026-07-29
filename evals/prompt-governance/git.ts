import { execFileSync } from "node:child_process";
import { lstat, mkdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { assertContained, changedSnapshotPaths, readCappedText, redactSensitiveText, snapshotHash, snapshotTree, writeText } from "./fs";
import type { TreeSnapshot } from "./types";

export const DIFF_CAP_BYTES = 1 * 1024 * 1024;

export function git(root: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed in ${root}: ${detail}`);
  }
}

export function initializeGitFixture(root: string): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Prompt evaluation fixture"]);
  git(root, ["config", "user.email", "prompt-eval@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture baseline"]);
}

export function changedPaths(root: string): string[] {
  const output = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return output
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort();
}

export function initialSnapshot(root: string): string {
  return git(root, ["rev-parse", "HEAD"]).trim();
}

export async function writeDiffArtifact(
  artifactRoot: string,
  fixtureRoot: string,
  baselineHead: string,
): Promise<{ path: string; bytes: number; storedBytes: number; truncated: boolean }> {
  const path = assertContained(artifactRoot, join(artifactRoot, "fixture.diff"), "diff artifact");
  await mkdir(artifactRoot, { recursive: true });
  const captured = await boundedDiff(fixtureRoot, baselineHead, DIFF_CAP_BYTES);
  const safeText = redactSensitiveText(captured.text);
  await writeText(path, safeText);
  return { path, bytes: captured.bytes, storedBytes: Buffer.byteLength(safeText), truncated: captured.truncated };
}

export async function diff(root: string, baselineHead: string): Promise<string> {
  return (await boundedDiff(root, baselineHead, DIFF_CAP_BYTES)).text;
}

async function boundedDiff(root: string, baselineHead: string, cap: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const tracked = gitCapped(root, ["diff", baselineHead, "--no-ext-diff", "--binary"], cap);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  const parts = [tracked];
  const additions: string[] = [];
  for (const path of untracked) {
    const fullPath = join(root, path);
    const metadata = await lstat(fullPath);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(fullPath);
      additions.push(`diff --git a/${path} b/${path}\nnew file mode 120000\n--- /dev/null\n+++ b/${path}\n@@\n${target}\n`);
    } else if (metadata.isFile()) {
      const content = await readCappedText(fullPath, cap);
      additions.push(`diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@\n${content.text}${content.truncated ? "\n[file truncated by harness]\n" : ""}`);
    } else {
      additions.push(`diff --git a/${path} b/${path}\n[unsupported untracked entry omitted]\n`);
    }
  }
  if (additions.length > 0) parts.push(additions.join("\n"));
  const full = parts.filter(Boolean).join(tracked && additions.length > 0 ? "\n" : "");
  const bytes = Buffer.byteLength(full);
  if (bytes <= cap) return { text: full, bytes, truncated: false };
  const bounded = new TextDecoder().decode(Buffer.from(full).subarray(0, cap));
  return { text: `${bounded}\n[diff truncated by harness]\n`, bytes, truncated: true };
}

function gitCapped(root: string, args: readonly string[], cap: number): string {
  try {
    const output = execFileSync("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer: cap + 1, stdio: ["ignore", "pipe", "pipe"] });
    return output.toString("utf8");
  } catch (error) {
    const partial = error && typeof error === "object" && "stdout" in error && Buffer.isBuffer(error.stdout) ? error.stdout : undefined;
    if (partial) return partial.subarray(0, cap).toString("utf8") + "\n[tracked diff truncated by harness]\n";
    throw error;
  }
}

export async function baselineTree(root: string): Promise<{ snapshot: TreeSnapshot; hash: string }> {
  const snapshot = await snapshotTree(root);
  return { snapshot, hash: snapshotHash(snapshot) };
}

export async function changedFromBaseline(root: string, baseline: TreeSnapshot): Promise<{ paths: string[]; snapshot: TreeSnapshot; hash: string }> {
  const snapshot = await snapshotTree(root);
  return { paths: changedSnapshotPaths(baseline, snapshot), snapshot, hash: snapshotHash(snapshot) };
}
