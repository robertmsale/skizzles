import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const hook = join(repositoryRoot, "hooks/guard-spawn-agent-fork.ts");
const denialReason =
  'Select a non-empty agent_type role and use the smallest useful positive numbered fork_turns (for example, "1"); do not use full-history or context-free forks.';

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

function event(toolInput: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "spawn_agent",
    tool_input: toolInput,
    ...overrides,
  });
}

describe("spawn-agent fork guard", () => {
  test("passes a selected role with a positive numbered fork", () => {
    const result = invoke(event({ task_name: "worker__fixture", agent_type: "worker", fork_turns: "2" }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("denies missing, full-history, context-free, zero, and malformed forks", () => {
    const inputs = [
      { task_name: "worker__fixture", agent_type: "worker" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "all" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "none" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "0" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "01" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "-1" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "1.5" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: 1 },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: " 1" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: "1 " },
      { task_name: "worker__fixture" },
      { task_name: "worker__fixture", agent_type: "worker", fork_turns: null },
    ];

    for (const toolInput of inputs) {
      const result = invoke(event(toolInput));

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: denialReason,
        },
      });
      expect(result.stderr).toBe("");
    }
  });

  test("denies missing and blank roles even with a numbered fork", () => {
    for (const agentType of [undefined, "", "   ", null, 1]) {
      const result = invoke(event({ task_name: "worker__fixture", agent_type: agentType, fork_turns: "1" }));

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
      expect(result.stderr).toBe("");
    }
  });

  test("passes representative MultiAgentV1 payloads without applying the V2 policy", () => {
    for (const toolInput of [
      { message: "legacy child", agent_type: "worker", fork_context: true },
      { items: [{ type: "text", text: "legacy child" }], fork_context: false },
    ]) {
      const result = invoke(event(toolInput));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });

  test("denies a V2 spawn when fork_turns is omitted", () => {
    const result = invoke(event({ task_name: "worker__fixture", agent_type: "worker", message: "missing fork" }));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.stderr).toBe("");
  });

  test("fails open for unrelated, malformed, and non-PreToolUse input", () => {
    for (const input of [
      "not json",
      event({ agent_type: "worker", fork_turns: "all" }, { hook_event_name: "PostToolUse" }),
      event({ agent_type: "worker", fork_turns: "all" }, { tool_name: "Bash" }),
      JSON.stringify({ tool_name: "spawn_agent", tool_input: { agent_type: "worker", fork_turns: "all" } }),
      JSON.stringify(["spawn_agent"]),
    ]) {
      const result = invoke(input);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });
});
