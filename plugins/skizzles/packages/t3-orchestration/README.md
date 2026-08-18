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

### Settled-worktree artifact reaper

T3 settle/archive does not delete worktrees or their build artifacts. The
optional host-only sidecar `t3-worktree-reaper` talks to the existing
`t3-orchestrationd` Unix socket, then runs configured cleaners inside
registered Git worktrees for tasks that are `settled=true` or `archived=true`.

With no host config, detection is generic: `cargo clean --target-dir target`
in any directory that has `Cargo.toml` plus `target/`, and `flutter clean` in
any directory that has a Flutter `pubspec.yaml` plus `build/`. Nothing in the
public defaults names a particular application or repository.

It will not:

- start or install a second orchestration daemon
- write `io.github.t3-orchestration.daemon`
- `git worktree remove` or delete a worktree directory, source, or `.git`
- clean the project's primary checkout
- clean a claimed worktree whose registered Git branch does not match the task
- clean a worktree owned by another live task
- proceed without an explicit occupancy list or boolean truncation proof from the daemon
- proceed when the settled/archived task list is truncated
- clean after a refresh listing drops the task or shows it running, even if it still occupies the path
- start `t3ctl tasks send` into a worktree that holds a live clean lease
- clean a task whose session, latest turn, or phase is running or starting
- guess when two worktrees match the same branch

Install it separately from the orchestration daemon:

```sh
bun run packages/t3-orchestration/scripts/install-reaper.ts
t3ctl worktrees clean-settled --dry-run
t3-worktree-reaper --dry-run
```

Optional host config lives at `~/.config/skizzles/t3-worktree-reaper.toml`
(or `T3_WORKTREE_REAPER_CONFIG` / `--config`). That file is machine-local and
must not be committed. Example:

```toml
# ~/.config/skizzles/t3-worktree-reaper.toml
enabled = true
include_projects = ["acme"]
deny_paths = ["~/Code/acme"]

[[strategies]]
name = "cargo"
markers = ["Cargo.toml"]
artifact_dir = "target"
command = ["cargo", "clean", "--target-dir", "target"]

[[strategies]]
name = "flutter"
markers = ["pubspec.yaml"]
artifact_dir = "build"
require_text = { file = "pubspec.yaml", pattern = "(?m)^flutter:\\s*$|sdk:\\s*flutter" }
command = ["flutter", "clean"]
match = ["apps/**"]

[[projects]]
id = "acme"
enabled = true
strategies = ["cargo", "flutter"]
deny_paths = ["vendor"]

[[projects.extra_commands]]
match = "acme/app"
artifact_dir = ".dart_tool"
command = ["rm", "-rf", ".dart_tool"]
```

`include_projects` matches a T3 project title, project id, or workspace root.
Set `enabled = false` on a `[[projects]]` entry to skip that project. Relative
`deny_paths` are resolved against the worktree. Extra commands are additional
artifact cleaners: `artifact_dir` must be a generated directory (`target`,
`build`, or `.dart_tool`) and the command may only be `cargo clean`,
`flutter clean`, or `rm -rf` of that same generated directory. Source
directories such as `lib`, `app`, `packages`, `assets`, `docs`, and `tests`
are refused.

The reaper installer copies the runtime into
`~/.local/share/skizzles/t3-worktree-reaper`, links `~/.local/bin/t3-worktree-reaper`,
and loads LaunchAgent `io.github.skizzles.t3-worktree-reaper` every 1800 seconds.
It refuses unowned PATH links, plists, and install roots; uninstall verifies
receipt-owned artifacts first:

```sh
bun run packages/t3-orchestration/scripts/install-reaper.ts --uninstall
```

`t3ctl tasks list` / `status` now include `worktreePath` and `workspaceRoot`.
The reaper prefers those paths, then falls back to `git worktree list --porcelain`
matched by branch. A successful clean records the thread id and leftover artifact
size in `~/.t3/worktree-reaper-state.json` so reruns stay cheap.

This sidecar is host-only. `--client-only` is refused. `t3ctl worktrees clean-settled` also refuses remote/client mode so it only talks to the local Unix socket.

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

Wait wakes only for completion, failure, archival/deletion, plan approval, approval, or user input—not progress chatter. Background subagent/workflow work and monitoring remain nonterminal. Rename, pin, archive, settle, interrupt, and pending-approval inspect/approve/deny operations are also exposed through `t3ctl tasks`; they preserve the task's existing provider/model/reasoning/runtime selection.

Coordinator approval commands wrap T3's existing `thread.approval.respond` command. `t3ctl tasks approvals` lists live `hasPendingApprovals` threads and projects `approval.requested` activity payloads from the thread snapshot. `t3ctl tasks approve ID [REQUEST_ID]` and `t3ctl tasks deny ID [REQUEST_ID] [--reason TEXT]` never auto-approve; approve refuses when T3 does not expose the command or path. Codex auto-guardian is unchanged.

The supported collaboration surface now maps Desktop list/read/wait/send/create/title/pin/archive operations. T3 does not expose a native provider-conversation fork or Desktop-style host handoff/navigation API, so the tool does not pretend to clone a conversation; explicit worktree task creation plus a handoff message is the T3-native equivalent.

## Private tailnet access

Remote access is opt-in. The host keeps the T3 bearer in its own Keychain; remote clients receive no T3 credential. Tailscale Serve terminates HTTPS and injects a verified user identity, which the daemon checks against an exact login allowlist.

On the T3 host, reinstall with the allowed Tailscale login and expose only the dedicated loopback HTTP listener. Port `43773` is the default; set `T3_ORCHESTRATION_HTTP_PORT` consistently for both commands to use another unprivileged port. A later host reinstall without those environment variables keeps the existing LaunchAgent allowlist and HTTP port; it refuses to write a gateway-less host plist over a LaunchAgent that already had the gateway enabled.

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
