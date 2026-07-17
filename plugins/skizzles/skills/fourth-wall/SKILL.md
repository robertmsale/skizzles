---
name: fourth-wall
description: Coordinate work through a bounded native Codex MultiAgentV2 task graph. Read before the first subagent spawn or orchestration action in a task. Use for complexity-aware model dispatch, behavioral roles, task messaging, worker-to-worker ownership delegation, dependency fan-out, review loops, goal checkpoints, warm handoffs, synchronization, and recovery. Do not use for routine single-agent work or communication across unrelated top-level Desktop tasks.
---

# Fourth Wall

Use native MultiAgentV2 with two independent dispatch choices: complexity and horizon select the model/effort tier, while a behavioral role selects the duty. Keep the graph bounded: the root dispatches every role, eligible Terra/Sol Workers may dispatch one active Luna Worker for a complete disjoint slice, and a global hook blocks deeper nesting and completed-task reactivation through `followup_task`.

## Scope

- Operate within the current root task tree. Native task paths and messaging do not cross unrelated top-level Desktop tasks.
- Keep the root focused on the overall outcome, decisions, dispatch, integration acceptance, and proof evaluation.
- Delegate complete ownership slices with a clear owner, boundary, implementation, validation, and evidence contract. Do not retain the expensive execution loop at the root merely because delegation is active.
- Stay single-agent when coordination overhead would exceed the value of delegation.
- Children are peers beneath the root. Non-Workers return further decomposition to the root. A depth-1 Terra/Sol Worker may dispatch one active Luna Worker only when it can transfer a small, disjoint, end-to-end ownership slice while continuing independent implementation.

## Dispatch Contract

Name every child `<tier>__<role>__<objective>`. Double underscores separate routing fields; use single underscores inside the objective. Do not encode model names in task names.

Choose the cheapest tier likely to succeed, then raise the tier when horizon, context, specialization, or risk demands it:

| Tier | Model | Effort | Use |
|---|---|---|---|
| `mechanical` | `gpt-5.6-luna` | high | Tiny, repetitive, precisely bounded work |
| `scoped` | `gpt-5.6-luna` | xhigh | Short conventional implementation with clear acceptance criteria |
| `broad` | `gpt-5.6-terra` | high | Context-heavy exploration or mapping with straightforward reasoning |
| `standard` | `gpt-5.6-terra` | high | Normal debugging, implementation, tests, and refactors |
| `complex` | `gpt-5.6-sol` | medium | Ambiguous but bounded cross-boundary reasoning |
| `specialized` | `gpt-5.6-sol` | high | Architecture, security, migrations, computer use, or long-horizon work |
| `critical` | `gpt-5.6-sol` | xhigh | Adversarial review, irreversible operations, crash or security risk, or failed lower-tier work |

Use Luna only when the assignment is short-lived, self-contained, cheaply verifiable, and comfortably below long-context territory. Luna is the cost-efficient default for a clean bounded packet, not a sink for noisy logs or ambiguous work. Prefer Terra as context insurance when broad repository history must remain coherent even if the reasoning is conventional; do not use it merely as a universal middle tier. Use Sol when ambiguity, specialization, runtime-only behavior, cross-boundary architecture, platform lifecycle, or defect-escape cost dominates. Complexity and horizon are separate signals: a small difficult task may need Sol, while a large straightforward mapping task may fit Terra.

Do not spend model turns merely polling commands or children. The owner of a long-running command uses the native bounded wait/session primitive, stores verbose output outside model context, and reports only completion state, relevant deltas, error signatures, and artifact paths. Delegate an engineering outcome only when the child can interpret and act on the result.

When `spawn_agent` exposes `model` and `reasoning_effort`, pass the table values explicitly and use `fork_turns = "none"`. If the active schema does not expose those fields, do not invent them; retain the tier prefix as the routing contract and rely on the configured host or hook to apply it. Missing schema feedback is not evidence that the child inherited the root or that routing did not occur. Do not claim an effective model or effort unless the host exposes it.

Choose the independent behavioral role that best matches the duty:

| Role | Use | Resource |
|---|---|---|
| Triage | Focused codebase research and current-shape mapping | [resources/roles/triage.md](resources/roles/triage.md) |
| Worker | Well-defined implementation with explicit ownership | [resources/roles/worker.md](resources/roles/worker.md) |
| Designer | Frontend and product UI implementation | [resources/roles/designer.md](resources/roles/designer.md) |
| QA | Runtime piloting and evidence-rich product verification | [resources/roles/qa.md](resources/roles/qa.md) |
| Review | Independent adversarial review and final validation | [resources/roles/review.md](resources/roles/review.md) |
| Deployment | Careful procedural deployment and production operations | [resources/roles/deployment.md](resources/roles/deployment.md) |

Examples: `scoped__worker__implement_filters`, `broad__triage__map_sync_flow`, and `critical__review__audit_auth_change`.

In every spawn message:

1. Name the tier and role.
2. Tell the child to read this skill and the linked role resource.
3. Provide the complete objective, ownership, constraints, established decisions, relevant skill obligations, and expected proof.
4. Prefer `fork_turns = "none"` so the handoff remains explicit and context cost stays bounded.

For a long or replacement-heavy root task, keep one durable task packet under `/tmp` and give children its path plus their slice-specific instructions. Keep the packet concise and operational; do not ask hooks to reconstruct or rewrite encrypted spawn messages. Record the overall objective, established decisions, constraints, live ownership, evidence, open gates, and routing state. Update it only at meaningful handoffs or acceptance points, not as a transcript.

Example:

```text
You are dispatched as a Scoped Worker. Read $fourth-wall and follow
resources/roles/worker.md. You are a Luna leaf and must not spawn subagents.

Assignment: ...
Ownership: ...
Constraints: ...
Expected proof: ...
```

## Execution Discipline

Roles describe duties and remain valid under every model and effort combination. The tier carries the capability decision.

- Act decisively when the path is clear and evidence is sufficient.
- Keep mechanical and reversible work direct.
- Investigate uncertainty that materially affects correctness, ownership, or costly rework.
- Stop and report a real owner decision when competing valid outcomes cannot be resolved from code, evidence, or instructions.
- Prefer one child owning investigation-through-proof for a coherent slice over splitting implementation and its focused validation between child and root.
- Complete causal ownership includes the smallest executable proof of the real boundary or production entrypoint changed. Source inspection, helper-only tests, and successful builds are not sufficient when a local runtime smoke can exercise the behavior directly.
- For runtime, platform, cross-process, or live-state boundaries, sequence proof by increasing cost: focused source/unit checks, then the cheapest causal smoke through the production entrypoint, then full product QA. Skip the smoke only when full QA is itself the cheapest executable proof.
- A test-green/runtime-red result raises the next owner one tier. A second failure on the same causal surface requires fresh Triage of the production path and proof boundary before another implementation attempt.
- Use the root's capability for decomposition, cross-slice decisions, and acceptance. Route repetitive implementation, integration stabilization, build/test loops, and runtime proof to an appropriately tiered leaf whenever the ownership can be made coherent.
- Delegate engineering loops, not command errands. A Worker grandchild owns inspection, implementation, focused checks, in-scope fixes, and its compact completion evidence together.

## Escalation And Cooldown

Treat the dispatch table as the baseline and maintain a task-family floor when execution evidence shows the baseline is insufficient. Escalation is fast and de-escalation is deliberately slow.

Raise the affected task family's floor immediately when a lower-tier result fails acceptance, root or reviewer must substantially repair it, ownership crosses an unexpected boundary, reproduction becomes runtime-only or platform-specific, a proposed fix violates an architectural invariant, or the same causal surface fails again. A test-green/runtime-red result raises the next owner one tier. A second failure requires fresh Triage of the production path and proof boundary before another implementation attempt. Attach the floor to a concrete risk signature or ownership family, not permanently to the whole repository.

Within an active systemic incident, keep diagnostic and acceptance work at the proven elevated floor. Once uncertainty is removed, bounded implementation descendants may use a lower tier when the invariant, ownership, and proof are explicit; the elevated reviewer still owns acceptance. Never infer that a lower tier would have succeeded merely because a higher-tier task completed in one shot.

Consider a one-route cooldown only after three consecutive independently accepted assignments in the same task family. Count a success only when the first implementation passes focused checks and runtime proof, independent review finds no material issue, and neither root repair nor replacement is required. Use only hook-backed named routes: `critical` -> `specialized` -> `complex` -> `standard`. This preserves the model while reducing reasoning wherever the table supports it, then crosses model class once. `broad` is selected by long context rather than elevated difficulty, so move it to `scoped` only when a new assignment is genuinely short-context; likewise move `standard` to `scoped` only after the work becomes independently Luna-eligible. `mechanical` and `scoped` are already baseline routes. Keep the reduced route on probation for three more clean assignments before adopting it as the new baseline. Any material rejection, root rescue, architecture correction, or attributable regression resets the clean-success count and immediately restores the last proven floor. Do not invent model/effort hybrids outside the routing table.

Do not automatically cool down crash investigation, security or authentication, data corruption, migrations, irreversible operations, native window or engine lifecycle, accessibility-engine faults, or final adversarial acceptance. Their sparse samples and high defect cost do not justify downward experiments. Record the task family, current floor, evidence trigger, clean-success count, probation state, and last accepted route in the durable task packet; the hook remains stateless.

## Native Primitives

- `spawn_agent`: dispatch a bounded task with a behavioral role and clear handoff; only eligible Workers may use it below the root.
- `list_agents`: inspect live task paths, statuses, and latest assignments.
- `send_message`: queue context or corrections without starting a new turn.
- `followup_task`: disabled by the global hook; spawn a fresh replacement instead of reactivating a completed child.
- `wait_agent`: wait for mailbox activity, user steering, or a bounded timeout.
- `interrupt_agent`: stop obsolete or unsafe work without destroying task identity.

Read [references/coordination-loop.md](references/coordination-loop.md) for exact delivery and lifecycle semantics.

## Workflow

1. Preserve the full owner-requested outcome and acceptance evidence. Keep an active goal's complete breadth.
2. Build the smallest useful bounded graph. Prefer one Worker with complete slice ownership before broad fan-out.
3. Assign disjoint ownership, a behavioral role, a self-contained handoff, implementation and validation responsibility, and expected proof.
4. Continue only high-leverage root work such as shared-contract decisions, integration inspection, and downstream routing. Do not fill child runtime with duplicate implementation, routine test loops, or repeated status polling.
5. Treat completion messages as claims. Inspect changes and evidence, then dispatch Review or QA when risk warrants independent proof.
6. When an integrated ownership slice has focused proof and no known breakage, commit it as a forward-progress checkpoint before changing causal surfaces, beginning risky work, handing off substantial ownership, or starting independent QA/Review. `/goal` state is not required. The root owns the checkpoint and excludes unrelated shared-worktree changes.
7. Send corrections to a running owner with `send_message`; after it completes, spawn a fresh replacement at the same or next tier with a compact handoff. Prefer corrective commits over rewriting already reviewed checkpoints.
8. Finish with a coherent integrated outcome, validating the aggregate commit series and working tree rather than only the latest checkpoint.

Read [references/delegation-contract.md](references/delegation-contract.md) before splitting consequential implementation work.

## Patterns

- **Big-picture root:** retain product intent and decisions while specialists own bounded execution.
- **Dependency fan-out:** dispatch independent preparation in parallel, then release downstream work after contracts stabilize.
- **Worker offload:** a Terra/Sol Worker continues its owned implementation while one Luna Worker owns a small disjoint slice through focused proof.
- **Fresh specialist:** dispatch one bounded assignment, collect its result, and replace rather than reactivate it.
- **Adversarial loop:** Review evaluates implementation and evidence; findings go to a fresh owning Worker when more work is needed.
- **Integration stabilization:** after parallel edits settle, one Worker owns the serial build/test/fix loop across the integrated surface while the root retains Git authority and acceptance.
- **Implementation proof:** one QA leaf owns application startup, piloting, logs, screenshots, and runtime evidence before handoff to any independent downstream QA task.
- **Warm handoff:** collect a compact state packet, dispatch a fresh sibling with the same role, then retire obsolete ownership.
- **Drift recovery:** inspect the tree, resolve stale or overlapping ownership, and interrupt only obsolete or unsafe work.

Read [references/handoff-packet.md](references/handoff-packet.md) for context renewal and its limits.

When observed behavior reveals a reusable routing or lifecycle caveat, follow [references/learning-loop.md](references/learning-loop.md). Record evidence-backed candidates without silently changing global policy during active work.

## Hard Boundaries

- Triage, Designer, QA, Review, Deployment, and Luna Workers are leaves. A depth-1 Terra/Sol Worker may have at most one active Luna Worker grandchild; all other delegation proposals return to the root.
- Worker grandchildren must be named `mechanical__worker__...` or `scoped__worker__...`, use `fork_turns = "none"`, own a disjoint complete implementation loop, and never spawn again. The hook enforces route shape and no-history forks; the one-active-grandchild limit remains parent/root lifecycle policy because the hook is intentionally stateless.
- A completed child is terminal. Do not reactivate it with `followup_task` or use `send_message` as a disguised follow-up.
- Do not let two implementation tasks own overlapping files without explicit coordination.
- The root owns Git integration, decides when parallel edits are stable, and accepts the final result. Once stable, delegate serialized project-wide verification, integration repair loops, and live proof when a leaf can own them coherently; run them at the root only when delegation overhead would exceed the work.
- The root commits stable forward progress after inspecting a coherent slice and its evidence. Do not commit every child result mechanically, known-broken intermediate states, overlapping ownership, or unrelated user/agent changes. Commit boundaries are independent of `/goal` boundaries.
- Do not turn size, difficulty, or uncertainty into a blocker. A blocker identifies an external dependency, contradiction, safety issue, or owner decision.
- Do not accept completion prose as proof.
- Do not attempt to promote a child into the root. Root renewal requires a new top-level task and an explicit handoff.
