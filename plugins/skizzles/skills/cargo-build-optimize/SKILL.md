---
name: cargo-build-optimize
description: Profile and reduce Rust/Cargo build times through measured, behavior-preserving optimization campaigns. Use when a Rust workspace has slow cold builds, slow warm rebuilds, giant crates, duplicate dependencies, expensive macros/codegen, poor Cargo parallelism, or when asked to apply the fasterthanli.me Rust build profiling methodology, split crates for build speed, inspect cargo timings, or run a long-running /goal-driven build optimization effort.
---

# Cargo Build Optimize

Use this skill to run an iterative Rust build optimization campaign. Optimize by measurement, not taste. Prefer small structural slices that keep behavior unchanged and produce an immediate before/after signal.

## Goal Shape

For long-running work, set or ask the agent to set a `/goal` for the full campaign, not for the current slice.

Good goal shape:

```text
Reduce Rust build latency by iteratively improving compilation-unit structure.
1. Fix obvious dependency duplication.
2. Extract support crates before route/application crates.
3. Extract one vertical slice and evaluate.
4. Repeat for the next largest neighborhoods until returns diminish.
```

The active implementation should still be one small slice at a time. When a slice is complete, report the result and continue to the next slice if the campaign goal is not achieved.

Avoid goals like "extract this helper" because they lose the broader optimization mission. Avoid goals like "optimize all builds" unless they include an ordered campaign and measurable stopping criteria.

## Core Loop

1. Establish the narrowest direct command that represents the painful build path.
2. Capture a baseline with `--timings` when practical.
3. Classify the bottleneck: one giant local crate, duplicate dependencies, expensive macros, monomorphization/codegen, linking, or poor parallelism.
4. Pick exactly one behavior-preserving slice.
5. Make the smallest structural change that exposes a better compilation boundary.
6. Run direct validation for changed crates first, then the representative command.
7. Capture a new timing report and compare against the baseline.
8. Summarize the delta, remaining bottleneck, and next slice.

Do not begin with broad harnesses, full-stack scripts, or CI-equivalent commands if a direct Cargo command proves the same build surface faster.

## Baseline Commands

Start with commands like these, adjusted to the workspace:

```sh
cargo check -p <package> --features <features> --timings
cargo test -p <changed-helper-crate>
cargo tree -p <package> --features <features> -e normal,build -d
```

When compile-time database or service checks exist, preserve the project's normal build environment:

```sh
SQLX_OFFLINE=true cargo check -p api --bin api --features blob-s3 --timings
```

Cargo timing reports land under:

```text
target/cargo-timings/
```

Compare warm rebuilds separately from cold builds. A project can have acceptable cold builds but terrible edit/test loops, or the reverse.

## Slice Selection

Prefer slices with all of these properties:

- Duplicated across routes, services, domains, or crates.
- Behavior is boring enough to preserve exactly.
- Ownership belongs in an existing support crate or a clearly named new crate.
- Old local code can be deleted rather than wrapped.
- Validation is direct and repeatable.

Good candidates:

- Route-local validation helpers.
- Repeated response builders.
- Repeated projection/query error mappers.
- Shared DTO/view/model surfaces trapped in a giant binary or application crate.
- Domain/rule/contract code mixed into route handlers.
- Vertical route neighborhoods after support/domain code has already been extracted.

Avoid:

- Sweeping rewrites that cannot be attributed to one timing delta.
- Compatibility shims around moved helpers.
- Moving dead code into new crates.
- Docs-only declarations of future splits.
- Feature-gate contortions unless measurement shows they help.

## Crate Splitting Heuristics

Treat crate splitting as instrumentation as much as architecture cleanup. A giant crate hides the real cost center behind one large Cargo timing bar. Smaller crates make Cargo reuse stable units and make future timing reports more legible.

Extract in this order when possible:

1. Generic support/helpers used by many modules.
2. DTO/view/model types with little runtime behavior.
3. Domain/rule/contract logic.
4. One vertical route/application slice.

Prefer support crates before route crates. A route crate extraction is easier and safer after helpers, view types, and domain contracts stop living inside the monolith.

## Macro And Codegen Checks

If `cargo --timings` only says one local crate is expensive, use deeper tools before guessing:

```sh
cargo +nightly rustc -p <package> -- -Z self-profile
summarize <profile-file>
flamegraph <profile-file>
cargo llvm-lines -p <package>
```

Investigate:

- SQLx, Diesel, serde, router, or other heavy macro expansion.
- Route combinators or builder APIs producing huge generic types.
- A small number of symbols dominating LLVM IR.
- Repeated monomorphization caused by generic helpers that could be boxed, erased, or moved.

For SQLx-heavy dev builds, consider a measured profile override:

```toml
[profile.dev.package.sqlx-macros]
opt-level = 3
```

Only keep profile changes when they improve the representative command.

## Validation And Reporting

For every slice, report:

```text
Slice:
Changed:
Validation:
Timing before:
Timing after:
Timing report:
Deleted old code:
Remaining bottleneck:
Next slice:
```

Validation should usually include:

```sh
cargo fmt -p <changed-crate> -p <main-crate>
cargo test -p <changed-helper-crate>
cargo check -p <main-crate> --features <features>
cargo check -p <main-crate> --features <features> --timings
git diff --check
```

Adjust commands to the repository's own conventions. If the repo forbids direct `cargo test` or requires `just`, follow the repo instructions.

## Completion Standard

A slice is complete when:

- Behavior is preserved.
- Old local duplicates are removed.
- The narrow validation command passes or the blocker is clearly isolated.
- Timing was captured or a specific reason explains why not.
- The next slice is identified if the broader `/goal` remains open.

The campaign is complete when timing returns diminish, the original painful edit loop is acceptable, or the remaining bottleneck is outside the local code structure being optimized.
