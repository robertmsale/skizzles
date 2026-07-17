# Installation and eventual cutover

The repository root remains a Codex skill plugin, but operational execution is provided only by the `cli/` Bun package. There is no `.mcp.json`, MCP registration, or stdio server.

Do not perform these steps while evaluating an isolated development branch. They are the eventual cutover procedure after review and merge.

## Prepare the PATH binaries

```sh
cd /path/to/codex-container-lab/cli
bun install --frozen-lockfile
bun link
```

This exposes `codex-container-lab` and `codex-container-lab-reaper`. Confirm that the shell environment used by Codex can resolve both binaries before removing a live MCP registration. The operational CLI inherits the task working directory and obtains the exact current thread from `CODEX_THREAD_ID`.

Codex's `~/.codex/hooks/manage-command-output.ts` must match the outer `codex-container-lab run --lab ... -- COMMAND...` command so the attached stream is supervised. Do not match the inner container argv: `run` intentionally has no JSON footer, and long attached output is retained by that supervisor. This repository does not install or edit the hook.

For a harmless verification in a consuming Git checkout:

```sh
codex-container-lab health
codex-container-lab --help
codex-container-lab-reaper --help
```

Outside Codex, pass `--owner THREAD_ID` to every operational command. Use `--state-root`, `--runtime-root`, and `--db` only for isolated testing or an intentional non-default installation.

## Install the skill plugin

Install or update the repository as a local Codex plugin so `skills/codex-container-lab/SKILL.md` is discovered. The plugin metadata advertises the procedural skill only; it does not register an execution server. Start a new Codex task after changing plugin or skill metadata.

## Configure the archive reaper

The repository contains a LaunchAgent template for periodic one-shot execution. Copy it to a temporary location and replace `__BUN_ABSOLUTE_PATH__` with the absolute Bun interpreter, `__REAPER_ABSOLUTE_PATH__` with this checkout's absolute `cli/src/reaper-cli.ts`, and the two log placeholders with absolute user-owned paths. LaunchAgents have a minimal environment, so the template deliberately does not depend on `PATH` or the script's `/usr/bin/env bun` shebang. Validate the rendered file with `plutil`, then place it in `~/Library/LaunchAgents`. The reaper defaults to `~/.codex/state_5.sqlite` and the per-user durable state root; do not add write flags, database-copy steps, or `immutable=1`.

Only after the CLI and template have been reviewed should an operator load the LaunchAgent. The reaper exits after one scan, so a `StartInterval` LaunchAgent is preferred to a persistent daemon. Any read, schema, busy, manifest, or archive-state uncertainty retains resources and reports an error for the next scheduled retry.

## Cut over from the live MCP installation

1. Finish or preserve any active labs owned by the old MCP session implementation.
2. Merge the reviewed branch and install frozen CLI dependencies.
3. Link the two new binaries and verify PATH resolution from a fresh Codex unified shell.
4. Update/reinstall the local skill plugin and begin a fresh task.
5. Remove the old `codex_container_lab` MCP registration only after the new CLI health check succeeds.
6. Install and validate the LaunchAgent template, then load it deliberately.
7. Confirm an unarchived disposable test owner is retained; archive that test task and confirm only its exact labels are eventually removed.

Never point validation fixtures at a live Codex database or use unrelated Docker resources. Rollback consists of unloading the new LaunchAgent and restoring the prior MCP registration; it does not require changing Codex's database.
