# Contributing

Contributions to Skizzles must stay focused on the project and be easy to review.

Contributions made with or without AI tools are welcome. Review is based on
relevance, engineering quality, rights, security, tests, and human judgment.
Writing style and automated detectors are not evidence that a tool was or was
not used.

## Skizzles change policy

- Base the change on the current upstream `main` branch.
- Read [the design intent](docs/design-intent.md),
  [the security model](docs/security-model.md), and the documentation owned by
  the component you are changing.
- Treat unfamiliar code as an implementation to understand, not as evidence
  that the repository needs a broad rewrite.
- Keep each change independently reviewable. Do not mix unrelated packages,
  skills, hooks, runtime policy, installation behavior, model routing, or
  hosted policy unless the causal dependency is explicit.
- Preserve user-facing commands, configuration keys, state paths, resource
  labels, installation wiring, model-role assignments, cleanup behavior, and
  other public contracts unless the proposal includes an explicit migration and
  rollback boundary.
- Edit canonical sources, then run their generators. Do not repair generated
  roles, plugin files, or bundled Container Lab entrypoints in place.
- The standard generated-file cleanup requirement below means removing
  unrelated generated artifacts. Include checked-in projections owned by the
  canonical inputs you changed after rebuilding them.

Reproduce the current failure or undesirable behavior before changing it. Add
or port a focused causal test first when practical. Measure the baseline when a
proposal changes performance, storage, concurrency, or operational cost.
Security and reliability hardening must respect the documented threat model and
authority boundary.

Skizzles is local-first. Do not add, enable, or require GitHub Actions or
another hosted CI system unless a maintainer explicitly requests that hosted
change.

## Local validation

Run the narrowest check that proves the changed behavior. For changes that
cross package or plugin boundaries, run the complete package boundary with:

```sh
just package
```

`just package` runs `bun run typecheck`, `bun test`, `bun run plugin:check`,
`bun run plugin:build`, and `bun run plugin:check` in that exact order.

Report every check you ran and its exact result. Report failed, skipped,
blocked, flaky, and environment-failed checks rather than omitting them.

## Review description

Explain:

- the observed problem or requested outcome;
- the confirmed cause and why the scope is necessary;
- the behavior and public contracts that remain unchanged;
- any migration or operational impact;
- the tests and commands run; and
- which generated artifacts were rebuilt.

Keep commits and pull requests focused enough for a reviewer to follow the
cause, implementation, and proof without reviewing an unrelated repository-wide
rewrite.

## Contribution requirements

- Search existing issues and pull requests before starting duplicate work.
- Discuss large, security-sensitive, or breaking changes with maintainers first.
- Keep each pull request focused on one clear change.
- Explain the problem, the approach, and any user-visible effect.
- Add or update tests when behavior changes.
- Run the relevant checks and report the actual results.
- Remove unrelated, generated, or temporary files.
- Respond to review with technical facts and revised code when needed.

The person submitting a change is responsible for the full change. They must
understand it, review it, and be able to explain it.

They must have the right to submit every part of the change, including code,
text, data, and images.

Do not include secrets, private data, copied material without permission, or
false test and review claims.

Report security problems through the repository's private security process when
one exists.

## Tool-assisted contributions

Tool use is allowed when the contribution meets the same quality, review,
license, security, and project-scope rules as other work.

Disclose meaningful coding-assistant or generated-content help in the pull
request. Credit substantial model contributions with a normal Git co-author
trailer in the relevant commits:

```text
Co-authored-by: Tool Model <attribution@example.com>
```

Use the real tool and model names when known and the attribution address
required by the contributing environment. Do not put private prompts, secrets,
or personal data in the trailer.

Add one trailer for each assistant when needed.

The human contributor must review the complete change, run the checks, and take
responsibility for it.

Maintainers may close unreviewed bulk output, unrelated changes, false results,
or work that the contributor cannot explain.

Only a human contributor may add `Signed-off-by`. They may add it only when
this repository uses the unchanged Developer Certificate of Origin and they can
make that statement.

## Languages

Official language: English. Reviewed translations: none. Use this English file
if a translation differs.
