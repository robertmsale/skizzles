import type { FileSink } from "bun";
import {
  MAX_RPC_FRAME_BYTES,
  MAX_RPC_REASSEMBLED_BYTES,
  RPC_CHUNK_PAYLOAD_BYTES,
  isRecord,
} from "./protocol.ts";

type RpcProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;
type PendingRequest = { command: string; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export interface OmpRpcClientOptions {
  command: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  onFrame?: (frame: Record<string, unknown>) => void | Promise<void>;
  onExit?: (exitCode: number, stderr: string) => void | Promise<void>;
}

export class OmpRpcError extends Error {
  constructor(message: string, readonly command?: string, readonly code?: string) {
    super(message);
    this.name = "OmpRpcError";
  }
}

export class RpcFrameDecoder {
  private pending?: { chunkId: string; count: number; byteLength: number; nextIndex: number; chunks: Buffer[]; receivedBytes: number };

  push(value: unknown): Record<string, unknown> | undefined {
    if (!isRecord(value) || value.type !== "rpc_chunk") {
      if (this.pending) throw new OmpRpcError("RPC chunk sequence was interrupted");
      if (!isRecord(value)) throw new OmpRpcError("RPC frame must be an object");
      return value;
    }
    const chunkId = value.chunkId;
    const index = value.index;
    const count = value.count;
    const byteLength = value.byteLength;
    const data = value.data;
    if (
      typeof chunkId !== "string" || chunkId.length === 0 || chunkId.length > 128 ||
      !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) ||
      (index as number) < 0 || (count as number) < 2 || (index as number) >= (count as number) ||
      (count as number) > Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) ||
      (byteLength as number) < MAX_RPC_FRAME_BYTES || (byteLength as number) > MAX_RPC_REASSEMBLED_BYTES ||
      typeof data !== "string" || data.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) throw new OmpRpcError("Invalid RPC chunk frame");
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data || bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
      throw new OmpRpcError("Invalid RPC chunk payload");
    }
    if (!this.pending) {
      if (index !== 0) throw new OmpRpcError("RPC chunk sequence must start at index zero");
      this.pending = { chunkId, count: count as number, byteLength: byteLength as number, nextIndex: 0, chunks: [], receivedBytes: 0 };
    }
    const pending = this.pending;
    if (pending.chunkId !== chunkId || pending.count !== count || pending.byteLength !== byteLength || pending.nextIndex !== index) {
      throw new OmpRpcError("RPC chunk sequence does not match");
    }
    pending.chunks.push(bytes);
    pending.nextIndex += 1;
    pending.receivedBytes += bytes.byteLength;
    if (pending.receivedBytes > pending.byteLength) throw new OmpRpcError("RPC chunk sequence exceeds its declared length");
    if (pending.nextIndex < pending.count) return undefined;
    this.pending = undefined;
    if (pending.receivedBytes !== pending.byteLength) throw new OmpRpcError("RPC chunk sequence length does not match");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
    const frame: unknown = JSON.parse(decoded);
    if (!isRecord(frame)) throw new OmpRpcError("Reassembled RPC frame must be an object");
    return frame;
  }
}

export class OmpRpcClient {
  private process?: RpcProcess;
  private sink?: FileSink;
  private sequence = 0;
  private pending = new Map<string, PendingRequest>();
  private stopped = false;
  private stderr = "";
  private protocolV2 = false;

  constructor(private readonly options: OmpRpcClientOptions) {}

  get pid(): number | undefined { return this.process?.pid; }

  async start(): Promise<Record<string, unknown>> {
    if (this.process) throw new OmpRpcError("OMP RPC client is already started");
    this.stopped = false;
    const child = Bun.spawn(this.options.command, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.process = child;
    this.sink = child.stdin;

    let resolveReady!: (value: Record<string, unknown>) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void this.readStderr(child);
    void this.readStdout(child, resolveReady, rejectReady);
    void child.exited.then(async (code) => {
      const wasCurrent = this.process === child;
      if (wasCurrent) {
        this.process = undefined;
        this.sink = undefined;
        const error = new OmpRpcError(`OMP exited with code ${code}${this.stderr ? `: ${this.stderr}` : ""}`);
        this.rejectPending(error);
        if (!this.stopped) rejectReady(error);
        await this.options.onExit?.(code, this.stderr);
      }
    });

    const startupTimeoutMs = this.options.startupTimeoutMs ?? 30_000;
    const timeout = Bun.sleep(startupTimeoutMs).then(() => { throw new OmpRpcError(`OMP did not become ready within ${startupTimeoutMs}ms`); });
    let readyFrame: Record<string, unknown>;
    try {
      readyFrame = await Promise.race([ready, timeout]);
      if (!supportsProtocolV2(readyFrame)) throw new OmpRpcError("OMP RPC protocol v2 is required");
      this.protocolV2 = true;
      await this.request("negotiate_protocol", { protocolVersion: 2 });
      await this.request("set_subagent_subscription", { level: "events" });
      return await this.getState();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.process;
    this.process = undefined;
    const sink = this.sink;
    this.sink = undefined;
    this.rejectPending(new OmpRpcError("OMP RPC client stopped"));
    try { sink?.end(); } catch {}
    if (!child) return;
    try { child.kill("SIGTERM"); } catch {}
    const exited = child.exited.then(() => true, () => true);
    if (!await Promise.race([exited, Bun.sleep(2_000).then(() => false)])) {
      try { child.kill("SIGKILL"); } catch {}
      await child.exited.catch(() => undefined);
    }
  }

  async request(command: string, payload: Record<string, unknown> = {}, timeoutMs = this.options.requestTimeoutMs ?? 60_000): Promise<Record<string, unknown>> {
    if (!this.process || !this.sink) throw new OmpRpcError("OMP RPC process is unavailable", command);
    const id = `skz-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    let resolveRequest!: (value: Record<string, unknown>) => void;
    let rejectRequest!: (error: Error) => void;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    const timer = setTimeout(() => {
      this.pending.delete(id);
      rejectRequest(new OmpRpcError(`OMP RPC ${command} timed out after ${timeoutMs}ms`, command, "timeout"));
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(id, { command, resolve: resolveRequest, reject: rejectRequest, timer });
    try {
      this.write({ id, type: command, ...payload });
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw error;
    }
    return result;
  }

  getState(): Promise<Record<string, unknown>> { return this.request("get_state"); }
  getMessagesPage(cursor?: string, limit = 50): Promise<Record<string, unknown>> {
    return this.request("get_messages_page", { ...(cursor ? { cursor } : {}), limit });
  }
  getSubagents(): Promise<Record<string, unknown>> { return this.request("get_subagents"); }
  prompt(message: string, streamingBehavior: "steer" | "followUp" = "followUp"): Promise<Record<string, unknown>> {
    return this.request("prompt", { message, streamingBehavior });
  }
  abort(): Promise<Record<string, unknown>> { return this.request("abort"); }

  respondToUi(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean; timedOut?: boolean }): void {
    this.write({ type: "extension_ui_response", id, ...response });
  }

  private write(frame: Record<string, unknown>): void {
    if (!this.sink) throw new OmpRpcError("OMP RPC input is closed");
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_RPC_FRAME_BYTES) throw new OmpRpcError("OMP RPC command exceeds 1 MiB");
    this.sink.write(line);
    this.sink.flush();
  }

  private async readStderr(child: RpcProcess): Promise<void> {
    const text = await new Response(child.stderr).text().catch(() => "");
    this.stderr = text.trim().slice(-16_384);
  }

  private async readStdout(
    child: RpcProcess,
    resolveReady: (frame: Record<string, unknown>) => void,
    rejectReady: (error: Error) => void,
  ): Promise<void> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    const frames = new RpcFrameDecoder();
    let buffer = "";
    let sawReady = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > MAX_RPC_FRAME_BYTES * 2) throw new OmpRpcError("OMP RPC output line exceeds transport limit");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.trim()) continue;
          if (Buffer.byteLength(line, "utf8") + 1 > MAX_RPC_FRAME_BYTES) throw new OmpRpcError("OMP RPC output frame exceeds 1 MiB");
          const parsed: unknown = JSON.parse(line);
          if (!sawReady && isRecord(parsed) && parsed.type === "ready") {
            sawReady = true;
            resolveReady(parsed);
            continue;
          }
          if (isRecord(parsed) && parsed.type === "rpc_chunk" && !this.protocolV2) {
            throw new OmpRpcError("OMP sent RPC chunks before protocol negotiation");
          }
          const frame = frames.push(parsed);
          if (frame) await this.handleFrame(frame);
        }
      }
      if (!sawReady) {
        await Promise.race([child.exited.catch(() => undefined), Bun.sleep(250)]);
        await Bun.sleep(0);
        rejectReady(new OmpRpcError(`OMP output closed before the ready frame${this.stderr ? `: ${this.stderr}` : ""}`));
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      rejectReady(failure);
      this.rejectPending(failure);
      try { child.kill("SIGTERM"); } catch {}
    } finally {
      reader.releaseLock();
    }
  }

  private async handleFrame(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.success === true) pending.resolve(frame);
        else pending.reject(new OmpRpcError(typeof frame.error === "string" ? frame.error : `OMP RPC ${pending.command} failed`, pending.command, typeof frame.code === "string" ? frame.code : undefined));
      }
    }
    await this.options.onFrame?.(frame);
  }

  private rejectPending(error: Error): void {
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const request of requests) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }
}

function supportsProtocolV2(frame: Record<string, unknown>): boolean {
  return frame.type === "ready" && Array.isArray(frame.supportedProtocolVersions) && frame.supportedProtocolVersions.includes(2) &&
    frame.maxFrameBytes === MAX_RPC_FRAME_BYTES && frame.maxReassembledFrameBytes === MAX_RPC_REASSEMBLED_BYTES;
}
