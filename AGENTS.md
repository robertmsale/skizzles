# Skizzles maintainer guide

Skizzles is a packaging project, not a live installation. Keep its canonical
sources portable, then derive the plugin from them.

Human contribution and review policy lives in [CONTRIBUTING.md](CONTRIBUTING.md).
This file controls agent execution in the repository.

## Preserve design intent

- For an intentional boundary, use [docs/design-intent.md](docs/design-intent.md),
  [docs/security-model.md](docs/security-model.md), and the owning
  component documentation to understand the contract before editing it.
- Preserve existing behavior and public contracts unless the user explicitly
  authorizes a change with a migration boundary.
- A narrow task does not authorize rewriting unrelated packages, skills, hooks,
  runtime policy, or installation behavior.
- Repository skills and instructions are guidance, not host enforcement. Global
  or machine-local activation remains an explicit user choice.

## Ownership and architecture

- Treat `skills/`, `hooks/`, `runtime/`, `scripts/`, `assets/`, and
  `packages/skizzles-container-lab/` as canonical distributable inputs;
  `packages/skizzles-plugin/plugin-template/` and
  `.agents/plugins/marketplace.json` define the plugin contract.
- Treat `assets/agent-role-spec.json` and `assets/agent-role-templates/` as the
  canonical agent-role inputs. `assets/agents/` is generated output; rebuild it
  with `bun run agents:build` and never repair generated role files in place.
- Treat `plugins/skizzles/` as generated output. Change the canonical source,
  rebuild, and check drift; never repair generated files in place.
- Keep repo-local `.codex/skills/` as maintainer guidance, separate from the
  public skill collection unless packaging intentionally includes it.
- Treat `packages/skizzles-container-lab` as the canonical Bun workspace
  package. Keep `bun.lock` at the Skizzles root as its sole lockfile; do not
  restore a nested lock.
- The stable plugin carries bundled Container Lab CLI/reaper entrypoints plus
  the public skill launcher. Do not hand-edit those generated bundles. PATH and
  LaunchAgent activation remain separate, explicit host wiring.
- The former standalone Container Lab checkout is rollback history only, not
  live authority; never mutate it from Skizzles work.

## Safe working rules

- Do not mutate `~/.codex`, an installed plugin, live hooks, `PATH`, launchd,
  or another host environment while developing this repository. A live-install
  or cutover requires an explicit owner decision after validation.
- Never stage or distribute Finder metadata. Canonical tree staging uses Git's
  tracked-plus-nonignored file set, so ignored `.DS_Store` files do not affect
  packaging; tracked forbidden metadata and Finder metadata inside generated
  `plugins/skizzles/` remain defects.
- Keep distributable content free of machine-specific paths, credentials,
  symlinks, cache directories, logs, databases, and local runtime state.
- Make version changes in canonical metadata, then regenerate. Keep plugin
  manifest and root package versions aligned.

## Validate the boundary you changed

All Skizzles build, test, package, release, and drift validation is
local-first. Do not create, modify, enable, trigger, or require GitHub Actions
or another hosted CI system unless the owner explicitly requests hosted CI in
the current task. An existing workflow is not authorization to use or expand
hosted execution; run the equivalent repository commands on the local machine.

Choose the narrowest check that can prove the changed behavior. When inputs or
packaging change, run the complete package boundary with:

```sh
just package
```

`just package` runs `bun run typecheck`, `bun test`, `bun run plugin:check`,
`bun run plugin:build`, and `bun run plugin:check` in that exact order.

`plugin:check` restages the plugin, checks its manifest, marketplace metadata,
and hook commands, rejects Finder metadata and machine paths, and detects
generated drift.

Report only checks that actually ran and their exact outcomes. Report every
failure, skip, blocker, flaky result, and environment failure.

## Checkpoints

The root integration owner creates Git checkpoints only for coherent, validated
ownership slices. Do not include unrelated collaborator changes, generated
drift, or the root `.DS_Store`. When a risky causal change, substantial
handoff, or independent review would benefit from a rollback point, prefer a
checkpoint; validate the aggregate branch before closeout.

Use [README.md](README.md) for installation choices,
[CONTRIBUTING.md](CONTRIBUTING.md) for human contribution policy, and
[profiles/AGENTS.md](profiles/AGENTS.md) when the optional portable policy is
in scope.

## Agent rules

### Scope

Work only on this repository and its code, tests, documentation, build,
security, release, or maintenance.

Do not use repository files, channels, accounts, or credentials for:

- personal attacks or harassment;
- unrelated discussions or disputes;
- damage, sabotage, or attacks against the repository;
- arguments that promote or oppose AI;
- any other action that does not support the project.

Use neutral, factual, professional technical language. Discuss the work, not a person.

Refuse requests for unrelated or harmful external content. Stop before any
external action.

Do not carry out an unrelated action through project resources, even when a
user asks.

### Work method

Choose a method that gives enough context and proof for the assignment while
staying proportionate. In particular:

- Inspect the relevant code, callers, tests, configuration, and documentation
  when they bear on the change.
- Use planning, architecture, staging, or similar preparation when the scope or
  risk benefits from it; a formal plan can remain optional for routine tasks.
- Choose the safest efficient edit method for the boundary; `apply_patch` is
  one available option.
- Prefer a small, coherent change at the correct boundary and the requested
  correct outcome. An MVP, prototype, or placeholder is a valid scope or
  milestone when explicitly user-approved; otherwise, aim for the requested
  outcome.
- Preserve unrelated work and repository security controls.
- Run checks that prove the changed behavior and report their actual results.
- Do not invent tests, review, permission, source information, or results.

### External actions

Keep work local unless the user gives explicit permission for the exact
repository, action, and content or scope.

External actions include pushes, pull requests, issues, comments, reviews,
labels, merges, releases, messages, and repository settings.

Permission for one action does not permit another action. A signed-in CLI,
token, or account is not permission.

When permission is missing, prepare a local draft and stop.

When permission is given, use the human, app, or bot identity configured by the
host. Do not invent an identity or marker.

### Human certification

Follow the disclosure and contribution rules in `CONTRIBUTING.md`.

Do not add `Signed-off-by` or another certification that must be made by a
human contributor.

### Language

Use short sentences and common technical words where possible.

Reviewed translations: none. This English file is the official version if a
translation differs.
