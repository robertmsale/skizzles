import { describe, expect, test } from "bun:test";
import { defaultGuardianConfig, parseGuardianConfig, projectAllowed } from "../src/auto-guardian-config.ts";

describe("guardian host config", () => {
  test("defaults to official auto-review model and empty project filters", () => {
    expect(defaultGuardianConfig()).toMatchObject({
      enabled: true,
      model: "codex-auto-review",
      dryRun: false,
      includeProjects: [],
      excludeProjects: [],
    });
  });

  test("parses host overrides and example acme selectors", () => {
    const config = parseGuardianConfig(`
enabled = true
dry_run = true
model = "codex-auto-review"
poll_interval_ms = 2500
include_projects = ["acme"]
exclude_projects = ["/repo/acme-app"]
`);
    expect(config.dryRun).toBe(true);
    expect(config.pollIntervalMs).toBe(2500);
    expect(projectAllowed({ projectId: "p1", projectTitle: "acme" }, config)).toEqual({ allowed: true });
    expect(projectAllowed({ projectId: "p2", projectTitle: "acme", workspaceRoot: "/repo/acme-app" }, config)).toEqual({
      allowed: false,
      reason: "project is in exclude_projects",
    });
    expect(projectAllowed({ projectId: "p3", projectTitle: "other" }, config)).toEqual({
      allowed: false,
      reason: "project is not in include_projects",
    });
  });

  test("rejects invalid TOML values", () => {
    expect(() => parseGuardianConfig("enabled = \"yes\"")).toThrow("enabled must be a boolean");
    expect(() => parseGuardianConfig("poll_interval_ms = 10")).toThrow("poll_interval_ms");
    expect(() => parseGuardianConfig("model = \"\"")).toThrow("model must be a non-empty string");
  });
});
