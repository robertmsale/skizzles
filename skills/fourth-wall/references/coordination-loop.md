# Native Coordination Loop

## Tool Semantics

| Tool | Use | Important behavior |
| --- | --- | --- |
| `spawn_agent` | Create bounded work | Use `<role>__<objective>`, pass explicit model/effort, and choose the smallest useful `fork_turns` value. Below the root, only eligible Workers may dispatch one active bounded Worker. |
| `list_agents` | Inspect the live tree | Can filter by task-path prefix. Use before intervention or reassignment. |
| `send_message` | Deliver context or a correction to running work | Queues the message and does not trigger a new turn. Do not target completed children. |
| `followup_task` | Reserved | The global hook blocks it because reloading a completed child can lose its model/effort assignment. Spawn a replacement. |
| `wait_agent` | Synchronize on activity | Waits for any mailbox update, user steering, or timeout. It is an event wait, not a status dump. |
| `interrupt_agent` | Stop current work | Leaves the task available for later messages and follow-up work. Cannot interrupt self or root. |

## Root Loop

1. Inspect the task graph with `list_agents` only at meaningful coordination points.
2. Compare active ownership and status with the overall outcome.
3. Use `send_message` for information the target should receive without waking it.
4. Spawn a fresh replacement when completed work needs another concrete action; include the prior evidence and ownership boundary.
5. Continue high-leverage root decisions and integration inspection instead of duplicating child work.
6. Use `wait_agent` only when mailbox activity is the next useful synchronization point. Prefer one appropriately long bounded wait over repeated short waits, and do not poll merely to narrate progress.
7. Verify returned evidence before accepting or routing the result.

The child that owns a long-running command also owns its terminal polling and reports the useful outcome. The root should not mirror that polling or repeatedly request status from a task that is still within its expected runtime.

A delegating Worker follows the same event-driven loop: continue independent implementation, do not poll the Luna Worker repeatedly, and do not edit its assigned surface. The Luna Worker should send an intermediate message only for a material blocker or ownership collision; normal progress arrives in its compact final report.

## Privileged Steps

Native approval requests are routed out-of-band to the configured reviewer; they do not bubble to the root orchestrator. Under the recommended setup, `approvals_reviewer = "auto_review"` lets subagents request necessary escalation without pausing for the user. Include the exact command or tool action and its reason, respect denials, and do not repeatedly retry an unchanged request. Message the root when a denial changes the plan or when the privileged action is itself an orchestration decision, such as serialized verification or coordinated Git integration.

## Dependency Release

When task B depends on task A:

- Either delay spawning B until A stabilizes, or spawn B with explicitly independent preparatory work.
- When A's output is ready, send it to B while B is still running, or spawn B only after A stabilizes.
- Do not let B guess an unstable shared interface.

## Shared Workspace And Integration

All tasks in the tree share the same checkout. Assign disjoint write ownership, tell implementation tasks not to revert unrelated edits, and resolve overlap before more changes land.

The root owns branch changes, staging, commits, merges, rebases, cherry-picks, stashes, resets, cleans, pushes, and other Git-history mutations unless the user and root explicitly delegate an exact action. Subagents should use read-only Git inspection by default.

Treat project-wide build, analyze, format, and test commands as synchronization points while parallel edits are active. Let implementation children run narrow checks that do not contend for shared locks. After edits stabilize, prefer one of these ownership shapes:

- An integration Worker owns the serial build/test/fix loop, including in-scope repairs and reruns.
- Review owns a serial verification command list and reports findings without modifying code.
- QA owns runtime startup, piloting, screenshots, logs, and user-flow evidence.

The root retains Git mutations, resolves cross-owner decisions, inspects the returned evidence, and accepts or reroutes the result. This is especially important for Flutter, Xcode, Cargo, Gradle, Linux/Xvfb application proof, and package-wide formatters.

## Review Loop

1. Worker returns its completion claim and evidence.
2. Root inspects the diff and selects the relevant proof obligations.
3. Spawn a `review` task for adversarial source/build/security/dead-code review, or `qa` for runnable product proof. Implementation-time QA proof complements rather than replaces a later independent product QA handoff.
4. On failure, spawn a fresh Worker with the exact findings and relevant prior evidence.
5. Re-review the corrected state when the risk warrants it.
6. The root integrates and decides completion; the reviewer does not silently broaden scope or relax the owner outcome.

## Recovery Loop

When orchestration drifts:

1. `list_agents` and reconstruct owner, status, dependency, and next action for each live path.
2. Resolve overlapping ownership before more edits land.
3. Queue nonurgent corrections with `send_message`.
4. Replace an idle or completed task that needs more work; do not reactivate it.
5. Interrupt only obsolete, unsafe, or irreconcilably overlapping work.
6. Spawn a replacement only after its role, handoff packet, and ownership boundary are ready.

Canonical paths are the routing graph. A task can use a short relative name for nearby tasks; use the full canonical path when communicating across branches of the tree or when names may be ambiguous.
