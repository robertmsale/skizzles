import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyDirectoryExclusive, installSkills, skillsReceiptPath, uninstallSkills } from "../src/core";

const roots: string[] = [];

function fixture(): { sourceRoot: string; codexHome: string } {
  const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-installer-${crypto.randomUUID()}`;
  roots.push(root);
  const sourceRoot = join(root, "source");
  const codexHome = join(root, "codex");
  for (const name of ["alpha", "install-skizzles"]) {
    mkdirSync(join(sourceRoot, "skills", name), { recursive: true });
    writeFileSync(join(sourceRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
  }
  return { sourceRoot, codexHome };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("skills installer", () => {
  for (const transfer of ["link", "copy"] as const) {
    test(`${transfer} install/uninstall round trip`, () => {
      const fixtureRoot = fixture();
      const before = readFileSync(join(fixtureRoot.sourceRoot, "skills/alpha/SKILL.md"), "utf8");
      const receipt = installSkills({ ...fixtureRoot, transfer });
      expect(receipt.skills.map((skill) => skill.name)).toEqual(["alpha", "install-skizzles"]);
      expect(existsSync(skillsReceiptPath(fixtureRoot.codexHome))).toBe(true);
      expect(lstatSync(join(fixtureRoot.codexHome, "skills/alpha")).isSymbolicLink()).toBe(transfer === "link");
      uninstallSkills(fixtureRoot.codexHome);
      expect(existsSync(join(fixtureRoot.codexHome, "skills/alpha"))).toBe(false);
      expect(existsSync(skillsReceiptPath(fixtureRoot.codexHome))).toBe(false);
      expect(readFileSync(join(fixtureRoot.sourceRoot, "skills/alpha/SKILL.md"), "utf8")).toBe(before);
    });
  }

  test("dry run performs no writes", () => {
    const fixtureRoot = fixture();
    installSkills({ ...fixtureRoot, transfer: "copy", dryRun: true });
    expect(existsSync(fixtureRoot.codexHome)).toBe(false);
  });

  test("exclusive copy cleans its partial target on nested failure", () => {
    const fixtureRoot = fixture();
    const source = join(fixtureRoot.sourceRoot, "skills/alpha");
    const target = join(fixtureRoot.codexHome, "skills/alpha");
    mkdirSync(join(fixtureRoot.codexHome, "skills"), { recursive: true });
    expect(() => copyDirectoryExclusive(source, target, (_from, to) => {
      writeFileSync(to, "partial");
      throw new Error("injected copy failure");
    })).toThrow("injected copy failure");
    expect(existsSync(target)).toBe(false);
  });

  test("preflight refuses a foreign target", () => {
    const fixtureRoot = fixture();
    mkdirSync(join(fixtureRoot.codexHome, "skills/alpha"), { recursive: true });
    expect(() => installSkills({ ...fixtureRoot, transfer: "link" })).toThrow("refusing to replace");
    expect(existsSync(skillsReceiptPath(fixtureRoot.codexHome))).toBe(false);
  });

  test("preflight preserves a foreign dangling symlink", () => {
    const fixtureRoot = fixture();
    mkdirSync(join(fixtureRoot.codexHome, "skills"), { recursive: true });
    const target = join(fixtureRoot.codexHome, "skills/alpha");
    symlinkSync(join(fixtureRoot.codexHome, "missing"), target);
    expect(() => installSkills({ ...fixtureRoot, transfer: "link" })).toThrow("refusing to replace");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });

  test("rejects a symlinked skills parent", () => {
    const fixtureRoot = fixture();
    const outside = join(fixtureRoot.codexHome, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(fixtureRoot.codexHome, { recursive: true });
    symlinkSync(outside, join(fixtureRoot.codexHome, "skills"));
    expect(() => installSkills({ ...fixtureRoot, transfer: "link" })).toThrow("symlinked parent");
    expect(existsSync(join(outside, "alpha"))).toBe(false);
  });

  test("uninstall refuses link drift", () => {
    const fixtureRoot = fixture();
    installSkills({ ...fixtureRoot, transfer: "link" });
    rmSync(join(fixtureRoot.codexHome, "skills/alpha"));
    mkdirSync(join(fixtureRoot.codexHome, "skills/alpha"));
    expect(() => uninstallSkills(fixtureRoot.codexHome)).toThrow("changed type");
    expect(existsSync(join(fixtureRoot.codexHome, "skills/install-skizzles"))).toBe(true);
  });

  test("uninstall refuses copied content drift", () => {
    const fixtureRoot = fixture();
    installSkills({ ...fixtureRoot, transfer: "copy" });
    writeFileSync(join(fixtureRoot.codexHome, "skills/alpha/SKILL.md"), "changed");
    expect(() => uninstallSkills(fixtureRoot.codexHome)).toThrow("drifted");
  });

  test("uninstall rolls back staged moves on failure", () => {
    const fixtureRoot = fixture();
    installSkills({ ...fixtureRoot, transfer: "copy" });
    let calls = 0;
    expect(() => uninstallSkills(fixtureRoot.codexHome, false, (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error("injected move failure");
      renameSync(from, to);
    })).toThrow("injected move failure");
    expect(existsSync(join(fixtureRoot.codexHome, "skills/alpha/SKILL.md"))).toBe(true);
    expect(existsSync(join(fixtureRoot.codexHome, "skills/install-skizzles/SKILL.md"))).toBe(true);
    expect(existsSync(skillsReceiptPath(fixtureRoot.codexHome))).toBe(true);
  });
});
