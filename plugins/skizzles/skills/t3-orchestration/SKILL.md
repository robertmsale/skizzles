---
name: t3-orchestration
description: Use Skizzles' T3 orchestration runtime to list, read, wait for, create, message, and manage T3 Code tasks with mandatory Git worktrees, locally or over a private Tailscale tailnet. Use for cross-task coordination from Codex or another agent harness.
---

# T3 orchestration

Use `t3ctl` for T3 project/task orchestration. The CLI exposes a bounded provider selector but intentionally exposes no model or reasoning flags.

The full Skizzles plugin and a Skizzles source checkout include the complete runtime. Resolve this skill's directory and use the literal bundled launcher path; a skill-only install falls back to a distinct `t3ctl` on `PATH` or explains that the full runtime is required:

```sh
/absolute/path/to/skills/t3-orchestration/scripts/t3ctl --help
```

Examples below use `t3ctl` for readability. Replace it with that resolved literal launcher unless an installed `t3ctl` convenience binary is already known to be healthy.

## Invariants

- New tasks always use a T3-created Git worktree; never the project’s primary checkout.
- New tasks use Codex unless the operator explicitly requests Grok or Cursor. Codex model/reasoning comes from the explicit top-level defaults in `~/.codex/config.toml`. `--provider grok` uses Grok 4.6 through the installed Grok harness. `--provider cursor` maps to T3 instanceId `cursor`, model `grok-4.6`, option `reasoning=high`, and `fastMode=false` as exposed by this machine's live T3 catalog ("Cursor Grok 4.6" / High, not Fast). Never invent model or reasoning overrides. New Cursor work is a new task; messaging an existing thread cannot change its provider.
- Messages replay the recipient’s exact saved model selection, runtime mode, and interaction mode. Never override them.
- Resolve `$CODEX_THREAD_ID` only when creating a same-project child task; do not trust a claimed sender id in message text. Cross-project send, status, and bounded history use the protected same-user daemon as their authorization boundary.
- Mutate T3 only through its HTTP/event API. Never write T3 or Codex SQLite.

## Commands

```sh
t3ctl projects list
t3ctl projects import
t3ctl handoff create --project <t3-project-id> --title <title> --message <text> [--provider grok|cursor]
t3ctl tasks create [--project <t3-project-id>] --title <title> --message <text> [--provider grok|cursor]
t3ctl tasks list [--project <t3-project-id>] [--limit 1..200] [--include-settled] [--include-archived]
t3ctl tasks status <t3-thread-id>
t3ctl tasks send <t3-thread-id> --message <text>
t3ctl tasks read <t3-thread-id> [--turns 1..10] [--before <cursor>]
t3ctl tasks wait <id> [<id> ...] [--timeout-ms 0..3600000] [--after <id>=<cursor>]
t3ctl tasks title <id> --title <title>
t3ctl tasks archive <id>
t3ctl tasks unarchive <id>
t3ctl tasks pin <id>
t3ctl tasks unpin <id>
t3ctl tasks settle <id>
t3ctl tasks unsettle <id>
t3ctl tasks interrupt <id>
t3ctl tasks approvals [--project <t3-project-id>]
t3ctl tasks approve <id> [<request-id>]
t3ctl tasks deny <id> [<request-id>] [--reason <text>]
t3ctl worktrees clean-settled [--dry-run] [--config PATH]
```

The optional per-user LaunchAgent keeps `t3-orchestrationd` available. The daemon owns the T3 credential; the CLI communicates over a same-user Unix socket. Host activation is explicit and machine-local—it is never performed merely by installing the Skizzles plugin or skill. With direct operator approval, run `bun run packages/t3-orchestration/scripts/install.ts` from a Skizzles checkout or plugin snapshot. The installer copies the runtime into a stable receipt-owned location, refuses foreign targets, and supports verified `--uninstall`; use `--client-only` for both install and uninstall on a tailnet client that must not host the credential-owning daemon.

`t3ctl worktrees clean-settled` is a host-only sidecar that asks the existing local daemon for settled and archived tasks, then runs configured cleaners inside those tasks' registered Git worktrees. Defaults detect `Cargo.toml`+`target/` and Flutter `pubspec.yaml`+`build/` from the tree; they do not name a particular repository. Optional host config is `~/.config/skizzles/t3-worktree-reaper.toml` (or `--config` / `T3_WORKTREE_REAPER_CONFIG`) and can include projects, named strategies, extra commands, and deny paths. It never removes a worktree, never touches the project primary checkout, refuses a claimed path whose registered Git branch does not match the task or that another live task owns, fails closed unless the daemon proves occupancy and a boolean truncation flag, and holds one exclusive worktree gate across this package's existing-task `thread.turn.start` dispatch and the reaper's final revalidation plus every cleaner. `tasks send` and in-process `dispatch`/`rawDispatch` share that gate. T3 Desktop and other direct callers of T3's own HTTP/WS are not admitted by the local lease. It refuses remote `t3ctl` mode so it cannot clean this machine from another host's task list. Install it with `bun run packages/t3-orchestration/scripts/install-reaper.ts`. That command writes LaunchAgent `io.github.skizzles.t3-worktree-reaper` only; it must not be used to mutate `io.github.t3-orchestration.daemon`. `--dry-run` prints thread id, path, and bytes that would be freed. The sidecar is not available in `--client-only` mode.

Remote clients may use an explicitly configured tailnet-only HTTPS endpoint created with Tailscale Serve. Never use Funnel. The host still owns the T3 credential; remote clients authenticate through Tailscale identity and an exact host allowlist. The Serve-facing gateway listens only on `127.0.0.1:43773` by default because macOS Tailscale cannot proxy the prior mode-`0600` Unix socket; `T3_ORCHESTRATION_HTTP_PORT` selects another unprivileged loopback port. Configure a remote client with `t3ctl remote configure --url https://HOSTNAME.TAILNET.ts.net`. Remote mode never falls back silently to the local socket.

When a T3 task creates another task, omit `--project` to target the caller's current T3 project. Explicit project IDs are accepted only when they match the caller's project. External ChatGPT Desktop tasks use `handoff create` with the destination project ID.

All task read, wait, message, and management commands may target any known T3 task ID across projects, matching ChatGPT Desktop's root-to-root collaboration model. The same-user daemon socket and its least-privilege T3 credential are the local authorization boundary.

`tasks list` returns non-archived tasks without an explicit `thread.settle` override by default. T3's UI may additionally hide tasks through its configurable inactivity and pull-request auto-settlement rules; those client-only heuristics are not available through the orchestration snapshot. Pinned tasks are always first in their UI order and do not consume `--limit`; the limit applies only to recent non-pinned tasks. Opt into explicitly settled or archived tasks only when needed. Each task includes an opaque `cursor` suitable for `tasks wait --after ID=CURSOR`.

Use `tasks read` to inspect only the bounded conversation window needed to coordinate work. Start with the default three turns; paginate or raise the limit only when necessary. `tasks history` remains a compatibility alias. The command returns messages rather than raw tool/activity payloads and caps message and total text size.

`tasks wait` accepts one through eight task IDs. It returns when the first task completes, fails, is archived/deleted, presents a plan for approval, requests approval, or requests user input. Background subagent/workflow work and monitoring keep the task nonterminal. `--timeout-ms 0` is an immediate compact snapshot. Pass each previously returned task cursor with a repeatable `--after ID=CURSOR` to suppress an already-delivered terminal state. The daemon uses one bounded shell-snapshot polling loop for all targets; progress chatter does not wake it.

`tasks archive` and `tasks settle` go through T3's WebSocket dispatcher so T3 performs its native provider-session cleanup. `tasks interrupt` requests interruption of the active turn; it does not kill an idle provider session. None of the management commands change provider, model, reasoning, runtime, or interaction settings.

`tasks approvals` lists live threads whose T3 shell flag `hasPendingApprovals` is true, then projects each pending `approval.requested` activity from the thread snapshot. Each identifiable item includes the T3 `requestId`, provider `instanceId`, request kind, command or path from the activity payload (`detail` / nested `command` / path), and worktree/cwd when T3 exposes them. This is the coordinator fallback for harnesses that prompt (Cursor, Grok, others). It does not change Codex auto-guardian. `tasks approve` and `tasks deny` dispatch T3's existing `thread.approval.respond` command with `decision` `accept` or `decline`. If a thread has exactly one pending approval, the request id may be omitted. Approve is fail-closed: it never auto-approves, never uses `acceptForSession`, and refuses when T3 does not expose the command or path. Deny accepts an optional `--reason` for the CLI result only; T3's command has no reason field, so the reason is not sent to T3.

Use `handoff create` only for explicit operator-authorized ingress from a task outside T3. It requires a concrete imported T3 project id, still creates a mandatory worktree, and exposes no model or reasoning controls.

## ChatGPT Desktop parity

| Desktop task operation | T3 orchestration equivalent |
| --- | --- |
| list | `tasks list` |
| read | `tasks read` |
| wait | `tasks wait` |
| send message | `tasks send` |
| create | `tasks create` or external `handoff create` |
| rename | `tasks title` |
| pin/unpin | `tasks pin` / `tasks unpin` |
| archive/unarchive | `tasks archive` / `tasks unarchive` |
| inspect/approve/deny pending harness approvals | `tasks approvals` / `tasks approve` / `tasks deny` |

T3 has no backend primitive for cloning an existing provider conversation at an arbitrary message, so Desktop's exact `fork` operation is not fabricated here. T3 instead creates a new branch/worktree task and receives an explicit handoff message. Desktop host handoff and navigation are client-window operations, not cross-agent orchestration primitives; T3 owns its own task placement and UI.

## First-time authentication

Create a short-lived pairing token with the local T3 CLI, then pipe it once to:

```sh
t3ctl auth configure < pairing-token.txt
```

The exchange requests only `orchestration:read orchestration:operate`; the resulting bearer is stored in macOS Keychain, never in this repository or the process environment. Pairing tokens are one-time credentials. Do not pass an administrative session token to agents.
