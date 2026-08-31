import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExecutionMode } from "./execution.ts";

export type RegisteredProject = {
  cwd: string;
  cloneUrl: string | null;
  createdAt: number;
  updatedAt: number;
};

export type StoredMachine = {
  machineId: string;
  kind: ExecutionMode;
  projectCwd: string | null;
  containerId: string | null;
  state: "active" | "orphaned" | "removed";
};

export type StoredThreadBinding = Pick<StoredThread, "threadId" | "projectCwd" | "executionMode">;

export type StoredMachineFleet = StoredMachine & {
  threadIds: string[];
  threads: StoredThreadBinding[];
};

export type StoredThread = {
  threadId: string;
  machineId: string;
  projectCwd: string;
  executionMode: ExecutionMode;
  snapshot: Record<string, unknown> & { id: string } | undefined;
  loaded: boolean;
  archived: boolean;
  deleted: boolean;
};

export class AggregatorState {
  private readonly database: Database;
  private readonly databasePath: string | undefined;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path, { create: true, strict: true });
    this.databasePath = path === ":memory:" ? undefined : realpathSync(resolve(path));
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.initializeSchema();
  }

  close(): void {
    this.database.close();
  }

  async acquireDaemonLease(): Promise<() => Promise<void>> {
    if (!this.databasePath) return async () => undefined;
    const leasePath = `${this.databasePath}.daemon-lock.sqlite`;
    const lease = new Database(leasePath, { create: true, strict: true });
    try {
      lease.exec("PRAGMA busy_timeout = 0");
      lease.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      lease.close();
      if (error instanceof Error && error.message.includes("database is locked")) {
        throw new Error(`aggregator database is already owned: ${this.databasePath}`);
      }
      throw error;
    }
    return async () => {
      try {
        lease.exec("ROLLBACK");
      } finally {
        lease.close();
      }
    };
  }

  project(cwd: string): RegisteredProject | undefined {
    const row = this.database.query<ProjectRow, [string]>(`
      SELECT cwd, clone_url, created_at, updated_at
      FROM projects
      WHERE cwd = ?
    `).get(cwd);
    return row ? projectFromRow(row) : undefined;
  }

  projects(): RegisteredProject[] {
    return this.database.query<ProjectRow, []>(`
      SELECT cwd, clone_url, created_at, updated_at
      FROM projects
      ORDER BY cwd
    `).all().map(projectFromRow);
  }

  saveProject(values: { cwd: string; cloneUrl: string | null }, now = Date.now()): RegisteredProject {
    this.database.query(`
      INSERT INTO projects (cwd, clone_url, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (cwd) DO UPDATE SET
        clone_url = excluded.clone_url,
        updated_at = excluded.updated_at
    `).run(values.cwd, values.cloneUrl, now, now);
    return this.project(values.cwd)!;
  }

  removeProject(cwd: string): boolean {
    return this.database.query("DELETE FROM projects WHERE cwd = ?").run(cwd).changes > 0;
  }

  saveMachine(machine: {
    machineId: string;
    kind?: ExecutionMode | undefined;
    projectCwd?: string | null | undefined;
    containerId?: string | null | undefined;
  }, now = Date.now()): void {
    const kind = machine.kind ?? (machine.containerId ? "container" : "host");
    const projectCwd = machine.projectCwd ?? null;
    const containerId = machine.containerId ?? null;
    if (kind === "container" && (!projectCwd || !containerId)) {
      throw new Error("container machines require projectCwd and containerId");
    }
    if (kind === "host" && (projectCwd !== null || containerId !== null)) {
      throw new Error("host machines cannot have container project or ID fields");
    }
    this.database.query(`
      INSERT INTO machines (machine_id, kind, project_cwd, container_id, state, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?)
      ON CONFLICT (machine_id) DO UPDATE SET
        kind = excluded.kind,
        project_cwd = excluded.project_cwd,
        container_id = excluded.container_id,
        state = 'active',
        updated_at = excluded.updated_at
    `).run(machine.machineId, kind, projectCwd, containerId, now);
  }

  markMachine(machineId: string, state: StoredMachine["state"], now = Date.now()): void {
    this.database.transaction(() => {
      this.database.query("UPDATE machines SET state = ?, updated_at = ? WHERE machine_id = ?")
        .run(state, now, machineId);
      if (state !== "active") {
        this.database.query("UPDATE threads SET loaded = 0, updated_at = ? WHERE machine_id = ? AND loaded = 1")
          .run(now, machineId);
      }
    })();
  }

  recoverOrphanedMachines(now = Date.now()): StoredMachine[] {
    const active = this.database.query<MachineRow, []>(`
      SELECT machine_id, kind, project_cwd, container_id, state
      FROM machines
      WHERE state IN ('active', 'orphaned')
      ORDER BY machine_id
    `).all().map(machineFromRow);
    this.database.transaction(() => {
      this.database.query("UPDATE machines SET state = 'orphaned', updated_at = ? WHERE state = 'active'").run(now);
      this.database.query("UPDATE threads SET loaded = 0, updated_at = ? WHERE loaded = 1").run(now);
    })();
    return active;
  }

  machines(): StoredMachine[] {
    return this.database.query<MachineRow, []>(`
      SELECT machine_id, kind, project_cwd, container_id, state
      FROM machines
      ORDER BY machine_id
    `).all().map(machineFromRow);
  }

  machineFleet(): StoredMachineFleet[] {
    const rows = this.database.query<MachineFleetRow, []>(`
      SELECT m.machine_id, m.kind, m.project_cwd, m.container_id, m.state,
             t.thread_id, t.project_cwd AS thread_project_cwd, t.execution_mode
      FROM machines AS m
      LEFT JOIN threads AS t ON t.machine_id = m.machine_id AND t.deleted = 0
      WHERE m.state IN ('active', 'orphaned')
      ORDER BY m.machine_id, t.thread_id
    `).all();
    const fleet: StoredMachineFleet[] = [];
    for (const row of rows) {
      let machine = fleet.at(-1);
      if (machine?.machineId !== row.machine_id) {
        machine = { ...machineFromRow(row), threadIds: [], threads: [] };
        fleet.push(machine);
      }
      if (row.thread_id !== null && row.thread_project_cwd !== null && row.execution_mode !== null) {
        machine.threadIds.push(row.thread_id);
        machine.threads.push({
          threadId: row.thread_id,
          projectCwd: row.thread_project_cwd,
          executionMode: row.execution_mode,
        });
      }
    }
    return fleet;
  }

  saveThread(
    thread: Omit<StoredThread, "executionMode"> & { executionMode?: ExecutionMode | undefined },
    now = Date.now(),
  ): void {
    this.database.query(`
      INSERT INTO threads (
        thread_id, machine_id, project_cwd, execution_mode,
        snapshot_json, loaded, archived, deleted, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET
        machine_id = excluded.machine_id,
        project_cwd = excluded.project_cwd,
        execution_mode = excluded.execution_mode,
        snapshot_json = excluded.snapshot_json,
        loaded = excluded.loaded,
        archived = excluded.archived,
        deleted = excluded.deleted,
        updated_at = excluded.updated_at
    `).run(
      thread.threadId,
      thread.machineId,
      thread.projectCwd,
      thread.executionMode ?? "container",
      thread.snapshot ? JSON.stringify(thread.snapshot) : null,
      Number(thread.loaded),
      Number(thread.archived),
      Number(thread.deleted),
      now,
    );
  }

  threads(): StoredThread[] {
    return this.database.query<ThreadRow, []>(`
      SELECT thread_id, machine_id, project_cwd, execution_mode,
             snapshot_json, loaded, archived, deleted
      FROM threads
      ORDER BY thread_id
    `).all().map(threadFromRow);
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        cwd TEXT PRIMARY KEY,
        clone_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `);
    if (columnNotNull(this.database, "projects", "clone_url")) {
      this.database.transaction(() => {
        this.database.exec("ALTER TABLE projects RENAME TO projects_container_only");
        this.database.exec(`
          CREATE TABLE projects (
            cwd TEXT PRIMARY KEY,
            clone_url TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT
        `);
        this.database.exec(`
          INSERT INTO projects (cwd, clone_url, created_at, updated_at)
          SELECT cwd, clone_url, created_at, updated_at FROM projects_container_only
        `);
        this.database.exec("DROP TABLE projects_container_only");
      })();
    }

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS machines (
        machine_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('host', 'container')),
        project_cwd TEXT,
        container_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('active', 'orphaned', 'removed')),
        updated_at INTEGER NOT NULL,
        CHECK (
          (kind = 'host' AND project_cwd IS NULL AND container_id IS NULL) OR
          (kind = 'container' AND project_cwd IS NOT NULL AND container_id IS NOT NULL)
        )
      ) STRICT
    `);
    if (!hasColumn(this.database, "machines", "kind")) {
      this.database.transaction(() => {
        this.database.exec("ALTER TABLE machines RENAME TO machines_container_only");
        this.database.exec(`
          CREATE TABLE machines (
            machine_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('host', 'container')),
            project_cwd TEXT,
            container_id TEXT,
            state TEXT NOT NULL CHECK (state IN ('active', 'orphaned', 'removed')),
            updated_at INTEGER NOT NULL,
            CHECK (
              (kind = 'host' AND project_cwd IS NULL AND container_id IS NULL) OR
              (kind = 'container' AND project_cwd IS NOT NULL AND container_id IS NOT NULL)
            )
          ) STRICT
        `);
        this.database.exec(`
          INSERT INTO machines (machine_id, kind, project_cwd, container_id, state, updated_at)
          SELECT machine_id, 'container', project_cwd, container_id, state, updated_at
          FROM machines_container_only
        `);
        this.database.exec("DROP TABLE machines_container_only");
      })();
    }

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        project_cwd TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'container'
          CHECK (execution_mode IN ('host', 'container')),
        snapshot_json TEXT,
        loaded INTEGER NOT NULL CHECK (loaded IN (0, 1)),
        archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        updated_at INTEGER NOT NULL
      ) STRICT
    `);
    if (!hasColumn(this.database, "threads", "execution_mode")) {
      this.database.exec(`
        ALTER TABLE threads ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'container'
          CHECK (execution_mode IN ('host', 'container'))
      `);
    }

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS machines_by_state
      ON machines (state, machine_id);

      CREATE INDEX IF NOT EXISTS visible_threads_by_machine
      ON threads (machine_id, deleted, thread_id)
    `);
  }
}

type ProjectRow = {
  cwd: string;
  clone_url: string | null;
  created_at: number;
  updated_at: number;
};

function projectFromRow(row: ProjectRow): RegisteredProject {
  return {
    cwd: row.cwd,
    cloneUrl: row.clone_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type MachineRow = {
  machine_id: string;
  kind: ExecutionMode;
  project_cwd: string | null;
  container_id: string | null;
  state: StoredMachine["state"];
};

type MachineFleetRow = MachineRow & {
  thread_id: string | null;
  thread_project_cwd: string | null;
  execution_mode: ExecutionMode | null;
};

function machineFromRow(row: MachineRow): StoredMachine {
  return {
    machineId: row.machine_id,
    kind: row.kind,
    projectCwd: row.project_cwd,
    containerId: row.container_id,
    state: row.state,
  };
}

type ThreadRow = {
  thread_id: string;
  machine_id: string;
  project_cwd: string;
  execution_mode: ExecutionMode;
  snapshot_json: string | null;
  loaded: number;
  archived: number;
  deleted: number;
};

function threadFromRow(row: ThreadRow): StoredThread {
  const snapshot = row.snapshot_json === null ? undefined : JSON.parse(row.snapshot_json) as StoredThread["snapshot"];
  if (snapshot !== undefined && (snapshot === null || typeof snapshot !== "object" || typeof snapshot.id !== "string")) {
    throw new Error(`invalid persisted snapshot for thread ${row.thread_id}`);
  }
  return {
    threadId: row.thread_id,
    machineId: row.machine_id,
    projectCwd: row.project_cwd,
    executionMode: row.execution_mode,
    snapshot,
    loaded: row.loaded === 1,
    archived: row.archived === 1,
    deleted: row.deleted === 1,
  };
}

type TableInfoRow = { name: string; notnull: number };

function tableInfo(database: Database, table: string): TableInfoRow[] {
  return database.query<TableInfoRow, []>(`PRAGMA table_info(${table})`).all();
}

function hasColumn(database: Database, table: string, column: string): boolean {
  return tableInfo(database, table).some((row) => row.name === column);
}

function columnNotNull(database: Database, table: string, column: string): boolean {
  return tableInfo(database, table).some((row) => row.name === column && row.notnull === 1);
}
