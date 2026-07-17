# Skizzles portable harness profile (opt-in)

Adopt this policy only when a project owner explicitly chooses it. Copy or link it deliberately into the target project and adapt its ownership map; this file never auto-installs, overwrites an existing `AGENTS.md`, or changes live host configuration.

## Portable harness policy

- Keep agent guidance, hooks, skills, runtime assets, and generated outputs in reviewed source control.
- Keep canonical source separate from generated or staged artifacts. Rebuild generated output from source and reject drift instead of hand-editing it.
- Treat machine paths, credentials, caches, logs, databases, Finder metadata, and live state as non-distributable unless the project intentionally defines a safe, reviewed exception.
- Keep live installation, hooks, environment variables, service managers, and external runtimes behind an explicit owner-approved cutover. Validate first in an isolated project fixture where practical.
- Preserve user and collaborator changes. The integration owner makes Git checkpoints only for coherent, validated slices and excludes unrelated metadata or work-in-progress files.
- Use the project’s own validation commands and record the command/result with each meaningful handoff.

Remove or rewrite rules that do not match the adopting project. This profile is a portable starting point, not an authority over that project’s existing instructions.
