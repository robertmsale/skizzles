# Completion contract

Outcome: a complete, version-controlled, script-only Codex plugin companion that gives each exact Codex thread multiple disposable Docker Compose labs with isolated Git clones, one attached command path, guarded bidirectional synchronization, deterministic exact-label cleanup, and archive-aware crash recovery.

Approved implementation path: Bun, TypeScript, Git, host-side Docker Compose, atomic durable JSON lab manifests, synchronous attached CLI execution, and Bun's SQLite reader in strict read-only mode. A consuming repository commits `.codex-container-lab.yaml`. Compose mode uses project-owned topology; Dockerfile and image modes share the same generated Compose lifecycle.

Non-negotiable constraints:

- Provide PATH-oriented operational and reaper binaries with no MCP transport, registration, compatibility wrapper, or session lifecycle.
- Resolve ownership from `CODEX_THREAD_ID`, with an explicit owner override for manual use and no generated fallback identity.
- Keep small authoritative owner/lab manifests durable across reboot; keep disposable workspaces, generated files, and sync state under an injectable temporary root.
- Preserve the consuming Codex task checkout, including Desktop linked worktrees, and support multiple isolated labs per owner.
- Provide exactly one arbitrary command lifecycle: attached `run` with argv after `--`, prompt stdout/stderr, stdin, timeout, final exit propagation, and in-container process-group cleanup on interruption. Unified execution owns backgrounding and polling; persistent services belong in Compose.
- Provision synchronously while persisting recoverable lab lifecycle transitions; retain no secondary lifecycle protocol.
- Preserve conflict-aware push and pull preview/apply with expiring single-use tokens, stale rejection, and transactional recovery.
- Generate overrides without rewriting project Compose files. Add only the workspace mount, exact labels, init behavior, declared random loopback ports, and non-sensitive metadata.
- Never synthesize Docker sockets, credentials, sensitive mounts, privilege escalation, language toolchains, databases, object stores, caches, or project ports.
- Inspect notable privilege surfaces without rejecting intentional trusted-project configuration.
- Make cleanup idempotent, bounded, and exact-label scoped. Never use Docker prune, broad prefixes, or unrelated resources.
- Open Codex's SQLite state database read-only, coexist with WAL, validate schema, require a consistent exact archived owner row, recheck before cleanup, and retain resources on missing rows or uncertainty.
- Keep stopped but unarchived root tasks and subagents intact. Never infer descendant state from a parent row.
- Expose only compact purpose-built public DTOs. Never serialize durable lab metadata, internal owner keys, runtime configuration, Compose arguments, generated absolute paths, image bookkeeping, or process identities. Bound service status and logs by structure, lines, bytes, and final serialized size.

Disallowed alternatives: project-specific topology, an image-only lifecycle fork, source Compose rewrites, host checkout bind-mounting, unbounded output, sync without preview tokens, compatibility aliases or tombstones, a secondary execution lifecycle, lease expiry as ownership proof, database mutation, cleanup based on missing rows, and documentation standing in for implementation.

Regression expectations: unit tests cover contracts, workspace discovery, Compose generation/inspection, attached streaming and signal cleanup, synchronous provisioning recovery, durable state, owner resolution, compact/redacted output budgets, exact-label cleanup, sync conflicts/staleness/recovery, and archive reaping. Reaper tests use only explicitly injected temporary SQLite fixtures and cover active, archived, inconsistent, missing, schema-mismatch, unavailable/busy, recheck, and WAL cases. CLI validation proves help, argument errors, owner requirements, argv parsing, streaming exit behavior, compact JSON, cross-process persistence, and harmless health calls. Serialized Docker integration may use only uniquely labeled disposable fixtures when Docker is available.

Evidence expected: parsed manifests and plugin metadata, frozen lock, TypeScript typecheck, unit tests, CLI smoke, reaper fixture tests, exact cleanup-filter mocks, output-size measurements, repository-wide obsolete-surface searches, optional safe Docker integration result, clean Git status, and coherent forward-progress commits.

Known valid blockers: unavailable Docker daemon, registry/network access required for a uniquely labeled integration image, or host permissions outside this worktree. These may limit external runtime evidence but cannot narrow implementation or local validation.
