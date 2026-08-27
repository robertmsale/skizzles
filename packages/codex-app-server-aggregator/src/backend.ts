import { readJsonLines } from "./jsonl.ts";
import {
  errorOutcome,
  idKey,
  isNotification,
  isRequest,
  isResponse,
  type RpcId,
  type RpcMessage,
  type RpcNotification,
  type RpcOutcome,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.ts";

export interface BackendTransport {
  readonly machineId: string;
  readonly containerId: string;
  readonly workspace: string;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr?: ReadableStream<Uint8Array>;
  write(line: string): void | Promise<void>;
  destroy(): Promise<void>;
}

export interface BackendFactory {
  create(): Promise<BackendTransport>;
}

export type BackendHandlers = {
  onNotification: (backend: BackendConnection, notification: RpcNotification) => void | Promise<void>;
  onServerRequest: (backend: BackendConnection, request: RpcRequest) => void | Promise<void>;
  onLog?: (backend: BackendConnection, text: string) => void;
};

type Pending = {
  resolve: (outcome: RpcOutcome) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class BackendConnection {
  private readonly pending = new Map<string, Pending>();
  private readonly consumePromise: Promise<void>;
  private readonly stderrPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(readonly transport: BackendTransport, private readonly handlers: BackendHandlers) {
    this.consumePromise = this.consume();
    this.stderrPromise = transport.stderr ? this.consumeStderr(transport.stderr) : undefined;
  }

  get machineId(): string {
    return this.transport.machineId;
  }

  get workspace(): string {
    return this.transport.workspace;
  }

  async call(method: string, params: unknown): Promise<RpcOutcome> {
    if (this.closed) return errorOutcome(-32003, `backend ${this.machineId} is closed`);
    const id = `agg/client/${crypto.randomUUID()}`;
    const outcome = new Promise<RpcOutcome>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(idKey(id));
        resolve(errorOutcome(-32002, `backend request timed out: ${method}`));
      }, 60_000);
      this.pending.set(idKey(id), { resolve, timeout });
    });
    try {
      await this.send({ method, id, params });
    } catch (error) {
      const pending = this.pending.get(idKey(id));
      if (pending) clearTimeout(pending.timeout);
      this.pending.delete(idKey(id));
      this.handlers.onLog?.(this, error instanceof Error ? error.message : String(error));
      return errorOutcome(-32003, `backend request failed: ${method}`);
    }
    return outcome;
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.send(params === undefined ? { method } : { method, params });
  }

  respond(backendId: RpcId, outcome: RpcOutcome): Promise<void> {
    return this.send({ id: backendId, ...outcome });
  }

  async initialize(params: unknown): Promise<RpcOutcome> {
    return this.call("initialize", params);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (!this.closed) {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.resolve(errorOutcome(-32003, `backend ${this.machineId} closed`));
      }
      this.pending.clear();
    }
    const attempt = (async () => {
      await this.transport.destroy();
      await Promise.allSettled([this.consumePromise, ...(this.stderrPromise ? [this.stderrPromise] : [])]);
    })();
    this.closePromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.closePromise === attempt) this.closePromise = undefined;
      throw error;
    }
  }

  private async send(message: RpcMessage): Promise<void> {
    await this.transport.write(`${JSON.stringify(message)}\n`);
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of readJsonLines(this.transport.stdout)) {
        if (isResponse(message)) this.receiveResponse(message);
        else if (isRequest(message)) await this.handlers.onServerRequest(this, message);
        else if (isNotification(message)) await this.handlers.onNotification(this, message);
      }
    } catch (error) {
      this.handlers.onLog?.(this, error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.closed) {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          pending.resolve(errorOutcome(-32003, `backend ${this.machineId} exited`));
        }
        this.pending.clear();
      }
    }
  }

  private receiveResponse(message: RpcResponse): void {
    const pending = this.pending.get(idKey(message.id));
    if (!pending) {
      this.handlers.onLog?.(this, `ignored response for unknown backend id ${String(message.id)}`);
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(idKey(message.id));
    pending.resolve("error" in message ? { error: message.error } : { result: message.result });
  }

  private async consumeStderr(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) this.handlers.onLog?.(this, text);
    }
    const tail = decoder.decode();
    if (tail) this.handlers.onLog?.(this, tail);
  }
}
