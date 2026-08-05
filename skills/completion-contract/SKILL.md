---
name: completion-contract
description: "**MANDATORY validation and completion gate** — use when planning, delegating, implementing, or accepting work, especially when validation is already failing, produces broad or high-volume diagnostics, or might tempt changes to lint, format, test, typecheck, CI, suppression, or quality-gate policy. For source-changing Fourth Wall campaigns, require the ordinary root to dispatch and obtain independent Review of a frozen coherent candidate before accepted, integration-ready, or complete status; the root never self-reviews. This gate does not govern routine pair-programming, read-only, evidence-only, monitoring, or no-code work. Preserve validation strength, classify task-attributable versus repository-red failures, and report systemic baseline cost without silently expanding scope or manufacturing a passing result."
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
Validation baseline:
Repository-red handling:
Known valid blockers:
Unknowns requiring clarification:
```

If an unknown would materially change the contract, ask the user or parent orchestrator instead of silently narrowing scope.

## Independent Review Gate

For every source-changing Fourth Wall campaign, require one mandatory terminal aggregate Review against a frozen coherent candidate before the root may call the work `accepted`, `integration-ready`, or `complete`, regardless of diff size or apparent triviality. The ordinary campaign root owns dispatching the Reviewer and obtaining the independent verdict; it never self-reviews. This is one campaign-level review, not one review per Worker.

Only a cross-root or external integration handoff may use the explicitly labelled `UNREVIEWED CANDIDATE` deferral: the handing root must first freeze a coherent target and name a real upstream root that owns the Review, immutable target, and required scope. Ordinary Worker returns remain unverified completion claims and need not provide a SHA or Review receipt. A root may deliberately freeze and declare a source-level shared or public contract checkpoint; that checkpoint requires an additional Review before downstream consumption. Ordinary Worker or dependency handoffs do not trigger per-Worker review. Tests, builds, QA, screenshots, root inspection, and Worker completion claims are evidence, never substitutes for independent Review. Routine pair-programming, read-only, evidence-only, monitoring, and no-code work remain outside this gate.

## Validation Integrity And Repository-Red Baselines

A passing command is evidence only when the accepted validation contract remains at least as strong as its baseline. Do not manufacture a passing result by disabling checks or formatters, downgrading severity, broadening ignores, adding suppression directives, changing exit behavior, or replacing a canonical command with a weaker one. Treat those as validation-policy changes that require explicit owner approval, not implementation repairs.

When practical, establish the relevant validation baseline before editing. If a gate fails after editing, classify it instead of assuming that every diagnostic belongs to the task:

| Classification | Required response |
|---|---|
| **Task-attributable failure** | Repair it within the owned task, then rerun the affected proof. |
| **Pre-existing bounded failure** | Preserve policy, run the narrowest supported proof for the changed surface, and report the remaining baseline failure without claiming the canonical gate passed. |
| **Large or systemic repository-red failure** | Preserve policy, retain bounded evidence, measure and summarize the repository-health condition, finish only what can be truthfully proved, and recommend a separate cleanup campaign. |

If no pre-edit baseline exists, use touched paths, changed behavior, diagnostic provenance, and repository history to distinguish attribution. Do not silently absorb broad pre-existing cleanup into a small task, and do not reinterpret recently created, modified, or untracked validation configuration as disposable scaffolding. Existing user and collaborator changes retain their ownership regardless of Git tracking state.

Treat the baseline as systemically red when its breadth makes task attribution or useful inline inspection unreliable—for example, diagnostics span many unrelated files or rules, output is truncated or redirected to a managed artifact, or correction would materially exceed the requested ownership boundary. Numeric thresholds are signals rather than policy; a hundred repetitive findings in one generated file may be more bounded than twenty unrelated architectural failures.

For a repository-red handoff, report a compact measurement rather than dumping the transcript:

- Exact command, working directory, tool version when relevant, and exit status.
- Error and warning counts, affected-file count, and touched-surface versus unrelated counts when available.
- A few dominant rule or failure categories without unbounded examples.
- Whether output was truncated and the bounded artifact path, with secrets and private data excluded.
- Which narrower checks passed, which canonical gate remains red, and what therefore remains unverified.
- The expected cost benefit of a dedicated cleanup: faster validation, smaller outputs, clearer attribution, fewer agent turns and retries, and lower risk of accidental suppression.

Repository-red is a health finding, not permission to broaden the current task, automatically create another task, or weaken policy. Recommend cleanup for the owner to deliberate separately.

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
