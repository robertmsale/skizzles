import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ApiError, boardApi, eventCursorRecovery } from "./api.ts";
import {
  approvalResult,
  classifyThread,
  eventDelta,
  eventThreadId,
  relativeTime,
  requestDetail,
  requestLabel,
  requestThreadId,
  threadIsRunning,
  threadTitle,
  timelineEntries,
} from "./model.ts";
import type { MachineDto, ProjectDto, ServerRequestDto, ThreadDto, ThreadView } from "./types.ts";

type ThreadFilter = "current" | "snapshot" | "archived";

export function App() {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectCwd, setProjectCwd] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadDto | null>(null);
  const [machines, setMachines] = useState<MachineDto[]>([]);
  const [requests, setRequests] = useState<ServerRequestDto[]>([]);
  const [filter, setFilter] = useState<ThreadFilter>("current");
  const [search, setSearch] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [deltas, setDeltas] = useState<Map<string, string>>(new Map());
  const selected = threads.find((candidate) => candidate.id === selectedId) ?? null;
  const selectedRef = useRef<ThreadView | null>(null);
  const eventCursorRef = useRef(0);
  const eventStreamRef = useRef<string | null>(null);

  const refreshProjects = useCallback(async () => {
    const response = await boardApi.projects();
    setProjects(response.data);
    setProjectCwd((current) => current && response.data.some((project) => project.cwd === current)
      ? current
      : response.data[0]?.cwd ?? null);
    return response.data;
  }, []);

  const refreshBoard = useCallback(async (cwd = projectCwd, knownProjects?: ProjectDto[]) => {
    const projectData = knownProjects ?? (projects.length ? projects : await refreshProjects());
    if (projectData.length === 0) {
      setThreads([]);
      setMachines([]);
      setRequests([]);
      setLoading(false);
      return;
    }
    const [active, archived, loaded, machineData, approvals] = await Promise.all([
      boardApi.threads(cwd, false, searchTerm || undefined),
      boardApi.threads(cwd, true, searchTerm || undefined),
      boardApi.loaded(),
      boardApi.machines(),
      boardApi.approvals(),
    ]);
    const loadedIds = new Set(loaded.data);
    const next = [
      ...active.data.map((item) => classifyThread(item, loadedIds, false)),
      ...archived.data.map((item) => classifyThread(item, loadedIds, true)),
    ].sort((a, b) => (b.recencyAt ?? b.updatedAt ?? 0) - (a.recencyAt ?? a.updatedAt ?? 0));
    setThreads(next);
    setMachines(machineData.data);
    setRequests(approvals.data);
    setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id ?? null);
    setLoading(false);
  }, [projectCwd, projects, refreshProjects, searchTerm]);

  const readThread = useCallback(async (view: ThreadView | null) => {
    if (!view) {
      setThread(null);
      return;
    }
    try {
      const response = await boardApi.readThread(view.id, view.lifecycle === "live");
      setThread(response.thread);
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, []);

  useEffect(() => {
    refreshProjects().then(() => setLoading(false)).catch((cause) => {
      setError(message(cause));
      setLoading(false);
    });
  }, [refreshProjects]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchTerm(search.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!projects.length) return;
    setLoading(true);
    refreshBoard(projectCwd).catch((cause) => {
      setError(message(cause));
      setLoading(false);
    });
  }, [projectCwd, projects.length, searchTerm]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void readThread(selected); }, [selectedId, selected?.lifecycle, readThread]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const [page, approvals] = await Promise.all([
          boardApi.events(eventCursorRef.current, eventStreamRef.current),
          boardApi.approvals(),
        ]);
        if (stopped) return;
        eventCursorRef.current = page.nextCursor;
        eventStreamRef.current = page.streamId;
        setRequests(approvals.data);
        if (page.data.length) {
          const currentSelection = selectedRef.current;
          const selectedChanged = page.data.some((record) => eventThreadId(record.event) === currentSelection?.id);
          setDeltas((current) => {
            const next = new Map(current);
            for (const record of page.data) {
              const delta = eventDelta(record.event);
              if (delta) next.set(delta.itemId, (next.get(delta.itemId) ?? "") + delta.delta);
            }
            return next;
          });
          await refreshBoard();
          if (selectedChanged) await readThread(currentSelection);
        }
        setError(null);
      } catch (cause) {
        const recovery = cause instanceof ApiError ? eventCursorRecovery(cause) : null;
        if (recovery) {
          eventCursorRef.current = recovery.after;
          eventStreamRef.current = recovery.stream;
          setDeltas(new Map());
          await refreshBoard().catch(() => undefined);
          await readThread(selectedRef.current).catch(() => undefined);
          if (!stopped) setError(null);
        } else if (!stopped) {
          setError(message(cause));
        }
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 900);
      }
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [refreshBoard, readThread]);

  const act = async (operation: () => Promise<unknown>, reconcile = true) => {
    setMutating(true);
    setError(null);
    try {
      await operation();
      if (reconcile) await refreshBoard();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setMutating(false);
    }
  };

  const respond = (request: ServerRequestDto, accepted: boolean) => {
    const result = approvalResult(request, accepted);
    if (!result) {
      setError(`${requestLabel(request)} needs a structured response that this board does not support.`);
      return;
    }
    void act(() => boardApi.respond(request.id, result));
  };

  const visibleThreads = useMemo(() => threads.filter((candidate) => {
    if (filter === "snapshot" && candidate.lifecycle !== "snapshot") return false;
    if (filter === "archived" && candidate.lifecycle !== "archived") return false;
    if (filter === "current" && candidate.lifecycle === "archived") return false;
    if (!search.trim()) return true;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    return `${name}\n${threadTitle(candidate)}`.toLowerCase().includes(search.trim().toLowerCase());
  }), [threads, filter, search]);

  const currentMachine = selected
    ? machines.find((machine) => machine.threadIds.includes(selected.id)) ?? null
    : null;
  const pendingForThread = requests.filter((request) => requestThreadId(request) === selectedId);

  return (
    <div className="app-shell">
      <Sidebar
        projects={projects}
        projectCwd={projectCwd}
        onProject={setProjectCwd}
        threads={visibleThreads}
        selectedId={selectedId}
        onSelect={setSelectedId}
        search={search}
        onSearch={setSearch}
        filter={filter}
        onFilter={setFilter}
        pending={requests}
        onAdd={() => setShowAdd(true)}
        onRemove={(cwd) => void act(async () => {
          await boardApi.removeProject(cwd);
          const projectData = await refreshProjects();
          const nextCwd = projectData[0]?.cwd ?? null;
          setProjectCwd(nextCwd);
          await refreshBoard(nextCwd, projectData);
        }, false)}
        onNew={() => projectCwd && void act(async () => {
          const started = await boardApi.startThread(projectCwd);
          setSelectedId(started.thread.id);
        })}
        disabled={mutating}
      />
      <main className="main-pane">
        <Topbar
          thread={selected}
          machine={currentMachine}
          approvalCount={requests.length}
          onInbox={() => setShowInbox(true)}
          onArchive={() => selected && window.confirm("Archive permanently removes its container and rollout. Continue?") && void act(() => boardApi.archive(selected.id))}
          onDelete={() => selected && window.confirm("Delete this thread permanently?") && void act(() => boardApi.delete(selected.id))}
          disabled={mutating}
        />
        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}
        {loading ? <Empty title="Loading board…" detail="Reading the aggregator state." />
          : !projects.length ? <Empty title="Register a project to begin" detail="Choose a host Git checkout with a container-reachable origin." action={<button className="primary" onClick={() => setShowAdd(true)}>Add project</button>} />
          : !selected ? <Empty title="No threads here" detail="Start a Codex thread in the selected project." action={<button className="primary" onClick={() => projectCwd && void act(async () => { const result = await boardApi.startThread(projectCwd); setSelectedId(result.thread.id); })}>New thread</button>} />
          : <Conversation
              view={selected}
              thread={thread}
              requests={pendingForThread}
              deltas={deltas}
              disabled={mutating}
              onRespond={respond}
              onSend={(text) => void act(async () => { await boardApi.sendTurn(selected.id, text); await readThread(selected); })}
              onInterrupt={() => {
                const turnId = thread?.turns?.at(-1)?.id;
                if (turnId) void act(() => boardApi.interrupt(selected.id, turnId));
              }}
            />}
      </main>
      {showAdd && <AddProject onClose={() => setShowAdd(false)} onSubmit={(cwd) => void act(async () => { const result = await boardApi.addProject(cwd); setProjectCwd(result.project.cwd); setShowAdd(false); await refreshProjects(); })} disabled={mutating} />}
      {showInbox && <Inbox requests={requests} onClose={() => setShowInbox(false)} onSelect={(id) => { if (id) setSelectedId(id); setShowInbox(false); }} onRespond={respond} disabled={mutating} />}
    </div>
  );
}

function Sidebar(props: {
  projects: ProjectDto[]; projectCwd: string | null; onProject: (cwd: string) => void;
  threads: ThreadView[]; selectedId: string | null; onSelect: (id: string) => void;
  search: string; onSearch: (value: string) => void; filter: ThreadFilter; onFilter: (value: ThreadFilter) => void;
  pending: ServerRequestDto[]; onAdd: () => void; onRemove: (cwd: string) => void; onNew: () => void; disabled: boolean;
}) {
  const selectedProject = props.projects.find((project) => project.cwd === props.projectCwd);
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark">C</span><div><strong>Codex Machines</strong><small>Local aggregator</small></div></div>
    <section className="project-block">
      <label htmlFor="project-select">Project</label>
      <div className="project-row">
        <select id="project-select" value={props.projectCwd ?? ""} onChange={(event) => props.onProject(event.target.value)} disabled={!props.projects.length}>
          {props.projects.map((project) => <option key={project.cwd} value={project.cwd}>{basename(project.cwd)}</option>)}
        </select>
        <button className="icon-button" onClick={props.onAdd} aria-label="Add project">＋</button>
        {selectedProject && <button className="icon-button danger-quiet" onClick={() => props.onRemove(selectedProject.cwd)} disabled={props.disabled} aria-label="Remove project">−</button>}
      </div>
      {selectedProject && <span className="project-path" title={selectedProject.cwd}>{selectedProject.cwd}</span>}
    </section>
    <button className="new-thread" onClick={props.onNew} disabled={props.disabled || !props.projectCwd}><span>＋</span> New thread</button>
    <div className="search-wrap"><span>⌕</span><input aria-label="Search threads" placeholder="Search threads" value={props.search} onChange={(event) => props.onSearch(event.target.value)} /></div>
    <div className="filter-tabs" role="tablist">
      {(["current", "snapshot", "archived"] as const).map((value) => <button key={value} className={props.filter === value ? "active" : ""} onClick={() => props.onFilter(value)}>{value === "snapshot" ? "Snapshots" : capitalize(value)}</button>)}
    </div>
    <div className="thread-list">
      {props.threads.map((item) => {
        const count = props.pending.filter((request) => requestThreadId(request) === item.id).length;
        return <button key={item.id} className={`thread-row ${props.selectedId === item.id ? "selected" : ""}`} onClick={() => props.onSelect(item.id)}>
          <span className={`state-dot ${item.lifecycle} ${threadIsRunning(item) ? "working" : ""}`} />
          <span className="thread-copy"><strong>{threadTitle(item)}</strong><small>{item.lifecycle === "snapshot" ? "Snapshot only" : item.lifecycle === "archived" ? "Archived" : threadIsRunning(item) ? "Working" : "Live · idle"}</small></span>
          <span className="thread-meta">{count > 0 ? <b title={`${count} pending request${count === 1 ? "" : "s"}`}>{count}</b> : relativeTime(item.recencyAt ?? item.updatedAt)}</span>
        </button>;
      })}
      {!props.threads.length && <p className="list-empty">No matching threads.</p>}
    </div>
  </aside>;
}

function Topbar(props: { thread: ThreadView | null; machine: MachineDto | null; approvalCount: number; onInbox: () => void; onArchive: () => void; onDelete: () => void; disabled: boolean }) {
  return <header className="topbar">
    <div className="topbar-title">
      <strong>{props.thread ? threadTitle(props.thread) : "Agent board"}</strong>
      {props.thread && <span className={`status-chip ${props.thread.lifecycle}`}>{props.thread.lifecycle === "snapshot" ? "Snapshot only" : capitalize(props.thread.lifecycle)}</span>}
      {props.machine && <span className={`status-chip machine ${props.machine.dockerStatus ?? props.machine.state}`}>{props.machine.dockerStatus ?? props.machine.state}</span>}
    </div>
    <div className="topbar-actions">
      <button className="inbox-button" onClick={props.onInbox}>Requests {props.approvalCount > 0 && <b>{props.approvalCount}</b>}</button>
      {props.thread && <><button onClick={props.onArchive} disabled={props.disabled || props.thread.lifecycle !== "live"}>Archive</button><button className="danger-quiet" onClick={props.onDelete} disabled={props.disabled}>Delete</button></>}
    </div>
  </header>;
}

function Conversation(props: { view: ThreadView; thread: ThreadDto | null; requests: ServerRequestDto[]; deltas: ReadonlyMap<string, string>; disabled: boolean; onRespond: (request: ServerRequestDto, accepted: boolean) => void; onSend: (text: string) => void; onInterrupt: () => void }) {
  const entries = useMemo(() => timelineEntries(props.thread, props.deltas), [props.thread, props.deltas]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [draft, setDraft] = useState("");
  useLayoutEffect(() => {
    if (atBottom) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" });
  }, [entries.length, entries.at(-1)?.text, props.requests.length, atBottom]);
  const send = (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    props.onSend(value);
  };
  const running = props.view.lifecycle === "live" && threadIsRunning(props.thread ?? props.view);
  return <div className="conversation">
    {props.view.lifecycle !== "live" && <div className={`truth-banner ${props.view.lifecycle}`}><strong>{props.view.lifecycle === "snapshot" ? "This thread is not live" : "This thread is archived"}</strong><span>{props.view.lifecycle === "snapshot" ? "The daemon retained its summary after restart, but the original container cannot be reattached. Turn history may be unavailable." : "Its container and rollout were removed. Archive is irreversible."}</span></div>}
    <div className="timeline" ref={scrollRef} onScroll={(event) => { const node = event.currentTarget; setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 88); }}>
      <div className="timeline-inner">
        {!entries.length && <div className="thread-welcome"><span className="brand-mark large">C</span><h1>{props.view.lifecycle === "live" ? "What should Codex do?" : "No retained turn history"}</h1><p>{props.view.lifecycle === "live" ? "Work happens in an isolated container cloned from this project's origin." : "The aggregate snapshot preserves identity and status, not a second copy of the rollout."}</p></div>}
        {entries.map((entry) => entry.role === "tool"
          ? <ToolCard key={entry.key} label={entry.label} text={entry.text} {...(entry.status ? { status: entry.status } : {})} />
          : <article key={entry.key} className={`message ${entry.role}`}><div className="avatar">{entry.role === "user" ? "R" : "C"}</div><div className="message-body"><span className="speaker">{entry.label}</span><Markdown text={entry.text} /></div></article>)}
        {props.requests.map((request) => <ApprovalCard key={String(request.id)} request={request} onRespond={props.onRespond} disabled={props.disabled} />)}
        {running && <div className="working-row"><span className="pulse" /> Codex is working</div>}
      </div>
      {!atBottom && <button className="jump-latest" onClick={() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); setAtBottom(true); }}>↓ Latest</button>}
    </div>
    <form className="composer" onSubmit={send}>
      <div className="composer-box">
        <textarea aria-label="Message Codex" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={props.view.lifecycle === "live" ? "Message Codex…" : "This retained thread is read-only"} disabled={props.disabled || props.view.lifecycle !== "live"} rows={2} />
        <div className="composer-footer"><span>{props.view.lifecycle === "live" ? "Enter to send · Shift+Enter for a new line" : "Snapshot-only and archived threads cannot be resumed"}</span>{running ? <button type="button" className="stop" onClick={props.onInterrupt} disabled={props.disabled}>■ Stop</button> : <button className="send" disabled={props.disabled || props.view.lifecycle !== "live" || !draft.trim()} aria-label="Send message">↑</button>}</div>
      </div>
    </form>
  </div>;
}

function ToolCard({ label, text, status }: { label: string; text: string; status?: string }) {
  return <details className="tool-card"><summary><span className="tool-icon">›_</span><strong>{label}</strong>{status && <span className="tool-status">{status}</span>}<span className="chevron">⌄</span></summary><pre>{text}</pre></details>;
}

function ApprovalCard({ request, onRespond, disabled }: { request: ServerRequestDto; onRespond: (request: ServerRequestDto, accepted: boolean) => void; disabled: boolean }) {
  const actionable = approvalResult(request, true) !== null;
  return <section className={actionable ? "approval-card" : "approval-card structured-request"}><div className="approval-icon">!</div><div><span className="eyebrow">{actionable ? "Approval required" : "Structured response required"}</span><h3>{requestLabel(request)}</h3><pre>{requestDetail(request)}</pre>{actionable
    ? <div className="approval-actions"><button onClick={() => onRespond(request, false)} disabled={disabled}>Deny</button><button className="primary" onClick={() => onRespond(request, true)} disabled={disabled}>Approve once</button></div>
    : <p className="request-note">This request cannot be answered safely by the board yet. It remains pending for a protocol-aware client.</p>}</div></section>;
}

function Markdown({ text }: { text: string }) {
  const blocks = text.split(/```/);
  return <div className="markdown">{blocks.map((block, index) => index % 2
    ? <pre className="code-block" key={index}><code>{block.replace(/^\w+\n/, "")}</code></pre>
    : <Fragment key={index}>{block.split("\n").map((line, lineIndex) => {
        if (!line) return <br key={lineIndex} />;
        if (line.startsWith("### ")) return <h3 key={lineIndex}>{inline(line.slice(4))}</h3>;
        if (line.startsWith("## ")) return <h2 key={lineIndex}>{inline(line.slice(3))}</h2>;
        if (line.startsWith("# ")) return <h1 key={lineIndex}>{inline(line.slice(2))}</h1>;
        if (/^[-*] /.test(line)) return <div className="list-line" key={lineIndex}>• <span>{inline(line.slice(2))}</span></div>;
        return <p key={lineIndex}>{inline(line)}</p>;
      })}</Fragment>)}</div>;
}

function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`)/g).map((part, index) => part.startsWith("`") && part.endsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part);
}

function AddProject({ onClose, onSubmit, disabled }: { onClose: () => void; onSubmit: (cwd: string) => void; disabled: boolean }) {
  const [cwd, setCwd] = useState("");
  return <div className="scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="dialog" onSubmit={(event) => { event.preventDefault(); onSubmit(cwd.trim()); }}><div className="dialog-head"><div><span className="eyebrow">Host checkout</span><h2>Register a project</h2></div><button type="button" className="icon-button" onClick={onClose}>×</button></div><p>The checkout must be a Git root with a container-reachable origin. Its host files are never mounted into the agent container.</p><label>Absolute path<input autoFocus value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/Users/you/Code/project" /></label><div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={disabled || !cwd.trim()}>Register project</button></div></form></div>;
}

function Inbox({ requests, onClose, onSelect, onRespond, disabled }: { requests: ServerRequestDto[]; onClose: () => void; onSelect: (threadId?: string) => void; onRespond: (request: ServerRequestDto, accepted: boolean) => void; disabled: boolean }) {
  return <div className="scrim drawer-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="inbox"><div className="dialog-head"><div><span className="eyebrow">Aggregator-wide</span><h2>Requests inbox</h2></div><button className="icon-button" onClick={onClose}>×</button></div>{requests.length ? requests.map((request) => {
    const actionable = approvalResult(request, true) !== null;
    return <div className={actionable ? "inbox-item" : "inbox-item structured-request"} key={String(request.id)}><button className="inbox-main" onClick={() => onSelect(requestThreadId(request))}><strong>{requestLabel(request)}</strong><span>{requestDetail(request)}</span></button>{actionable
      ? <div className="approval-actions"><button onClick={() => onRespond(request, false)} disabled={disabled}>Deny</button><button className="primary" onClick={() => onRespond(request, true)} disabled={disabled}>Approve</button></div>
      : <p className="request-note">Needs a structured response; left pending.</p>}</div>;
  }) : <Empty title="Nothing is waiting" detail="Pending requests from every live machine appear here." />}</aside></div>;
}

function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) { return <div className="empty"><div className="empty-orbit"><span>·</span></div><h2>{title}</h2><p>{detail}</p>{action}</div>; }
function basename(path: string) { return path.split("/").filter(Boolean).at(-1) ?? path; }
function capitalize(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
