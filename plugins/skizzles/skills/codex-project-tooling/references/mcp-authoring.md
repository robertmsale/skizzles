# MCP Authoring With Bun And FastMCP

Use this reference when creating or updating a repo-local MCP server for Codex.

## Default Shape

- Put repo-specific MCPs under `.codex/mcp/<server-name>`.
- Use Bun and TypeScript.
- Use `fastmcp` for the MCP protocol surface and `zod` for tool input schemas.
- Prefer stdio transport for repo-local servers.
- Keep stdout reserved for MCP JSON-RPC. Write diagnostics to stderr with `console.error`.
- Keep tool outputs compact. Prefer short text or small structured objects over verbose logs.
- Add a companion skill for nontrivial servers; MCP schemas are not enough procedural context.

## Bootstrap

Start from the bundled template. From the canonical source repository, use its
repo-relative path:

```sh
cp -R skills/codex-project-tooling/assets/fastmcp-bun-template .codex/mcp/<server-name>
cd .codex/mcp/<server-name>
bun install
```

When using an installed skill instead of the canonical repository, resolve the
same template from `$CODEX_HOME/skills/codex-project-tooling/assets/`.

Then update:

- `package.json` name and scripts if needed.
- `src/start.ts` if dependency installation needs a different policy.
- `src/index.ts` server name, version, and tool registrations.
- `src/tools/*` tool implementations.
- `src/lifecycle.ts` if the MCP owns an environment stack.

Register Codex against `src/start.ts`, not `src/index.ts`, when the MCP lives in a repo or worktree that might not have dependencies installed yet. The starter installs dependencies first, routes install output to stderr, then launches the stdio MCP server with stdout reserved for JSON-RPC.

After `bun install`, commit the generated `bun.lock` with the MCP project. The start wrapper can recover in a fresh worktree, but a committed lockfile keeps dependency resolution reproducible and avoids surprise lockfile churn during MCP startup.

## FastMCP Server Skeleton

```ts
import { FastMCP } from "fastmcp";
import { z } from "zod";

const server = new FastMCP({ name: "project-env", version: "0.1.0" });

server.addTool({
  name: "health",
  description: "Return a compact health check for this MCP server.",
  parameters: z.object({
    verbose: z.boolean().optional(),
  }),
  execute: async ({ verbose }) => {
    return JSON.stringify({ ok: true, verbose: Boolean(verbose) });
  },
});

server.start({ transportType: "stdio" });
```

## Tool Design

- Tool names should be stable, lowercase, and action-oriented.
- Descriptions should say what the tool does, not the entire workflow.
- Schemas should reject ambiguous input where possible.
- Prefer explicit enum parameters over free-form strings when the allowed values are known.
- Return user-actionable errors. Do not leak secrets or large logs.
- If a tool can mutate files or external state, make that obvious in the description and pair it with conservative approval config.

## Validation

Run the narrow checks first:

```sh
bun install
bun run typecheck
bun test
bun run validate:stdio
```

Use `bun run validate:stdio` for unattended MCP protocol smoke testing. It starts the server as a background process, sends newline-delimited JSON-RPC over stdin, checks `initialize`, `tools/list`, and the template `health` tool, then terminates the server.

Use `bun run inspect:browser` as an interactive/manual check when needed. It starts the MCP inspector, opens a browser, and is not a one-shot command. In Codex Desktop, an agent with browser-control tools can pilot that inspector for richer manual validation.

If the MCP is registered in Codex config, start a fresh trusted Codex thread and verify:

- The server starts without MCP startup failures.
- Expected tools are visible.
- A harmless health tool works.
- Outputs are compact in the agent transcript.
- Stack cleanup runs when the MCP process exits, if the server owns a stack.
