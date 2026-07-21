import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertManagedParentsAreReal, pathEntryExists } from "./core";

export type OrchestrationMode = "aggressive" | "passive";
export type InstructionMode = "native" | "skizzles";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ConfigEdit {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: "replace";
}

interface ConfigLayer {
  name: { type: string; file?: string; profile?: string | null };
  version: string;
  config: JsonValue;
}

interface ConfigReadResponse {
  layers: ConfigLayer[] | null;
}

interface ConfigWriteResponse {
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

interface OwnedValue {
  keyPath: string;
  beforePresent: boolean;
  before: JsonValue;
  after: JsonValue;
}

export interface ConfigReceipt {
  version: 1;
  state: "pending" | "active" | "restoring";
  orchestration: OrchestrationMode;
  instructions?: InstructionMode;
  sourceRoot?: string;
  codexBinary: string;
  configPath: string;
  values: OwnedValue[];
}

export interface ConfigureOptions {
  codexHome: string;
  codexBinary: string;
  orchestration: OrchestrationMode;
  instructions?: InstructionMode;
  sourceRoot?: string;
  dryRun?: boolean;
  rpcFactory?: (codexHome: string, codexBinary: string) => Promise<ConfigRpc>;
}

const aggressiveModeHint =
  "Proactive complexity-aware delegation is active. Follow $fourth-wall whenever orchestration would materially improve speed or quality.";
const rootHint = "Fourth Wall applies. Read and follow $fourth-wall before this task's first orchestration action.";
const subagentHint =
  "Fourth Wall applies. Read and follow $fourth-wall and the behavioral role resource named in your assignment.";
const defaultAgentDescription =
  "Skizzles execution subagent with a compact developer-focused instruction set.";

interface InstructionAssets {
  sourceRoot: string;
  rootInstructions: string;
  subagentInstructions: string;
  subagentConfig: string;
}

export function configReceiptPath(codexHome: string): string {
  return join(canonicalExistingPath(codexHome), ".skizzles", "config-receipt.json");
}

function canonicalExistingPath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function resolveInstructionAssets(sourceRootInput: string): InstructionAssets {
  const sourceRoot = canonicalExistingPath(sourceRootInput);
  const assets = {
    sourceRoot,
    rootInstructions: join(sourceRoot, "assets", "skizzles_instructions.md"),
    subagentInstructions: join(sourceRoot, "assets", "skizzles_subagent_instructions.md"),
    subagentConfig: join(sourceRoot, "assets", "skizzles_subagent.toml"),
  };
  for (const [label, path] of Object.entries(assets).filter(([label]) => label !== "sourceRoot")) {
    if (!existsSync(path)) throw new Error(`Skizzles ${label} asset is missing: ${path}`);
  }
  return assets;
}

export function desiredConfigEdits(
  orchestration: OrchestrationMode,
  instructionAssets?: InstructionAssets,
): ConfigEdit[] {
  const edits: ConfigEdit[] = [
    { keyPath: "features.hooks", value: true, mergeStrategy: "replace" },
  ];
  if (instructionAssets) {
    edits.push(
      {
        keyPath: "model_instructions_file",
        value: instructionAssets.rootInstructions,
        mergeStrategy: "replace",
      },
      {
        keyPath: "agents.default.description",
        value: defaultAgentDescription,
        mergeStrategy: "replace",
      },
      {
        keyPath: "agents.default.config_file",
        value: instructionAssets.subagentConfig,
        mergeStrategy: "replace",
      },
    );
  }
  if (orchestration === "aggressive") {
    edits.push(
      { keyPath: "features.multi_agent_v2.enabled", value: true, mergeStrategy: "replace" },
      {
        keyPath: "features.multi_agent_v2.max_concurrent_threads_per_session",
        value: 7,
        mergeStrategy: "replace",
      },
      {
        keyPath: "features.multi_agent_v2.multi_agent_mode_hint_text",
        value: aggressiveModeHint,
        mergeStrategy: "replace",
      },
      {
        keyPath: "features.multi_agent_v2.root_agent_usage_hint_text",
        value: rootHint,
        mergeStrategy: "replace",
      },
      {
        keyPath: "features.multi_agent_v2.subagent_usage_hint_text",
        value: subagentHint,
        mergeStrategy: "replace",
      },
    );
  }
  return edits;
}

function valueAt(root: JsonValue, keyPath: string): { present: boolean; value: JsonValue } {
  let current = root;
  for (const segment of keyPath.split(".")) {
    if (current === null || Array.isArray(current) || typeof current !== "object" || !(segment in current)) {
      return { present: false, value: null };
    }
    current = current[segment]!;
  }
  return { present: true, value: current };
}

function sameValue(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function userLayer(read: ConfigReadResponse, configPath: string): ConfigLayer {
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

function writeReceipt(path: string, receipt: ConfigReceipt, exclusive = false): void {
  mkdirSync(dirname(path), { recursive: true });
  const contents = `${JSON.stringify(receipt, null, 2)}\n`;
  if (exclusive) {
    writeFileSync(path, contents, { flag: "wx" });
    return;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { flag: "wx" });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readReceipt(codexHome: string): ConfigReceipt {
  const path = configReceiptPath(codexHome);
  if (!existsSync(path)) throw new Error(`Skizzles config receipt is missing: ${path}`);
  const receipt = JSON.parse(readFileSync(path, "utf8")) as Partial<ConfigReceipt>;
  if (
    receipt.version !== 1 ||
    !["pending", "active", "restoring"].includes(receipt.state ?? "") ||
    !["aggressive", "passive"].includes(receipt.orchestration ?? "") ||
    (receipt.instructions !== undefined && !["native", "skizzles"].includes(receipt.instructions)) ||
    !Array.isArray(receipt.values)
  ) {
    throw new Error(`invalid Skizzles config receipt: ${path}`);
  }
  return receipt as ConfigReceipt;
}

function validateBinary(codexBinary: string): string {
  if (!isAbsolute(codexBinary)) throw new Error("--codex-binary must be an absolute path");
  const binary = resolve(codexBinary);
  if (!existsSync(binary)) throw new Error(`Codex binary is missing: ${binary}`);
  return binary;
}

export async function configureCodex(options: ConfigureOptions): Promise<ConfigReceipt> {
  const codexHome = canonicalExistingPath(options.codexHome);
  const codexBinary = validateBinary(options.codexBinary);
  const instructions = options.instructions ?? "native";
  if (instructions === "skizzles" && !options.sourceRoot) {
    throw new Error("--source-root is required with --instructions skizzles");
  }
  const instructionAssets = instructions === "skizzles"
    ? resolveInstructionAssets(options.sourceRoot!)
    : undefined;
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  if (pathEntryExists(receiptPath)) throw new Error(`Skizzles config receipt already exists: ${receiptPath}`);

  const configPath = join(codexHome, "config.toml");
  const rpc = await (options.rpcFactory ?? AppServerRpc.create)(codexHome, codexBinary);
  try {
    const layer = userLayer(await rpc.read(), configPath);
    const edits = desiredConfigEdits(options.orchestration, instructionAssets);
    const values = edits.map(({ keyPath, value }) => {
      const before = valueAt(layer.config, keyPath);
      return { keyPath, beforePresent: before.present, before: before.value, after: value };
    });
    const receipt: ConfigReceipt = {
      version: 1,
      state: "pending",
      orchestration: options.orchestration,
      instructions,
      ...(instructionAssets ? { sourceRoot: instructionAssets.sourceRoot } : {}),
      codexBinary,
      configPath,
      values,
    };
    if (options.dryRun) return receipt;

    writeReceipt(receiptPath, receipt, true);
    try {
      await rpc.batchWrite({
        edits,
        filePath: configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true,
      });
    } catch (error) {
      rmSync(receiptPath, { force: true });
      throw error;
    }
    receipt.state = "active";
    writeReceipt(receiptPath, receipt);
    return receipt;
  } finally {
    await rpc.close();
  }
}

export async function unconfigureCodex(options: Omit<ConfigureOptions, "orchestration">): Promise<ConfigReceipt> {
  const codexHome = canonicalExistingPath(options.codexHome);
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  const receipt = readReceipt(codexHome);
  const codexBinary = validateBinary(options.codexBinary);
  if (resolve(receipt.codexBinary) !== codexBinary) {
    throw new Error(`use the Codex binary recorded by the config receipt: ${receipt.codexBinary}`);
  }
  if (resolve(receipt.configPath) !== join(codexHome, "config.toml")) {
    throw new Error("config receipt points outside the selected CODEX_HOME");
  }

  const rpc = await (options.rpcFactory ?? AppServerRpc.create)(codexHome, codexBinary);
  try {
    const layer = userLayer(await rpc.read(), receipt.configPath);
    const atBefore = receipt.values.every(({ keyPath, beforePresent, before }) => {
      const current = valueAt(layer.config, keyPath);
      return current.present === beforePresent && (!beforePresent || sameValue(current.value, before));
    });
    if (receipt.state === "restoring" && atBefore) {
      if (!options.dryRun) rmSync(receiptPath);
      return receipt;
    }
    for (const value of receipt.values) {
      const current = valueAt(layer.config, value.keyPath);
      if (!current.present || !sameValue(current.value, value.after)) {
        throw new Error(`refusing to restore drifted config key: ${value.keyPath}`);
      }
    }
    if (options.dryRun) return receipt;

    receipt.state = "restoring";
    writeReceipt(receiptPath, receipt);
    await rpc.batchWrite({
      edits: receipt.values.map(({ keyPath, beforePresent, before }) => ({
        keyPath,
        value: beforePresent ? before : null,
        mergeStrategy: "replace",
      })),
      filePath: receipt.configPath,
      expectedVersion: layer.version,
      reloadUserConfig: true,
    });
    rmSync(receiptPath);
    return receipt;
  } finally {
    await rpc.close();
  }
}

class AppServerRpc implements ConfigRpc {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private readonly stderrChunks: string[] = [];
  private constructor(private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">) {}

  static async create(codexHome: string, codexBinary: string): Promise<AppServerRpc> {
    const process = Bun.spawn([codexBinary, "app-server"], {
      env: { ...Bun.env, CODEX_HOME: codexHome },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const rpc = new AppServerRpc(process);
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
