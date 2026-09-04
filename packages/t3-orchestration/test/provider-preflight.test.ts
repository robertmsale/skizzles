import { describe, expect, test } from "bun:test";
import { requireSelection } from "../src/protocol.ts";
import { applyCatalogSelectionDefaults, requireAvailableProviderSelection, taskTurnCommand } from "../src/t3.ts";

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

  test("accepts the discovered Cursor Grok 4.6 High selection", () => {
    expect(requireAvailableProviderSelection({
      providers: [{
        instanceId: "cursor",
        driver: "cursor",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        models: [{ slug: "grok-4.6" }],
      }],
    }, { instanceId: "cursor", model: "grok-4.6", options: [{ id: "reasoning", value: "high" }, { id: "fastMode", value: false }] })).toBe("cursor");
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

  test("preflights an explicit Codex model override against the live catalog slug", () => {
    const overridden = {
      instanceId: "codex",
      model: "xai/grok-4.6",
      options: [],
    };
    expect(requireAvailableProviderSelection({
      providers: [{
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        models: [{ slug: "xai/grok-4.6" }],
      }],
    }, overridden)).toBe("codex");
    expect(() => requireAvailableProviderSelection({
      providers: [{
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        models: [{ slug: "gpt-5.4" }],
      }],
    }, overridden)).toThrow("T3 provider 'codex' does not expose model 'xai/grok-4.6'");
  });

  test("fills missing Codex reasoningEffort from the catalog current or default", () => {
    const requested = { instanceId: "codex", model: "xai/grok-4.6", options: [] };
    expect(applyCatalogSelectionDefaults({
      providers: [{
        instanceId: "codex",
        models: [{
          slug: "xai/grok-4.6",
          capabilities: {
            optionDescriptors: [{
              id: "reasoningEffort",
              type: "select",
              currentValue: "high",
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
            }],
          },
        }],
      }],
    }, requested)).toEqual({
      instanceId: "codex",
      model: "xai/grok-4.6",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(applyCatalogSelectionDefaults({
      providers: [{
        instanceId: "codex",
        models: [{
          slug: "xai/grok-4.6",
          capabilities: {
            optionDescriptors: [{
              id: "reasoningEffort",
              type: "select",
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
            }],
          },
        }],
      }],
    }, requested)).toEqual({
      instanceId: "codex",
      model: "xai/grok-4.6",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
    const withoutDescriptor = applyCatalogSelectionDefaults({
      providers: [{
        instanceId: "codex",
        models: [{ slug: "xai/grok-4.6" }],
      }],
    }, requested);
    expect(withoutDescriptor).toEqual({
      instanceId: "codex",
      model: "xai/grok-4.6",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
    expect(requireSelection(withoutDescriptor)).toEqual(withoutDescriptor);
    expect(taskTurnCommand({
      id: "target",
      projectId: "project",
      title: "Target",
      modelSelection: withoutDescriptor,
      runtimeMode: "auto",
      interactionMode: "default",
      worktreePath: "/tmp/worktree",
      branch: "t3code/target",
      session: null,
    }, "continue").modelSelection).toEqual(withoutDescriptor);
    expect(applyCatalogSelectionDefaults({
      providers: [{
        instanceId: "codex",
        models: [{
          slug: "xai/grok-4.6",
          capabilities: {
            optionDescriptors: [{
              id: "reasoningEffort",
              type: "select",
              currentValue: "low",
            }],
          },
        }],
      }],
    }, {
      instanceId: "codex",
      model: "xai/grok-4.6",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    })).toEqual({
      instanceId: "codex",
      model: "xai/grok-4.6",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    });
  });
});

test("explicit creation effort replaces defaults, validates catalog, and survives follow-up", async () => {
  const { applyTaskReasoningOverride } = await import("../src/t3.ts");
  const catalog = { providers: [{ instanceId: "codex", models: [{ slug: "sol", capabilities: { optionDescriptors: [{ id: "reasoningEffort", options: [{ id: "medium", isDefault: true }, { id: "xhigh" }] }] } }] }] };
  const original = { instanceId: "codex", model: "sol", options: [{ id: "reasoningEffort", value: "medium" }, { id: "serviceTier", value: "priority" }] };
  const selected = applyCatalogSelectionDefaults(catalog, applyTaskReasoningOverride(catalog, original, "xhigh"));
  expect(selected.options).toEqual([{ id: "serviceTier", value: "priority" }, { id: "reasoningEffort", value: "xhigh" }]);
  expect(original.options[0]?.value).toBe("medium");
  for (const value of ["", "ultra"]) expect(() => applyTaskReasoningOverride(catalog, original, value)).toThrow();
  expect(() => applyTaskReasoningOverride({}, original, "xhigh")).toThrow("does not advertise");
  expect(() => applyTaskReasoningOverride(catalog, { ...original, instanceId: "grok" }, "high")).toThrow("only for Codex");
  expect(applyTaskReasoningOverride({}, original)).toBe(original);
  const target = { id: "t", projectId: "p", title: "test", modelSelection: selected, runtimeMode: "auto" as const, interactionMode: "default" as const, worktreePath: null, branch: null, session: null };
  expect(taskTurnCommand(target, "continue").modelSelection).toEqual(selected);
});
