import { describe, expect, test } from "bun:test";
import { parseModelRouting } from "../src/config.ts";

describe("model routing configuration", () => {
  test("parses maintainer defaults and per-agent selectors", () => {
    expect(parseModelRouting({
      OMP_ORCHESTRATION_MAINTAINER_MODEL: " opencodex/gpt-5.6-sol ",
      OMP_ORCHESTRATION_MAINTAINER_THINKING: "xhigh",
      OMP_ORCHESTRATION_AGENT_MODELS: JSON.stringify({
        task: "opencodex/xai/grok-4.6:high",
        reviewer: ["opencodex/gpt-5.6-sol:high", "opencodex/gpt-5.6-terra:high"],
      }),
    })).toEqual({
      maintainerModel: "opencodex/gpt-5.6-sol",
      maintainerThinking: "xhigh",
      agentModelOverrides: {
        task: "opencodex/xai/grok-4.6:high",
        reviewer: ["opencodex/gpt-5.6-sol:high", "opencodex/gpt-5.6-terra:high"],
      },
    });
  });

  test.each([
    [{ OMP_ORCHESTRATION_MAINTAINER_THINKING: "ultra" }, "MAINTAINER_THINKING is invalid"],
    [{ OMP_ORCHESTRATION_AGENT_MODELS: "{" }, "must be valid JSON"],
    [{ OMP_ORCHESTRATION_AGENT_MODELS: "[]" }, "must be a JSON object"],
    [{ OMP_ORCHESTRATION_AGENT_MODELS: '{"Task Agent":"model"}' }, "contains invalid agent"],
    [{ OMP_ORCHESTRATION_AGENT_MODELS: '{"task":[]}' }, "string or non-empty string array"],
    [{ OMP_ORCHESTRATION_AGENT_MODELS: '{"task":""}' }, "model selector for task is invalid"],
    [{ OMP_ORCHESTRATION_AGENT_MODELS: '{"task":["model",1]}' }, "contain only strings"],
    [{ OMP_ORCHESTRATION_AGENT_MODELS: '{"task":"model\\nother"}' }, "model selector for task is invalid"],
  ])("rejects invalid routing %#", (env, message) => {
    expect(() => parseModelRouting(env)).toThrow(message);
  });
});
