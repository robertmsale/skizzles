import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../execution/process";
import type { LabMetadata } from "../storage/records";
import { expectedLabRuntimeRoot, type StateRoots } from "../storage/state";
import { recoverSyncTransactions } from "./sync";

export async function recoverLabSync(roots: StateRoots, lab: LabMetadata): Promise<void> {
  if (lab.runtimeRoot !== expectedLabRuntimeRoot(roots, lab.owner, lab.id) ||
      lab.workspace !== join(lab.runtimeRoot, "workspace")) {
    throw new Error("lab runtime containment is invalid");
  }
  try {
    if (!(await stat(lab.workspace)).isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const journalDirectory = join(lab.runtimeRoot, "sync", lab.id, "journals");
  let journals: string[];
  try {
    journals = await readdir(journalDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (journals.length === 0) return;
  await assertSourceRepositoryIdentity(lab);
  await recoverSyncTransactions({
    stateRoot: lab.runtimeRoot,
    labId: lab.id,
    allowedTargetRoots: [lab.sourceRoot, lab.workspace],
  });
}

export async function assertSourceRepositoryIdentity(lab: LabMetadata): Promise<void> {
  const commonGit = (await runCommand("git", [
    "-C", lab.sourceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir",
  ], { timeoutMs: 10_000 })).stdout.toString().trim();
  const actual = createHash("sha256").update(await realpath(commonGit)).digest("hex").slice(0, 12);
  if (actual !== lab.repoHash) {
    throw new Error("lab source repository identity no longer matches durable state");
  }
}

export async function assertCloneHasNoAlternates(
  workspace: string,
  signal?: AbortSignal,
): Promise<void> {
  const commonGit = (await runCommand("git", [
    "-C", workspace, "rev-parse", "--path-format=absolute", "--git-common-dir",
  ], { timeoutMs: 10_000, signal })).stdout.toString().trim();
  for (const name of ["alternates", "http-alternates"]) {
    try {
      await lstat(join(commonGit, "objects", "info", name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`cloned workspace retained Git object alternates: ${name}`);
  }
}
