# Skizzles on Cursor

Cursor's harness is not Grok Build and is not Codex. Do not assume ACP options, hooks, agent profiles, or plugin install match either of those surfaces.

- Follow the nearest repository `AGENTS.md`. Adopt `profiles/AGENTS.md` only when that project already chose it.
- Use the installed Skizzles personal skills (Cursor scans `skills/*/SKILL.md` under the Cursor home). The portable set includes T3 orchestration plus the same useful domain skills Grok gets; it does not include Codex-only installer/config surfaces.
- Skizzles' Codex plugin hooks and Grok Build launcher/agents are not part of this Cursor surface. Do not invent parity for hooks, spawn guards, or model launchers that are not installed here.
- T3 Cursor work uses `--provider cursor`, which maps to T3 instance `cursor`, model `grok-4.6`, and option `reasoning=high`. Messaging an existing thread cannot change its provider.
