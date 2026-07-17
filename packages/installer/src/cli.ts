#!/usr/bin/env bun
import { resolve } from "node:path";
import { installSkills, receiptSummary, uninstallSkills, type Transfer } from "./core";

type Parsed = { command: "install" | "uninstall"; codexHome: string; sourceRoot: string; transfer: Transfer; dryRun: boolean };

function usage(): never {
  console.error("usage: bun packages/installer/src/cli.ts <install|uninstall> --surface skills --codex-home PATH [--source-root PATH] [--mode link|copy] [--dry-run]");
  process.exit(2);
}

function parse(argv: string[]): Parsed {
  const command = argv.shift();
  if (command !== "install" && command !== "uninstall") usage();
  let codexHome = process.env.CODEX_HOME;
  let sourceRoot = resolve(import.meta.dir, "../../..");
  let transfer: Transfer = "link";
  let surface: string | undefined;
  let dryRun = false;
  while (argv.length > 0) {
    const flag = argv.shift();
    if (flag === "--dry-run") dryRun = true;
    else if (flag === "--codex-home") codexHome = argv.shift();
    else if (flag === "--source-root") sourceRoot = resolve(argv.shift() ?? usage());
    else if (flag === "--mode") {
      const mode = argv.shift();
      if (mode !== "link" && mode !== "copy") usage();
      transfer = mode;
    } else if (flag === "--surface") surface = argv.shift();
    else usage();
  }
  if (!codexHome || surface !== "skills") usage();
  return { command, codexHome: resolve(codexHome), sourceRoot, transfer, dryRun };
}

export function main(argv = process.argv.slice(2)): void {
  const parsed = parse([...argv]);
  const receipt = parsed.command === "install"
    ? installSkills(parsed)
    : uninstallSkills(parsed.codexHome, parsed.dryRun);
  console.log(JSON.stringify({ ok: true, dryRun: parsed.dryRun, ...receiptSummary(receipt) }));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "installer failed");
    process.exit(1);
  }
}
