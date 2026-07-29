import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { canonicalExistingPath } from "../managed-filesystem";
import type { ConfigEdit, JsonValue } from "./edit-policy";

export interface ConfigLayer {
  name: { type: string; file?: string; profile?: string | null };
  version: string;
  config: JsonValue;
}

export interface ConfigReadResponse {
  layers: ConfigLayer[] | null;
}

export interface ConfigWriteResponse {
  status: string;
  version: string;
  filePath: string;
}

export interface ConfigRpc {
  read(): Promise<ConfigReadResponse>;
  batchWrite(params: {
    edits: ConfigEdit[];
    filePath: string;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }): Promise<ConfigWriteResponse>;
  close(): Promise<void>;
}

export function resolveCodexBinary(codexBinary: string): string {
  if (!isAbsolute(codexBinary)) throw new Error("--codex-binary must be an absolute path");
  const binary = resolve(codexBinary);
  if (!existsSync(binary)) throw new Error(`Codex binary is missing: ${binary}`);
  return binary;
}

export function selectUserConfigLayer(read: ConfigReadResponse, configPath: string): ConfigLayer {
  const expected = canonicalExistingPath(configPath);
  const layer = read.layers?.find(
    ({ name }) =>
      name.type === "user" &&
      name.profile === null &&
      name.file &&
      canonicalExistingPath(name.file) === expected,
  );
  if (!layer) throw new Error(`Codex did not report the selected user config layer: ${expected}`);
  return layer;
}

export class CodexAppServerAdapter implements ConfigRpc {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private readonly stderrChunks: string[] = [];

  private constructor(private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">) {}

  static async create(codexHome: string, codexBinary: string): Promise<CodexAppServerAdapter> {
    const process = Bun.spawn([codexBinary, "app-server"], {
      env: { ...Bun.env, CODEX_HOME: codexHome },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const rpc = new CodexAppServerAdapter(process);
    rpc.consumeStdout();
    rpc.consumeStderr();
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "skizzles_installer", title: "Skizzles Installer", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      rpc.send({ method: "initialized" });
      return rpc;
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }

  read(): Promise<ConfigReadResponse> {
    return this.request("config/read", { includeLayers: true, cwd: null });
  }

  batchWrite(params: {
    edits: ConfigEdit[];
    filePath: string;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }): Promise<ConfigWriteResponse> {
    return this.request("config/batchWrite", params);
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    const exited = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(2_000).then(() => false),
    ]);
    if (!exited) this.process.kill();
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      this.send({ method, id, params });
    });
  }

  private send(message: object): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
    this.process.stdin.flush();
  }

  private async consumeStdout(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) this.receive(line);
    }
    const detail = this.stderrChunks.join("").slice(-8_000).trim();
    const error = new Error(`Codex app-server closed unexpectedly${detail ? `: ${detail}` : ""}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let message: { id?: number; result?: unknown; error?: { message?: string; data?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(`${message.error.message ?? "Codex app-server request failed"}: ${JSON.stringify(message.error.data ?? {})}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private async consumeStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.stderrChunks.push(decoder.decode(value, { stream: true }));
      if (this.stderrChunks.join("").length > 16_000) this.stderrChunks.splice(0, this.stderrChunks.length - 1);
    }
  }
}
