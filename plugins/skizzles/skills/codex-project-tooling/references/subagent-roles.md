# Codex Subagent Roles Reference

Subagent roles describe the types of agents the orchestrator can spawn. Good roles are concise, scoped, and operational: they tell the parent when to use the role and tell the child how to behave.

## Agents Settings

Project `.codex/config.toml` can set agent limits and role declarations:

```toml
[features]
multi_agent = true
goals = true

[agents]
max_threads = 6
max_depth = 1
job_max_runtime_seconds = 7200
interrupt_message = true
```

Fields:

- `max_threads`: Maximum concurrent agent threads. Omit for no explicit limit. Must be at least 1 when set.
- `max_depth`: Maximum spawn nesting depth. Root sessions start at depth 0. Use `1` to allow top-level agents to spawn subagents while preventing subagents from spawning more agents.
- `job_max_runtime_seconds`: Default maximum runtime for agent job workers.
- `interrupt_message`: Whether interrupted agent turns leave a model-visible message; defaults to true.

When `features.multi_agent_v2` is enabled, `agents.max_threads` cannot be set. Use the v2 concurrency config instead. For normal project roles, follow the project's existing multi-agent feature style.

## Inline Role Declarations

Declare roles under `[agents.<role>]`:

```toml
[agents.explorer]
description = "Use for mapping the current codebase shape to the desired outcome before implementation. Explorers inspect, summarize, and recommend an execution path without modifying product source."
config_file = ".codex/agents/explorer.toml"
nickname_candidates = ["Scout", "Mapper", "Surveyor"]
```

Fields:

- `description`: Required unless supplied by the referenced role file. This text appears in spawn tool guidance.
- `config_file`: Optional role-specific TOML config layer. Relative paths resolve relative to the config file that declares them.
- `nickname_candidates`: Optional non-empty list. Values must be unique and contain only ASCII letters, digits, spaces, hyphens, and underscores.

## Discovered Role Files

Codex also discovers role files under `.codex/agents/**/*.toml`. This is usually the cleanest project-local form:

```toml
name = "review"
description = "Use for adversarial review of completed changes. Reviewers inspect diffs, validation proof, missed requirements, security risks, dead code, and tombstones; they report findings to the orchestrator instead of editing by default."
nickname_candidates = ["Auditor", "Verifier", "Crosscheck"]

developer_instructions = """
You are an adversarial review agent. Prioritize correctness, missed requirements, security risks, dead code, build/test proof, and behavior regressions.
Lead with findings and concrete file references. Do not rewrite the implementation unless explicitly asked.
"""
```

Role files may include normal Codex config keys after the role metadata. Examples include:

- `developer_instructions`
- `model`
- `model_reasoning_effort`
- `service_tier`
- `approval_policy`
- `sandbox_mode`
- `[features]`
- MCP and tool configuration supported by normal config loading

Discovered role files must define `name`, `description`, and `developer_instructions`. Files referenced by `[agents.<role>].config_file` can inherit the role name and description from the declaration.

## Precedence And Loading

- User-defined roles override built-in roles with the same name.
- Built-ins include `default`, `explorer`, and `worker`.
- Role config is applied as a high-precedence config layer at spawn time.
- Current model provider and service tier are preserved unless the role config explicitly sets them.
- Role descriptions are merged across config layers by filling missing fields from lower-precedence layers.
- Duplicate role names in the same config layer are ignored with startup warnings.

## Practical Role Templates

Worker:

```toml
name = "worker"
description = "Use for well-defined implementation after the plan is clear. Workers own assigned files or modules, make focused edits, avoid reverting others, and report validation results."

developer_instructions = """
Carry out the assigned implementation slice. Respect file ownership from the parent prompt.
Assume other agents may be editing nearby code. Preserve their work and adapt instead of reverting.
Prefer small, correct, maintainable changes with targeted validation.
"""
```

Explorer:

```toml
name = "explorer"
description = "Use for read-only exploration before implementation. Explorer maps current codebase shape to desired outcome, identifies constraints, and proposes an execution path."

developer_instructions = """
Explore first and summarize what exists, what must change, risks, and recommended next steps.
Prefer code references and concrete findings. Do not make implementation edits unless explicitly assigned.
"""
```

Reviewer:

```toml
name = "review"
description = "Use for adversarial review of proposed or completed changes. Reviewers check compile/test proof, missed requirements, security risks, regressions, dead code, and refactor tombstones."

developer_instructions = """
Review adversarially. Lead with findings ordered by severity and include concrete file references.
Check whether relevant project skills or requirements were followed. Treat missing validation as a finding when risk warrants it.
"""
```

## Authoring Guidance

- Put operational rules in `developer_instructions`, not only in the description.
- Keep descriptions short enough to scan in spawn tool guidance.
- Keep write ownership disjoint when nested fan-out is enabled.
- Give the parent guidance in role descriptions and the child guidance in role config.
- Prefer role-specific permissions only when the role truly needs different safety boundaries.
