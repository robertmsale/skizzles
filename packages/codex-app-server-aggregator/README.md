# Codex app-server aggregator spike

This package is a Bun middleware spike that remains a Codex app-server peer: headerless JSON-RPC 2.0 over JSONL on stdio. It starts one real `codex app-server` per Docker container and forwards the backend's notifications and server-to-client approval requests on the original client connection.

It is deliberately not a GUI, worktree manager, review product, or second agent protocol.

## Run the spike

Build the version-locked container image:

```sh
docker build \
  --tag skizzles/codex-app-server:0.149.1 \
  packages/codex-app-server-aggregator/container
```

Start the aggregator with a repository that each container can clone:

```sh
bun run packages/codex-app-server-aggregator/src/cli.ts \
  --repo https://github.com/owner/repository.git
```

The client then speaks the normal app-server protocol on stdin/stdout. `initialize` provisions a warm container so its returned `codexHome`, platform, and user agent are real in-container values. Container startup emits an internal readiness marker only after clone and provider readiness; the transport strips it before starting the app-server RPC timeout. The cloned workspace is trusted inside that disposable container so its repo-local Codex config, hooks, and exec policy load. The first `thread/start` consumes that container; later starts provision another container. A failed later provision returns a JSON-RPC error for that `thread/start` instead of stranding its request ID.

Client notification opt-outs still apply on the outer connection. The aggregator removes the thread lifecycle, status, and turn/item activity methods needed for aggregate bookkeeping from the capabilities sent to each backend, observes them internally, then suppresses them before forwarding when the client opted out.

Pass `--codex-home-template DIR` to copy a provider-ready Codex home into every isolated `/codex-home`. Keep session rollouts out of this seed; it should contain only intentional shared config/auth material. A custom image can include an OpenCodex-compatible provider, started with `--provider-command`; use `--provider-ready-url` to gate app-server startup until it is ready. `--pass-env NAME` passes selected provider credentials by name without putting their values in this repository.

## Current interception boundary

| Method | Spike behavior |
| --- | --- |
| `initialize`, `initialized` | Initialize every real backend with the client's DTO, except topology-critical notification opt-outs retained only at the outer boundary; return the warm Linux backend's response. |
| `thread/start` | Clone/provision first, force `cwd` to `/workspace/repo`, then preserve the real returned thread id. |
| `thread/list`, `thread/loaded/list` | Answer from aggregate bookkeeping across containers. Turn/item activity refreshes preview and ordering timestamps; close/status notifications maintain per-thread loaded state independently of container readiness. |
| `thread/read` after teardown | Return the retained snapshot when turns are not requested. |
| Thread-scoped requests | Route by the real Codex thread id. Fork/review ids observed in responses or `thread/started` bind to the same container. |
| Backend approvals and other requests | Rewrite only the JSON-RPC request id for collision-free correlation, then route the client response back to the originating backend. Payloads are untouched. |
| `thread/archive`, `thread/delete` | Pass through; if the real backend has not materialized a rollout yet, synthesize the normal lifecycle success for its already-minted thread. Remove the container when no mapped live threads remain. |
| Project/section/search topology | Reject as not yet implemented instead of returning one backend's false partial view. |
| Homogeneous global reads | Route to the warm backend or an existing representative. |
| Other unkeyed requests | Reject until an aggregate, broadcast, or seed-owned meaning exists. |

This is not production-ready. Bookkeeping is in memory, stdio backends cannot be reattached after an aggregator crash, and an archived container's rollout is destroyed with the container. Those are protocol/process questions the spike is intended to expose, not paper over.

See [PROTOCOL.md](PROTOCOL.md) for the runtime probes, counterfactuals, interception boundary, and known breaks.

## Protocol lock

`bun run --cwd packages/codex-app-server-aggregator protocol:generate` invokes the installed `codex app-server generate-ts --experimental`. The checked-in subset under `src/generated/` is the exact 0.149.1 DTO surface synthesized by this shim; passthrough payloads intentionally remain opaque.
