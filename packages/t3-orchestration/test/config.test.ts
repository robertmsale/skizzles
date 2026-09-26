import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_TAILSCALE_GATEWAY_PORT, parseTailscaleGatewayPort, taskProviderDefaults, taskProviderInstance, taskRuntimeMode } from "../src/config.ts";

describe("Tailscale gateway port", () => {
  test("uses a stable default and accepts an explicit unprivileged port", () => {
    expect(parseTailscaleGatewayPort(undefined)).toBe(DEFAULT_TAILSCALE_GATEWAY_PORT);
    expect(parseTailscaleGatewayPort(" 54321 ")).toBe(54_321);
  });

  test("rejects privileged, oversized, fractional, and malformed ports", () => {
    for (const value of ["443", "65536", "43773.5", "not-a-port"]) {
      expect(() => parseTailscaleGatewayPort(value)).toThrow("integer from 1024 through 65535");
    }
  });
});

describe("task provider defaults", () => {
  test("maps friendly aliases and passes other providers through as T3 instance ids", () => {
    expect(taskProviderInstance(undefined)).toBe("codex");
    expect(taskProviderInstance("  ")).toBe("codex");
    expect(taskProviderInstance("OpenAI")).toBe("codex");
    expect(taskProviderInstance("claude")).toBe("claudeAgent");
    expect(taskProviderInstance("Claude-Code")).toBe("claudeAgent");
    expect(taskProviderInstance("grok")).toBe("grok");
    expect(taskProviderInstance("opencode")).toBe("opencode");
  });

  test("leaves non-Codex model and options to the live catalog", async () => {
    expect(await taskProviderDefaults("claude")).toEqual({ instanceId: "claudeAgent", options: [] });
    expect(await taskProviderDefaults("grok")).toEqual({ instanceId: "grok", options: [] });
    expect(await taskProviderDefaults("cursor", " grok-4.5 ")).toEqual({ instanceId: "cursor", model: "grok-4.5", options: [] });
    expect(await taskProviderDefaults("claude", "claude-fable-5-1")).toEqual({ instanceId: "claudeAgent", model: "claude-fable-5-1", options: [] });
  });

  test("omit --model still reads Codex defaults from an isolated config.toml", async () => {
    const root = await mkdtemp("/tmp/t3-codex-defaults-");
    const configPath = join(root, "config.toml");
    const config = [
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "xhigh"',
      'model_provider = "openai"',
      'service_tier = "flex"',
      "",
    ].join("\n");
    await writeFile(configPath, config);
    try {
      const script = `
        const { taskProviderDefaults } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/config.ts"))});
        const omitted = await taskProviderDefaults("codex");
        console.log(JSON.stringify(omitted));
      `;
      const process = Bun.spawn(["bun", "-e", script], {
        env: { ...Bun.env, CODEX_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "serviceTier", value: "flex" },
        ],
      });
      expect(await Bun.file(configPath).text()).toBe(config);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("omit --model leaves settings absent from config.toml to the T3 catalog", async () => {
    const root = await mkdtemp("/tmp/t3-codex-partial-");
    await writeFile(join(root, "config.toml"), 'model = "gpt-6-astra"\nservice_tier = "default"\n');
    const empty = await mkdtemp("/tmp/t3-codex-empty-");
    try {
      const script = `
        const { taskProviderDefaults } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/config.ts"))});
        console.log(JSON.stringify(await taskProviderDefaults("codex")));
      `;
      for (const [home, expected] of [
        [root, { instanceId: "codex", model: "gpt-6-astra", options: [{ id: "serviceTier", value: "default" }] }],
        [empty, { instanceId: "codex", options: [] }],
      ] as const) {
        const child = Bun.spawn(["bun", "-e", script], { env: { ...Bun.env, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
        expect(await child.exited).toBe(0);
        expect(JSON.parse(await new Response(child.stdout).text())).toEqual(expected);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("Codex --model never reads or writes config.toml", async () => {
    const missing = await mkdtemp("/tmp/t3-codex-missing-");
    const broken = await mkdtemp("/tmp/t3-codex-broken-");
    const brokenPath = join(broken, "config.toml");
    const brokenConfig = [
      "model = 123",
      'other = "not-enough"',
      "",
    ].join("\n");
    await writeFile(brokenPath, brokenConfig);
    try {
      const script = `
        const { taskProviderDefaults } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/config.ts"))});
        const missingHome = process.env.CODEX_HOME;
        const missingSelection = await taskProviderDefaults("codex", "xai/grok-4.6");
        const openaiSelection = await taskProviderDefaults("openai", "xai/grok-4.6");
        console.log(JSON.stringify({ missingHome, missingSelection, openaiSelection }));
      `;
      const omitScript = `
        const { taskProviderDefaults } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/config.ts"))});
        await taskProviderDefaults("codex");
      `;
      const missingProcess = Bun.spawn(["bun", "-e", script], {
        env: { ...Bun.env, CODEX_HOME: missing },
        stdout: "pipe",
        stderr: "pipe",
      });
      const brokenProcess = Bun.spawn(["bun", "-e", script], {
        env: { ...Bun.env, CODEX_HOME: broken },
        stdout: "pipe",
        stderr: "pipe",
      });
      const omitBroken = Bun.spawn(["bun", "-e", omitScript], {
        env: { ...Bun.env, CODEX_HOME: broken },
        stdout: "pipe",
        stderr: "pipe",
      });
      const expected = {
        instanceId: "codex",
        model: "xai/grok-4.6",
        options: [],
      };
      for (const child of [missingProcess, brokenProcess]) {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        const result = JSON.parse(stdout) as {
          missingHome: string;
          missingSelection: unknown;
          openaiSelection: unknown;
        };
        expect(result.missingSelection).toEqual(expected);
        expect(result.openaiSelection).toEqual(expected);
      }
      const [omitExit, omitStdout, omitStderr] = await Promise.all([
        omitBroken.exited,
        new Response(omitBroken.stdout).text(),
        new Response(omitBroken.stderr).text(),
      ]);
      expect(omitExit).not.toBe(0);
      expect(omitStdout).toBe("");
      expect(omitStderr).toContain("config.toml model must be a nonempty string");
      expect(await Bun.file(join(missing, "config.toml")).exists()).toBe(false);
      expect(await Bun.file(brokenPath).text()).toBe(brokenConfig);
    } finally {
      await rm(missing, { recursive: true, force: true });
      await rm(broken, { recursive: true, force: true });
    }
  });
});

describe("task runtime mode", () => {
  test("boots Full Access for the supported harnesses", () => {
    for (const instanceId of ["codex", "claudeAgent", "grok", "cursor"]) expect(taskRuntimeMode(instanceId)).toBe("full-access");
  });

  test("boots other harnesses in Auto so approvals stay visible", () => {
    expect(taskRuntimeMode("opencode")).toBe("auto");
    expect(taskRuntimeMode("unknown")).toBe("auto");
  });
});

