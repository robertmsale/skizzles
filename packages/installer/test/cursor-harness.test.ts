import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cursorHarnessReceiptPath, installCursorHarness, uninstallCursorHarness } from "../src/cursor";

const roots: string[] = [];

function fixture(): { sourceRoot: string; cursorHome: string } {
  const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-cursor-${crypto.randomUUID()}`;
  roots.push(root);
  const sourceRoot = join(root, "source");
  const cursorHome = join(root, "cursor-home");
  mkdirSync(join(sourceRoot, "cursor/plugin/.cursor-plugin"), { recursive: true });
  mkdirSync(join(sourceRoot, "cursor/plugin/rules"), { recursive: true });
  writeFileSync(join(sourceRoot, "cursor/plugin/.cursor-plugin/plugin.json"), '{"name":"skizzles"}\n');
  writeFileSync(join(sourceRoot, "cursor/plugin/rules/skizzles-cursor.md"), "# rule\n");
  mkdirSync(join(sourceRoot, "skills/portable"), { recursive: true });
  writeFileSync(join(sourceRoot, "skills/portable/SKILL.md"), "---\nname: portable\n---\n");
  writeFileSync(join(sourceRoot, "cursor/portable-skills.json"), '{"version":1,"skills":["portable"]}\n');
  return { sourceRoot, cursorHome };
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("Cursor harness installer", () => {
  for (const transfer of ["link", "copy"] as const) {
    test(`${transfer} install and uninstall preserve unrelated Cursor state`, () => {
      const f = fixture();
      mkdirSync(f.cursorHome, { recursive: true });
      writeFileSync(join(f.cursorHome, "cli-config.json"), '{"version":1}\n');
      mkdirSync(join(f.cursorHome, "skills-cursor/builtin"), { recursive: true });
      writeFileSync(join(f.cursorHome, "skills-cursor/builtin/SKILL.md"), "builtin\n");

      const receipt = installCursorHarness({ ...f, transfer });

      expect(receipt.entries).toHaveLength(3);
      expect(existsSync(join(f.cursorHome, "skills/portable/SKILL.md"))).toBe(true);
      expect(existsSync(join(f.cursorHome, "plugins/local/skizzles/.cursor-plugin/plugin.json"))).toBe(true);
      expect(lstatSync(join(f.cursorHome, "plugins/local/skizzles/.cursor-plugin/plugin.json")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(f.cursorHome, "cli-config.json"), "utf8")).toBe('{"version":1}\n');
      expect(readFileSync(join(f.cursorHome, "skills-cursor/builtin/SKILL.md"), "utf8")).toBe("builtin\n");

      uninstallCursorHarness(f.cursorHome);

      expect(existsSync(join(f.cursorHome, "skills/portable"))).toBe(false);
      expect(existsSync(join(f.cursorHome, "plugins/local/skizzles/.cursor-plugin/plugin.json"))).toBe(false);
      expect(existsSync(cursorHarnessReceiptPath(f.cursorHome))).toBe(false);
      expect(readFileSync(join(f.cursorHome, "cli-config.json"), "utf8")).toBe('{"version":1}\n');
      expect(readFileSync(join(f.cursorHome, "skills-cursor/builtin/SKILL.md"), "utf8")).toBe("builtin\n");
    });
  }

  test("dry run is read-only and foreign targets fail closed", () => {
    const f = fixture();
    installCursorHarness({ ...f, transfer: "link", dryRun: true });
    expect(existsSync(f.cursorHome)).toBe(false);

    mkdirSync(join(f.cursorHome, "skills/portable"), { recursive: true });
    writeFileSync(join(f.cursorHome, "skills/portable/SKILL.md"), "foreign\n");
    expect(() => installCursorHarness({ ...f, transfer: "link" })).toThrow("refusing to replace");
    expect(readFileSync(join(f.cursorHome, "skills/portable/SKILL.md"), "utf8")).toBe("foreign\n");
  });

  test("uninstall refuses copied target drift", () => {
    const f = fixture();
    installCursorHarness({ ...f, transfer: "copy" });
    const target = join(f.cursorHome, "plugins/local/skizzles/.cursor-plugin/plugin.json");
    writeFileSync(target, '{"changed":true}\n');

    expect(() => uninstallCursorHarness(f.cursorHome)).toThrow("target drifted");
    expect(existsSync(cursorHarnessReceiptPath(f.cursorHome))).toBe(true);
  });

  test("uninstall uses the receipt when the portable skill manifest changes", () => {
    const f = fixture();
    installCursorHarness({ ...f, transfer: "copy" });
    writeFileSync(join(f.sourceRoot, "cursor/portable-skills.json"), '{"version":1,"skills":[]}\n');

    uninstallCursorHarness(f.cursorHome);

    expect(existsSync(join(f.cursorHome, "skills/portable"))).toBe(false);
    expect(existsSync(cursorHarnessReceiptPath(f.cursorHome))).toBe(false);
  });

  test("refuses a reserved skills-cursor portable skill name", () => {
    const f = fixture();
    writeFileSync(join(f.sourceRoot, "cursor/portable-skills.json"), '{"version":1,"skills":["skills-cursor"]}\n');
    mkdirSync(join(f.sourceRoot, "skills/skills-cursor"), { recursive: true });
    writeFileSync(join(f.sourceRoot, "skills/skills-cursor/SKILL.md"), "no\n");
    expect(() => installCursorHarness({ ...f, transfer: "link" })).toThrow("reserved directory");
  });
});
