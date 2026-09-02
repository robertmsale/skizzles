#!/usr/bin/env bun
import { connect, type Server } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DATABASE_PATH, HTTP_ALLOWED_PROJECTS, HTTP_HOST, HTTP_PORT, HTTP_TOKEN, ORCHESTRATION_HOME, SOCKET_PATH,
} from "./config.ts";
import { createHttpServer } from "./http-server.ts";
import { createLocalServer } from "./local-server.ts";
import { OmpManager } from "./manager.ts";
import { OrchestrationState } from "./state.ts";

export async function runDaemon(): Promise<void> {
  process.umask(0o077);
  for (const directory of new Set([ORCHESTRATION_HOME, dirname(DATABASE_PATH), dirname(SOCKET_PATH)])) {
    await preparePrivateDirectory(directory);
  }
  const state = new OrchestrationState(DATABASE_PATH);
  const releaseLease = state.acquireDaemonLease();
  const manager = new OmpManager(state);
  const local = createLocalServer(manager);
  const http = HTTP_PORT === undefined ? undefined : createHttpServer(manager, {
    token: HTTP_TOKEN ?? (() => { throw new Error("OMP_ORCHESTRATION_HTTP_TOKEN is required when HTTP ingress is enabled"); })(),
    allowedProjects: HTTP_ALLOWED_PROJECTS,
  });
  let shuttingDown = false;
  const shutdown = async (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.allSettled([manager.stop(), closeServer(http), closeServer(local)]);
    await unlink(SOCKET_PATH).catch(() => undefined);
    releaseLease();
    state.close();
    process.exit(exitCode);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(0));
  try {
    await prepareSocket(SOCKET_PATH);
    await listenUnix(local, SOCKET_PATH);
    await chmod(SOCKET_PATH, 0o600);
    if (http && HTTP_PORT !== undefined) await listenTcp(http, HTTP_PORT, HTTP_HOST);
    console.log(`omp-orchestrationd listening on ${SOCKET_PATH}${HTTP_PORT === undefined ? "" : ` and http://${HTTP_HOST}:${HTTP_PORT}`}`);
    await manager.start();
  } catch (error) {
    await Promise.allSettled([manager.stop(), closeServer(http), closeServer(local)]);
    await unlink(SOCKET_PATH).catch(() => undefined);
    releaseLease();
    state.close();
    throw error;
  }
}

async function prepareSocket(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const metadata = await lstat(path);
    if (!metadata.isSocket()) throw new Error(`refusing to replace non-socket path ${path}`);
    if (await socketIsLive(path)) throw new Error(`daemon already running on ${path}`);
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function preparePrivateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { recursive: true, mode: 0o700 }); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`private runtime path is not a directory: ${path}`);
  if (uid !== undefined && metadata.uid !== uid) throw new Error(`private runtime path is not owned by the current user: ${path}`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`private runtime path must not grant group or world access: ${path}`);
}

function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolveLive) => {
    const socket = connect(path);
    socket.once("connect", () => { socket.destroy(); resolveLive(true); });
    socket.once("error", () => { socket.destroy(); resolveLive(false); });
  });
}

function listenUnix(server: Server, path: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolveListen(); });
  });
}

function listenTcp(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolveListen(); });
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
    const closable = server as Server & { closeActiveConnections?: () => void; closeAllConnections?: () => void };
    closable.closeActiveConnections?.();
    closable.closeAllConnections?.();
  });
}

if (import.meta.main) {
  await runDaemon().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
