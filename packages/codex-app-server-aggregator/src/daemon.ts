import { chmodSync } from "node:fs";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { AppServerAggregator } from "./aggregator.ts";
import type { BackendFactory } from "./backend.ts";
import { AggregatorBridge, type AggregatorClientSession } from "./bridge.ts";
import { readJsonLines, SerialMessageSink } from "./jsonl.ts";
import { ProjectRegistry } from "./projects.ts";
import { errorOutcome, isRequest, response, type RpcMessage } from "./protocol.ts";
import { RestApiServer, type RestServerOptions } from "./rest.ts";
import { AggregatorState, type StoredMachine } from "./state.ts";

export type AggregatorDaemonOptions = {
  socketPath: string;
  state: AggregatorState;
  factory: BackendFactory;
  removeOrphan?: (machine: StoredMachine) => Promise<void>;
  http?: Omit<RestServerOptions, "log">;
  log?: (message: string) => void;
};

export class AggregatorDaemon {
  private readonly server: Server;
  private readonly registry: ProjectRegistry;
  private readonly bridge: AggregatorBridge;
  private readonly aggregator: AppServerAggregator;
  private readonly rest: RestApiServer | undefined;
  private readonly log: (message: string) => void;
  private active: { socket: Socket; session: AggregatorClientSession } | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly serveTasks = new Set<Promise<void>>();
  private restUrl: URL | undefined;
  private started = false;
  private closed = false;
  private ownsSocket = false;

  constructor(private readonly options: AggregatorDaemonOptions) {
    this.registry = new ProjectRegistry(options.state);
    this.log = options.log ?? (() => undefined);
    this.bridge = new AggregatorBridge(this.log);
    this.aggregator = new AppServerAggregator({
      factory: this.options.factory,
      registry: this.registry,
      state: this.options.state,
      output: this.bridge,
      applyClientNotificationOptOuts: false,
      onServerRequestSettled: (id) => this.bridge.settleServerRequest(id),
      log: this.log,
    });
    this.bridge.bind(this.aggregator);
    this.rest = options.http ? new RestApiServer(this.bridge, { ...options.http, log: this.log }) : undefined;
    this.server = createServer((socket) => this.accept(socket));
  }

  get httpUrl(): URL | undefined {
    return this.restUrl;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new Error("daemon is closed");
    this.started = true;
    try {
      await prepareSocketDirectory(dirname(this.options.socketPath));
      await prepareSocket(this.options.socketPath);
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.options.socketPath, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
      this.ownsSocket = true;
      chmodSync(this.options.socketPath, 0o600);
      await this.recoverOrphans();
      this.restUrl = this.rest?.start();
    } catch (error) {
      await closeServer(this.server).catch(() => undefined);
      if (this.ownsSocket) await unlink(this.options.socketPath).catch(() => undefined);
      this.ownsSocket = false;
      this.started = false;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const serverClosed = closeServer(this.server);
    const restClosed = this.rest?.close() ?? Promise.resolve();
    const active = this.active;
    this.active = undefined;
    active?.session.close();
    for (const socket of this.sockets) socket.destroy();
    this.restUrl = undefined;
    await Promise.allSettled([serverClosed, restClosed, ...this.serveTasks]);
    await this.aggregator.close();
    await this.bridge.close();
    if (this.ownsSocket) await unlink(this.options.socketPath).catch(() => undefined);
    this.ownsSocket = false;
    this.options.state.close();
  }

  private accept(socket: Socket): void {
    socket.on("error", () => undefined);
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    if (this.closed) {
      socket.destroy();
      return;
    }
    if (this.active) {
      void rejectBusyClient(socket);
      return;
    }
    const sink = new SerialMessageSink((line) => new Promise<void>((resolve, reject) => {
      socket.write(line, (error) => error ? reject(error) : resolve());
    }));
    const session = this.bridge.attachClient(sink);
    this.active = { socket, session };
    const work = this.serve(socket, session);
    this.serveTasks.add(work);
    work.finally(() => this.serveTasks.delete(work)).catch(() => undefined);
  }

  private async serve(socket: Socket, session: AggregatorClientSession): Promise<void> {
    const active = new Set<Promise<void>>();
    try {
      const stream = Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>;
      for await (const message of readJsonLines(stream)) {
        const work = session.handle(message).catch((error) => {
          this.log(error instanceof Error ? error.stack ?? error.message : String(error));
        }).finally(() => active.delete(work));
        active.add(work);
      }
    } catch (error) {
      this.log(`client connection failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      session.close();
      if (this.active?.socket === socket) this.active = undefined;
      if (!socket.destroyed) socket.end();
      await Promise.allSettled(active);
    }
  }

  private async recoverOrphans(): Promise<void> {
    for (const machine of this.options.state.recoverOrphanedMachines()) {
      if (!this.options.removeOrphan) {
        this.log(`orphaned container requires cleanup: ${machine.containerId}`);
        continue;
      }
      try {
        await this.options.removeOrphan(machine);
        this.options.state.markMachine(machine.machineId, "removed");
      } catch (error) {
        this.log(`failed to remove orphaned container ${machine.containerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export async function connectStdio(socketPath: string): Promise<number> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.on("error", () => undefined);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout, { end: false });
  await new Promise<void>((resolve) => socket.once("close", resolve));
  return 0;
}

async function rejectBusyClient(socket: Socket): Promise<void> {
  try {
    const stream = Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>;
    for await (const message of readJsonLines(stream)) {
      if (isRequest(message)) {
        const rejected: RpcMessage = response(message.id, errorOutcome(-32005, "aggregator already has an active client"));
        socket.end(`${JSON.stringify(rejected)}\n`);
      } else {
        socket.end();
      }
      return;
    }
  } catch {
    socket.destroy();
  }
}

async function prepareSocket(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (!existing.isSocket()) throw new Error(`refusing to replace non-socket path: ${path}`);
    if (await socketIsLive(path)) throw new Error(`aggregator daemon is already running: ${path}`);
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

async function prepareSocketDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const directory = await lstat(path);
  if (!directory.isDirectory()) throw new Error(`socket parent is not a directory: ${path}`);
  if (typeof process.getuid !== "function") throw new Error(`cannot verify socket directory ownership: ${path}`);
  if (directory.uid !== process.getuid()) throw new Error(`socket directory is not owned by the current user: ${path}`);
  if ((directory.mode & 0o777) !== 0o700) throw new Error(`socket directory must have mode 0700: ${path}`);
}

function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
