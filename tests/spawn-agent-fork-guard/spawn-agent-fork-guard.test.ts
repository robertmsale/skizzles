import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const hook = join(repositoryRoot, "hooks/guard-spawn-agent-fork.ts");
const overrideForkReason =
  'Explicit model/reasoning overrides require fork_turns="none" or a positive numbered context fork; the native surface disallows full-history and omitted forks with those overrides.';
const malformedForkReason =
  'Use fork_turns="none" for a context-free spawn, a positive numbered context fork (for example, "1"), or a native default ("all" or omitted without model/reasoning overrides).';
const blankRoleReason =
  'If agent_type is set, use a non-empty role name; omit it to keep the native default.';

function invoke(input: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", hook], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function event(
  toolInput: unknown,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "spawn_agent",
    tool_input: toolInput,
    ...overrides,
  });
}

function expectDenied(result: { exitCode: number; stdout: string; stderr: string }, reason: string): void {
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput).toEqual({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  });
  expect(result.stderr).toBe("");
}

function expectPassed(result: { exitCode: number; stdout: string; stderr: string }): void {
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
}

describe("spawn-agent fork guard", () => {
  test("allows native defaults without forcing a role", () => {
    for (const toolInput of [
      { task_name: "worker__fixture" },
      { task_name: "worker__fixture", fork_turns: "all" },
      { task_name: "worker__fixture", agent_type: "worker" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "all" },
    ]) {
      expectPassed(invoke(event(toolInput)));
    }
  });

  test("allows a selected role with a positive numbered fork", () => {
    expectPassed(invoke(event({ task_name: "worker__fixture", agent_type: "worker", fork_turns: "2" })));
  });

  test("allows context-free forks with or without a role", () => {
    for (const toolInput of [
      { task_name: "worker__fixture", fork_turns: "none" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "none" },
    ]) {
      expectPassed(invoke(event(toolInput)));
    }
  });

  test("allows explicit model and reasoning with none or numbered forks", () => {
    for (const toolInput of [
      { task_name: "review__fixture", model: "gpt-5.6-luna", fork_turns: "none" },
      { task_name: "review__fixture", agent_type: "review", model: "gpt-5.6-sol", fork_turns: "1" },
      { task_name: "review__fixture", reasoning_effort: "medium", fork_turns: "none" },
      { task_name: "review__fixture", model: null, fork_turns: "none" },
    ]) {
      expectPassed(invoke(event(toolInput)));
    }
  });

  test("enforces the same contract for the flattened collaboration namespace", () => {
    const valid = invoke(event(
      { task_name: "worker__fixture", agent_type: "worker", model: "gpt-5.6-luna", fork_turns: "2" },
      { tool_name: "collaborationspawn_agent" },
    ));
    expectPassed(valid);

    for (const toolInput of [
      { task_name: "worker__fixture", model: "gpt-5.6-luna" },
      { task_name: "worker__fixture", model: "gpt-5.6-luna", fork_turns: "all" },
      { task_name: "worker__fixture", agent_type: "worker", reasoning_effort: "low" },
    ]) {
      expectDenied(invoke(event(toolInput, { tool_name: "collaborationspawn_agent" })), overrideForkReason);
    }
  });

  test("denies full-history and omitted forks when model or reasoning is overridden", () => {
    for (const toolInput of [
      { task_name: "review__fixture", model: "gpt-5.6-sol" },
      { task_name: "review__fixture", agent_type: "review", model: "gpt-5.6-sol" },
      { task_name: "review__fixture", model: "gpt-5.6-sol", fork_turns: "all" },
      { task_name: "review__fixture", reasoning_effort: "none" },
      { task_name: "review__fixture", model: null },
    ]) {
      expectDenied(invoke(event(toolInput)), overrideForkReason);
    }
  });

  test("denies malformed forks even without model overrides", () => {
    const inputs = [
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "0" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "01" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "-1" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "1.5" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: 1 },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: " 1" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "1 " },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: null },
    ];

    for (const toolInput of inputs) {
      expectDenied(invoke(event(toolInput)), malformedForkReason);
    }
  });

  test("denies blank roles when agent_type is present", () => {
    for (const agentType of ["", "   ", null, 1]) {
      const result = invoke(event({ task_name: "worker__fixture", agent_type: agentType, fork_turns: "1" }));
      expectDenied(result, blankRoleReason);
    }
  });

  test("denies malformed forks even when model overrides are otherwise valid", () => {
    for (const forkTurns of ["0", "01", "-1", "1.5", 1, " 1", null]) {
      expectDenied(
        invoke(event({ task_name: "review__fixture", model: "gpt-5.6-luna", fork_turns: forkTurns })),
        overrideForkReason,
      );
    }
  });

  test("passes representative MultiAgentV1 payloads without applying the V2 policy", () => {
    for (const toolInput of [
      { message: "legacy child", agent_type: "worker", fork_context: true },
      { items: [{ type: "text", text: "legacy child" }], fork_context: false },
    ]) {
      expectPassed(invoke(event(toolInput)));
    }
  });

  test("fails open for unrelated, malformed, and non-PreToolUse input", () => {
    for (const input of [
      "not json",
      event({ agent_type: "worker", fork_turns: "all" }, { hook_event_name: "PostToolUse" }),
      event({ agent_type: "worker", fork_turns: "all" }, { tool_name: "Bash" }),
      JSON.stringify({ tool_name: "spawn_agent", tool_input: { agent_type: "worker", fork_turns: "all" } }),
      JSON.stringify(["spawn_agent"]),
    ]) {
      expectPassed(invoke(input));
    }
  });
});
