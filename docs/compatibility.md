# Codex Compatibility

Skizzles supports three host tiers. The current task's advertised tool inventory always controls which operations an agent may call.

This matrix records the compatibility evidence supplied by Robert Sale on 2026-07-29. It does not promise that every future CLI release or Desktop task exposes the same tools.

| Capability | CLI `0.145.0` | CLI `>= 0.146.0-alpha.3` | Desktop bundled `0.146.0-alpha.3.1` |
| --- | --- | --- | --- |
| Skills, plugins, hooks, managed command output | Supported | Supported | Supported |
| Container Lab | Supported when Docker or OrbStack and the packaged or source runtime are available | Same | Same |
| MultiAgentV2 child tree and same-root coordination | Partial; enable V2/collaboration and use only advertised tools | Full Skizzles core | Full Skizzles core |
| Same-root lifecycle and messaging tools | Conditional on active inventory | Supported | Supported |
| Fixed Triage, Worker, Designer, QA, Review, and Deployment role/model/reasoning selection | Conditional; not the durable baseline | Supported when generated roles are configured | Supported when generated roles are configured |
| Continuity after residency eviction, reload, or later reactivation | Not guaranteed; reactivation is not proof | Not guaranteed after eviction or reload; reactivation is not proof | Not guaranteed after eviction or reload; reactivation is not proof |
| Browser, Computer Use, appshots, realtime voice, and native pipes | Not CLI model tools | Not CLI model tools | Conditional; advertised per task |
| Cross-root task operations | Not CLI model tools | Not CLI model tools | Desktop-only extras when advertised |

## CLI `0.145.0`: portable/partial

Skills, hooks, Container Lab, and basic child-tree work are supported when the session exposes the required tools. Tagged source may select configured roles, but Skizzles does not present this tier as the persistent fixed-role workflow.

Use passive configuration on unknown or partial hosts. It enables hooks without writing MultiAgentV2 settings.

## CLI `>= 0.146.0-alpha.3`: full same-root core

Fixed roles with their configured model and reasoning effort, plus native same-root MultiAgentV2 coordination, are supported while the selected child remains resident. Fixed-role behavior requires `--instructions skizzles` or equivalent configuration of the generated role files; plugin presence alone is insufficient. This tier does not add Desktop task management, browser control, Computer Use, voice, or other Desktop-hosted tools.

Aggressive configuration is appropriate only when the session advertises the collaboration tools the workflow needs. If the host rejects the settings or omits a required tool, restore or use passive mode rather than emulating the missing feature.

## Desktop: optional inventory-scoped extras

Desktop is an enhancement tier, not a prerequisite. Dynamic functions are advertised per task. A cross-root operation, when advertised, can address another root, but it remains a Desktop-only extra rather than a CLI dependency. Do not infer a capability from the Desktop application, a CLI version, or another task.

## Same-root and cross-root work

`spawn_agent`, `list_agents`, `wait_agent`, `interrupt_agent`, `send_message`, and `followup_task` operate only inside the current root tree and only when advertised.

When a cross-root task operation is unavailable, write one compact packet under the task's `/tmp` workspace, report its path and next action, and use a manual handoff. Do not make CLI orchestration depend on Desktop-only operations.

## Role limits

`fork_turns="all"` bypasses selected-role configuration. Use `"none"` or a bounded positive turn count for a role-qualified child.

Eviction or reload ends the continuity guarantee. Reactivating a child afterward does not prove that its role, model, or reasoning effort survived. When continuity matters, create a fresh sibling with explicit role selection and a compact handoff.

## Installation identity

The plugin and a plain-skill copy are alternative installation surfaces for the same Skizzles skill. Plugin skills are namespaced, while direct skills use plain identifiers. Remove a direct copy before installing or enabling the plugin, and do not directly install a skill already supplied by the enabled plugin.

## Piloting fallback

When browser control, Computer Use, appshots, realtime voice, or native Desktop pipes are absent, use the available production entrypoint, command output, logs, and saved artifacts. Do not block a CLI workflow on a Desktop-only proof path.
