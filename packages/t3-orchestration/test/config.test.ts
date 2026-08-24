import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyTaskModelOverride, DEFAULT_TAILSCALE_GATEWAY_PORT, parseTailscaleGatewayPort, taskProviderDefaults, taskRuntimeMode } from "../src/config.ts";

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
  test("selects the installed Grok harness without model option overrides", async () => {
    expect(await taskProviderDefaults("grok")).toEqual({
      instanceId: "grok",
      model: "grok-4.6",
      options: [],
    });
  });

  test("maps --provider cursor to the live T3 catalog Grok 4.6 High selection", async () => {
    expect(await taskProviderDefaults("cursor")).toEqual({
      instanceId: "cursor",
      model: "grok-4.6",
      options: [
        { id: "reasoning", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
  });

  test("rejects providers outside the bounded orchestration contract", async () => {
    await expect(taskProviderDefaults("claude")).rejects.toThrow(
      "Supported providers: codex, grok, cursor",
    );
  });

  test("overrides only the model slug and keeps provider option defaults", async () => {
    expect(await taskProviderDefaults("grok", "xai/grok-4.6")).toEqual({
      instanceId: "grok",
      model: "xai/grok-4.6",
      options: [],
    });
    expect(await taskProviderDefaults("cursor", "grok-4.5")).toEqual({
      instanceId: "cursor",
      model: "grok-4.5",
      options: [
        { id: "reasoning", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
    expect(applyTaskModelOverride({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "flex" },
      ],
    }, "xai/grok-4.6")).toEqual({
      instanceId: "codex",
      model: "xai/grok-4.6",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "flex" },
      ],
    });
    expect(applyTaskModelOverride({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    }, "  ")).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  test("reads Codex defaults from an isolated config.toml and overrides only the model", async () => {
    const root = await mkdtemp("/tmp/t3-codex-defaults-");
    const configPath = join(root, "config.toml");
    const config = [
      'model = "gpt-5.4"',
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
        const overridden = await taskProviderDefaults("codex", "xai/grok-4.6");
        console.log(JSON.stringify({ omitted, overridden }));
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
        omitted: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "flex" },
          ],
        },
        overridden: {
          instanceId: "codex",
          model: "xai/grok-4.6",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "flex" },
          ],
        },
      });
      expect(await Bun.file(configPath).text()).toBe(config);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("task runtime mode", () => {
  test("boots Full Access for grok and cursor", () => {
    expect(taskRuntimeMode("grok")).toBe("full-access");
    expect(taskRuntimeMode("cursor")).toBe("full-access");
  });

  test("keeps Codex Auto for codex, openai, and unset providers", () => {
    expect(taskRuntimeMode("codex")).toBe("auto");
    expect(taskRuntimeMode("openai")).toBe("auto");
    expect(taskRuntimeMode(undefined)).toBe("auto");
    expect(taskRuntimeMode("")).toBe("auto");
  });
});
