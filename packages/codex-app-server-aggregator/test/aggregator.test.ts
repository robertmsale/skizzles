import { describe, expect, test } from "bun:test";
import { AppServerAggregator } from "../src/aggregator.ts";
import type { BackendFactory, BackendTransport, HostBackendFactory } from "../src/backend.ts";
import { CONTAINER_WORKSPACE } from "../src/docker.ts";
import type { MessageSink } from "../src/jsonl.ts";
import { ProjectRegistry } from "../src/projects.ts";
import type { RpcId, RpcMessage } from "../src/protocol.ts";
import { AggregatorState, type RegisteredProject, type StoredThread } from "../src/state.ts";

const PROJECT_A = "/host/project-a";
const PROJECT_B = "/host/project-b";

describe("host and container app-server aggregation", () => {
  test("initializes one durable host app-server and serves global discovery without a project", async () => {
    const harness = createHarness([]);
    try {
      await initialize(harness);
      expect(harness.hostFactory.transports).toHaveLength(1);
      expect(harness.containerFactory.transports).toHaveLength(0);
      expect(resultFor(harness.output.messages, 1)).toMatchObject({
        codexHome: "/host-codex-home",
        platformOs: "macos",
      });

      await harness.aggregator.handle({
        method: "skills/list",
        id: 2,
        params: { cwds: [PROJECT_A, PROJECT_B], forceReload: true },
      });
      expect(resultFor(harness.output.messages, 2)).toEqual({
        backend: "host",
        params: { cwds: [PROJECT_A, PROJECT_B], forceReload: true },
      });
      expect(requestFor(harness.host, "skills/list")?.params).toEqual({
        cwds: [PROJECT_A, PROJECT_B],
        forceReload: true,
      });
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("allows host initialization to retry after provisioning fails", async () => {
    const harness = createHarness([]);
    harness.hostFactory.createFailures = 1;
    try {
      await harness.aggregator.handle({ method: "initialize", id: "first", params: initializeParams() });
      expect(errorFor(harness.output.messages, "first").message).toContain("fake host provisioning failure");

      await harness.aggregator.handle({ method: "initialize", id: "second", params: initializeParams() });
      expect(resultFor(harness.output.messages, "second")).toMatchObject({ platformOs: "macos" });
      expect(harness.hostFactory.transports).toHaveLength(1);
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("defaults new threads to containers and forces danger-full-access", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      await harness.aggregator.handle({
        method: "thread/start",
        id: 2,
        params: {
          cwd: PROJECT_A,
          permissions: ":read-only",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          runtimeWorkspaceRoots: [PROJECT_A, "/tmp/elsewhere"],
          config: {
            feature: true,
            sandbox_mode: "read-only",
            permissions: ":read-only",
          },
        },
      });

      const container = harness.containerFactory.transports[0]!;
      const start = requestFor(container, "thread/start")!;
      expect(start.params).toEqual({
        cwd: CONTAINER_WORKSPACE,
        sandbox: "danger-full-access",
        approvalPolicy: "on-request",
        runtimeWorkspaceRoots: [CONTAINER_WORKSPACE],
        config: { feature: true, sandbox_mode: "danger-full-access" },
      });
      const result = resultFor(harness.output.messages, 2) as { thread: { id: string; cwd: string } };
      expect(result.thread.cwd).toBe(PROJECT_A);
      expect(harness.state.threads()).toMatchObject([{
        threadId: result.thread.id,
        projectCwd: PROJECT_A,
        executionMode: "container",
        machineId: container.machineId,
      }]);

      await harness.aggregator.handle({ method: "thread/list", id: 3, params: { cwd: PROJECT_A } });
      expect(resultFor(harness.output.messages, 3)).toMatchObject({
        data: [{ id: result.thread.id, cwd: PROJECT_A }],
      });
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("runs host threads in the canonical host cwd and preserves their permission selection", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      const permissions = ":workspace";
      await harness.aggregator.handle({
        method: "thread/start",
        id: 2,
        params: {
          cwd: PROJECT_A,
          skizzlesExecutionMode: "host",
          permissions,
          approvalPolicy: "untrusted",
        },
      });
      await harness.aggregator.handle({
        method: "thread/start",
        id: 3,
        params: { cwd: PROJECT_B, skizzlesExecutionMode: "host" },
      });

      expect(harness.hostFactory.transports).toHaveLength(1);
      expect(harness.containerFactory.transports).toHaveLength(0);
      expect(requestFor(harness.host, "thread/start", 0)?.params).toEqual({
        cwd: PROJECT_A,
        permissions,
        approvalPolicy: "untrusted",
      });
      expect(requestFor(harness.host, "thread/start", 1)?.params).toEqual({ cwd: PROJECT_B });
      expect(harness.state.threads().map((thread) => ({
        mode: thread.executionMode,
        project: thread.projectCwd,
        machine: thread.machineId,
      }))).toEqual([
        { mode: "host", project: PROJECT_A, machine: "host" },
        { mode: "host", project: PROJECT_B, machine: "host" },
      ]);
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("allows host-only directories but rejects their default container mode clearly", async () => {
    const harness = createHarness([{ cwd: PROJECT_A, cloneUrl: null }]);
    try {
      await initialize(harness);
      await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: PROJECT_A } });
      expect(errorFor(harness.output.messages, 2).message).toContain("host-only");
      expect(harness.containerFactory.transports).toHaveLength(0);

      await harness.aggregator.handle({
        method: "thread/start",
        id: 3,
        params: { cwd: PROJECT_A, skizzlesExecutionMode: "host" },
      });
      expect(resultFor(harness.output.messages, 3)).toMatchObject({ thread: { cwd: PROJECT_A } });

      await harness.aggregator.handle({
        method: "thread/start",
        id: 4,
        params: { cwd: PROJECT_A, skizzlesExecutionMode: "moon" },
      });
      expect(errorFor(harness.output.messages, 4).message).toContain("host' or 'container");
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("rejects unregistered directories without provisioning either backend mode", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      for (const [id, mode] of [["container", "container"], ["host", "host"]] as const) {
        await harness.aggregator.handle({
          method: "thread/start",
          id,
          params: { cwd: "/host/not-registered", skizzlesExecutionMode: mode },
        });
        expect(errorFor(harness.output.messages, id).message).toContain("not a registered project");
      }
      expect(harness.containerFactory.transports).toHaveLength(0);
      expect(requestFor(harness.host, "thread/start")).toBeUndefined();
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("returns a provisioning error without poisoning the next container start", async () => {
    const harness = createHarness();
    harness.containerFactory.createFailures = 1;
    try {
      await initialize(harness);
      await harness.aggregator.handle({ method: "thread/start", id: "failed", params: { cwd: PROJECT_A } });
      expect(errorFor(harness.output.messages, "failed").message).toContain("fake container provisioning failure");
      expect(harness.containerFactory.transports).toHaveLength(0);

      await harness.aggregator.handle({ method: "thread/start", id: "retry", params: { cwd: PROJECT_A } });
      expect(resultFor(harness.output.messages, "retry")).toMatchObject({ thread: { cwd: PROJECT_A } });
      expect(harness.containerFactory.transports).toHaveLength(1);
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("keeps forks and resumes sticky while allowing fresh cross-mode threads", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      const containerThread = await startThread(harness, PROJECT_A, "container", "container-start");
      const container = harness.containerFactory.transports[0]!;

      await harness.aggregator.handle({
        method: "thread/fork",
        id: "bad-fork",
        params: { threadId: containerThread, skizzlesExecutionMode: "host" },
      });
      expect(errorFor(harness.output.messages, "bad-fork").message).toContain("only be selected");
      expect(requestFor(container, "thread/fork")).toBeUndefined();

      await harness.aggregator.handle({
        method: "skizzles/project/list",
        id: "bad-project-extension",
        params: { skizzlesExecutionMode: "host" },
      });
      expect(errorFor(harness.output.messages, "bad-project-extension").message).toContain("only be selected");

      await harness.aggregator.handle({
        method: "thread/fork",
        id: "fork",
        params: {
          threadId: containerThread,
          permissions: ":host-request",
          sandbox: "read-only",
        },
      });
      const fork = resultFor(harness.output.messages, "fork") as { thread: { id: string } };
      expect(requestFor(container, "thread/fork")?.params).toEqual({
        threadId: containerThread,
        sandbox: "danger-full-access",
      });
      expect(harness.state.threads().find((thread) => thread.threadId === fork.thread.id)).toMatchObject({
        machineId: container.machineId,
        executionMode: "container",
      });

      await harness.aggregator.handle({
        method: "thread/resume",
        id: "container-resume",
        params: { threadId: containerThread, sandbox: "read-only" },
      });
      expect(requestFor(container, "thread/resume")?.params).toEqual({
        threadId: containerThread,
        sandbox: "danger-full-access",
      });

      const hostThread = await startThread(harness, PROJECT_A, "host", "host-start");
      expect(hostThread).toStartWith("host-thread-");
      expect(harness.state.threads().find((thread) => thread.threadId === hostThread)).toMatchObject({
        machineId: "host",
        executionMode: "host",
      });
      await harness.aggregator.handle({
        method: "thread/resume",
        id: "host-resume",
        params: { threadId: hostThread, sandbox: "workspace-write" },
      });
      expect(requestFor(harness.host, "thread/resume")?.params).toEqual({
        threadId: hostThread,
        sandbox: "workspace-write",
      });
      expect(harness.containerFactory.transports).toHaveLength(1);
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("forces per-turn container policy but forwards host turn policy unchanged", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      const containerThread = await startThread(harness, PROJECT_A, "container", 2);
      const container = harness.containerFactory.transports[0]!;
      await harness.aggregator.handle({
        method: "turn/start",
        id: 3,
        params: {
          threadId: containerThread,
          permissions: ":read-only",
          sandboxPolicy: { type: "readOnly" },
          approvalPolicy: "on-request",
          input: [],
        },
      });
      expect(requestFor(container, "turn/start")?.params).toEqual({
        threadId: containerThread,
        sandboxPolicy: { type: "dangerFullAccess" },
        approvalPolicy: "on-request",
        input: [],
      });

      const hostThread = await startThread(harness, PROJECT_A, "host", 4);
      const hostTurnParams = {
        threadId: hostThread,
        permissions: ":workspace",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [PROJECT_A] },
        approvalPolicy: "on-request",
        input: [],
      };
      await harness.aggregator.handle({ method: "turn/start", id: 5, params: hostTurnParams });
      expect(requestFor(harness.host, "turn/start")?.params).toEqual(hostTurnParams);
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("rejects and removes a container whose visible model catalog differs from the host", async () => {
    const harness = createHarness();
    harness.runtime.containerModels = ["codex", "grok"];
    harness.runtime.hostModels = ["codex", "grok", "grok-fast"];
    try {
      await initialize(harness);
      await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: PROJECT_A } });

      expect(errorFor(harness.output.messages, 2).message).toContain("missing in container: grok-fast");
      expect(harness.containerFactory.transports[0]?.destroyed).toBe(true);
      expect(requestFor(harness.containerFactory.transports[0]!, "thread/start")).toBeUndefined();
      expect(harness.state.threads()).toEqual([]);
      expect(harness.state.machines().find((machine) => machine.kind === "container")?.state).toBe("removed");
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("compares every hidden-model page before starting a container thread", async () => {
    const harness = createHarness();
    harness.runtime.hostModels = ["codex", "grok", "grok-fast"];
    harness.runtime.containerModels = [...harness.runtime.hostModels];
    harness.runtime.modelPageSize = 1;
    try {
      await initialize(harness);
      await harness.aggregator.handle({ method: "thread/start", id: 2, params: { cwd: PROJECT_A } });
      expect(resultFor(harness.output.messages, 2)).toMatchObject({ thread: { cwd: PROJECT_A } });

      for (const transport of [harness.host, harness.containerFactory.transports[0]!]) {
        expect(transport.writes
          .filter((message) => "method" in message && message.method === "model/list")
          .map((message) => record((message as { params?: unknown }).params)))
          .toEqual([
            { includeHidden: true },
            { includeHidden: true, cursor: "model-page:1" },
            { includeHidden: true, cursor: "model-page:2" },
          ]);
      }
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("archives exact containers without draining the shared host app-server", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      const containerThread = await startThread(harness, PROJECT_A, "container", 2);
      const hostThread = await startThread(harness, PROJECT_A, "host", 3);
      const container = harness.containerFactory.transports[0]!;

      await harness.aggregator.handle({ method: "thread/archive", id: 4, params: { threadId: containerThread } });
      expect(resultFor(harness.output.messages, 4)).toEqual({});
      expect(container.destroyed).toBe(true);

      await harness.aggregator.handle({ method: "thread/archive", id: 5, params: { threadId: hostThread } });
      expect(resultFor(harness.output.messages, 5)).toEqual({});
      expect(harness.host.destroyed).toBe(false);

      await harness.aggregator.handle({ method: "permissionProfile/list", id: 6, params: { cwd: PROJECT_A } });
      expect(resultFor(harness.output.messages, 6)).toEqual({
        backend: "host",
        params: { cwd: PROJECT_A },
      });
      expect(harness.state.machines().find((machine) => machine.kind === "host")?.state).toBe("active");
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("retains a failed container teardown so daemon close can retry it", async () => {
    const harness = createHarness();
    let closed = false;
    try {
      await initialize(harness);
      const threadId = await startThread(harness, PROJECT_A, "container", 2);
      const container = harness.containerFactory.transports[0]!;
      container.destroyFailures = 1;

      await harness.aggregator.handle({ method: "thread/archive", id: 3, params: { threadId } });
      expect(container.destroyed).toBe(false);
      expect(container.destroyCalls).toBe(1);
      expect(harness.state.machines().find((machine) => machine.machineId === container.machineId)?.state)
        .toBe("active");

      await harness.aggregator.close();
      closed = true;
      expect(container.destroyed).toBe(true);
      expect(container.destroyCalls).toBe(2);
      expect(harness.state.machines().find((machine) => machine.machineId === container.machineId)?.state)
        .toBe("removed");
    } finally {
      if (!closed) await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("keeps a fork-bearing container until every thread in its tree is archived", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      const parentId = await startThread(harness, PROJECT_A, "container", 2);
      const container = harness.containerFactory.transports[0]!;
      await harness.aggregator.handle({ method: "thread/fork", id: 3, params: { threadId: parentId } });
      const childId = (resultFor(harness.output.messages, 3) as { thread: { id: string } }).thread.id;

      await harness.aggregator.handle({ method: "thread/archive", id: 4, params: { threadId: parentId } });
      expect(container.destroyed).toBe(false);
      await harness.aggregator.handle({ method: "thread/archive", id: 5, params: { threadId: childId } });
      expect(container.destroyed).toBe(true);
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("blocks project removal for either mode and keeps the host when a drained project is removed", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      const hostThread = await startThread(harness, PROJECT_A, "host", 2);
      const containerThread = await startThread(harness, PROJECT_B, "container", "container-start");
      await harness.aggregator.handle({
        method: "skizzles/project/remove",
        id: 3,
        params: { cwd: PROJECT_A },
      });
      expect(errorFor(harness.output.messages, 3).message).toBe("project has active threads");
      await harness.aggregator.handle({
        method: "skizzles/project/remove",
        id: "container-remove",
        params: { cwd: PROJECT_B },
      });
      expect(errorFor(harness.output.messages, "container-remove").message).toBe("project has active threads");

      await harness.aggregator.handle({ method: "thread/archive", id: 4, params: { threadId: hostThread } });
      await harness.aggregator.handle({
        method: "thread/archive",
        id: "container-archive",
        params: { threadId: containerThread },
      });
      await harness.aggregator.handle({
        method: "skizzles/project/remove",
        id: 5,
        params: { cwd: PROJECT_A },
      });
      expect(resultFor(harness.output.messages, 5)).toEqual({ removed: true });
      await harness.aggregator.handle({
        method: "skizzles/project/remove",
        id: "container-remove-after-archive",
        params: { cwd: PROJECT_B },
      });
      expect(resultFor(harness.output.messages, "container-remove-after-archive")).toEqual({ removed: true });
      expect(harness.host.destroyed).toBe(false);
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("correlates colliding reverse requests from host and container independently", async () => {
    const harness = createHarness();
    try {
      await initialize(harness);
      await startThread(harness, PROJECT_A, "container", 2);
      harness.host.emit({
        method: "item/commandExecution/requestApproval",
        id: 7,
        params: { threadId: "host-thread-1", command: "echo host" },
      });
      harness.containerFactory.transports[0]!.emit({
        method: "item/commandExecution/requestApproval",
        id: 7,
        params: { threadId: "container-thread-1", command: "echo container" },
      });
      await waitFor(() => harness.output.messages.filter(isServerRequest).length === 2);
      const requests = harness.output.messages.filter(isServerRequest);
      expect(requests[0]!.id).not.toBe(requests[1]!.id);

      await harness.aggregator.handle({ id: requests[0]!.id, result: { decision: "accept" } });
      await harness.aggregator.handle({ id: requests[1]!.id, result: { decision: "decline" } });
      expect(harness.host.response(7)).toMatchObject({ id: 7, result: { decision: "accept" } });
      expect(harness.containerFactory.transports[0]!.response(7)).toMatchObject({
        id: 7,
        result: { decision: "decline" },
      });
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("routes recovered host threads to the new host process but never migrates stale containers", async () => {
    const recovered: StoredThread[] = [
      {
        threadId: "recovered-host",
        machineId: "host",
        projectCwd: PROJECT_A,
        executionMode: "host",
        snapshot: snapshot("recovered-host", PROJECT_A),
        loaded: false,
        archived: false,
        deleted: false,
      },
      {
        threadId: "recovered-container",
        machineId: "old-container-machine",
        projectCwd: PROJECT_A,
        executionMode: "container",
        snapshot: snapshot("recovered-container", PROJECT_A),
        loaded: false,
        archived: false,
        deleted: false,
      },
    ];
    const harness = createHarness(undefined, recovered);
    try {
      await initialize(harness);
      await harness.aggregator.handle({
        method: "thread/read",
        id: 2,
        params: { threadId: "recovered-host", includeTurns: true },
      });
      expect(requestFor(harness.host, "thread/read")?.params).toEqual({
        threadId: "recovered-host",
        includeTurns: true,
      });

      await harness.aggregator.handle({
        method: "thread/read",
        id: 3,
        params: { threadId: "recovered-container", includeTurns: true },
      });
      expect(errorFor(harness.output.messages, 3).message).toContain("unavailable");
      expect(harness.containerFactory.transports).toHaveLength(0);

      await harness.aggregator.handle({
        method: "thread/read",
        id: 4,
        params: { threadId: "recovered-container", includeTurns: false },
      });
      expect(resultFor(harness.output.messages, 4)).toMatchObject({
        thread: { id: "recovered-container", cwd: PROJECT_A },
      });

      await harness.aggregator.handle({
        method: "thread/archive",
        id: 5,
        params: { threadId: "recovered-container" },
      });
      expect(resultFor(harness.output.messages, 5)).toEqual({});
      expect(harness.state.threads().find((thread) => thread.threadId === "recovered-container"))
        .toMatchObject({ archived: true, executionMode: "container", machineId: "old-container-machine" });
      expect(harness.containerFactory.transports).toHaveLength(0);
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });

  test("retains topology notifications internally when the client opts out", async () => {
    const harness = createHarness();
    try {
      await initialize(harness, { experimentalApi: true, optOutNotificationMethods: ["thread/started"] });
      const threadId = await startThread(harness, PROJECT_A, "container", 2);
      expect(harness.output.messages.some((message) => (
        "method" in message && message.method === "thread/started"
      ))).toBe(false);

      await harness.aggregator.handle({ method: "thread/list", id: 3, params: { cwd: PROJECT_A } });
      expect(resultFor(harness.output.messages, 3)).toMatchObject({ data: [{ id: threadId }] });
      const initializeRequest = requestFor(harness.host, "initialize")!;
      expect(initializeRequest.params).toMatchObject({
        capabilities: { optOutNotificationMethods: [] },
      });
    } finally {
      await harness.aggregator.close();
      harness.state.close();
    }
  });
});

type ProjectSeed = { cwd: string; cloneUrl: string | null };

function createHarness(
  projects: ProjectSeed[] | undefined = [
    { cwd: PROJECT_A, cloneUrl: "https://example.test/project-a.git" },
    { cwd: PROJECT_B, cloneUrl: "https://example.test/project-b.git" },
  ],
  threads: StoredThread[] = [],
) {
  const runtime = new FakeRuntime();
  const hostFactory = new FakeHostFactory(runtime);
  const containerFactory = new FakeContainerFactory(runtime);
  const output = new CaptureSink();
  const state = new AggregatorState(":memory:");
  for (const project of projects ?? []) state.saveProject(project);
  for (const thread of threads) state.saveThread(thread);
  const registry = new ProjectRegistry(state);
  const aggregator = new AppServerAggregator({
    hostFactory,
    containerFactory,
    registry,
    state,
    output,
  });
  return {
    runtime,
    hostFactory,
    containerFactory,
    output,
    state,
    registry,
    aggregator,
    get host(): FakeTransport {
      return hostFactory.transports[0]!;
    },
  };
}

async function initialize(
  harness: ReturnType<typeof createHarness>,
  capabilities: Record<string, unknown> = { experimentalApi: true },
): Promise<void> {
  await harness.aggregator.handle({ method: "initialize", id: 1, params: initializeParams(capabilities) });
  expect(resultFor(harness.output.messages, 1)).toMatchObject({ platformFamily: "unix" });
  await harness.aggregator.handle({ method: "initialized" });
}

function initializeParams(capabilities: Record<string, unknown> = { experimentalApi: true }) {
  return {
    clientInfo: { name: "test", title: "Test", version: "0.1.0" },
    capabilities,
  };
}

async function startThread(
  harness: ReturnType<typeof createHarness>,
  cwd: string,
  mode: "host" | "container",
  id: RpcId,
): Promise<string> {
  await harness.aggregator.handle({
    method: "thread/start",
    id,
    params: { cwd, skizzlesExecutionMode: mode },
  });
  const result = resultFor(harness.output.messages, id) as { thread: { id: string } };
  return result.thread.id;
}

class FakeHostFactory implements HostBackendFactory {
  readonly transports: FakeTransport[] = [];
  createFailures = 0;

  constructor(private readonly runtime: FakeRuntime) {}

  async create(): Promise<BackendTransport> {
    if (this.createFailures > 0) {
      this.createFailures--;
      throw new Error("fake host provisioning failure");
    }
    const transport = new FakeTransport("host", this.transports.length, this.runtime);
    this.transports.push(transport);
    return transport;
  }
}

class FakeContainerFactory implements BackendFactory {
  readonly transports: FakeTransport[] = [];
  readonly projects: RegisteredProject[] = [];
  createFailures = 0;

  constructor(private readonly runtime: FakeRuntime) {}

  async create(project: RegisteredProject): Promise<BackendTransport> {
    if (this.createFailures > 0) {
      this.createFailures--;
      throw new Error("fake container provisioning failure");
    }
    this.projects.push(project);
    const transport = new FakeTransport("container", this.transports.length, this.runtime);
    this.transports.push(transport);
    return transport;
  }
}

class FakeRuntime {
  hostModels = ["codex", "grok"];
  containerModels = ["codex", "grok"];
  modelPageSize = Number.POSITIVE_INFINITY;
  private threadSequence = 0;
  private readonly snapshots = new Map<string, Record<string, unknown> & { id: string }>();

  async handle(transport: FakeTransport, message: RpcMessage): Promise<void> {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "initialize") {
      transport.initialized = true;
      transport.emit({
        id: message.id,
        result: {
          userAgent: "fake-codex/0.149.1",
          codexHome: transport.kind === "host" ? "/host-codex-home" : "/codex-home",
          platformFamily: "unix",
          platformOs: transport.kind === "host" ? "macos" : "linux",
        },
      });
      transport.emit({ method: "configWarning", params: { summary: `${transport.kind} warning`, details: null } });
      return;
    }
    if (!transport.initialized) {
      transport.emit({ id: message.id, error: { code: -32000, message: "Not initialized" } });
      return;
    }
    if (message.method === "model/list") {
      const models = transport.kind === "host" ? this.hostModels : this.containerModels;
      const cursor = record(message.params).cursor;
      const offset = typeof cursor === "string" && cursor.startsWith("model-page:")
        ? Number.parseInt(cursor.slice("model-page:".length), 10)
        : 0;
      const pageSize = Math.min(this.modelPageSize, models.length || 1);
      const page = models.slice(offset, offset + pageSize);
      const nextOffset = offset + page.length;
      transport.emit({
        id: message.id,
        result: {
          data: page.map((id) => ({ id })),
          nextCursor: nextOffset < models.length ? `model-page:${nextOffset}` : null,
        },
      });
      return;
    }
    if (message.method === "thread/start") {
      const params = record(message.params);
      const id = `${transport.kind}-thread-${++this.threadSequence}`;
      const thread = snapshot(id, String(params.cwd ?? ""));
      this.snapshots.set(id, thread);
      transport.emit({ id: message.id, result: { thread } });
      transport.emit({ method: "thread/started", params: { thread } });
      return;
    }
    if (message.method === "thread/fork") {
      const params = record(message.params);
      const parentId = String(params.threadId);
      const parent = this.snapshots.get(parentId) ?? snapshot(parentId, transport.workspace ?? PROJECT_A);
      const id = `${transport.kind}-thread-${++this.threadSequence}`;
      const thread = { ...snapshot(id, String(parent.cwd ?? PROJECT_A)), forkedFromId: parentId, parentThreadId: parentId };
      this.snapshots.set(id, thread);
      transport.emit({ id: message.id, result: { thread } });
      transport.emit({ method: "thread/started", params: { thread } });
      return;
    }
    if (message.method === "thread/read" || message.method === "thread/resume") {
      const threadId = String(record(message.params).threadId);
      const existing = this.snapshots.get(threadId) ?? snapshot(threadId, PROJECT_A);
      const thread = { ...existing, turns: message.method === "thread/read" ? [] : undefined };
      this.snapshots.set(threadId, thread);
      transport.emit({ id: message.id, result: { thread } });
      return;
    }
    if (message.method === "thread/archive" || message.method === "thread/delete") {
      const threadId = String(record(message.params).threadId);
      transport.emit({
        id: message.id,
        error: { code: -32600, message: `no rollout found for thread id ${threadId}` },
      });
      return;
    }
    if (message.method === "turn/start") {
      transport.emit({ id: message.id, result: { turn: { id: `turn-${this.threadSequence}` } } });
      return;
    }
    transport.emit({ id: message.id, result: { backend: transport.kind, params: message.params } });
  }
}

class FakeTransport implements BackendTransport {
  readonly machineId: string;
  readonly containerId: string | undefined;
  readonly workspace: string | undefined;
  readonly disposable: boolean;
  readonly ready = Promise.resolve();
  readonly stdout: ReadableStream<Uint8Array>;
  readonly writes: RpcMessage[] = [];
  destroyed = false;
  destroyCalls = 0;
  destroyFailures = 0;
  initialized = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  constructor(
    readonly kind: "host" | "container",
    index: number,
    private readonly runtime: FakeRuntime,
  ) {
    this.machineId = kind === "host" ? "host" : `container-machine-${index}`;
    this.containerId = kind === "container" ? `container-${index}` : undefined;
    this.workspace = kind === "container" ? CONTAINER_WORKSPACE : undefined;
    this.disposable = kind === "container";
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller; },
    });
  }

  async write(line: string): Promise<void> {
    const message = JSON.parse(line) as RpcMessage;
    this.writes.push(structuredClone(message));
    await this.runtime.handle(this, message);
  }

  emit(message: RpcMessage): void {
    this.controller.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }

  response(id: RpcId): RpcMessage | undefined {
    return this.writes.find((message) => !("method" in message) && "id" in message && message.id === id);
  }

  async destroy(): Promise<void> {
    this.destroyCalls++;
    if (this.destroyFailures > 0) {
      this.destroyFailures--;
      throw new Error("fake destroy failure");
    }
    if (this.destroyed) return;
    this.destroyed = true;
    this.controller.close();
  }
}

class CaptureSink implements MessageSink {
  readonly messages: RpcMessage[] = [];

  async send(message: RpcMessage): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}

function snapshot(id: string, cwd: string) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: `Preview for ${id}`,
    modelProvider: "fake",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    cwd,
    source: "vscode",
    turns: [],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requestFor(
  transport: FakeTransport,
  method: string,
  index = 0,
): Extract<RpcMessage, { method: string; id: RpcId }> | undefined {
  return transport.writes.filter((message): message is Extract<RpcMessage, { method: string; id: RpcId }> => (
    "method" in message && "id" in message && message.method === method
  ))[index];
}

function resultFor(messages: RpcMessage[], id: RpcId): unknown {
  const message = messages.find((candidate) => !("method" in candidate) && candidate.id === id);
  if (!message || !("result" in message)) throw new Error(`missing result for ${String(id)}`);
  return message.result;
}

function errorFor(messages: RpcMessage[], id: RpcId): { code: number; message: string } {
  const message = messages.find((candidate) => !("method" in candidate) && candidate.id === id);
  if (!message || !("error" in message)) throw new Error(`missing error for ${String(id)}`);
  return message.error;
}

function isServerRequest(message: RpcMessage): message is Extract<RpcMessage, { method: string; id: RpcId }> {
  return "method" in message && "id" in message && message.method.includes("requestApproval");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("timed out waiting for condition");
}
