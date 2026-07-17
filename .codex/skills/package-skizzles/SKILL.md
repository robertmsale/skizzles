---
name: package-skizzles
description: Stage, inspect, and validate the Skizzles versioned plugin from its canonical source tree. Use when changing plugin inputs, checking generated-plugin drift, preparing a reviewable package checkpoint, or diagnosing packaging validation failures.
---

# Package Skizzles

Package from canonical sources only. Treat `plugins/skizzles/` as generated output and never edit it by hand.

## Prepare

1. Inspect `package.json`, `packages/core/plugin-template/.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, and `git status`.
2. Keep the root `.DS_Store` untouched. Remove or relocate Finder metadata and local-state artifacts from package inputs before staging.
3. Do not mutate a live Codex directory, installed plugin, `PATH`, launchd, or Container Lab runtime.

## Stage and verify

1. Run `bun install --frozen-lockfile` when dependencies are not already available.
2. Run `bun run plugin:build` to stage the versioned plugin.
3. Run `bun run plugin:check` to restage into isolation, validate manifest/marketplace/hooks, reject machine paths and Finder metadata, and prove no generated drift.
4. Run `bun test packages/core/test/plugin-package.test.ts` when package logic or canonical inputs changed.
5. Inspect the generated diff. Fix canonical inputs, then rebuild; never patch generated files as the fix.

## Hand off

Report the canonical changes, generated paths affected, commands and results, and any release or live-install decision still required. Do not publish, tag, install, or cut over a live environment without explicit approval.
