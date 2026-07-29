# Installation and optional host wiring

Container Lab is included in Skizzles. The canonical source package is `packages/skizzles-container-lab`, the root Skizzles `bun.lock` is its only lockfile, and a stable plugin carries dependency-self-contained CLI and reaper bundles. There is no MCP execution server or registration.

## Select the project wrapper or generic launcher

First inspect the consuming repository's committed agent guidance, development documentation, and manifest-adjacent scripts. If it documents a required project-owned Container Lab wrapper, prefer that wrapper consistently for lifecycle, run, logs, sync, and destroy operations. A wrapper may be required to safely materialize values allowlisted by the manifest's `secret_environment`; bypassing it with the generic launcher can omit that setup. Follow the wrapper's documented interface without extracting secret values or reproducing its secret-loading implementation. The wrapper must preserve attached-run argv, stdin, signals, and exit status plus sync preview/apply token semantics. An arbitrary wrapper is not recognized as the generic launcher by Container Lab-specific managed-output classification, so its output may remain normal passthrough.

When no project wrapper is documented, use the resolved public skill launcher from a Skizzles source checkout or installed full plugin without touching `PATH`. The literal outer launcher path lets the managed-output hook recognize attached `run` commands; do not hide it behind a shell variable:

```sh
/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab --help
/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab health
/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab --owner thread-id --state-root /tmp/ccl-state --runtime-root /tmp/ccl-runtime run --lab lab-id --cwd packages/api -- bun test
```

`run --cwd` is always relative to the isolated repository workspace root. Use `.` or a repository path such as `packages/api`; never pass the configured absolute container workspace (for example `/workspace`) or any other absolute container path.

The launcher resolves `../../../packages/skizzles-container-lab/src/cli.ts` from the skill's scripts directory. That relative contract is identical in a source checkout and an installed plugin: source uses the canonical workspace CLI; the plugin uses its bundled, self-contained CLI. For a plugin snapshot, invoke its own `skills/codex-container-lab/scripts/codex-container-lab` file.

Run `bun install --frozen-lockfile` from the Skizzles root before source development. A stable plugin does not need Bun/npm dependency installation for the bundled entrypoints.

The managed-output hook recognizes a literal `run --lab ... -- COMMAND...` invocation, including the supported `--owner`, `--state-root`, and `--runtime-root` globals before `run`, when it also recognizes the inner argv as a safe noisy build or test command. Keep the launcher, its pre-run globals, and the inner program and action literal and unquoted so the hook can classify them. The hook does not rewrite unsafe or ambiguous payloads; they receive no managed-output wrapper and pass through to normal native handling.

## Optional host wiring — machine-local and reversible

`codex-container-lab` and `codex-container-lab-reaper` PATH binaries are conveniences, not prerequisites. Host wiring is separate from skill/plugin installation: it is an explicit, reversible, machine-local operation with a recorded rollback target. Do not alter broad Codex hooks/configuration, Docker state, or SQLite while setting it up.

When requested by the host owner, link the canonical workspace package from `packages/skizzles-container-lab` after a frozen root install. The LaunchAgent template at `install/com.openai.codex-container-lab-reaper.plist` must be rendered into a user-owned temporary file with absolute Bun, bundled-or-canonical reaper, and log paths; validate it with `plutil` before loading. LaunchAgents have a minimal environment and must not rely on `PATH` or the `/usr/bin/env bun` shebang.

Keep every doctor health probe on disposable owner, state, runtime, and database roots. The reaper defaults are live-host behavior and are not a test target. Archive and seven-day active-owner retention both fail closed: any database, schema, busy, manifest, lease, clock, or archive-state uncertainty retains resources.

## Verification and rollback

1. Finish or preserve active labs owned by the previous installation.
2. Rebuild and validate the Skizzles plugin, then verify the bundled launcher from a fresh task.
3. If approved, add the optional PATH links and verify both binary names from the Codex shell.
4. Render, validate, and only then deliberately load the reaper LaunchAgent.
5. Keep the former standalone checkout only as rollback history until an explicit cleanup decision; it is not live authority.

The former standalone Container Lab repository may be retained as a rollback source. Rollback restores the recorded host wiring and unloads any newly loaded LaunchAgent; it never changes Codex’s database or broad Docker state.
