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

  test("a submodule inside a linked worktree resolves to the superproject's project", async () => {
    const { primary, linked } = await repositoryWithWorktree();
    const library = join(root!, "library");
    await $`git init -q ${library} && git -C ${library} -c user.email=t@t -c user.name=t commit -q --allow-empty -m lib`.quiet();
    await $`git -C ${linked} -c protocol.file.allow=always submodule add -q ${library} vendor/lib`.quiet();
    const inside = join(linked, "vendor/lib");
    expect(await callerPathCandidates(inside)).toContain(join(primary, "vendor/lib"));
    expect(await resolveCallerProject(inside, async () => [{ id: "repo", workspaceRoot: primary }])).toBe("repo");
  });

  test("submodules resolve to the most specific registered project, not the superproject's Git directory", async () => {
    root = await realpath(await mkdtemp("/tmp/t3-identity-"));
    const library = join(root, "library");
    await $`git init -q ${library} && git -C ${library} -c user.email=t@t -c user.name=t commit -q --allow-empty -m lib`.quiet();
    const superRoot = join(root, "super");
    await $`git init -q ${superRoot} && git -C ${superRoot} -c protocol.file.allow=always submodule add -q ${library} sub && git -C ${superRoot} -c user.email=t@t -c user.name=t commit -q -m sub`.quiet();
    const superLinked = join(root, "superwt");
    await $`git -C ${superRoot} worktree add -q -b task ${superLinked} && git -C ${superLinked} -c protocol.file.allow=always submodule update -q --init`.quiet();
    await mkdir(join(superLinked, "sub/x"), { recursive: true });
    const subLinked = join(root, "subwt");
    await $`git -C ${join(superRoot, "sub")} worktree add -q -b subtask ${subLinked}`.quiet();
    const projects = async () => [{ id: "super", workspaceRoot: superRoot }, { id: "sub", workspaceRoot: join(superRoot, "sub") }];
    expect(await resolveCallerProject(join(superLinked, "sub/x"), projects)).toBe("sub");
    expect(await resolveCallerProject(subLinked, projects)).toBe("sub");
    expect(await resolveCallerProject(superLinked, projects)).toBe("super");
    expect(await callerPathCandidates(subLinked)).not.toContain(join(superRoot, ".git/modules/sub"));
  });

  test("a worktree of a bare repository falls back to its own path", async () => {
    root = await realpath(await mkdtemp("/tmp/t3-identity-"));
    const bare = join(root, "repo.git");
    await $`git init -q --bare ${bare}`.quiet();
    const seed = join(root, "seed");
    await $`git clone -q ${bare} ${seed} 2>/dev/null; git -C ${seed} -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git -C ${seed} push -q origin HEAD:main`.quiet();
    const linked = join(root, "linked");
    await $`git -C ${bare} worktree add -q ${linked} main`.quiet();
    expect(await callerPathCandidates(linked)).toEqual([linked]);
    expect(await resolveCallerProject(linked, async () => [{ id: "linked", workspaceRoot: linked }])).toBe("linked");
  });

  test("prefers the most specific project and refuses ambiguity or no match", () => {
    const projects = [{ id: "repo", workspaceRoot: "/r" }, { id: "app", workspaceRoot: "/r/app" }];
    expect(selectCallerProject(["/r/app/src"], projects)).toBe("app");
    expect(selectCallerProject(["/r/lib"], projects)).toBe("repo");
    expect(() => selectCallerProject(["/r2"], projects)).toThrow("pass --project");
    expect(() => selectCallerProject(["/rapp"], [{ id: "repo", workspaceRoot: "/r" }])).toThrow("No T3 project");
    expect(() => selectCallerProject(["/r"], [{ id: "a", workspaceRoot: "/r" }, { id: "b", workspaceRoot: "/r" }])).toThrow("Several T3 projects");
    // Equal-length roots matching different candidates are not ambiguous: the
    // caller's own path (the first candidate) wins.
    expect(selectCallerProject(["/wt/a", "/pr/a"], [{ id: "worktree", workspaceRoot: "/wt" }, { id: "primary", workspaceRoot: "/pr" }])).toBe("worktree");
  });

  test("an unknown working directory asks for --project", async () => {
    await expect(resolveCallerProject(undefined, async () => [])).rejects.toThrow("pass --project");
  });
});
