---
name: fourth-wall
description: Coordinate work through a bounded native Codex MultiAgentV2 team when independent ownership, risk, elapsed time, or evidence needs make coordination worthwhile. Use for evidence-first triage, parallel implementation slices, persistent specialist reuse, adversarial review, runtime QA, deployment, task messaging, long event-driven waits, goals, synchronization, and recovery. Keep routine or small work single-agent and do not use it for unrelated top-level Desktop tasks.
---

# Fourth Wall

Use native MultiAgentV2 as a fixed-role local engineering team when it adds
value. Choose coordination from the task shape: independent coherent slices,
material risk, long-running work, or evidence that one owner cannot collect as
well. A large repository or a difficult-looking task is not, by itself, a
reason to fan out. A small or tightly serial task can stay with one agent.

The root is the sole orchestrator. Every child is a leaf. All agents share one
local machine and workspace, but not conversation context. The root owns the
overall objective, decomposition, cross-slice decisions, Git integration,
evidence acceptance, and completion decision.

Global orchestration guidance stays flexible: the root chooses enough planning,
architecture, staging, and verification for the task's size and risk. A
prewritten plan is not a prerequisite for ordinary work. Create a proportionate
plan when it clarifies ownership or proof, and ask the owner only when a
material authority, scope, or likely-satisfaction decision is unclear. The
role-specific contracts below then enforce the stricter boundaries for Triage,
Workers, Review, QA, Designer, and Deployment.

## Fixed Roles

Select the native `agent_type` and omit separate model and reasoning overrides.
The installed role config durably carries this pair across completion,
eviction, and reactivation.

| `agent_type` | Model | Effort | Duty |
|---|---|---|---|
| `worker` | `gpt-5.6-luna` | xhigh | Complete implementation, focused validation, and repair ownership |
| `triage` | `gpt-5.6-terra` | medium | Evidence-first diagnosis, runtime reproduction, and execution-path mapping |
| `default` | `gpt-5.6-luna` | high | Cheap general-purpose bounded execution when no specialized role applies |
| `deployment` | `gpt-5.6-sol` | xhigh | Authorized consequential external or production operations |
| `review` | `gpt-5.6-sol` | high | Independent adversarial correctness and architectural acceptance |
| `designer` | `gpt-5.6-sol` | medium | Product and visual design judgment with implementation proof |
| `qa` | `gpt-5.6-terra` | medium | Long procedural runtime piloting and usability evidence |

There are no capability variants or model-escalation ladder. When
implementation becomes difficult, improve diagnosis, clarify the contract,
split independent ownership, or reactivate the relevant specialist. Do not
replace a Luna Worker with a Sol Worker. Sol is reserved for design, review,
deployment, and root judgment.

`deployment` means consequential mutation of external or production state.
Local builds, packaging, disposable development stacks, and ordinary
integration remain Worker, Triage, or QA work.

## Graph And Capacity

The installed aggressive profile permits at most 14 concurrent subagent
threads per root session. This is a ceiling, not a target.

- For a substantial decomposable campaign, 2-6 concurrent Luna Workers can
  help when each owns a complete disjoint slice and the expected speed or
  quality gain exceeds coordination cost. One Worker, or no delegation, is
  correct when it does not.
- Use up to two independent Terra Triage agents only when competing
  hypotheses or disjoint domains need independent evidence. A single Triage
  owner is enough for one causal path.
- Add a Designer, QA owner, Reviewer, or Deployment owner when that duty's
  judgment, runtime proof, or authorized operation is needed. Do not create
  role owners merely to fill a roster.
- Seven or more simultaneously active children requires an explicit root
  ownership map with unusually clear disjoint boundaries. Never fill slots
  speculatively.
- All children are leaves. Further decomposition proposals return to the root;
  grandchildren are forbidden.

Stay single-agent when coordination costs more than the work. Prefer one
complete ownership slice over command errands. The root must not retain
duplicate implementation and validation loops merely because delegation is
active.

## Dispatch Contract

Dispatch a child only when its ownership is coherent and the packet gives it
enough context to act without rediscovering the parent's reasoning. Name every
child `<role>__<objective>`, using single underscores inside the objective.
Examples: `triage__map_sync_failure`, `worker__implement_storage_contract`,
and `review__audit_auth_change`.

Use `fork_turns="none"` for self-contained packets and isolated slices.
Prefer a small positive integer such as `"1"` or `"2"` when recent root
decisions prevent rediscovery. Do not use `"all"`: full-history forks inherit
the parent role and bypass the child-specific role configuration. A positive
number larger than available history retains all available turns without
becoming full-history mode.

For a small delegated child, a compact packet naming the outcome, ownership,
relevant constraints, and proof can be enough. For consequential or multi-owner
work, include the full outcome, ownership and known neighbors, dependencies,
accepted decisions and invariants, constraints and skills, expected evidence,
and return shape. Also include the
relevant **peer map** and, when Triage exists, its canonical task name, accepted
report path, and revision. Do not repeat stable role instructions or paste a
shared report into every prompt; pass the artifact path and slice-specific
deltas.

Canonical task paths are callable peer identities, not ownership transfer.
Share only the paths needed for contact: Workers receive named Triage and
relevant neighboring Workers; Triage receives affected Workers; Review receives
Triage and every reviewed Worker; QA/Designer receive owners when clarification
or rework may be needed. Use `send_message` while a peer is active and
`followup_task` only to reactivate an appropriate persistent owner. Peer contact
never permits a child to spawn or change ownership.

For consequential or multi-owner dispatches, use a packet such as:

```md
## Peer map
- Triage: `/root/triage__map_checkout` (contact: narrow clarification; accepted report: `/tmp/.../report.md`, rev 2)
- Workers: `/root/worker__api`, `/root/worker__migration` (contact: relevant cross-slice clarification; neighboring ownership)
- Review: `/root/review__acceptance` (contact: evidence requests/findings after assignment; when assigned)
```

Read [references/delegation-contract.md](references/delegation-contract.md)
for the complete packet contract.

Use these assurance labels in claims and handoffs:

- **Worker completion claim** — unverified until root or Review accepts its evidence.
- **Accepted Triage evidence** — provisional causal authority after root checks plausibility and source support; implementation may falsify it.
- **Independent Reviewer verdict** — the highest independent-assurance recommendation; root still accepts or rejects completion.
- **Reduced-independence Reviewer verdict** — advisory when that Reviewer supplied midstream Triage adjudication; root uses a fresh Reviewer for consequential independent final acceptance.

Do not equate assurance with numeric model effort or treat Review as
infallible.

Aim for the requested correct outcome. An MVP, prototype, placeholder, or
partial result is a valid milestone only when the user explicitly approves it
as the intended scope; do not silently replace the requested result with one.
Use independent Review or other verification when risk warrants it to close the
gap between an implementation slice and correctness.

## Evidence-First Triage

Triage keeps product source and durable project configuration read-only, but it
is not runtime-read-only. Terra may build, run focused tests, start services,
operate disposable Container Labs, query databases or networks, inspect logs,
create temporary diagnostics or fixtures, and reproduce behavior when those
actions are safe and necessary to establish the causal chain. Triage cleans up
disposable resources and never turns an experiment into an unreviewed product
fix.

A small, local diagnosis can return a compact evidence note. For substantial,
multi-owner, high-risk, or long-lived work, give each Triage agent a new report
beneath:

```text
/tmp/skizzles-orchestration/<campaign-id-or-triage-uuid>/triage/<triage-task>/
├── report.md
└── evidence/
```

The root may provide a campaign identifier; otherwise Triage generates a UUID
and returns the resulting path. Use a collision-proof task directory, atomic
report writes, local-user permissions, and a revision/timestamp. `/tmp`
artifacts are campaign-scoped and may disappear after reboot or cleanup. Never
include credentials, private ambient data, raw transcripts, or unbounded logs.
Put large captures under `evidence/` and reference only the relevant fragment.

When a full report is warranted, `report.md` contains:

- Objective, environment, and exact reproduction.
- Verified facts with file, symbol, history, log, or runtime references.
- Confirmed causal chain, competing hypotheses, and rejected alternatives.
- Relevant architecture, invariants, source map, and known unknowns.
- Proposed disjoint implementation slices and dependency order.
- Exact baseline, build, test, migration, and runtime commands with working directories and prerequisites.
- Expected output, exit state, duration, quiet phases, benign warnings, and failure interpretation.
- Focused and broader validation success paths.
- Confidence, unresolved owner decisions, revision, and authoring task.

The root verifies plausibility and source support before accepting a report or
releasing implementation. When certainty remains materially low, dispatch a
second independent Triage agent and compare reports without anchoring one on
the other.

## Parallel Luna Implementation

When enough architecture, interfaces, and execution-path planning are stable
for the task at hand, and independent ownership makes coordination worthwhile,
decompose implementation into complete slices. Parallelize only when:

- Each Worker has a coherent end-to-end responsibility.
- Write sets and causal ownership are disjoint or explicitly sequenced.
- Interfaces and integration contracts are settled.
- Each slice can progress and run focused checks independently.
- The speed or quality gain exceeds coordination cost.

Do not parallelize unresolved architecture, overlapping files, tightly serial
dependencies, or tiny fragments that leave the root performing all integration
work.

Each Worker owns inspect-edit-format-analyze-build-test-fix-report for its
slice. When Triage exists, it reads the accepted report before editing and
confirms the documented baseline or preflight when one exists. If the command,
environment, or observed failure differs materially, it must not patch product
code to compensate for a malformed workflow.

When a Triage owner exists, the assignment names it. When blocked after
ordinary implementation attempts, the Worker contacts that persistent Triage
agent with:

- Slice and exact command.
- Expected and observed result.
- Attempts already made and evidence path.
- One narrow clarification question.

Use `send_message` for a running owner and `followup_task` to reactivate an
idle or completed owner. Triage answers from existing evidence or performs a
bounded new diagnostic, atomically updates the shared report when assumptions
change, and sends the requesting Worker the corrected guidance and revision
path. The Worker retains implementation ownership and continues; Triage does
not take over its edits.

If implementation evidence falsifies the accepted diagnosis, stop forcing the
proposed solution and return the contradiction for renewed Triage. Material
RCA changes update the report and go to the root; narrow environment or
command clarifications may remain peer-to-peer.

Review may ask a named Worker for one concrete existing artifact or one bounded
missing runtime observation when the Worker still owns the relevant Lab or
slice. The Worker runs it in that ownership boundary and returns the command,
result, and artifact path; Review evaluates it without taking Lab ownership or
editing implementation. Root coordinates any repair assignment.

Triage may request Review adjudication only through the root and only after two
bounded diagnostic passes (or equivalent contradictory evidence) leave a
high-consequence architectural, security, migration, concurrency, or
repeating-causal-model impasse. The packet must include competing
explanations, supporting/rejecting evidence, Worker attempts, why another
Triage pass is unlikely to resolve it, and one narrow decision request. Review
supplies adjudication, never Sol implementation. Each use is counted and
flagged as a red-flag KPI; slow builds, difficult tests, or incomplete
implementation are not sufficient.

## Persistent Ownership And Review

Task completion releases active execution, not identity or accumulated context.

- Send corrections to a running owner with `send_message`.
- Reactivate the existing Worker for reviewer-directed repairs or coherent
  follow-on work, the same Triage owner for clarification or renewed evidence,
  and the same Reviewer for re-review of that slice or campaign.
- Spawn a fresh sibling only for changed ownership, poisoned context, a genuinely independent second opinion, or a materially new slice.

Before spawning, inspect existing task paths for the same role and ownership.
One durable owner per slice is the default. Rework is not a reason to discard
context. If two repair cycles fail, revisit diagnosis, decomposition, or the
execution contract rather than manufacturing another Worker.

Review treats both the Triage report and implementation as fallible. Sol
compares the causal model with source and runtime evidence, checks the touched
and adjacent surfaces, judges architecture, correctness, security, migration
completeness, and evidence sufficiency, and hunts deeper explanations. It does
not routinely repeat formatting, compilation, static analysis, or tests already
run successfully by the Worker. Run a targeted probe only for a concrete
suspicion, contradictory proof, high-consequence boundary, or integrated-state
drift.

## QA, Design, And Deployment

- Designer owns product and visual judgment, coherent UI implementation, accessibility, responsive states, and visual proof.
- QA owns the real application, runtime processes, user-flow piloting, screenshots, logs, platform evidence, and usability reporting. QA does not silently repair code.
- Deployment owns only explicitly authorized consequential operations. Verify target, procedure, rollback, observability, and authorization; stop safely when preconditions differ.

Use these roles when their evidence or authority is needed, not as mandatory
stages for ordinary work.

## Event-Driven Coordination

Do not spend turns polling agents or commands. `wait_agent` is event-driven:
its timeout is an upper bound and it wakes when mailbox activity or user
steering arrives. Match the timeout to the expected work horizon; one 5-15
minute wait is often useful for implementation, builds, or QA, while a shorter
wait suits a quick handoff. If it times out, inspect once and issue another
wait only when waiting remains the next useful action.

Children send intermediate messages only for material blockers, ownership
collisions, falsified assumptions, or decisions. Routine commentary can wake
the root and recreate polling cost. The child that owns a long-running command
also owns its native session polling and reports compact state, error
signatures, and artifact paths.

Read [references/coordination-loop.md](references/coordination-loop.md) when a
multi-owner task needs the exact live-tree, approval, dependency,
synchronization, or recovery semantics; a single-agent task does not need this
reference.

## Workflow

For a substantial or consequential multi-owner campaign, use this lifecycle;
skip stages that do not apply. A bounded single-agent task needs only its
outcome, ownership, relevant checks, and truthful evidence. If a material gap
in authority, scope, or likely satisfaction remains, ask or stop rather than
inventing work.

1. Preserve the full requested outcome and acceptance evidence; use `/goal` when the work spans multiple turns.
2. Dispatch Triage when causal understanding, repository mapping, or the verification path is uncertain and the evidence will repay the coordination cost.
3. Verify the report, settle shared contracts, and define dependency-ordered ownership slices.
4. Dispatch persistent Luna Workers in parallel where ownership is clear; keep uncertain or overlapping work serial.
5. Route concrete Worker questions to the existing Triage owner and propagate only material cross-slice changes through the root.
6. After parallel edits stabilize, give one Worker the integrated build/test/fix lane when necessary. The root retains Git mutations and acceptance.
7. Inspect completion claims and evidence. Dispatch persistent Review or QA when risk warrants it; return findings to the same owner.
8. Commit stable forward progress after a coherent slice has focused proof and no known breakage, excluding unrelated shared-worktree changes.
9. Finish aggregate validation and make the explicit decision when possible; record the campaign terminal disposition as `accepted`, `rejected`, `blocked`, or `abandoned`.
10. Once the campaign reaches any terminal disposition, finalize the bounded campaign-close learning packet described in [references/learning-loop.md](references/learning-loop.md) for every substantial campaign, even when KPIs are zero or not observed. Separate repository friction, which belongs in the task-owner completion handoff, from harness candidates; forward only to an explicitly configured consumer. Learning packets are evidence only: never automatically change policy, roles, routing, hooks, tasks, configuration, or installs.

Read [references/handoff-packet.md](references/handoff-packet.md) before
replacing ownership or renewing long context.

## Native Primitives

- `spawn_agent`: root-only creation of a bounded leaf using the fixed native `agent_type`.
- `list_agents`: inspect paths, status, and current ownership at meaningful coordination points.
- `send_message`: queue context or correction without starting an idle task.
- `followup_task`: reactivate an idle or completed persistent owner with its role, model, effort, and accumulated context.
- `wait_agent`: event-driven mailbox wait with a bounded timeout.
- `interrupt_agent`: stop obsolete or unsafe work without destroying task identity.

## Hard Boundaries

- All subagents are leaves. Only the root spawns.
- Do not assign overlapping implementation ownership without explicit sequencing.
- Do not accept completion prose as proof.
- Do not route ordinary implementation to Sol or invent unconfigured role variants.
- Do not treat repository size, difficult code, failing tests, or more investigation as blockers.
- Do not let learning observations self-modify the harness. Reporting is automatic; policy promotion requires explicit owner deliberation.
- The root owns Git integration, task-graph shape, cross-slice decisions, evidence acceptance, and final completion.
- Native task messaging stays within one root tree. Unrelated top-level Desktop tasks require app-level coordination.
