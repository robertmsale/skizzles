import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestrationState } from "../src/state.ts";

function fixtureState(): OrchestrationState {
  const state = new OrchestrationState(":memory:");
  state.saveProject({
    id: "skizzles", name: "Skizzles", cwd: "/tmp/skizzles", remote: "git@example.test:skizzles.git",
    baseBranch: "main", model: null, thinking: null, autoPublish: true, enabled: true,
  }, 100);
  return state;
}

describe("OrchestrationState", () => {
  test("persists projects, maintainers, jobs, and recovery transitions", () => {
    const state = fixtureState();
    state.saveMaintainer("skizzles", { state: "busy", pid: 42, sessionId: "session", sessionFile: "/tmp/session.jsonl" });
    state.saveJobLifecycle("skizzles", { id: "agent-1", agent: "worker", status: "started", description: "Fix it" }, "abc", 200);
    state.saveJobProgress("skizzles", { progress: { id: "agent-1", status: "running" }, assignment: "Repair the widget" }, 250);
    expect(state.job("skizzles", "agent-1")).toMatchObject({
      status: "running", baseSha: "abc", branchName: "omp/task/agent-1", assignment: "Repair the widget",
    });
    state.saveJobLifecycle("skizzles", { id: "agent-2", agent: "worker", status: "started" }, "def", 210);
    state.saveJobLifecycle("skizzles", { id: "agent-2", agent: "worker", status: "completed" }, null, 260);
    state.setJobPublishState("skizzles", "agent-2", { status: "publishing" }, 270);
    state.recoverMaintainers(300);
    expect(state.maintainer("skizzles")).toMatchObject({ state: "stopped", pid: null, lastError: "daemon restarted" });
    expect(state.job("skizzles", "agent-1")).toMatchObject({ status: "failed", completedAt: 300 });
    expect(state.job("skizzles", "agent-2")).toMatchObject({ status: "publish_failed", error: "daemon restarted while publication was active" });
    state.close();
  });

  test("deduplicates ingress before delivery", () => {
    const state = fixtureState();
    const input = { projectId: "skizzles", source: "github", sourceKey: "delivery-7", kind: "issues.opened", payload: { issue: 7 } };
    expect(state.acceptInbox(input, 100)).toEqual({ id: 1, duplicate: false, delivered: false });
    state.markInboxDelivered(1, 150);
    expect(state.acceptInbox(input, 200)).toEqual({ id: 1, duplicate: true, delivered: true });
    state.close();
  });

  test("resolves each approval at most once", () => {
    const state = fixtureState();
    state.saveApproval("skizzles", { id: "approval-1", method: "confirm", title: "Proceed?" }, 100);
    expect(state.resolveApproval("skizzles", "approval-1", "approved", { confirmed: true }, 200)).toBe(true);
    expect(state.resolveApproval("skizzles", "approval-1", "denied", { cancelled: true }, 300)).toBe(false);
    expect(state.approval("skizzles", "approval-1")).toMatchObject({ status: "approved", resolvedAt: 200 });
    state.close();
  });

  test("journals ordered resumable events", () => {
    const state = fixtureState();
    const first = state.appendEvent("skizzles", "one", { value: 1 }, 100);
    const second = state.appendEvent("skizzles", "two", { value: 2 }, 200);
    expect(state.events(first.sequence)).toEqual([second]);
    state.close();
  });

  test("does not regress a published job when OMP repeats lifecycle frames", () => {
    const state = fixtureState();
    state.saveJobLifecycle("skizzles", { id: "agent-1", agent: "worker", status: "started" }, "abc", 100);
    state.saveJobLifecycle("skizzles", { id: "agent-1", agent: "worker", status: "completed" }, null, 200);
    state.setJobPublishState("skizzles", "agent-1", { status: "published", prUrl: "https://example.test/pr/1", prNumber: 1 }, 300);
    state.saveJobLifecycle("skizzles", { id: "agent-1", agent: "worker", status: "started" }, "abc", 400);
    expect(state.job("skizzles", "agent-1")).toMatchObject({ status: "published", prNumber: 1, completedAt: 200 });
    state.close();
  });

  test("rejects a database from an unsupported schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "skizzles-omp-schema-"));
    const path = join(root, "state.sqlite");
    const database = new Database(path, { create: true });
    database.exec("PRAGMA user_version = 99");
    database.close();
    expect(() => new OrchestrationState(path)).toThrow("unsupported OMP orchestration database schema 99");
    await rm(root, { recursive: true, force: true });
  });
});
