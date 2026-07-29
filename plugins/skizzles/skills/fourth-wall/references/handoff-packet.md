# Context Renewal And Warm Handoff

Use a handoff when accumulated context is slowing or confusing the work, when
ownership changes, or when an agent can no longer continue reliably. Do not
hand off merely to summarize ordinary progress. A small task that remains with
its owner needs its normal completion claim, not a renewal packet.

## Compact Packet

Include only operational state:

```md
## Objective
The full outcome still being pursued.

## Ownership
Current task paths, roles, and file or system boundaries.

## Established State
Completed changes, decisions, commits or artifacts, and validation evidence.

## Constraints
User decisions, architecture boundaries, relevant skills, and known hazards.

## Open Work
Unfinished items, valid blockers, dependencies, and remaining gates.

## Next Action
The first concrete action the successor should take.

## Evidence State
The accepted Triage owner, report path and revision, material clarifications,
and any assumption that implementation or review has falsified.
```

For a long root task, store this packet under `/tmp` and pass its path to
children together with a compact slice-specific assignment or follow-up. Update
it at ownership transfers, material routing changes, and acceptance checkpoints.
Do not automate encrypted spawn-message rewriting or continuously append
command output.

Do not include motivational framing, a chronological transcript, stable base
instructions, or facts the successor can cheaply inspect. Preserve usable task
identities, ownership, evidence paths, status, and contact semantics.

## Worker Or Specialist Handoff

Use a parent-mediated sibling replacement so the root preserves the task graph
and role boundary:

1. The outgoing task sends the packet to the root with `send_message` and stops
   taking new ownership.
2. The root inspects the packet and current tree.
3. The root spawns a fresh sibling, selects the fixed native `agent_type`
   without model/reasoning overrides, names the behavioral role and evidence
   path in its handoff, and chooses the smallest useful bounded history fork.
4. The root confirms the successor exists and has the right ownership boundary.
5. The predecessor returns or is interrupted only after the successor is established.

Prefer no-history forks. Quote the relevant completed decisions in the handoff
packet or point to a durable artifact instead of relying on inherited execution
history. A successor keeps the assigned scope and requested outcome.

## Reactivation Or Replacement

Use `followup_task` when a completed child remains the right owner and its
accumulated context reduces rediscovery. Native MultiAgentV2 preserves its
role, model, reasoning settings, and context. Spawn a fresh sibling only for
changed ownership, poisoned context, a genuinely independent second opinion,
or a materially new slice. Use the smallest useful positive fork plus the
packet so a necessary successor retains relevant knowledge without inheriting
an unbounded transcript.

## Root Handoff Limitation

MultiAgentV2 cannot promote a child into the top-level root or archive and
replace the root atomically. If the root itself needs renewal:

1. Produce an orchestrator packet containing the overall objective, live task
   tree, ownership, decisions, evidence, gates, and next action.
2. When the current task advertises an appropriate user- or app-level Desktop
   thread operation, start a new top-level Desktop task.
3. Give the replacement the packet and the relevant workspace.
4. Confirm continuity before retiring the old root.

When the needed Desktop operation is not advertised, report the packet path and
next action for manual handoff instead. Native task messaging applies only
inside one root tree and does not cross unrelated top-level tasks.
