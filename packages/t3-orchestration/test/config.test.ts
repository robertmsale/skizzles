import { describe, expect, test } from "bun:test";
import { DEFAULT_TAILSCALE_GATEWAY_PORT, parseTailscaleGatewayPort, taskProviderDefaults } from "../src/config.ts";

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

  test("rejects providers outside the bounded orchestration contract", async () => {
    await expect(taskProviderDefaults("claude")).rejects.toThrow(
      "Supported providers: codex, grok",
    );
  });
});
