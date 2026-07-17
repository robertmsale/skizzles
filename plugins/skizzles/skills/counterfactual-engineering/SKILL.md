---
name: counterfactual-engineering
description: Apply a coding version of the scientific method when first-answer bias could produce a superficial or inferior result. Use for competing architectures, major refactors, performance work, UI/product alternatives, migrations, risky changes, and bug diagnosis or repair when the cause or durable fix is uncertain, multiple causal paths fit the evidence, recurrence or systemic risk matters, or an earlier fix failed review. Skip only when reproduction and evidence isolate one straightforward mechanical correction.
---

# Counterfactual Engineering

Compare materially different causal models or implementation approaches before committing to one. Favor evidence over first-answer momentum.

## Workflow

1. **Observe:** Reproduce the current behavior and capture a stable failure or success oracle.
2. **Question:** Define success criteria, constraints, shared validation, and what is out of scope.
3. **Research:** Inspect local patterns, prior art, dependency capabilities, and existing abstractions.
4. **Hypothesize:** State 2-3 genuinely different causal models or implementation routes. For bugs, record the evidence and falsification test for each cause rather than jumping directly to fixes.
5. **Isolate:** Choose one isolated workspace per serious hypothesis using the backend guidance below. Start every experiment from the same committed checkpoint when results may be composed.
6. **Experiment:** Give each hypothesis a complete reproduce-investigate-implement-validate loop. Keep experiments independent so one path does not anchor another.
7. **Test:** Apply the same tests, checks, screenshots, benchmarks, or reproduction oracle to every hypothesis.
8. **Select or synthesize:** Accept the strongest validated outcome, combine independently justified complementary results, or reject all. Apply selected changes sequentially and validate both each addition and the aggregate.
9. **Report or commit:** Produce a clean final result and summarize the evidence, rejected paths, and remaining risks.

## Isolation backends

Choose one backend per hypothesis unless a concrete constraint requires both:

- **Git worktree:** Use for host-native or repository-only work where Docker is irrelevant. Create `{REPO_ROOT}/.worktrees/<short-hypothesis-slug>` and name its branch from the hypothesis, such as `codex/cache-boundary`.
- **Container lab:** Use when the repository has a reviewed `.codex-container-lab.yaml` and Linux, Docker, Compose services, databases, or environmental isolation materially improve the experiment. Follow the `codex-container-lab` skill, create one lab per hypothesis, and use its synchronization or Git patch workflow to lift out selected results. A lab's isolated Git workspace replaces routine worktree management for that hypothesis.

Keep each experiment small enough to validate. Avoid leaving rejected worktrees or labs behind unless the user or local instructions require preservation.

Verify that isolation includes mutable dependencies, not only source files. Shared databases, caches, queues, host-bound volumes, fixed services, or reused credentials can contaminate hypotheses and invalidate comparisons.

## Bug investigations

Make triage produce a compact hypothesis set instead of only the most plausible explanation. Each serious hypothesis should include:

- the proposed causal mechanism;
- evidence it explains;
- evidence that would falsify it;
- the smallest experiment that distinguishes it;
- the regression oracle a durable fix must satisfy.

Use independent workers when parallelism materially helps; otherwise one worker may explore multiple isolated workspaces. Give each worker complete ownership of its hypothesis loop. Let the root own selection and integration, then use QA and adversarial review on the integrated result instead of relying on repeated worker-review repair loops to discover alternate causes.

If review exposes a materially different causal model, reopen hypothesis exploration rather than repeatedly patching the same approach.

## Synthesis standard

Accept a hypothesis only when it satisfies the shared criteria better than the alternatives. Prefer outcomes that are correct, validated, maintainable, convention-aligned, reversible, and clean in Git history.

Combine results only when each change has independent evidence or prevents a distinct demonstrated failure. Verify that one fix is not merely hiding the absence of another. After sequential integration, rerun the original reproduction and the complete shared validation because complementary patches can interact.

Do not multiply experiments for an obvious localized defect with a deterministic reproduction and one evidence-backed correction. Report instead of integrating when the evidence reveals a product, architecture, or risk tradeoff requiring user judgment.

## Report format

```text
| Hypothesis | Approach | Validation | Result | Reason |
| --- | --- | --- | --- | --- |
| ... | ... | ... | Accepted/Rejected | ... |
```

Finish with:

```text
Selected:
Committed:
Rejected experiments:
Remaining risks:
```

If no hypothesis is accepted, report what failed and the next question that would unblock a better experiment.
