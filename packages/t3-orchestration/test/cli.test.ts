import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

let server: Server | undefined;
let root: string | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
  if (root) await rm(root, { recursive: true, force: true });
  server = undefined;
  root = undefined;
});

async function captureCli(args: string[]): Promise<Record<string, unknown>> {
  root = await mkdtemp("/tmp/t3-cli-");
  const socketPath = join(root, "daemon.sock");
  let resolvePayload!: (payload: Record<string, unknown>) => void;
  const payload = new Promise<Record<string, unknown>>((resolveValue) => { resolvePayload = resolveValue; });
  server = createServer((socket) => socket.once("data", (chunk) => {
    resolvePayload(JSON.parse(chunk.toString()) as Record<string, unknown>);
    socket.end('{"ok":true,"result":{"sequence":1}}\n');
  }));
  await new Promise<void>((resolveListen) => server!.listen(socketPath, resolveListen));
  const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...Bun.env, T3_ORCHESTRATION_SOCKET: socketPath, CODEX_THREAD_ID: "desktop-root" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await process.exited).toBe(0);
  return payload;
}

describe("cross-project collaboration CLI", () => {
  test("prints bounded machine-readable help without a daemon", async () => {
    const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/cli.ts"), "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    const help = JSON.parse(stdout) as { help: string };
    expect(help.help).toContain("t3ctl tasks create");
    expect(help.help).toContain("t3ctl tasks approvals");
    expect(help.help).toContain("t3ctl tasks approve ID [REQUEST_ID]");
    expect(help.help).toContain("t3ctl tasks deny ID [REQUEST_ID] [--reason TEXT]");
    expect(help.help).toContain("t3ctl worktrees clean-settled [--dry-run] [--config PATH]");
    expect(help.help).toContain("t3ctl tasks wait ID [ID ...] [--timeout-ms 0..58000] [--after ID=CURSOR]");
    expect(stderr).toBe("");
  });

  test("message delivery does not require a T3-mapped caller", async () => {
    expect(await captureCli(["tasks", "send", "target", "--message", "hello"])).toEqual({
      op: "tasks.send",
      threadId: "target",
      message: "hello",
    });
  });

  test("bounded history does not require a T3-mapped caller", async () => {
    expect(await captureCli(["tasks", "history", "target", "--turns", "4"])).toEqual({
      op: "tasks.history",
      threadId: "target",
      turns: 4,
    });
  });

  test("lists tasks with bounded lifecycle filters", async () => {
    expect(await captureCli(["tasks", "list", "--project", "project", "--limit", "25", "--include-settled"])).toEqual({
      op: "tasks.list",
      projectId: "project",
      limit: 25,
      includeSettled: true,
      includeArchived: false,
    });
  });

  test("waits on up to eight tasks with repeatable cursors", async () => {
    expect(await captureCli(["tasks", "wait", "one", "two", "--timeout-ms", "0", "--after", "one=abc", "--after", "two=def"])).toEqual({
      op: "tasks.wait",
      threadIds: ["one", "two"],
      timeoutMs: 0,
      after: { one: "abc", two: "def" },
    });
  });

  test("clamps tasks.wait above the 60s client ceiling and preserves a bounded wait", async () => {
    expect(await captureCli(["tasks", "wait", "one", "--timeout-ms", "58000"])).toEqual({
      op: "tasks.wait",
      threadIds: ["one"],
      timeoutMs: 58_000,
      after: {},
    });
    expect(await captureCli(["tasks", "wait", "one", "--timeout-ms", "60000"])).toEqual({
      op: "tasks.wait",
      threadIds: ["one"],
      timeoutMs: 58_000,
      after: {},
    });
    expect(await captureCli(["tasks", "wait", "one", "--timeout-ms", "3600000"])).toEqual({
      op: "tasks.wait",
      threadIds: ["one"],
      timeoutMs: 58_000,
      after: {},
    });
  });

  test("exits a held tasks.wait within the injected client ceiling", async () => {
    root = await mkdtemp("/tmp/t3-cli-");
    const socketPath = join(root, "daemon.sock");
    let received: Record<string, unknown> | undefined;
    server = createServer((socket) => socket.once("data", (chunk) => {
      received = JSON.parse(chunk.toString()) as Record<string, unknown>;
    }));
    await new Promise<void>((resolveListen) => server!.listen(socketPath, resolveListen));
    const started = Date.now();
    const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/cli.ts"), "tasks", "wait", "one", "--timeout-ms", "3600000"], {
      env: { ...Bun.env, T3_ORCHESTRATION_SOCKET: socketPath, T3_ORCHESTRATION_CLIENT_DEADLINE_MS: "80" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("t3ctl tasks.wait timed out after 80ms\n");
    expect(received).toEqual({
      op: "tasks.wait",
      threadIds: ["one"],
      timeoutMs: 0,
      after: {},
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("exits promptly when a local daemon never responds", async () => {
    root = await mkdtemp("/tmp/t3-cli-");
    const socketPath = join(root, "daemon.sock");
    server = createServer((socket) => socket.once("data", () => undefined));
    await new Promise<void>((resolveListen) => server!.listen(socketPath, resolveListen));
    const started = Date.now();
    const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/cli.ts"), "tasks", "list"], {
      env: { ...Bun.env, T3_ORCHESTRATION_SOCKET: socketPath, T3_ORCHESTRATION_CLIENT_DEADLINE_MS: "80" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("t3ctl tasks.list timed out after 80ms\n");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("exits promptly when pairing never responds", async () => {
    root = await mkdtemp("/tmp/t3-cli-");
    const origin = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => undefined);
      },
    });
    try {
      await mkdir(join(root, "userdata"), { recursive: true });
      await writeFile(join(root, "userdata/server-runtime.json"), `${JSON.stringify({ origin: String(origin.url).replace(/\/$/, "") })}\n`);
      const started = Date.now();
      const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/cli.ts"), "auth", "configure"], {
        env: { ...Bun.env, T3_HOME: root, T3_ORCHESTRATION_CLIENT_DEADLINE_MS: "80" },
        stdin: new Blob(["pairing-token\n"]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe("t3ctl auth.configure timed out after 80ms\n");
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      origin.stop(true);
    }
  });

  test("prints a daemon error without waiting for the client deadline", async () => {
    root = await mkdtemp("/tmp/t3-cli-");
    const socketPath = join(root, "daemon.sock");
    server = createServer((socket) => socket.once("data", () => {
      socket.end('{"ok":false,"error":"T3 task not found: missing"}\n');
    }));
    await new Promise<void>((resolveListen) => server!.listen(socketPath, resolveListen));
    const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/cli.ts"), "tasks", "status", "missing"], {
      env: { ...Bun.env, T3_ORCHESTRATION_SOCKET: socketPath, T3_ORCHESTRATION_CLIENT_DEADLINE_MS: "250" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ error: "T3 task not found: missing" });
    expect(stderr).toBe("");
  });

  test("supports read alias and management commands", async () => {
    expect(await captureCli(["tasks", "read", "target", "--turns", "2"])).toEqual({
      op: "tasks.history",
      threadId: "target",
      turns: 2,
    });
    expect(await captureCli(["tasks", "title", "target", "--title", "New title"])).toEqual({
      op: "tasks.title",
      threadId: "target",
      title: "New title",
    });
  });

  test("parses coordinator approval list and resolve commands", async () => {
    expect(await captureCli(["tasks", "approvals", "--project", "project"])).toEqual({
      op: "tasks.approvals",
      projectId: "project",
    });
    expect(await captureCli(["tasks", "approve", "target"])).toEqual({
      op: "tasks.approve",
      threadId: "target",
    });
    expect(await captureCli(["tasks", "approve", "target", "req-1"])).toEqual({
      op: "tasks.approve",
      threadId: "target",
      requestId: "req-1",
    });
    expect(await captureCli(["tasks", "deny", "target", "req-1", "--reason", "too broad"])).toEqual({
      op: "tasks.deny",
      threadId: "target",
      requestId: "req-1",
      reason: "too broad",
    });
  });

  test("selects a provider only when creating a task", async () => {
    expect(await captureCli(["tasks", "create", "--title", "Grok task", "--message", "work", "--provider", "grok"])).toEqual({
      op: "tasks.create",
      callerThreadId: "desktop-root",
      projectId: "current",
      title: "Grok task",
      message: "work",
      provider: "grok",
    });
    expect(await captureCli(["tasks", "create", "--title", "Cursor task", "--message", "work", "--provider", "cursor"])).toEqual({
      op: "tasks.create",
      callerThreadId: "desktop-root",
      projectId: "current",
      title: "Cursor task",
      message: "work",
      provider: "cursor",
    });
  });

  test("clean-settled asks the existing daemon for cleanable tasks instead of a second daemon", async () => {
    root = await mkdtemp("/tmp/t3-cli-");
    const socketPath = join(root, "daemon.sock");
    let resolvePayload!: (payload: Record<string, unknown>) => void;
    const payload = new Promise<Record<string, unknown>>((resolveValue) => { resolvePayload = resolveValue; });
    server = createServer((socket) => socket.once("data", (chunk) => {
      resolvePayload(JSON.parse(chunk.toString()) as Record<string, unknown>);
      socket.end('{"ok":true,"result":{"tasks":[],"count":0,"truncated":false,"occupied":[]}}\n');
    }));
    await new Promise<void>((resolveListen) => server!.listen(socketPath, resolveListen));
    const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/cli.ts"), "worktrees", "clean-settled", "--dry-run"], {
      env: { ...Bun.env, T3_ORCHESTRATION_SOCKET: socketPath, HOME: root, T3_HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr, request] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      payload,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(request).toEqual({ op: "worktrees.listCleanable" });
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, dryRun: true, configPath: null, scanned: 0, cleaned: 0, bytesFreed: 0 });
  });

  test("refuses remote mode so it cannot clean local disks from a host snapshot", async () => {
    root = await mkdtemp("/tmp/t3-cli-");
    const configDir = join(root, ".config/t3-orchestration");
    await Bun.write(join(configDir, "client.json"), `${JSON.stringify({ url: "https://host.example.ts.net" })}\n`);
    const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/cli.ts"), "worktrees", "clean-settled", "--dry-run"], {
      env: { ...Bun.env, HOME: root, T3_HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("refuses remote t3ctl mode");
  });

  test("fails closed when an explicit remote config selector is missing", async () => {
    root = await mkdtemp("/tmp/t3-cli-");
    const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/cli.ts"), "worktrees", "clean-settled", "--dry-run"], {
      env: {
        ...Bun.env,
        HOME: root,
        T3_HOME: root,
        T3_ORCHESTRATION_REMOTE_CONFIG: join(root, "missing-remote.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("explicit remote orchestration config is unavailable");
  });

  test("refuses a padded explicit remote-config selector through both reaper entrypoints", async () => {
    root = await mkdtemp("/tmp/t3-cli-");
    await Bun.write(join(root, "remote.json"), `${JSON.stringify({ url: "https://review-host.example.ts.net" })}\n`);
    for (const command of [
      ["bun", resolve(import.meta.dir, "../src/cli.ts"), "worktrees", "clean-settled", "--dry-run"],
      ["bun", resolve(import.meta.dir, "../src/worktree-reaper-cli.ts"), "--dry-run"],
    ]) {
      const process = Bun.spawn(command, {
        cwd: root,
        env: {
          ...Bun.env,
          HOME: root,
          T3_HOME: root,
          T3_ORCHESTRATION_REMOTE_CONFIG: " remote.json ",
          T3_ORCHESTRATION_REMOTE_URL: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("refuses remote t3ctl mode");
    }
  });
});
