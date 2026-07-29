import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const justfile = join(repositoryRoot, "justfile");
const temporaryRoots: string[] = [];

afterEach(() => temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("root Just installer workflows", () => {
  test("package emits the complete five-command boundary in order", () => {
    const result = invokeJust(["package"]);
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual([
      ["run", "typecheck"],
      ["test"],
      ["run", "plugin:check"],
      ["run", "plugin:build"],
      ["run", "plugin:check"],
    ]);
  });

  test("all preview/apply pairs keep their dry-run boundary and installer flags", () => {
    const pairs: Array<{
      preview: string[];
      apply: string[];
      expected: string[];
    }> = [
      {
        preview: ["skills-install-preview", "TARGET", "copy"],
        apply: ["skills-install-apply", "TARGET", "copy"],
        expected: ["run", "packages/skizzles-installer/src/cli.ts", "install", "--source-root", repositoryRoot, "--codex-home", "TARGET", "--surface", "skills", "--transfer", "copy"],
      },
      {
        preview: ["harness-install-preview", "TARGET", "copy"],
        apply: ["harness-install-apply", "TARGET", "copy"],
        expected: ["run", "packages/skizzles-installer/src/cli.ts", "install", "--source-root", repositoryRoot, "--home", "TARGET", "--surface", "harness", "--transfer", "copy"],
      },
      {
        preview: ["skills-uninstall-preview", "TARGET"],
        apply: ["skills-uninstall-apply", "TARGET"],
        expected: ["run", "packages/skizzles-installer/src/cli.ts", "uninstall", "--surface", "skills", "--codex-home", "TARGET"],
      },
      {
        preview: ["harness-uninstall-preview", "TARGET"],
        apply: ["harness-uninstall-apply", "TARGET"],
        expected: ["run", "packages/skizzles-installer/src/cli.ts", "uninstall", "--surface", "harness", "--home", "TARGET"],
      },
      {
        preview: ["configure-preview", "TARGET", "passive", "native"],
        apply: ["configure-apply", "TARGET", "passive", "native"],
        expected: ["run", "packages/skizzles-installer/src/cli.ts", "configure", "--codex-home", "TARGET", "--codex-binary", "CODEX_BINARY", "--orchestration", "passive", "--instructions", "native"],
      },
      {
        preview: ["unconfigure-preview", "TARGET"],
        apply: ["unconfigure-apply", "TARGET"],
        expected: ["run", "packages/skizzles-installer/src/cli.ts", "unconfigure", "--codex-home", "TARGET", "--codex-binary", "CODEX_BINARY"],
      },
    ];

    for (const pair of pairs) {
      const preview = invokeJust(pair.preview);
      const apply = invokeJust(pair.apply);
      expect(preview.exitCode).toBe(0);
      expect(apply.exitCode).toBe(0);
      expect(preview.calls).toHaveLength(1);
      expect(apply.calls).toHaveLength(1);
      const previewCall = normalizePlaceholders(preview.calls[0]!, preview);
      const applyCall = normalizePlaceholders(apply.calls[0]!, apply);
      expect(previewCall).toEqual([...pair.expected, "--dry-run"]);
      expect(applyCall).toEqual(pair.expected);
      if (pair.expected.includes("--codex-binary")) {
        expect(isAbsolute(preview.calls[0]![preview.calls[0]!.indexOf("--codex-binary") + 1] ?? "")).toBe(true);
        expect(isAbsolute(apply.calls[0]![apply.calls[0]!.indexOf("--codex-binary") + 1] ?? "")).toBe(true);
      }
    }
  });

  test("native configure omits source-root while Skizzles configure uses this checkout", () => {
    const native = invokeJust(["configure-preview", "TARGET", "aggressive", "native"]);
    const skizzles = invokeJust(["configure-preview", "TARGET", "aggressive", "skizzles"]);
    const skizzlesApply = invokeJust(["configure-apply", "TARGET", "aggressive", "skizzles"]);
    expect(native.exitCode).toBe(0);
    expect(skizzles.exitCode).toBe(0);
    expect(skizzlesApply.exitCode).toBe(0);
    expect(native.calls[0]).not.toContain("--source-root");
    expect(skizzles.calls[0]).toContain("--source-root");
    expect(skizzles.calls[0]![skizzles.calls[0]!.indexOf("--source-root") + 1]).toBe(repositoryRoot);
    expect(skizzlesApply.calls[0]).toContain("--source-root");
    expect(skizzlesApply.calls[0]![skizzlesApply.calls[0]!.indexOf("--source-root") + 1]).toBe(repositoryRoot);
    expect(skizzlesApply.calls[0]).not.toContain("--dry-run");
  });

  test("absolute target and enum gates reject before fake Bun dispatch", () => {
    const invalid = [
      ["skills-install-preview", "relative"],
      ["skills-install-apply", "relative"],
      ["harness-install-preview", "relative"],
      ["harness-install-apply", "relative"],
      ["skills-uninstall-preview", "relative"],
      ["skills-uninstall-apply", "relative"],
      ["harness-uninstall-preview", "relative"],
      ["harness-uninstall-apply", "relative"],
      ["configure-preview", "relative", "passive", "native"],
      ["configure-apply", "relative", "passive", "native"],
      ["unconfigure-preview", "relative"],
      ["unconfigure-apply", "relative"],
      ["install-doctor", "relative", "/tmp/codex"],
      ["install-doctor", "/tmp/home", "relative"],
      ["skills-install-preview", "TARGET", "invalid-transfer"],
      ["configure-preview", "TARGET", "invalid-orchestration", "native"],
      ["configure-preview", "TARGET", "passive", "invalid-instructions"],
      ["configure-preview", "TARGET", "passive", "native", "missing-codex"],
      ["unconfigure-preview", "TARGET", "missing-codex"],
    ];

    for (const args of invalid) {
      const result = invokeJust(args);
      expect(result.exitCode).toBe(2);
      expect(result.calls).toEqual([]);
    }
  });
});

function invokeJust(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "skizzles-justfile-workflow-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const capture = join(root, "bun-argv.tsv");
  const target = join(root, "target home");
  const codex = join(bin, "codex");
  const bun = join(bin, "bun");
  mkdirSync(bin);
  writeFileSync(capture, "");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n");
  writeFileSync(bun, "#!/bin/sh\nprintf '%s\\t' \"$@\" >> \"$CAPTURE\"\nprintf '\\n' >> \"$CAPTURE\"\n");
  chmodSync(codex, 0o755);
  chmodSync(bun, 0o755);
  const substituted = args.map((arg) => arg === "TARGET" ? target : arg);
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, CAPTURE: capture };
  delete environment.CODEX_BIN;
  const result = Bun.spawnSync({
    cmd: ["just", "--justfile", justfile, ...substituted],
    cwd: root,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    calls: capturedCalls(capture),
    target,
    codex,
  };
}

function capturedCalls(capture: string): string[][] {
  return readFileSync(capture, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").slice(0, -1));
}

function normalizePlaceholders(call: string[], result: ReturnType<typeof invokeJust>): string[] {
  return call.map((value) => value === result.target ? "TARGET" : value === result.codex ? "CODEX_BINARY" : value);
}
