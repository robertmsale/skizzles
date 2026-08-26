import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  assertManagedParentsAreReal,
  copyDirectoryExclusive,
  pathEntryExists,
  type Transfer,
} from "./core";

interface InstalledEntry {
  source: string;
  target: string;
  kind: "directory" | "file";
  transfer: Transfer | "copy-only";
  fingerprint: string;
}

export interface GrokHarnessReceipt {
  version: 1;
  sourceRoot: string;
  grokHome: string;
  transfer: Transfer;
  entries: InstalledEntry[];
}

export interface GrokHarnessOptions {
  grokHome: string;
  sourceRoot: string;
  transfer: Transfer;
  dryRun?: boolean;
}

const receiptName = "grok-harness-receipt.json";

export function grokHarnessReceiptPath(grokHome: string): string {
  return join(resolve(grokHome), ".skizzles", receiptName);
}

function fingerprint(path: string): string {
  const hash = createHash("sha256");
  const visit = (current: string, prefix: string): void => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${prefix}\0${readlinkSync(current)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`dir\0${prefix}\0`);
      for (const name of readdirSync(current).filter((entry) => entry !== ".DS_Store").sort()) {
        visit(join(current, name), prefix ? `${prefix}/${name}` : name);
      }
      return;
    }
    hash.update(`file\0${prefix}\0`);
    hash.update(readFileSync(current));
    hash.update("\0");
  };
  visit(path, "");
  return hash.digest("hex");
}

function portableSkills(sourceRoot: string): string[] {
  const manifestPath = join(sourceRoot, "grok/portable-skills.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: unknown;
    skills?: unknown;
  };
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.skills) ||
    manifest.skills.some((skill) => typeof skill !== "string" || skill.length === 0)
  ) {
    throw new Error(`invalid Grok portable-skills manifest: ${manifestPath}`);
  }
  return [...new Set(manifest.skills as string[])].sort();
}

function plannedEntries(options: GrokHarnessOptions): InstalledEntry[] {
  const sourceRoot = resolve(options.sourceRoot);
  const grokHome = resolve(options.grokHome);
  const agentRoot = join(sourceRoot, "grok/agents");
  const hookRoot = join(sourceRoot, "grok/hooks");
  const agentNames = [
    "skizzles-root.md",
    "skizzles-worker.md",
    "skizzles-explorer.md",
    "skizzles-reviewer.md",
  ];
  const entries: InstalledEntry[] = agentNames.map((name) => ({
    source: join(agentRoot, name),
    target: join(grokHome, "agents", name),
    kind: "file",
    transfer: options.transfer,
    fingerprint: "",
  }));
  entries.push(
    {
      source: join(sourceRoot, "grok/bin/skizzles-grok"),
      target: join(grokHome, "bin/skizzles-grok"),
      kind: "file",
      transfer: "copy-only",
      fingerprint: "",
    },
    {
      source: join(sourceRoot, "grok/bin/ompctl"),
      target: join(grokHome, "bin/ompctl"),
      kind: "file",
      transfer: "copy-only",
      fingerprint: "",
    },
    {
      source: join(sourceRoot, "packages/ompweb-orchestrator"),
      target: join(grokHome, ".skizzles/runtime/ompweb-orchestrator"),
      kind: "directory",
      transfer: options.transfer,
      fingerprint: "",
    },
    {
      source: join(hookRoot, "skizzles-subagent-guard.json"),
      target: join(grokHome, "hooks", "skizzles-subagent-guard.json"),
      kind: "file",
      transfer: "copy-only",
      fingerprint: "",
    },
    {
      source: join(hookRoot, "bin/skizzles-guard-subagent-spawn.ts"),
      target: join(grokHome, "hooks/bin/skizzles-guard-subagent-spawn.ts"),
      kind: "file",
      transfer: "copy-only",
      fingerprint: "",
    },
  );
  for (const skill of portableSkills(sourceRoot)) {
    entries.push({
      source: join(sourceRoot, "skills", skill),
      target: join(grokHome, "skills", skill),
      kind: "directory",
      transfer: options.transfer,
      fingerprint: "",
    });
  }
  for (const entry of entries) {
    if (!pathEntryExists(entry.source)) throw new Error(`canonical Grok harness input is missing: ${entry.source}`);
    if (entry.kind === "directory" && !lstatSync(entry.source).isDirectory()) {
      throw new Error(`canonical Grok harness directory is invalid: ${entry.source}`);
    }
    if (entry.kind === "file" && !lstatSync(entry.source).isFile()) {
      throw new Error(`canonical Grok harness file is invalid: ${entry.source}`);
    }
    entry.fingerprint = fingerprint(entry.source);
  }
  return entries;
}

function readReceipt(grokHome: string): GrokHarnessReceipt {
  const path = grokHarnessReceiptPath(grokHome);
  if (!existsSync(path)) throw new Error(`Skizzles Grok harness receipt is missing: ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GrokHarnessReceipt>;
  if (
    value.version !== 1 ||
    typeof value.sourceRoot !== "string" ||
    typeof value.grokHome !== "string" ||
    (value.transfer !== "link" && value.transfer !== "copy") ||
    !Array.isArray(value.entries)
  ) {
    throw new Error(`invalid Skizzles Grok harness receipt: ${path}`);
  }
  return value as GrokHarnessReceipt;
}

function validateReceiptEntries(receipt: GrokHarnessReceipt, grokHome: string): void {
  const sourceRoot = resolve(receipt.sourceRoot);
  const fixedEntries = new Map<string, Omit<InstalledEntry, "fingerprint">>([
    ...["root", "worker", "explorer", "reviewer"].map((role) => {
      const name = `skizzles-${role}.md`;
      const target = join(grokHome, "agents", name);
      return [target, {
        source: join(sourceRoot, "grok/agents", name),
        target,
        kind: "file" as const,
        transfer: receipt.transfer,
      }] as const;
    }),
    [
      join(grokHome, "bin", "skizzles-grok"),
      {
        source: join(sourceRoot, "grok/bin/skizzles-grok"),
        target: join(grokHome, "bin", "skizzles-grok"),
        kind: "file" as const,
        transfer: "copy-only" as const,
      },
    ],
    [
      join(grokHome, "bin", "ompctl"),
      {
        source: join(sourceRoot, "grok/bin/ompctl"),
        target: join(grokHome, "bin", "ompctl"),
        kind: "file" as const,
        transfer: "copy-only" as const,
      },
    ],
    [
      join(grokHome, ".skizzles/runtime/ompweb-orchestrator"),
      {
        source: join(sourceRoot, "packages/ompweb-orchestrator"),
        target: join(grokHome, ".skizzles/runtime/ompweb-orchestrator"),
        kind: "directory" as const,
        transfer: receipt.transfer,
      },
    ],
    [
      join(grokHome, "hooks", "skizzles-subagent-guard.json"),
      {
        source: join(sourceRoot, "grok/hooks/skizzles-subagent-guard.json"),
        target: join(grokHome, "hooks", "skizzles-subagent-guard.json"),
        kind: "file" as const,
        transfer: "copy-only" as const,
      },
    ],
    [
      join(grokHome, "hooks/bin", "skizzles-guard-subagent-spawn.ts"),
      {
        source: join(sourceRoot, "grok/hooks/bin/skizzles-guard-subagent-spawn.ts"),
        target: join(grokHome, "hooks/bin", "skizzles-guard-subagent-spawn.ts"),
        kind: "file" as const,
        transfer: "copy-only" as const,
      },
    ],
  ]);
  const ompctlTargets = new Set([
    join(grokHome, "bin", "ompctl"),
    join(grokHome, ".skizzles/runtime/ompweb-orchestrator"),
  ]);
  const seen = new Set<string>();
  for (const entry of receipt.entries) {
    if (
      !entry ||
      typeof entry.source !== "string" ||
      typeof entry.target !== "string" ||
      (entry.kind !== "file" && entry.kind !== "directory") ||
      (entry.transfer !== "link" && entry.transfer !== "copy" && entry.transfer !== "copy-only") ||
      typeof entry.fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.fingerprint)
    ) {
      throw new Error("Grok harness receipt contains an invalid entry");
    }
    const target = resolve(entry.target);
    if (seen.has(target)) throw new Error(`Grok harness receipt contains a duplicate target: ${target}`);
    seen.add(target);
    const fixed = fixedEntries.get(target);
    if (fixed) {
      if (
        resolve(entry.source) !== fixed.source ||
        entry.kind !== fixed.kind ||
        entry.transfer !== fixed.transfer
      ) {
        throw new Error(`Grok harness receipt entry does not match its owned target: ${target}`);
      }
      continue;
    }
    const skillRoot = join(grokHome, "skills");
    const skillName = relative(skillRoot, target);
    if (
      entry.kind !== "directory" ||
      entry.transfer !== receipt.transfer ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skillName) ||
      resolve(entry.source) !== join(sourceRoot, "skills", skillName)
    ) {
      throw new Error(`Grok harness receipt contains an unexpected target: ${target}`);
    }
  }
  const hasModernOmpctlEntry = [...ompctlTargets].some((target) => seen.has(target));
  for (const target of fixedEntries.keys()) {
    if (!seen.has(target) && (!ompctlTargets.has(target) || hasModernOmpctlEntry)) {
      throw new Error(`Grok harness receipt is missing an owned target: ${target}`);
    }
  }
}

export function installGrokHarness(options: GrokHarnessOptions): GrokHarnessReceipt {
  const grokHome = resolve(options.grokHome);
  const sourceRoot = resolve(options.sourceRoot);
  assertManagedParentsAreReal(grokHome, ["agents", "bin", "hooks", "hooks/bin", "skills", ".skizzles", ".skizzles/runtime"]);
  const receiptPath = grokHarnessReceiptPath(grokHome);
  if (pathEntryExists(receiptPath)) throw new Error(`Skizzles Grok harness receipt already exists: ${receiptPath}`);
  const entries = plannedEntries({ ...options, grokHome, sourceRoot });
  const conflict = entries.find(({ target }) => pathEntryExists(target));
  if (conflict) throw new Error(`refusing to replace existing Grok harness target: ${conflict.target}`);
  const receipt: GrokHarnessReceipt = { version: 1, sourceRoot, grokHome, transfer: options.transfer, entries };
  if (options.dryRun) return receipt;

  const created: string[] = [];
  try {
    for (const entry of entries) {
      mkdirSync(dirname(entry.target), { recursive: true });
      if (entry.transfer === "link") {
        symlinkSync(entry.source, entry.target, entry.kind === "directory" ? "dir" : "file");
      } else if (entry.kind === "directory") {
        copyDirectoryExclusive(entry.source, entry.target);
      } else {
        copyFileSync(entry.source, entry.target);
      }
      created.push(entry.target);
    }
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    for (const target of created.reverse()) rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return receipt;
}

export function uninstallGrokHarness(
  grokHomeInput: string,
  dryRun = false,
  move: (from: string, to: string) => void = renameSync,
): GrokHarnessReceipt {
  const grokHome = resolve(grokHomeInput);
  assertManagedParentsAreReal(grokHome, ["agents", "bin", "hooks", "hooks/bin", "skills", ".skizzles", ".skizzles/runtime"]);
  const receipt = readReceipt(grokHome);
  if (resolve(receipt.grokHome) !== grokHome) throw new Error("Grok harness receipt belongs to a different GROK_HOME");
  validateReceiptEntries(receipt, grokHome);
  for (const entry of receipt.entries) {
    const target = resolve(entry.target);
    if (!pathEntryExists(target)) throw new Error(`owned Grok harness target is missing: ${target}`);
    if (entry.transfer === "link") {
      if (!lstatSync(target).isSymbolicLink()) throw new Error(`owned Grok harness link changed type: ${target}`);
      const actual = resolve(dirname(target), readlinkSync(target));
      if (actual !== resolve(entry.source)) throw new Error(`owned Grok harness link target drifted: ${target}`);
    } else if (fingerprint(target) !== entry.fingerprint) {
      throw new Error(`owned Grok harness target drifted: ${target}`);
    }
  }
  if (dryRun) return receipt;

  const quarantine = join(grokHome, ".skizzles", `grok-uninstall-${crypto.randomUUID()}`);
  mkdirSync(quarantine);
  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const [index, entry] of receipt.entries.entries()) {
      const to = join(quarantine, `${index}-${entry.target.split("/").at(-1)}`);
      move(entry.target, to);
      moved.push({ from: entry.target, to });
    }
    const receiptPath = grokHarnessReceiptPath(grokHome);
    const to = join(quarantine, receiptName);
    move(receiptPath, to);
    moved.push({ from: receiptPath, to });
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

export function grokReceiptSummary(receipt: GrokHarnessReceipt): Record<string, unknown> {
  return {
    surface: "grok",
    transfer: receipt.transfer,
    grokHome: receipt.grokHome,
    targets: receipt.entries.map(({ target, transfer }) => ({
      target: relative(process.cwd(), target) || target,
      transfer,
    })),
  };
}
