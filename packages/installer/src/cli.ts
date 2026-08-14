#!/usr/bin/env bun
import { resolve } from "node:path";
import { installSkills, receiptSummary, uninstallSkills, type Transfer } from "./core";
import { installHarness, uninstallHarness } from "./harness";
import { grokReceiptSummary, installGrokHarness, uninstallGrokHarness } from "./grok";
import { doctor } from "./doctor";
import {
  configureCodex,
  unconfigureCodex,
  type InstructionMode,
  type OrchestrationMode,
} from "./config";

type Parsed = {
  command: "install" | "uninstall" | "doctor" | "configure" | "unconfigure";
  surface: "skills" | "harness" | "grok" | undefined;
  codexHome: string | undefined;
  codexBinary: string | undefined;
  orchestration: OrchestrationMode | undefined;
  instructions: InstructionMode | undefined;
  home: string | undefined;
  grokHome: string | undefined;
  sourceRoot: string;
  sourceRootProvided: boolean;
  transfer: Transfer;
  dryRun: boolean;
};

function usage(): never {
  console.error("usage: bun packages/installer/src/cli.ts <install|uninstall> --surface <skills|harness|grok> [--codex-home PATH] [--home PATH] [--grok-home PATH] [--source-root PATH] [--transfer link|copy] [--dry-run] | configure --codex-home PATH --codex-binary PATH --orchestration <aggressive|passive> [--instructions <native|skizzles>] [--source-root PATH] [--dry-run] | unconfigure --codex-home PATH --codex-binary PATH [--dry-run] | doctor --home PATH --codex-home PATH");
  process.exit(2);
}

function parse(argv: string[]): Parsed {
  const command = argv.shift();
  if (!["install", "uninstall", "doctor", "configure", "unconfigure"].includes(command ?? "")) usage();
  let codexHome: string | undefined;
  let codexBinary: string | undefined;
  let orchestration: OrchestrationMode | undefined;
  let instructions: InstructionMode | undefined;
  let home: string | undefined;
  let grokHome: string | undefined;
  let sourceRoot = resolve(import.meta.dir, "../../..");
  let sourceRootProvided = false;
  let transfer: Transfer = "link";
  let surface: "skills" | "harness" | "grok" | undefined;
  let dryRun = false;
  while (argv.length > 0) {
    const flag = argv.shift();
    if (flag === "--dry-run") dryRun = true;
    else if (flag === "--codex-home") codexHome = argv.shift();
    else if (flag === "--codex-binary") codexBinary = argv.shift();
    else if (flag === "--orchestration") {
      const value = argv.shift();
      if (value !== "aggressive" && value !== "passive") usage();
      orchestration = value;
    }
    else if (flag === "--instructions") {
      const value = argv.shift();
      if (value !== "native" && value !== "skizzles") usage();
      instructions = value;
    }
    else if (flag === "--home") home = argv.shift();
    else if (flag === "--grok-home") grokHome = argv.shift();
    else if (flag === "--source-root") {
      sourceRoot = resolve(argv.shift() ?? usage());
      sourceRootProvided = true;
    }
    else if (flag === "--transfer" || flag === "--mode") {
      const mode = argv.shift();
      if (mode !== "link" && mode !== "copy") usage();
      transfer = mode;
    } else if (flag === "--surface") {
      const value = argv.shift();
      if (value !== "skills" && value !== "harness" && value !== "grok") usage();
      surface = value;
    }
    else usage();
  }
  if (command === "doctor") {
    if (!home || !codexHome || grokHome || surface || codexBinary || orchestration || instructions) usage();
  } else if (command === "configure") {
    if (
      !codexHome ||
      !codexBinary ||
      !orchestration ||
      surface ||
      home ||
      grokHome ||
      (instructions === "skizzles" && !sourceRootProvided)
    ) usage();
  } else if (command === "unconfigure") {
    if (!codexHome || !codexBinary || orchestration || instructions || surface || home || grokHome) usage();
  } else if (
    instructions ||
    !surface ||
    (surface === "skills" && (!codexHome || home || grokHome)) ||
    (surface === "harness" && (!home || codexHome || grokHome)) ||
    (surface === "grok" && (!grokHome || codexHome || home || (command === "install" && !sourceRootProvided)))
  ) usage();
  return {
    command: command as Parsed["command"],
    surface,
    codexHome: codexHome && resolve(codexHome),
    codexBinary,
    orchestration,
    instructions,
    home: home && resolve(home),
    grokHome: grokHome && resolve(grokHome),
    sourceRoot,
    sourceRootProvided,
    transfer,
    dryRun,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parse([...argv]);
  if (parsed.command === "doctor") {
    const report = doctor(parsed.home!, parsed.codexHome!);
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (parsed.command === "configure" || parsed.command === "unconfigure") {
    const receipt = parsed.command === "configure"
      ? await configureCodex({
        codexHome: parsed.codexHome!,
        codexBinary: parsed.codexBinary!,
        orchestration: parsed.orchestration!,
        sourceRoot: parsed.sourceRoot,
        ...(parsed.instructions ? { instructions: parsed.instructions } : {}),
        dryRun: parsed.dryRun,
      })
      : await unconfigureCodex({
        codexHome: parsed.codexHome!,
        codexBinary: parsed.codexBinary!,
        dryRun: parsed.dryRun,
      });
    console.log(JSON.stringify({
      ok: true,
      dryRun: parsed.dryRun,
      surface: "config",
      orchestration: receipt.orchestration,
      instructions: receipt.instructions ?? "native",
      configPath: receipt.configPath,
      keys: receipt.values.map(({ keyPath }) => keyPath),
    }));
    return;
  }
  if (parsed.surface === "skills") {
    const receipt = parsed.command === "install"
      ? installSkills({ codexHome: parsed.codexHome!, sourceRoot: parsed.sourceRoot, transfer: parsed.transfer, dryRun: parsed.dryRun })
      : uninstallSkills(parsed.codexHome!, parsed.dryRun);
    console.log(JSON.stringify({ ok: true, dryRun: parsed.dryRun, ...receiptSummary(receipt) }));
  } else if (parsed.surface === "harness") {
    const receipt = parsed.command === "install"
      ? installHarness({ home: parsed.home!, sourceRoot: parsed.sourceRoot, transfer: parsed.transfer, dryRun: parsed.dryRun })
      : uninstallHarness(parsed.home!, parsed.dryRun);
    console.log(JSON.stringify({ ok: true, dryRun: parsed.dryRun, surface: "harness", transfer: receipt.transfer, pluginTarget: receipt.pluginTarget }));
  } else {
    const receipt = parsed.command === "install"
      ? installGrokHarness({ grokHome: parsed.grokHome!, sourceRoot: parsed.sourceRoot, transfer: parsed.transfer, dryRun: parsed.dryRun })
      : uninstallGrokHarness(parsed.grokHome!, parsed.dryRun);
    console.log(JSON.stringify({ ok: true, dryRun: parsed.dryRun, ...grokReceiptSummary(receipt) }));
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "installer failed");
    process.exit(1);
  });
}
