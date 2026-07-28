# Compact Handoff Packet

Use a packet for long-context replacement, changed ownership, or manual transfer between unrelated root tasks. Do not create one for ordinary delegated work.

```md
## Objective
The remaining user-visible outcome.

## Ownership
Current task owners and exclusive boundaries.

## Established State
Completed changes, decisions, and decisive checks.

## Constraints
User decisions, architecture boundaries, safety limits, and relevant skills.

## Open Work
Unfinished items, dependencies, and real blockers.

## Next Action
The first concrete action the successor should take.

## Evidence
Relevant commands, results, and artifact paths.
```

Keep the packet under the task's `/tmp` workspace. Do not include secrets, raw transcripts, stable base instructions, or large command output.

For a same-root replacement, the root inspects the packet and spawns a fresh sibling with explicit role selection, exclusive ownership, and the smallest useful history fork.

For a cross-root transfer, use a task-local Desktop operation only when the current task advertises one. Otherwise report the packet path and next action for manual handoff. MultiAgentV2 messages do not cross root trees.

A packet preserves engineering state only. It does not prove role, model, reasoning-effort, or runtime continuity.
