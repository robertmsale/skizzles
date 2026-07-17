---
name: no-legacy-cleanup
description: Remove obsolete behavior, tooling, docs, config, tests, scripts, flags, generated artifacts, wrappers, aliases, compatibility paths, and tombstones cleanly. Use when replacing an old system, deleting old harnesses, renaming/removing entrypoints, migrating configs, or preventing legacy code from surviving as disabled or documented leftovers.
---

# No Legacy Cleanup

Use this skill when the assigned area is meant to be clean after replacement or removal. Deletion is the final state.

## Core Rule

Do not preserve obsolete behavior through:

- compatibility wrappers
- aliases
- disabled entrypoints
- hard-error stubs
- tombstone files
- deprecated-but-available routes
- fallback behavior
- old command names
- stale tests
- stale docs
- comments explaining removed paths
- config keys that reserve old names
- generated artifacts from the old path
- UI affordances that still advertise the old behavior

If the user asks to remove or replace something, do not interpret that as “hard-disable but keep discoverable” unless the user explicitly asks for a compatibility period.

## Cleanup Workflow

1. Identify the old names, entrypoints, scripts, routes, config keys, docs, tests, and generated artifacts.
2. Replace behavior through the approved new path.
3. Delete obsolete artifacts rather than redirecting to them.
4. Search for old names and references with `rg`.
5. Update tests/docs only when they describe the new behavior or remain active source of truth.
6. Report final-state evidence: removed paths, old-name search results, and any intentionally retained artifacts with explicit justification.

## Review Questions

- Can a user, agent, script, config, or test still invoke the old path?
- Does any doc or comment still teach the old workflow?
- Did a stale test force preservation of legacy behavior instead of validating the new contract?
- Is there a compatibility shim the user did not ask for?
- Are generated artifacts stale or still reflecting the old schema/path?
- Did the implementation leave “temporarily disabled” code that will confuse the next worker?

If a legacy artifact must remain because of an explicit user decision, document that decision in the final answer and keep the retained surface as narrow as possible.
