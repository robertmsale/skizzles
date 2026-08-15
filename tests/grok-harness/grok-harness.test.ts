import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const agentRoot = join(repositoryRoot, "grok/agents");
const hook = join(repositoryRoot, "grok/hooks/bin/skizzles-guard-subagent-spawn.ts");
const launcher = join(repositoryRoot, "grok/bin/skizzles-grok");

function agent(name: string): string {
  return readFileSync(join(agentRoot, `${name}.md`), "utf8");
}

function invokeHook(
  toolInput: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
  env: Record<string, string> = { GROK_AGENT: "skizzles-root" },
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", hook], {
    stdin: new TextEncoder().encode(JSON.stringify({
      hookEventName: "pre_tool_use",
      toolName: "spawn_subagent",
      toolInput,
      ...overrides,
    })),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("Grok agent profiles", () => {
  test("all profiles fully replace the prompt and inherit model and effort", () => {
    for (const name of ["skizzles-root", "skizzles-worker", "skizzles-explorer", "skizzles-reviewer"]) {
      const text = agent(name);
      const frontmatter = text.split("---", 3)[1] ?? "";
      expect(frontmatter).toContain("promptMode: full");
      expect(frontmatter).not.toMatch(/^model:/m);
      expect(frontmatter).not.toMatch(/^effort:/m);
      expect(text).not.toContain("completionRequirement");
    }
  });

  test("root delegates deliberately while child profiles cannot recurse", () => {
    expect(agent("skizzles-root")).toContain("Delegate only concrete, bounded work");
    for (const name of ["skizzles-worker", "skizzles-explorer", "skizzles-reviewer"]) {
      expect(agent(name)).toContain("disallowedTools: Agent");
    }
  });

  test("explorer is read-only and reviewer can execute probes without edit tools", () => {
    expect(agent("skizzles-explorer")).toContain("capabilityMode: read-only");
    expect(agent("skizzles-reviewer")).toContain("capabilityMode: execute");
    expect(agent("skizzles-reviewer")).toContain("Do not modify implementation");
  });
});

describe("Grok launcher", () => {
  test("pins the root and enables native automatic permission review", () => {
    const text = readFileSync(launcher, "utf8");
    expect(text).toContain("GROK_AGENT=skizzles-root");
    expect(text).toContain("--agent skizzles-root");
    expect(text).toContain("--model grok-4.6");
    expect(text).toContain("--effort high");
    expect(text).toContain("--permission-mode auto");
  });
});

describe("Grok subagent guard", () => {
  test("allows the three inherited-configuration roles", () => {
    for (const subagentType of ["skizzles-worker", "skizzles-explorer", "skizzles-reviewer"]) {
      const result = invokeHook({ prompt: "bounded work", description: "work", subagent_type: subagentType });
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    }
  });

  test("denies unknown or implicit roles", () => {
    for (const subagentType of [undefined, "general-purpose", "explore", "reviewer"]) {
      const result = invokeHook({ prompt: "work", description: "work", subagent_type: subagentType });
      expect(JSON.parse(result.stdout)).toEqual({
        decision: "deny",
        reason: "Select exactly one Skizzles role: skizzles-worker, skizzles-explorer, or skizzles-reviewer.",
      });
    }
  });

  test("denies model and reasoning overrides", () => {
    for (const override of [{ model: "grok-other" }, { model: null }, { reasoning_effort: "low" }, { effort: "max" }]) {
      const result = invokeHook({
        prompt: "work",
        description: "work",
        subagent_type: "skizzles-worker",
        ...override,
      });
      expect(JSON.parse(result.stdout).reason).toContain("inherit the root session configuration");
    }
  });

  test("denies truncated input and remains inert outside the Skizzles profile", () => {
    const truncated = invokeHook(
      { prompt: "work", description: "work", subagent_type: "skizzles-worker" },
      { toolInputTruncated: true },
    );
    expect(JSON.parse(truncated.stdout).reason).toContain("truncated");

    const unrelated = invokeHook(
      { prompt: "work", description: "work", subagent_type: "general-purpose", model: "other" },
      {},
      { GROK_AGENT: "grok-build" },
    );
    expect(unrelated).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });
});
