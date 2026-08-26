---
name: ompweb-orchestrator
description: Drive OMP sessions through an existing community ompweb server with ompctl. Use to list, create, message, read, or check OMP sessions through ompweb; do not use for T3 tasks or direct OMP ACP control.
---

# ompweb orchestrator

Use `ompctl` to operate the configured ompweb HTTP server. Resolve this skill's
directory and invoke its literal launcher path:

```sh
/absolute/path/to/skills/ompweb-orchestrator/scripts/ompctl --help
```

The full Skizzles plugin, source checkout, and Grok harness installation bundle
the client runtime. A standalone skill-only copy falls back to a distinct
`ompctl` already on `PATH`.

## Commands

```sh
ompctl sessions list
ompctl sessions create --cwd <server-path> [--message <text>]
ompctl sessions send <session-id> --message <text>
ompctl sessions history <session-id> [--include-state]
ompctl sessions status <session-id>
```

All output is JSON. `send` returns after ompweb accepts the prompt; use `status`
to check native state such as `isPromptRunning` and `isStreaming`, then read
`history` when the turn is done. The `--cwd` value names a directory on the
ompweb host, not necessarily the client machine.

The default base URL is `http://127.0.0.1:30177`. Use `--base-url` or
`OMPWEB_URL` for another existing listener. Password-protected servers accept
`--password` / `OMPWEB_PASSWORD` or `--cookie` / `OMPWEB_COOKIE`; prefer the
environment so credentials do not enter shell history. Never print, persist, or
commit those credentials.

This tool talks only to ompweb's HTTP API. Do not start `omp acp`, write OMP
session files, talk to T3 sockets, alter OMP isolation, or configure/rebind a
reverse proxy or Tailscale Serve route as part of using it.
