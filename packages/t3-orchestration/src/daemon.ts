#!/usr/bin/env bun
import { connect, createServer, type Server } from "node:net";
import { chmodSync } from "node:fs";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { SOCKET_PATH, TAILSCALE_ALLOWED_USERS, TAILSCALE_GATEWAY_PORT } from "./config.ts";
import * as t3 from "./t3.ts";
import { resolveCallerThread } from "./identity.ts";
import { executeCommand } from "./commands.ts";
import { createTailscaleGateway } from "./http-gateway.ts";

const commandDependencies = {
  resolveCallerThread,
  importProjects: t3.importProjects,
  projectList: t3.projectList,
  taskList: t3.taskList,
  taskWait: t3.taskWait,
  createTask: t3.createTask,
  sendTask: t3.sendTask,
  taskStatus: t3.taskStatus,
  taskHistory: t3.taskHistory,
  renameTask: t3.renameTask,
  archiveTask: t3.archiveTask,
  pinTask: t3.pinTask,
  settleTask: t3.settleTask,
  interruptTask: t3.interruptTask,
  listTaskApprovals: t3.listTaskApprovals,
  resolveTaskApproval: t3.resolveTaskApproval,
  listCleanableWorktrees: t3.listCleanableWorktrees,
};

const dispatch = (command: { op: string; [key: string]: unknown }) => executeCommand(command, commandDependencies);

const server = createServer((socket) => {
  let buffer = "";
  let work = Promise.resolve();
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    if (buffer.length > 1_048_576) { socket.destroy(new Error("request exceeds 1 MiB")); return; }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n");
      work = work.then(async () => { try {
        const command = JSON.parse(line) as { op: string; [key: string]: unknown };
        const result = await dispatch(command);
        socket.write(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) { socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`); } });
    }
  });
  socket.on("error", () => undefined);
  socket.on("close", () => { buffer = ""; });
});
const gateway = TAILSCALE_ALLOWED_USERS.length > 0
  ? createTailscaleGateway(TAILSCALE_ALLOWED_USERS, dispatch)
  : undefined;
let shuttingDown = false;

const closeServer = (listener: Server | undefined): Promise<void> => {
  if (!listener?.listening) return Promise.resolve();
  return new Promise((resolve) => listener.close(() => resolve()));
};

const shutdown = async (exitCode: number): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([closeServer(gateway), closeServer(server)]);
  await unlink(SOCKET_PATH).catch(() => undefined);
  process.exit(exitCode);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(0));
}

process.umask(0o077);
await mkdir(dirname(SOCKET_PATH), { recursive: true, mode: 0o700 });
const prepareSocket = async (path: string, isLive: () => Promise<boolean>) => {
  try {
    const existing = await lstat(path);
    if (!existing.isSocket()) throw new Error(`Refusing to replace non-socket path ${path}`);
    if (await isLive()) throw new Error(`Daemon already running on ${path}`);
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
  }
};
await prepareSocket(SOCKET_PATH, () => new Promise<boolean>((resolve) => {
  const socket = connect(SOCKET_PATH);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => { socket.destroy(); resolve(false); });
}));
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(SOCKET_PATH, () => {
    server.off("error", reject);
    chmodSync(SOCKET_PATH, 0o600);
    console.log(`t3-orchestrationd listening on ${SOCKET_PATH}`);
    resolve();
  });
});
server.on("error", (error) => {
  console.error(`t3-orchestrationd local socket failed: ${error.message}`);
  void shutdown(1);
});

if (gateway) {
  try {
    await new Promise<void>((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(TAILSCALE_GATEWAY_PORT, "127.0.0.1", () => {
        gateway.off("error", reject);
        console.log(`t3-orchestrationd Tailscale gateway listening on 127.0.0.1:${TAILSCALE_GATEWAY_PORT}`);
        resolve();
      });
    });
    gateway.on("error", (error) => {
      console.error(`t3-orchestrationd Tailscale gateway failed: ${error.message}`);
      void shutdown(1);
    });
  } catch (error) {
    await Promise.all([closeServer(gateway), closeServer(server)]);
    await unlink(SOCKET_PATH).catch(() => undefined);
    throw error;
  }
}
