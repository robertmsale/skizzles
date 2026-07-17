---
name: codex-project-tooling
description: Author and maintain repo-local Codex project tooling. Use when configuring project-level .codex/config.toml, hooks, subagent roles under .codex/agents, repo-local MCP servers, Bun/FastMCP scaffolding, paired MCP skills, trusted-project behavior, linked worktree behavior, or repo-specific Codex automation conventions.
---

# Codex Project Tooling

Use this skill to configure Codex behavior that belongs to a repository rather than a single user. Prefer small, reviewable project-local changes that future agents can understand from the repo itself.

## Workflow

1. Identify whether the task is about hooks, subagent roles, MCP servers, project `.codex` loading, or a combination.
2. Read the relevant reference before editing:
   - Hooks: `references/hooks.md`
   - Subagent roles: `references/subagent-roles.md`
   - MCP authoring with Bun + FastMCP: `references/mcp-authoring.md`
   - Codex MCP client behavior and config: `references/mcp-codex-client.md`
   - Companion skills for MCPs: `references/mcp-associated-skills.md`
   - MCP-managed environment stacks: `references/mcp-lifecycle-stacks.md`
   - Project `.codex`, trust, and worktrees: `references/project-codex.md`
3. Inspect existing repo-local `.codex` files before adding new ones.
4. Prefer committed, repo-local templates for durable team behavior. Keep personal secrets, machine paths, credentials, and temporary experiments out of committed config.
5. Validate syntax and behavior with the narrowest practical check, such as parsing TOML/JSON, listing hooks, spawning a role in a safe test prompt, or inspecting an MCP server.

## Defaults

- Keep hook commands deterministic, non-interactive, and bounded by timeouts.
- Keep subagent role descriptions short but operational: say when to use the role, what it owns, and what it must avoid.
- Prefer stdio Bun/FastMCP servers for repo-local MCP tooling.
- Omit `cwd` for repo-local MCP servers so Codex starts them in each task's workspace. Set `cwd` only when the server intentionally uses a fixed absolute directory; never use `cwd = "."`.
- Pair nontrivial MCP servers with a skill that explains when to use the tools and how to interpret outputs.
- Use relative paths inside repo-local config when the file lives in the repo.
- Treat project tooling as shared infrastructure: avoid clever one-off scripts unless they become stable, documented project assets.
- When Codex Desktop worktrees are involved, confirm how `.codex` files and hooks resolve before assuming a worktree has different project tooling from the root checkout.

## Output

When adding or changing project tooling, summarize:

- Files changed.
- Which hooks, roles, MCP servers, or paired skills are now available.
- How trust/worktree behavior affects the setup.
- How the change was validated.
