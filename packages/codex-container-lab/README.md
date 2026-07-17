# Codex Container Lab

Codex Container Lab is a PATH-oriented Bun/TypeScript CLI for disposable Docker Compose development environments. Each Codex thread owns isolated Git workspace clones, guarded synchronization, and exact-label cleanup. There is no MCP execution server or secondary command scheduler.

Project topology belongs to the consuming repository. A committed `.codex-container-lab.yaml` selects existing Compose files and a command service, or uses Dockerfile/image shorthand normalized into the same one-service Compose lifecycle. The engine adds only the isolated workspace mount, exact ownership labels, init behavior, and declared random loopback ports.

## Quick start

1. Follow [docs/installation.md](docs/installation.md) to prepare the two PATH binaries without changing a live installation during development.
2. Copy the closest manifest from `examples/compose`, `examples/dockerfile`, or `examples/image` into a consuming Git repository.
3. From a Codex unified shell, run `codex-container-lab health`, then `codex-container-lab lab create --name experiment`. `CODEX_THREAD_ID` supplies the exact owner automatically.
4. Run work with `codex-container-lab run --lab LAB_ID -- COMMAND...`, synchronize through `sync preview`/`sync apply`, then explicitly destroy labs. The command stays attached to Codex's unified shell, which owns backgrounding, polling, stdin, signals, and final status. The periodic archive reaper is a crash/abandonment backstop, not the normal lifecycle.

For manual use outside Codex, every operation requires an explicit owner override; the CLI never invents ownership. See the [CLI architecture](docs/architecture.md), [manifest contract](docs/manifest.md), [safety model](docs/safety.md), and binding [completion contract](docs/completion-contract.md).
