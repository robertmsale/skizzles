import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const roots: string[] = [];
const processes: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const process of processes.splice(0)) {
    if (process.exitCode === null) process.kill("SIGTERM");
    await process.exited;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForRestrictedSocket(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const status = await stat(path);
      if (status.isSocket() && (status.mode & 0o777) === 0o600) return;
    } catch {}
    await Bun.sleep(10);
  }
  throw new Error(`restricted socket did not become ready: ${path}`);
}

function start(root: string, localSocket: string, httpSocket: string): Bun.Subprocess {
  const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/daemon.ts")], {
    env: {
      ...Bun.env,
      HOME: root,
      T3_HOME: join(root, "t3-home"),
      T3_ORCHESTRATION_SOCKET: localSocket,
      T3_ORCHESTRATION_HTTP_SOCKET: httpSocket,
      T3_ORCHESTRATION_TAILSCALE_USERS: "owner@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(process);
  return process;
}

describe("daemon Tailscale gateway lifecycle", () => {
  test("creates custom socket parents, restricts both sockets, and removes them on shutdown", async () => {
    const root = `/tmp/t3-daemon-gateway-${crypto.randomUUID()}`;
    roots.push(root);
    const localSocket = join(root, "local/daemon.sock");
    const httpSocket = join(root, "remote/nested/gateway.sock");
    const process = start(root, localSocket, httpSocket);
    await Promise.all([waitForRestrictedSocket(localSocket), waitForRestrictedSocket(httpSocket)]);
    expect((await stat(localSocket)).mode & 0o777).toBe(0o600);
    expect((await stat(httpSocket)).mode & 0o777).toBe(0o600);

    process.kill("SIGTERM");
    expect(await process.exited).toBe(0);
    await expect(stat(localSocket)).rejects.toThrow();
    await expect(stat(httpSocket)).rejects.toThrow();
  });

  test("fails startup and cleans the local socket when the gateway cannot bind", async () => {
    const root = `/tmp/t3-daemon-gateway-${crypto.randomUUID()}`;
    roots.push(root);
    const localSocket = join(root, "local/daemon.sock");
    const httpSocket = join(root, "remote/gateway.sock");
    await mkdir(dirname(httpSocket), { recursive: true });
    await writeFile(httpSocket, "not a socket");
    await chmod(httpSocket, 0o600);
    const process = start(root, localSocket, httpSocket);
    expect(await process.exited).not.toBe(0);
    await expect(stat(localSocket)).rejects.toThrow();
    expect((await stat(httpSocket)).isFile()).toBe(true);
  });
});
