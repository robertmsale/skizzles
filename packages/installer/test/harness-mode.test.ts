import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessReceiptPath, installHarness, uninstallHarness } from "../src/harness";

const roots: string[] = [];
function fixture(): { sourceRoot: string; home: string } {
  const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-harness-${crypto.randomUUID()}`;
  roots.push(root);
  const sourceRoot = join(root, "source");
  const home = join(root, "home");
  mkdirSync(join(sourceRoot, "plugins/skizzles/.codex-plugin"), { recursive: true });
  writeFileSync(join(sourceRoot, "plugins/skizzles/.codex-plugin/plugin.json"), '{"name":"skizzles"}\n');
  return { sourceRoot, home };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("harness installer", () => {
  for (const transfer of ["link", "copy"] as const) {
    test(`${transfer} install/uninstall round trip`, () => {
      const f = fixture();
      installHarness({ ...f, transfer });
      expect(existsSync(join(f.home, "plugins/skizzles/.codex-plugin/plugin.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(f.home, ".agents/plugins/marketplace.json"), "utf8")).plugins[0].name).toBe("skizzles");
      uninstallHarness(f.home);
      expect(existsSync(join(f.home, "plugins/skizzles"))).toBe(false);
      expect(existsSync(join(f.home, ".agents/plugins/marketplace.json"))).toBe(false);
      expect(existsSync(harnessReceiptPath(f.home))).toBe(false);
    });
  }

  test("merges and restores an existing marketplace", () => {
    const f = fixture();
    const path = join(f.home, ".agents/plugins/marketplace.json");
    mkdirSync(join(f.home, ".agents/plugins"), { recursive: true });
    const before = '{"name":"personal","plugins":[{"name":"other"}]}\n';
    writeFileSync(path, before);
    installHarness({ ...f, transfer: "link" });
    expect(JSON.parse(readFileSync(path, "utf8")).plugins.map((entry: { name: string }) => entry.name)).toEqual(["other", "skizzles"]);
    uninstallHarness(f.home);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("dry run and conflicts are fail closed", () => {
    const f = fixture();
    installHarness({ ...f, transfer: "copy", dryRun: true });
    expect(existsSync(f.home)).toBe(false);
    mkdirSync(join(f.home, "plugins/skizzles"), { recursive: true });
    expect(() => installHarness({ ...f, transfer: "copy" })).toThrow("refusing to replace");
  });

  test("uninstall refuses marketplace drift", () => {
    const f = fixture();
    installHarness({ ...f, transfer: "link" });
    writeFileSync(join(f.home, ".agents/plugins/marketplace.json"), '{"name":"changed","plugins":[]}\n');
    expect(() => uninstallHarness(f.home)).toThrow("marketplace changed");
    expect(existsSync(join(f.home, "plugins/skizzles"))).toBe(true);
  });
});
