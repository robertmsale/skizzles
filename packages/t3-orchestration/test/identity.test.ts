import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { callerPathCandidates, resolveCallerProject, selectCallerProject } from "../src/identity.ts";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

async function repositoryWithWorktree() {
  root = await realpath(await mkdtemp("/tmp/t3-identity-"));
  const primary = join(root, "primary");
  await mkdir(join(primary, "packages/app"), { recursive: true });
  await $`git init -q ${primary} && git -C ${primary} -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`.quiet();
  const linked = join(root, "elsewhere/linked");
  await $`git -C ${primary} worktree add -q -b task ${linked}`.quiet();
  await mkdir(join(linked, "packages/app"), { recursive: true });
  return { primary, linked };
}

describe("caller project resolution", () => {
  test("maps a linked worktree back to the primary checkout", async () => {
    const { primary, linked } = await repositoryWithWorktree();
    expect(await callerPathCandidates(linked)).toEqual([linked, primary]);
    expect(await callerPathCandidates(join(linked, "packages/app"))).toEqual([join(linked, "packages/app"), join(primary, "packages/app")]);
    expect(await callerPathCandidates(primary)).toEqual([primary]);
  });

  test("resolves any harness's worktree to the project registered for its repository", async () => {
    const { primary, linked } = await repositoryWithWorktree();
    const projects = async () => [
      { id: "deleted", workspaceRoot: primary, deletedAt: "2026-01-01" },
      { id: "stale", workspaceRoot: join(root!, "missing") },
      { id: "repo", workspaceRoot: primary },
    ];
    expect(await resolveCallerProject(linked, projects)).toBe("repo");
    expect(await resolveCallerProject(join(linked, "packages/app"), projects)).toBe("repo");
  });

  test("outside Git, a directory inside a project root still resolves", async () => {
    root = await realpath(await mkdtemp("/tmp/t3-identity-"));
    await mkdir(join(root, "plain/sub"), { recursive: true });
    expect(await resolveCallerProject(join(root, "plain/sub"), async () => [{ id: "plain", workspaceRoot: join(root!, "plain") }])).toBe("plain");
  });

  test("prefers the most specific project and refuses ambiguity or no match", () => {
    const projects = [{ id: "repo", workspaceRoot: "/r" }, { id: "app", workspaceRoot: "/r/app" }];
    expect(selectCallerProject(["/r/app/src"], projects)).toBe("app");
    expect(selectCallerProject(["/r/lib"], projects)).toBe("repo");
    expect(() => selectCallerProject(["/r2"], projects)).toThrow("pass --project");
    expect(() => selectCallerProject(["/rapp"], [{ id: "repo", workspaceRoot: "/r" }])).toThrow("No T3 project");
    expect(() => selectCallerProject(["/r"], [{ id: "a", workspaceRoot: "/r" }, { id: "b", workspaceRoot: "/r" }])).toThrow("Several T3 projects");
  });

  test("an unknown working directory asks for --project", async () => {
    await expect(resolveCallerProject(undefined, async () => [])).rejects.toThrow("pass --project");
  });
});
