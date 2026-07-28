# Delegation Contract

Delegate a complete engineering outcome, not a command.

## Assignment fields

- **Outcome:** observable behavior or state the child must establish.
- **Ownership:** exclusive files, modules, services, or product surface.
- **Dependencies:** stable inputs and downstream consumers.
- **Constraints:** user decisions, architecture, applicable skills, and forbidden scope.
- **Checks:** focused source, test, build, or runtime proof expected.
- **Return:** changed paths, behavior, checks, diagnostics, untested work, and risk.

Include only context the child cannot cheaply inspect. Name every child `<role>__<objective>` and state that it is a leaf.

## Spawn shape

```json
{
  "task_name": "worker__backend_contract",
  "fork_turns": "1",
  "agent_type": "worker",
  "message": "Own the backend contract through implementation and focused validation. Ownership: packages/backend/**. Preserve the public API and do not edit generated output. Return changed paths, checks, diagnostics, and remaining risk. You are a leaf; do not spawn subagents."
}
```

When generated roles are advertised, use `agent_type` and omit separate model or reasoning overrides. When they are unavailable, do not invent model or effort substitutes for those roles. Use the active spawn schema only when the task does not depend on configured Skizzles routing; otherwise report the missing configured-role surface.

Do not use `fork_turns="all"` with a selected role. Use `"none"` or a bounded positive count.

## Fan-out test

Parallelize only when:

- ownership is disjoint or explicitly sequenced;
- every child can progress without waiting for an unstable interface;
- each child owns implementation or investigation through focused proof;
- the speed or quality gain exceeds coordination cost.

The root retains shared-interface decisions, Git integration, and acceptance.

## Valid blockers

A blocker requires an unavailable dependency, contradictory requirement, missing authority, forbidden safety boundary, or unresolved owner decision. Difficulty, uncertainty, failing checks, and slow tools require investigation or repair, not a blocker label.
