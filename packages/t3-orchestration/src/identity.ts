import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { $ } from "bun";

export type ProjectRoot = { id: string; workspaceRoot: string };

const MAX_SUPERPROJECT_DEPTH = 4;

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  const result = await $`git -C ${cwd} ${args}`.nothrow().quiet();
  return result.exitCode === 0 ? result.text() : undefined;
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

// Paths that identify the caller's checkout, most specific first. A linked Git
// worktree (T3, Hermes, or hand-made) is mapped back to its primary checkout,
// and a submodule to its location inside the superproject, so the caller
// resolves to the project registered for that repository whichever harness
// runs there.
export async function callerPathCandidates(cwd: string, depth = 0): Promise<string[]> {
  const candidates: string[] = [];
  const add = (path: string) => {
    const normalized = withoutTrailingSlash(path);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };
  const real = await realpath(cwd);
  add(real);
  const revParse = await git(real, "rev-parse", "--show-toplevel", "--show-prefix");
  if (revParse === undefined) return candidates;
  const prefix = revParse.split("\n")[1] ?? "";
  // The first `worktree list` entry is the primary checkout, except that a
  // submodule reports its Git directory; rev-parse there follows core.worktree
  // back to the checkout. Bare primaries have no checkout to map to.
  const primaryRecord = (await git(real, "worktree", "list", "--porcelain"))?.split("\n\n")[0] ?? "";
  const primary = primaryRecord.match(/^worktree (.+)$/m)?.[1];
  const primaryTop = primary && !/^bare$/m.test(primaryRecord) ? (await git(primary, "rev-parse", "--show-toplevel"))?.trim() : undefined;
  if (primaryTop) add(join(await realpath(primaryTop), prefix));
  const superproject = (await git(real, "rev-parse", "--show-superproject-working-tree"))?.trim();
  if (superproject && depth < MAX_SUPERPROJECT_DEPTH) {
    const superRoot = await realpath(superproject);
    const inside = relative(superRoot, real);
    for (const base of await callerPathCandidates(superRoot, depth + 1)) add(join(base, inside));
  }
  return candidates;
}

// Chooses the most specific project for the earliest candidate that any project
// contains; only identical roots registered twice are ambiguous.
export function selectCallerProject(candidates: string[], projects: ProjectRoot[]): string {
  for (const path of candidates) {
    let best: ProjectRoot[] = [];
    for (const project of projects) {
      const root = project.workspaceRoot;
      if (!(path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`))) continue;
      if (best.length === 0 || root.length > best[0]!.workspaceRoot.length) best = [project];
      else if (root === best[0]!.workspaceRoot) best.push(project);
    }
    if (best.length > 1) throw new Error(`Several T3 projects share ${best[0]!.workspaceRoot}; pass --project explicitly`);
    if (best.length === 1) return best[0]!.id;
  }
  throw new Error(`No T3 project contains ${candidates[0]}; pass --project with an id from 't3ctl projects list'`);
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
