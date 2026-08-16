import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

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
    expect(JSON.parse(stdout)).toEqual({ help: expect.stringContaining("t3ctl tasks create") });
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

  test("selects a provider only when creating a task", async () => {
    expect(await captureCli(["tasks", "create", "--title", "Grok task", "--message", "work", "--provider", "grok"])).toEqual({
      op: "tasks.create",
      callerThreadId: "desktop-root",
      projectId: "current",
      title: "Grok task",
      message: "work",
      provider: "grok",
    });
  });
});
