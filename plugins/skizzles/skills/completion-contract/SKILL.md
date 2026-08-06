---
name: completion-contract
description: "**MANDATORY validation and completion gate** — use before a completion or acceptance decision when meaningful validation is required, validation fails or is repository-red/broad, or a lint/format/test/typecheck/CI/suppression policy change is contemplated. Preserve validation strength, classify task-attributable versus repository-red failures, and report systemic baseline cost without silently expanding scope or manufacturing a passing result. For Fourth Wall review and checkpoint lifecycle, use $fourth-wall. Do not use for routine pair-programming, read-only, evidence-only, monitoring, or no-code work."
---

# Completion Contract

Use this skill before a completion or acceptance decision when its trigger applies. A completion contract is not a general planning, delegation, estimate, suggestion list, or escape hatch; it is the smallest explicit statement of what must be true before the work can be called done.

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

## Fourth Wall Review And Checkpoints

For source-changing Fourth Wall campaigns, `$fourth-wall` owns the mandatory terminal aggregate Review, frozen-candidate and quiescence protocol, checkpoint commits, repair/re-review loop, resource ledger, and terminal disposition. Do not call a campaign `accepted`, `integration-ready`, or `complete` without that skill's independent Review receipt. This skill owns the validation contract and does not create per-Worker commits, extra branches, or a second review lifecycle.

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

## Delegation Scope

When Fourth Wall applies, use its dispatch and ownership contract for decomposition, peer routing, and worker persistence. Delegated packages still must cover the full responsibility of their boundary and map back to the top-level outcome; do not relabel a first, easiest, best-effort, or docs-only slice as completion. This skill does not define the role graph.

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

## Campaign Lifecycle

For Fourth Wall work, follow `$fourth-wall` for quiescence, immutable candidate freezing, root-owned Git checkpoints, independent Review/QA, additive repairs, resource release, and campaign close. A goal tracks the outcome; it is not a substitute for those acceptance gates. For non-Fourth-Wall work, retain the user's or repository's ordinary checkpoint and validation rules.
