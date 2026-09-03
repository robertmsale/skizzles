# OMP orchestration

`@skizzles/omp-orchestration` is a Bun daemon and JSON CLI for running one
long-lived Oh My Pi maintainer agent per registered Git project. It is a native
OMP RPC v2 host with no third-party web-session dependency.

The maintainer keeps project context and delegates code work through OMP's
native `task` tool. OMP snapshots each worker into an APFS copy-on-write clone,
detaches its Git metadata, and captures successful changes on an
`omp/task/<agent-id>` branch. Apply-back is disabled. The daemon independently
verifies the retained branch and publishes it as an idempotent draft PR, so OMP
processes never need GitHub credentials.

```text
automation / ompctl
        │
        ├── mode-0600 Unix socket
        └── authenticated HTTP + SSE (optional)
                    │
             Bun orchestration daemon
              │        │          │
           SQLite   OMP RPC     fixed-argv publisher
              │        │          │
          durable   maintainer  git push + gh pr
          journal      │
                    native task
                       │
                  APFS clones
```

## Requirements

- macOS with the project checkout on APFS
- Bun
- OMP 18.x with RPC protocol v2
- Git
- GitHub CLI authenticated on the daemon host when auto-publish is enabled

The maintainer itself receives only `read`, `grep`, `glob`, `lsp`, `task`,
`todo`, and `web_search`. Its generated config explicitly sets:

```yaml
task:
  isolation:
    mode: apfs
    apply: false
    merge: branch
```

OMP may report a platform fallback if APFS isolation is unavailable; treat that
as an operational defect for this deployment rather than silently changing the
Skizzles policy.

## Model routing

Maintainer and subagent models are a daemon-owned policy, independent of the
operator's global interactive OMP defaults. Set an optional maintainer default
and a JSON object of OMP agent names to model selectors:

```sh
OMP_ORCHESTRATION_MAINTAINER_MODEL=opencodex/gpt-5.6-sol
OMP_ORCHESTRATION_MAINTAINER_THINKING=xhigh
OMP_ORCHESTRATION_AGENT_MODELS='{"task":"opencodex/xai/grok-4.6:high","reviewer":"opencodex/gpt-5.6-sol:high"}'
```

Per-project `model` and `thinking` values override the maintainer defaults. The
daemon renders agent routes into each private OMP config overlay using
`task.agentModelOverrides`; selectors may also be non-empty arrays for ordered
fallbacks. Per-task effort selection is disabled and capped at `high`, so an
agent cannot silently override a pinned reasoning level. `maintainers status`
reports the effective routing policy, while each job's durable progress records
OMP's requested role, resolved model, and fallback flag when OMP supplies them.

Each maintainer permits up to 12 concurrent subagent jobs. This leaves room for
six coding workers to own independent PRs while as many as six scout, review,
security-review, or support jobs run alongside them. Both OMP's task concurrency
and async job ceilings are 12, so the advertised capacity is available at both
gates.

## Source operation

```sh
bun run packages/omp-orchestration/src/daemon.ts
bun run packages/omp-orchestration/src/cli.ts projects add --id skizzles --cwd /absolute/project
bun run packages/omp-orchestration/src/cli.ts maintainers send skizzles --message "Handle the open bug"
bun run packages/omp-orchestration/src/cli.ts jobs list --project skizzles
```

The default state root is `~/.omp-orchestration`. It contains `state.sqlite`,
the local socket, per-project generated config overlays, and isolated session
files. Provider authentication remains in the operator's normal OMP credential
domain; setting a distinct `PI_CODING_AGENT_DIR` would also isolate auth and is
therefore an explicit deployment choice, not the default. The database uses WAL mode, foreign keys, bounded busy waits, an exclusive
daemon lease, idempotent inbox keys, and an ordered event journal. After a daemon
restart, in-flight jobs fail explicitly and pending UI requests are cancelled;
enabled maintainers resume their last session file.

## Ingress and agent access

Local `ompctl` uses the Unix socket. Set all three variables to enable a private
HTTP listener:

```sh
OMP_ORCHESTRATION_HTTP_PORT=43873
OMP_ORCHESTRATION_HTTP_TOKEN=... # load from operator-owned secret storage
OMP_ORCHESTRATION_HTTP_PROJECTS=skizzles,another-project
```

The listener exposes public `GET /v1/health`, authenticated
`POST /v1/request`, idempotent `POST /v1/projects/:id/inbox`, journal reads at
`GET /v1/events`, and resumable SSE at `GET /v1/events/stream`. Browser-origin
requests are rejected. Missing credentials, invalid credentials, unauthorized
projects, invalid requests, and unavailable maintainers remain distinct errors.

Remote `ompctl` clients require HTTPS by default. Plain HTTP is accepted only
for loopback and literal Tailscale addresses in `100.64.0.0/10` or
`fd7a:115c:a1e0::/48`; bearer authentication and project authorization still
apply. This permits direct tailnet access without taking over a Tailscale Serve
target while rejecting ordinary LAN and public plaintext endpoints.

Ingress events require `source`, `sourceKey`, `kind`, `message`, and optional
`payload`. The tuple `(project, source, sourceKey)` is unique, so webhook retries
cannot enqueue the same maintainer message twice.

## Publishing invariants

Before any network mutation, the publisher requires the exact
`refs/heads/omp/task/<agent-id>` ref, the job's captured base SHA as an ancestor,
and at least one new commit. It queries existing PRs before and after pushing,
then creates a draft PR only when none exists. Failures become durable
`publish_failed` jobs and can be retried with `ompctl jobs publish`.

Installation into PATH and launchd is explicit through `scripts/install.ts`;
the plugin package only carries the runtime, skill, installer, and integration
contract.

```sh
# CLI + Codex skill only
bun run packages/omp-orchestration/scripts/install.ts --client-only

# CLI, skill, absolute OMP pin, and KeepAlive LaunchAgent
bun run packages/omp-orchestration/scripts/install.ts
```

The host installer resolves the absolute `omp` executable before sanitizing the
LaunchAgent environment, so Bun-managed installations do not depend on an
interactive shell PATH. To enable HTTP ingress, set the documented port/project
variables and pipe a freshly generated token into `--http-token-stdin`; the
installer stores it in macOS Keychain and the launch wrapper retrieves it at
startup without writing the bearer token into the plist. Model-routing variables
are non-secret host configuration and are preserved in the generated LaunchAgent.
