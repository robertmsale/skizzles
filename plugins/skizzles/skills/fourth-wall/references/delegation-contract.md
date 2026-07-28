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

When Triage exists, also define its canonical task name, accepted report path, report revision, and the narrow conditions under which the recipient should reactivate it.

## Complete Slice Test

Prefer a handoff that gives one child the complete causal loop: inspect the owned surface, implement the change, run focused validation, correct in-scope failures, and collect relevant runtime proof. A code-only handoff is too narrow when it predictably leaves the root with the longer test, integration, or proof campaign.

Keep shared Git mutations and final acceptance at the root. When parallel edits prevent lock-heavy checks, defer those checks until the tree stabilizes, then dispatch one integration Worker, Review, or QA leaf with the complete serial command or piloting contract.

## Spawn Shape

Encode the role and objective in the task name; the fixed role carries capability:

```json
{
  "task_name": "worker__backend_contract",
  "fork_turns": "1",
  "agent_type": "worker",
  "message": "Own the bounded backend contract through implementation, focused validation, in-scope fixes, and compact evidence. Triage owner: triage__map_backend. Accepted report: /tmp/skizzles-orchestration/.../report.md ..."
}
```

Duty selects the fixed model/effort pair. Set the matching native `agent_type`, omit independent model and reasoning overrides, and repeat only assignment-specific constraints. Every child is a leaf; further decomposition returns to the root.

Include directly relevant skill names and obligations in the message. Skills available to the parent are not a substitute for telling the recipient which domain contract governs its work.

## Fan-Out Test

Spawn tasks in parallel only when all are true:

- Each owns a coherent responsibility boundary.
- Their write sets are disjoint or explicitly sequenced.
- Each can make meaningful progress without waiting for another spawned task.
- The root can continue useful cross-slice decisions, integration inspection, or planning without duplicating delegated execution.
- The expected speed or quality gain exceeds coordination cost.

Prefer dependency order over maximum concurrency. Contracts, schemas, and shared interfaces usually stabilize before broad implementation fan-out.

For a large, well-planned implementation, prefer 2-6 parallel Luna Workers with disjoint complete slices over one exhausted Worker or a Sol implementation substitute. The installed limit of 14 active children is a ceiling, not a target.

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

Completion releases active ownership but does not destroy the child. Use `followup_task` for reviewer-directed corrections or coherent next work by the same owner. Classify review findings: an explicit-contract miss is attributable rework, an adjacent existing defect is healing rather than failure, and a newly discovered invariant returns to Triage for clarification. Use a fresh task only for changed ownership, poisoned context, a genuinely independent second opinion, or a materially new slice.

When a durable `/tmp` report exists, pass its path rather than repeating stable cross-task context. The spawn message must still contain the role, concrete objective, ownership, constraints, Triage owner, report revision, and expected proof so the artifact supplements rather than hides the assignment. Do not put secrets, raw transcripts, or unbounded build logs in the packet.
