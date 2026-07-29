# Maintainer design intent

Skizzles has several deliberately evolved behavior and installation contracts. An unfamiliar implementation is not evidence that the whole surface should be replaced. Before changing one of these areas, inspect its owning source, tests, documentation, and relevant history; preserve the established behavior unless the proposal explicitly changes that contract.

This document records the intent behind decisions that cross package boundaries. Owning documents remain authoritative for exact commands, schemas, and runtime behavior.

## Reviewable change boundaries

- Start from current upstream and keep each contribution focused on one coherent cause or authority surface.
- Reproduce a defect or port the causal regression test before applying a reliability or security fix where practical.
- Do not combine installation, distribution, orchestration, model routing, prompts, telemetry, command supervision, repository policy, and CI changes merely because they can share one branch.
- Preserve public names, configuration, state, labels, cleanup discovery, host wiring, and installation behavior unless the change includes an explicit compatibility or migration decision.
- Treat a refactor as behavior-preserving work. A path migration may be intentional, but it does not authorize unrelated product or policy changes.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the human contribution workflow and [AGENTS.md](../AGENTS.md) for coding-agent execution rules.

## Packaging and local validation

Skizzles is a packaging repository, not a live installation. Canonical sources are edited once, generated roles and plugin output are rebuilt from them, and drift checks prove the projection. Generated files are not an alternate authority.

Validation is intentionally local-first. Hosted GitHub Actions previously expanded the project’s authority surface without being part of its operating model. Do not add or require hosted CI incidentally; use the repository’s local checks unless the owner makes a separate hosted-CI decision.

## Fixed roles and orchestration

The generated Triage, Worker, Designer, QA, Review, Deployment, and default roles intentionally bind duties to selected model and reasoning pairs. The higher reasoning floors are part of the tested routing policy, not placeholders for an older escalation ladder. Change them through the canonical role specification with explicit evidence, then regenerate the role files required by the selected installation mode.

Fourth Wall is proactive, evidence-rich orchestration guidance. It gives the root enough information to decide when delegation improves speed or quality; it is not a blanket “do not orchestrate” rule.

- The complete handoff procedure is deliberate. Handoff is normally a one-time lifecycle boundary, so deleting required operational state is not a useful recurring token optimization.
- The `<role>__<objective>` convention gives child tasks visible role context. Peer task paths are callable identities and do not need to be renamed during handoff.
- The learning loop records bounded evidence and never changes skills, roles, routing, hooks, configuration, or installs automatically.
- A repository learning-log resource is not part of the product. Durable private curation, when an owner explicitly wants it, remains host-local and outside packaging.

See [Fourth Wall](../skills/fourth-wall/SKILL.md), its [handoff contract](../skills/fourth-wall/references/handoff-packet.md), and its [learning loop](../skills/fourth-wall/references/learning-loop.md).

## Container Lab purpose

The `codex-container-lab` name describes the product: a parallelization and reproducible-experiment primitive built around isolated Git workspaces and project-owned Docker Compose topology. It is not a generic hostile-code sandbox.

Each task or hypothesis can receive its own clone and Compose identity, perform a complete inspect-edit-build-test-fix loop, and return selected changes through guarded synchronization or ordinary Git patches. The original checkout is never mounted into the command container. The root task owns final integration.

The established CLI, `.codex-container-lab.yaml` manifest, state paths, Docker labels, reaper discovery, model-catalog integration, and optional LaunchAgent wiring are user-facing contracts. Renaming or replacing them requires an explicit compatibility plan so existing resources and installations do not become invisible.

Project-authored Compose inputs remain trusted project configuration. Relative build contexts, `.env` behavior, `env_file`, configs, binds, services, databases, caches, and other declared topology stay owned by the consuming repository. Container Lab adds only its isolated workspace, exact ownership labels, init behavior, thread-scoped lifecycle state, and explicitly declared random loopback ports; findings report notable project configuration rather than silently rejecting it.

See the Container Lab [architecture](../packages/skizzles-container-lab/docs/architecture.md), [manifest](../packages/skizzles-container-lab/docs/manifest.md), [safety model](../packages/skizzles-container-lab/docs/safety.md), and [completion contract](../packages/skizzles-container-lab/docs/completion-contract.md).

## Evaluating hardening proposals

Focused hardening is welcome when evidence justifies its cost and compatibility impact:

- Host subprocess-tree supervision should begin with causal tests for pre-start cancellation, surviving descendants, escalation, and inherited output pipes, followed by the smallest process fix.
- An immutable normalized Compose topology may improve lifecycle reproducibility, but it must be evaluated separately from policies that reject normal trusted-project inputs.
- Narrow Git and Docker environments are reproducibility hardening, not a second sandbox. Compatibility tests must cover environment variables Skizzles intentionally supports.
- Stronger clone-independence checks may help linked worktrees or borrowed object stores, but cloning time and disk amplification must be measured.
- Synchronization and filesystem-identity hardening should start from a reproduced race or failing adversarial test. The trusted-local-project threat model does not justify treating every local path as hostile by default.

These proposals do not authorize a repository-wide framework replacement. Each can be reviewed and integrated independently.

## Security authority

Skills, instructions, exec rules, hooks, and the command supervisor have different responsibilities. None replaces Codex’s filesystem and network sandbox or grants new host authority. See the [Skizzles security model](security-model.md).

## Provenance

This intent consolidates the maintainer’s review of [robertmsale/skizzles#1](https://github.com/robertmsale/skizzles/pull/1) and the canonical contracts linked above. The repository sources and tests, not the review conversation, define current behavior.
