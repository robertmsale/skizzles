---
name: completion-contract
description: Convert user intent, approved plans, and subagent handoffs into explicit completion contracts. Use when Codex is planning implementation, spawning subagents, setting or refining a /goal, defining acceptance criteria, avoiding scope shrink, deciding fan-out boundaries, or reviewing whether a claimed result satisfies the requested outcome.
---

# Completion Contract

Use this skill to turn a task into a concrete completion contract. A completion contract is not a plan, estimate, suggestion list, or escape hatch. It is the smallest explicit statement of what must be true before the work can be called done.

## Authority Order

Preserve this order:

1. Permanent user or repo instructions.
2. Explicit user non-negotiables.
3. User-approved plan.
4. Task-specific outcome.
5. Agent implementation preference.

Do not let a worker plan, convenience path, or smaller first slice weaken a higher-authority item.

## Contract Draft

Before delegating or claiming completion, normalize the task:

```text
Outcome:
Approved implementation path:
Non-negotiable constraints:
Disallowed alternatives:
Legacy/removal expectations:
Regression expectations:
Evidence expected:
Known valid blockers:
Unknowns requiring clarification:
```

If an unknown would materially change the contract, ask the user or parent orchestrator instead of silently narrowing scope.

## Fan-Out

Split large work before execution, not by letting a worker shrink scope during execution.

Good boundaries:

- API/contracts
- storage or persistence
- backend implementation
- frontend integration
- design polish
- QA validation
- deployment/infrastructure

Bad boundaries:

- first slice
- make a start
- easiest part
- best effort
- docs-only substitute

Each delegated package must cover the full responsibility for its boundary and map back to the top-level outcome.

## Requirements

Write one main obligation per requirement. Prefer obligations that are observable and hard to fake:

- implement
- remove
- replace
- wire
- preserve
- prove
- validate
- update
- delete
- migrate
- enforce
- route
- render
- persist
- reject
- fail

Avoid soft wording:

```text
if possible
where possible
try to
attempt to
best effort
if too large
if time allows
fallback
temporary
for now
MVP
first slice
partial
stub
mock
document a workaround
leave the old path
keep both paths
manual step
remove or hard-disable
compatibility entrypoint
tombstone
legacy wrapper
```

Rewrite soft language into exact final-state obligations.

## Valid Blockers

Accept blockers only when they are concrete and external:

- missing permissions
- unavailable external services
- missing required secrets
- inaccessible required files
- contradictory instructions
- unsafe work
- explicit missing user decision

Do not accept task size, difficulty, uncertainty, refactor effort, stale failing tests, or lack of a convenient path as blockers.

## Clobber Audit

Before execution or final acceptance, ask:

- Did the contract preserve the user-approved outcome?
- Did it shrink scope into a partial job?
- Did it add fallback or compatibility paths the user did not ask for?
- Did it preserve legacy names, wrappers, disabled entrypoints, or tombstones?
- Did it require evidence that can actually be inspected?
- Did it allow fake UI, fake data, disabled checks, skipped tests, or manual workarounds?
- Did it ignore relevant skills, repo instructions, or role constraints?

Final responses should include the concrete evidence used: changed files, tests or commands, screenshots, source inspection, artifacts, or exact blockers.

## Forward-Progress Checkpoints

Treat commits as validated repository checkpoints, independent of `/goal` lifecycle. A goal tracks the overall outcome; a commit records one coherent causal state. Do not require or create a goal merely to obtain commit boundaries.

Commit when a coherent ownership slice is integrated, its focused proof passes, and no known breakage remains in that slice. Prefer a checkpoint before switching causal surfaces, beginning a risky refactor, transferring substantial ownership, or starting independent QA or Review. Keep unrelated slices separate and write commit messages in terms of the behavioral outcome.

Do not commit every child completion automatically. The root first inspects shared-worktree ownership, integrates the slice, excludes unrelated user or agent changes, and verifies the evidence. Do not checkpoint a known-broken intermediate state merely to reduce diff size. Preserve reviewer corrections as later commits when practical so accepted history remains inspectable. Before final acceptance, validate the aggregate commit series and working tree, not only the newest checkpoint.
