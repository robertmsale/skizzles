#!/usr/bin/env bun
import { resolve } from "node:path";
import { installSkills, receiptSummary, uninstallSkills, type Transfer } from "./core";
import { installHarness, uninstallHarness } from "./harness";

type Parsed = { command: "install" | "uninstall"; surface: "skills" | "harness"; codexHome: string | undefined; home: string | undefined; sourceRoot: string; transfer: Transfer; dryRun: boolean };

function usage(): never {
  console.error("usage: bun packages/installer/src/cli.ts <install|uninstall> --surface <skills|harness> [--codex-home PATH] [--home PATH] [--source-root PATH] [--transfer link|copy] [--dry-run]");
  process.exit(2);
}

function parse(argv: string[]): Parsed {
  const command = argv.shift();
  if (command !== "install" && command !== "uninstall") usage();
  let codexHome = process.env.CODEX_HOME;
  let home = process.env.HOME;
  let sourceRoot = resolve(import.meta.dir, "../../..");
  let transfer: Transfer = "link";
  let surface: "skills" | "harness" | undefined;
  let dryRun = false;
  while (argv.length > 0) {
    const flag = argv.shift();
    if (flag === "--dry-run") dryRun = true;
    else if (flag === "--codex-home") codexHome = argv.shift();
    else if (flag === "--home") home = argv.shift();
    else if (flag === "--source-root") sourceRoot = resolve(argv.shift() ?? usage());
    else if (flag === "--transfer" || flag === "--mode") {
      const mode = argv.shift();
      if (mode !== "link" && mode !== "copy") usage();
      transfer = mode;
    } else if (flag === "--surface") {
      const value = argv.shift();
      if (value !== "skills" && value !== "harness") usage();
      surface = value;
    }
    else usage();
  }
  if (!surface || (surface === "skills" && !codexHome) || (surface === "harness" && !home)) usage();
  return { command, surface, codexHome: codexHome && resolve(codexHome), home: home && resolve(home), sourceRoot, transfer, dryRun };
}

export function main(argv = process.argv.slice(2)): void {
  const parsed = parse([...argv]);
  if (parsed.surface === "skills") {
    const receipt = parsed.command === "install"
      ? installSkills({ codexHome: parsed.codexHome!, sourceRoot: parsed.sourceRoot, transfer: parsed.transfer, dryRun: parsed.dryRun })
      : uninstallSkills(parsed.codexHome!, parsed.dryRun);
    console.log(JSON.stringify({ ok: true, dryRun: parsed.dryRun, ...receiptSummary(receipt) }));
  } else {
    const receipt = parsed.command === "install"
      ? installHarness({ home: parsed.home!, sourceRoot: parsed.sourceRoot, transfer: parsed.transfer, dryRun: parsed.dryRun })
      : uninstallHarness(parsed.home!, parsed.dryRun);
    console.log(JSON.stringify({ ok: true, dryRun: parsed.dryRun, surface: "harness", transfer: receipt.transfer, pluginTarget: receipt.pluginTarget }));
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "installer failed");
    process.exit(1);
  }
}
