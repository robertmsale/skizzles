---
name: agent-dispatch
description: Choose bounded native Codex or Grok worker assignments, instruction-only roles, and economical model/reasoning settings for delegated coding work.
---

# Agent dispatch

Keep T3 work units owned by Codex. Use T3 orchestration for separate work units; use native Codex subagents or `grok-worker` for bounded work inside the current task and workspace. Do simple sequential work directly. Delegate when a coherent independent assignment improves throughput or provides needed independent judgment.

## Duties and selection

Roles encode instructions, not model or reasoning settings:

- `worker` implements and validates owned paths; `default` handles a general bounded assignment.
- `explorer` investigates without modifying product source or durable configuration.
- `review` independently evaluates a coherent candidate; the root retains acceptance.
- Grok via `grok-worker` is an implementation backend with no nested agents, sharing the same workspace.

Choose the least expensive available model likely to succeed at the particular assignment. For a catalog exposing Luna/Terra/Sol: start clear bounded edits with Luna at low or medium effort; use Terra medium for investigation that requires following behavior across modules. Use Sol for a demonstrated capability gap or consequential ambiguity that warrants stronger judgment. These are dispatch guidance, not role bindings. Respect the available tool's actual model names and effort values.

Increase reasoning when there is a specific unresolved causal question or tradeoff. Escalate the model when evidence shows a capability gap, not merely because the task involves code, many files, or a failed environment command. Reduce uncertainty with a smaller assignment or an explorer before buying a larger model by default. Do not repeat failed worker attempts blindly.

Select model and reasoning explicitly when making a cost-sensitive native dispatch. Use `fork_turns="none"` with a self-contained assignment or the smallest useful positive turn count. Full-history forks inherit parent configuration on surfaces that prohibit explicit overrides; follow the tool schema rather than assuming the selected role changes that. Continue the same worker for rework when its session remains appropriate.

## Shared ownership and handoff

Give the worker objective, owned paths, constraints, necessary context, and acceptance/validation criteria. Identify pre-existing edits and concurrent owners. Serialize overlapping writes, including generated artifacts and lockfiles. The root owns Git staging, commits, integration, publication, and user communication; workers leave their edits for root review. No automatic rollback on cancellation.

Use compact completion and blocker reports. Do not routinely read worker transcripts or duplicate their execution loops. Inspect the actual diff and validation evidence; use `request-review` for independent native review of substantial committed source changes. The integration owner requests it after workers finish; the reviewer settings belong to the user. Review is a duty, not an automatic reason for the most expensive model at maximum effort.

## Selective use

Copy this skill independently to retain dispatch guidance. Native role config files are generated from `assets/agent-role-templates/` and `assets/agent-role-spec.json`; copy the desired generated role files together with their referenced `skizzles_subagent_instructions.md`, preserving relative paths, and declare only the roles you intend to use. Copy the complete `grok-worker` skill directory for its standalone runtime. No full harness or installer activation is required.
