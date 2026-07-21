# Codex Container Lab

Codex Container Lab is Skizzles' canonical Bun/TypeScript package for disposable Docker Compose development environments. Each Codex thread owns isolated Git workspace clones, guarded synchronization, and exact-label cleanup. There is no MCP execution server or secondary command scheduler.

The root `bun.lock` is authoritative for `cli/`; do not create a nested lockfile. Stable Skizzles plugins carry dependency-self-contained CLI and reaper bundles, and the public skill launcher works before PATH wiring exists.

Project topology belongs to the consuming repository. A committed `.codex-container-lab.yaml` selects existing Compose files and a command service, or uses Dockerfile/image shorthand normalized into the same one-service Compose lifecycle. The engine adds only the isolated workspace mount, exact ownership labels, init behavior, and declared random loopback ports.

Manifests keep `environment` (explicit command-service list-form forwarding) separate from optional `secret_environment` (Compose top-level sources backed by the invoking CLI environment). Secret names are retained for lifecycle bookkeeping; secret values are ephemeral and redacted from generated configuration diagnostics and every public or durable boundary. See the [manifest contract](docs/manifest.md) for the exact rules; the bundled examples leave `secret_environment` empty so they run without credentials.

## Quick start

1. First follow any committed consuming-repository guidance for a project-owned Container Lab wrapper, especially when it supplies manifest `secret_environment` values. Otherwise, from the Skizzles root run `bun skills/codex-container-lab/scripts/codex-container-lab --help` to use the generic bundled launcher without PATH wiring. Read [docs/installation.md](docs/installation.md) before optional host wiring.
2. Copy the closest manifest from `examples/compose`, `examples/dockerfile`, or `examples/image` into a consuming Git repository.
3. From a Codex unified shell, run the selected launcher with `health`, then `lab create --name experiment`. `CODEX_THREAD_ID` supplies the exact owner automatically.
4. Run work with the selected launcher and `run --lab LAB_ID [--cwd REPO_RELATIVE_PATH] -- COMMAND...`, synchronize through that same launcher with `sync preview`/`sync apply`, then explicitly destroy labs. `--cwd` is relative to the repository workspace root (for example `packages/api`), never an absolute container path such as `/workspace/packages/api`. The command stays attached to Codex's unified shell, which owns backgrounding, polling, stdin, signals, and final status. The periodic archive reaper is a crash/abandonment backstop, not the normal lifecycle.

For manual use outside Codex, every operation requires an explicit owner override; the CLI never invents ownership. See the [CLI architecture](docs/architecture.md), [manifest contract](docs/manifest.md), [safety model](docs/safety.md), and binding [completion contract](docs/completion-contract.md). The former standalone checkout is rollback history only and is no longer live authority.
