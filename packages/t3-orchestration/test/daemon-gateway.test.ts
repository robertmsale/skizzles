import { afterEach, describe, expect, test } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { join, resolve } from "node:path";

const roots: string[] = [];
const processes: Bun.Subprocess[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const process of processes.splice(0)) {
    if (process.exitCode === null) process.kill("SIGTERM");
    await process.exited;
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
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

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP test server has no port");
  return address.port;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function waitForTcp(port: number, expected: boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await new Promise<boolean>((resolveProbe) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
      socket.once("error", () => { socket.destroy(); resolveProbe(false); });
    });
    if (ready === expected) return;
    await Bun.sleep(10);
  }
  throw new Error(`TCP gateway readiness did not become ${expected}: ${port}`);
}

function start(root: string, localSocket: string, httpPort: number): Bun.Subprocess {
  const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/daemon.ts")], {
    env: {
      ...Bun.env,
      HOME: root,
      T3_HOME: join(root, "t3-home"),
      T3_ORCHESTRATION_SOCKET: localSocket,
      T3_ORCHESTRATION_HTTP_PORT: String(httpPort),
      T3_ORCHESTRATION_TAILSCALE_USERS: "owner@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(process);
  return process;
}

describe("daemon Tailscale gateway lifecycle", () => {
  test("binds the remote gateway on loopback and preserves the restricted local socket", async () => {
    const root = `/tmp/t3-daemon-gateway-${crypto.randomUUID()}`;
    roots.push(root);
    const localSocket = join(root, "local/daemon.sock");
    const httpPort = await availablePort();
    const process = start(root, localSocket, httpPort);
    await Promise.all([waitForRestrictedSocket(localSocket), waitForTcp(httpPort, true)]);

    expect((await stat(localSocket)).mode & 0o777).toBe(0o600);
    const response = await fetch(`http://127.0.0.1:${httpPort}/missing`);
    expect(response.status).toBe(404);

    process.kill("SIGTERM");
    expect(await process.exited).toBe(0);
    await expect(stat(localSocket)).rejects.toThrow();
    await waitForTcp(httpPort, false);
  });

  test("fails startup and cleans the local socket when the loopback port is occupied", async () => {
    const root = `/tmp/t3-daemon-gateway-${crypto.randomUUID()}`;
    roots.push(root);
    const localSocket = join(root, "local/daemon.sock");
    const occupied = createServer();
    servers.push(occupied);
    const httpPort = await listen(occupied);
    const process = start(root, localSocket, httpPort);

    expect(await process.exited).not.toBe(0);
    expect(await new Response(process.stderr).text()).toContain("EADDRINUSE");
    await expect(stat(localSocket)).rejects.toThrow();
    await waitForTcp(httpPort, true);
  });
});
