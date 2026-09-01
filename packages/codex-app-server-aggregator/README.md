# Codex app-server aggregator

This package presents one long-lived Codex app-server surface backed by two execution modes:

| Mode | Backend | Lifetime | Permissions |
| --- | --- | --- | --- |
| host | One shared host <code>codex app-server --stdio</code> | Daemon lifetime after initialization | Forward selected permissions, sandbox, and approval policy |
| container | One Docker app-server per live thread tree | Removed when its tree drains or the daemon stops | Ignore named permissions, force danger-full-access, preserve approval policy |

<code>thread/start</code> accepts the optional Skizzles field
<code>skizzlesExecutionMode: "host" | "container"</code>. Container is the default. A created
thread is permanently bound to that backend:

- later requests route by the real backend-minted thread ID;
- forks, reviews, and other child IDs inherit the same backend;
- <code>skizzlesExecutionMode</code> is rejected outside <code>thread/start</code>;
- a fresh thread may explicitly choose either mode, regardless of the caller's mode.

The daemon also owns a mode-0600 Unix socket, unchanged JSONL relay, REST management surface,
SQLite topology, and React board. This is a workspace package, not a Skizzles plugin or
installation payload.

## Host control plane

The shared host app-server is the control plane. <code>initialize</code> returns its real host
description. Global reads such as <code>model/list</code>, <code>permissionProfile/list</code>,
<code>skills/list</code>, config, plugin/app, account, and diagnostic discovery go directly to it.
Multi-CWD skill discovery therefore sees the host filesystem rather than a representative
container.

<code>thread/list</code> and <code>thread/loaded/list</code> remain aggregator-owned views across
both modes. Backend approvals retain their payloads; only JSON-RPC IDs are remapped so different
backends cannot collide.

## Run it

~~~sh
docker build \
  --tag skizzles/codex-app-server:0.149.1 \
  packages/codex-app-server-aggregator/container

bun run packages/codex-app-server-aggregator/src/cli.ts serve
~~~

Useful server options:

~~~text
--host-codex PATH
--image IMAGE
--codex-home-template DIR
--provider-command COMMAND
--provider-ready-url URL
--pass-env NAME
--docker PATH
--container-host HOST
--host-gateway-mode auto|native|host-gateway
~~~

<code>--host-codex</code> defaults to <code>codex</code> and may name another Codex-compatible
harness executable. SQLite defaults to
<code>~/.local/state/skizzles/codex-app-server.sqlite3</code>, and REST defaults to
<code>http://127.0.0.1:8788</code>.

Connect a normal JSONL app-server client through the persistent daemon:

~~~sh
bun run packages/codex-app-server-aggregator/src/cli.ts connect
~~~

Ending the connector does not end the daemon or its backends. One JSONL peer and concurrent REST
clients share the same routing core.

## Projects and mode selection

Register any absolute host directory:

~~~sh
bun run --silent --cwd packages/codex-app-server-aggregator ctl -- \
  projects add /absolute/path/to/project
~~~

Every registered directory is host-eligible. It is container-eligible when it is a Git root whose
origin is a container-reachable HTTP(S), SSH, Git, or scp-style remote. Otherwise its stored
<code>cloneUrl</code> is null, the board labels it **host only**, and container starts fail clearly.

The project extensions work before app-server initialization:

| Method | Result |
| --- | --- |
| <code>skizzles/project/add</code> | Canonicalize the directory and refresh container eligibility |
| <code>skizzles/project/list</code> | List registered directories |
| <code>skizzles/project/remove</code> | Remove a project unless either mode has live threads |

Host starts use the canonical host path. Container starts clone the origin into
<code>/workspace/repo</code>; host files are never mounted as the container workspace. Returned
container thread DTOs expose the host CWD for aggregate filtering.

The scripted client exposes mode directly:

~~~sh
# Container is the default.
bun run --silent --cwd packages/codex-app-server-aggregator ctl -- \
  threads start /absolute/path/to/project

# Explicit host thread.
bun run --silent --cwd packages/codex-app-server-aggregator ctl -- \
  threads start /absolute/path/to/project --mode host
~~~

Equivalent REST bodies:

~~~json
{"cwd":"/absolute/path/to/project"}
~~~

~~~json
{
  "cwd": "/absolute/path/to/project",
  "skizzlesExecutionMode": "host",
  "permissions": ":workspace",
  "approvalPolicy": "on-request"
}
~~~

<code>permissions</code> is the profile ID returned by host <code>permissionProfile/list</code>.
Host mode forwards it after removing only the Skizzles mode field. Container mode removes
<code>permissions</code> and normalizes sandbox fields to Codex's
danger-full-access/dangerFullAccess forms on start, resume, fork, turn, and settings requests.
<code>approvalPolicy</code> is unchanged.

## Provider configuration and model parity

Skizzles does not depend on OpenCodex or another provider. Containers receive configuration through
an explicit, operator-owned Codex-home template:

~~~text
container-codex-home/
├── config.toml
└── models.json
~~~

~~~sh
bun run packages/codex-app-server-aggregator/src/cli.ts serve \
  --codex-home-template /absolute/path/to/container-codex-home \
  --pass-env PROVIDER_API_KEY
~~~

The template is mounted read-only and copied into isolated <code>/codex-home</code>. It must
contain parseable <code>config.toml</code>. Symlinks, special files, auth/history/session/log/cache
state, SQLite databases, and obvious credential files are rejected.
<code>model_catalog_json</code> paths must be relative, stay inside the template, contain valid
JSON, and expose a non-empty models array. Do not point this option at live
<code>~/.codex</code>; prepare a sanitized source tree.

After each container initializes, the aggregator fetches every visible and hidden model ID from
host and container. A mismatch aborts the start and removes the container. A host configured for a
Codex-compatible provider—OpenCodex included—therefore stays honest with what container agents can
select, without coupling Skizzles to that provider.

<code>--provider-command</code> can start a trusted provider process inside each container, and
<code>--provider-ready-url</code> gates Codex startup on it. These are generic hooks.

## Reaching a provider on the host

The default container-visible hostname is <code>host.docker.internal</code>. Auto mode inspects the
active Docker context:

- OrbStack, Docker Desktop, Colima, and Rancher Desktop keep native host DNS;
- local Linux engines fall back to an explicit host-gateway mapping;
- remote TCP/SSH contexts use host-gateway semantics for the daemon host.

OrbStack's documented compatibility hostname is also
[host.docker.internal](https://docs.orbstack.dev/docker/network). Skizzles does not add an
unconditional mapping that would shadow OrbStack's native DNS and localhost proxying.

Unusual backends can override both decisions:

~~~sh
--container-host host.orbstack.internal --host-gateway-mode native
--container-host host.internal.example --host-gateway-mode host-gateway
~~~

Inside <code>config.toml</code>, <code>{{SKIZZLES_CONTAINER_HOST}}</code> is replaced after copying:

~~~toml
[model_providers.local]
base_url = "http://{{SKIZZLES_CONTAINER_HOST}}:8080/v1"
~~~

## REST and board

| Route | Operation |
| --- | --- |
| <code>/v1/projects</code> | Project registry |
| <code>/v1/threads</code> | Aggregate list or mode-selecting thread start |
| <code>/v1/threads/:id</code> | Read/delete |
| <code>/v1/threads/:id/turns</code> | Start a turn |
| <code>/v1/threads/:id/{fork,resume,interrupt,archive}</code> | Thread operation |
| <code>/v1/threads/loaded</code> | Aggregate loaded IDs |
| <code>/v1/machines</code> | Host/container fleet and per-thread project/mode bindings |
| <code>/v1/events</code> | Bounded daemon-local notification journal |
| <code>/v1/app-state/stream</code> | Global project, thread, status, and pending-request SSE stream |
| <code>/v1/threads/:id/stream?tail=50</code> | Selected-thread timeline snapshot and live SSE stream |
| <code>/v1/threads/:id/entries</code> | Cursor-paginated finalized timeline entries |
| <code>/v1/threads/:id/entries/:entryId</code> | Hydrate one finalized entry, including oversized SSE items |
| <code>/v1/server-requests</code> | Pending backend callbacks |
| <code>/healthz</code> | Process liveness without backend initialization |

The board is served only on an unauthenticated loopback listener. <code>--http-token-env</code>
enables bearer-authenticated REST and disables board assets. Non-loopback binds require a token.
The SSE routes use the same bearer/origin gate as every other REST route; credentials remain in the
<code>Authorization</code> header, never query parameters. Fork and resume deliberately have no mode
option. See [PROTOCOL.md](PROTOCOL.md#server-sent-events) for the typed stream, replay, heartbeat,
batching, and hydration contract.

## Persistence and teardown

SQLite stores project eligibility, machine kind, exact container IDs, and per-thread project/mode
bindings. Existing container-only databases migrate in place as container bindings.

After a restart:

- the old host process is removed; the new host process reuses logical machine ID
  <code>host</code>, preserving host-thread routing identity;
- old container writers cannot be reattached, so exact persisted container IDs are cleaned and
  their threads remain unloaded snapshots;
- no thread migrates between modes.

Archiving/deleting a drained container tree removes only that container. Archiving a host thread
never shuts down the shared host app-server. Daemon shutdown closes all live processes and
containers.

## Validation

~~~sh
bun run --cwd packages/codex-app-server-aggregator check
~~~

See [PROTOCOL.md](PROTOCOL.md) for routing rationale.
