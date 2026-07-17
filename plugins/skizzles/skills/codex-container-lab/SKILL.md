---
name: codex-container-lab
description: Operate disposable Docker Compose labs through the external codex-container-lab CLI. Use when Codex needs an isolated Linux workspace, attached command execution, bounded logs, transactional synchronization, or explicit cleanup without mutating the host source checkout.
---

# Codex Container Lab

Treat Container Lab as an independently released runtime prerequisite. From a versioned Skizzles checkout, run `bun packages/installer/src/cli.ts doctor --home <isolated-home> --codex-home <isolated-codex-home>` to check the repository-owned compatibility descriptor. If only this skill or the stable plugin is installed, do not assume that repository CLI is present. A configured runtime version of `0.1.0` remains unverified until the external project exposes a version endpoint.

## Operate a lab

1. Confirm the repository contains `.codex-container-lab.yaml` and run `codex-container-lab health` with the current task owner.
2. Create a lab with `codex-container-lab lab create --name NAME` and inspect its privilege findings.
3. Run attached work directly with `codex-container-lab run --lab ID -- COMMAND...`. Keep this command outermost; never wrap it in a Skizzles subprocess.
4. Read bounded output with `codex-container-lab logs --lab ID --service SERVICE`.
5. Preview synchronization, resolve every conflict, then apply the exact single-use token.
6. Validate host changes and explicitly destroy the lab.

Use one owner per Codex task. Never borrow another task's owner, guess ports, expose Docker sockets or credentials, invoke the installed reaper for diagnosis, or point a doctor at live state/runtime roots. Container Lab owns its CLI, reaper, LaunchAgent, security/redaction rules, and release lifecycle; Skizzles does not install, relocate, or update them.
