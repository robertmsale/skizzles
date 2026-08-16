import { describe, expect, test } from "bun:test";
import { requireSelection } from "../src/protocol.ts";

describe("selection safety", () => {
  test("accepts providers without model options", () => {
    expect(requireSelection({ instanceId: "grok", model: "grok-4.6", options: [] })).toEqual({
      instanceId: "grok", model: "grok-4.6", options: [],
    });
    expect(requireSelection({ instanceId: "grok", model: "grok-4.6" })).toEqual({
      instanceId: "grok", model: "grok-4.6", options: [],
    });
    expect(() => requireSelection({ instanceId: "grok", model: "grok-4.6", options: null })).toThrow(
      "Model selection is malformed",
    );
  });

  test("still rejects an optionless Codex selection", () => {
    expect(() => requireSelection({ instanceId: "codex", model: "gpt-5.6-sol", options: [] })).toThrow(
      "Codex reasoning effort is missing",
    );
    expect(() => requireSelection({ instanceId: "codex", model: "gpt-5.6-sol" })).toThrow(
      "Codex reasoning effort is missing",
    );
  });

  test("rejects an optionless custom Codex instance by driver identity", () => {
    expect(() => requireSelection(
      { instanceId: "codex_personal", model: "gpt-5.6-sol", options: [] },
      "codex",
    )).toThrow("Codex reasoning effort is missing");
    expect(() => requireSelection(
      { instanceId: "codex_personal", model: "gpt-5.6-sol" },
      "codex",
    )).toThrow("Codex reasoning effort is missing");
  });

  test("preserves the exact provider option values", () => {
    expect(requireSelection({ instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] })).toEqual({
      instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }],
    });
  });
});
