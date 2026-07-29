# Skizzles portable harness profile (opt-in)

Adopt this policy only when a project owner explicitly chooses it. Copy or link
it deliberately into the target project and adapt its ownership map; this file
never auto-installs, overwrites an existing `AGENTS.md`, or changes live host
configuration.

## Portable harness policy

- Keep agent guidance, hooks, skills, runtime assets, and generated outputs in
  reviewed source control.
- Keep canonical source separate from generated or staged artifacts. Rebuild
  generated output from source and reject drift instead of hand-editing it.
- Treat machine paths, credentials, caches, logs, databases, Finder metadata,
  and live state as non-distributable unless the project intentionally defines
  a safe, reviewed exception.
- Keep live installation, hooks, environment variables, service managers, and
  external runtimes behind an explicit owner-approved cutover. Validate first
  in an isolated project fixture where practical.
- Preserve user and collaborator changes. The integration owner makes Git
  checkpoints only for coherent, checked slices and excludes unrelated metadata
  or work-in-progress files. Prefer a checkpoint when it provides a useful
  review or rollback point; ordinary tasks may remain uncheckpointed.
- For a meaningful handoff, use the project’s checks that can prove the changed
  behavior and record the command and result.
- Choose planning, architecture, staging, or similar preparation when the scope
  or risk benefits from it; a formal plan can remain optional for routine tasks.
- Choose the safest efficient edit method for the boundary; `apply_patch` is
  one available option.
- Prefer the requested correct outcome. An MVP, prototype, or placeholder is a
  valid scope or milestone when explicitly user-approved; for other work,
  target the requested outcome.
- Prefer local compute for builds, tests, linting, packaging, security scans,
  and other checks. Do not create, modify, enable, trigger, or require GitHub
  Actions or another hosted CI system unless the owner explicitly requests
  hosted CI in the current task. If local checking is blocked, report the gap
  instead of silently moving it to a cloud runner.

Remove or rewrite rules that do not match the adopting project. This profile is
a portable starting point, not an authority over that project’s existing
instructions.
