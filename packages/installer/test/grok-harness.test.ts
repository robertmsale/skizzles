import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { grokHarnessReceiptPath, installGrokHarness, uninstallGrokHarness } from "../src/grok";

const roots: string[] = [];

function fixture(): { sourceRoot: string; grokHome: string } {
  const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-grok-${crypto.randomUUID()}`;
  roots.push(root);
  const sourceRoot = join(root, "source");
  const grokHome = join(root, "grok-home");
  for (const name of ["root", "worker", "explorer", "reviewer"]) {
    const path = join(sourceRoot, `grok/agents/skizzles-${name}.md`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `---\nname: skizzles-${name}\npromptMode: full\n---\n${name}\n`);
  }
  mkdirSync(join(sourceRoot, "grok/bin"), { recursive: true });
  writeFileSync(
    join(sourceRoot, "grok/bin/skizzles-grok"),
    '#!/bin/sh\nexport GROK_AGENT=skizzles-root\nexec "$(dirname "$0")/grok" --agent skizzles-root --model grok-4.6 --effort high --permission-mode auto "$@"\n',
    { mode: 0o755 },
  );
  mkdirSync(join(sourceRoot, "grok/hooks/bin"), { recursive: true });
  writeFileSync(join(sourceRoot, "grok/hooks/skizzles-subagent-guard.json"), "{}\n");
  writeFileSync(join(sourceRoot, "grok/hooks/bin/skizzles-guard-subagent-spawn.ts"), "#!/usr/bin/env bun\n");
  mkdirSync(join(sourceRoot, "skills/portable"), { recursive: true });
  writeFileSync(join(sourceRoot, "skills/portable/SKILL.md"), "---\nname: portable\n---\n");
  writeFileSync(join(sourceRoot, "grok/portable-skills.json"), '{"version":1,"skills":["portable"]}\n');
  return { sourceRoot, grokHome };
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("Grok harness installer", () => {
  for (const transfer of ["link", "copy"] as const) {
    test(`${transfer} install and uninstall preserve unrelated Grok state`, () => {
      const f = fixture();
      mkdirSync(f.grokHome, { recursive: true });
      writeFileSync(join(f.grokHome, "config.toml"), "[ui]\nyolo = false\n");

      const receipt = installGrokHarness({ ...f, transfer });

      expect(receipt.entries).toHaveLength(8);
      expect(existsSync(join(f.grokHome, "agents/skizzles-root.md"))).toBe(true);
      expect(existsSync(join(f.grokHome, "skills/portable/SKILL.md"))).toBe(true);
      expect(lstatSync(join(f.grokHome, "bin/skizzles-grok")).mode & 0o111).not.toBe(0);
      expect(lstatSync(join(f.grokHome, "hooks/skizzles-subagent-guard.json")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(f.grokHome, "config.toml"), "utf8")).toBe("[ui]\nyolo = false\n");

      uninstallGrokHarness(f.grokHome);

      expect(existsSync(join(f.grokHome, "agents/skizzles-root.md"))).toBe(false);
      expect(existsSync(join(f.grokHome, "skills/portable"))).toBe(false);
      expect(existsSync(join(f.grokHome, "bin/skizzles-grok"))).toBe(false);
      expect(existsSync(grokHarnessReceiptPath(f.grokHome))).toBe(false);
      expect(readFileSync(join(f.grokHome, "config.toml"), "utf8")).toBe("[ui]\nyolo = false\n");
    });
  }

  test("dry run is read-only and foreign targets fail closed", () => {
    const f = fixture();
    installGrokHarness({ ...f, transfer: "link", dryRun: true });
    expect(existsSync(f.grokHome)).toBe(false);

    mkdirSync(join(f.grokHome, "agents"), { recursive: true });
    writeFileSync(join(f.grokHome, "agents/skizzles-root.md"), "foreign\n");
    expect(() => installGrokHarness({ ...f, transfer: "link" })).toThrow("refusing to replace");
    expect(readFileSync(join(f.grokHome, "agents/skizzles-root.md"), "utf8")).toBe("foreign\n");
  });

  test("launcher pins the root profile and enables native automatic permission review", () => {
    const f = fixture();
    mkdirSync(join(f.grokHome, "bin"), { recursive: true });
    writeFileSync(join(f.grokHome, "bin/grok"), "#!/bin/sh\nprintf 'GROK_AGENT=%s\\n' \"$GROK_AGENT\"\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
    installGrokHarness({ ...f, transfer: "link" });

    const result = Bun.spawnSync([join(f.grokHome, "bin/skizzles-grok"), "agent", "stdio"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      "GROK_AGENT=skizzles-root",
      "--agent",
      "skizzles-root",
      "--model",
      "grok-4.6",
      "--effort",
      "high",
      "--permission-mode",
      "auto",
      "agent",
      "stdio",
    ]);
  });

  test("uninstall refuses copied target drift", () => {
    const f = fixture();
    installGrokHarness({ ...f, transfer: "copy" });
    const target = join(f.grokHome, "hooks/skizzles-subagent-guard.json");
    writeFileSync(target, '{"changed":true}\n');

    expect(() => uninstallGrokHarness(f.grokHome)).toThrow("target drifted");
    expect(existsSync(grokHarnessReceiptPath(f.grokHome))).toBe(true);
  });

  test("uninstall uses the receipt when the portable skill manifest changes", () => {
    const f = fixture();
    installGrokHarness({ ...f, transfer: "copy" });
    writeFileSync(join(f.sourceRoot, "grok/portable-skills.json"), '{"version":1,"skills":[]}\n');

    uninstallGrokHarness(f.grokHome);

    expect(existsSync(join(f.grokHome, "skills/portable"))).toBe(false);
    expect(existsSync(grokHarnessReceiptPath(f.grokHome))).toBe(false);
  });

  test("uninstall rejects receipt targets outside the owned Grok surface", () => {
    const f = fixture();
    installGrokHarness({ ...f, transfer: "copy" });
    const receiptPath = grokHarnessReceiptPath(f.grokHome);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.entries[0].target = join(f.grokHome, "config.toml");
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);

    expect(() => uninstallGrokHarness(f.grokHome)).toThrow("unexpected target");
    expect(existsSync(join(f.grokHome, "agents/skizzles-root.md"))).toBe(true);
  });

  test("rejects symlinked managed parents", () => {
    const f = fixture();
    const outside = join(f.grokHome, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(f.grokHome, { recursive: true });
    symlinkSync(outside, join(f.grokHome, "agents"));

    expect(() => installGrokHarness({ ...f, transfer: "copy" })).toThrow("symlinked parent");
    expect(existsSync(join(outside, "skizzles-root.md"))).toBe(false);
  });
});
