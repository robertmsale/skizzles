---
name: release-skizzles
description: Prepare a safe, versioned Skizzles release from canonical source. Use when an approved release version must be aligned across package metadata, rebuilt into the plugin, validated, and handed off for a separate tag, publication, or live cutover decision.
---

# Release Skizzles

Release only from a clean, validated source state. Keep versioning, generated output, and live deployment as distinct decisions.

## Confirm the release contract

1. Obtain the exact target version and release destination from the owner.
2. Inspect the working tree and preserve unrelated changes, including the root `.DS_Store`.
3. Confirm that Container Lab remains external and that no live Codex installation, hook configuration, `PATH`, or launchd state is in scope.

## Align and validate

1. Update the canonical version in `package.json` and `packages/core/plugin-template/.codex-plugin/plugin.json` together.
2. Run `bun run plugin:check` to record expected pre-regeneration drift, then regenerate with `bun run plugin:build`; do not edit `plugins/skizzles/` directly.
3. Run `bun install --frozen-lockfile`, `bunx tsc --noEmit`, `bun test`, and `bun run plugin:check`.
4. Inspect the diff for the intended metadata and generated output only. Resolve drift in canonical sources and rerun validation.

## Release gate

Hand the validated version, evidence, and exact remaining publication/tag/cutover steps to the release owner. Do not create tags, publish artifacts, install the plugin, or change live settings without explicit authorization.
