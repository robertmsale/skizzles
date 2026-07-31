# Orchestration Learning Loop

The loop observes completed orchestration; it does not rewrite policy. Children report bounded events to the root, and the root emits a campaign-close packet. Promotion into skills, roles, routing, hooks, configuration, or installs is a separate owner-reviewed decision.

## Campaign-close packet

Once a substantial orchestrated campaign reaches any terminal disposition, root finalizes one compact packet, even when every KPI is zero or `not observed`. Perform aggregate validation and an explicit decision when possible, then record the terminal disposition as `accepted`, `rejected`, `blocked`, or `abandoned` before closeout:

```text
/tmp/skizzles-orchestration/<campaign-id>/learning/campaign-close.md
```

The root creates the directory with local-user permissions. This `campaign-close.md` path is a bounded latest snapshot for local coordination, not an immutable consumer record. When a packet is forwarded, copy it to a new, never-reused revision path such as:

```text
/tmp/skizzles-orchestration/<campaign-id>/learning/forwarded/campaign-close.<campaign-id>.r<revision>.<identity>.md
```

The forwarded artifact is immutable: do not edit, replace, or silently reuse a revision filename. Its metadata must include `campaign_id`, integer `revision`, `close_state`, `supersedes` (the exact prior forwarded artifact or `null`), `correction_summary` (`none` for an uncorrected close), and `integrity_sha256` or another independently verifiable identity. Compute the hash over canonical UTF-8 packet bytes with the integrity field omitted or blanked, and include the resulting identity in the filename or metadata so a consumer can verify it without trusting the sender.

A **true terminal close** (`close_state: terminal_close`) means aggregate validation and the root decision are complete with no pending repair or evidence decision; forward that revision and do not mutate it. If later evidence requires work, explicitly reopen the campaign, preserve every prior forwarded revision, update only the latest snapshot, and write the next revision with `close_state: reopened_correction`, `supersedes` pointing to the corrected artifact, and a concise correction summary. After the correction is validated, issue another `terminal_close` revision when the campaign is final again. A reopened correction must never silently overwrite or masquerade as the earlier terminal close.

Enforce a safe total cap of **24 KiB** (below context-item limits), with at most **32** per-slice/KPI detail rows, **32** evidence references, **8** repository-friction items, **8** harness candidates, and **32** review findings. Cap each row/reference at **512 bytes**; truncate detail and retain an `overflow_counts` summary (omitted rows, refs, friction, candidates, findings, and bytes) rather than exceeding a cap. Include no secrets, private ambient data, raw transcripts, or unbounded logs. Reference relevant child reports and evidence paths instead of copying them.

The packet contains:

- campaign objective, dates/duration, owner, slice/owner count, and terminal disposition (`accepted`, `rejected`, `blocked`, or `abandoned`);
- initial accepted Triage report and revision, review cycles, fresh Labs/environments, cold-build or lock waits, flaky commands, ownership collisions, and serial-validation deferrals;
- the KPI table below with counts, denominators, per-slice/owner context, and `0` or `not observed` when appropriate; include `overflow_counts` when a bound truncates detail;
- review-finding classification and outcomes;
- Reviewer independence status per review cycle: `independent` or `reduced-independence-advisory` (the latter is required when that Reviewer supplied midstream Triage adjudication);
- a separate **repository friction** report for reproducible product/process obstacles (command or surface, evidence, affected owner, and suggested repository owner);
- a **harness candidate** section for generalizable orchestration observations, evidence paths, confidence, and the smallest change worth deliberating. When observed, record `incorrect_terminal_block` for a root that treated failed local build/test/Lab/QA proof as terminal despite a plausible in-scope repair path, and `in_scope_runtime_failure_continued` when the failed proof stayed active, was repaired by the owning Worker/Triage loop, and fresh proof resumed;
- forwarding status: optional configured learning consumer plus the immutable artifact path, revision, and integrity identity, or `not configured`/`ambiguous`.

Do not infer a missing event from silence. Counts are observations, not performance conclusions; retain denominators and context so complex repository work is not compared with trivial slices.

## KPI schema

| Field | Count only | Required context |
| --- | --- | --- |
| `worker_shots` | implementation revisions submitted by a Worker for acceptance/review, not edits, builds, or test reruns | Per slice/Worker: `shots_submitted`, terminal outcome `accepted`/`rejected`/`abandoned`, `accepted_shot_number` (integer or `null`), first-pass acceptance, total slices |
| `worker_to_triage_consultations` | bounded clarification requests to the named Triage peer | resolved/unresolved, and whether the report revision changed |
| `attributable_reviewer_product_blockers` | Reviewer findings classified as Worker-introduced explicit-contract or correctness defects | severity, slice, review cycle; exclude adjacent healing, contract discovery, and evidence-only gaps |
| `triage_to_review_adjudications` | root-authorized guarded Triage requests dispatched to Review, including unanswered requests | decision category, why two passes were insufficient, outcome `answered`/`unanswered`/`rejected`, and whether dispatch was authorized; rejected preauthorization attempts are context only; flag as a red-flag escalation |

Review findings use one of: **attributable Worker defect**, **adjacent pre-existing healing**, **contract discovery/RCA correction**, or **insufficient evidence**. Only the first category increments `attributable_reviewer_product_blockers`.

## Candidate lifecycle

Record a harness candidate only when observed in real execution, generalizable beyond one unusual incident, material to cost/correctness/latency/safety/reliability, and supported by a task path, measurement, reproducible behavior, or authoritative source. Never copy campaign-derived observations into this public skill repository, its resources, or its generated plugin. Children never edit global policy.

Only after an explicit owner decision, a human may manually curate a private host-local record at `CODEX_HOME/.skizzles/learning/learning-log.md`. Keep its directory owner-only (`0700`) and the file owner-readable only (`0600`). It is user-owned local state, not an installer receipt, source input, or plugin asset. Keep project, client, workspace, task-path, transcript, credential, and raw-evidence details there; a public proposal must be independently rewritten as a de-identified, generalizable policy change and separately reviewed.

Forwarding is optional and explicit. A configured consumer receives the bounded packet or its path; absent or ambiguous routing means report it to the human owner. Never clone a repository, create/message tasks, edit `AGENTS.md`, or mutate hooks/configuration to establish a consumer.

Promotion requires explicit owner review plus either a reproducible authoritative explanation or corroboration from independent campaigns. Mark promoted or rejected candidates so old evidence is not rediscovered. Automate observation and reporting only; never auto-promote or auto-mutate harness policy.
