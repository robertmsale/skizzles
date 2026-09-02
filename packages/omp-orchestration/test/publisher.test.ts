import { describe, expect, test } from "bun:test";
import { PullRequestPublisher } from "../src/publisher.ts";
import { OrchestrationState } from "../src/state.ts";

function fixture() {
  const state = new OrchestrationState(":memory:");
  const project = state.saveProject({
    id: "project", name: "Project", cwd: "/project", remote: "git@github.com:owner/project.git",
    baseBranch: "main", model: null, thinking: null, autoPublish: true, enabled: true,
  }, 100);
  state.saveJobLifecycle("project", { id: "agent-1", agent: "worker", status: "started", description: "Fix widget" }, "base-sha", 200);
  state.saveJobLifecycle("project", { id: "agent-1", agent: "worker", status: "completed" }, null, 300);
  return { state, project, job: state.job("project", "agent-1")! };
}

describe("PullRequestPublisher", () => {
  test("verifies and pushes before creating one idempotent draft PR", async () => {
    const { state, project, job } = fixture();
    const checkedCalls: string[][] = [];
    let listCalls = 0;
    const publisher = new PullRequestPublisher(state, {
      checked: async (command) => {
        checkedCalls.push(command);
        if (command.slice(0, 4).join(" ") === "git remote get-url origin") return project.remote!;
        if (command.slice(0, 4).join(" ") === "git rev-list --count base-sha..omp/task/agent-1") return "1";
        return "";
      },
      run: async () => {
        listCalls += 1;
        return { exitCode: 0, stderr: "", stdout: listCalls < 3 ? "[]" : '[{"number":17,"url":"https://github.test/pr/17","isDraft":true}]' };
      },
    });
    expect(await publisher.publish(project, job)).toMatchObject({ status: "published", prNumber: 17, prUrl: "https://github.test/pr/17" });
    expect(checkedCalls.some((command) => command[0] === "git" && command[1] === "push")).toBe(true);
    expect(checkedCalls.some((command) => command[0] === "gh" && command[1] === "pr" && command[2] === "create" && command.includes("--draft"))).toBe(true);
    state.close();
  });

  test("reuses an existing PR without pushing", async () => {
    const { state, project, job } = fixture();
    const checkedCalls: string[][] = [];
    const publisher = new PullRequestPublisher(state, {
      checked: async (command) => {
        checkedCalls.push(command);
        if (command[1] === "remote") return project.remote!;
        return command[1] === "rev-list" ? "1" : "";
      },
      run: async () => ({ exitCode: 0, stderr: "", stdout: '[{"number":9,"url":"https://github.test/pr/9"}]' }),
    });
    expect(await publisher.publish(project, job)).toMatchObject({ status: "published", prNumber: 9 });
    expect(checkedCalls.some((command) => command[1] === "push")).toBe(false);
    state.close();
  });

  test("persists verification failures for retry", async () => {
    const { state, project, job } = fixture();
    const publisher = new PullRequestPublisher(state, {
      checked: async () => { throw new Error("expected branch is missing"); },
      run: async () => ({ exitCode: 0, stderr: "", stdout: "[]" }),
    });
    expect(publisher.publish(project, job)).rejects.toThrow("expected branch is missing");
    expect(state.job("project", "agent-1")).toMatchObject({ status: "publish_failed", error: "expected branch is missing" });
    state.close();
  });
});
