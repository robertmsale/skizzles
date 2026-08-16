#!/usr/bin/env bun
import { connect, createServer } from "node:net";
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
  process.exit(1);
});

const gateway = TAILSCALE_ALLOWED_USERS.length > 0
  ? createTailscaleGateway(TAILSCALE_ALLOWED_USERS, dispatch)
  : undefined;
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
      process.exit(1);
    });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(SOCKET_PATH).catch(() => undefined);
    throw error;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    const cleanup = () => unlink(SOCKET_PATH).catch(() => undefined).finally(() => process.exit(0));
    if (gateway) gateway.close(() => server.close(cleanup));
    else server.close(cleanup);
  });
}
