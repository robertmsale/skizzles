import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RegisteredProject = {
  cwd: string;
  cloneUrl: string;
  createdAt: number;
  updatedAt: number;
};

export class AggregatorState {
  private readonly database: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path, { create: true, strict: true });
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
  }

  close(): void {
    this.database.close();
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
