import { describe, expect, test } from "bun:test";
import { requireAvailableProviderSelection } from "../src/t3.ts";

const selection = { instanceId: "grok", model: "grok-4.6", options: [] };

describe("task provider preflight", () => {
  test("accepts a ready provider exposing the requested model", () => {
    expect(requireAvailableProviderSelection({
      providers: [{
        instanceId: "grok",
        driver: "grok",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        models: [{ slug: "grok-4.6" }],
      }],
    }, selection)).toBe("grok");
  });

  test("fails before task creation when provider or model is unusable", () => {
    expect(() => requireAvailableProviderSelection({ providers: [] }, selection)).toThrow(
      "is not configured",
    );
    expect(() => requireAvailableProviderSelection({
      providers: [{
        instanceId: "grok",
        driver: "grok",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "grok-build" }],
      }],
    }, selection)).toThrow("does not expose model 'grok-4.6'");
  });
});
