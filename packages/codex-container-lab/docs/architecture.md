# Architecture

Container Lab is canonical Skizzles source at `packages/codex-container-lab/cli`. The root Skizzles workspace and `bun.lock` own its dependency graph. Stable plugins stage dependency-self-contained Bun bundles at `packages/codex-container-lab/cli/src/{cli,reaper-cli}.ts`; the public skill launcher resolves those same relative paths before any PATH activation.

Codex Container Lab consists of two Skizzles-bundled Bun entrypoints and no MCP server. The PATH binaries are optional explicit host conveniences:

- `codex-container-lab` performs lab, attached command, log, synchronization, and explicit cleanup operations.
- `codex-container-lab-reaper` is a short-lived, one-shot scanner suitable for a per-user macOS LaunchAgent interval.

The ownership unit is the exact current Codex thread id. Unified shell commands receive it as `CODEX_THREAD_ID`; manual callers must pass an explicit owner override. Filesystem directories use a collision-resistant owner hash, while authoritative manifests and every managed Docker/Compose resource retain the exact owner value. An owner may create multiple labs across CLI invocations.

Small owner and lab manifests live in a durable per-user state directory. They record ownership, source checkout, runtime location, Compose identity, lifecycle state, endpoints, safety findings, and managed image identity. Disposable clones, generated Compose files, sync baselines/tokens/journals, and backups live under an injectable temporary runtime root. Tests inject both roots.

Archive cleanup writes a small exact-owner reaped tombstone outside the removable owner directory while holding the shared owner lock. A create queued behind cleanup therefore cannot recreate resources for an already reaped archived identity; manual work must use a new owner identity.

Creation is synchronous: the CLI persists `provisioning`, provisions in the attached process, and records `ready` or a compact `failed` state before returning. Catchable interruption records `failed` after exact cleanup. An uncatchable host termination can leave the durable state at `provisioning`; that manifest and its exact ownership labels remain intentionally destroyable by `lab destroy` and eligible for exact archive cleanup.

Arbitrary commands have exactly one lifecycle. `codex-container-lab run` starts an in-container process group and remains attached while stdout and stderr stream through the normal terminal. Codex unified execution owns background sessions, polling, waiting, stdin, signals, and final exit status. Timeout or host signals trigger bounded in-container process-group termination so an exec cannot be orphaned. The ephemeral run identity is never persisted, and there is no second scheduler. Long-lived application services belong in Compose.

The lifecycle retains one Compose path. Project Compose files remain in the consuming checkout and are passed to Docker in manifest order. Image and Dockerfile modes generate an internal base Compose file. Every mode receives a generated override containing exact labels, the isolated workspace bind, `init`, declared random loopback publications, and non-sensitive lab metadata. Dockerfile mode also applies the exact labels at build time; cleanup verifies them on the tagged image and removes only its validated immutable image id.

Docker runs only on the host. Generated configuration never adds a Docker socket or ambient credentials. The normalized Compose model is inspected for host binds, socket binds, privileged mode, host namespaces, devices, capabilities, secrets, configs, and non-loopback or fixed publications. Findings describe trusted-project configuration; they are not a hostile-project sandbox policy.

Synchronization includes Git-tracked and non-ignored untracked files. It uses a three-way baseline, five-minute single-use preview tokens, digest-based stale checks, transactional backups, recovery journals, and a crash-recoverable per-lab activity lock that excludes attached execution while preview/apply runs. Attached commands use argv after `--`; the configured shell is used only as the container-side launcher needed to establish and clean up the process group.

The public JSON boundary uses compact purpose-built response objects. It never serializes durable lab manifests or runtime configuration. Compose status is reduced to service name/state/health summaries, service log tails have line and byte caps, and internal owner hashes, generated paths, Compose arguments, image bookkeeping, and process identities remain private.

The stable administrative response shapes are:

- `health`: `{ok,dockerAvailable,labs}`
- `lab create`: `{labId,state}`
- `lab list`: `{labs:[{labId,name,state,updatedAt}]}`
- `lab status`: `{labId,name,state,updatedAt,endpoints?,endpointCount?,findings?,findingCount?,error?,stack?}`; bounded arrays expose actionable entries while counts disclose omitted entries, and `stack.services` contains only `{service,state,health?,exitCode?}` summaries
- `lab destroy`: `{labId,destroyed}`; `lab destroy-all`: `{destroyed}`
- `logs`: `{labId,service,transcript:{text,truncated,bytes,lines}}`
- `sync preview`: `{labId,direction,token,expiresAt,changes,conflicts,changeCount,conflictCount,truncated}`; `sync apply`: `{labId,direction,applied}`

Administrative JSON is capped at 16 KiB. Service transcript text is capped at 8 KiB and 500 requested lines. If unusual JSON escaping would exceed the public ceiling, the command fails closed instead of emitting an oversized record. `run` has no JSON footer: its complete output is the attached terminal stream, and Codex's command-output supervisor provides the durable inspection artifact when it compacts a long command.

The reaper writes nothing for a clean scan. A cleanup or exceptional scan emits only `{ok,cleaned,retained,issues?}` with counts, at most six bounded redacted details, and a 1,536-byte ceiling; active owner identities are never listed.

The archive reaper opens Codex's SQLite state database read-only in place so SQLite can read its WAL safely. It validates the required `threads` schema before considering cleanup. A managed owner is eligible only when its exact row consistently has `archived = 1` and `archived_at IS NOT NULL`; the reaper queries the exact row again immediately before cleanup. Active rows, missing rows, inconsistent archive markers, schema mismatch, busy/unavailable/corrupt databases, invalid manifests, and any other uncertainty retain the stack. Cleanup uses exact managed/owner labels and never infers that stopping a process or archiving a different thread ended ownership.
