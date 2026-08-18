import { describe, expect, test } from "bun:test";
import { defaultGuardianConfig, parseGuardianConfig, projectAllowed } from "../src/auto-guardian-config.ts";

describe("guardian host config", () => {
  test("defaults to official auto-review model and empty project filters", () => {
    expect(defaultGuardianConfig()).toMatchObject({
      enabled: true,
      model: "codex-auto-review",
      modelReasoningEffort: "low",
      dryRun: false,
      includeProjects: [],
      excludeProjects: [],
    });
  });

  test("parses host overrides and example acme selectors", () => {
    const config = parseGuardianConfig(`
enabled = true
dry_run = true
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
poll_interval_ms = 2500
include_projects = ["acme"]
exclude_projects = ["/repo/acme-app"]
`);
    expect(config.model).toBe("gpt-5.6-luna");
    expect(config.modelReasoningEffort).toBe("low");
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
    expect(() => parseGuardianConfig('model_reasoning_effort = ""')).toThrow("model_reasoning_effort must be a non-empty string");
    expect(() => parseGuardianConfig('model_reasoning_effort = "lowe"')).toThrow("model_reasoning_effort must be one of");
  });

  test("rejects unknown top-level keys instead of live unrestricted defaults", () => {
    expect(() => parseGuardianConfig("dry_rnu = true")).toThrow("unknown keys: dry_rnu");
    expect(() => parseGuardianConfig('include_project = ["acme"]')).toThrow("unknown keys: include_project");
    expect(() => parseGuardianConfig("enabled = true\ndry_rnu = true\ninclude_project = [\"acme\"]")).toThrow("unknown keys");
    expect(() => parseGuardianConfig('effort = "low"')).toThrow("unknown keys: effort");
    expect(() => parseGuardianConfig('model_reasoning_effrot = "low"')).toThrow("unknown keys: model_reasoning_effrot");
  });
});
