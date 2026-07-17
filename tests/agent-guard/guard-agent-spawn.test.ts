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

async function createTranscript(depth: number, agentPath: string): Promise<string> {
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

  await writeFile(path, `${JSON.stringify(metadata)}\n${JSON.stringify({ ignored: true })}\n`);
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
  test("allows root dispatch, preserves the payload, and injects authoritative route controls", async () => {
    const output = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "collaboration.spawn_agent",
      tool_input: {
        task_name: "standard__worker__build_api",
        fork_turns: "none",
        message: "opaque handoff",
        encrypted_payload: { ciphertext: "unchanged" },
        model: "caller-model",
        reasoning_effort: "low",
      },
    });

    expect(output.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        task_name: "standard__worker__build_api",
        fork_turns: "none",
        message: "opaque handoff",
        encrypted_payload: { ciphertext: "unchanged" },
        model: "gpt-5.6-terra",
        reasoning_effort: "high",
      },
    });
  });

  for (const malformedName of [
    "standard_worker_build_api",
    "unknown__worker__build_api",
    "standard__unknown__build_api",
    "standard__worker__BuildApi",
    "standard__worker__build-api",
    "standard__worker__",
  ]) {
    test(`rejects malformed route ${malformedName}`, async () => {
      const output = await runHook({
        hook_event_name: "PreToolUse",
        tool_name: "spawn_agent",
        tool_input: { task_name: malformedName },
      });

      expectDenied(output, "tier__role__objective");
    });
  }

  test("announces the bounded delegation allowance to eligible depth-1 workers", async () => {
    const transcriptPath = await createTranscript(
      1,
      "/root/specialized__worker__migrate_agent_guard",
    );
    const output = await runHook({
      hook_event_name: "SubagentStart",
      transcript_path: transcriptPath,
    });

    expect(output.hookSpecificOutput.hookEventName).toBe("SubagentStart");
    expect(output.hookSpecificOutput.additionalContext).toContain("at most one active");
    expect(output.hookSpecificOutput.additionalContext).toContain("mechanical__worker__");
    expect(output.hookSpecificOutput.additionalContext).toContain("scoped__worker__");
    expect(output.hookSpecificOutput.additionalContext).toContain('fork_turns="none"');
  });

  test("allows one bounded Luna worker route from an eligible depth-1 worker", async () => {
    const transcriptPath = await createTranscript(1, "/root/complex__worker__fix_boundary");
    const output = await runHook({
      agent_id: "parent-agent",
      hook_event_name: "PreToolUse",
      transcript_path: transcriptPath,
      tool_name: "collaboration.spawn_agent",
      tool_input: {
        task_name: "scoped__worker__add_fixtures",
        fork_turns: "none",
        message: "bounded complete slice",
      },
    });

    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        task_name: "scoped__worker__add_fixtures",
        fork_turns: "none",
        model: "gpt-5.6-luna",
        reasoning_effort: "xhigh",
      },
    });
  });

  test("rejects delegation from leaf roles and deeper workers", async () => {
    const reviewTranscript = await createTranscript(1, "/root/critical__review__audit_change");
    const reviewOutput = await runHook({
      agent_id: "review-agent",
      hook_event_name: "PreToolUse",
      transcript_path: reviewTranscript,
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "scoped__worker__apply_fix",
        fork_turns: "none",
      },
    });
    expectDenied(reviewOutput, "Only depth-1 Terra or Sol workers");

    const grandchildTranscript = await createTranscript(
      2,
      "/root/standard__worker__parent/scoped__worker__child",
    );
    const grandchildOutput = await runHook({
      agent_id: "grandchild-agent",
      hook_event_name: "PreToolUse",
      transcript_path: grandchildTranscript,
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "mechanical__worker__nested_child",
        fork_turns: "none",
      },
    });
    expectDenied(grandchildOutput, "Only depth-1 Terra or Sol workers");
  });

  test("rejects non-Luna grandchildren and inherited-history grandchildren", async () => {
    const transcriptPath = await createTranscript(1, "/root/specialized__worker__parent");
    const wrongRouteOutput = await runHook({
      agent_id: "parent-agent",
      hook_event_name: "PreToolUse",
      transcript_path: transcriptPath,
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "standard__worker__too_broad",
        fork_turns: "none",
      },
    });
    expectDenied(wrongRouteOutput, "mechanical__worker__objective or scoped__worker__objective");

    const inheritedOutput = await runHook({
      agent_id: "parent-agent",
      hook_event_name: "PreToolUse",
      transcript_path: transcriptPath,
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "mechanical__worker__small_slice",
        fork_turns: "all",
      },
    });
    expectDenied(inheritedOutput, 'fork_turns="none"');
  });

  test("marks valid Luna grandchildren as leaves and invalid depth-2 routes as violations", async () => {
    const leafTranscript = await createTranscript(
      2,
      "/root/specialized__worker__parent/scoped__worker__child",
    );
    const leafOutput = await runHook({
      hook_event_name: "SubagentStart",
      transcript_path: leafTranscript,
    });
    expect(leafOutput.hookSpecificOutput.additionalContext).toContain("guaranteed leaf");
    expect(leafOutput.hookSpecificOutput.additionalContext).toContain("Do not spawn");

    const invalidTranscript = await createTranscript(
      2,
      "/root/specialized__worker__parent/broad__worker__invalid_child",
    );
    const invalidOutput = await runHook({
      hook_event_name: "SubagentStart",
      transcript_path: invalidTranscript,
    });
    expect(invalidOutput.hookSpecificOutput.additionalContext).toContain(
      "depth-2 tasks must be mechanical or scoped Workers",
    );
  });

  test("injects every tier's model and effort contract", async () => {
    const routes = {
      mechanical: ["gpt-5.6-luna", "high"],
      scoped: ["gpt-5.6-luna", "xhigh"],
      broad: ["gpt-5.6-terra", "high"],
      standard: ["gpt-5.6-terra", "high"],
      complex: ["gpt-5.6-sol", "medium"],
      specialized: ["gpt-5.6-sol", "high"],
      critical: ["gpt-5.6-sol", "xhigh"],
    } as const;

    for (const [tier, [model, reasoningEffort]] of Object.entries(routes)) {
      const output = await runHook({
        hook_event_name: "PreToolUse",
        tool_name: "spawn_agent",
        tool_input: { task_name: `${tier}__triage__inspect_route` },
      });
      expect(output.hookSpecificOutput.updatedInput).toMatchObject({
        model,
        reasoning_effort: reasoningEffort,
      });
    }
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
