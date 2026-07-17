# Codex MCP Client Behavior

Use this reference when registering MCP servers for Codex or shaping MCP outputs.

## Repo-Local Config

Register local MCPs in `.codex/config.toml` for trusted projects or in the user config for personal-only tooling.

```toml
[mcp_servers.project_env]
command = "bun"
args = ["run", ".codex/mcp/project-env/src/start.ts"]
startup_timeout_sec = 10
tool_timeout_sec = 60
default_tools_approval_mode = "approve"
```

Useful stdio fields:

- `command`: executable to launch.
- `args`: command arguments.
- `cwd`: optional fixed working directory for the MCP process. Omit it for a
  repo-local MCP so Codex falls back to the current task workspace. Do not use
  `cwd = "."`; Desktop app-server may resolve it relative to `/` rather than
  the task workspace.
- `env`: literal environment values.
- `env_vars`: environment variable names to forward.
- `enabled`: set `false` to disable without deleting config.
- `required`: make startup failure fatal for `codex exec`.
- `startup_timeout_sec`: initialize and first tools/list timeout.
- `tool_timeout_sec`: default call timeout.
- `enabled_tools`: allow-list visible tools.
- `disabled_tools`: deny-list tools after allow-list filtering.
- `default_tools_approval_mode`: `auto`, `prompt`, or `approve`.
- `[mcp_servers.<server>.tools.<tool>] approval_mode`: per-tool override.

Streamable HTTP servers use `url` instead of `command` and can use `bearer_token_env_var`, `http_headers`, and `env_http_headers`. Prefer stdio for repo-local project tooling unless the server must be shared outside the Codex process.

## Approval Guidance

- Use `default_tools_approval_mode = "approve"` for trusted low-risk project tools that should not interrupt agents.
- Use per-tool `approval_mode = "prompt"` for destructive, expensive, credentialed, or production-affecting tools.
- Keep mutating tools narrow and named clearly so approvals remain understandable.
- Use `enabled_tools` when a server exposes extra utilities that agents should not see by default.

Example:

```toml
[mcp_servers.project_env]
command = "bun"
args = ["run", ".codex/mcp/project-env/src/start.ts"]
default_tools_approval_mode = "approve"
enabled_tools = ["health", "stack_status", "reset_stack"]

[mcp_servers.project_env.tools.reset_stack]
approval_mode = "prompt"
```

Use a start wrapper that ensures dependencies are installed before the MCP server imports packages. This matters in new worktrees where `.codex/mcp/<server>/node_modules` may not exist. Keep install output on stderr so stdout remains valid MCP JSON-RPC.

For repo-local MCPs, commit the MCP package lockfile after bootstrapping. The wrapper is a resilience layer for fresh worktrees, not a substitute for reproducible dependency state.

## Browserless Protocol Validation

For local stdio MCPs, agents can validate the server without restarting Codex by spawning the MCP as a background process and sending newline-delimited JSON-RPC to stdin. The bundled template provides:

```sh
bun run validate:stdio
```

This catches common failures before registering the MCP in Codex:

- dependency/import failures
- protocol initialization failures
- missing expected tools
- broken harmless tool calls
- stdout contamination that prevents JSON-RPC parsing

Use the FastMCP inspector for deeper interactive validation, but treat it as browser-based manual testing rather than an automated gate.

## Model-Visible Output

Codex converts MCP `CallToolResult` into function-call output for the model.

- If `structuredContent` is present and not JSON null, Codex serializes that value as the model-visible output.
- If `structuredContent` is null or absent, Codex falls back to serializing the `content` array.
- Code mode consumers can still receive the raw MCP result.
- Codex adds a small wall-time header before injecting tool output into context.
- Large tool outputs are truncated before entering conversation history.

Practical result: keep both `structuredContent` and `content` compact. If a tool needs to expose large logs, write them to a temp file and return a short path plus the relevant summary.

## Lifecycle Boundary

Codex owns local stdio MCP processes through the MCP connection manager. On refresh, shutdown, or manager drop, Codex shuts down clients and terminates stdio server process groups. This is a good fit for MCP-owned local resources, but it is not an archive hook and should not be treated as a long-term daemon lifecycle.
