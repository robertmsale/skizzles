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

The client then speaks the normal app-server protocol on stdin/stdout. `initialize` provisions a warm container so its returned `codexHome`, platform, and user agent are real in-container values. The first `thread/start` consumes that container; later starts provision another container.

Pass `--codex-home-template DIR` to copy a provider-ready Codex home into every isolated `/codex-home`. Keep session rollouts out of this seed; it should contain only intentional shared config/auth material. A custom image can include an OpenCodex-compatible provider, started with `--provider-command`; use `--provider-ready-url` to gate app-server startup until it is ready. `--pass-env NAME` passes selected provider credentials by name without putting their values in this repository.

## Current interception boundary

| Method | Spike behavior |
| --- | --- |
| `initialize`, `initialized` | Initialize every real backend with the client's DTO; return the warm Linux backend's response. |
| `thread/start` | Clone/provision first, force `cwd` to `/workspace/repo`, then preserve the real returned thread id. |
| `thread/list`, `thread/loaded/list` | Answer from aggregate bookkeeping across containers. |
| Thread-scoped requests | Route by the real Codex thread id. Fork/review ids observed in responses or `thread/started` bind to the same container. |
| Backend approvals and other requests | Rewrite only the JSON-RPC request id for collision-free correlation, then route the client response back to the originating backend. Payloads are untouched. |
| `thread/archive`, `thread/delete` | Pass through; if the real backend has not materialized a rollout yet, synthesize the normal lifecycle success for its already-minted thread. Remove the container when no mapped live threads remain. |
| Other global requests | Route to the warm backend or an existing backend. |

This is not production-ready. Bookkeeping is in memory, stdio backends cannot be reattached after an aggregator crash, and an archived container's rollout is destroyed with the container. Those are protocol/process questions the spike is intended to expose, not paper over.

## Protocol lock

`bun run --cwd packages/codex-app-server-aggregator protocol:generate` invokes the installed `codex app-server generate-ts --experimental`. The checked-in subset under `src/generated/` is the exact 0.149.1 DTO surface synthesized by this shim; passthrough payloads intentionally remain opaque.
