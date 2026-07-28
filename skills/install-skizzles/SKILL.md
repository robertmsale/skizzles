---
name: install-skizzles
description: Choose, install, diagnose, update, or uninstall Skizzles from its canonical repository. Use when a user wants plain Codex skills, the complete Skizzles plugin harness, source-linked hot reload, an isolated copied install, optional Container Lab compatibility checks, or help making a new task pick up an installed version.
---

# Install Skizzles

Keep installation deliberate and reversible. Never mutate a live Codex home, plugin marketplace, `PATH`, Docker, or launchd without the user's explicit approval.

## Choose the installation

- Use plain-skill mode when the user only wants skills. It manages selected directories below an explicit `CODEX_HOME/skills` and never activates hooks or runtime helpers.
- Use full-harness mode only when the user wants the generated Skizzles plugin and accepts that its hooks may become available through the target marketplace.
- After the complete plugin surface is installed, choose `passive` orchestration to enable hooks without overriding Codex's native MultiAgentV2 defaults, or `aggressive` orchestration to activate proactive Fourth Wall routing.
- Use `link` for a trusted local checkout that should hot-reload source updates. Use `copy` for an isolated snapshot.
- Prefer a versioned release checkout for stable use. Treat `plugins/skizzles` as generated output and build it before a full-harness install.

Confirm the source checkout, absolute target `HOME`, absolute target `CODEX_HOME`, surface, and transfer method before running a non-dry-run command. Use temporary targets for demonstrations and validation. The current skills surface installs every public skill as one owned set.

The complete plugin bundles the installer at `packages/installer/`; run the commands below from the plugin root or a selected source checkout. If this skill was installed by itself with the Skills CLI, do not assume that package exists beside it. Ask the user to select a Skizzles release or commit, obtain and verify that versioned checkout, then run the installer from its root.

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

## Complete the Codex configuration

Only run this lifecycle after the complete plugin surface—and therefore its packaged hook—has been installed. It is independent from skill/plugin file transfer so a user can change machine policy without reinstalling content.

Ask the user to choose an orchestration mode:

- `passive` writes only `features.hooks = true`. It does not write any MultiAgentV2 setting or hint, so Codex retains its model-specific native defaults.
- `aggressive` also enables MultiAgentV2, sets `max_concurrent_threads_per_session = 14`, adds one concise proactive mode hint, and gives roots and subagents short pointers to `$fourth-wall`. Fourteen is a ceiling for bounded parallel ownership, not a target. Use this only when the user wants autonomous quality-and-speed delegation.

Also ask whether Codex should keep its native model instructions or use the Skizzles split:

- `native` is the default and does not write instruction or agent-role config.
- `skizzles` writes the canonical root prompt to `model_instructions_file` and configures the seven fixed native roles advertised by `assets/agents/manifest.json`. Generated role files combine one behavioral duty with one durable model/reasoning pair, share `skizzles_subagent_instructions.md`, and add duty-specific `developer_instructions`. This mode requires an absolute `--source-root` whose assets remain available after installation.

With the Skizzles split, select the generated `agent_type`, omit independent model/reasoning overrides, and use `fork_turns="none"` or a positive integer. A positive integer larger than the available history retains all available turns without becoming full-history mode. Do not use `fork_turns="all"`: full-history spawning inherits the parent role and deliberately bypasses selected-role application.

Preview against an explicit `CODEX_HOME` and absolute Codex binary:

```sh
bun run packages/installer/src/cli.ts configure \
  --codex-home /absolute/target/codex-home \
  --codex-binary /absolute/path/to/codex \
  --orchestration aggressive \
  --instructions skizzles \
  --source-root /absolute/path/to/skizzles \
  --dry-run
```

Review the reported key list, then repeat without `--dry-run`. Restore the exact prior values with:

```sh
bun run packages/installer/src/cli.ts unconfigure \
  --codex-home /absolute/target/codex-home \
  --codex-binary /absolute/path/to/codex --dry-run
```

Repeat restoration without `--dry-run` only after previewing it. The lifecycle launches that Codex binary's app-server against the selected home and uses native `config/read` plus atomic `config/batchWrite` with version-conflict detection. Its receipt lives at `CODEX_HOME/.skizzles/config-receipt.json`; restoration fails closed if an owned value drifted. It never edits `AGENTS.md`, `developer_instructions`, approvals, permissions, goals, model defaults, MCP registrations, or unrelated feature flags. With `--instructions skizzles`, it additionally owns `model_instructions_file` and the generated Skizzles roles listed by the manifest. To restore configuration shape cleanly, the receipt owns the entire `agents` table when it was initially absent, an entire named-role table when that role was initially absent, or only `description` and `config_file` leaves when preserving an existing customized role. Later edits inside a structurally owned table are treated as drift and block restoration. Do not manually delete the receipt to bypass a conflict.

Configuration upgrades are an explicit restore-and-reapply lifecycle because `configure` refuses to overwrite an active receipt. Preview `unconfigure` with the absolute Codex binary recorded in the receipt, run it only when the owned values are drift-free, preview the new `configure`, then apply it. Do not delete or rewrite the receipt by hand; that discards the exact restoration boundary Skizzles uses to preserve unrelated config.

Maintainers edit `assets/agent-role-spec.json` for model/reasoning pairs and `assets/agent-role-templates/*.toml` for behavioral duties. Run `bun run agents:build` to regenerate `assets/agents/`, and `bun run agents:check` to detect drift. Never hand-edit generated role TOML or its manifest.

## Optionally configure a learning consumer

Fourth Wall emits a bounded campaign-close learning packet under `/tmp/skizzles-orchestration/<campaign-id>/learning/campaign-close.md`. This is evidence, not an automatic harness change. If the user explicitly wants harness learning forwarded, guide them to:

1. Choose an existing local project whose owner can evaluate orchestration behavior. A versioned checkout of the official OpenAI Codex repository is a useful recommendation when the consumer must inspect harness implementation, but it is never a prerequisite.
2. Choose a stable consumer naming or epoch convention and record the routing in machine-local instructions (for example, `AGENTS.md`) by an explicit user action.
3. Forward only the bounded packet or its path after the user confirms the unique consumer and destination.

The installer must not clone or modify a repository, edit `AGENTS.md`, create or message tasks, or guess when a consumer is absent or ambiguous. Report the packet to the human owner instead. Consumer review may propose changes, but promotion into Skizzles skills, roles, routing, hooks, configuration, or installs always requires separate owner deliberation.

## Use Container Lab deliberately

A skill-only installation contains Container Lab guidance and its launcher, not the runnable CLI. Its launcher uses a distinct installed `codex-container-lab` PATH binary when one exists; otherwise it exits with a compact instruction to obtain the full Skizzles plugin or source checkout. The stable Skizzles plugin includes the dependency-self-contained operational and reaper bundles; a selected source checkout includes the canonical workspace package.

Use the `scripts/codex-container-lab` launcher beside the public `codex-container-lab` skill before relying on any `PATH` command. `doctorContainerLab` reports only the optional PATH convenience; bundled ownership paths and source provenance come from `integrations/container-lab.json`. Host PATH and LaunchAgent activation remain explicit, reversible wiring, not part of a skill-only or plugin install.

Read the canonical [Container Lab installation and optional host-wiring guide](../../packages/codex-container-lab/docs/installation.md) from the selected checkout or plugin snapshot. Keep doctor health probes on disposable owner/state/runtime roots. Never wrap an attached `run`, invoke live reaping, edit `PATH`, or load launchd as part of a skill/plugin install; host wiring is separate, explicit, reversible, and machine-local.

An installed bundle with an unavailable Docker daemon is `installed-not-ready`, not proof that Container Lab is broken. The configured `0.1.0` compatibility is unverified until a release fingerprint is supplied.

## Enable the optional Luna V2 catalog

Skizzles includes `runtime/model-catalog.ts` and `assets/com.openai.skizzles-model-catalog.plist` for owners who have independently verified Luna with MultiAgentV2. This is explicit host wiring, not part of ordinary skill/plugin installation.

Read `assets/model-catalog-installation.md` from the selected source checkout or plugin snapshot. The generator preserves the full upstream model catalog and changes only `gpt-5.6-luna.multi_agent_version` from `v1` to `v2`. It never reads or copies credentials. It accepts only a fresh, version-matched, complete `CODEX_HOME/models_cache.json`, otherwise uses the selected Codex binary's bundled catalog, and preflights the result through that binary before promotion.

Render and validate the LaunchAgent before loading it, then set the global `model_catalog_json` to the generated absolute path. A generated catalog is applied only at app-server startup; restart app-server after a refresh reports `catalogChanged: true`. The status `generation` is the stable catalog identity, while `catalogChanged` describes only its most recent refresh. Do not restart Desktop or app-server automatically while tasks are active. If upstream already marks Luna V2, the overlay reports `upstream-v2` and leaves that field unchanged.

## Finish on a new task

Tell the user what was installed, whether it was linked or copied, which instruction mode was selected, and where the receipt lives. Restart app-server after changing model instructions, then start a new Codex task so the selected config, skills, hooks, and role prompt are discovered cleanly; never claim the current task hot-reloaded them.
