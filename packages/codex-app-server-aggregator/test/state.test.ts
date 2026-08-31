import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AggregatorState } from "../src/state.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("aggregator state schema", () => {
  test("migrates the container-only schema without changing existing bindings", () => {
    const directory = mkdtempSync(join(tmpdir(), "skizzles-state-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite3");
    const old = new Database(path, { create: true, strict: true });
    old.exec([
      "CREATE TABLE projects (cwd TEXT PRIMARY KEY, clone_url TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;",
      "CREATE TABLE machines (machine_id TEXT PRIMARY KEY, project_cwd TEXT NOT NULL, container_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'orphaned', 'removed')), updated_at INTEGER NOT NULL) STRICT;",
      "CREATE TABLE threads (thread_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_cwd TEXT NOT NULL, snapshot_json TEXT, loaded INTEGER NOT NULL CHECK (loaded IN (0, 1)), archived INTEGER NOT NULL CHECK (archived IN (0, 1)), deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)), updated_at INTEGER NOT NULL) STRICT;",
      "CREATE INDEX machines_by_state ON machines (state, machine_id);",
      "CREATE INDEX visible_threads_by_machine ON threads (machine_id, deleted, thread_id);",
      "INSERT INTO projects VALUES ('/host/project', 'https://example.test/project.git', 1, 1);",
      "INSERT INTO machines VALUES ('machine-1', '/host/project', 'container-1', 'active', 1);",
      "INSERT INTO threads VALUES ('thread-1', 'machine-1', '/host/project', '{\"id\":\"thread-1\",\"cwd\":\"/host/project\"}', 1, 0, 0, 1);",
    ].join("\n"));
    old.close();

    const state = new AggregatorState(path);
    expect(state.projects()).toEqual([{
      cwd: "/host/project",
      cloneUrl: "https://example.test/project.git",
      createdAt: 1,
      updatedAt: 1,
    }]);
    expect(state.machines()).toEqual([{
      machineId: "machine-1",
      kind: "container",
      projectCwd: "/host/project",
      containerId: "container-1",
      state: "active",
    }]);
    expect(state.threads()).toMatchObject([{
      threadId: "thread-1",
      machineId: "machine-1",
      executionMode: "container",
      loaded: true,
    }]);
    expect(state.saveProject({ cwd: "/host/only", cloneUrl: null })).toMatchObject({ cloneUrl: null });
    state.close();
  });

  test("projects many host threads onto one machine without losing per-thread cwd", () => {
    const state = new AggregatorState(":memory:");
    state.saveMachine({ machineId: "host", kind: "host" });
    for (const projectCwd of ["/host/a", "/host/b"]) {
      state.saveThread({
        threadId: "thread-" + projectCwd.at(-1),
        machineId: "host",
        projectCwd,
        executionMode: "host",
        snapshot: undefined,
        loaded: true,
        archived: false,
        deleted: false,
      });
    }

    expect(state.machineFleet()).toEqual([{
      machineId: "host",
      kind: "host",
      projectCwd: null,
      containerId: null,
      state: "active",
      threadIds: ["thread-a", "thread-b"],
      threads: [
        { threadId: "thread-a", projectCwd: "/host/a", executionMode: "host" },
        { threadId: "thread-b", projectCwd: "/host/b", executionMode: "host" },
      ],
    }]);
    state.close();
  });
});
