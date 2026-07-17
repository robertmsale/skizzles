# Repo-Local `.codex` Reference

Repo-local Codex configuration lets a project carry its own agent roles, hooks, skills, and local conventions. Use it for durable project behavior that should follow the repository across machines and worktrees.

## Common Layout

```text
.codex/
  config.toml
  hooks.json
  hooks/
    check-shell.py
  agents/
    triage.toml
    reviewer.toml
  skills/
    project-skill/
      SKILL.md
```

Use only the pieces the project needs. Avoid committing local credentials, machine-specific paths, and experimental scratch files.

## Project Config

`.codex/config.toml` can define repo-local features, hooks, agents, permissions, MCP settings, and other normal Codex config. Prefer relative paths for files committed in the repo:

```toml
[features]
hooks = true
multi_agent = true
goals = true

[agents]
max_threads = 6
max_depth = 1

[agents.reviewer]
description = "Use for adversarial review of completed changes."
config_file = ".codex/agents/reviewer.toml"
```

Keep repo config focused on shared project behavior. Put personal preferences in
the user-level `$CODEX_HOME/config.toml`, not in the repository.

## Trust Behavior

Project config, hooks, and agent roles are gated by trusted project layers. A repo generally must be trusted before its project `.codex/config.toml`, hooks, and role definitions affect sessions.

Skills are more discoverable than other project configuration: repo-local skill roots may be available even when other project layers are disabled. Do not rely on this exception for privileged behavior; put privileged automation behind trusted hooks/config instead.

When authoring project tooling, document whether the user must trust the project before the change works.

## Desktop Linked Worktrees

Codex Desktop can spawn sessions in linked worktrees. In linked worktrees:

- Trust resolves back through the `.git` file to the root repository identity.
- Worktree-local checked-out `.codex/config.toml`, `.codex/agents`, and `.codex/skills` come from the worktree contents.
- Hook declarations are special-cased to use the matching root checkout `.codex` hook declarations instead of divergent worktree hook declarations.

Practical consequence: if a project relies on hooks, update and trust the root checkout behavior. If a project relies on roles or config, make sure the worktree branch contains the intended `.codex` files.

## Committed Versus Local-Only

Commit when the behavior is durable and project-relevant:

- Role definitions for recurring project responsibilities.
- Hook scripts that enforce repo conventions.
- Skills that encode project domain knowledge.
- Config needed for build reproducibility or safe agent orchestration.

Keep local-only when the behavior is personal or sensitive:

- Credentials and tokens.
- Absolute paths outside the repo.
- Temporary experiments.
- User-specific model/provider choices unless the role intentionally locks them.

## Validation Checklist

- Parse TOML/JSON after edits.
- Confirm referenced files exist and use relative paths when committed.
- Confirm role files define required metadata.
- Confirm hook scripts are executable through their configured command.
- Confirm trusted-project expectations are documented in the final response.
- In a linked worktree, confirm whether the relevant behavior comes from root checkout hooks or worktree config/agents.
