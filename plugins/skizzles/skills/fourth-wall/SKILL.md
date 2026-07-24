---
name: fourth-wall
description: Coordinate work through a bounded native Codex MultiAgentV2 task graph. Read before the first subagent spawn or orchestration action in a task. Use for complexity-aware model dispatch, behavioral roles, task messaging, worker-to-worker ownership delegation, dependency fan-out, review loops, goal checkpoints, warm handoffs, synchronization, and recovery. Do not use for routine single-agent work or communication across unrelated top-level Desktop tasks.
---

# Fourth Wall

Use native MultiAgentV2 with capability-bearing agent roles. Complexity and horizon select a model/effort pair, while behavioral duty selects the role family; the installed composite `agent_type` durably carries both choices across eviction and reactivation. Terra maps broad context, Luna owns well-specified implementation loops, and Sol resolves ambiguity and judges quality. Keep the graph bounded: the root dispatches every role, and eligible Terra/Sol Workers may dispatch one active bounded Worker for a complete disjoint slice.

## Scope

- Operate within the current root task tree. Native task paths and messaging do not cross unrelated top-level Desktop tasks.
- Keep the root focused on the overall outcome, decisions, dispatch, integration acceptance, and proof evaluation.
- Delegate complete ownership slices with a clear owner, boundary, implementation, validation, and evidence contract. Do not retain the expensive execution loop at the root merely because delegation is active.
- Stay single-agent when coordination overhead would exceed the value of delegation.
- Children are peers beneath the root. Non-Workers return further decomposition to the root. A depth-1 Terra/Sol Worker may dispatch one active bounded Worker only when it can transfer a small, disjoint, end-to-end ownership slice while continuing independent implementation.

## Dispatch Contract

Name every child `<role>__<objective>`. Double underscores separate the behavioral role from the objective; use single underscores inside the objective. Examples: `worker__implement_filters`, `triage__map_sync_flow`, and `review__audit_auth_change`. Capability belongs in the selected native `agent_type`, not in the task name.

Choose the cheapest route likely to succeed. Complexity selects the model class; horizon selects reasoning effort and how much recent context to fork:

| Route | Complexity / horizon | Preferred model | Effort | Availability fallback |
|---|---|---|---|---|
| Mechanical | Tiny, repetitive, short | `gpt-5.6-luna` | high | `gpt-5.6-terra` medium |
| Scoped | Conventional, bounded, short | `gpt-5.6-luna` | high | `gpt-5.6-terra` medium |
| Broad | Straightforward reasoning, long context | `gpt-5.6-terra` | medium | — |
| Standard | Normal debugging or implementation | `gpt-5.6-terra` | medium | — |
| Complex | Ambiguous but bounded cross-boundary reasoning | `gpt-5.6-sol` | medium | — |
| Specialized | Architecture, security, migrations, or long horizon | `gpt-5.6-sol` | high | — |
| Critical | Adversarial acceptance, irreversible work, or repeated failure | `gpt-5.6-sol` | xhigh | — |

Use Luna as the default Worker once the objective, ownership, established decisions, invariants, constraints, and proof are explicit. Give Luna the complete inspect-implement-compile-test-fix-report loop; do not reduce it to a command runner or a few dictated edits. Repository size does not require a larger model when the active ownership slice is coherent. If Luna is unavailable, use the listed Terra fallback. Prefer Terra for broad repository mapping, dependency discovery, context compression, and long-context coordination. Prefer Sol for unresolved architecture, ambiguous diagnosis, security or irreversible decisions, product design judgment, and adversarial acceptance. Runtime or cross-boundary work may return to Luna after Sol or Terra has made the contract concrete.

Do not spend model turns merely polling commands or children. The owner of a long-running command uses the native bounded wait/session primitive, stores verbose output outside model context, and reports only completion state, relevant deltas, error signatures, and artifact paths. Delegate an engineering outcome only when the child can interpret and act on the result.

Under the Skizzles instruction profile, select the advertised capability-bearing `agent_type` and omit independent `model` and `reasoning_effort` overrides. Each generated role config owns its model, effort, compact subagent base, and role-specific developer instructions; this is what makes reactivation durable after process eviction. Do not repeat that stable role contract in the message. If the matching generated role is unavailable, use an advertised role with the closest sufficient capability. Only when Skizzles roles are not installed should you omit `agent_type`, pass explicit model/effort fields, and add one concise duty sentence.

Choose `fork_turns` deliberately:

- Use `"none"` for self-contained packets, isolated implementation, sensitive stale context, and Worker grandchildren.
- Prefer a small positive integer string such as `"1"` or `"2"` when recent owner intent or an established plan would prevent rediscovery.
- Do not use `"all"` when the active default or named agent role supplies child-specific configuration. Full-history forks skip role application; under the Skizzles instruction profile, that would also bypass the compact subagent base instructions. A positive number larger than the available turn count keeps every available fork turn without becoming full-history.

Codex 0.145.0-alpha.18 supports explicit model/reasoning overrides with positive and full-history forks, and exposes `agent_type` when roles are configured. Skizzles role dispatch requires `fork_turns="none"` or a positive integer because full-history forks inherit the parent `agent_type` and bypass role application. A positive integer larger than available history retains all available turns without becoming full-history mode. Do not claim an effective role, model, or effort merely from a successful call; use host-visible task settings or rollout evidence when verification matters.

Choose the behavioral family that best matches the duty, then select an advertised capability variant. Unsuffixed names are the normal defaults:

| Role | Default `agent_type` | Installed variants | Use |
|---|---|---|---|
| Triage | `triage` = Terra medium | `triage_sol_medium` | Focused codebase research and current-shape mapping |
| Worker | `worker` = Luna high | `worker_<model>_<effort>` across the Luna, Terra, and Sol ladders; `worker_luna_medium` is Mechanical | Well-defined implementation with explicit ownership |
| Designer | `designer` = Sol high | `designer_sol_xhigh` | Frontend and product UI implementation |
| QA | `qa` = Luna high | `qa_terra_medium` | Runtime piloting and evidence-rich product verification |
| Review | `review` = Sol high | `review_sol_xhigh`, `review_sol_max` | Independent adversarial judgment and acceptance assessment |
| Deployment | `deployment` = Sol high | `deployment_sol_xhigh` | Careful procedural deployment and production operations |

The generated manifest at `assets/agents/manifest.json` is the source of truth for exact installed names and capability pairs. Typical Worker routing is Mechanical -> `worker_luna_medium`, Scoped -> `worker`, Broad/Standard -> `worker_terra_medium`, Complex -> `worker_sol_medium`, Specialized -> `worker_sol_high`, and Critical -> `worker_sol_xhigh`.

In every spawn message:

1. Name the selected route and role. Under the Skizzles profile, set the matching capability-bearing native `agent_type` and do not independently override its model or effort.
2. Provide the complete objective, ownership, constraints, established decisions, relevant skill obligations, and expected proof.
3. Add only assignment-specific role constraints; the configured role already injects its stable duty through `developer_instructions`.
4. Choose the smallest useful `fork_turns` value so the handoff remains explicit without forcing the child to rediscover recent decisions.

For a long or replacement-heavy root task, keep one durable task packet under `/tmp` and give children its path plus their slice-specific instructions. Keep the packet concise and operational; do not automate reconstruction or rewriting of encrypted spawn messages. Record the overall objective, established decisions, constraints, live ownership, evidence, open gates, and routing state. Update it only at meaningful handoffs or acceptance points, not as a transcript.

Example:

```text
You are dispatched as a Scoped Worker. The native `worker` role supplies
gpt-5.6-luna at high effort and the stable Worker contract.

Assignment: ...
Ownership: ...
Constraints: ...
Expected proof: ...
```

## Execution Discipline

Generated roles combine a stable behavioral duty with one durable model/effort pair. The role manifest carries the capability decision.

- Act decisively when the path is clear and evidence is sufficient.
- Keep mechanical and reversible work direct.
- Investigate uncertainty that materially affects correctness, ownership, or costly rework.
- Stop and report a real owner decision when competing valid outcomes cannot be resolved from code, evidence, or instructions.
- Prefer one child owning investigation-through-proof for a coherent slice over splitting implementation and its focused validation between child and root.
- Treat Worker validation as part of implementation ownership. The Worker runs appropriate formatting, static analysis, builds, tests, and focused runtime proof, fixes attributable failures, and returns compact evidence.
- Review evaluates the change and whether that evidence is sufficient. Do not routinely rerun the same build, test, formatter, or static-analysis suite. Run a targeted probe only to resolve a concrete suspicion, contradictory evidence, a high-consequence boundary, or aggregate-state drift.
- Complete causal ownership includes the smallest executable proof of the real boundary or production entrypoint changed. Source inspection, helper-only tests, and successful builds are not sufficient when a local runtime smoke can exercise the behavior directly.
- For runtime, platform, cross-process, or live-state boundaries, sequence proof by increasing cost: focused source/unit checks, then the cheapest causal smoke through the production entrypoint, then full product QA. Skip the smoke only when full QA is itself the cheapest executable proof.
- A test-green/runtime-red result is evidence that the proof contract or production-path understanding may be incomplete, not automatic proof that the Worker needs a larger model. Clarify the boundary; a second failure on the same causal surface requires fresh Triage before another implementation attempt and may justify one recorded capability step.
- Use the root's capability for decomposition, cross-slice decisions, and acceptance. Route repetitive implementation, integration stabilization, build/test loops, and runtime proof to an appropriately capable leaf whenever the ownership can be made coherent.
- Delegate engineering loops, not command errands. A Worker grandchild owns inspection, implementation, focused checks, in-scope fixes, and its compact completion evidence together.

## Capability Adjustment And Evidence

Start each assignment at the cheapest model floor that fits its remaining uncertainty: Luna high for explicit implementation, Terra medium for broad mapping or context-heavy coordination, and Sol medium for unresolved judgment. Specialized design and independent review may begin above the floor when the risk justifies it. Cap deliberate escalation at `max` reasoning.

The full gradual ladder below is a **Worker correction policy**. Worker owns implementation rework and therefore has every generated step. Other roles use only the finite variants listed in the role table: Triage may move from Terra medium to Sol medium when mapping becomes judgment-heavy; QA may move from Luna high to Terra medium when runtime investigation becomes context-heavy; Designer, Review, and Deployment may move through their listed Sol variants. Do not invent a missing role variant or imply a one-step transition that the manifest does not provide.

For Worker, increase capability one step at a time:

| Model | Reasoning ladder |
|---|---|
| `gpt-5.6-luna` | high -> xhigh -> max |
| `gpt-5.6-terra` | medium -> high -> xhigh -> max |
| `gpt-5.6-sol` | medium -> high -> xhigh -> max |

After a model reaches `max`, the next step is the next model at its floor: Luna max -> Terra medium -> Sol medium. Do not jump directly from Luna to Sol merely because review found a bug. Classify rework before routing it:

- **Attributable rework:** the Worker violated or missed an explicit invariant, callsite, test obligation, or evidence requirement from its assignment. Record this as an upgrade signal and increase reasoning one step for the correction when in-place capability changes are available.
- **Adjacent healing:** review found an existing or surrounding defect not introduced by the Worker and not reasonably implied by its contract. Return bounded in-scope work without counting it against the Worker.
- **Contract discovery:** review exposed a new architectural invariant or ambiguity. Sol resolves the decision, then the clarified implementation normally returns to the same Worker without treating discovery as its capability failure.

Current tools cannot change the capability-bearing role of an existing child. Preserve context for the first bounded correction with `followup_task` at the current role; if the same explicit contract is missed again, spawn a successor using the next generated capability variant. Increase capability immediately only for sustained context pressure or a clearly demonstrated reasoning failure where retaining the current route would predictably repeat the mistake.

Keep escalation local to the current ownership slice and reason. A later explicit implementation assignment starts from the normal Luna floor; it does not inherit a repository-wide or task-family penalty. There is no cooldown ritual. Past escalation is evidence for future dispatch, not a permanent capability tax.

Before every capability increase or availability fallback, the root appends one compact JSON object to `routing-decisions.jsonl` beside the durable `/tmp` task packet. Include `agent_path`, `ownership`, `from`, `to`, `reason`, and a bounded `evidence` summary; never include secrets or raw transcripts. Record attributable rework even when the current tool limitation defers its in-place increase, using the unchanged route for `to` and noting that one same-owner repair is pending. Also state an applied increase reason in the successor handoff so it is persisted in rollout history. This makes model changes auditable and lets later analysis distinguish capability failures from bad contracts, adjacent healing, missing context, environment failures, and availability routing.

Current MultiAgentV2 `followup_task` preserves task identity and accumulated context but does not accept capability overrides. Official reload reconstructs the persisted `agent_type` and reapplies its generated model/effort config, so reuse the same Worker safely for corrections at its current route. When a true capability increase is required, spawn a successor with the next generated role variant, the smallest useful positive fork, and the recorded reason. If native reactivation later exposes role or capability overrides, prefer upgrading the same owner so its accumulated knowledge survives without a handoff.

## Native Primitives

- `spawn_agent`: dispatch a bounded task with the matching capability-bearing native `agent_type` and a clear handoff; only eligible Workers may use it below the root.
- `list_agents`: inspect live task paths, statuses, and latest assignments.
- `send_message`: queue context or corrections to running work without starting a new turn.
- `followup_task`: reactivate an idle or completed child while preserving task identity and accumulated context; after eviction, the persisted generated `agent_type` reapplies its durable model/effort pair. It cannot currently change capability.
- `wait_agent`: wait for mailbox activity, user steering, or a bounded timeout.
- `interrupt_agent`: stop obsolete or unsafe work without destroying task identity.

Read [references/coordination-loop.md](references/coordination-loop.md) for exact delivery and lifecycle semantics.

## Workflow

1. Preserve the full owner-requested outcome and acceptance evidence. Keep an active goal's complete breadth.
2. Build the smallest useful bounded graph. Prefer one Worker with complete slice ownership before broad fan-out.
3. Assign disjoint ownership, a behavioral role, a self-contained handoff, implementation and validation responsibility, and expected proof.
4. Continue only high-leverage root work such as shared-contract decisions, integration inspection, and downstream routing. Do not fill child runtime with duplicate implementation, routine test loops, or repeated status polling.
5. Treat completion messages as claims. Inspect changes and evidence, then dispatch Review for independent judgment or QA for independent runtime proof when risk warrants it. Review checks evidence sufficiency instead of mechanically repeating the Worker's validation.
6. When an integrated ownership slice has focused proof and no known breakage, commit it as a forward-progress checkpoint before changing causal surfaces, beginning risky work, handing off substantial ownership, or starting independent QA/Review. `/goal` state is not required. The root owns the checkpoint and excludes unrelated shared-worktree changes.
7. Send corrections to a running owner with `send_message`. After it completes, use `followup_task` when the same ownership and route remain useful. Reviewer-directed rework normally returns to that Worker to preserve context. Spawn a successor only for independence, changed ownership, a poisoned context, or a recorded capability increase. Prefer corrective commits over rewriting already reviewed checkpoints.
8. Finish with a coherent integrated outcome, validating the aggregate commit series and working tree rather than only the latest checkpoint.

Read [references/delegation-contract.md](references/delegation-contract.md) before splitting consequential implementation work.

## Patterns

- **Big-picture root:** retain product intent and decisions while specialists own bounded execution.
- **Dependency fan-out:** dispatch independent preparation in parallel, then release downstream work after contracts stabilize.
- **Worker offload:** a Terra/Sol Worker continues its owned implementation while one bounded Worker owns a small disjoint slice through focused proof.
- **Persistent specialist:** reactivate a completed specialist for coherent follow-on work when retaining its context and ownership reduces rediscovery.
- **Adversarial loop:** Review evaluates correctness, architecture, risk, quality, and evidence sufficiency; bounded findings return to the same owning Worker, while a fresh reviewer remains available when independent final acceptance matters.
- **Integration stabilization:** after parallel edits settle, one Worker owns the serial build/test/fix loop across the integrated surface while the root retains Git authority and acceptance.
- **Implementation proof:** one QA leaf owns application startup, piloting, logs, screenshots, and runtime evidence before handoff to any independent downstream QA task.
- **Warm handoff:** collect a compact state packet, dispatch a fresh sibling with the same role, then retire obsolete ownership.
- **Drift recovery:** inspect the tree, resolve stale or overlapping ownership, and interrupt only obsolete or unsafe work.

Read [references/handoff-packet.md](references/handoff-packet.md) for context renewal and its limits.

When observed behavior reveals a reusable routing or lifecycle caveat, follow [references/learning-loop.md](references/learning-loop.md). Record evidence-backed candidates without silently changing global policy during active work.

## Hard Boundaries

- Triage, Designer, QA, Review, Deployment, and bounded Luna/Terra-medium Workers are leaves. A depth-1 Terra/Sol Worker may have at most one active bounded Worker grandchild; all other delegation proposals return to the root.
- Worker grandchildren must be named `worker__...`, set `agent_type = "worker"` for durable Luna-high routing or `worker_terra_medium` as the bounded fallback, omit independent model/effort overrides, set `fork_turns = "none"`, own a disjoint complete implementation loop, and never spawn again. The parent and root enforce the one-active-grandchild limit through lifecycle discipline.
- Reactivate a completed child when its role, current route, context, and ownership still fit the next action. Spawn a fresh sibling for independent review, changed ownership, a clean context, or a recorded capability increase that current `followup_task` cannot apply in place.
- Do not let two implementation tasks own overlapping files without explicit coordination.
- The root owns Git integration, decides when parallel edits are stable, and accepts the final result. Once stable, delegate serialized project-wide verification, integration repair loops, and live proof when a leaf can own them coherently; run them at the root only when delegation overhead would exceed the work.
- The root commits stable forward progress after inspecting a coherent slice and its evidence. Do not commit every child result mechanically, known-broken intermediate states, overlapping ownership, or unrelated user/agent changes. Commit boundaries are independent of `/goal` boundaries.
- Do not turn size, difficulty, or uncertainty into a blocker. A blocker identifies an external dependency, contradiction, safety issue, or owner decision.
- Do not accept completion prose as proof.
- Do not attempt to promote a child into the root. Root renewal requires a new top-level task and an explicit handoff.
