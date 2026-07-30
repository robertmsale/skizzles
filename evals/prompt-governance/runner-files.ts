import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectCaptureEvidence } from "./evidence";
import { writeAtomicText } from "./fs";
import type { CaptureResult } from "./types";

export async function ensureFreshDirectory(path: string): Promise<void> {
  await mkdir(path);
}

export async function assertAbsent(path: string): Promise<void> {
  try {
    await readFile(path);
    throw new Error(`artifact already exists; refusing to overwrite: ${path}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export async function writePartialResult(root: string, plan: Record<string, any>, captures: readonly CaptureResult[], stopReason: string | null): Promise<void> {
  await writeAtomicText(join(root, "pilot-result.json"), `${JSON.stringify({ ...plan, status: stopReason ? "stopped" : "partial", stopReason, captures: captures.map(projectCaptureEvidence) }, null, 2)}\n`);
}
