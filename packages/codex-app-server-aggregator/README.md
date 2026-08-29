# Codex app-server aggregator

This package is one long-lived, multi-project Codex app-server peer. Codex clients still speak
Codex's headerless JSON-RPC 2.0 envelopes over JSONL. A mode-0600 Unix socket keeps the daemon
alive independently of any stdio client, and the `connect` command is a byte-for-byte stdio relay
for clients that need the usual process shape. A versioned REST projection exposes common project,
thread, turn, lifecycle, event, and server-request operations to short-lived HTTP clients; both
transports use the same in-process aggregator and backend connections.

The daemon starts one real `codex app-server --stdio` inside each managed Docker container. A
registered host checkout is only a routing key and the source of its Git origin. Each container
clones that origin into `/workspace/repo`; the host checkout is never mounted as the agent
workspace.

## Run it

Build the version-locked container image:

```sh
docker build \
  --tag skizzles/codex-app-server:0.149.1 \
  packages/codex-app-server-aggregator/container
```

Start the single daemon:

```sh
bun run packages/codex-app-server-aggregator/src/cli.ts serve
```

The defaults are a per-user socket below the system temporary directory and a SQLite database at
`~/.local/state/skizzles/codex-app-server.sqlite3`. Use `--socket` and `--database` to override
them. The daemon accepts one active outer app-server connection at a time; that connection can host
threads from every registered project. REST calls can run concurrently with it. The REST listener
defaults to `http://127.0.0.1:8788`; use `--http-host` and `--http-port` to override it.

The same origin serves the built React board at `http://127.0.0.1:8788/` when the listener uses its
default unauthenticated loopback configuration. The board is deliberately disabled when a bearer
token is configured or the daemon binds beyond loopback: normal browser navigation cannot safely
bootstrap that token into the first document request. Authenticated configurations remain REST and
JSONL-only and can use `codex-app-server-ctl`. The checked-in `dist/` is produced from `src/web/`
with Vite. During UI development, run the daemon on its default port and start Vite's loopback dev
server and REST proxy separately:

```sh
bun run --cwd packages/codex-app-server-aggregator dev
bun run --cwd packages/codex-app-server-aggregator build
```

The board uses only the routes below. Its event loop polls the daemon-local journal and fully
reconciles projects, thread topology, loaded IDs, machines, and pending requests after HTTP 410.

Before a normal app-server client initializes, register a Git checkout through the same JSON-RPC
surface. The path must be an absolute checkout root with a container-reachable `origin` remote:

```sh
printf '%s\n' \
  '{"method":"skizzles/project/add","id":1,"params":{"cwd":"/absolute/path/to/project"}}' \
  | bun run packages/codex-app-server-aggregator/src/cli.ts connect
```

Then configure the app-server client to launch the relay:

```sh
bun run packages/codex-app-server-aggregator/src/cli.ts connect
```

Ending that relay does not close its containers or the daemon. A later relay reconnects to the same
live aggregator core. Explicit archive/delete and daemon shutdown are the container teardown
boundaries.

## REST API

REST calls initialize the shared app-server core on demand. Register at least one project before
calling a thread endpoint. Request and response bodies preserve the corresponding app-server
parameter/result DTOs; the resource path supplies identifiers such as `threadId`.

| HTTP route | App-server operation |
| --- | --- |
| `GET`, `POST`, `DELETE /v1/projects` | List, add, or remove registered projects. Delete uses the `cwd` query parameter. |
| `GET`, `POST /v1/threads` | `thread/list` or `thread/start`. Common list filters are query parameters. |
| `GET /v1/threads/:id` | `thread/read`; `includeTurns` defaults to `true`. |
| `POST /v1/threads/:id/turns` | `turn/start`; the body supplies `input` and other native parameters. |
| `POST /v1/threads/:id/{fork,resume,interrupt}` | The corresponding thread/turn operation. |
| `POST /v1/threads/:id/archive`, `DELETE /v1/threads/:id` | Intentional destructive release. |
| `GET /v1/threads/loaded` | Aggregate `thread/loaded/list`. |
| `GET /v1/machines` | Stored machine/container associations plus best-effort live Docker status. |
| `GET /v1/events?after=N&stream=ID` | Poll the bounded in-memory app-server notification journal. |
| `GET /v1/server-requests` | List pending app-server callbacks such as approvals. |
| `POST /v1/server-requests/:id/responses` | Complete a pending callback with a JSON-RPC `result` or `error` outcome. |
| `GET /healthz` | Process liveness without initializing a backend. |

For example:

```sh
curl --json '{"cwd":"/absolute/path/to/project"}' \
  http://127.0.0.1:8788/v1/projects

curl --json '{"cwd":"/absolute/path/to/project"}' \
  http://127.0.0.1:8788/v1/threads

curl --json '{"input":[{"type":"text","text":"Run the focused tests"}]}' \
  http://127.0.0.1:8788/v1/threads/THREAD_ID/turns

curl 'http://127.0.0.1:8788/v1/threads/THREAD_ID?includeTurns=true'
```

Events are intentionally not another durable rollout store. Each response contains a daemon-local
`streamId`, numeric `nextCursor`, and retained `oldestCursor`. Send both `stream` and `after` on the
next poll. HTTP `410` means either the bounded window was overrun or the daemon restarted; callers
must reconcile through `thread/list`, `thread/read`, and `server-requests`. Thread snapshots and the
project registry retain their existing SQLite persistence.

The HTTP listener is loopback-only by default. Set `--http-token-env NAME` to require a bearer
token read from the named environment variable. Doing so disables the browser board; use the
authenticated scripted client instead. A non-loopback bind is rejected unless a token is
configured and likewise never serves board assets. Use a trusted TLS reverse proxy rather than
sending that token over an untrusted plaintext network.

### Scripted HTTP client

`codex-app-server-ctl` standardizes the REST calls and always emits JSON. In this checkout, invoke
the package script as follows; the package also publishes that executable name through its `bin`
map for installed/linkable use.

```sh
bun run --silent --cwd packages/codex-app-server-aggregator ctl -- projects list
bun run --silent --cwd packages/codex-app-server-aggregator ctl -- threads list --cwd /absolute/path/to/project
bun run --silent --cwd packages/codex-app-server-aggregator ctl -- threads send THREAD_ID --message 'Run the focused tests'
bun run --silent --cwd packages/codex-app-server-aggregator ctl -- threads read THREAD_ID
bun run --silent --cwd packages/codex-app-server-aggregator ctl -- events list --after 12 --stream STREAM_ID
bun run --silent --cwd packages/codex-app-server-aggregator ctl -- requests approve REQUEST_ID
```

Use `--stdin` instead of `--message` for multiline input. `threads start`, `send`, `fork`, `resume`,
and `interrupt` accept `--params JSON` for native app-server fields that do not warrant dedicated
CLI flags. Resource identifiers and query parameters are encoded by the client.

The client defaults to `http://127.0.0.1:8788`. Override it with
`SKIZZLES_AGGREGATOR_URL` or `--url`. If the server requires authentication, export
`SKIZZLES_AGGREGATOR_TOKEN`; `--token-env NAME` selects another environment variable without
placing the token in process arguments. HTTP failures produce structured JSON on stderr and a
nonzero exit status.

## Project registry extensions

These requests are available before `initialize`, which allows an empty database to be bootstrapped.
They retain ordinary JSON-RPC request and response envelopes.

| Method | Params | Result |
| --- | --- | --- |
| `skizzles/project/add` | `{ cwd: string }` | `{ project }`; canonicalizes the Git root and discovers or refreshes its `origin`. |
| `skizzles/project/list` | `{}` | `{ data: project[] }`. |
| `skizzles/project/remove` | `{ cwd: string }` | `{ removed: boolean }`; refuses removal while that project has live container-backed threads. |

`thread/start` requires a `cwd` that exactly resolves to a registered project. Unknown paths are
rejected before provisioning. The selected project's stored origin is cloned in a new container,
the inner request is forced to `/workspace/repo`, and returned thread DTOs expose the registered
host CWD so normal client filtering remains meaningful. Re-add a checkout after changing its
`origin` to refresh the persisted clone source.

## Persistence and process truth

SQLite retains registered projects, aggregate thread snapshots, lifecycle flags, and the exact
machine/project/container association. A daemon restart cannot reattach the lost stdio streams,
so it never labels old threads as loaded or pretends their backend is routable. Instead it removes
persisted active/orphaned containers by exact container ID, retains snapshot-only `thread/list` and
`thread/read` data, and returns an unavailable-thread error for operations that require the dead
writer.

Within a live connection, archive is the explicit destructive release operation. It routes by the
real backend-minted thread ID and runs `docker rm --force` only after every thread mapped to that
machine is drained. The rollout is intentionally discarded. `thread/unarchive` is an idempotent
no-op for known threads: it returns success but leaves the snapshot archived and never provisions a
replacement. Fork and detached review IDs remain on their original writer process.

The canonical peer transport is a Unix-domain JSONL socket because direct stdio exits on EOF and
the pinned Codex runtime's listen-WebSocket surface is experimental. REST is an aggregate-owned
projection for one-off commands, not a claim that Codex itself exposes those resource routes.
Inner app-server connections remain direct stdio because they are container-owned and deliberately
non-reattachable. Tests prove the daemon and live backends survive relay disconnect, REST and JSONL
share topology, the registry survives daemon restart, stale machines are cleaned by exact ID, two
CWDs select different clone sources, unknown CWDs provision nothing, and archive removes the
selected machine.

## Existing app-server behavior

| Method | Aggregator behavior |
| --- | --- |
| `initialize`, `initialized` | Initialize a real warm backend from a registered project and preserve the backend's Linux runtime description. |
| `thread/start` | Route by registered host CWD, clone/provision, force the inner workspace, and preserve the real returned thread ID. |
| `thread/list`, `thread/loaded/list` | Answer from aggregate topology across projects; persisted but disconnected threads are never reported loaded. |
| `thread/read` after teardown | Return the retained snapshot when turns are not requested. |
| Thread-scoped requests | Route by the real Codex thread ID. Fork/review IDs bind to the same backend and project. |
| Backend approvals and other requests | Rewrite only the JSON-RPC request ID for collision-free correlation, then route the client response back to the originating backend. |
| `thread/archive` | Pass through, persist the archived snapshot, and intentionally remove the exact container when its thread tree drains. |
| `thread/unarchive` | Return success for a known thread without changing its archived state or provisioning a replacement. |
| `thread/delete` | Pass through, persist deletion, and remove the exact container when its thread tree drains. |
| Native project/section/search topology | Reject rather than return one backend's false partial view; the Skizzles registry extensions are a separate aggregate-owned surface. |
| Representative reads | Route `cwd`/`cwds` to one registered project's backend and reject cross-project arrays; unscoped homogeneous reads use any warm or running representative. |
| Other unkeyed requests | Reject until an aggregate, broadcast, or seed-owned meaning exists. |

Pass `--codex-home-template DIR` to copy a provider-ready Codex home into every isolated
`/codex-home`. Keep session rollouts out of this seed. A custom image can start an
OpenCodex-compatible provider with `--provider-command`; use `--provider-ready-url` to gate
app-server startup and `--pass-env NAME` for explicitly selected provider credentials.

Run the package boundary with:

```sh
bun run --cwd packages/codex-app-server-aggregator check
```

See [PROTOCOL.md](PROTOCOL.md) for the runtime probes, protocol/extension boundary, and remaining
limitations.

## Protocol lock

`bun run --cwd packages/codex-app-server-aggregator protocol:generate` invokes the installed
`codex app-server generate-ts --experimental`. The checked-in subset under `src/generated/` is the
exact 0.149.1 DTO surface synthesized by this middleware; passthrough payloads intentionally remain
opaque.
