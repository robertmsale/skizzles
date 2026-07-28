---
name: fourth-wall
description: Coordinate substantial engineering work through a bounded native Codex MultiAgentV2 task tree. Use before spawning subagents or when an active tree needs routing, synchronization, review, recovery, or handoff. Stay single-agent when delegation would not materially improve speed or quality.
---

# Fourth Wall

Use native MultiAgentV2 for complete, disjoint engineering outcomes. The root owns the user outcome, task graph, shared decisions, Git integration, and final acceptance. Children own their assigned slice and remain leaves.

A full plugin installation advertises this skill as `$skizzles:fourth-wall`. A standalone skill installation may advertise `$fourth-wall`. Use the identifier present in the active skill inventory.

## Decide whether to delegate

Stay single-agent for routine, tightly coupled, or cheap work. Delegate when at least one bounded child can make independent progress and the expected speed or quality gain exceeds coordination cost.

Do not require a plan, Triage, QA, Review, a report artifact, screenshots, or a handoff packet for ordinary tasks. Add them only when task structure, risk, or the user makes them useful.

Prefer:

- one Worker that owns inspection through focused validation;
- several Workers only for disjoint files or causal surfaces;
- Triage for uncertain diagnosis or runtime-path mapping;
- Designer for product UI implementation;
- QA for independent runtime or user-flow proof;
- Review for consequential or high-risk acceptance;
- Deployment only for explicitly authorized external or production operations.

## Host boundary

Use only collaboration tools advertised in the current session. Native MultiAgentV2 messaging and lifecycle operations stay inside one root tree.

The supplied compatibility summary is:

- CLI `0.145.0` is portable/partial. Same-root collaboration and configured roles are conditional on the active tool inventory; do not promise durable fixed-role behavior.
- CLI `>= 0.146.0-alpha.3` supports the full same-root fixed-role core when generated roles have been configured.
- Desktop dynamic functions are advertised per task. Cross-root operations are Desktop-only extras when advertised, not CLI requirements.

When a needed cross-root operation is not advertised, write one compact packet under the task's `/tmp` workspace, report its path and next action, and use a manual handoff. Do not wait on an unrelated root through MultiAgentV2.

## Roles

When the generated Skizzles roles are configured and advertised, select the matching `agent_type` and omit separate model or reasoning overrides:

| `agent_type` | Model | Effort | Duty |
|---|---|---|---|
| `worker` | `gpt-5.6-luna` | xhigh | Complete implementation, focused validation, and repair ownership |
| `triage` | `gpt-5.6-terra` | medium | Evidence-first diagnosis, runtime reproduction, and execution-path mapping |
| `default` | `gpt-5.6-luna` | high | Cheap general-purpose bounded execution when no specialized role applies |
| `deployment` | `gpt-5.6-sol` | xhigh | Authorized consequential external or production operations |
| `review` | `gpt-5.6-sol` | high | Independent adversarial correctness and architectural acceptance |
| `designer` | `gpt-5.6-sol` | medium | Product and visual design judgment with implementation proof |
| `qa` | `gpt-5.6-terra` | medium | Long procedural runtime piloting and usability evidence |

There are no capability variants or model-escalation ladder. When implementation becomes difficult, improve diagnosis, clarify the contract, or split independent ownership. Do not replace a Luna Worker with a Sol Worker. Sol is reserved for design, review, deployment, and root judgment.

Do not invent fallback role mappings, lower routing floors, or capability variants when configured roles are unavailable. Use only the active spawn schema and report the missing configured-role surface when it prevents the requested routing.

Role duty determines routing. Repository size alone does not justify a larger model or a broader graph.

## Dispatch

Name children `<role>__<objective>`, with single underscores inside the objective: `worker__implement_filters`, `triage__map_sync_failure`, `review__audit_auth_change`.

Every delegated assignment states:

- the observable outcome;
- exclusive ownership;
- relevant dependencies and established decisions;
- constraints, applicable skills, and forbidden scope;
- focused checks or runtime proof expected;
- the result the parent needs back.

Tell the child it is a leaf. Include only context it cannot cheaply inspect.

Choose `fork_turns` deliberately:

- `"none"` for self-contained packets and isolated slices;
- a small positive count when recent decisions prevent rediscovery;
- never `"all"` when selecting a child role: full-history spawning bypasses the selected role configuration.

See [delegation-contract.md](references/delegation-contract.md) for a compact assignment template.

## Coordinate

All children share the checkout. Keep write ownership disjoint and resolve overlap before more edits land. Children use read-only Git inspection unless the root delegates one exact Git action.

Use collaboration tools by lifecycle:

- `spawn_agent` creates a bounded child;
- `send_message` delivers a correction or dependency while it runs;
- `followup_task` gives coherent follow-on work to an idle child;
- `wait_agent` waits for mailbox activity without polling;
- `list_agents` inspects current state;
- `interrupt_agent` stops obsolete, unsafe, or irreconcilably overlapping work.

Do not spend turns polling. Use event-driven waits and resume useful root work while independent children run.

Reactivation does not prove that an evicted child's role, model, or reasoning effort survived. When continuity matters, spawn a fresh sibling with an explicit role selection and a compact handoff instead of relying on reactivation.

See [coordination-loop.md](references/coordination-loop.md) for delivery and lifecycle details.

## Integrate and verify

Treat a child completion message as a claim. Inspect its changes and checks before integration.

The root may:

1. accept a focused low-risk slice after inspection;
2. return an attributable finding to the owning Worker;
3. use QA for independent runtime proof;
4. use Review for consequential correctness, architecture, security, or migration risk;
5. assign one Worker the serial project-wide build, test, and repair loop after parallel edits settle.

Do not duplicate adequate child validation mechanically. Add targeted proof where the changed boundary or risk requires it. Keep diagnostic results visible and resolve or report every failure.

## Recovery and handoff

When the graph drifts, inspect live tasks, restore one owner per surface, send corrections, and interrupt only obsolete or unsafe work. Spawn a replacement after its ownership and first action are clear.

Use a compact handoff only for long-context replacement, changed ownership, or cross-root manual transfer. Include objective, ownership, established state, constraints, open work, decisive evidence, and next action. Do not include a transcript or claim that a packet preserves model state.

See [handoff-packet.md](references/handoff-packet.md).

## Hard boundaries

- Children are leaves and do not spawn subagents.
- Two implementation tasks do not own the same files or causal surface.
- The root owns task-graph decisions, shared-interface changes, Git integration, and final acceptance.
- External writes, deployment, credentials, destructive operations, and production changes require exact authorization.
- Cross-root and Desktop-only capabilities are used only when advertised for the current task.
- `fork_turns="all"` is incompatible with selected-role application.
- Reactivation after residency eviction is not evidence of role, model, or effort continuity.
