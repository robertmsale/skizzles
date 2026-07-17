---
name: design-proof-gate
description: Require screenshot-backed proof and production UI quality for frontend, product UI, Flutter, web, design-system, and UX work. Use when implementing, reviewing, or accepting visual changes, layout changes, design polish, responsive screens, component styling, empty/loading/error states, or user-facing copy.
---

# Design Proof Gate

Use this skill for design or frontend work where visual quality matters. Completion is not text-only. The agent must provide inspectable visual proof or a precise reason proof is blocked.

## Required Proof

Final design claims must include:

- screenshot path(s)
- capture method
- viewport or device
- reviewed screen, component, or flow
- scope contract
- content-vs-shell boundary
- fake-data policy
- primary user job
- reference image path, if one exists

If no reference exists, say so and name the approved design direction or user instruction used instead.

For iOS Simulator proof, use `$designer-runtime`. For browser proof, use the browser/runtime tooling available in the current session. Text-only visual review is not sufficient unless the user explicitly accepts that limitation.

## Product Truth

Do not implement fake, decorative, placeholder, or non-functional UI for assigned product behavior.

Controls, inputs, navigation, filters, toggles, copy, loading states, empty states, error states, permission states, unavailable states, saved states, and selected states must either work through the intended product path or truthfully explain unavailable functionality with actionable context.

Mock data is allowed only for a design lab/reference fixture or when the user explicitly authorizes mocked proof.

## Shared Source

Where applicable, proof surfaces and the real application must share the same design-system/source components. Do not fork page bodies just to make screenshots prettier. A design lab is a proof surface, not a separate product implementation.

## Anti-Slop Review

Before claiming completion, inspect the screenshot and answer:

- Is the primary job obvious within three seconds?
- Is there one dominant information/action path?
- Are there nested cards or boxes inside boxes?
- Did a workflow page become a dashboard?
- Are there fake metrics, decorative badges, or analytics panels?
- Is developer/internal copy visible to users?
- Is any prose explaining what layout already communicates?
- Are borders, shadows, radii, padding, or gutters louder than the content?
- Does every container earn its existence?
- Does every sentence earn its existence?
- Is there clipping, overflow, low contrast, broken focus, missing semantics, or unfinished UI?

Any failed answer is a design defect. Fix it before claiming completion or report the exact blocker.

## Strong Defaults

- Avoid nested cards and card-inside-card hierarchy.
- Avoid dashboardification unless metrics are the user's actual job.
- Avoid UUIDs, API paths, enum values, database terms, debug text, fixture names, stack traces, endpoint names, raw booleans, and implementation notes in user-facing UI.
- Avoid marketing filler, repeated helper prose, and obvious explanations.
- Preserve the product's true state over visual fan fiction.
- Keep visual finish production-grade for the target viewport/device.

Report design work in this order: primary job, what changed, how hierarchy works, copy changes, screenshot/runtime evidence, remaining risks.
