import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertManagedParentsAreReal, copyDirectoryExclusive, pathEntryExists, sameTree, type Transfer } from "./core";

interface Marketplace {
  name: string;
  interface?: { displayName?: string };
  plugins: Array<Record<string, unknown>>;
}

export interface HarnessReceipt {
  version: 1;
  sourceRoot: string;
  transfer: Transfer;
  pluginTarget: string;
  marketplacePath: string;
  marketplaceAfter: string;
}

export interface HarnessOptions {
  home: string;
  sourceRoot: string;
  transfer: Transfer;
  dryRun?: boolean;
}

export function harnessReceiptPath(home: string): string {
  return join(resolve(home), ".skizzles", "harness-receipt.json");
}

function pluginEntry(): Record<string, unknown> {
  return {
    name: "skizzles",
    source: { source: "local", path: "./plugins/skizzles" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  };
}

function marketplaceWithSkizzles(): string {
  const marketplace: Marketplace = { name: "personal", interface: { displayName: "Personal" }, plugins: [] };
  marketplace.plugins.push(pluginEntry());
  return `${JSON.stringify(marketplace, null, 2)}\n`;
}

function readReceipt(home: string): HarnessReceipt {
  const path = harnessReceiptPath(home);
  if (!existsSync(path)) throw new Error(`Skizzles harness receipt is missing: ${path}`);
  const receipt = JSON.parse(readFileSync(path, "utf8")) as Partial<HarnessReceipt>;
  if (receipt.version !== 1 || (receipt.transfer !== "link" && receipt.transfer !== "copy")) {
    throw new Error(`invalid Skizzles harness receipt: ${path}`);
  }
  return receipt as HarnessReceipt;
}

export function installHarness(options: HarnessOptions): HarnessReceipt {
  const home = resolve(options.home);
  const sourceRoot = resolve(options.sourceRoot);
  const pluginSource = join(sourceRoot, "plugins", "skizzles");
  const pluginTarget = join(home, "plugins", "skizzles");
  const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
  const receiptPath = harnessReceiptPath(home);
  assertManagedParentsAreReal(home, ["plugins", ".agents", ".agents/plugins", ".skizzles"]);
  if (!existsSync(join(pluginSource, ".codex-plugin", "plugin.json"))) {
    throw new Error(`generated plugin is missing: ${pluginSource}`);
  }
  if (pathEntryExists(pluginTarget)) throw new Error(`refusing to replace existing plugin: ${pluginTarget}`);
  if (pathEntryExists(receiptPath)) throw new Error(`Skizzles harness receipt already exists: ${receiptPath}`);
  if (pathEntryExists(marketplacePath)) throw new Error(`isolated harness requires an absent marketplace: ${marketplacePath}`);
  const marketplaceAfter = marketplaceWithSkizzles();
  const receipt: HarnessReceipt = {
    version: 1,
    sourceRoot,
    transfer: options.transfer,
    pluginTarget,
    marketplacePath,
    marketplaceAfter,
  };
  if (options.dryRun) return receipt;

  try {
    mkdirSync(dirname(pluginTarget), { recursive: true });
    if (options.transfer === "link") symlinkSync(pluginSource, pluginTarget, "dir");
    else copyDirectoryExclusive(pluginSource, pluginTarget);
    mkdirSync(dirname(marketplacePath), { recursive: true });
    writeFileSync(marketplacePath, marketplaceAfter, { flag: "wx" });
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    rmSync(pluginTarget, { recursive: true, force: true });
    rmSync(marketplacePath, { force: true });
    throw error;
  }
  return receipt;
}

export function uninstallHarness(
  homeInput: string,
  dryRun = false,
  move: (from: string, to: string) => void = renameSync,
): HarnessReceipt {
  const home = resolve(homeInput);
  assertManagedParentsAreReal(home, ["plugins", ".agents", ".agents/plugins", ".skizzles"]);
  const receipt = readReceipt(home);
  const expectedTarget = join(home, "plugins", "skizzles");
  const expectedMarketplace = join(home, ".agents", "plugins", "marketplace.json");
  if (resolve(receipt.pluginTarget) !== expectedTarget || resolve(receipt.marketplacePath) !== expectedMarketplace) {
    throw new Error("harness receipt targets are outside the selected HOME");
  }
  if (!pathEntryExists(receipt.pluginTarget)) throw new Error("owned plugin target is missing");
  const pluginSource = join(receipt.sourceRoot, "plugins", "skizzles");
  if (receipt.transfer === "link") {
    if (!lstatSync(receipt.pluginTarget).isSymbolicLink()) throw new Error("owned plugin link changed type");
    const actual = resolve(dirname(receipt.pluginTarget), readlinkSync(receipt.pluginTarget));
    if (actual !== resolve(pluginSource)) throw new Error("owned plugin link target drifted");
  } else if (!sameTree(pluginSource, receipt.pluginTarget)) {
    throw new Error("owned copied plugin drifted");
  }
  if (!existsSync(receipt.marketplacePath) || readFileSync(receipt.marketplacePath, "utf8") !== receipt.marketplaceAfter) {
    throw new Error("marketplace changed after Skizzles installation");
  }
  if (dryRun) return receipt;
  const quarantine = join(home, ".skizzles", `harness-uninstall-${crypto.randomUUID()}`);
  mkdirSync(quarantine);
  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const [from, name] of [
      [receipt.marketplacePath, "marketplace.json"],
      [receipt.pluginTarget, "plugin"],
      [harnessReceiptPath(home), "receipt.json"],
    ] as const) {
      const to = join(quarantine, name);
      move(from, to);
      moved.push({ from, to });
    }
  } catch (error) {
    for (const item of moved.reverse()) {
      if (pathEntryExists(item.to) && !pathEntryExists(item.from)) renameSync(item.to, item.from);
    }
    rmSync(quarantine, { recursive: true, force: true });
    throw error;
  }
  try { rmSync(quarantine, { recursive: true, force: true }); } catch {}
  return receipt;
}
