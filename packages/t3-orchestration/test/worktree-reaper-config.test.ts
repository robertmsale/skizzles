import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertAllowedCleanCommand,
  defaultReaperConfig,
  loadReaperConfig,
  matchRelativeGlob,
  parseReaperConfig,
  resolveProjectPolicy,
} from "../src/worktree-reaper-config.ts";

describe("reaper host config", () => {
  test("defaults detect cargo and flutter from the tree", () => {
    const config = defaultReaperConfig();
    expect(config.enabled).toBe(true);
    expect(config.includeProjects).toEqual([]);
    expect(config.strategies.map((entry) => entry.name)).toEqual(["cargo", "flutter"]);
    expect(config.strategies[0]).toMatchObject({ markers: ["Cargo.toml"], artifactDir: "target" });
    expect(config.strategies[1]).toMatchObject({ markers: ["pubspec.yaml"], artifactDir: "build" });
  });

  test("parses include, deny, strategy globs, and per-project disable", () => {
    const config = parseReaperConfig(`
include_projects = ["acme"]
deny_paths = ["~/Code/acme"]

[[strategies]]
name = "cargo"
markers = ["Cargo.toml"]
artifact_dir = "target"
command = ["cargo", "clean", "--target-dir", "target"]
match = ["crates/**"]

[[projects]]
id = "acme"
enabled = false
`);
    expect(config.includeProjects).toEqual(["acme"]);
    expect(config.denyPaths).toEqual(["~/Code/acme"]);
    expect(config.strategies[0]?.match).toEqual(["crates/**"]);
    expect(resolveProjectPolicy({ projectId: "p1", projectTitle: "acme", workspaceRoot: "/repo" }, config)).toMatchObject({
      enabled: false,
      reason: "project disabled by host config",
    });
  });

  test("omitted strategies keep tree-detection defaults", () => {
    const config = parseReaperConfig("include_projects = [\"acme\"]\n");
    expect(config.strategies.map((entry) => entry.name)).toEqual(["cargo", "flutter"]);
  });

  test("matches include_projects by title, id, or workspace root", () => {
    const config = parseReaperConfig(`include_projects = ["acme-app"]\n`);
    expect(resolveProjectPolicy({ projectId: "abc", projectTitle: "acme-app", workspaceRoot: "/repo" }, config).enabled).toBe(true);
    expect(resolveProjectPolicy({ projectId: "other", projectTitle: "other", workspaceRoot: "/repo" }, config)).toMatchObject({
      enabled: false,
      reason: "project is not in include_projects",
    });
  });

  test("loads a host file and fails closed when an explicit path is missing", async () => {
    const root = `/tmp/t3-reaper-config-${crypto.randomUUID()}`;
    await mkdir(root, { recursive: true });
    const path = join(root, "t3-worktree-reaper.toml");
    await writeFile(path, "enabled = false\n");
    expect((await loadReaperConfig(path)).config.enabled).toBe(false);
    await expect(loadReaperConfig(join(root, "missing.toml"))).rejects.toThrow("missing");
  });

  test("matches strategy globs used by host config", () => {
    expect(matchRelativeGlob("apps/mobile", "apps/**")).toBe(true);
    expect(matchRelativeGlob("apps/mobile", "acme/app")).toBe(false);
    expect(matchRelativeGlob("acme/app", "acme/app")).toBe(true);
    expect(matchRelativeGlob("apps/mobile/src", "apps/*")).toBe(false);
  });

  test("allows only artifact-only cleaners", () => {
    expect(() => assertAllowedCleanCommand(["cargo", "clean", "--target-dir", "target"], "target")).not.toThrow();
    expect(() => assertAllowedCleanCommand(["flutter", "clean"], "build")).not.toThrow();
    expect(() => assertAllowedCleanCommand(["rm", "-rf", ".dart_tool"], ".dart_tool")).not.toThrow();
    expect(() => assertAllowedCleanCommand(["sh", "-c", "printf escaped > /tmp/reaper-proof"], "target")).toThrow("not allowed");
    expect(() => assertAllowedCleanCommand(["git", "-C/tmp", "clean", "-fd"], "target")).toThrow();
    expect(() => assertAllowedCleanCommand(["rm", "-rf", "src"], "src")).toThrow();
    expect(() => assertAllowedCleanCommand(["rm", "-rf", ".git"], ".git")).toThrow();
    expect(() => assertAllowedCleanCommand(["rm", "-rf", "lib"], "lib")).toThrow("generated artifact");
    for (const source of ["packages", "app", "assets", "docs", "tests"]) {
      expect(() => assertAllowedCleanCommand(["rm", "-rf", source], source)).toThrow("generated artifact");
    }
    expect(() => parseReaperConfig(`
[[extra_commands]]
match = "**"
artifact_dir = "lib"
command = ["rm", "-rf", "lib"]
`)).toThrow("generated artifact");
    expect(() => parseReaperConfig(`
[[extra_commands]]
match = "apps/mobile"
command = ["sh", "-c", "rm -rf /"]
`)).toThrow("artifact_dir");
  });
});
