# Skizzles maintainer guide

Skizzles is a packaging project, not a live installation. Keep its canonical sources portable, then derive the plugin from them.

## Ownership and architecture

- Treat `skills/`, `hooks/`, `runtime/`, `scripts/`, and `assets/` as canonical distributable inputs; `packages/core/plugin-template/` and `.agents/plugins/marketplace.json` define the plugin contract.
- Treat `plugins/skizzles/` as generated output. Change the canonical source, rebuild, and check drift; never repair generated files in place.
- Keep repo-local `.codex/skills/` as maintainer guidance, separate from the public skill collection unless packaging intentionally includes it.
- Keep Container Lab external. Do not vendor, relocate, launch, or update it from this repository.

## Safe working rules

- Do not mutate `~/.codex`, an installed plugin, live hooks, `PATH`, launchd, or another host environment while developing this repository. A live-install or cutover requires an explicit owner decision after validation.
- Preserve the tracked root `.DS_Store`; never stage, normalize, or distribute it. Finder metadata anywhere in package inputs or `plugins/skizzles/` is a defect.
- Keep distributable content free of machine-specific paths, credentials, symlinks, cache directories, logs, databases, and local runtime state.
- Make version changes in canonical metadata, then regenerate. Keep plugin manifest and root package versions aligned.

## Validate the boundary you changed

Run the narrowest useful check first, then use the complete package boundary when inputs or packaging change:

```sh
bunx tsc --noEmit
bun test
bun run plugin:check
bun run plugin:build
bun run plugin:check
```

`plugin:check` restages the plugin, validates its manifest, marketplace metadata and hook commands, rejects Finder metadata and machine paths, and detects generated drift.

## Checkpoints

The root integration owner creates Git checkpoints only after a coherent ownership slice has passed focused validation. Do not include unrelated collaborator changes, generated drift, or the root `.DS_Store`. Checkpoint before risky causal changes, a substantial handoff, or independent review; validate the aggregate branch before closeout.

Read [README.md](README.md) for installation choices and [profiles/AGENTS.md](profiles/AGENTS.md) for the optional portable policy.
