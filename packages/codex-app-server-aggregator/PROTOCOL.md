# Protocol findings: Codex app-server aggregation

These findings are pinned to `codex-cli 0.149.1`, the runtime recorded in
`src/generated/runtime.json` and installed in the container image. They combine the generated DTOs,
direct JSONL probes against the installed binary, focused unit tests, and an end-to-end Docker
run.

## Bottom line

The aggregation shape works without inventing an agent protocol. A client can speak the normal,
headerless Codex JSON-RPC envelopes over JSONL to one long-lived Bun daemon while that process owns
one real `codex app-server --stdio` connection per container. The daemon listens on a mode-0600
Unix socket; an optional stdio connector relays the same bytes and is not a second protocol.

The protocol does not supply a caller-selected thread ID, project registry, or container-routing
field. The aggregator therefore resolves `thread/start.params.cwd` against its extension-owned
registry, learns later routing from each backend's returned threads, retains that topology itself,
and rejects unkeyed operations that have no honest aggregate meaning.

## Intercept versus passthrough

| Surface | Aggregator behavior | Why |
| --- | --- | --- |
| `initialize` | Provision and initialize a warm backend from a registered project, return its real Linux `codexHome`, platform, and user agent, then release queued backend events. Keep topology-critical notifications enabled on the inner connection while applying the client's opt-outs on the outer connection. | The response describes a concrete backend. Holding its early notifications prevents them from overtaking the outer initialize response; observing thread lifecycle events is required for routing and teardown. |
| `initialized` | Fan out to every initialized backend, including later backends. | Each app-server connection has its own initialization state. |
| `thread/start` | Require an exactly registered host CWD, select that project's clone origin, allocate a container, force inner `cwd` and caller-supplied runtime roots to `/workspace/repo`, then bind the returned thread ID to that machine/project. Thread DTOs expose the host CWD. | `thread/start` has no caller-supplied ID or routing field. CWD is the only existing project discriminator; the real backend remains the ID authority. |
| `thread/list`, `thread/loaded/list` | Answer from aggregate SQLite-backed topology; derive mutable preview/activity metadata and per-thread loaded state from backend notifications. Never delegate to one backend. | A backend only knows its own Codex home and loaded threads, while persisted readiness cannot make a disconnected stdio writer loaded. |
| `thread/read` after teardown | Return the retained snapshot when `includeTurns` is not true. | The container and rollout no longer exist; turns cannot honestly be supplied. |
| Requests with `params.threadId` | Route to the mapped backend and pass payload/result through. | The existing protocol field is a sufficient routing key. |
| `thread/fork`, detached `review/start`, and new `thread/started` notifications | Pass through and bind every returned/announced ID to the same backend. | These operations mint extra real thread IDs inside the existing writer process. |
| Backend-to-client requests | Preserve method and params, remap only the JSON-RPC request ID, and reverse-map the client response. | Different backends can concurrently choose the same request ID for approvals or elicitation. Thread IDs remain untouched. |
| `thread/archive`, `thread/delete` | Pass through, update aggregate topology, and `docker rm --force` once every mapped thread is archived/deleted. | A fork tree can share one backend, so one archived ID is not necessarily enough to free the machine. |
| `skizzles/project/add`, `list`, `remove` | Maintain the persistent host-CWD registry with ordinary JSON-RPC envelopes, including before `initialize`. | Codex 0.149.1 has no backend-owned surface with a truthful fleet-wide registry view. |
| Native project, section, and thread-search topology | Return an explicit same-protocol error for now. | These must eventually be aggregate-owned; asking one arbitrary backend would return a false partial view. |
| Homogeneous global reads | Use a warm or running representative backend. | Model/config/account capability reads are expected to agree while every container comes from one image and Codex-home seed. |
| Other unkeyed methods | Return an explicit same-protocol error. | A config write, login, filesystem operation, or process mutation cannot be safely assigned to an arbitrary container. |

The 0.149.1 schema has `thread/archive` and `thread/delete`, but no separate `thread/done`
request. A product can treat archive as “done and release,” but the shim should not add a new RPC
method to say so.

## What the protocol allowed versus what was extended

Codex already supplies the JSON-RPC envelope, initialization lifecycle, `thread/start.params.cwd`,
backend-minted thread IDs, thread-scoped routing keys, lifecycle notifications, and bidirectional
server requests. Those surfaces remain shape-compatible and backend IDs remain authoritative.

Skizzles extends only aggregate-owned concerns: the `skizzles/project/*` registry methods, host-CWD
validation and DTO virtualization, persistent topology/machine bookkeeping, and Unix-socket serving.
The Unix socket and stdio connector carry unchanged JSONL. SQLite does not claim to revive a dead
inner transport: restart marks retained threads unloaded and removes exact persisted containers.

## What the runtime actually allows

### IDs and writers

- Generated `ThreadStartParams` contains no ID field. A direct `thread/start` probe returned a
  backend-minted UUIDv7 string. This runtime did not add a `thr_` prefix.
- `thread/fork` returned a distinct UUIDv7 thread with `forkedFromId`; detached `review/start`
  returned another distinct `reviewThreadId`.
- A default `codex app-server --stdio` start response classified its session source as `vscode`,
  not `appServer`. Aggregate filtering therefore follows the returned DTO instead of inferring a
  source from the process name.
- Once the first turn materialized a rollout, a second app-server process attempting
  `thread/resume` for that ID failed with `thread <id> already has an active writer`.

The consequence is one writer process per live thread tree, not necessarily one process per ID.
Provisioning a new container when a fork/review ID appears would fight the real writer lock. The
aggregator instead maps every ID minted or announced by a backend to that backend's container.

### Creation is earlier than persistence

The direct runtime returned `thread/start` before its `thread/started` notification. Immediately
afterward, `thread/loaded/list` knew the ID, but `thread/list`, `thread/fork`, and
`thread/archive` could not find a rollout. The latter two returned the exact error
`no rollout found for thread id <id>`. A first turn created the rollout and made writer locking and
archive behave normally.

This is why topology must observe the start response/notification rather than wait for persisted
history. For an ID the shim saw the backend mint, the aggregator also treats that exact pre-rollout
archive/delete error as lifecycle success, emits the normal lifecycle notification, and removes a
drained container. It does not synthesize success for unknown IDs or other backend errors.

### Aggregate snapshots are derived state

`thread/started` supplies the initial full DTO, but creation precedes the first persisted user
message. The 0.149.1 notification schema then supplies the missing mutable facts: `turn/started`
carries the turn's start time, user-message item lifecycle carries canonical input content, and
`turn/completed` carries completion time. The shim uses those events to fill an empty preview and
monotonically advance `updatedAt` and `recencyAt` before applying search filters or activity sorts.
Its preview derivation follows Codex's text concatenation, request-prefix stripping, and image-only
fallback instead of treating an arbitrary agent item as the thread preview.

Loaded state is per thread, not per process. `thread/closed` and a `notLoaded` status remove only
that ID from `thread/loaded/list`; sibling fork/review IDs may remain loaded on the same ready
container. Archive and delete also clear loaded state without conflating unload with lifecycle
completion.

### Bidirectional traffic is connection-scoped

The generated server-request union includes command/file approvals, user input, MCP elicitation,
auth refresh, attestation, and time requests. Those requests arrive on the backend connection and
their response IDs are meaningful only on that connection. The collision test drives two
backends that both request approval with ID `7`; the client sees distinct aggregator request IDs,
and each answer returns to the correct backend with ID `7` restored.

### Initialization describes one machine

The real Docker run returned `/codex-home` and Linux in `InitializeResponse`. Returning host
initialization data would be a lie. Conversely, there is no
single response that can describe a heterogeneous backend fleet; this aggregator assumes one pinned
image and returns its warm representative.

Initialization capabilities describe the client-facing connection, but the aggregator is also an
app-server client on every inner connection. Forwarding opt-outs for lifecycle, status, or
turn/item activity would suppress events required to bind autonomous children, track loaded state,
refresh list metadata, and release drained containers. The aggregator keeps those methods enabled on
each inner connection, observes them for bookkeeping, and independently honors the original
opt-out when forwarding notifications to the outer client.

Provisioning is also part of the outer request contract. Docker create/start failures are caught at
the `thread/start` boundary, partial transports are closed, and the original JSON-RPC ID receives an
error. Logging an exception without a response is not a valid app-server outcome.

## Container and provider proof

The end-to-end run built the pinned image, created a labeled container, cloned the selected
project's Git origin into `/workspace/repo`, started app-server there, and showed the cloned repository's
instruction source in `thread/start`. The fixed workspace is trusted only inside the disposable
container so repo-local Codex config, hooks, and exec policy can load. No host worktree was mounted
as the agent workspace.

Docker attach succeeds before the entrypoint finishes cloning or waiting for its provider. The
entrypoint now writes a private readiness line immediately before `exec codex ... app-server`; the
transport consumes and strips that line before sending `initialize`. Thus clone/provider startup is
outside the 60-second JSON-RPC timeout, while the initialize response itself remains bounded. A
committed subprocess-boundary test delays readiness beyond a deliberately short RPC timeout and
proves both the gate and normal post-readiness timeout behavior.

A disposable Codex-home seed selected a mock Responses-compatible provider at
`127.0.0.1:8787`. The image's provider hook started that process inside the same container, waited
for readiness, and the in-container Codex sent `POST /v1/responses` to it. The intentional mock
`503` proved routing without relying on a live provider credential. This validates the provider
configuration/process seam; it does not claim that one particular OpenCodex build has been
packaged.

The seed is bind-mounted read-only and copied into an isolated `/codex-home` before launch. A real
deployment still needs a deliberate secret distribution and refresh policy; copying a reusable
auth seed is mechanism, not a credential-security design.

## Counterfactuals tested

| Hypothesis | Validation | Result |
| --- | --- | --- |
| Let the caller choose a routing ID. | Generated DTO plus direct start. | Rejected: no input ID; preserve the backend's UUIDv7. |
| Ask one backend for global thread topology. | Immediate start/list/loaded probes and two-backend unit test. | Rejected: the view is partial and may lag rollout creation. |
| Refresh aggregate lists from every backend on demand. | Runtime notification schema plus post-turn search/sort and unload tests. | Rejected: it turns an aggregate-owned read into an N-backend partial-failure fanout. Derive the mutable projection from inner events instead. |
| Give every fork/review ID a new process. | Fork, detached review, and competing resume probe. | Rejected: child IDs are minted by the current writer; competing writers are refused. |
| Always trust backend archive immediately after start. | Start then archive before a first turn. | Rejected: the ID exists before its rollout does. Narrow synthesis is required to release that machine. |
| Serve the outer peer directly on stdio. | EOF process-lifetime probe. | Rejected: the process exited immediately with its client, so persistence did not make it a daemon. |
| Serve unchanged JSONL on a Unix socket with a raw stdio connector. | Mode check, connector-disconnect/reconnect test, and database restart test. | Selected: one daemon survives client processes without adding a protocol. |
| Use direct stdio per container. | Real Docker initialization, start, turn, archive, and removal. | Selected for inner connections: simple and fully bidirectional; restart cleanup acknowledges that it is not reattachable. |
| Increase the universal RPC timeout to cover cloning. | Delayed attached-process test with a short request timeout. | Rejected: attachment is not readiness, and any fixed increase preserves the race. Gate the first request instead. |
| Use experimental listen-WebSocket instead. | Generated/runtime CLI surface and official transport contract. | Viable later for reconnect, but deliberately not the baseline while the transport is experimental. |
| Use `app-server daemon` plus `proxy`. | Disposable npm-installed runtime probe. | Rejected for this image: daemon demanded the managed standalone layout; an unsupported symlink experiment started it, but proxy relay failed with a broken pipe. This is not proof of an upstream defect. |
| Keep the provider on the host. | In-container mock provider and loopback request. | Rejected as unnecessary: the same provider config and process can live beside Codex in the container. |

## Remaining limits and next decisions

- Registry, thread snapshots, lifecycle state, and exact machine/container associations persist.
  Direct stdio still cannot reattach after restart, so stale containers are removed and old
  threads remain snapshot-only and unloaded.
- `docker rm` intentionally destroys rollout history. Durable archive/read/resume requires an
  external volume or object-store policy before teardown.
- Native Codex project/section/search topology is explicitly unimplemented. The host-CWD registry
  is an extension-owned aggregate view, not a backend's partial `project/*` response.
- Thread-list cursors and filters have the right DTO shape and cover common filters, but use an
  aggregator-owned offset cursor rather than Codex's timestamp cursor/repair behavior.
- Representative global reads are only valid while images, provider config, and Codex-home seeds
  are homogeneous. Global writes need broadcast or seed mutation semantics.
- Repository authentication, image/resource limits, provider secret refresh, trusted-repository
  policy, rollout persistence, and multi-client outer-session ownership remain deployment work.
- The slim image needed `bubblewrap` for the Codex Linux sandbox. That dependency belongs in the
  image rather than weakening sandbox mode.
- The documented remote CLI and experimental transports do not establish a supported Desktop
  “attach to this arbitrary aggregator” workflow; no GUI integration was built or assumed.

The useful next architectural argument is therefore durable rollout storage or a supported
reattachable inner transport—not another ID scheme or a new frontend protocol.
