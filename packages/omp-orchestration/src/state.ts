import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SERVICE_SCHEMA, type Approval, type ApprovalState, type Job, type JobState, type JournalEvent, type Maintainer, type MaintainerState, type Project } from "./protocol.ts";

type ProjectRow = {
  id: string; name: string; cwd: string; remote: string | null; base_branch: string;
  model: string | null; thinking: string | null; auto_publish: number; enabled: number;
  created_at: number; updated_at: number;
};
type MaintainerRow = {
  project_id: string; state: MaintainerState; pid: number | null; session_id: string | null;
  session_file: string | null; started_at: number | null; heartbeat_at: number | null;
  restart_count: number; last_error: string | null;
};
type JobRow = {
  id: string; project_id: string; agent: string; description: string | null; assignment: string | null;
  status: JobState; parent_tool_call_id: string | null; session_file: string | null; base_sha: string | null;
  branch_name: string; progress_json: string | null; error: string | null; pr_url: string | null;
  pr_number: number | null; created_at: number; updated_at: number; completed_at: number | null;
};
type ApprovalRow = {
  id: string; project_id: string; method: string; title: string | null; request_json: string;
  status: ApprovalState; response_json: string | null; created_at: number; resolved_at: number | null;
};
type EventRow = { sequence: number; project_id: string | null; kind: string; payload_json: string; created_at: number };

export class OrchestrationState {
  readonly database: Database;
  private readonly databasePath: string | undefined;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path, { create: true, strict: true });
    this.databasePath = path === ":memory:" ? undefined : path;
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const schema = this.database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (schema !== 0 && schema !== SERVICE_SCHEMA) {
      this.database.close();
      throw new Error(`unsupported OMP orchestration database schema ${schema}; expected ${SERVICE_SCHEMA}`);
    }
    this.initialize();
  }

  close(): void { this.database.close(); }

  acquireDaemonLease(): () => void {
    if (!this.databasePath) return () => undefined;
    const lease = new Database(`${this.databasePath}.daemon-lock.sqlite`, { create: true, strict: true });
    try {
      lease.exec("PRAGMA busy_timeout = 0");
      lease.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      lease.close();
      if (error instanceof Error && error.message.includes("database is locked")) {
        throw new Error(`OMP orchestration database is already owned: ${this.databasePath}`);
      }
      throw error;
    }
    return () => { try { lease.exec("ROLLBACK"); } finally { lease.close(); } };
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL UNIQUE,
        remote TEXT,
        base_branch TEXT NOT NULL,
        model TEXT,
        thinking TEXT,
        auto_publish INTEGER NOT NULL CHECK (auto_publish IN (0, 1)),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS maintainers (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        pid INTEGER,
        session_id TEXT,
        session_file TEXT,
        started_at INTEGER,
        heartbeat_at INTEGER,
        restart_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE(project_id, source, source_key)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        description TEXT,
        assignment TEXT,
        status TEXT NOT NULL,
        parent_tool_call_id TEXT,
        session_file TEXT,
        base_sha TEXT,
        branch_name TEXT NOT NULL,
        progress_json TEXT,
        error TEXT,
        pr_url TEXT,
        pr_number INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY(project_id, id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        title TEXT,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        PRIMARY KEY(project_id, id)
      );
      CREATE TABLE IF NOT EXISTS event_journal (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_journal_project_sequence ON event_journal(project_id, sequence);
      CREATE INDEX IF NOT EXISTS jobs_project_updated ON jobs(project_id, updated_at DESC);
      PRAGMA user_version = ${SERVICE_SCHEMA};
    `);
  }

  saveProject(input: Omit<Project, "createdAt" | "updatedAt">, now = Date.now()): Project {
    this.database.query(`
      INSERT INTO projects (id, name, cwd, remote, base_branch, model, thinking, auto_publish, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, cwd = excluded.cwd, remote = excluded.remote, base_branch = excluded.base_branch,
        model = excluded.model, thinking = excluded.thinking, auto_publish = excluded.auto_publish,
        enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(input.id, input.name, input.cwd, input.remote, input.baseBranch, input.model, input.thinking,
      input.autoPublish ? 1 : 0, input.enabled ? 1 : 0, now, now);
    return this.project(input.id)!;
  }

  project(id: string): Project | undefined {
    const row = this.database.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? projectFromRow(row) : undefined;
  }

  projects(): Project[] {
    return this.database.query<ProjectRow, []>("SELECT * FROM projects ORDER BY id").all().map(projectFromRow);
  }

  removeProject(id: string): boolean {
    return this.database.query("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  setProjectEnabled(id: string, enabled: boolean, now = Date.now()): void {
    this.database.query("UPDATE projects SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now, id);
  }

  saveMaintainer(projectId: string, patch: Partial<Omit<Maintainer, "projectId">>): Maintainer {
    const current = this.maintainer(projectId) ?? {
      projectId, state: "stopped" as const, pid: null, sessionId: null, sessionFile: null,
      startedAt: null, heartbeatAt: null, restartCount: 0, lastError: null,
    };
    const next = { ...current, ...patch };
    this.database.query(`
      INSERT INTO maintainers (project_id, state, pid, session_id, session_file, started_at, heartbeat_at, restart_count, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET state=excluded.state, pid=excluded.pid, session_id=excluded.session_id,
        session_file=excluded.session_file, started_at=excluded.started_at, heartbeat_at=excluded.heartbeat_at,
        restart_count=excluded.restart_count, last_error=excluded.last_error
    `).run(projectId, next.state, next.pid, next.sessionId, next.sessionFile, next.startedAt,
      next.heartbeatAt, next.restartCount, next.lastError);
    return next;
  }

  maintainer(projectId: string): Maintainer | undefined {
    const row = this.database.query<MaintainerRow, [string]>("SELECT * FROM maintainers WHERE project_id = ?").get(projectId);
    return row ? maintainerFromRow(row) : undefined;
  }

  recoverMaintainers(now = Date.now()): void {
    this.database.query(`UPDATE maintainers SET state = 'stopped', pid = NULL, heartbeat_at = ?,
      last_error = CASE WHEN state IN ('starting', 'ready', 'busy') THEN 'daemon restarted' ELSE last_error END`).run(now);
    this.database.query(`UPDATE jobs SET status = 'failed', error = 'daemon restarted while subagent was active', updated_at = ?, completed_at = ?
      WHERE status = 'running'`).run(now, now);
    this.database.query(`UPDATE jobs SET status = 'publish_failed', error = 'daemon restarted while publication was active', updated_at = ?
      WHERE status = 'publishing'`).run(now);
    this.database.query(`UPDATE approvals SET status = 'cancelled', response_json = ?, resolved_at = ? WHERE status = 'pending'`)
      .run(JSON.stringify({ cancelled: true, reason: "daemon restarted" }), now);
  }

  acceptInbox(input: { projectId: string; source: string; sourceKey: string; kind: string; payload: unknown }, now = Date.now()): { id: number; duplicate: boolean; delivered: boolean } {
    const result = this.database.query(`INSERT OR IGNORE INTO inbox
      (project_id, source, source_key, kind, payload_json, accepted_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.projectId, input.source, input.sourceKey, input.kind, JSON.stringify(input.payload), now);
    const row = this.database.query<{ id: number; delivered_at: number | null }, [string, string, string]>(
      "SELECT id, delivered_at FROM inbox WHERE project_id = ? AND source = ? AND source_key = ?",
    ).get(input.projectId, input.source, input.sourceKey);
    if (!row) throw new Error("inbox event was not persisted");
    return { id: row.id, duplicate: result.changes === 0, delivered: row.delivered_at !== null };
  }

  markInboxDelivered(id: number, now = Date.now()): void {
    this.database.query("UPDATE inbox SET delivered_at = ? WHERE id = ?").run(now, id);
  }

  saveJobLifecycle(projectId: string, payload: Record<string, unknown>, baseSha: string | null, now = Date.now()): Job | undefined {
    const id = typeof payload.id === "string" ? payload.id : undefined;
    const agent = typeof payload.agent === "string" ? payload.agent : undefined;
    const lifecycle = typeof payload.status === "string" ? payload.status : undefined;
    if (!id || !agent || !lifecycle) return undefined;
    const status: JobState = lifecycle === "completed" ? "completed" : lifecycle === "failed" ? "failed" : lifecycle === "aborted" ? "aborted" : "running";
    const completedAt = status === "running" ? null : now;
    this.database.query(`
      INSERT INTO jobs (id, project_id, agent, description, assignment, status, parent_tool_call_id, session_file,
        base_sha, branch_name, progress_json, error, pr_url, pr_number, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
      ON CONFLICT(project_id, id) DO UPDATE SET agent=excluded.agent,
        description=COALESCE(excluded.description, jobs.description),
        status=CASE
          WHEN jobs.status IN ('publishing', 'published', 'publish_failed') THEN jobs.status
          WHEN jobs.status IN ('completed', 'failed', 'aborted') AND excluded.status = 'running' THEN jobs.status
          ELSE excluded.status
        END,
        parent_tool_call_id=COALESCE(excluded.parent_tool_call_id, jobs.parent_tool_call_id),
        session_file=COALESCE(excluded.session_file, jobs.session_file), updated_at=excluded.updated_at,
        completed_at=COALESCE(jobs.completed_at, excluded.completed_at)
    `).run(id, projectId, agent, stringOrNull(payload.description), status, stringOrNull(payload.parentToolCallId),
      stringOrNull(payload.sessionFile), baseSha, `omp/task/${id}`, now, now, completedAt);
    return this.job(projectId, id);
  }

  saveJobProgress(projectId: string, payload: Record<string, unknown>, now = Date.now()): Job | undefined {
    const progress = recordOrNull(payload.progress);
    const id = typeof progress?.id === "string" ? progress.id : undefined;
    if (!id) return undefined;
    this.database.query(`UPDATE jobs SET assignment=COALESCE(?, assignment), progress_json=?, session_file=COALESCE(?, session_file), updated_at=?
      WHERE project_id=? AND id=?`).run(stringOrNull(payload.assignment), JSON.stringify(progress), stringOrNull(payload.sessionFile), now, projectId, id);
    return this.job(projectId, id);
  }

  setJobPublishState(projectId: string, id: string, input: { status: JobState; error?: string | null; prUrl?: string | null; prNumber?: number | null }, now = Date.now()): void {
    this.database.query(`UPDATE jobs SET status=?, error=?, pr_url=COALESCE(?, pr_url), pr_number=COALESCE(?, pr_number), updated_at=?
      WHERE project_id=? AND id=?`).run(input.status, input.error ?? null, input.prUrl ?? null, input.prNumber ?? null, now, projectId, id);
  }

  job(projectId: string, id: string): Job | undefined {
    const row = this.database.query<JobRow, [string, string]>("SELECT * FROM jobs WHERE project_id = ? AND id = ?").get(projectId, id);
    return row ? jobFromRow(row) : undefined;
  }

  jobs(projectId?: string): Job[] {
    const rows = projectId
      ? this.database.query<JobRow, [string]>("SELECT * FROM jobs WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)
      : this.database.query<JobRow, []>("SELECT * FROM jobs ORDER BY updated_at DESC").all();
    return rows.map(jobFromRow);
  }

  saveApproval(projectId: string, request: Record<string, unknown>, now = Date.now()): Approval | undefined {
    const id = typeof request.id === "string" ? request.id : undefined;
    const method = typeof request.method === "string" ? request.method : undefined;
    if (!id || !method) return undefined;
    this.database.query(`INSERT INTO approvals
      (id, project_id, method, title, request_json, status, response_json, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
      ON CONFLICT(project_id, id) DO UPDATE SET request_json=excluded.request_json, title=excluded.title`)
      .run(id, projectId, method, stringOrNull(request.title), JSON.stringify(request), now);
    return this.approval(projectId, id);
  }

  resolveApproval(projectId: string, id: string, status: Exclude<ApprovalState, "pending">, response: unknown, now = Date.now()): boolean {
    return this.database.query(`UPDATE approvals SET status=?, response_json=?, resolved_at=?
      WHERE project_id=? AND id=? AND status='pending'`).run(status, JSON.stringify(response), now, projectId, id).changes > 0;
  }

  approval(projectId: string, id: string): Approval | undefined {
    const row = this.database.query<ApprovalRow, [string, string]>("SELECT * FROM approvals WHERE project_id=? AND id=?").get(projectId, id);
    return row ? approvalFromRow(row) : undefined;
  }

  approvals(projectId?: string, pendingOnly = false): Approval[] {
    const condition = `${projectId ? "project_id = ?" : "1 = 1"}${pendingOnly ? " AND status = 'pending'" : ""}`;
    const rows = projectId
      ? this.database.query<ApprovalRow, [string]>(`SELECT * FROM approvals WHERE ${condition} ORDER BY created_at DESC`).all(projectId)
      : this.database.query<ApprovalRow, []>(`SELECT * FROM approvals WHERE ${condition} ORDER BY created_at DESC`).all();
    return rows.map(approvalFromRow);
  }

  appendEvent(projectId: string | null, kind: string, payload: unknown, now = Date.now()): JournalEvent {
    const result = this.database.query("INSERT INTO event_journal (project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(projectId, kind, JSON.stringify(payload), now);
    return { sequence: Number(result.lastInsertRowid), projectId, kind, payload, createdAt: now };
  }

  events(after = 0, projectId?: string, limit = 200): JournalEvent[] {
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const rows = projectId
      ? this.database.query<EventRow, [number, string, number]>(`SELECT * FROM event_journal WHERE sequence > ? AND project_id = ? ORDER BY sequence LIMIT ?`).all(after, projectId, boundedLimit)
      : this.database.query<EventRow, [number, number]>(`SELECT * FROM event_journal WHERE sequence > ? ORDER BY sequence LIMIT ?`).all(after, boundedLimit);
    return rows.map(eventFromRow);
  }
}

function projectFromRow(row: ProjectRow): Project {
  return { id: row.id, name: row.name, cwd: row.cwd, remote: row.remote, baseBranch: row.base_branch,
    model: row.model, thinking: row.thinking, autoPublish: row.auto_publish === 1, enabled: row.enabled === 1,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function maintainerFromRow(row: MaintainerRow): Maintainer {
  return { projectId: row.project_id, state: row.state, pid: row.pid, sessionId: row.session_id,
    sessionFile: row.session_file, startedAt: row.started_at, heartbeatAt: row.heartbeat_at,
    restartCount: row.restart_count, lastError: row.last_error };
}
function jobFromRow(row: JobRow): Job {
  return { id: row.id, projectId: row.project_id, agent: row.agent, description: row.description,
    assignment: row.assignment, status: row.status, parentToolCallId: row.parent_tool_call_id,
    sessionFile: row.session_file, baseSha: row.base_sha, branchName: row.branch_name,
    progress: parseJson(row.progress_json), error: row.error, prUrl: row.pr_url, prNumber: row.pr_number,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at };
}
function approvalFromRow(row: ApprovalRow): Approval {
  return { id: row.id, projectId: row.project_id, method: row.method, title: row.title,
    request: parseJson(row.request_json), status: row.status, response: parseJson(row.response_json),
    createdAt: row.created_at, resolvedAt: row.resolved_at };
}
function eventFromRow(row: EventRow): JournalEvent {
  return { sequence: row.sequence, projectId: row.project_id, kind: row.kind, payload: parseJson(row.payload_json), createdAt: row.created_at };
}
function parseJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}
function stringOrNull(value: unknown): string | null { return typeof value === "string" ? value : null; }
function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
