# Board interaction research

This board is intentionally an aggregator console, not a general chat template. Research was done
before implementation against the local T3 Code checkout and the current public repositories for
[assistant-ui](https://github.com/assistant-ui/assistant-ui),
[Vercel Chatbot](https://github.com/vercel/chatbot),
[Open WebUI](https://github.com/open-webui/open-webui), and
[LibreChat](https://github.com/danny-avila/LibreChat).

## Borrowed

- **T3 Code:** keep project/thread navigation in one bounded rail; order threads by recent activity;
  make pending approval and running state visible before selection; keep the composer attached to the
  transcript; and stop live-edge following as soon as the reader navigates history. Its timeline's
  explicit `liveFollowEnabled`/`isAtEnd` split was the most important behavior reference.
- **assistant-ui:** treat messages, tools, and approvals as different timeline primitives instead of
  flattening everything into chat bubbles. Streaming text belongs to the same stable item identity.
- **Vercel Chatbot:** use a restrained reading column, markdown/code treatment, a durable composer,
  and an explicit jump-to-latest affordance rather than forcing scroll on every update.
- **Open WebUI and LibreChat:** make large history manageable with search, state filters, compact
  recency metadata, and a collapsed-by-default operational trace. Approvals remain actionable both
  in context and from a global inbox.

## Rejected

- No T3 worktrees, reviews, merge controls, campaign state, terminal/file panes, or repository source
  was copied. T3 Code is only a feel and interaction reference.
- No model/provider marketplace, personas, knowledge base, sharing, analytics, or generic dashboard
  from the public chat products. The aggregator owns projects, one shared host backend, disposable
  container machines, live threads, snapshots, approvals, and an in-memory event journal.
- No optimistic fiction after restart. A stale container thread remains snapshot-only. Persisted
  host threads retain their host binding, but the board does not silently resume them. Archive copy
  distinguishes destructive container release from a host thread that leaves the shared server up.
- No new streaming protocol. Cursor polling remains the source of incremental activity; HTTP 410
  causes a full reconciliation from REST resources and pending requests.
