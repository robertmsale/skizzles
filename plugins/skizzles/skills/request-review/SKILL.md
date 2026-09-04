---
name: request-review
description: Request an independent native Codex review of a committed candidate, from Codex or Grok, using operator-controlled model and reasoning settings.
---

# Request review

Before accepting coherent source-changing work, request a review when the task or repository calls for independent review. Skip answers, monitoring, and unchanged candidates. The integration owner requests review after workers finish; subordinate workers report readiness to their owner instead of initiating overlapping reviews.

Run the shared Bun script by its absolute installed path:

```sh
bun /absolute/path/to/request-review/scripts/request-review.ts run --cwd /workspace --base master
bun /absolute/path/to/request-review/scripts/request-review.ts run --cwd /workspace --commit HEAD
bun /absolute/path/to/request-review/scripts/request-review.ts result REVIEW_ID
```

Choose exactly one target. `--base` reviews the branch's aggregate changes from its merge base; `--commit` reviews the current HEAD commit only. The workspace must be clean, including untracked files. The runner resolves refs to full SHAs, records the candidate, and rechecks it after review. Do not stage or commit someone else's changes just to satisfy this condition. Workers without Git ownership hand off to the root. No new worktree is created. Keep the candidate stable until the review finishes.

The runner uses `codex exec review` and its native prompt. Do not add custom review prose, implementor conclusions, build/test claims, conversation history, or previous reviewer opinions. It launches a fresh ephemeral process with read-only sandboxing and without user config or automatic project/skill instructions. Normal Codex authentication is reused. This is not an enforceable prohibition on running tests: native review tools can execute read-only commands. Do not request extra build/test execution.

The operator config is `~/.config/skizzles/request-review/config.toml`. Only the user may authorize changes to this file, the reviewer model/reasoning, executable, or limits. Never change settings, substitute a config, or bypass the runner to obtain a preferred verdict. Installation copies `config.example.toml` only if the operator config is absent; subsequent updates preserve it. Model/reasoning CLI overrides and custom prompts are intentionally unavailable. Requires Bun, Git, and an authenticated Codex CLI supporting `exec review` and `--ignore-user-config`.

The command runs until completion. Use the shell tool's normal process/session waiting; do not read execution logs while waiting. Only compact metadata and the final report enter the caller's context. State and raw logs remain under `~/.local/state/skizzles/request-review`. `result` retrieves a saved report without another model call. Completed identical candidates reuse the saved report. `--rerun` explicitly requests another attempt after diagnosing a failure or when the user asks; never retry blindly. A per-workspace gate prevents overlapping requests. After a crashed runner, a recorded live reviewer blocks another launch; inspect the recorded PID before recovery.

A `completed` review means a report was produced, not that the code passed. Read findings, inspect their evidence, address actionable issues, and report unresolved disagreements. A stale, failed, or timed-out review is not acceptance. Request a new review after relevant fixes change the candidate. Limit automatic repair/review to three rounds for the current work episode; after that, report remaining findings to the user. Stop events, report delivery, and unchanged candidates do not start new episodes. Reviewer processes must never invoke this skill recursively.

This runner does not post PR comments or message T3. The invoking owner receives the report and retains decisions, integration, publication, and user communication. The same skill and script can be copied to Codex or Grok; both read the same operator configuration.
