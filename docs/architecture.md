# Skizzles Repository Architecture

## Task Contract

- `OBJ-001`: Keep Skizzles behavior stable while making the repository easier for maintainers and coding agents to navigate and change.
- `REQ-001`: Integrate the two `robertmsale/main` commits without losing the nine local `main` commits.
- `REQ-002`: Every authored workspace package directory is named `packages/skizzles-*`.
- `REQ-003`: Every authored workspace package manifest uses an `@skizzles/*` package name.
- `REQ-004`: Remove obsolete workspace paths instead of retaining aliases, wrappers, or parallel package layouts.
- `REQ-005`: Keep authored TypeScript source and test files at or below 450 lines. Generated bundles are exempt.
- `REQ-006`: Reject exact duplicate authored files. Generated outputs are exempt.
- `REQ-007`: Separate mixed TypeScript responsibilities behind focused modules and thin executable entrypoints.
- `CON-001`: Preserve CLI arguments, outputs, exit statuses, plugin contents, installation behavior, hook behavior, and Container Lab safety behavior.
- `CON-002`: `plugins/skizzles/` and `assets/agents/` remain generated and must be rebuilt from canonical sources.
- `CON-003`: The root `bun.lock` remains the only lockfile.
- `EXC-001`: Backward compatibility for old workspace paths is explicitly out of scope.
- `EXC-002`: Live installation, host `PATH`, launchd, release, publication, and deployment are out of scope.

Definition of done: the fork merge is present; the package graph and source ownership match this document; old paths are absent; generated output is fresh; architecture checks, type checks, tests, packaging checks, and the production launchers pass.

## Evidence and Unknowns

### Facts

- `FACT-001`: The merge base with `robertmsale/main` was `b9824d9`; local `main` had nine exclusive commits and the fork had two exclusive commits.
- `FACT-002`: The fork changes usage credit accounting in `scripts/analyze.ts`, its generated plugin copy, and analyzer tests.
- `FACT-003`: The pre-change branch passed `bun run typecheck`, 232 Bun tests, and `bun run plugin:check`.
- `FACT-004`: The architecture audit reported generic package owners at `packages/skizzles-plugin` and `packages/skizzles-installer`, a 28-file flat Container Lab source directory, and authored TypeScript files above the 450-line review threshold.
- `FACT-005`: Exact-content hashing found no duplicate authored files when generated plugin output was excluded.
- `FACT-006`: Bun workspaces, package manifests, `integrations/container-lab.json`, package scripts, tests, launchers, and plugin staging code are authoritative path contracts.

### Assumptions

- `ASSUMED-001`: A 450-line TypeScript ceiling is the repository's intended definition of an authored large source file because it is the configured architecture review threshold. If false, the fitness test must be changed by an owner decision rather than bypassed.
- `ASSUMED-002`: Generated Bun bundles may exceed authored limits because their source maps and dependency closure are machine-produced and validated by deterministic regeneration.

No high-impact architecture decision depends on an unresolved assumption.

## Domain and Boundary Model

Skizzles is a packaging repository with four capability boundaries:

1. **Plugin packaging** owns deterministic staging, validation, generated-role assembly, and plugin drift detection.
2. **Installer** owns skills/harness installation, configuration lifecycle, receipts, and diagnostics.
3. **Container Lab** owns disposable-lab configuration, lifecycle, Docker effects, synchronization, durable lab state, and reaping.
4. **Distributable runtime inputs** own public hook, command-supervision, model-catalog, usage-analysis, skill, asset, and integration contracts staged into the plugin.

The root workspace is the composition root. It owns workspace membership, build order, canonical input selection, and aggregate verification. It does not own capability policy.

Generated plugin state has one writer: the plugin packaging pipeline. Generated agent roles have one writer: the role packaging pipeline. Neither generated tree may be edited directly.

## Quality-Attribute Scenarios

### `QA-MOD-001` — Repository Navigation

- Source: maintainer or coding agent
- Stimulus: locate and change one capability
- Environment: clean checkout
- Artifact: package and source tree
- Response: identifies one accountable package or module without searching aliases or duplicate implementations
- Measure: no old package paths; no generic top-level package names; no exact duplicate authored files
- Priority: high
- Verification: repository-boundary test and old-name search

### `QA-REV-001` — Human Reviewability

- Source: reviewer
- Stimulus: inspect a behavioral TypeScript change
- Environment: pull-request diff
- Artifact: authored TypeScript
- Response: reads focused modules with explicit imports and test seams
- Measure: no authored TypeScript file exceeds 450 lines
- Priority: high
- Verification: repository-boundary test and architecture audit

### `QA-COR-001` — Behavioral Fidelity

- Source: user or plugin host
- Stimulus: invoke an existing CLI, hook, installer operation, analyzer report, or Container Lab flow
- Environment: source checkout or generated plugin
- Artifact: public entrypoint
- Response: preserves arguments, output schema, exit behavior, safety checks, and side effects
- Measure: existing focused and aggregate tests pass unchanged except for path assertions
- Priority: high
- Verification: Bun tests, CLI smokes, plugin package tests

### `QA-REL-001` — Reproducible Packaging

- Source: maintainer
- Stimulus: build then check the plugin
- Environment: frozen root dependency graph
- Artifact: `plugins/skizzles/`
- Response: deterministic generated output with no machine paths, live state, forbidden metadata, or drift
- Measure: `plugin:build` followed by `plugin:check` passes
- Priority: high
- Verification: package tests and plugin checks

### `QA-SEC-001` — Trust Boundary Preservation

- Source: untrusted manifest, command, path, environment, or persisted state
- Stimulus: crosses installer, hook, command-runner, or Container Lab boundary
- Environment: local host
- Artifact: validation and effect modules
- Response: fails closed before unsafe filesystem, process, Docker, or configuration mutation
- Measure: existing negative and fault tests pass
- Priority: high
- Verification: focused subsystem tests

Performance, capacity, cost, and sustainability are not primary structural drivers here; the refactor must not add runtime processes, network calls, dependencies, or repeated serialization.

## Candidate Architectures

### Candidate A — Rename Only

Rename package directories and manifest names while leaving large mixed modules and the flat Container Lab source bucket intact.

- Benefit: smallest diff.
- Liability: fails `REQ-005` and `REQ-007`; navigation and reviewability remain poor.
- Decision: rejected.

### Candidate B — Capability-Oriented Modular Workspace

Use `packages/skizzles-*` capability packages, thin public entrypoints, focused internal modules, and pipeline stages only for packaging and usage analysis.

- State owner: each capability package or distributable runtime subsystem.
- Control authority: root scripts for build composition; package CLIs for runtime workflows.
- Dependency direction: entrypoint/coordinator to policy and representation modules; effect modules implement filesystem, process, Docker, SQLite, or Git boundaries.
- Extension: add a capability package only for an independently testable ownership boundary; add a module for a cohesive reason to change.
- Benefit: matches actual release and failure boundaries with limited indirection.
- Liability: coordinated path migration and broader initial diff.
- Decision: selected.

### Candidate C — Fine-Grained Ports-and-Adapters Packages

Split hooks, runtime, analyzer, Docker, state, synchronization, and packaging into separate workspace packages with interface packages between them.

- Benefit: strongest compile-time graph isolation.
- Liability: creates package and interface ceremony without independent deployment, reuse, or multiple adapters; increases packaging complexity.
- Decision: rejected.

## Decision Matrix

Scores are 1–5; higher is better.

| Candidate | Behavior Risk | Modifiability | Reviewability | Packaging Simplicity | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| A — Rename only | 5 | 2 | 1 | 5 | 13 |
| B — Capability workspace | 4 | 5 | 5 | 4 | 18 |
| C — Fine-grained packages | 2 | 4 | 4 | 1 | 11 |

## Selected Architecture and Consequences

`ADR-001`: Adopt a capability-oriented modular workspace with pipeline modules for deterministic transformations.

The enforcement profile is a modular monolith for the Skizzles plugin composition plus independently invoked library/CLI packages. Container Lab remains a distinct runtime package because it has its own process, persistence, Docker, failure, and safety boundaries.

Selected pattern invariants:

- Package directories name durable capabilities.
- Public executable files parse input, compose dependencies, render output, and return status; they do not own unrelated policy.
- Packaging and analysis stages use explicit typed inputs and outputs.
- Filesystem, process, Git, SQLite, Docker, and host-configuration effects remain visible at module boundaries.
- Generated state has one canonical producer and deterministic drift checks.
- Tests remain runner-recognized files outside production modules.

Accepted consequences:

- Old workspace paths disappear immediately.
- Path assertions and documentation must change atomically.
- Some imports become longer because ownership is explicit.
- No compatibility barrels or forwarding entrypoints remain.

Revisit when a capability gains independent publication/deployment, multiple effect implementations require a stable port, or the package graph becomes cyclic.

## Static Structure

```text
package.json                         root composition and verification
packages/
  skizzles-plugin/                   plugin and agent-role packaging pipeline
  skizzles-installer/                install/configure/doctor capability
  skizzles-container-lab/            Container Lab CLI, lifecycle, state, effects, docs
hooks/                               public hook entrypoint and hook-owned modules
runtime/                             public command/model runtime entrypoints and modules
scripts/                             public usage analyzer entrypoint and pipeline modules
skills/ assets/ integrations/        canonical distributable contracts
plugins/skizzles/                    generated plugin projection
assets/agents/                       generated role projection
tests/                               root public-contract and architecture tests
```

Allowed dependencies:

- Root composition may invoke any package public entrypoint.
- Plugin packaging may read canonical root inputs and package outputs.
- Installer may inspect packaged Container Lab paths but may not import Container Lab internals.
- Container Lab internals may depend only on their own capability modules and declared external dependencies.
- Root hooks, runtime, and analyzer modules may not import generated plugin output.
- No authored module imports from another package's private path.

## Critical Flows

### Plugin Build

Root script → role generation → canonical input inventory → Container Lab bundle → plugin validation → atomic generated-tree replacement.

- Invalid input: fail with a packaging error before replacement.
- Dependency failure: surface Bun build or filesystem diagnostic.
- Partial completion: staging directory is removed; previous generated plugin remains until successful replacement.
- Recovery: rerun the deterministic build.

### Public CLI or Hook Invocation

Entrypoint → argument/event parsing → semantic validation → coordinator → effect module → bounded representation → exit status.

- Invalid input: stable usage or validation error.
- Dependency failure: compact public diagnostic with existing redaction rules.
- Timeout/cancellation: existing signal and deadline semantics remain authoritative.
- Partial completion: subsystem-specific rollback, receipt, transaction, or failed-state rules remain unchanged.

## Component Contracts and Invariants

- **Plugin packager**: owns canonical selection, staging, validation, and drift comparison; must not mutate live installations.
- **Role packager**: owns template/spec validation and generated role projections; templates cannot define undeclared capabilities.
- **Installer**: owns explicit target roots and receipts; uninstall/configuration rollback touches only receipt-owned state.
- **Container Lab coordinator**: owns lifecycle ordering; Docker, Git, filesystem, and persisted-state modules do not decide workflow policy.
- **Container Lab run contract**: owns global/run option names, parsing, repository-relative working-directory rules, environment encoding, and timeout ceilings; the CLI and managed-command hook consume the same contract.
- **Managed command hook**: classifies only literal supported commands, recognizes only Container Lab runs accepted by the shared run contract, and preserves native approval unless explicitly bypassed.
- **Command supervisor**: owns process-tree signaling, bounded capture, status persistence, and public output.
- **Usage analyzer**: parses immutable rollout inputs, aggregates typed usage/credit state, and renders JSON or human projections without modifying inputs.

## Risks, Sensitivity Points, and Tradeoffs

| ID | Hazard | Trigger | Effect | Mitigation and Detection |
| --- | --- | --- | --- | --- |
| `RISK-001` | Stale path contract | package move misses a manifest, launcher, test, or document | runtime or packaging failure | exact old-path search, typecheck, focused CLI and package tests |
| `RISK-002` | Circular extraction | modules are split by line count rather than ownership | harder navigation | dependency review and no compatibility barrels |
| `RISK-003` | Generated drift | canonical moves are not rebuilt | shipped plugin differs | build then drift check |
| `RISK-004` | Behavior change hidden by refactor | policy moves with altered control order | safety or output regression | preserve tests first; focused negative/fault tests |
| `RISK-005` | Excess package granularity | directories become packages without a real boundary | build and cognitive overhead | top-level package fitness rule and ADR revisit trigger |

## ADR Index

- `ADR-001`: Capability-oriented modular workspace — accepted in this document.
- `ADR-002`: Immediate removal of old workspace paths — accepted because workspace compatibility is explicitly excluded.
- `ADR-003`: Authored TypeScript ceiling and duplicate-content gate — accepted as executable repository fitness functions.

## Implementation Slices

1. Merge and validate the fork commits.
2. Rename package owners and update every authoritative path contract atomically.
3. Add repository-boundary fitness tests.
4. Extract plugin packaging, installer, managed-command, usage-analysis, and Container Lab responsibilities into focused modules.
5. Rebuild generated roles and plugin output.
6. Run focused, aggregate, packaging, architecture, and runtime validation.

## Verification Plan

| Verification | Requirement | Method | Pass Criterion |
| --- | --- | --- | --- |
| `VER-001` | `REQ-001` | Git graph and analyzer tests | both fork commits are ancestors and focused tests pass |
| `VER-002` | `REQ-002`–`REQ-004` | repository-boundary test and `rg` | only `packages/skizzles-*`, all `@skizzles/*`, no old paths |
| `VER-003` | `REQ-005`–`REQ-007` | line/duplicate fitness test and architecture audit | no authored violation |
| `VER-004` | `CON-001` | typecheck and Bun tests | all checks pass |
| `VER-005` | `CON-002`–`CON-003` | agent/plugin build and drift checks | deterministic generated output and one lockfile |
| `VER-006` | runtime behavior | launcher, analyzer, installer, hook, and Container Lab tests | public entrypoints preserve behavior |

## Deferred / Out of Scope

- Publishing packages, tagging a release, creating a pull request, or pushing branches.
- Live Codex/plugin installation or host wiring.
- New product behavior beyond the merged credit-accounting feature.

## Blocking Questions

None.
