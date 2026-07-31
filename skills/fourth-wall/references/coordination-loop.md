# Native Coordination Loop

## Tool Semantics

| Tool | Use | Important behavior |
| --- | --- | --- |
| `spawn_agent` | Create bounded work | Root-only. Use `<role>__<objective>`, select the fixed native `agent_type`, omit model/effort overrides, and choose the smallest useful `fork_turns` value. The canonical role spec and generated installed catalog resolve those bindings. |
| `list_agents` | Inspect the live tree | Can filter by task-path prefix. Use before intervention or reassignment. |
| `send_message` | Deliver context or a correction to running work | Queues the message and does not trigger a new turn. |
| `followup_task` | Continue prior ownership | Reactivates an idle or completed child while preserving its task identity, role binding, configured effort, and accumulated context. |
| `wait_agent` | Synchronize on activity | Waits for any mailbox update, user steering, or timeout. It is an event wait, not a status dump. |
| `interrupt_agent` | Stop current work | Leaves the task available for later messages and follow-up work. Cannot interrupt self or root. |

## Root Loop

1. Inspect the task graph with `list_agents` only at meaningful coordination points.
2. Compare active ownership and status with the overall outcome.
3. Use `send_message` for information the target should receive without waking it.
4. Use `followup_task` when completed work needs another concrete action from the same owner. Spawn a fresh sibling only for changed ownership, poisoned context, a genuinely independent second opinion, or a materially new slice.
5. Continue high-leverage root decisions and integration inspection instead of duplicating child work.
6. Use `wait_agent` only when mailbox activity is the next useful synchronization point. Its timeout is an upper bound: prefer one 5-15 minute event-driven wait matched to the expected horizon over repeated short waits, and do not poll merely to narrate progress.
7. Verify returned evidence before accepting or routing the result.

The child that owns a long-running command also owns its terminal polling and reports the useful outcome. The root should not mirror that polling or repeatedly request status from a task that is still within its expected runtime.

Children are leaves. A Worker should send an intermediate message only for a material blocker, ownership collision, or falsified assumption; normal progress arrives in its compact final report.

## Triage And Worker Cooperation

At dispatch, root gives each relevant peer the canonical task paths and resource custody it may contact:

- Workers receive the named Triage path and relevant neighboring Worker paths.
- Triage receives affected Worker paths.
- Review receives Triage and every Worker it reviews.
- QA/Designer receive owners only when clarification or rework may need them.

For every relevant resource, include its stable identifier and locator plus the exact owner task path: Container Lab identifier and state/workspace path, owned worktree/branch, or critical evidence artifact as applicable. Route evidence and runtime requests to the current resource owner. Resource custody is routing metadata, not transfer or shared control; contact never authorizes edits, spawning, or ownership changes. A running Worker uses `send_message` for a narrow clarification and `followup_task` only to reactivate a completed Triage owner. Include the exact command, expected and observed result, attempts, evidence path, and one question. Triage updates the report when its assumptions change; the Worker retains implementation ownership. Material cross-slice changes also go to the root.

Claims carry assurance labels: Worker completion claims are unverified; accepted Triage evidence is provisional causal authority after root verification; an independent Reviewer verdict is the highest independent-assurance recommendation, while a Reviewer that supplied midstream Triage adjudication must mark later verdicts reduced-independence/advisory. Root retains final acceptance and uses a fresh Reviewer when consequential independent final acceptance is required.

Review may request one concrete existing artifact or one bounded missing runtime observation from the exact owner of the relevant Lab, worktree, or evidence. The owner runs it within that boundary and returns command, result, and artifact path. Review neither takes custody nor edits implementation; root coordinates any repair or ownership change.

Triage-to-Review is a guarded adjudication escape hatch, authorized only by root after two bounded diagnostic passes (or equivalent contradictory/high-consequence impasse). Triage's packet includes alternatives, evidence, Worker attempts, why another pass is unlikely to resolve the question, and one narrow decision request. Count every root-authorized dispatch, even when unanswered; record the outcome separately and keep rejected preauthorization attempts as context only. Review adjudicates only and never becomes an implementation owner. Flag every dispatched use as a red-flag KPI; difficult tests or slow builds do not qualify.

## Privileged Steps

Native approval requests are routed out-of-band to the configured reviewer; they do not bubble to the root orchestrator. Under the recommended setup, `approvals_reviewer = "auto_review"` lets subagents request necessary escalation without pausing for the user. Include the exact command or tool action and its reason, respect denials, and do not repeatedly retry an unchanged request. Message the root when a denial changes the plan or when the privileged action is itself an orchestration decision, such as serialized verification or coordinated Git integration.

## Dependency Release

When task B depends on task A:

- Either delay spawning B until A stabilizes, or spawn B with explicitly independent preparatory work.
- When A's output is ready, send it to B while B is still running, or spawn B only after A stabilizes.
- Do not let B guess an unstable shared interface.

## Shared Workspace And Integration

All tasks in the tree share the same checkout. Assign disjoint write ownership, tell implementation tasks not to revert unrelated edits, and resolve overlap before more changes land.

The root owns branch changes, staging, commits, merges, rebases, cherry-picks, stashes, resets, cleans, pushes, and other Git-history mutations unless the user and root explicitly delegate an exact action. Subagents should use read-only Git inspection by default.

Treat project-wide build, analyze, format, and test commands as synchronization points while parallel edits are active. Let implementation children run narrow checks that do not contend for shared locks. After edits stabilize, prefer one of these ownership shapes:

- An integration Worker owns the serial build/test/fix loop, including in-scope repairs and reruns.
- Review inspects the integrated change and its validation evidence, using targeted probes only when a concrete suspicion or evidence gap warrants them.
- QA owns runtime startup, piloting, screenshots, logs, and user-flow evidence.

The root retains Git mutations, resolves cross-owner decisions, inspects the returned evidence, and accepts or reroutes the result. This is especially important for Flutter, Xcode, Cargo, Gradle, Linux/Xvfb application proof, and package-wide formatters.

## Review Loop

1. Worker returns its completion claim and evidence.
2. Root inspects the diff and selects the relevant proof obligations.
3. Spawn a `review` task for adversarial correctness, architecture, security, risk, and quality judgment, or `qa` for runnable product proof. The reviewer assesses whether Worker evidence is sufficient and does not routinely repeat the same build, test, formatting, or static-analysis commands. Implementation-time QA proof complements rather than replaces a later independent product QA handoff.
4. Classify a bounded finding as attributable rework, adjacent healing, or contract discovery. Reactivate the owning Worker so it retains its research and implementation context. A contract-discovery finding returns to persistent Triage before the same Worker continues.
5. Re-review the corrected state when the risk warrants it.
6. Reactivate the same Reviewer for re-review of the same slice. The root integrates and decides completion; the reviewer does not silently broaden scope, repair the code, duplicate validation without cause, or relax the owner outcome.

## Recovery Loop

When orchestration drifts:

1. `list_agents` and reconstruct owner, status, dependency, and next action for each live path.
2. Resolve overlapping ownership before more edits land.
3. Queue nonurgent corrections with `send_message`.
4. Reactivate an idle or completed task when its role and ownership still fit; otherwise prepare a fresh replacement.
5. Interrupt only obsolete, unsafe, or irreconcilably overlapping work.
6. Spawn a replacement only after its role, handoff packet, and ownership boundary are ready.

Canonical paths are the routing graph. A task can use a short relative name for nearby tasks; use the full canonical path when communicating across branches of the tree or when names may be ambiguous.

## Campaign Closeout

After aggregate validation and an explicit decision when possible, root records the campaign terminal disposition (`accepted`, `rejected`, `blocked`, or `abandoned`) and finalizes a bounded latest packet at `/tmp/skizzles-orchestration/<campaign-id>/learning/campaign-close.md` for every substantial campaign, including zero or `not observed` KPI values. A true terminal close has no pending repair or evidence decision. If later evidence reopens the campaign, preserve the prior packet and create a new immutable revisioned forwarding artifact; never overwrite a previously forwarded file. Each forwarded artifact carries campaign ID, revision, `supersedes` when correcting prior evidence, a correction summary, and a verifiable integrity hash or equivalent identity. Finalize on every terminal path, not only acceptance. Keep packets bounded, split repository friction from harness candidates, and forward only to an explicitly configured consumer. Observation/reporting may be automated; policy, hooks, roles, routing, tasks, configuration, and installs never change automatically.
