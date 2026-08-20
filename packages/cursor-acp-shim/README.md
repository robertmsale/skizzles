# t3-cursor-acp

Supervisor in front of `cursor-agent acp`. T3 talks to this process as if it were Cursor ACP. The shim execs the real `cursor-agent` binary from a resolved path and only intercepts the death-as-text class: Cursor ACP printing a recoverable network flake as assistant text, then completing the turn.

This is not a second ACP, not a PTY wrap of the interactive CLI, and not an MCP. Default traffic is pass-through.

HTTP/1.1 (`network.useHttp1ForAgent`) is not the fix. Studio can keep that setting; the shim still has to swallow the assistant-shaped flake.

## What it intercepts

Cursor ACP maps stream failures to:

```text
Error: ConnectError: [unavailable] ...
Error: ConnectError: [aborted] aborted
Error: RetriableError: ...
```

plus HTTP/2 CANCEL / stream reset phrasing and "Something went wrong communicating with the server. Please try again."

A genuine "HTTP failed in the app you are debugging" still goes through. Last-words dumps in that class are swallowed at any point in the turn, including after a tool call or reverse child request. A dump-shaped last line or paragraph after real assistant prose is stripped from the forwarded text and replayed the same way, including after a fenced write-up. A later dump-only `agent_message_chunk` after flushed commentary is classified on that chunk, not the accumulated turn, and a successful `end_turn` a moment later does not keep the dump. A sentence that only mentions those class names is not a flake, and a dump only inside a fence is not. Auth/plan copy that is not a `RetriableError:` dump is not swallowed.

On a match the shim drops that assistant text and the matching `session/prompt` result, then replays the same prompt on the live child. If the child is dead, it respawns and re-runs `initialize` / `authenticate` / `session/load` only as far as needed, carrying `cwd` and `mcpServers` from the original `session/new` or `session/load`. It does not invent a Cursor-internal session with `session/new`. After the retry budget it returns a JSON-RPC error (`-32000`) so T3 never sees the flake as last words. Thought chunks and quoted ConnectError inside a real answer are not fingerprints.

Intercepts log to stderr, never to the ACP stream:

```text
t3-cursor-acp: swallowed spurious Cursor ACP network death; replaying session/prompt (attempt 2/3)
```

## T3 command override

T3 already has a Cursor **Binary path**. On this machine it is:

```text
/Users/<you>/.local/bin/agent
```

T3 then execs `$binaryPath acp`. Do not replace `agent` or `cursor-agent`. Install the shim beside them and point T3 at the shim:

| Field | Value |
| --- | --- |
| T3 setting | Cursor → Binary path |
| Command | `t3-cursor-acp` |
| Absolute path | `~/.local/bin/t3-cursor-acp` |
| argv T3 still passes | `acp` (and any extra Cursor ACP args it already sends) |
| Effective spawn | `/path/to/real/cursor-agent acp` |

Settings JSON equivalent:

```json
{
  "providerInstances": {
    "cursor": {
      "driver": "cursor",
      "config": {
        "binaryPath": "/Users/<you>/.local/bin/t3-cursor-acp"
      }
    }
  }
}
```

Do not add `acp` to a launch-args field. T3 already supplies it.

## Install (host-only, no LaunchAgent)

From a Skizzles checkout, after review. This installer copies the runtime and links `~/.local/bin/t3-cursor-acp`. It does not write a LaunchAgent, does not touch `t3-auto-guardian`, and does not change T3 settings.

```sh
bun run packages/cursor-acp-shim/scripts/install.ts
```

Uninstall:

```sh
bun run packages/cursor-acp-shim/scripts/install.ts --uninstall
```

Override the real Cursor binary with `T3_CURSOR_ACP_BIN=/absolute/path/to/cursor-agent` if the versioned `~/.local/share/cursor-agent/versions/*/cursor-agent` layout is missing. Retry budget is `T3_CURSOR_ACP_MAX_RETRIES` (default `2`, meaning three attempts).
