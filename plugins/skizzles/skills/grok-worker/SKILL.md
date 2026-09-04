---
name: grok-worker
description: Dispatch a trusted Grok Build implementer beneath a Codex-owned task, in the same workspace, with durable sessions and compact completion reporting.
---

# Grok worker

Run the bundled script with Bun using its literal absolute path:

```sh
bun /absolute/path/to/grok-worker/scripts/grok-worker.ts --help
```

Copy this entire skill directory to use it independently. Requires macOS or Linux, Bun, and an authenticated `grok` executable. `GROK_WORKER_BINARY` selects another executable; it must be the Grok CLI, not the T3 root-profile launcher. No T3 task, worktree, MCP registration, or installer is required.

## Dispatch

Use Grok for a bounded implementation with clear acceptance criteria. The parent owns decisions, user communication, Git staging/commits, integration, and review. Grok runs in the exact existing workspace passed with `--cwd`, with `bypassPermissions` and no nested agents. Use only within the operator-authorized trusted-execution scope.

Write a compact assignment to a file outside the repository: objective, owned paths, relevant context, existing/concurrent work, constraints, and validation. Do not forward the entire parent conversation. Serialize overlapping writers. File ownership is an instruction contract, not a filesystem sandbox.

```sh
bun /absolute/path/to/grok-worker/scripts/grok-worker.ts spawn --cwd /workspace --prompt-file /tmp/assignment.txt --model grok-4.6 --effort high
bun /absolute/path/to/grok-worker/scripts/grok-worker.ts wait JOB_ID --timeout-ms 58000
bun /absolute/path/to/grok-worker/scripts/grok-worker.ts result JOB_ID
bun /absolute/path/to/grok-worker/scripts/grok-worker.ts followup JOB_ID --prompt-file /tmp/followup.txt
```

The job supervisor survives the launching command. Followups preserve executable, workspace, session ID, model, reasoning, permissions, and limits. Only one turn runs per job. Default execution limits are 64 turns and 30 minutes; select appropriate `--max-turns` and `--timeout-ms` at spawn.

## Observe and accept

`status` and `wait` return compact state only. Wait wakes on terminal state, never progress chatter; pass `--after CURSOR` to suppress a previously delivered terminal state. Retrieve `result` once per turn. Reports use Grok's structured final output and are capped at 12,000 characters; the concatenated `text` field is never returned because it includes progress narration. Raw stdout (including reasoning) and stderr remain in private local artifacts; `inspect` returns a bounded tail only when diagnosis requires it. Local event collection does not feed the parent model.

Read the actual diff and evaluate validation before accepting. A completed process is an implementation report, not proof of correctness. A non-end-turn stop or invalid/missing structured report is a failed job; inspect and decide whether to resume. A model-reported blocker returns `blocked`, which can be resumed with the missing context.

`cancel JOB_ID` requests process-group termination. Wait for terminal state before touching owned files or resuming. Cancellation and timeout preserve edits; never automatically roll them back. State lives outside the repo under `~/.local/state/skizzles/grok-worker` (override with `GROK_WORKER_STATE_DIR`). An `orphaned` state means the supervisor is unavailable and the worker may still be running. Followup is blocked: inspect the recorded PIDs and local artifacts before manual recovery; do not start another overlapping writer. Keep artifacts while work is active or needed for diagnosis.
