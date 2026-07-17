import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installSkills, skillsReceiptPath, uninstallSkills } from "../src/core";

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

  test("preflight refuses a foreign target", () => {
    const fixtureRoot = fixture();
    mkdirSync(join(fixtureRoot.codexHome, "skills/alpha"), { recursive: true });
    expect(() => installSkills({ ...fixtureRoot, transfer: "link" })).toThrow("refusing to replace");
    expect(existsSync(skillsReceiptPath(fixtureRoot.codexHome))).toBe(false);
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
});
