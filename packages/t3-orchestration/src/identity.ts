import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { $ } from "bun";

export type ProjectRoot = { id: string; workspaceRoot: string };

// Paths that identify the caller's checkout. A linked Git worktree (T3,
// Hermes, or hand-made) is mapped back to its primary checkout so it resolves
// to the project registered for that repository, whichever harness runs there.
export async function callerPathCandidates(cwd: string): Promise<string[]> {
  const real = await realpath(cwd);
  const candidates = [real];
  const git = await $`git -C ${real} rev-parse --path-format=absolute --git-common-dir --show-prefix`.nothrow().quiet();
  if (git.exitCode !== 0) return candidates;
  const [commonDir = "", prefix = ""] = git.text().split("\n");
  if (basename(commonDir) !== ".git") return candidates;
  const primary = join(await realpath(dirname(commonDir)), prefix);
  const normalized = primary.endsWith("/") && primary.length > 1 ? primary.slice(0, -1) : primary;
  if (!candidates.includes(normalized)) candidates.push(normalized);
  return candidates;
}

// Chooses the most specific project whose root contains a candidate path.
export function selectCallerProject(candidates: string[], projects: ProjectRoot[]): string {
  let best: ProjectRoot[] = [];
  for (const project of projects) {
    const root = project.workspaceRoot;
    if (!candidates.some((path) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`))) continue;
    if (best.length === 0 || root.length > best[0]!.workspaceRoot.length) best = [project];
    else if (root.length === best[0]!.workspaceRoot.length) best.push(project);
  }
  if (best.length === 0) {
    throw new Error(`No T3 project contains ${candidates[0]}; pass --project with an id from 't3ctl projects list'`);
  }
  if (best.length > 1) {
    throw new Error(`Several T3 projects share ${best[0]!.workspaceRoot}; pass --project explicitly`);
  }
  return best[0]!.id;
}

export async function resolveCallerProject(
  cwd: unknown,
  projects: () => Promise<Array<{ id: string; workspaceRoot: string; deletedAt?: string | null }>>,
): Promise<string> {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("The caller's working directory is unknown; pass --project with an id from 't3ctl projects list'");
  }
  const candidates = await callerPathCandidates(cwd);
  const roots: ProjectRoot[] = [];
  for (const project of await projects()) {
    if (project.deletedAt) continue;
    try { roots.push({ id: project.id, workspaceRoot: await realpath(project.workspaceRoot) }); } catch { /* stale T3 project */ }
  }
  return selectCallerProject(candidates, roots);
}
