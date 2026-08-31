# Protocol findings: heterogeneous Codex app-server aggregation

The generated DTO subset and container image are pinned to Codex CLI 0.149.1. The aggregator keeps
Codex's headerless JSON-RPC-over-JSONL envelopes and adds only aggregate-owned routing,
registration, persistence, and HTTP projection.

## Backend topology

The outer app-server surface owns:

- one daemon-lifetime host app-server, created on first initialization;
- zero or more disposable container app-servers;
- a real thread-ID to machine/project/mode map;
- collision-free reverse routing for backend-to-client requests;
- aggregate thread topology and loaded state.

The host app-server initializes the outer surface and handles global discovery. Containers are
execution backends only. There is no representative or warm container.

## Intercept contract

| Surface | Behavior |
| --- | --- |
| <code>initialize</code> | Start and initialize the stable host backend, return its real response, then release queued events |
| <code>initialized</code> | Notify the host and every initialized container; later containers are notified before use |
| Global reads | Route account, config, model, permission-profile, skill, hook, MCP, app/plugin, capability, and diagnostic reads to host unchanged |
| <code>thread/start</code> | Resolve a registered CWD, consume <code>skizzlesExecutionMode</code>, select host or a new container, and bind the returned ID |
| <code>thread/list</code>, <code>thread/loaded/list</code> | Answer from aggregate topology |
| Thread-scoped requests | Route only to the machine already bound to the thread ID |
| Fork/review/child IDs | Bind to the originating backend and execution mode |
| Backend server requests | Rewrite only the request ID and restore it on the originating backend response |
| Archive/delete | Update topology; remove a drained container but never drain the shared host |
| Project extensions | Maintain the canonical host-directory registry before or after initialization |

Native project/section/search topology remains explicitly unimplemented rather than returning one
backend's partial view.

## Execution-mode extension

The only extension field on native app-server params is:

~~~json
{"skizzlesExecutionMode":"host"}
~~~

It is optional on <code>thread/start</code> and defaults to container. Any value other than host or
container is invalid. Its presence on fork, resume, turn, settings, or another operation is also
invalid.

This placement is deliberate. Codex mints thread IDs, and a writer process owns a live thread tree.
Switching the backend of an existing ID would violate writer ownership and make persisted routing
ambiguous. Cross-mode collaboration therefore creates a fresh thread.

## Permission semantics

Host requests preserve native permission inputs. The aggregator strips the Skizzles mode selector
and canonicalizes start CWD, but otherwise sends selected named permissions, sandbox values,
approval policy, and reviewer settings unchanged.

Containers are the isolation boundary, so caller permission profiles are not meaningful there:

- named <code>permissions</code> are removed;
- thread start/resume/fork use <code>sandbox: "danger-full-access"</code>;
- turn/settings policy uses <code>{ "type": "dangerFullAccess" }</code>;
- raw config overrides are forced to <code>sandbox_mode = "danger-full-access"</code>;
- approval and reviewer policy remain unchanged.

This also avoids the Codex protocol conflict where named permissions and sandbox cannot be sent
together.

## Host discovery and model parity

Host routing gives CWD-sensitive <code>permissionProfile/list</code> and multi-CWD
<code>skills/list</code> access to real host configuration and files. It also makes host
<code>model/list</code> authoritative.

Each new container must return the exact same set of model IDs, including hidden models. Pagination
is followed and malformed/repeated cursors are rejected. A mismatch tears down the container before
<code>thread/start</code>. Provider implementation is intentionally outside this protocol:
operators supply a sanitized Codex-home template and optional generic provider hooks.

## Notifications and host context

A container connection has one fixed project, so its thread DTOs are virtualized from
<code>/workspace/repo</code> to the registered host CWD.

The host connection can span projects. Host notification ownership is resolved in this order:

1. an already-bound thread, review, or parent thread ID;
2. the canonical CWD in a newly announced thread DTO;
3. no topology mutation if neither is known.

The notification is still forwarded when step 3 occurs; the aggregator does not invent project
ownership. Thread-start and routed request responses provide the authoritative binding.

Topology-critical notifications stay enabled on inner connections even when the outer client opts
out. The aggregator consumes them for routing and lifecycle state, then honors the opt-out at the
outer edge.

## Persistence

SQLite stores:

- registered CWD and nullable container clone URL;
- machine kind, nullable project/container fields, and lifecycle state;
- thread machine, project, execution mode, snapshot, loaded, archived, and deleted state.

The stable host machine ID is <code>host</code>. On restart the dead host process is marked removed;
the newly initialized host reclaims that logical ID. Persisted host threads can therefore route to
the new host app-server without being relabeled or migrated.

Container stdio transports are not reattachable. Persisted exact container IDs are cleaned on
daemon recovery, and their threads remain unloaded snapshots. Existing pre-host-mode databases are
migrated with every existing machine and thread classified as container.

## Docker host reachability

An unconditional <code>--add-host host.docker.internal:host-gateway</code> is incorrect on desktop
backends because it can shadow their native DNS/proxy behavior. Auto mode examines the active
Docker context:

- known OrbStack/Desktop/Colima/Rancher contexts and local non-Linux Unix sockets use native DNS;
- local Linux and remote TCP/SSH contexts use host-gateway;
- explicit native or host-gateway configuration wins.

The hostname is separately configurable and passed into the container. The entrypoint replaces
<code>{{SKIZZLES_CONTAINER_HOST}}</code> in copied <code>config.toml</code>.

## Runtime invariants retained from container-only mode

- Codex supplies no caller-selected start ID; real returned IDs remain authoritative.
- A fork or detached review is another ID owned by the existing writer, not a reason to provision.
- Creation can precede rollout persistence. The exact immediate
  <code>no rollout found for thread id ...</code> archive/delete error is narrowly synthesized as
  lifecycle success for a known ID.
- Loaded state is per thread rather than per process.
- Reverse request IDs are connection-scoped and must be correlated by backend.
- Docker attachment is earlier than app-server readiness, so the private readiness marker still
  gates the first inner initialize request.

## Aggregate HTTP boundary

REST and JSONL use one daemon-owned core. REST events are a bounded, process-local journal rather
than a second rollout store. HTTP 410 tells consumers to reconcile topology and pending requests.
The machine projection includes machine kind and per-thread project/mode bindings because one host
machine can own threads from many registered projects.

## Deliberate limits

- Container rollout history is destroyed with its container; unarchive cannot reconstruct it.
- The board does not automatically resume persisted host threads after restart, though protocol
  requests retain their host routing binding.
- Remote Docker contexts identify the daemon host, not necessarily the CLI client host; operators
  must configure a reachable provider endpoint.
- Repository authentication, resource limits, secret refresh, and durable rollout storage remain
  deployment policy.
