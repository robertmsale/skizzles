# Skizzles ✨

![Skizzles logo](assets/logo.png)

Skizzles is a friendly, reviewable Codex harness: reusable skills, helpful hooks, tiny runtime tools, and release packaging in one canonical source tree. It turns the fiddly parts of agent work into a tidy little toolkit. 🧰

## What’s inside

- **Command-output management** — classifies useful build/test commands, keeps output bounded, and leaves a useful artifact when a command gets noisy.
- **Fourth Wall orchestration** — guarded multi-agent dispatch with explicit roles, contracts, and follow-up boundaries.
- **Usage analyzer** — privacy-conscious, read-only rollout analysis using an explicit `CODEX_HOME`.
- **Container Lab, batteries included** — a skill, full canonical source project, bundled CLI/reaper, compatibility descriptor, and safe doctor boundary for disposable Docker Compose labs. 🔬
- **A practical skill shelf** — auth semantics, Cargo optimization, completion contracts, counterfactual engineering, design proof gates, legacy cleanup, Rinf boundaries, project tooling, and a gated designer runtime.
- **Installation help** — the public `install-skizzles` skill guides an LLM through optional host wiring after a skill-only install.

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

Container Lab is fully included in this repository—not merely documented here. A source-linked installation runs the canonical CLI and reaper directly from the checkout, while the stable plugin carries dependency-self-contained bundles. If you install only a copied skill, `install-skizzles` guides Codex through obtaining a selected Skizzles version and installing the complete surface; the launcher can also use an existing `codex-container-lab` PATH command. Host PATH and LaunchAgent wiring are optional, explicit, reversible, and machine-local. Full-harness development uses the isolated installer and generated plugin; keep live Codex configuration outside ordinary repository setup.

## Keep the loop delightful

Build and verify the generated plugin from source with:

```sh
bun install --frozen-lockfile
bun run verify
```

Plugins and new tasks use cached, versioned content, so start a fresh task after an update. For ownership, release rules, and safety details, see [AGENTS.md](AGENTS.md).

> **Pre-release note:** the Git-based examples become runnable once the repository and a versioned release are published. Stable marketplace publication remains a separate release step; host wiring is optional machine-local setup.
