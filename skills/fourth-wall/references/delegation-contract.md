# Delegation Contract

Use this contract for consequential delegated work. Keep it concrete enough that the recipient can act without reconstructing the parent's reasoning.

## Before Spawning

Define:

1. **Outcome:** the observable state this task must produce.
2. **Ownership:** files, modules, services, or product surface this task owns.
3. **Dependencies:** inputs that must already exist and downstream tasks waiting on this result.
4. **Constraints:** user decisions, architecture boundaries, relevant skills, and forbidden scope changes.
5. **Evidence:** exact checks, artifacts, screenshots, or source inspection expected at completion.
6. **Return shape:** changed areas, validation performed, unresolved risks, and the next recommended action.

## Complete Slice Test

Prefer a handoff that gives one child the complete causal loop: inspect the owned surface, implement the change, run focused validation, correct in-scope failures, and collect relevant runtime proof. A code-only handoff is too narrow when it predictably leaves the root with the longer test, integration, or proof campaign.

Keep shared Git mutations and final acceptance at the root. When parallel edits prevent lock-heavy checks, defer those checks until the tree stabilizes, then dispatch one integration Worker, Review, or QA leaf with the complete serial command or piloting contract.

## Spawn Shape

Encode tier, role, and objective in the task name:

```json
{
  "task_name": "standard__worker__backend_contract",
  "fork_turns": "none",
  "model": "gpt-5.6-terra",
  "reasoning_effort": "high",
  "message": "Implement the bounded backend contract described below..."
}
```

The tier selects model and effort; the role selects behavior. In the message, name both and tell the child to read `$fourth-wall` plus the matching `resources/roles/*.md` file. Pass model overrides only when the active tool schema exposes them.

## Worker Grandchildren

A depth-1 `broad`, `standard`, `complex`, `specialized`, or `critical` Worker may dispatch at most one active Luna Worker when all of these hold:

- The child is named `mechanical__worker__...` or `scoped__worker__...`.
- The slice is small, disjoint from the parent's continuing edits, and comfortably short-context.
- The child owns inspection, implementation, focused validation, in-scope fixes, and completion evidence together.
- The parent has genuinely independent implementation to continue while the child works.
- The child uses `fork_turns = "none"`, remains a leaf, and is retired after delivery.

Do not create a command runner by another name. If the parent must interpret every result or modify the same surface before validation is meaningful, keep that loop with the parent. Non-Worker roles return delegation proposals to the root.

Include directly relevant skill names and obligations in the message. Skills available to the parent are not a substitute for telling the recipient which domain contract governs its work.

## Fan-Out Test

Spawn tasks in parallel only when all are true:

- Each owns a coherent responsibility boundary.
- Their write sets are disjoint or explicitly sequenced.
- Each can make meaningful progress without waiting for another spawned task.
- The root can continue useful cross-slice decisions, integration inspection, or planning without duplicating delegated execution.
- The expected speed or quality gain exceeds coordination cost.

Prefer dependency order over maximum concurrency. Contracts, schemas, and shared interfaces usually stabilize before broad implementation fan-out.

## Blockers

A valid blocker identifies one of:

- An unavailable external dependency or environment.
- Contradictory requirements.
- A safety boundary that forbids the required action.
- A product or architecture decision only the owner can make.

Task size, difficult code, uncertainty, failing tests, or the need for more investigation are not blockers by themselves.

## Completion Claim

Require the task to report:

- What changed and where.
- What behavior is now true.
- What validation ran and its result.
- What did not run and why.
- Remaining risks, decisions, or downstream work.

The root verifies this claim before integration or completion.

Completion retires the child. Corrections after completion go to a fresh task with a compact handoff, normally at the same tier for a narrow correction or one tier higher when the prior attempt exposed greater complexity.

When a durable `/tmp` task packet exists, pass its path rather than repeating stable cross-task context. The spawn message must still contain the child's tier, role, concrete objective, ownership, constraints, and expected proof so the packet supplements rather than hides the assignment. Do not put secrets, raw transcripts, or unbounded build logs in the packet.
