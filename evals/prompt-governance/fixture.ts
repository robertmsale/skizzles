import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPilotCase } from "./cases";
import { sha256, snapshotHash, snapshotTree, writeText } from "./fs";
import { git, initializeGitFixture } from "./git";
import type { PilotCase, PilotCaseId, TreeSnapshot } from "./types";

export interface FixtureHandle {
  readonly root: string;
  readonly pilotCase: PilotCase;
  readonly baselineCommit: string;
  readonly baselineSnapshot: TreeSnapshot;
  readonly baselineTreeHash: string;
  readonly verifierHash: string;
}

export async function createFixture(caseId: PilotCaseId, parentRoot?: string): Promise<FixtureHandle> {
  const pilotCase = getPilotCase(caseId);
  const root = parentRoot ?? await mkdtemp(join(tmpdir(), `skizzles-prompt-eval-${caseId}-`));
  await mkdir(root);
  for (const [relativePath, contents] of Object.entries(pilotCase.fixtureFiles)) {
    await writeText(join(root, relativePath), contents);
  }
  initializeGitFixture(root);
  const baselineSnapshot = await snapshotTree(root);
  const canonicalHash = canonicalFixtureSnapshotHash(pilotCase);
  if (snapshotHash(baselineSnapshot) !== canonicalHash) {
    throw new Error(`fixture baseline differs from canonical snapshot for ${caseId}`);
  }
  return {
    root,
    pilotCase,
    baselineCommit: git(root, ["rev-parse", "HEAD"]).trim(),
    baselineSnapshot,
    baselineTreeHash: snapshotHash(baselineSnapshot),
    verifierHash: sha256(pilotCase.fixtureFiles["verify.mjs"] ?? ""),
  };
}

/** Canonical fixture tree used by both planning and execution. */
export function canonicalFixtureSnapshot(pilotCase: PilotCase): TreeSnapshot {
  const entries = Object.fromEntries(
    Object.entries(pilotCase.fixtureFiles)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([path, contents]) => [path, { kind: "file" as const, sha256: sha256(contents), byteLength: Buffer.byteLength(contents) }]),
  );
  return entries;
}

export function canonicalFixtureSnapshotHash(pilotCase: PilotCase): string {
  return snapshotHash(canonicalFixtureSnapshot(pilotCase));
}

export async function resetFixture(handle: FixtureHandle): Promise<void> {
  git(handle.root, ["reset", "--hard", handle.baselineCommit]);
  git(handle.root, ["clean", "-fdx"]);
}
