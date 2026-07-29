import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stagePlugin } from "../src/plugin-package.ts";
import {
  filesUnder,
  PackageTestSandbox,
} from "./package-fixture.ts";

const sandbox = new PackageTestSandbox();
afterEach(() => sandbox.cleanup());

describe("bundled Container Lab runtime", () => {
  test("ships runnable dependency-self-contained entrypoints", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const temporaryRoot = await sandbox.createTemporaryRoot(
      "skizzles-container-lab-plugin-",
    );
    const stagedPlugin = join(temporaryRoot, "staged");
    const isolatedPlugin = join(temporaryRoot, "isolated");
    await stagePlugin(repoRoot, stagedPlugin);
    await cp(stagedPlugin, isolatedPlugin, { recursive: true });

    const runtimeRoot = join(
      isolatedPlugin,
      "packages/skizzles-container-lab",
    );
    expect(await filesUnder(runtimeRoot)).toEqual([
      "LICENSE",
      "docs/architecture.md",
      "docs/completion-contract.md",
      "docs/installation.md",
      "docs/manifest.md",
      "docs/safety.md",
      "install/com.openai.codex-container-lab-reaper.plist",
      "run-contract.ts",
      "src/cli.ts",
      "src/contracts/run.ts",
      "src/reaper-cli.ts",
    ]);

    for (const entrypoint of ["src/cli.ts", "src/reaper-cli.ts"]) {
      const path = join(runtimeRoot, entrypoint);
      expect((await stat(path)).mode & 0o111).not.toBe(0);
      const result = Bun.spawnSync(["bun", path, "--help"], {
        cwd: isolatedPlugin,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const response = JSON.parse(result.stdout.toString()) as { help?: unknown };
      expect(typeof response.help).toBe("string");
      expect(result.stderr.toString()).toBe("");
    }
  });

  test("exercises bundled YAML configuration with a fake Docker binary", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const root = await sandbox.createTemporaryRoot(
      "skizzles-container-lab-bundle-config-",
    );
    const plugin = join(root, "plugin");
    const source = join(root, "source");
    const stateRoot = join(root, "state");
    const runtimeRoot = join(root, "runtime");
    const bin = join(root, "bin");
    await stagePlugin(repoRoot, plugin);
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("config")) console.log(JSON.stringify({ services: { lab: { image: "ubuntu:24.04" } } }));
process.exit(0);
`,
    );
    await chmod(join(bin, "docker"), 0o755);
    await mkdir(source);
    await writeFile(
      join(source, ".codex-container-lab.yaml"),
      "image: { name: ubuntu:24.04, service: lab }\nruntime: { workspace: /workspace, shell: [/bin/sh, -lc] }\n",
    );
    Bun.spawnSync(["git", "init", "-q", source]);
    Bun.spawnSync(["git", "-C", source, "add", "."]);
    Bun.spawnSync([
      "git",
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);

    const result = Bun.spawnSync([
      "bun",
      join(plugin, "packages/skizzles-container-lab/src/cli.ts"),
      "--owner",
      "bundle-yaml",
      "--state-root",
      stateRoot,
      "--runtime-root",
      runtimeRoot,
      "lab",
      "create",
      "--name",
      "yaml",
      "--source",
      source,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const response = JSON.parse(result.stdout.toString()) as {
      labId: string;
      state: string;
    };
    if (response.state !== "ready") {
      const stateFiles = await filesUnder(stateRoot);
      const state = await Promise.all(
        stateFiles.map(async (path) =>
          `${path}: ${await readFile(join(stateRoot, path), "utf8")}`
        ),
      );
      throw new Error(`bundled configuration fixture failed: ${state.join("\\n")}`);
    }
    expect(response).toMatchObject({
      labId: expect.stringMatching(/^yaml-/),
      state: "ready",
    });
  });
});
