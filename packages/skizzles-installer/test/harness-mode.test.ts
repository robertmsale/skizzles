import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("requires an absent marketplace for isolated harness mode", () => {
    const f = fixture();
    const path = join(f.home, ".agents/plugins/marketplace.json");
    mkdirSync(join(f.home, ".agents/plugins"), { recursive: true });
    const before = '{"name":"personal","plugins":[{"name":"other"}]}\n';
    writeFileSync(path, before);
    expect(() => installHarness({ ...f, transfer: "link" })).toThrow("requires an absent marketplace");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("dry run and conflicts are fail closed", () => {
    const f = fixture();
    installHarness({ ...f, transfer: "copy", dryRun: true });
    expect(existsSync(f.home)).toBe(false);
    mkdirSync(join(f.home, "plugins/skizzles"), { recursive: true });
    expect(() => installHarness({ ...f, transfer: "copy" })).toThrow("refusing to replace");
  });

  test("preflight preserves a foreign dangling plugin symlink", () => {
    const f = fixture();
    mkdirSync(join(f.home, "plugins"), { recursive: true });
    const target = join(f.home, "plugins/skizzles");
    symlinkSync(join(f.home, "missing"), target);
    expect(() => installHarness({ ...f, transfer: "link" })).toThrow("refusing to replace");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });

  test("rejects symlinked managed parents", () => {
    const f = fixture();
    const outside = join(f.home, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(f.home, { recursive: true });
    symlinkSync(outside, join(f.home, "plugins"));
    expect(() => installHarness({ ...f, transfer: "link" })).toThrow("symlinked parent");
    expect(existsSync(join(outside, "skizzles"))).toBe(false);
  });

  test("uninstall rolls back staged moves on failure", () => {
    const f = fixture();
    installHarness({ ...f, transfer: "link" });
    let calls = 0;
    expect(() => uninstallHarness(f.home, false, (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error("injected move failure");
      renameSync(from, to);
    })).toThrow("injected move failure");
    expect(existsSync(join(f.home, "plugins/skizzles/.codex-plugin/plugin.json"))).toBe(true);
    expect(existsSync(join(f.home, ".agents/plugins/marketplace.json"))).toBe(true);
    expect(existsSync(harnessReceiptPath(f.home))).toBe(true);
  });

  test("uninstall refuses marketplace drift", () => {
    const f = fixture();
    installHarness({ ...f, transfer: "link" });
    writeFileSync(join(f.home, ".agents/plugins/marketplace.json"), '{"name":"changed","plugins":[]}\n');
    expect(() => uninstallHarness(f.home)).toThrow("marketplace changed");
    expect(existsSync(join(f.home, "plugins/skizzles"))).toBe(true);
  });
});
