import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readText, sha256, writeText } from "./fs";
import { git } from "./git";
import type { Condition, OverlayRecord } from "./types";

const instructionPath = "assets/skizzles_instructions.md";
const baselineRevision = "f707cd3";

export interface OverlayPair {
  readonly baseline: OverlayRecord;
  readonly candidate: OverlayRecord;
}

export async function copyFrozenOverlay(record: OverlayRecord, targetPath: string): Promise<string> {
  const contents = await readText(record.materializedPath);
  if (sha256(contents) !== record.sha256) throw new Error(`frozen overlay hash changed: ${record.overlayId}`);
  await writeText(targetPath, contents);
  return targetPath;
}

export async function materializeInstructionOverlays(
  repositoryRoot: string,
  runArtifactRoot: string,
): Promise<OverlayPair> {
  const baselineText = git(repositoryRoot, ["show", `${baselineRevision}^{commit}:${instructionPath}`]);
  const candidateText = await readText(join(repositoryRoot, instructionPath));
  const baselineSourceRevision = git(repositoryRoot, ["rev-parse", `${baselineRevision}^{commit}`]).trim();
  const candidateHead = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  const records = await Promise.all([
    materialize("baseline", baselineText, baselineSourceRevision, runArtifactRoot),
    materialize("candidate", candidateText, `${candidateHead}+working-tree`, runArtifactRoot),
  ]);
  return { baseline: records[0]!, candidate: records[1]! };
}

async function materialize(
  condition: Condition,
  contents: string,
  sourceRevision: string,
  root: string,
): Promise<OverlayRecord> {
  const overlayId = randomUUID();
  const materializedPath = join(root, "overlays", overlayId, "instructions.md");
  await writeText(materializedPath, contents);
  return {
    condition,
    sourceRevision,
    materializedPath,
    sha256: sha256(contents),
    byteLength: Buffer.byteLength(contents),
    overlayId,
  };
}

export { baselineRevision, instructionPath };
