/**
 * MultiAgentV2 dispatch boundary.
 *
 * Native spawn_agent owns model and reasoning selection. This hook validates
 * role-oriented task names, requires explicit routing controls, permits one
 * bounded worker delegation layer, and blocks completed-task reactivation.
 */
type HookInput = {
  agent_id?: unknown;
  hook_event_name?: unknown;
  transcript_path?: unknown;
  tool_name?: unknown;
  tool_input?: Record<string, unknown> & {
    task_name?: unknown;
    model?: unknown;
    reasoning_effort?: unknown;
    fork_turns?: unknown;
  };
};

const roles = ["triage", "worker", "designer", "qa", "review", "deployment"] as const;
const taskNamePattern = new RegExp(
  `^(${roles.join("|")})__[a-z0-9]+(?:_[a-z0-9]+)*$`,
);
const legacyTaskNamePattern = new RegExp(
  `^[a-z0-9]+__(${roles.join("|")})__[a-z0-9]+(?:_[a-z0-9]+)*$`,
);
const sessionMetadataReadLimit = 2 * 1024 * 1024;

function deny(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

type ThreadState = {
  depth?: unknown;
  agent_path?: unknown;
  model?: string;
};

async function readLatestModel(file: ReturnType<typeof Bun.file>): Promise<string | undefined> {
  let end = file.size;
  let carry = "";
  while (end > 0) {
    const start = Math.max(0, end - sessionMetadataReadLimit);
    const text = await file.slice(start, end).text();
    const lines = `${text}${carry}`.split("\n");
    carry = start > 0 ? (lines.shift() ?? "") : "";
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: unknown;
          payload?: { model?: unknown };
        };
        if (entry.type === "turn_context" && typeof entry.payload?.model === "string") {
          return entry.payload.model;
        }
      } catch {
        // A non-context record can be truncated at a chunk boundary. Continue
        // scanning older complete records rather than losing verified state.
      }
    }
    if (carry.length > sessionMetadataReadLimit) carry = "";
    end = start;
  }
  return undefined;
}

async function readThreadState(transcriptPath: unknown): Promise<ThreadState | null> {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;

  try {
    const file = Bun.file(transcriptPath);
    const prefix = await file.slice(0, sessionMetadataReadLimit).text();
    let state: ThreadState = {};
    const lines = prefix.split("\n");
    if (!prefix.endsWith("\n")) lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const entry = JSON.parse(line) as {
        type?: unknown;
        payload?: {
          model?: unknown;
          source?: { subagent?: { thread_spawn?: ThreadState } };
        };
      };
      if (entry.type === "session_meta") {
        state = { ...state, ...entry.payload?.source?.subagent?.thread_spawn };
      }
    }
    state.model = await readLatestModel(file);
    return state;
  } catch {
    return null;
  }
}

function parseRoleFromPath(agentPath: unknown): string | null {
  if (typeof agentPath !== "string") return null;
  const taskName = agentPath.split("/").filter(Boolean).at(-1);
  if (!taskName) return null;
  return taskName.match(taskNamePattern)?.[1] ?? taskName.match(legacyTaskNamePattern)?.[1] ?? null;
}

function isExplicitRouting(model: unknown, reasoningEffort: unknown): boolean {
  return (
    typeof model === "string" &&
    model.trim().length > 0 &&
    typeof reasoningEffort === "string" &&
    reasoningEffort.trim().length > 0
  );
}

function isBoundedWorkerRoute(model: unknown, reasoningEffort: unknown): boolean {
  if (model === "gpt-5.6-luna") {
    return reasoningEffort === "low" || reasoningEffort === "medium";
  }
  return model === "gpt-5.6-terra" && reasoningEffort === "low";
}

const raw = await Bun.stdin.text();
if (!raw.trim()) {
  deny("Blocked spawn_agent because the hook received empty input.");
}

let event: HookInput;
try {
  event = JSON.parse(raw) as HookInput;
} catch {
  deny("Blocked spawn_agent because the hook input was malformed.");
}

if (event.hook_event_name === "SubagentStart") {
  const state = await readThreadState(event.transcript_path);
  const role = parseRoleFromPath(state?.agent_path);
  const depth = state?.depth;

  let additionalContext: string | null = null;
  if (depth === 1 && role === "worker") {
    additionalContext =
      "Fourth Wall worker delegation may be available: while continuing independent implementation, you may dispatch at most one active worker__... grandchild for a small, disjoint, self-contained ownership slice. Use explicit Luna low/medium routing when available or Terra low as the bounded fallback, fork_turns=\"none\", and give it the complete inspect-edit-focused-validation-fix-report loop. The spawn guard verifies the effective parent and child routes.";
  } else if (depth === 2 && role === "worker") {
    additionalContext =
      "You are a bounded worker grandchild and a guaranteed leaf. Own the assigned slice end to end: inspect, edit, run focused validation, fix in-scope failures, and report changed areas plus evidence. Do not spawn or perform Git integration. Message your parent only for a material blocker or ownership collision, then send one compact final result.";
  } else if (depth === 2) {
    additionalContext =
      "Fourth Wall policy violation: depth-2 tasks must be bounded Workers. Do not take ownership or spawn; report the invalid route to the parent/root and stop.";
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        ...(additionalContext ? { additionalContext } : {}),
      },
    }),
  );
  process.exit(0);
}

const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
if (toolName.endsWith("followup_task")) {
  deny(
    "Completed subagents are not reusable. Spawn a fresh role__objective task with a compact handoff and explicit model/reasoning controls.",
  );
}

if (!toolName.endsWith("spawn_agent")) {
  deny(`Unexpected orchestration tool reached the dispatch hook: ${toolName || "unknown"}.`);
}

const taskName = event.tool_input?.task_name;
if (typeof taskName !== "string" || !taskNamePattern.test(taskName)) {
  deny(
    "Task names must use role__objective. Roles: triage, worker, designer, qa, review, deployment. Use lowercase letters, digits, and underscores only.",
  );
}

if (!isExplicitRouting(event.tool_input?.model, event.tool_input?.reasoning_effort)) {
  deny(
    "spawn_agent must pass explicit model and reasoning_effort values selected from the active tool schema using the Fourth Wall complexity and horizon guidance.",
  );
}

if (typeof event.agent_id === "string" && event.agent_id.trim()) {
  const parentState = await readThreadState(event.transcript_path);
  const parentRole = parseRoleFromPath(parentState?.agent_path);
  const childRole = taskName.split("__", 1)[0];

  if (
    parentState?.depth !== 1 ||
    parentRole !== "worker" ||
    (parentState.model !== "gpt-5.6-terra" && parentState.model !== "gpt-5.6-sol")
  ) {
    deny(
      "Only depth-1 Terra or Sol Workers may delegate. Return the proposed slice to the root orchestrator for dispatch.",
    );
  }
  if (
    childRole !== "worker" ||
    !isBoundedWorkerRoute(event.tool_input?.model, event.tool_input?.reasoning_effort)
  ) {
    deny(
      "Worker grandchildren must use worker__objective with Luna low/medium when available or Terra low as the bounded fallback.",
    );
  }
  if (event.tool_input?.fork_turns !== "none") {
    deny(
      "Worker grandchildren must use fork_turns=\"none\" so bounded ownership slices do not inherit the parent's long context.",
    );
  }
}

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  }),
);
