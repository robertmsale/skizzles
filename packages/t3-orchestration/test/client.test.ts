import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

let server: Server | undefined;
let root: string | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  server = undefined;
  root = undefined;
});

describe("daemon client", () => {
  test("extends the client deadline beyond a requested task wait", async () => {
    const { daemonResponseTimeoutMs } = await import("../src/client.ts");
    expect(daemonResponseTimeoutMs({ op: "tasks.wait", timeoutMs: 3_600_000 })).toBe(3_630_000);
    expect(daemonResponseTimeoutMs({ op: "projects.list" })).toBe(240_000);
  });

  test("exchanges a newline-delimited command", async () => {
    root = await mkdtemp("/tmp/t3-client-");
    const socketPath = join(root, "daemon.sock");
    const { daemonRequest } = await import("../src/client.ts");
    server = createServer((socket) => socket.once("data", (chunk) => {
      expect(JSON.parse(chunk.toString())).toEqual({ op: "projects.list" });
      socket.write('{"ok":true,"result":{"projects":[');
      setTimeout(() => socket.end("]}}\n"), 5);
    }));
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    expect(await daemonRequest({ op: "projects.list" }, socketPath)).toEqual({ ok: true, result: { projects: [] } });
  });

  test("explains how to recover when the service is unavailable", async () => {
    root = await mkdtemp("/tmp/t3-client-");
    const { daemonRequest } = await import("../src/client.ts");
    await expect(daemonRequest({ op: "projects.list" }, join(root, "missing.sock"))).rejects.toThrow("install and start its LaunchAgent");
  });

  test("rejects a daemon that closes before a newline-delimited response", async () => {
    root = await mkdtemp("/tmp/t3-client-");
    const socketPath = join(root, "daemon.sock");
    const { daemonRequest } = await import("../src/client.ts");
    server = createServer((socket) => socket.once("data", () => socket.end('{"ok":true')));
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    await expect(daemonRequest({ op: "projects.list" }, socketPath)).rejects.toThrow("closed without a complete response");
  });

  test("honors an explicit bounded response timeout", async () => {
    root = await mkdtemp("/tmp/t3-client-");
    const socketPath = join(root, "daemon.sock");
    const { daemonRequest } = await import("../src/client.ts");
    server = createServer((socket) => socket.once("data", () => undefined));
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    await expect(daemonRequest({ op: "projects.list" }, socketPath, 5)).rejects.toThrow("5 milliseconds");
  });
});
