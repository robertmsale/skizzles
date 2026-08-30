import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type RegisteredProject = {
  cwd: string;
  cloneUrl: string;
  createdAt: number;
  updatedAt: number;
};

export type StoredMachine = {
  machineId: string;
  projectCwd: string;
  containerId: string;
  state: "active" | "orphaned" | "removed";
};

export type StoredMachineFleet = StoredMachine & { threadIds: string[] };

export type StoredThread = {
  threadId: string;
  machineId: string;
  projectCwd: string;
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
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        cwd TEXT PRIMARY KEY,
        clone_url TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS machines (
        machine_id TEXT PRIMARY KEY,
        project_cwd TEXT NOT NULL,
        container_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'orphaned', 'removed')),
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        project_cwd TEXT NOT NULL,
        snapshot_json TEXT,
        loaded INTEGER NOT NULL CHECK (loaded IN (0, 1)),
        archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS machines_by_state
      ON machines (state, machine_id);

      CREATE INDEX IF NOT EXISTS visible_threads_by_machine
      ON threads (machine_id, deleted, thread_id)
    `);
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

  saveProject(values: { cwd: string; cloneUrl: string }, now = Date.now()): RegisteredProject {
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

  saveMachine(machine: Omit<StoredMachine, "state">, now = Date.now()): void {
    this.database.query(`
      INSERT INTO machines (machine_id, project_cwd, container_id, state, updated_at)
      VALUES (?, ?, ?, 'active', ?)
      ON CONFLICT (machine_id) DO UPDATE SET
        project_cwd = excluded.project_cwd,
        container_id = excluded.container_id,
        state = 'active',
        updated_at = excluded.updated_at
    `).run(machine.machineId, machine.projectCwd, machine.containerId, now);
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
      SELECT machine_id, project_cwd, container_id, state
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
      SELECT machine_id, project_cwd, container_id, state
      FROM machines
      ORDER BY machine_id
    `).all().map(machineFromRow);
  }

  machineFleet(): StoredMachineFleet[] {
    const rows = this.database.query<MachineFleetRow, []>(`
      SELECT m.machine_id, m.project_cwd, m.container_id, m.state, t.thread_id
      FROM machines AS m
      LEFT JOIN threads AS t ON t.machine_id = m.machine_id AND t.deleted = 0
      WHERE m.state IN ('active', 'orphaned')
      ORDER BY m.machine_id, t.thread_id
    `).all();
    const fleet: StoredMachineFleet[] = [];
    for (const row of rows) {
      let machine = fleet.at(-1);
      if (machine?.machineId !== row.machine_id) {
        machine = { ...machineFromRow(row), threadIds: [] };
        fleet.push(machine);
      }
      if (row.thread_id !== null) machine.threadIds.push(row.thread_id);
    }
    return fleet;
  }

  saveThread(thread: StoredThread, now = Date.now()): void {
    this.database.query(`
      INSERT INTO threads (
        thread_id, machine_id, project_cwd, snapshot_json, loaded, archived, deleted, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET
        machine_id = excluded.machine_id,
        project_cwd = excluded.project_cwd,
        snapshot_json = excluded.snapshot_json,
        loaded = excluded.loaded,
        archived = excluded.archived,
        deleted = excluded.deleted,
        updated_at = excluded.updated_at
    `).run(
      thread.threadId,
      thread.machineId,
      thread.projectCwd,
      thread.snapshot ? JSON.stringify(thread.snapshot) : null,
      Number(thread.loaded),
      Number(thread.archived),
      Number(thread.deleted),
      now,
    );
  }

  threads(): StoredThread[] {
    return this.database.query<ThreadRow, []>(`
      SELECT thread_id, machine_id, project_cwd, snapshot_json, loaded, archived, deleted
      FROM threads
      ORDER BY thread_id
    `).all().map(threadFromRow);
  }
}

type ProjectRow = {
  cwd: string;
  clone_url: string;
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
  project_cwd: string;
  container_id: string;
  state: StoredMachine["state"];
};

type MachineFleetRow = MachineRow & { thread_id: string | null };

function machineFromRow(row: MachineRow): StoredMachine {
  return {
    machineId: row.machine_id,
    projectCwd: row.project_cwd,
    containerId: row.container_id,
    state: row.state,
  };
}

type ThreadRow = {
  thread_id: string;
  machine_id: string;
  project_cwd: string;
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
    snapshot,
    loaded: row.loaded === 1,
    archived: row.archived === 1,
    deleted: row.deleted === 1,
  };
}
