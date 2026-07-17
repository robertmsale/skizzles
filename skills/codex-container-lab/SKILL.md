---
name: codex-container-lab
description: Use Skizzles' bundled Container Lab launcher to create, run attached commands in, inspect, synchronize, and destroy disposable Docker Compose labs with isolated Git workspaces. Use when Docker/Compose isolation, reproducible experiments, or guarded file synchronization would help.
---

# Codex Container Lab

Skizzles includes the complete Container Lab source project and runnable operational/reaper tooling. A stable plugin carries dependency-self-contained Bun bundles; a source checkout runs the canonical workspace package. Use the launcher bundled beside this skill as the guaranteed invocation surface, even before any `PATH` wiring exists. A skill-only install falls back to an existing distinct `codex-container-lab` PATH binary, or explains that the full plugin/source runtime is needed.

Resolve the skill directory, then send the literal launcher path as the outer Bash command. Do not put it in a shell variable: the managed-output hook deliberately does not expand variables. Replace `/absolute/path/to` with the resolved, unquoted path from the source checkout or installed plugin:

```sh
/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab --help
/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab health
```

The `codex-container-lab` PATH command is an optional host-installed convenience. Host PATH and LaunchAgent activation remain explicit, reversible, machine-local wiring; see the canonical [installation and optional host-wiring guide](../../packages/codex-container-lab/docs/installation.md) from a Skizzles checkout or plugin snapshot.

Use this skill when work benefits from an isolated Linux workspace or disposable project stack. It augments counterfactual engineering: use one lab per serious hypothesis, validate each against the same criteria, and synchronize only the selected result.

## Safe workflow

1. Confirm the consuming repository commits `.codex-container-lab.yaml` in the intended checkout or Desktop worktree. Run `/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab health` to verify Docker and owner state. The CLI uses the current `CODEX_THREAD_ID` automatically.
2. Run `/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab lab create --name NAME`. Provisioning stays attached and returns a compact `{labId,state}` result after durable state reaches `ready` or `failed`.
3. Read `findings` before running code. They report trusted-project privilege surfaces such as host binds, sockets, devices, capabilities, host namespaces, secrets, configs, and exposed ports. They are review guidance, not policy rejections.
4. Run work with `/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab --owner THREAD_ID --state-root /tmp/ccl-state --runtime-root /tmp/ccl-runtime run --lab ID [--cwd PATH] [--env KEY=VALUE] [--timeout-seconds N] -- COMMAND...`. Arguments after `--` are an argv, not a shell-encoded command. The CLI remains attached while output streams; Codex unified execution owns backgrounding, polling, stdin, signals, and the final exit status. Put intentional persistent services in Compose.
5. Read bounded service output with `/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab logs --lab ID --service SERVICE`. Use only service names declared by the consuming project.
6. Finish or cancel the attached run before synchronizing. Run `/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab sync preview --lab ID --direction pull` to bring a result to the host, or use `push` to refresh the lab.
7. Resolve every reported conflict and preview again. Apply exactly the returned token with `/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab sync apply --lab ID --direction DIRECTION --token TOKEN`; tokens expire, are single-use, and fail if either side changed.
8. Validate synchronized host changes normally, then run `/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab lab destroy --lab ID`. Use `lab destroy-all` to remove every lab owned by the current thread.

For intentional manual use outside Codex, place `--owner THREAD_ID` before the command. Never borrow another task's id or invent a shared owner.

## Output interpretation

- Administrative commands print one compact JSON value. `run` instead streams the child stdout/stderr and exits with its outcome. Usage errors exit 2; operational failures or uncertainty exit 1 with a compact diagnostic on stderr.
- `lab create` is synchronous. A catchable interruption records `failed`; an abrupt uncatchable host termination may leave `provisioning`. Both states remain explicitly destroyable, so destroy and recreate rather than treating a stale nonterminal state as ready.
- `failed` includes a compact actionable error. Inspect findings and bounded service logs, then explicitly destroy the failed lab.
- Endpoints are named by the manifest and published on random loopback ports. Never guess ports from source Compose files.
- `logs` returns a bounded service tail with explicit byte, line, and truncation metadata. Use repeated targeted service-log calls for inspection; no internal runtime path is exposed.
- `health`, create, list, status, destroy, logs, and synchronization use Skizzles' compact public JSON contract. Administrative JSON never exceeds 16 KiB; service transcript text is capped at 8 KiB and the requested line bound. Long attached-run output remains available through the normal command-output supervisor artifact.
- A sync conflict means both source and target diverged from the last successful baseline. A conflicted, expired, mismatched, already-used, or stale token performs no writes.
- A preview with more than 100 entries issues no token; reduce the change set so every applied path is visible.
- Git-tracked and non-ignored untracked files participate in sync. Ignored credentials, caches, build outputs, and Git metadata do not.

## Compatibility and safety

The command service must be a normal distro-based container with the configured absolute shell, `setsid`, a writable workspace, and a long-running process. Image and Dockerfile shorthand receive a generated long-running command. Distroless images are unsupported.

If the consuming manifest uses `secret_environment`, treat it as an explicit allowlist for project-owned Compose secret sources backed by the invoking CLI environment. Keep `environment` and `secret_environment` disjoint; provide only names in the manifest, never copy secret values into commands or files, and rely on the CLI's fixed redaction when Compose reports an error.

Docker runs only on the host. Generated configuration never adds a Docker socket, host credential, privileged mode, device, capability, secret, or arbitrary host mount. A trusted project's intentional Compose configuration is preserved and reported. Forwarded environment variables must be explicitly named in the manifest; pass run-specific values only through `run --env KEY=VALUE`.

The current thread owns its stack across CLI invocations, process exits, and stopped-but-unarchived task state. Explicit destroy is the normal lifecycle. A fail-closed periodic reaper removes only exact-labeled owners whose own Codex database row is consistently archived; missing, active, inconsistent, or unreadable state is retained.

An owner is bounded to eight labs. Run arguments and environment payloads are capped. Synchronization accepts at most 20,000 eligible paths, 64 MiB per file, and 512 MiB total.

## Counterfactual patch composition

For counterfactual experiments, use one lab per hypothesis and start from the same clean committed checkpoint. Before running parallel hypotheses, inspect findings for project-declared host binds, sockets, fixed services, or other shared mutable state that could contaminate experiments despite separate Compose identities. Let the root own integration. Use normal synchronization for an exact transactional transfer, especially when the initial host workspace was dirty or the result includes many file types. Use Git patches when independently developed hunks should compose or the result must cross a machine boundary.

Generate patches as files under `/tmp`; do not print or copy patch bodies through model context. Include full blob identities and binary changes:

```bash
shared_base=$(git rev-parse HEAD)
patch=$(mktemp /tmp/codex-container-lab.patch.XXXXXX)

/absolute/path/to/skills/codex-container-lab/scripts/codex-container-lab run --lab "$lab" -- \
  git diff --binary --full-index "$shared_base" -- path/to/file > "$patch"

git apply --check --3way "$patch"
git apply --3way "$patch"
```

Record `shared_base` once before experiments diverge. Begin host integration from that clean committed checkpoint, and do not reset or stash unrelated staged work merely to make application succeed. The normal command-output hook preserves explicit redirection: Git writes the patch to stdout while diagnostics remain on stderr. A patch saved in `/tmp` remains reviewable and retryable if checking or application fails. Git can relocate context-shifted hunks during normal application and use three-way application when the destination has the shared base objects. If the artifact contains unexpected non-patch stdout, do not apply it.

Plain `git diff` omits untracked files. Before export, use `git add -N -- path/to/file` inside the lab or create a lab-local commit and diff it against the shared base. Keep this index mutation inside the disposable lab.

For multiple selected hypotheses, give every patch a unique path, inspect it, and have the root apply patches serially. Validate after each patch and again after composition. Do not use `--unsafe-paths`, `--reject`, or automatic `--ours`, `--theirs`, or `--union` conflict resolution as routine shortcuts. Preserve genuine conflicts for deliberate integration.

Patch composition complements rather than replaces synchronization. Synchronization provides baseline-bound preview tokens, stale checks, exact-file transfer, journaling, and rollback. Git patches provide context-aware hunk composition and portable artifacts, but are most reliable when every experiment shares a committed base.
