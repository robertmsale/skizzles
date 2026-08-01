---
name: fourth-wall
description: Coordinate substantial work through a bounded native Codex MultiAgentV2 team. Read before the first subagent spawn or orchestration action. Use for evidence-first triage, parallel implementation slices, persistent specialist reuse, adversarial review, runtime QA, deployment, task messaging, long event-driven waits, goals, synchronization, and recovery. Do not use for routine single-agent work or unrelated top-level Desktop tasks.
---

# Fourth Wall

Use native MultiAgentV2 as a fixed-role local engineering team. Role names describe duty: Triage establishes evidence and the execution path, Workers implement well-specified slices, and Review supplies adversarial judgment while Deployment handles authorized consequential operations. The canonical `assets/agent-role-spec.json` and its generated installed role catalog are the sole authority for model and reasoning-effort binding; this behavioral guidance never selects, ranks, or overrides those values. Improve the contract, decompose the work, and let multiple persistent Workers cooperate with the Triage owner.

The root is the sole orchestrator. Every child is a leaf. All agents share one local machine and workspace, but not conversation context.

## Fixed Roles

Select the native `agent_type` that matches the duty and omit model or reasoning overrides. The canonical role spec and generated installed catalog durably carry that binding across completion, eviction, and reactivation.

| Role | `agent_type` | Duty |
|---|---|---|
| Worker | `worker` | Complete implementation, focused validation, and repair ownership |
| Triage | `triage` | Evidence-first diagnosis, runtime reproduction, and execution-path mapping |
| Default | `default` | General-purpose bounded execution when no specialized role applies |
| Deployment | `deployment` | Authorized consequential external or production operations |
| Review | `review` | Independent adversarial correctness and architectural acceptance |
| Designer | `designer` | Product and visual design judgment with implementation proof |
| QA | `qa` | Runtime piloting and evidence-rich product verification |

When implementation becomes difficult, improve diagnosis, clarify the contract, split independent ownership, or reactivate the relevant specialist. Do not invent role variants or override the generated role binding. Role names remain stable even when the installed catalog changes its underlying configuration.

`deployment` means consequential mutation of external or production state. Local builds, packaging, disposable development stacks, and ordinary integration remain Worker, Triage, or QA work.

## Graph And Capacity

The installed aggressive profile permits at most 14 concurrent subagent threads per root session. This is breathing room, not a target.

- Normally use 2-6 concurrent Workers for a substantial decomposable campaign.
- Use up to two independent Triage agents when competing hypotheses or disjoint domains benefit from independent evidence.
- Normally retain one persistent Designer, QA owner, Reviewer per slice or campaign, and Deployment owner.
- Seven or more simultaneously active children requires unusually clear disjoint ownership. Do not fill available slots speculatively.
- All children are leaves. Further decomposition proposals return to the root; grandchildren are forbidden.

Stay single-agent when coordination costs more than the work. Prefer one complete ownership slice over command errands. The root keeps the overall objective, decomposition, cross-slice decisions, Git integration, evidence acceptance, and completion decision; it must not retain duplicate implementation and validation loops merely because delegation is active.

## Dispatch Contract

Name every child `<role>__<objective>`, using single underscores inside the objective. Examples: `triage__map_sync_failure`, `worker__implement_storage_contract`, and `review__audit_auth_change`.

Use a small positive integer for `fork_turns`, such as `"1"` or `"2"`, choosing the smallest useful value when recent root decisions prevent rediscovery. Do not use `"none"` or `"all"`: context-free forks discard the bounded handoff context, while full-history forks inherit the parent role and bypass the child-specific role configuration. A positive number larger than available history retains all available turns without becoming full-history mode.

Every assignment states:

1. Observable outcome.
2. Exact ownership boundary and known neighboring owners.
3. Accepted decisions, invariants, constraints, and relevant skills.
4. Triage owner and shared evidence-report path when applicable.
5. Expected implementation, validation, runtime proof, and return shape.

Do not repeat stable role instructions or paste a shared report into every prompt. Pass the artifact path plus slice-specific deltas.

For consequential or multi-owner work, add a relevant **peer map** to the dispatch packet:

```md
## Peer map
- Triage: `/root/triage__map_checkout` (contact: narrow clarification; accepted report: `/tmp/.../report.md`, rev 2)
- Workers: `/root/worker__api`, `/root/worker__migration` (contact: relevant cross-slice clarification; neighboring ownership)
- Review: `/root/review__acceptance` (contact: evidence requests/findings after assignment; when assigned)
- Container Lab: `lab-123`, state/workspace `/tmp/.../labs/lab-123` (owner: `/root/worker__api`; contact: runtime evidence only)
- Worktree/branch: `/path/to/worktree` on `feature/api` (owner: `/root/worker__api`)
- Critical evidence: `/tmp/.../response.json` (owner: `/root/worker__api`; contact: bounded artifact request)
```

When a peer owns a resource relevant to the slice, record its stable identifier and locator plus the exact owner task path. Include Container Lab identifiers and state/workspace paths, and include the owned worktree/branch or critical evidence artifact when applicable. Resource custody is explicit routing metadata: requests for evidence or runtime observations go to the current resource owner, never to an unowned/shared-control channel. A request does not transfer custody, grant shared control, or authorize edits. Review may ask the exact owner for one bounded existing artifact or one missing observation; the root coordinates any repair or ownership change.

Canonical task paths are callable peer identities, not ownership transfer. Share only the paths needed for contact: Workers receive named Triage and relevant neighboring Workers; Triage receives affected Workers; Review receives Triage, every reviewed Worker, and the owner of each requested resource; QA/Designer receive owners when clarification or rework may be needed. Use `send_message` while a peer is active and `followup_task` only to reactivate an appropriate persistent owner. Peer contact never permits a child to spawn or change ownership.

Use these assurance labels in claims and handoffs:

- **Worker completion claim** — unverified until root or Review accepts its evidence.
- **Accepted Triage evidence** — provisional causal authority after root verifies plausibility and source support; implementation may falsify it.
- **Independent Reviewer verdict** — the highest independent-assurance recommendation; root still accepts or rejects completion.
- **Reduced-independence Reviewer verdict** — an advisory recommendation when that Reviewer supplied midstream Triage adjudication; root uses a fresh Reviewer for consequential independent final acceptance.

Do not equate assurance with role metadata or configured effort, and do not treat Review as infallible.

## Evidence-First Triage

Triage keeps product source and durable project configuration read-only, but it is not runtime-read-only. Triage may build, run focused tests, start services, operate disposable Container Labs, query databases or networks, inspect logs, create temporary diagnostics or fixtures, and reproduce behavior when those actions are safe and necessary to establish the causal chain. Triage cleans up disposable resources and never turns an experiment into an unreviewed product fix.

For substantial work, each Triage agent writes a new report beneath:

```text
/tmp/skizzles-orchestration/<campaign-id-or-triage-uuid>/triage/<triage-task>/
├── report.md
└── evidence/
```

The root may provide a campaign identifier; otherwise Triage generates a UUID and returns the resulting path. Use a collision-proof task directory, atomic report writes, local-user permissions, and a revision/timestamp. `/tmp` artifacts are campaign-scoped and may disappear after reboot or cleanup. Never include credentials, private ambient data, raw transcripts, or unbounded logs. Put large captures under `evidence/` and reference only the relevant fragment.

`report.md` contains:

- Objective, environment, and exact reproduction.
- Verified facts with file, symbol, history, log, or runtime references.
- Confirmed causal chain, competing hypotheses, and rejected alternatives.
- Relevant architecture, invariants, source map, and known unknowns.
- Proposed disjoint implementation slices and dependency order.
- Exact baseline, build, test, migration, and runtime commands with working directories and prerequisites.
- Expected output, exit state, duration, quiet phases, benign warnings, and failure interpretation.
- Focused and broader validation success paths.
- Confidence, unresolved owner decisions, revision, and authoring task.

The root verifies plausibility and source support before accepting the report or releasing implementation. When certainty remains materially low, dispatch a second independent Triage agent and compare reports without anchoring one on the other.

## Parallel Worker Implementation

After architecture, interfaces, and the execution path are sufficiently stable, decompose substantial implementation into independent ownership slices and dispatch multiple Workers concurrently. Parallelize only when:

- Each Worker has a coherent end-to-end responsibility.
- Write sets and causal ownership are disjoint or explicitly sequenced.
- Interfaces and integration contracts are settled.
- Each slice can progress and run focused checks independently.
- The speed or quality gain exceeds coordination cost.

Do not parallelize unresolved architecture, overlapping files, tightly serial dependencies, or tiny fragments that leave the root performing all integration work.

Each Worker owns inspect-edit-format-analyze-build-test-fix-report for its slice. When Triage exists, it reads the accepted report before editing and confirms the documented baseline or preflight when one exists. If the command, environment, or observed failure differs materially, it must not patch product code to compensate for a malformed workflow.

When a Triage owner exists, the assignment names it. When blocked after ordinary implementation attempts, the Worker contacts that persistent Triage agent with:

- Slice and exact command.
- Expected and observed result.
- Attempts already made and evidence path.
- One narrow clarification question.

Use `send_message` for a running owner and `followup_task` to reactivate an idle or completed owner. Triage answers from existing evidence or performs a bounded new diagnostic, atomically updates the shared report when assumptions change, and sends the requesting Worker the corrected guidance and revision path. The Worker retains implementation ownership and continues; Triage does not take over its edits.

If implementation evidence falsifies the accepted diagnosis, stop forcing the proposed solution and return the contradiction for renewed Triage. Material RCA changes update the report and go to the root; narrow environment or command clarifications may remain peer-to-peer.

Review may ask a named Worker for one concrete existing artifact or one bounded missing runtime observation when the Worker still owns the relevant Lab or slice. The Worker runs it in that ownership boundary and returns the command, result, and artifact path; Review evaluates it without taking Lab ownership or editing implementation. Root coordinates any repair assignment.

Triage may request Review adjudication only through the root and only after two bounded diagnostic passes (or equivalent contradictory evidence) leave a high-consequence architectural, security, migration, concurrency, or repeating-causal-model impasse. The packet must include competing explanations, supporting/rejecting evidence, Worker attempts, why another Triage pass is unlikely to resolve it, and one narrow decision request. Review supplies adjudication, never implementation. Each use is counted and flagged as a red-flag KPI; slow builds, difficult tests, or incomplete implementation are not sufficient.

## Failed Proof Is A Repair Input

A failed local build, test, Container Lab run, or QA proof is evidence to preserve and classify, not a reason to terminate a substantial goal or campaign. Record a bounded command result and artifact path, then keep the existing Worker/Triage repair loop active when branch or base code, an owned fixture/config/migration, or an in-scope runtime contract plausibly caused the failure. Unknown cause means diagnosis is still pending; it is not a terminal blocker. Route the evidence to the owning Worker or persistent Triage owner, repair in scope, and rerun fresh proof.

Reserve `blocked` for an unavailable external dependency, service, or permission; contradictory requirements or an owner-only decision; or a safety boundary that prevents further authorized progress. Do not infer an external blocker merely from a failed local proof, and do not add automatic recovery in place of explicit ownership routing.

## Stable Review Checkpoints

The default review topology is one shared worktree. Do not create extra branches or temporary worktrees, or require per-Worker commits, merely to make review possible. Review is a checkpoint against an immutable candidate, not an acceptance verdict on a moving worktree.

The shared worktree need not be globally clean: unrelated user or agent changes may remain. The root must disclose them and keep any relevant, overlapping, or unreviewed source delta out of the candidate target.

At a coherent integration boundary:

1. **Quiesce parallel writers.** The root waits for relevant Workers to finish their current turns and stops parallel source edits. If integration repair is needed, the root activates exactly one serial integration owner; all other source writers remain quiescent while that owner edits. When it finishes, the root quiesces reviewed surfaces again before validation.
2. **Validate the re-quiesced candidate.** The root inspects the aggregate diff and ownership boundaries, resolves any remaining integration issue, and runs focused aggregate validation. Exclude unrelated shared-worktree changes from the candidate commit and disclose them; do not checkpoint known breakage or relevant unreviewed deltas.
3. **Commit and freeze.** The root creates one coherent stable-candidate commit. This commit is the Review/QA target; the root retains Git integration and acceptance. No edits to reviewed surfaces land through Review/QA.
4. Review/QA receives an immutable packet with the exact base and target SHAs, the primary committed diff, current Git status and uncommitted-delta summary, reviewed-source quiescence, the included Worker map, and the validation/evidence paths:

   ```md
   ## Review target
   - Original base: <sha>
   - Candidate target: <sha>
   - Primary diff: <base>..<target>
   - Accepted integration base: <ref@sha at candidate freeze; current ref@sha at final preflight>
   - Candidate merge-base: <sha computed against current accepted base; PR merge-base when a PR exists>
   - Base/merge-base preflight: <base/target ahead-behind counts; path-interaction classification and bounded evidence; whether base moved since freeze>
   - Git status: <clean/dirty and exact status or bounded summary>
   - Uncommitted deltas: <paths, owners, and whether any can affect the target>
   - Reviewed source writers: quiescent
   - Included Workers: <task paths and owned slices>
   - Evidence: <validation and artifact paths>
   - QA provenance: <target-verified, or honest non-target provenance>
   ```

   Review inspects the committed target object and diff, not an assumed globally clean worktree, and must not issue independent acceptance against a moving target. QA may claim exact-target runtime proof only when its execution environment and source are verified at the candidate target and no undisclosed or relevant deltas can affect proof; otherwise QA waits for quiescence or labels provenance honestly. An architecture consultation may inspect uncommitted or incomplete material only as advisory input, never as independent acceptance.
5. **Pre-acceptance base/merge-base check.** Immediately before each final Review/QA verdict, the root refreshes the accepted integration ref and records its current SHA, computes the candidate target's merge-base against that current base (the PR merge-base when a PR exists), records bounded ahead/behind counts for the base and candidate relative to that merge-base, and classifies path interaction. Compare the base-side paths (`<merge-base>..<current accepted base>`) directly with the candidate-side paths (`<merge-base>..<candidate target>`), rather than only paths changed after the freeze snapshot; classify the interaction as `none/independent`, `material overlap`, or `uncertain interaction` (shared interfaces, configuration, or runtime behavior can be uncertain even without an identical path). The freeze-time accepted-base snapshot may additionally show whether the base moved during review, but it cannot replace this direct comparison: a candidate may already have been behind the accepted base when frozen. If the evidence is `none/independent`, record it and let the existing verdict stand. If overlap is material or interaction is uncertain, the prior verdict is stale: the root deliberately integrates or otherwise updates the candidate through the repository's normal workflow (never an automatic merge or rebase), re-quiesces, validates, creates a new immutable candidate, and obtains fresh exact-target Review/QA.
6. Findings return to the persistent specialist that owns the affected slice. After repair, the root creates an additive repair commit; the same Reviewer re-reviews source findings against both the repair delta (`<old-target>..<new-target>`) and cumulative diff (`<base>..<new-target>`), while the same QA owner reruns runtime proof against the repaired target and reports its provenance again.

## Persistent Ownership And Review

Task completion releases active execution, not identity or accumulated context.

- Send corrections to a running owner with `send_message`.
- Reactivate the same completed Worker for reviewer-directed repairs and coherent follow-on work.
- Reactivate the same Triage owner for clarification and renewed evidence.
- Reactivate the same Reviewer for re-review of the same slice or campaign.
- Reactivate the same QA owner to rerun runtime proof after repair.
- Spawn a fresh sibling only for changed ownership, poisoned context, a genuinely independent second opinion, or a materially new slice.

Before spawning, inspect existing task paths for the same role and ownership. One durable owner per slice is the default. Rework is not a reason to discard context. If two repair cycles fail, revisit diagnosis, decomposition, or the execution contract rather than manufacturing another Worker.

Review treats both the Triage report and implementation as fallible. Review compares the causal model with source and runtime evidence, checks the touched and adjacent surfaces, judges architecture, correctness, security, migration completeness, and evidence sufficiency, and hunts deeper explanations. It does not routinely repeat formatting, compilation, static analysis, or tests already run successfully by the Worker. Run a targeted probe only for a concrete suspicion, contradictory proof, high-consequence boundary, or integrated-state drift.

Return bounded source findings to the same Worker or persistent specialist, and runtime findings to the same QA owner. If a Reviewer supplied midstream Triage adjudication, mark later verdicts reduced-independence/advisory; use a fresh Reviewer when consequential independent final acceptance is required.

## QA, Design, And Deployment

- Designer owns product and visual judgment, coherent UI implementation, accessibility, responsive states, and visual proof.
- QA owns the real application, runtime processes, user-flow piloting, screenshots, logs, platform evidence, and usability reporting. QA does not silently repair code.
- Deployment owns only explicitly authorized consequential operations. Verify target, procedure, rollback, observability, and authorization; stop safely when preconditions differ.

## Event-Driven Coordination

Do not spend turns polling agents or commands. `wait_agent` is event-driven: its timeout is an upper bound and it wakes when mailbox activity or user steering arrives. Prefer one wait matched to the expected horizon—commonly 5-15 minutes for implementation, builds, or QA—over repeated short waits. If it times out, inspect once and issue another long wait when waiting remains the next useful action.

Children send intermediate messages only for material blockers, ownership collisions, falsified assumptions, or decisions. Routine commentary can wake the root and recreates polling cost. The child that owns a long-running command also owns its native session polling and reports compact state, error signatures, and artifact paths.

Read [references/coordination-loop.md](references/coordination-loop.md) for exact primitive and synchronization semantics.

## Workflow

1. Preserve the full requested outcome and acceptance evidence; use `/goal` for substantial multi-turn campaigns.
2. Dispatch Triage when causal understanding, repository mapping, or the verification path is uncertain.
3. Verify the report, settle shared contracts, and define dependency-ordered ownership slices.
4. Dispatch persistent Workers in parallel where ownership is clear; keep uncertain or overlapping work serial.
5. Route concrete Worker questions to the existing Triage owner and propagate only material cross-slice changes through the root.
6. After parallel edits stabilize, the root quiesces parallel writers. If integration repair or a serial build/test/fix lane is needed, activate exactly one integration Worker while all other writers remain quiescent; after it finishes, re-quiesce reviewed surfaces, integrate the final aggregate state, and run focused aggregate validation. The root retains Git mutations and acceptance.
7. Commit one coherent stable candidate after that validation, excluding unrelated shared-worktree changes; do not create per-Worker commits or extra branches/worktrees for review.
   When task-launch ambiguity or later evidence reveals duplicate roots pursuing the same outcome and base, pause further external publication until the coordinating root names one canonical publisher and compares the exact task paths, bases, branches or remote heads, and existing artifacts. Preserve and reuse a useful commit, branch, or PR that a duplicate already published when safe; reconcile disjoint work additively and validate the cumulative result. Never infer duplicate ownership from title similarity alone, automatically stop tasks, force-push, rewrite history, or discard useful work. This is a recovery gate for known or suspected duplication, not a routine semantic-deduplication scan.
8. Dispatch persistent Review or QA against the exact checkpoint packet when risk warrants it; return findings to the persistent specialist, then use an additive repair commit, same-Reviewer source re-review, and same-QA-owner rerun as described above.
9. Finish aggregate validation and make the explicit decision when possible; record the campaign terminal disposition as `accepted`, `rejected`, `blocked`, or `abandoned`.
10. Once the campaign reaches any terminal disposition, finalize the bounded campaign-close learning packet described in [references/learning-loop.md](references/learning-loop.md) for every substantial campaign, even when KPIs are zero or not observed. Keep a bounded latest snapshot if useful, but forward only a new immutable revisioned artifact with campaign/revision metadata, supersession and correction details when applicable, and a verifiable integrity identity. A later correction explicitly reopens the campaign and never overwrites a prior forwarded revision. Separate repository friction, which belongs in the task-owner completion handoff, from harness candidates; forward only to an explicitly configured consumer. Learning packets are evidence only: never automatically change policy, roles, routing, hooks, tasks, configuration, or installs.

Read [references/delegation-contract.md](references/delegation-contract.md) before consequential fan-out and [references/handoff-packet.md](references/handoff-packet.md) before replacing ownership or renewing long context.

## Native Primitives

- `spawn_agent`: root-only creation of a bounded leaf using the fixed native `agent_type`.
- `list_agents`: inspect paths, status, and current ownership at meaningful coordination points.
- `send_message`: queue context or correction without starting an idle task.
- `followup_task`: reactivate an idle or completed persistent owner with its role binding and accumulated context.
- `wait_agent`: event-driven mailbox wait with a bounded timeout.
- `interrupt_agent`: stop obsolete or unsafe work without destroying task identity.

## Hard Boundaries

- All subagents are leaves. Only the root spawns.
- Do not assign overlapping implementation ownership without explicit sequencing.
- Do not accept completion prose as proof.
- Do not route ordinary implementation to a review-only role or invent unconfigured role variants.
- Do not treat repository size, difficult code, failing tests, or more investigation as blockers.
- Do not let learning observations self-modify the harness. Reporting is automatic; policy promotion requires explicit owner deliberation.
- The root owns Git integration, task-graph shape, cross-slice decisions, evidence acceptance, and final completion.
- Native task messaging stays within one root tree. Unrelated top-level Desktop tasks require app-level coordination.
