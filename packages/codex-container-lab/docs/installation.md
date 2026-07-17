# Installation and eventual cutover

Container Lab is included in Skizzles. The canonical source package is `packages/codex-container-lab/cli`, the root Skizzles `bun.lock` is its only lockfile, and a stable plugin carries dependency-self-contained CLI and reaper bundles. There is no MCP execution server or registration.

## Use the bundled launcher now

From a Skizzles source checkout, use the public skill launcher without touching `PATH`:

```sh
bun skills/codex-container-lab/scripts/codex-container-lab --help
bun skills/codex-container-lab/scripts/codex-container-lab health
```

The launcher resolves `../../../packages/codex-container-lab/cli/src/cli.ts` from the skill's scripts directory. That relative contract is identical in a source checkout and an installed plugin: source uses the canonical workspace CLI; the plugin uses its bundled, self-contained CLI. For a plugin snapshot, invoke its own `skills/codex-container-lab/scripts/codex-container-lab` file.

Run `bun install --frozen-lockfile` from the Skizzles root before source development. A stable plugin does not need Bun/npm dependency installation for the bundled entrypoints.

The managed-output hook recognizes the launcher’s outer `run --lab ... -- COMMAND...` invocation. Do not match or wrap the inner container argv: `run` intentionally has no JSON footer, and the normal supervisor retains long attached output.

## Optional host wiring — not in this stage

`codex-container-lab` and `codex-container-lab-reaper` PATH binaries are conveniences, not prerequisites. Do not run `bun link`, edit `PATH`, render/load a LaunchAgent, or remove any existing integration until a separate live-cutover approval names exact targets and rollback steps.

When approved, link the canonical workspace package from `packages/codex-container-lab/cli` after a frozen root install. The LaunchAgent template at `cli/install/com.openai.codex-container-lab-reaper.plist` must be rendered into a user-owned temporary file with absolute Bun, bundled-or-canonical reaper, and log paths; validate it with `plutil` before any deliberate load. LaunchAgents have a minimal environment and must not rely on `PATH` or the `/usr/bin/env bun` shebang.

Keep every doctor health probe on disposable owner, state, runtime, and database roots. The archive reaper defaults are live-host behavior and are not a test target. Any database, schema, busy, manifest, or archive-state uncertainty retains resources.

## Eventual cutover and rollback

1. Finish or preserve active labs owned by the previous installation.
2. Rebuild and validate the Skizzles plugin, then verify the bundled launcher from a fresh task.
3. If approved, add the optional PATH links and verify both binary names from the Codex shell.
4. Render, validate, and only then deliberately load the reaper LaunchAgent.
5. Retire the old standalone checkout only after the Skizzles launcher, PATH convenience, and reaper lifecycle have each been proven against isolated fixtures.

The former standalone Container Lab repository is a temporary rollback source until that approval. Rollback restores the previously approved host wiring and unloads any newly loaded LaunchAgent; it never changes Codex’s database or broad Docker state.
