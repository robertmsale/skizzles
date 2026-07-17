# Skizzles ✨

![Skizzles logo](assets/logo.png)

Skizzles is a friendly, reviewable Codex harness: reusable skills, helpful hooks, tiny runtime tools, and release packaging in one canonical source tree. It turns the fiddly parts of agent work into a tidy little toolkit. 🧰

## What’s inside

- **Command-output management** — classifies useful build/test commands, keeps output bounded, and leaves a useful artifact when a command gets noisy.
- **Fourth Wall orchestration** — native multi-agent dispatch with explicit roles, capability routing, useful context forks, and reusable specialist tasks.
- **Usage analyzer** — privacy-conscious, read-only rollout analysis using an explicit `CODEX_HOME`.
- **Container Lab, batteries included** — a skill, full canonical source project, bundled CLI/reaper, compatibility descriptor, and safe doctor boundary for disposable Docker Compose labs. 🔬
- **Luna joins the V2 party** — an opt-in model-catalog overlay and tiny launchd refresher preserve the official catalog while enabling proven Luna workers in native MultiAgentV2. 🌙
- **A practical skill shelf** — auth semantics, Cargo optimization, completion contracts, counterfactual engineering, design proof gates, legacy cleanup, Rinf boundaries, project tooling, and a gated designer runtime.
- **Installation help** — the public `install-skizzles` skill guides an LLM through optional host wiring after a skill-only install.
- **A polite config handshake** — enable the hooks, then choose passive native orchestration or the full proactive Fourth Wall experience without trampling the rest of `config.toml`. 🤝

Everything is maintained once in the canonical roots and workspace packages, then staged into a versioned plugin. 🎯

## Pick your ride

### Stable plugin

**WIP:** Use the official Codex marketplace/plugin flow to install a released `skizzles` plugin. It packages the skills, hooks, runtime helpers, branding, and runnable Container Lab CLI/reaper together.

### Individual skills

Install just the skills you want with the Skills CLI:

```sh
bunx skills add https://github.com/robertsale/skizzles --skill install-skizzles
```

Add `--skill <name>` for another public skill, or omit it to choose interactively. Skill-only installs do not activate Skizzles hooks or runtime helpers; [install-skizzles](skills/install-skizzles/SKILL.md) explains the optional next steps.

### Source-linked development

For maintainer work, use a local checkout and point the Skills CLI at its canonical `skills/` directory:

```sh
git clone https://github.com/robertsale/skizzles.git
cd skizzles
bunx skills add ./skills --skill install-skizzles
```

Container Lab is fully included in this repository—not merely documented here. A source-linked installation runs the canonical CLI and reaper directly from the checkout, while the stable plugin carries dependency-self-contained bundles. If you install only a copied skill, `install-skizzles` guides Codex through obtaining a selected Skizzles version and installing the complete surface; the launcher can also use an existing `codex-container-lab` PATH command. Host PATH and LaunchAgent wiring are optional, explicit, reversible, and machine-local.

After installing the complete plugin surface, Skizzles can safely finish the Codex-side handshake:

- **Passive orchestration** enables the packaged hooks and leaves Codex’s native MultiAgentV2 defaults completely alone.
- **Aggressive orchestration** also enables MultiAgentV2, keeps seven task slots available, and adds tiny root/subagent pointers to `$fourth-wall` plus the proactive quality-and-speed trigger. 🚀

The configuration lifecycle previews before writing, uses Codex’s own atomic config editor, preserves comments and unrelated settings, and records only the keys it owns for drift-safe restoration. It never edits `AGENTS.md`, personal instructions, approvals, permissions, goals, model defaults, or MCP registrations. See [install-skizzles](skills/install-skizzles/SKILL.md) for the exact commands.

The optional Luna V2 overlay lives in `runtime/model-catalog.ts`. It regenerates a complete static catalog from the newest valid normal cache or the installed Codex binary, changes only Luna's compatibility marker, and becomes a no-op when upstream enables V2 officially. Its launchd template watches both sources and runs every five minutes; catalog changes take effect after the next app-server restart. See `assets/model-catalog-installation.md` before activating it. 🚀

## Keep the loop delightful

Build and verify the generated plugin from source with:

```sh
bun install --frozen-lockfile
bun run verify
```

Plugins and new tasks use cached, versioned content, so start a fresh task after an update. For ownership, release rules, and safety details, see [AGENTS.md](AGENTS.md).

> **Pre-release note:** the Git-based examples become runnable once the repository and a versioned release are published. Stable marketplace publication remains a separate release step; host wiring is optional machine-local setup.
