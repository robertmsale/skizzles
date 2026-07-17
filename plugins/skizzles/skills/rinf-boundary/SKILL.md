---
name: rinf-boundary
description: Preserve Flutter Rinf architecture boundaries in projects that use Rinf. Use when changing Flutter UI, Dart state, Rust backend logic, signals/messages, generated Rinf files, networking, persistence, or cross-boundary data flow in a Rinf-based app.
---

# Rinf Boundary

Use this skill only in Flutter projects that use Rinf. The central rule is that Dart UI sends intents to Rust through Rinf signals, and authoritative results flow back over Rinf event streams.

## Boundary Rules

- Do not add ordinary Dart networking for product data when the project uses Rinf for that domain.
- Do not create parallel Dart global state or persistence for data that should hydrate through Rust/Rinf.
- Do not bypass Rust-side source of truth with frontend-only state.
- Keep request/response semantics on the intended signal/event path.
- Client-device preferences such as theme or text size may stay local when the project already treats them as local preferences.

## Signal Changes

When changing Rinf signals/messages:

- update the source signal definitions
- regenerate generated Dart/Rust bindings through the project's sanctioned command
- keep generated files when they are part of the repo contract
- do not discard generated changes as noisy
- inspect call sites on both sides of the boundary

## Implementation Checks

Before finalizing, verify:

- Dart sends intents rather than direct product networking
- Rust owns product data fetching, persistence, or domain authority where expected
- event streams hydrate UI state
- loading/error/empty states map from real Rinf results
- generated files match the source definitions
- tests or manual proof cover both sides when practical

If the project does not use Rinf, do not force this skill onto the architecture.
