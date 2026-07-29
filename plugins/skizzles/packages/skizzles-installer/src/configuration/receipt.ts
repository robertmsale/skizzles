import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalExistingPath } from "../managed-filesystem";
import type { InstructionMode, JsonValue, OrchestrationMode } from "./edit-policy";

export interface OwnedConfigValue {
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
  values: OwnedConfigValue[];
}

export function configReceiptPath(codexHome: string): string {
  return join(canonicalExistingPath(codexHome), ".skizzles", "config-receipt.json");
}

export function readConfigReceipt(codexHome: string): ConfigReceipt {
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

export function writePendingConfigReceipt(path: string, receipt: ConfigReceipt): void {
  if (receipt.state !== "pending") throw new Error("new config receipt must be pending");
  persistReceipt(path, receipt, true);
}

export function activateConfigReceipt(path: string, receipt: ConfigReceipt): ConfigReceipt {
  const activeReceipt = { ...receipt, state: "active" as const };
  persistReceipt(path, activeReceipt);
  return activeReceipt;
}

export function beginConfigRestoration(path: string, receipt: ConfigReceipt): ConfigReceipt {
  const restoringReceipt = { ...receipt, state: "restoring" as const };
  persistReceipt(path, restoringReceipt);
  return restoringReceipt;
}

export function removeConfigReceipt(path: string, force = false): void {
  rmSync(path, { force });
}

function persistReceipt(path: string, receipt: ConfigReceipt, exclusive = false): void {
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
