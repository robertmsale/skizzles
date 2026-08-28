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

Named `shared_images` profiles are a separate Compose-mode contract. Container Lab fingerprints the declared environment context, takes a digest-scoped lock outside owner directories, and builds through the dedicated `skizzles-shared-image` BuildKit builder from an immutable snapshot of the fingerprinted bytes. The resulting image is tagged `skizzles-shared-image:env-<digest>` and labeled with immutable Skizzles provenance (`managed`, `schema`, `kind`, `profile`, `digest`, `repo`, `platform`, `created-at`). Active leases and last-use timestamps live in `{stateRoot}/shared-images/<digest>.json`, not in image labels. A Lab records the exact reference and acquires a lease inside that digest lock before Compose up, so GC cannot delete the image in an ensure-to-lease gap; successful, failed, cancelled, recovered, and reaped cleanup release that lease only after exact Lab resource removal. `lab destroy` never deletes a shared image or the shared builder cache.

An explicit `runtime.compiler_cache: sccache-redis` opt-in adds one shared
Skizzles-owned Redis container on one external bridge network before Compose
up. The command service keeps its downstream-owned image and command; the
override preserves its project network memberships, adds the external cache
network, and injects only `SCCACHE_REDIS_ENDPOINT`. The cache uses a pinned
Redis digest, bounded eviction settings, no host port, and non-lab labels. A
bounded `shared-cache` finding records the opt-in. Per-lab destroy and archive
cleanup discover only exact lab labels, so they never remove the shared cache.

Manifest `environment` and `secret_environment` are separate allowlists. The former remains list-form forwarding for the command service. The latter authorizes project-owned top-level Compose secret sources shaped as `{ environment: VAR }`; every allowlisted name must be present in the invoking CLI environment, and every environment-backed source in the normalized model must be allowlisted. Only names are retained in normalized configuration and durable manifests. Secret values are supplied ephemerally to Compose config/up, never to generated YAML, argv, state, metadata, findings, errors, or public output. Names shared by the two fields are rejected. A no-interpolation normalized model is checked for declared source-name references in plaintext service environments without value comparison, and Compose diagnostics are replaced with fixed redacted errors.

Docker runs only on the host. Generated configuration never adds a Docker socket or ambient credentials implicitly; `secret_environment` is the explicit ephemeral path for declared Compose secret sources. The normalized Compose model is inspected for host binds, socket binds, privileged mode, host namespaces, devices, capabilities, secrets, configs, and non-loopback or fixed publications. Findings describe trusted-project configuration; they are not a hostile-project sandbox policy.

Synchronization includes Git-tracked and non-ignored untracked files. It uses a three-way baseline, five-minute single-use preview tokens, digest-based stale checks, transactional backups, recovery journals, and a crash-recoverable per-lab activity lock that excludes attached execution while preview/apply runs. Attached commands use argv after `--`; the configured shell is used only as the container-side launcher needed to establish and clean up the process group.

The public JSON boundary uses compact purpose-built response objects. It never serializes durable lab manifests or runtime configuration. Compose status is reduced to service name/state/health summaries, service log tails have line and byte caps, and internal owner hashes, generated paths, Compose arguments, image bookkeeping, and process identities remain private. A failed Compose-up captures one bounded, redacted per-lab artifact before exact Docker cleanup; it may combine lifecycle output with logs only for manifest-backed failed command or declared-port services whose terminal status has a non-zero exited code or unhealthy health. Healthy services, exit-zero services unless unhealthy, and unexposed service logs are excluded. Its optional `evidence` descriptor is an opaque availability record, never a host path. The owner may retrieve the bounded redacted transcript with `lab diagnostic --lab ID` while the lab remains failed. Diagnostic capture is best effort and cannot replace the original provisioning error or block cleanup.

The stable administrative response shapes are:

- `health`: `{ok,dockerAvailable,labs}`. When Docker is unavailable, the
  response additionally includes `dockerDiagnostic: {reason,context?,nextAction}`.
  `reason` is one of `timeout`, `spawn`, `not-found`, `context`, `permission`,
  `daemon`, `unreachable`, or `other`; `context` is included only when the
  active context value is a safe identifier (`[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`),
  and `nextAction` is a fixed actionable hint. Docker stderr, paths, endpoints,
  and environment values are never returned.
- `lab create`: `{labId,state}`
- `lab list`: `{labs:[{labId,name,state,updatedAt}]}`
- `lab status`: `{labId,name,state,updatedAt,endpoints?,endpointCount?,findings?,findingCount?,error?,provisioningFailure?,stack?}`; failed Compose-up records contain only `{phase,capturedAt,services,serviceCount,evidence?}`, where `evidence` is `{kind,available,bytes,lines,truncated}` and never a filesystem path. Bounded arrays expose actionable entries while counts disclose omitted entries, and `stack.services` contains only `{service,state,health?,exitCode?}` summaries
- `lab diagnostic --lab ID`: `{labId,diagnostic:{phase,capturedAt,services,serviceCount,evidence,transcript:{text,truncated,bytes,lines}}}` for an owner-scoped failed lab; it rejects ready labs and never exposes the backing runtime path
- `lab destroy`: `{labId,destroyed}`; `lab destroy-all`: `{destroyed}`
- `logs`: `{labId,service,transcript:{text,truncated,bytes,lines}}`
- `sync preview`: `{labId,direction,token,expiresAt,changes,conflicts,changeCount,conflictCount,truncated}`; `sync apply`: `{labId,direction,applied}`
- `system inventory`: `{ok,labs:{owned,other},labResources:{containers,volumes,networks},sharedImages:{cataloged,present,activeLeases,eligible,bytes,reclaimableBytes,untracked},builderCache:{present,namespaceOwned,bytes,reclaimableBytes?},dockerAvailable}` plus the same optional `dockerDiagnostic` as `health`. Other-owner labs are counted, never identified. Builder-cache bytes are reported only for the verified `skizzles-shared-image` namespace. Shared-image GC eligibility uses the optional `--max-age-hours` and `--budget-bytes` policy inputs.
- `system gc --resource images|cache --mode plan|apply`: image GC returns `{mode,considered,eligible,removed,retained,bytes,findings}`; cache GC returns `{mode,builder,bytes,reclaimableBytes?,applied,findings}`. Findings are bounded codes/details. Apply removes only this state root's cataloged images after digest-lock revalidation and only with `docker image rm --no-prune`. Cache apply prunes only the verified `skizzles-shared-image` builder.

Administrative JSON is capped at 16 KiB. Service transcript text is capped at 8 KiB and 500 requested lines. If unusual JSON escaping would exceed the public ceiling, the command fails closed instead of emitting an oversized record. `run` has no JSON footer: its complete output is the attached terminal stream, and Codex's command-output supervisor provides the durable inspection artifact when it compacts a long command.

The reaper writes nothing for a clean scan. A cleanup or exceptional scan emits only `{ok,cleaned,retained,issues?}` with counts, at most six bounded redacted details, and a 1,536-byte ceiling; active owner identities are never listed.

The archive reaper opens Codex's SQLite state database read-only in place so SQLite can read its WAL safely. It validates the required `threads` schema before considering cleanup. A managed owner is eligible only when its exact row consistently has `archived = 1` and `archived_at IS NOT NULL`; the reaper queries the exact row again immediately before cleanup. Active rows, missing rows, inconsistent archive markers, schema mismatch, busy/unavailable/corrupt databases, invalid manifests, and any other uncertainty retain the stack. Cleanup uses exact managed/owner labels and never infers that stopping a process or archiving a different thread ended ownership.
