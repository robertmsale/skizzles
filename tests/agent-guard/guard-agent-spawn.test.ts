import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const hookPath = join(repoRoot, "hooks", "guard-agent-spawn.ts");

type HookOutput = {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
    additionalContext?: string;
    updatedInput?: Record<string, unknown>;
  };
};

let fixtureDirectory = "";
let transcriptSequence = 0;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "skizzles-agent-guard-"));
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function createTranscript(
  depth: number,
  agentPath: string,
  model = "gpt-5.6-terra",
): Promise<string> {
  const path = join(fixtureDirectory, `transcript-${transcriptSequence++}.jsonl`);
  const metadata = {
    type: "session_meta",
    payload: {
      source: {
        subagent: {
          thread_spawn: {
            depth,
            agent_path: agentPath,
          },
        },
      },
    },
  };
  const turnContext = { type: "turn_context", payload: { model } };

  await writeFile(path, `${JSON.stringify(metadata)}\n${JSON.stringify(turnContext)}\n`);
  return path;
}

async function runHook(input: unknown, raw = false): Promise<HookOutput> {
  const processHandle = Bun.spawn([process.execPath, hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  processHandle.stdin.write(raw ? String(input) : JSON.stringify(input));
  processHandle.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as HookOutput;
}

function expectDenied(output: HookOutput, reasonFragment: string): void {
  expect(output.hookSpecificOutput).toMatchObject({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
  });
  expect(output.hookSpecificOutput.permissionDecisionReason).toContain(reasonFragment);
}

describe("guard-agent-spawn hook", () => {
  test("allows root dispatch without rewriting native routing controls", async () => {
    const output = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "collaboration.spawn_agent",
      tool_input: {
        task_name: "worker__build_api",
        fork_turns: "2",
        message: "opaque handoff",
        encrypted_payload: { ciphertext: "unchanged" },
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
      },
    });

    expect(output.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    });
  });

  for (const malformedName of [
    "standard__worker__build_api",
    "worker_build_api",
    "unknown__build_api",
    "worker__BuildApi",
    "worker__build-api",
    "worker__",
  ]) {
    test(`rejects malformed role name ${malformedName}`, async () => {
      const output = await runHook({
        hook_event_name: "PreToolUse",
        tool_name: "spawn_agent",
        tool_input: {
          task_name: malformedName,
          model: "gpt-5.6-terra",
          reasoning_effort: "low",
        },
      });

      expectDenied(output, "role__objective");
    });
  }

  test("requires explicit native model and reasoning fields", async () => {
    const missingModel = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "triage__inspect_route",
        reasoning_effort: "low",
      },
    });
    expectDenied(missingModel, "explicit model and reasoning_effort");

    const missingEffort = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "triage__inspect_route",
        model: "gpt-5.6-terra",
      },
    });
    expectDenied(missingEffort, "explicit model and reasoning_effort");
  });

  test("announces bounded delegation to depth-1 workers", async () => {
    const transcriptPath = await createTranscript(1, "/root/worker__migrate_agent_guard");
    const output = await runHook({
      hook_event_name: "SubagentStart",
      transcript_path: transcriptPath,
    });

    expect(output.hookSpecificOutput.hookEventName).toBe("SubagentStart");
    expect(output.hookSpecificOutput.additionalContext).toContain("at most one active");
    expect(output.hookSpecificOutput.additionalContext).toContain("worker__");
    expect(output.hookSpecificOutput.additionalContext).toContain('fork_turns="none"');
  });

  test("allows bounded Luna and Terra-fallback worker grandchildren", async () => {
    const transcriptPath = await createTranscript(1, "/root/worker__fix_boundary");
    for (const [model, reasoningEffort] of [
      ["gpt-5.6-luna", "medium"],
      ["gpt-5.6-terra", "low"],
    ]) {
      const output = await runHook({
        agent_id: "parent-agent",
        hook_event_name: "PreToolUse",
        transcript_path: transcriptPath,
        tool_name: "collaboration.spawn_agent",
        tool_input: {
          task_name: "worker__add_fixtures",
          fork_turns: "none",
          message: "bounded complete slice",
          model,
          reasoning_effort: reasoningEffort,
        },
      });

      expect(output.hookSpecificOutput).toEqual({
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      });
    }
  });

  test("accepts legacy parent names during migration", async () => {
    const transcriptPath = await createTranscript(1, "/root/complex__worker__fix_boundary");
    const output = await runHook({
      agent_id: "parent-agent",
      hook_event_name: "PreToolUse",
      transcript_path: transcriptPath,
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "worker__add_fixtures",
        fork_turns: "none",
        model: "gpt-5.6-terra",
        reasoning_effort: "low",
      },
    });

    expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("ignores an incomplete transcript tail after verified parent metadata", async () => {
    const transcriptPath = await createTranscript(1, "/root/worker__long_parent");
    await writeFile(transcriptPath, '{"type":"response_item","payload":{"large":"unterminated', {
      flag: "a",
    });
    const output = await runHook({
      agent_id: "parent-agent",
      hook_event_name: "PreToolUse",
      transcript_path: transcriptPath,
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "worker__small_slice",
        fork_turns: "none",
        model: "gpt-5.6-terra",
        reasoning_effort: "low",
      },
    });

    expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("uses the latest model from a bounded transcript tail", async () => {
    const largeRecord = `${JSON.stringify({
      type: "response_item",
      payload: { large: "x".repeat(2 * 1024 * 1024) },
    })}\n`;

    const downgradedTranscript = await createTranscript(
      1,
      "/root/worker__downgraded_parent",
      "gpt-5.6-sol",
    );
    await writeFile(
      downgradedTranscript,
      `${largeRecord}${JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-5.6-luna" },
      })}\n${largeRecord}`,
      { flag: "a" },
    );
    const denied = await runHook({
      agent_id: "parent-agent",
      hook_event_name: "PreToolUse",
      transcript_path: downgradedTranscript,
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "worker__small_slice",
        fork_turns: "none",
        model: "gpt-5.6-terra",
        reasoning_effort: "low",
      },
    });
    expectDenied(denied, "Only depth-1 Terra or Sol Workers");

    const upgradedTranscript = await createTranscript(
      1,
      "/root/worker__upgraded_parent",
      "gpt-5.6-luna",
    );
    await writeFile(
      upgradedTranscript,
      `${largeRecord}${JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-5.6-terra" },
      })}\n${largeRecord}`,
      { flag: "a" },
    );
    const allowed = await runHook({
      agent_id: "parent-agent",
      hook_event_name: "PreToolUse",
      transcript_path: upgradedTranscript,
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "worker__small_slice",
        fork_turns: "none",
        model: "gpt-5.6-terra",
        reasoning_effort: "low",
      },
    });
    expect(allowed.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("rejects delegation from leaf roles, deep workers, and Luna parents", async () => {
    const cases = [
      await createTranscript(1, "/root/review__audit_change"),
      await createTranscript(2, "/root/worker__parent/worker__child"),
      await createTranscript(1, "/root/worker__small_parent", "gpt-5.6-luna"),
    ];
    for (const transcriptPath of cases) {
      const output = await runHook({
        agent_id: "parent-agent",
        hook_event_name: "PreToolUse",
        transcript_path: transcriptPath,
        tool_name: "spawn_agent",
        tool_input: {
          task_name: "worker__apply_fix",
          fork_turns: "none",
          model: "gpt-5.6-terra",
          reasoning_effort: "low",
        },
      });
      expectDenied(output, "Only depth-1 Terra or Sol Workers");
    }
  });

  test("rejects unbounded or inherited-history worker grandchildren", async () => {
    const transcriptPath = await createTranscript(1, "/root/worker__parent", "gpt-5.6-sol");
    const wrongRouteOutput = await runHook({
      agent_id: "parent-agent",
      hook_event_name: "PreToolUse",
      transcript_path: transcriptPath,
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "worker__too_broad",
        fork_turns: "none",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
      },
    });
    expectDenied(wrongRouteOutput, "Luna low/medium");

    const inheritedOutput = await runHook({
      agent_id: "parent-agent",
      hook_event_name: "PreToolUse",
      transcript_path: transcriptPath,
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "worker__small_slice",
        fork_turns: "1",
        model: "gpt-5.6-terra",
        reasoning_effort: "low",
      },
    });
    expectDenied(inheritedOutput, 'fork_turns="none"');
  });

  test("marks valid worker grandchildren as leaves and invalid depth-2 roles as violations", async () => {
    const leafTranscript = await createTranscript(
      2,
      "/root/worker__parent/worker__child",
      "gpt-5.6-terra",
    );
    const leafOutput = await runHook({
      hook_event_name: "SubagentStart",
      transcript_path: leafTranscript,
    });
    expect(leafOutput.hookSpecificOutput.additionalContext).toContain("guaranteed leaf");
    expect(leafOutput.hookSpecificOutput.additionalContext).toContain("Do not spawn");

    const invalidTranscript = await createTranscript(
      2,
      "/root/worker__parent/review__invalid_child",
    );
    const invalidOutput = await runHook({
      hook_event_name: "SubagentStart",
      transcript_path: invalidTranscript,
    });
    expect(invalidOutput.hookSpecificOutput.additionalContext).toContain(
      "depth-2 tasks must be bounded Workers",
    );
  });

  test("rejects follow-up reactivation regardless of tool namespace", async () => {
    const output = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "collaboration.followup_task",
      tool_input: { target: "/root/completed", message: "continue" },
    });

    expectDenied(output, "Completed subagents are not reusable");
  });

  test("returns contract-shaped denials for malformed JSON and unexpected tools", async () => {
    const malformedOutput = await runHook("{not-json", true);
    expectDenied(malformedOutput, "hook input was malformed");

    const unexpectedOutput = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "collaboration.send_message",
      tool_input: {},
    });
    expectDenied(unexpectedOutput, "Unexpected orchestration tool");
  });
});
