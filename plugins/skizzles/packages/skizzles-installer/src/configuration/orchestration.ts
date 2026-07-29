import { join, resolve } from "node:path";
import {
  assertManagedParentsAreReal,
  canonicalExistingPath,
  pathEntryExists,
} from "../managed-filesystem";
import {
  CodexAppServerAdapter,
  resolveCodexBinary,
  selectUserConfigLayer,
  type ConfigRpc,
} from "./codex-app-server";
import {
  desiredConfigEdits,
  resolveInstructionAssets,
  sameJsonValue,
  valueAt,
  type InstructionMode,
  type OrchestrationMode,
} from "./edit-policy";
import {
  activateConfigReceipt,
  beginConfigRestoration,
  configReceiptPath,
  readConfigReceipt,
  removeConfigReceipt,
  writePendingConfigReceipt,
  type ConfigReceipt,
} from "./receipt";

export interface ConfigureOptions {
  codexHome: string;
  codexBinary: string;
  orchestration: OrchestrationMode;
  instructions?: InstructionMode;
  sourceRoot?: string;
  dryRun?: boolean;
  rpcFactory?: (codexHome: string, codexBinary: string) => Promise<ConfigRpc>;
}

export interface UnconfigureOptions {
  codexHome: string;
  codexBinary: string;
  dryRun?: boolean;
  rpcFactory?: (codexHome: string, codexBinary: string) => Promise<ConfigRpc>;
}

export async function configureCodex(options: ConfigureOptions): Promise<ConfigReceipt> {
  const codexHome = canonicalExistingPath(options.codexHome);
  const codexBinary = resolveCodexBinary(options.codexBinary);
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
  const rpc = await (options.rpcFactory ?? CodexAppServerAdapter.create)(codexHome, codexBinary);
  try {
    const layer = selectUserConfigLayer(await rpc.read(), configPath);
    const edits = desiredConfigEdits(options.orchestration, instructionAssets, layer.config);
    const values = edits.map(({ keyPath, value }) => {
      const before = valueAt(layer.config, keyPath);
      return { keyPath, beforePresent: before.present, before: before.value, after: value };
    });
    let receipt: ConfigReceipt = {
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

    writePendingConfigReceipt(receiptPath, receipt);
    try {
      await rpc.batchWrite({
        edits,
        filePath: configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true,
      });
    } catch (error) {
      removeConfigReceipt(receiptPath, true);
      throw error;
    }
    receipt = activateConfigReceipt(receiptPath, receipt);
    return receipt;
  } finally {
    await rpc.close();
  }
}

export async function unconfigureCodex(options: UnconfigureOptions): Promise<ConfigReceipt> {
  const codexHome = canonicalExistingPath(options.codexHome);
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  let receipt = readConfigReceipt(codexHome);
  const codexBinary = resolveCodexBinary(options.codexBinary);
  if (resolve(receipt.codexBinary) !== codexBinary) {
    throw new Error(`use the Codex binary recorded by the config receipt: ${receipt.codexBinary}`);
  }
  if (resolve(receipt.configPath) !== join(codexHome, "config.toml")) {
    throw new Error("config receipt points outside the selected CODEX_HOME");
  }

  const rpc = await (options.rpcFactory ?? CodexAppServerAdapter.create)(codexHome, codexBinary);
  try {
    const layer = selectUserConfigLayer(await rpc.read(), receipt.configPath);
    const atBefore = receipt.values.every(({ keyPath, beforePresent, before }) => {
      const current = valueAt(layer.config, keyPath);
      return current.present === beforePresent && (!beforePresent || sameJsonValue(current.value, before));
    });
    if (receipt.state === "restoring" && atBefore) {
      if (!options.dryRun) removeConfigReceipt(receiptPath);
      return receipt;
    }
    for (const value of receipt.values) {
      const current = valueAt(layer.config, value.keyPath);
      if (!current.present || !sameJsonValue(current.value, value.after)) {
        throw new Error(`refusing to restore drifted config key: ${value.keyPath}`);
      }
    }
    if (options.dryRun) return receipt;

    receipt = beginConfigRestoration(receiptPath, receipt);
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
    removeConfigReceipt(receiptPath);
    return receipt;
  } finally {
    await rpc.close();
  }
}
