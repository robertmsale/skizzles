---
name: install-skizzles
description: Choose, install, diagnose, update, or uninstall Skizzles from its canonical repository. Use when a user wants plain Codex skills, the complete Skizzles plugin harness, source-linked hot reload, an isolated copied install, optional Container Lab compatibility checks, or help making a new task pick up an installed version.
---

# Install Skizzles

Keep installation deliberate and reversible. Never mutate a live Codex home, plugin marketplace, `PATH`, Docker, or launchd without the user's explicit approval.

## Choose the installation

- Use plain-skill mode when the user only wants skills. It manages selected directories below an explicit `CODEX_HOME/skills` and never activates hooks or runtime helpers.
- Use full-harness mode only when the user wants the generated Skizzles plugin and accepts that its hooks may become available through the target marketplace.
- Use `link` for a trusted local checkout that should hot-reload source updates. Use `copy` for an isolated snapshot.
- Prefer a versioned release checkout for stable use. Treat `plugins/skizzles` as generated output and build it before a full-harness install.

Confirm the source checkout, absolute target `HOME`, absolute target `CODEX_HOME`, surface, and transfer method before running a non-dry-run command. Use temporary targets for demonstrations and validation. The current skills surface installs every public skill as one owned set.

If this skill was installed by itself with the Skills CLI, do not assume the repository CLI exists beside it. Ask the user to select a Skizzles release or commit, obtain that versioned checkout, verify the checkout, and run every `packages/installer/...` command below from its root.

## Run the lifecycle

From the selected Skizzles checkout, preview first:

```sh
bun run packages/installer/src/cli.ts install \
  --source-root /absolute/path/to/skizzles \
  --codex-home /absolute/target/codex-home \
  --surface skills --transfer link --dry-run
```

For an isolated source-linked development harness, build and check `plugins/skizzles` first, then preview the custom harness surface against an explicit disposable home:

```sh
bun run packages/installer/src/cli.ts install \
  --source-root /absolute/path/to/skizzles \
  --home /absolute/target/home \
  --surface harness --transfer link --dry-run
```

Run the preview again without `--dry-run` only after reviewing its exact targets. Diagnose or remove the receipt-owned install with the same explicit roots:

```sh
bun run packages/installer/src/cli.ts doctor --home /absolute/target/home --codex-home /absolute/target/codex-home
bun run packages/installer/src/cli.ts uninstall --surface skills --codex-home /absolute/target/codex-home --dry-run
bun run packages/installer/src/cli.ts uninstall --surface harness --home /absolute/target/home --dry-run
```

The custom harness surface is for isolated development and test fixtures. Install, update, or uninstall a stable versioned plugin through the official Codex plugin/marketplace flow instead; plugin installs are cached snapshots and a new task may be required. The installer fails closed on foreign targets. Skills receipts live below `CODEX_HOME/.skizzles/`; harness receipts live below `HOME/.skizzles/`. Uninstall verifies receipt-listed links or copied content and restores the exact marketplace state it owned. Do not bypass conflicts by deleting or overwriting paths for the user.

## Use Container Lab deliberately

A skill-only installation contains Container Lab guidance and its launcher contract, not the runnable CLI. The stable Skizzles plugin includes the dependency-self-contained operational and reaper bundles; a selected source checkout includes the canonical workspace package.

Use the `scripts/codex-container-lab` launcher beside the public `codex-container-lab` skill before relying on any `PATH` command. `doctorContainerLab` reports only the optional PATH convenience; bundled ownership paths and source provenance come from `integrations/container-lab.json`. Host PATH and LaunchAgent activation remain explicit, reversible wiring, not part of a skill-only or plugin install.

Read the canonical [Container Lab installation and cutover guide](../../packages/codex-container-lab/docs/installation.md) from the selected checkout or plugin snapshot. Keep doctor health probes on disposable owner/state/runtime roots. Never wrap an attached `run`, invoke live reaping, edit `PATH`, or load launchd from this workflow without a separate explicit cutover approval.

An installed bundle with an unavailable Docker daemon is `installed-not-ready`, not proof that Container Lab is broken. The configured `0.1.0` compatibility is unverified until a release fingerprint is supplied.

## Finish on a new task

Tell the user what was installed, whether it was linked or copied, and where the receipt lives. Start a new Codex task after install or update so the selected skills and hooks are discovered cleanly; never claim the current task hot-reloaded them.
