import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  CLIENT_DEADLINE_MS,
  WAIT_RESPONSE_BUFFER_MS,
  clampWaitTimeoutMs,
  daemonRequest,
  maxWaitTimeoutMs,
  resolveClientDeadlineMs,
} from "../src/client.ts";

let server: Server | undefined;
let root: string | undefined;
const originalDeadlineEnv = process.env.T3_ORCHESTRATION_CLIENT_DEADLINE_MS;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  server = undefined;
  root = undefined;
  if (originalDeadlineEnv === undefined) delete process.env.T3_ORCHESTRATION_CLIENT_DEADLINE_MS;
  else process.env.T3_ORCHESTRATION_CLIENT_DEADLINE_MS = originalDeadlineEnv;
});

async function listen(handler: (socket: import("node:net").Socket) => void): Promise<string> {
  root = await mkdtemp("/tmp/t3-client-");
  const socketPath = join(root, "daemon.sock");
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  return socketPath;
}

describe("daemon client", () => {
  test("uses a hard 60s client deadline that task wait cannot extend", () => {
    expect(CLIENT_DEADLINE_MS).toBe(60_000);
    expect(WAIT_RESPONSE_BUFFER_MS).toBe(2_000);
    expect(resolveClientDeadlineMs()).toBe(60_000);
    expect(resolveClientDeadlineMs(3_600_000)).toBe(60_000);
    expect(resolveClientDeadlineMs(80)).toBe(80);
    process.env.T3_ORCHESTRATION_CLIENT_DEADLINE_MS = "999999";
    expect(resolveClientDeadlineMs()).toBe(60_000);
    process.env.T3_ORCHESTRATION_CLIENT_DEADLINE_MS = "150";
    expect(resolveClientDeadlineMs()).toBe(150);
    expect(clampWaitTimeoutMs(0)).toBe(0);
    expect(clampWaitTimeoutMs(1_000)).toBe(1_000);
    expect(clampWaitTimeoutMs(60_000)).toBe(58_000);
    expect(clampWaitTimeoutMs(3_600_000)).toBe(58_000);
    expect(maxWaitTimeoutMs()).toBe(58_000);
    expect(maxWaitTimeoutMs(1_000)).toBe(0);
  });

  test("exchanges a newline-delimited command", async () => {
    const socketPath = await listen((socket) => socket.once("data", (chunk) => {
      expect(JSON.parse(chunk.toString())).toEqual({ op: "projects.list" });
      socket.write('{"ok":true,"result":{"projects":[');
      setTimeout(() => socket.end("]}}\n"), 5);
    }));
    expect(await daemonRequest({ op: "projects.list" }, socketPath, 250)).toEqual({ ok: true, result: { projects: [] } });
  });

  test("returns a daemon error before the client deadline", async () => {
    const socketPath = await listen((socket) => socket.once("data", () => {
      socket.end('{"ok":false,"error":"T3 task not found: missing"}\n');
    }));
    expect(await daemonRequest({ op: "tasks.status" }, socketPath, 250)).toEqual({
      ok: false,
      error: "T3 task not found: missing",
    });
  });

  test("explains how to recover when the service is unavailable", async () => {
    root = await mkdtemp("/tmp/t3-client-");
    await expect(daemonRequest({ op: "projects.list" }, join(root, "missing.sock"), 250)).rejects.toThrow(
      "bun run packages/t3-orchestration/scripts/install.ts",
    );
  });

  test("rejects a daemon that closes before a newline-delimited response", async () => {
    const socketPath = await listen((socket) => socket.once("data", () => socket.end('{"ok":true')));
    await expect(daemonRequest({ op: "projects.list" }, socketPath, 250)).rejects.toThrow("closed without a complete response");
  });

  test("aborts a never-responding local socket at the injected deadline", async () => {
    const socketPath = await listen((socket) => socket.once("data", () => undefined));
    const started = Date.now();
    await expect(daemonRequest({ op: "tasks.list" }, socketPath, 80)).rejects.toThrow("t3ctl tasks.list timed out after 80ms");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("clamps a tasks.wait payload before it leaves the client", async () => {
    const socketPath = await listen((socket) => socket.once("data", (chunk) => {
      expect(JSON.parse(chunk.toString())).toEqual({
        op: "tasks.wait",
        threadIds: ["one"],
        timeoutMs: 58_000,
        after: {},
      });
      socket.end('{"ok":true,"result":{"timedOut":true,"ready":[],"tasks":[]}}\n');
    }));
    expect(await daemonRequest({
      op: "tasks.wait",
      threadIds: ["one"],
      timeoutMs: 3_600_000,
      after: {},
    }, socketPath, CLIENT_DEADLINE_MS)).toEqual({
      ok: true,
      result: { timedOut: true, ready: [], tasks: [] },
    });
  });

  test("settles a held tasks.wait at the injected client ceiling", async () => {
    const socketPath = await listen((socket) => socket.once("data", (chunk) => {
      expect(JSON.parse(chunk.toString())).toEqual({
        op: "tasks.wait",
        threadIds: ["one"],
        timeoutMs: 0,
        after: {},
      });
    }));
    const started = Date.now();
    const settled = daemonRequest({
      op: "tasks.wait",
      threadIds: ["one"],
      timeoutMs: 3_600_000,
      after: {},
    }, socketPath, 80).then(() => "resolved" as const, (error) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("t3ctl tasks.wait timed out after 80ms");
      return "rejected" as const;
    });
    expect(await Promise.race([settled, Bun.sleep(1_000).then(() => "pending" as const)])).toBe("rejected");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
