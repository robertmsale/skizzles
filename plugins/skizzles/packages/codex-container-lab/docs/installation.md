# Installation and optional host wiring

Container Lab is included in Skizzles. The canonical source package is `packages/codex-container-lab/cli`, the root Skizzles `bun.lock` is its only lockfile, and a stable plugin carries dependency-self-contained CLI and reaper bundles. There is no MCP execution server or registration.

## Use the bundled launcher now

From a Skizzles source checkout or installed full plugin, use its resolved public skill launcher without touching `PATH`. The literal outer launcher path lets the managed-output hook recognize attached `run` commands; do not hide it behind a shell variable:

```sh
/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab --help
/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab health
/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab --owner thread-id --state-root /tmp/ccl-state --runtime-root /tmp/ccl-runtime run --lab lab-id -- echo hello
```

The launcher resolves `../../../packages/codex-container-lab/cli/src/cli.ts` from the skill's scripts directory. That relative contract is identical in a source checkout and an installed plugin: source uses the canonical workspace CLI; the plugin uses its bundled, self-contained CLI. For a plugin snapshot, invoke its own `skills/codex-container-lab/scripts/codex-container-lab` file.

Run `bun install --frozen-lockfile` from the Skizzles root before source development. A stable plugin does not need Bun/npm dependency installation for the bundled entrypoints.

The managed-output hook recognizes the launcher’s outer `run --lab ... -- COMMAND...` invocation, including the supported `--owner`, `--state-root`, and `--runtime-root` globals before `run`. Keep the launcher and its pre-run globals literal and unquoted so the hook can classify them; do not match or wrap the inner container argv: `run` intentionally has no JSON footer, and the normal supervisor retains long attached output.

## Optional host wiring — machine-local and reversible

`codex-container-lab` and `codex-container-lab-reaper` PATH binaries are conveniences, not prerequisites. Host wiring is separate from skill/plugin installation: it is an explicit, reversible, machine-local operation with a recorded rollback target. Do not alter broad Codex hooks/configuration, Docker state, or SQLite while setting it up.

When requested by the host owner, link the canonical workspace package from `packages/codex-container-lab/cli` after a frozen root install. The LaunchAgent template at `cli/install/com.openai.codex-container-lab-reaper.plist` must be rendered into a user-owned temporary file with absolute Bun, bundled-or-canonical reaper, and log paths; validate it with `plutil` before loading. LaunchAgents have a minimal environment and must not rely on `PATH` or the `/usr/bin/env bun` shebang.

Keep every doctor health probe on disposable owner, state, runtime, and database roots. The archive reaper defaults are live-host behavior and are not a test target. Any database, schema, busy, manifest, or archive-state uncertainty retains resources.

## Verification and rollback

1. Finish or preserve active labs owned by the previous installation.
2. Rebuild and validate the Skizzles plugin, then verify the bundled launcher from a fresh task.
3. If approved, add the optional PATH links and verify both binary names from the Codex shell.
4. Render, validate, and only then deliberately load the reaper LaunchAgent.
5. Keep the former standalone checkout only as rollback history until an explicit cleanup decision; it is not live authority.

The former standalone Container Lab repository may be retained as a rollback source. Rollback restores the recorded host wiring and unloads any newly loaded LaunchAgent; it never changes Codex’s database or broad Docker state.
