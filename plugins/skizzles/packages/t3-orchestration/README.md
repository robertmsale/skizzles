# Skizzles T3 orchestration

Optional Skizzles sidecar tooling for orchestrating T3 Code tasks through its supported HTTP/event API, locally or over a private Tailscale tailnet. Installing the Skizzles plugin makes the runtime available to the bundled skill; host, Keychain, LaunchAgent, PATH, and Tailscale wiring remain explicit operator actions.

## Requirements

- macOS (the host installer uses Keychain and LaunchAgents)
- [Bun](https://bun.sh/)
- T3 Code with its local orchestration API enabled
- Codex, and optionally the Skizzles Grok harness
- Tailscale only when remote access is enabled

## Design

- `t3-orchestrationd` owns the least-privilege T3 bearer from macOS Keychain.
- `t3ctl` talks to the daemon over a same-user Unix socket.
- T3 SQLite and Codex SQLite are read-only identity/configuration sources; mutations use T3 dispatch.
- New root tasks always use T3's worktree bootstrap. The CLI exposes a bounded provider selector, never model or reasoning flags.
- Codex remains the default provider and uses the explicit top-level defaults in `~/.codex/config.toml`. `--provider grok` selects the installed Grok harness with Grok 4.6. `--provider cursor` selects this machine's T3 Cursor instance with catalog model `grok-4.6`, option `reasoning=high`, and `fastMode=false` (Cursor Grok 4.6 High, not Fast). Messages replay the recipient's exact saved selection. Profile/CLI model overrides are intentionally not inherited. New Cursor work requires a new task; an existing thread's provider cannot be flipped by messaging it.

## First-time setup

Create a short-lived pairing token with the local T3 CLI, then exchange it once:

```sh
bun run packages/t3-orchestration/scripts/install.ts
t3ctl auth configure < pairing-token.txt
```

The pairing token is short-lived. Keep it outside the checkout and delete it after the exchange.

The host-wiring command copies the runtime and skill into the stable,
receipt-owned `~/.local/share/skizzles/t3-orchestration` installation, then
installs and starts a per-user LaunchAgent. It keeps the credential-owning
daemon available across terminal and T3 restarts without depending on the
checkout or plugin-cache path that supplied the installer.

The installer refuses unowned PATH links, skills, LaunchAgents, and install
roots. Re-running it performs a staged upgrade with rollback; uninstall first
verifies every receipt-owned link, file, and runtime artifact before removing
anything:

```sh
bun run packages/t3-orchestration/scripts/install.ts --uninstall
```

The project importer is idempotent by canonical workspace root:

```sh
t3ctl projects import
t3ctl projects list
```

Project listing is a bounded project-only projection; it does not dump every task. Task listing follows T3's inbox lifecycle by default:

```sh
t3ctl tasks list [--project <id>] [--limit 50]
t3ctl tasks list --include-settled --include-archived
```

Pinned tasks are always included first and do not consume the recent-task limit.

For an explicitly authorized one-time ingress from an external Codex client:

```sh
t3ctl handoff create --project <id> --title <title> --message <handoff> [--provider grok|cursor]
```

Tasks can read a bounded window of another task's conversation in the same T3 installation, including across projects. The default is three user-anchored turns and the hard maximum is ten:

```sh
t3ctl tasks read <thread-id> [--turns 1..10]
```

When the response says `hasMore`, pass its opaque `beforeCursor` back as
`--before <cursor>` to read the preceding window.

Message delivery, status, and bounded history intentionally accept any known
T3 task ID across projects. This mirrors ChatGPT Desktop's root-to-root
collaboration model; task creation remains project-scoped.

Wait for up to eight tasks with one bounded daemon-side polling loop:

```sh
t3ctl tasks wait <id> [<id> ...] [--timeout-ms 120000]
t3ctl tasks wait <id> --after <id>=<cursor>
```

Wait wakes only for completion, failure, archival/deletion, plan approval, approval, or user input—not progress chatter. Background subagent/workflow work and monitoring remain nonterminal. Rename, pin, archive, settle, and interrupt operations are also exposed through `t3ctl tasks`; they preserve the task's existing provider/model/reasoning/runtime selection.

The supported collaboration surface now maps Desktop list/read/wait/send/create/title/pin/archive operations. T3 does not expose a native provider-conversation fork or Desktop-style host handoff/navigation API, so the tool does not pretend to clone a conversation; explicit worktree task creation plus a handoff message is the T3-native equivalent.

## Private tailnet access

Remote access is opt-in. The host keeps the T3 bearer in its own Keychain; remote clients receive no T3 credential. Tailscale Serve terminates HTTPS and injects a verified user identity, which the daemon checks against an exact login allowlist.

On the T3 host, reinstall with the allowed Tailscale login and expose only the dedicated loopback HTTP listener. Port `43773` is the default; set `T3_ORCHESTRATION_HTTP_PORT` consistently for both commands to use another unprivileged port.

```sh
T3_ORCHESTRATION_TAILSCALE_USERS="you@example.com" T3_ORCHESTRATION_HTTP_PORT=43773 bun run packages/t3-orchestration/scripts/install.ts
tailscale serve --bg --https=443 http://127.0.0.1:43773
tailscale serve status
```

Use Tailscale ACLs or grants to restrict port 443 on the host to the intended operators. Never use `tailscale funnel`: Funnel is internet-facing and is outside this tool's security model.

On another tailnet-connected Mac:

```sh
bun run packages/t3-orchestration/scripts/install.ts --client-only
t3ctl remote configure --url https://host-name.your-tailnet.ts.net
t3ctl remote status
t3ctl projects list
```

The `--client-only` installer mode is intentionally for a clean client device. It refuses to run when a daemon symlink or host LaunchAgent already exists; it never silently converts or disables a credential-owning host installation.
Remove a receipt-owned client installation with:

```sh
bun run packages/t3-orchestration/scripts/install.ts --client-only --uninstall
```

`t3ctl remote clear` restores local Unix-socket mode. Remote mode is explicit and never silently falls back to local transport. Since a lost network response can leave a mutation's outcome unknown, the client does not automatically retry commands.

### Security boundary

This is trusted-operator tooling, not a multi-tenant authorization service. Locally, any process running as the same macOS user can use the mode-`0600` daemon socket. The optional Serve-facing listener binds only to `127.0.0.1`, but local processes can forge proxy headers; do not enable it on a shared or mutually untrusted multi-user host. Remotely, any tailnet user who both passes tailnet network policy and appears in `T3_ORCHESTRATION_TAILSCALE_USERS` can read, message, create, and manage T3 tasks across projects. The HTTP gateway rejects missing identities, tagged-device traffic without a user identity, non-HTTPS proxy traffic, browser-origin requests, and requests larger than 1 MiB.

See the installed `t3-orchestration` Codex skill for agent-facing invariants and commands.
