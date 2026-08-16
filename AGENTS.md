# Skizzles maintainer guide

Skizzles is a packaging project, not a live installation. Keep its canonical sources portable, then derive the plugin from them.

## Ownership and architecture

- Treat `skills/`, `hooks/`, `runtime/`, `scripts/`, `assets/`, `packages/codex-container-lab/`, and `packages/t3-orchestration/` as canonical Codex-plugin inputs; `packages/core/plugin-template/` and `.agents/plugins/marketplace.json` define that plugin contract.
- Treat `grok/` as the canonical Grok Build harness source. It is installed independently and must not be staged into the Codex plugin.
- Treat `assets/agent-role-spec.json` and `assets/agent-role-templates/` as the canonical agent-role inputs. `assets/agents/` is generated output; rebuild it with `bun run agents:build` and never repair generated role files in place.
- Treat `plugins/skizzles/` as generated output. Change the canonical source, rebuild, and check drift; never repair generated files in place.
- Keep repo-local `.codex/skills/` as maintainer guidance, separate from the public skill collection unless packaging intentionally includes it.
- Treat `packages/codex-container-lab/cli` as the canonical Bun workspace package. Keep `bun.lock` at the Skizzles root as its sole lockfile; do not restore a nested lock.
- The stable plugin carries bundled Container Lab CLI/reaper and T3 orchestration CLI/daemon entrypoints plus their public skill launchers. Do not hand-edit those generated bundles. PATH, LaunchAgent, Keychain, and Tailscale activation remain separate, explicit host wiring.
- The former standalone Container Lab checkout is rollback history only, not live authority; never mutate it from Skizzles work.

## Safe working rules

- Do not mutate `~/.codex`, an installed plugin, live hooks, `PATH`, launchd, or another host environment while developing this repository unless the owner has granted installation authority. For Robert's source-linked development environment, treat each completed Skizzles change as requiring installation of its affected live surface after validation; use the narrowest reversible installation, verify it, and report the exact target. This standing authority does not cover unrelated host wiring, broad configuration changes, credentials, Docker state, launchd, or production.
- Never stage or distribute Finder metadata. Canonical tree staging uses Git's tracked-plus-nonignored file set, so ignored `.DS_Store` files do not affect packaging; tracked forbidden metadata and Finder metadata inside generated `plugins/skizzles/` remain defects.
- Keep distributable content free of machine-specific paths, credentials, symlinks, cache directories, logs, databases, and local runtime state.
- Make version changes in canonical metadata, then regenerate. Keep plugin manifest and root package versions aligned.

## Validate the boundary you changed

All Skizzles build, test, package, release, and drift validation is local-first. Do not create, modify, enable, trigger, or require GitHub Actions or another hosted CI system unless the owner explicitly requests hosted CI in the current task. An existing workflow is not authorization to use or expand hosted execution; run the equivalent repository commands on the local machine.

Run the narrowest useful check first, then use the complete package boundary when inputs or packaging change:

```sh
bun run typecheck
bun test
bun run plugin:check
bun run plugin:build
bun run plugin:check
```

`plugin:check` restages the plugin, validates its manifest, marketplace metadata and hook commands, rejects Finder metadata and machine paths, and detects generated drift.

## Checkpoints

The root integration owner creates Git checkpoints only after a coherent ownership slice has passed focused validation. Do not include unrelated collaborator changes, generated drift, or the root `.DS_Store`. Checkpoint before risky causal changes, a substantial handoff, or independent review; validate the aggregate branch before closeout.

Read [README.md](README.md) for installation choices and [profiles/AGENTS.md](profiles/AGENTS.md) for the optional portable policy.
