# Delegation Contract

Use this contract when a child will own work. Use the complete form for
consequential or multi-owner work; a small, self-contained task can stay
single-agent or use a compact packet with only the facts needed to act. The
purpose is a clear ownership and evidence boundary, not a mandatory ceremony.

## Choose Delegation

Delegate when an independent, coherent slice can progress without waiting and
the expected speed, quality, risk reduction, or evidence gain exceeds the
coordination cost. Keep tightly serial work, unresolved architecture, and tiny
fragments with one owner. The root can create or refine a proportionate plan;
it need not wait for a prewritten plan. A material gap in authority, scope, or
likely satisfaction is a reason to ask or stop, not to invent a larger task.

## Assignment Packet

For a small delegated task, a compact packet can name the outcome, ownership,
relevant constraints, and proof. For consequential or multi-owner work, include
all six fields so the child can complete its causal loop without reconstructing
the parent's reasoning:

1. **Outcome:** the observable state this task must produce.
2. **Ownership:** files, modules, services, or product surface this task owns,
   including known neighboring owners.
3. **Dependencies:** inputs that must already exist and downstream tasks that
   wait on this result.
4. **Constraints:** accepted user/owner decisions, invariants, architecture
   boundaries, relevant skills, and forbidden scope changes.
5. **Evidence:** exact checks, artifacts, screenshots, or source inspection
   expected at completion.
6. **Return shape:** changed areas, validation performed, unresolved risks, and
   the next recommended action.

When Triage exists, name its canonical task path, accepted report path, report
revision, and the narrow conditions under which the child should reactivate it.
For consequential or multi-owner work, include a **peer map** with only the
canonical paths and ownership/contact conditions that matter:

```md
## Peer map
- Triage: `/root/triage__map_checkout` (contact: narrow clarification; accepted report: `/tmp/.../report.md`, rev 2)
- Workers: `/root/worker__api`, `/root/worker__migration` (contact: relevant cross-slice clarification; neighboring ownership)
- Review: `/root/review__acceptance` (contact: evidence requests/findings after assignment; when assigned)
```

Paths are callable peer identities, not ownership transfer, and child contact
never authorizes spawning. Workers receive Triage and relevant neighboring
Workers; Triage receives affected Workers; Review receives Triage and reviewed
Workers; QA/Designer receive owners when clarification or rework may need them.

Use the assurance labels in the main Fourth Wall policy. A Worker completion
claim is unverified, accepted Triage evidence is provisional, and an independent
Reviewer verdict is advisory to root acceptance. A Reviewer that supplied
midstream Triage adjudication must mark later verdicts
**reduced-independence/advisory**; root uses a fresh Reviewer when consequential
independent acceptance is required. Do not infer assurance from numeric model
effort.

## Complete Slice Test

Prefer a handoff that gives one child the complete causal loop: inspect the
owned surface, implement the change, run focused validation, correct in-scope
failures, and collect relevant runtime proof. A code-only handoff is too narrow
when it predictably leaves the root with the longer test, integration, or proof
campaign.

Keep shared Git mutations and final acceptance at the root. When parallel edits
prevent lock-heavy checks, defer those checks until the tree stabilizes, then
dispatch one integration Worker, Review, or QA leaf with the complete serial
command or piloting contract.

## Spawn Shape

Encode the role and objective in the task name; the fixed role carries
capability:

```json
{
  "task_name": "worker__backend_contract",
  "fork_turns": "1",
  "agent_type": "worker",
  "message": "Own the bounded backend contract through implementation, focused validation, in-scope fixes, and compact evidence. Triage owner: triage__map_backend. Accepted report: /tmp/skizzles-orchestration/.../report.md ..."
}
```

Duty selects the fixed model/effort pair. Set the matching native
`agent_type`, omit independent model and reasoning overrides, and repeat only
assignment-specific constraints. Include directly relevant skill names and
obligations in the message; skills available to the parent are not a substitute
for telling the recipient which domain contract governs its work. Every child
is a leaf; further decomposition returns to the root.

## Fan-Out Test

Run these checks before parallel fan-out. All should be true:

- Each child owns a coherent responsibility boundary.
- Write sets and causal ownership are disjoint or explicitly sequenced.
- Each child can make meaningful progress without waiting for another spawned
  task.
- The root can continue useful cross-slice decisions, integration inspection,
  or planning without duplicating delegated execution.
- The expected speed or quality gain exceeds coordination cost.

Prefer dependency order over maximum concurrency. For a large, well-planned
implementation, 2-6 parallel Luna Workers may be useful when those checks hold;
the installed limit of 14 active children is a ceiling, not a target. A single
Worker is preferable when additional owners would only add coordination.

## Blockers

A valid blocker identifies one of:

- An unavailable external dependency or environment.
- Contradictory requirements.
- A safety boundary that forbids the required action.
- A product or architecture decision only the owner can make.

Task size, difficult code, uncertainty, failing tests, or the need for more
investigation are not blockers by themselves.

## Completion Claim

Require a delegated task to report:

- What changed and where.
- What behavior is now true.
- What validation ran and its result.
- What did not run and why.
- Remaining risks, decisions, or downstream work.

After aggregate validation and an explicit decision when possible, root records
the campaign terminal disposition (`accepted`, `rejected`, `blocked`, or
`abandoned`) and finalizes a bounded learning packet at
`/tmp/skizzles-orchestration/<campaign-id>/learning/campaign-close.md` on every
terminal path for every substantial campaign, with the KPI schema and
denominators in [learning-loop.md](learning-loop.md), even when values are zero
or not observed. Separate repository friction from harness candidates.
Forwarding is optional and explicit; observations never auto-mutate harness
policy, roles, routing, hooks, tasks, configuration, or installs.

The root verifies the claim before integration or completion. Completion
releases active ownership but does not destroy the child. Use `followup_task`
for reviewer-directed corrections or coherent next work by the same owner.
Classify review findings: an explicit-contract miss is attributable rework, an
adjacent existing defect is healing rather than failure, and a newly discovered
invariant returns to Triage for clarification. Use a fresh task only for
changed ownership, poisoned context, a genuinely independent second opinion,
or a materially new slice.

When a durable `/tmp` report exists, pass its path rather than repeating stable
cross-task context. The spawn message still contains the role, concrete
objective, ownership, constraints, Triage owner, report revision, and expected
proof so the artifact supplements rather than hides the assignment. Do not put
secrets, raw transcripts, or unbounded build logs in the packet.
