/**
 * MultiAgentV2 dispatch boundary.
 *
 * Root PreToolUse events omit `agent_id`; spawned subagents include it. The
 * hook validates tier/role task names, permits one bounded worker delegation
 * layer, and blocks follow-up reactivation because an unloaded child may resume
 * with the caller's model and reasoning effort.
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

const routes = {
  mechanical: { model: "gpt-5.6-luna", effort: "high" },
  scoped: { model: "gpt-5.6-luna", effort: "xhigh" },
  broad: { model: "gpt-5.6-terra", effort: "high" },
  standard: { model: "gpt-5.6-terra", effort: "high" },
  complex: { model: "gpt-5.6-sol", effort: "medium" },
  specialized: { model: "gpt-5.6-sol", effort: "high" },
  critical: { model: "gpt-5.6-sol", effort: "xhigh" },
} as const;

const roles = ["triage", "worker", "designer", "qa", "review", "deployment"] as const;
const delegatingWorkerTiers = new Set(["broad", "standard", "complex", "specialized", "critical"]);
const delegatedWorkerTiers = new Set(["mechanical", "scoped"]);
const sessionMetadataReadLimit = 2 * 1024 * 1024;
const taskNamePattern = new RegExp(
  `^(${Object.keys(routes).join("|")})__(${roles.join("|")})__[a-z0-9]+(?:_[a-z0-9]+)*$`,
);

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

type ThreadSpawn = {
  depth?: unknown;
  agent_path?: unknown;
};

async function readThreadSpawn(transcriptPath: unknown): Promise<ThreadSpawn | null> {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;

  try {
    // Session metadata is the first JSONL record; never load a long rollout just
    // to recover its task path and depth.
    const prefix = await Bun.file(transcriptPath).slice(0, sessionMetadataReadLimit).text();
    const newline = prefix.indexOf("\n");
    if (newline < 0) return null;
    const firstLine = prefix.slice(0, newline);
    const entry = JSON.parse(firstLine) as {
      type?: unknown;
      payload?: { source?: { subagent?: { thread_spawn?: ThreadSpawn } } };
    };
    if (entry.type !== "session_meta") return null;
    return entry.payload?.source?.subagent?.thread_spawn ?? null;
  } catch {
    return null;
  }
}

function parseRouteFromPath(agentPath: unknown): { tier: string; role: string } | null {
  if (typeof agentPath !== "string") return null;
  const taskName = agentPath.split("/").filter(Boolean).at(-1);
  if (!taskName || !taskNamePattern.test(taskName)) return null;
  const [tier, role] = taskName.split("__", 3);
  return { tier, role };
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
  const spawn = await readThreadSpawn(event.transcript_path);
  const route = parseRouteFromPath(spawn?.agent_path);
  const depth = spawn?.depth;

  let additionalContext: string | null = null;
  if (depth === 1 && route?.role === "worker" && delegatingWorkerTiers.has(route.tier)) {
    additionalContext =
      "Fourth Wall worker delegation is available: you may keep implementing your owned work while dispatching at most one active mechanical__worker__... or scoped__worker__... Luna grandchild for a small, disjoint, self-contained ownership slice. Give it the complete inspect-edit-focused-validation-fix-report loop, use fork_turns=\"none\", avoid overlapping writes, and mark it done after delivery. Delegate outcomes, not command-running errands.";
  } else if (
    depth === 2 &&
    route?.role === "worker" &&
    delegatedWorkerTiers.has(route.tier)
  ) {
    additionalContext =
      "You are a Luna worker grandchild and a guaranteed leaf. Own the assigned bounded slice end to end: inspect, edit, run focused validation, fix in-scope failures, and report changed areas plus evidence. Do not spawn or perform Git integration. Message your parent only for a material blocker or ownership collision, then send one compact final result.";
  } else if (depth === 2) {
    additionalContext =
      "Fourth Wall policy violation: depth-2 tasks must be mechanical or scoped Workers. Do not take ownership or spawn; report the invalid route to the parent/root and stop.";
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
    "Completed subagents are not reusable. Spawn a fresh tier__role__objective task with a compact handoff, raising the tier when the prior attempt exposed greater complexity.",
  );
}

if (!toolName.endsWith("spawn_agent")) {
  deny(`Unexpected orchestration tool reached the dispatch hook: ${toolName || "unknown"}.`);
}

const taskName = event.tool_input?.task_name;
if (typeof taskName !== "string" || !taskNamePattern.test(taskName)) {
  deny(
    "Task names must use tier__role__objective. Tiers: mechanical, scoped, broad, standard, complex, specialized, critical. Roles: triage, worker, designer, qa, review, deployment. Use lowercase letters, digits, and underscores only.",
  );
}

const tier = taskName.split("__", 1)[0] as keyof typeof routes;
const route = routes[tier];

if (typeof event.agent_id === "string" && event.agent_id.trim()) {
  const parentSpawn = await readThreadSpawn(event.transcript_path);
  const parentRoute = parseRouteFromPath(parentSpawn?.agent_path);
  const childRole = taskName.split("__", 3)[1];

  if (
    parentSpawn?.depth !== 1 ||
    parentRoute?.role !== "worker" ||
    !delegatingWorkerTiers.has(parentRoute.tier)
  ) {
    deny(
      "Only depth-1 Terra or Sol workers may delegate. Return the proposed slice to the root orchestrator for dispatch.",
    );
  }
  if (childRole !== "worker" || !delegatedWorkerTiers.has(tier)) {
    deny(
      "Worker grandchildren must use mechanical__worker__objective or scoped__worker__objective so they remain bounded Luna ownership slices.",
    );
  }
  if (event.tool_input?.fork_turns !== "none") {
    deny(
      "Worker grandchildren must use fork_turns=\"none\" so bounded Luna slices do not inherit the parent's long context.",
    );
  }
}

/**
 * Tier routing is authoritative. Preserve the complete spawn payload, including
 * encrypted messages and fork settings, while injecting the model controls that
 * Desktop may hide from the model-visible spawn schema.
 */
console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...event.tool_input,
        model: route.model,
        reasoning_effort: route.effort,
      },
    },
  }),
);
