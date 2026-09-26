import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = {
  id: "large", projectId: "project", title: "Large thread",
  modelSelection: { instanceId: "codex", model: "saved-model", options: [{ id: "reasoningEffort", value: "high" }] },
  runtimeMode: "full-access", interactionMode: "plan", worktreePath: null, branch: null,
  session: { status: "ready" }, latestUserMessageAt: null,
  hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
};

// Run the real client in an isolated process so fake credentials/config never
// replace another test's modules or touch the host Keychain/runtime files.
test("large histories do not block send/status; reads remain bounded", async () => {
  const home = await mkdtemp(join(tmpdir(), "t3-large-thread-"));
  let archived = false;
  let activityBytes = 600_000;
  let detailRequests = 0;
  let snapshotRequests = 0;
  let archivedFrameBytes = 0;
  let deleted = false;
  let ticketStatus = 200;
  let lastQuery = "";
  const commands: any[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request, server) => {
      const url = new URL(request.url);
      if (url.pathname === "/ws" && server.upgrade(request)) return;
      expect(request.headers.get("authorization")).toBe("Bearer fake-test-token");
      const thread = { ...target, archivedAt: archived ? "2026-09-26T00:00:00Z" : null };
      const model = { snapshotSequence: 1, projects: [{ id: "project", title: "Project", workspaceRoot: "/fixture" }], threads: [thread], updatedAt: "now" };
      if (url.pathname === "/api/orchestration/shell") return Response.json({ ...model, threads: archived || deleted ? [] : [thread] });
      if (url.pathname === "/api/orchestration/snapshot") {
        snapshotRequests++;
        return Response.json({ ...model, threads: [{ ...thread, messages: [], activities: [], proposedPlans: [{ planMarkdown: "p".repeat(2_000_001) }] }] });
      }
      if (url.pathname === "/api/orchestration/threads/large") {
        detailRequests++;
        lastQuery = url.search;
        return Response.json({
          snapshotSequence: 1,
          thread: { ...thread, messages: [{ role: "assistant", text: "x".repeat(20_000), turnId: "turn", createdAt: "now" }], activities: [{ payload: "a".repeat(activityBytes) }] },
          page: { beforeCursor: "older", hasMore: true, snapshotSequence: 1 },
        });
      }
      if (url.pathname === "/api/auth/websocket-ticket") {
        return ticketStatus === 200
          ? Response.json({ ticket: "fake-ticket" })
          : new Response("private-auth-error fake-test-token fake-ticket", { status: ticketStatus });
      }
      if (url.pathname === "/api/orchestration/dispatch") {
        commands.push(await request.json());
        return Response.json({ sequence: 2 });
      }
      return new Response("Unexpected route", { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(String(message));
        if (frame.tag === "orchestration.getArchivedShellSnapshot") {
          const reply = JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: {
            snapshotSequence: 1, updatedAt: "now",
            projects: [{ id: "project", title: "Project", workspaceRoot: "/fixture" }],
            threads: archived && !deleted ? [{ ...target, archivedAt: "2026-09-26T00:00:00Z" }] : [],
          } } });
          // JSON permits trailing whitespace: pad the complete wire frame to an
          // exact byte boundary without flooding projected status output.
          socket.send(reply + " ".repeat(Math.max(0, archivedFrameBytes - Buffer.byteLength(reply))));
          return;
        }
        expect(frame.tag).toBe("server.getConfig");
        socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: {
          providers: [{ instanceId: "codex", driver: "codex", enabled: true, installed: true, status: "ready", models: [{ slug: "saved-model" }] }],
        } } }));
      },
    },
  });
  const run = async (expression: string) => {
    const configPath = new URL("../src/config.ts", import.meta.url).pathname;
    const clientPath = new URL("../src/t3.ts", import.meta.url).pathname;
    const script = `
      import { mock } from "bun:test";
      const config = await import(${JSON.stringify(configPath)});
      mock.module(${JSON.stringify(configPath)}, () => ({ ...config, origin: async () => ${JSON.stringify(server.url.origin)}, token: async () => "fake-test-token" }));
      const client = await import(${JSON.stringify(clientPath)});
      try { console.log(JSON.stringify(await (${expression}))); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: { ...process.env, T3_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).not.toContain("fake-test-token");
    expect(stderr).not.toContain("fake-ticket");
    return { stdout, stderr, code };
  };
  try {
    for (const isArchived of [false, true]) {
      archived = isArchived;
      const status = await run('client.taskStatus("large")');
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout).id).toBe("large");
      const send = await run('client.sendTask("large", "continue")');
      expect(send.code).toBe(0);
      expect(JSON.parse(send.stdout)).toEqual({ sequence: 2 });
    }
    expect(detailRequests).toBe(0);
    expect(snapshotRequests).toBe(0);
    for (const command of commands) {
      expect(command.modelSelection).toEqual(target.modelSelection);
      expect(command.runtimeMode).toBe(target.runtimeMode);
      expect(command.interactionMode).toBe(target.interactionMode);
    }
    expect(commands).toHaveLength(2);
    const read = await run('client.taskHistory("large", 1, "earlier cursor")');
    expect(read.code).toBe(0);
    const history = JSON.parse(read.stdout);
    expect(history.messages[0].text.length).toBe(8_000);
    expect(history.messages[0].textTruncated).toBe(true);
    expect(history.page.beforeCursor).toBe("older");
    expect(read.stdout).not.toContain("activities");
    expect(lastQuery).toBe("?turnLimit=1&beforeCursor=earlier+cursor");
    // Activity-dependent approval snapshots retain their original ceiling.
    expect((await run('client.threadSnapshot("large", 1)')).stderr).toContain("exceeded 512000 bytes");
    activityBytes = 8_000_001;
    for (const turns of [1, 3]) {
      const oversized = await run(`client.taskHistory("large", ${turns})`);
      expect(oversized.code).toBe(1);
      expect(oversized.stderr).toContain("8000000-byte limit");
      expect(oversized.stderr).toContain(turns === 1 ? "single turn is too large" : "--turns 1");
      expect(oversized.stderr).toContain("Tasks send and tasks status remain available");
      expect(oversized.stderr.length).toBeLessThan(500);
    }
    expect((await run('client.taskStatus("missing")')).stderr).toContain("was not found");
    expect((await run('client.taskStatus("large")')).code).toBe(0);
    expect((await run('client.sendTask("large", "still reachable")')).code).toBe(0);
    expect(snapshotRequests).toBe(0);
    archivedFrameBytes = 16_000_000;
    expect((await run('client.taskStatus("large")')).code).toBe(0);
    expect((await run('client.sendTask("large", "at the boundary")')).code).toBe(0);
    archivedFrameBytes++;
    const tooMuchMetadata = await run('client.taskStatus("large")');
    expect(tooMuchMetadata.code).toBe(1);
    expect(tooMuchMetadata.stderr).toContain("archived-thread list exceeded 16000000 bytes");
    expect(tooMuchMetadata.stderr).toContain("ARCHIVED_SHELL_BYTE_LIMIT");
    expect(tooMuchMetadata.stderr).toContain("rebuild");
    archivedFrameBytes = 0;
    // T3 omits deleted threads from both shells, rather than returning deletedAt.
    deleted = true;
    const deletedStatus = await run('client.taskStatus("large")');
    expect(deletedStatus.code).toBe(1);
    expect(deletedStatus.stderr.trim()).toBe("T3 thread 'large' was not found");
    deleted = false;
    for (const status of [401, 503]) {
      ticketStatus = status;
      const ticketFailure = await run('client.taskStatus("large")');
      expect(ticketFailure.code).toBe(1);
      expect(ticketFailure.stderr.trim()).toBe(`T3 WebSocket ticket request failed (HTTP ${status})`);
      expect(ticketFailure.stderr).not.toContain("private-auth-error");
    }
  } finally {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
