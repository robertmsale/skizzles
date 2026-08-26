# ompweb orchestrator

`ompctl` is a small machine-readable HTTP client for community
[`@kahme247/ompweb`](https://github.com/kahme247/ompweb). It lets another agent
list, create, message, inspect, and check OMP sessions without implementing an
OMP harness or launching `omp acp` itself.

The contract was derived from the installed ompweb 0.3.5 production package and
verified against a live 0.3.5 listener:

| Command | ompweb endpoint |
| --- | --- |
| `sessions list` | `GET /api/sessions` |
| `sessions create` | `POST /api/agent/new` with `ensure_session` or `prompt` |
| `sessions send` | `POST /api/agent/:id` with `prompt` |
| `sessions history` | `GET /api/sessions/:id` |
| `sessions status` | `GET /api/sessions/:id/state` |
| password login | `POST /api/web-auth/session` |

Run it from a Skizzles checkout:

```sh
bun run packages/ompweb-orchestrator/src/cli.ts sessions list
bun run packages/ompweb-orchestrator/src/cli.ts sessions create --cwd /server/path
bun run packages/ompweb-orchestrator/src/cli.ts sessions send SESSION_ID --message "Continue"
bun run packages/ompweb-orchestrator/src/cli.ts sessions history SESSION_ID --include-state
bun run packages/ompweb-orchestrator/src/cli.ts sessions status SESSION_ID
```

The default URL is `http://127.0.0.1:30177`. Override it with `--base-url` or
`OMPWEB_URL`. `--password` / `OMPWEB_PASSWORD` performs ompweb's password login
for the current invocation; `--cookie` / `OMPWEB_COOKIE` accepts an existing
`omp_web_session` cookie. Prefer credential environment variables because flags
can appear in shell history and process listings. The client does not persist
passwords or cookies.

`--cwd` is a path on the machine running ompweb, including when the client uses
a remote HTTPS reverse proxy. `sessions send` returns when ompweb accepts the
prompt; use `sessions status` to inspect `isPromptRunning`, `isStreaming`, and
the other native state fields before reading updated history.

This package only makes HTTP requests to the configured ompweb URL. It never
talks to T3, starts an OMP ACP process, changes OMP settings, or configures a
reverse proxy, VPN, or Tailscale Serve route.

The Skizzles Grok harness installer carries this package in its receipt-owned
runtime directory and installs an `ompctl` convenience binary. Both source-link
and copy installs therefore work without a separately installed global package.
