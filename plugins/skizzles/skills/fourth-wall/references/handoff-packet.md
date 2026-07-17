# Context Renewal And Warm Handoff

Use handoff when accumulated context is harming speed or clarity, when ownership changes, or when an agent can no longer continue reliably. Do not hand off merely to avoid summarizing ordinary progress.

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

## Routing State
The task family, current proven floor, evidence trigger, clean-success count,
probation state, and last independently accepted route.
```

Do not include motivational framing, a chronological transcript, stable base instructions, or facts the successor can cheaply inspect.

For a long root task, store this packet under `/tmp` and pass its path to fresh children together with a compact slice-specific assignment. Update it at ownership transfers, material routing changes, and acceptance checkpoints. Do not automate encrypted spawn-message rewriting or continuously append command output; hooks should enforce observable routing and graph safety only.

## Worker Or Specialist Handoff

Use a parent-mediated sibling replacement so the root preserves the task graph and role boundary:

1. The outgoing task sends the packet to the root with `send_message` and stops taking new ownership.
2. The root inspects the packet and current tree.
3. The root spawns a fresh sibling named `<tier>__<role>__<objective>`, names the behavioral role resource in its handoff, and normally uses `fork_turns = "none"`.
4. The root confirms the successor exists and has the right ownership boundary.
5. The predecessor returns or is interrupted only after the successor is established.

Prefer no-history forks. Quote the relevant completed decisions in the handoff packet or point to a durable artifact instead of relying on inherited execution history.

## Replacement, Not Reactivation

Treat a completed child as terminal. Reusing an unloaded task can replace its original model and reasoning settings with the caller's settings. Preserve useful context in the packet and spawn a fresh sibling at the same tier, or one tier higher when the earlier attempt exposed greater complexity.

## Root Handoff Limitation

MultiAgentV2 cannot promote a child into the top-level root or archive and replace the root atomically. If the root itself needs renewal:

1. Produce an orchestrator packet containing the overall objective, live task tree, ownership, decisions, evidence, gates, and next action.
2. Start a new top-level Desktop task through a user- or app-level thread operation.
3. Give the replacement the packet and the relevant workspace.
4. Confirm continuity before retiring the old root.

Native task messaging applies only inside one root tree. Crossing between unrelated top-level tasks requires app-level thread coordination, not MultiAgentV2 task tools.
