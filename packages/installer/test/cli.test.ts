import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("installer CLI target gates", () => {
  for (const invocation of [
    ["install", "--surface", "skills"],
    ["uninstall", "--surface", "skills"],
    ["install", "--surface", "harness"],
    ["uninstall", "--surface", "harness"],
    ["doctor"],
  ]) {
    test(`requires explicit roots for ${invocation.join(" ")}`, () => {
      const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-cli-gate-${crypto.randomUUID()}`;
      roots.push(root);
      const result = Bun.spawnSync({
        cmd: [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...invocation],
        env: { ...process.env, HOME: join(root, "ambient-home"), CODEX_HOME: join(root, "ambient-codex") },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(2);
      expect(existsSync(root)).toBe(false);
    });
  }

  test("doctor reports no install with a nonzero exit", () => {
    const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-cli-doctor-${crypto.randomUUID()}`;
    roots.push(root);
    const result = Bun.spawnSync({
      cmd: [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "doctor", "--home", join(root, "home"), "--codex-home", join(root, "codex")],
      env: { ...process.env, PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: false, installs: { skills: "absent", harness: "absent" } });
    expect(existsSync(root)).toBe(false);
  });
});
