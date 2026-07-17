import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  buildPlugin,
  checkPlugin,
  compareTrees,
  PackagingError,
  stagePlugin,
} from "../src/plugin-package.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("deterministic plugin packaging", () => {
  test("uses the root lockfile for the Container Lab workspace", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const rootPackage = await Bun.file(join(repoRoot, "package.json")).json() as { workspaces?: unknown };
    expect(rootPackage.workspaces).toContain("packages/codex-container-lab/cli");
    expect(await Bun.file(join(repoRoot, "packages/codex-container-lab/cli/bun.lock")).exists()).toBe(false);
    expect(await readFile(join(repoRoot, "bun.lock"), "utf8")).toContain(
      '"codex-container-lab@workspace:packages/codex-container-lab/cli"',
    );
  });

  test("canonical hook discovery contract uses plugin-root commands", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const hooks = await Bun.file(join(repoRoot, "hooks/hooks.json")).json();

    expect(hooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: 'bun "${PLUGIN_ROOT}/hooks/manage-command-output.ts"',
                timeout: 3,
                statusMessage: "checking command output management",
              },
            ],
          },
        ],
      },
    });
  });

  test("stages only allowlisted canonical inputs deterministically", async () => {
    const root = await fixture();
    await write(root, "skills/example/SKILL.md", "---\nname: example\ndescription: Example skill.\n---\n");
    await write(
      root,
      "hooks/hooks.json",
      JSON.stringify({ hooks: [{ command: "bun ${PLUGIN_ROOT}/runtime/hook.ts" }] }, null, 2),
    );
    await write(root, "runtime/hook.ts", "console.log('hook');\n");
    await write(root, "README.md", "must not be packaged\n");

    const first = join(root, "stage-one");
    const second = join(root, "stage-two");
    await stagePlugin(root, first);
    await stagePlugin(root, second);

    expect(await compareTrees(first, second)).toEqual([]);
    expect(await readFile(join(first, "runtime/hook.ts"), "utf8")).toBe("console.log('hook');\n");
    expect(await readFile(join(first, "packages/installer/src/cli.ts"), "utf8")).toContain("fixture cli");
    expect(await Bun.file(join(first, "README.md")).exists()).toBe(false);
  });

  test("check reports generated drift", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await checkPlugin(root);
    await write(root, "plugins/skizzles/unexpected.txt", "drift\n");

    expect(checkPlugin(root)).rejects.toThrow("unexpected unexpected.txt");
  });

  test("check reports generated executable-mode drift", async () => {
    const root = await fixture();
    await write(root, "runtime/executable.ts", "console.log('ok');\n");
    await chmod(join(root, "runtime/executable.ts"), 0o755);
    await buildPlugin(root);
    await chmod(join(root, "plugins/skizzles/runtime/executable.ts"), 0o644);

    expect(checkPlugin(root)).rejects.toThrow("changed mode runtime/executable.ts");
  });

  test("check reports drift in the bundled Container Lab runtime", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await write(
      root,
      "packages/codex-container-lab/cli/src/cli.ts",
      "#!/usr/bin/env bun\nconsole.log(JSON.stringify({ help: 'changed' }));\n",
    );

    expect(checkPlugin(root)).rejects.toThrow(
      "changed packages/codex-container-lab/cli/src/cli.ts",
    );
  });

  test("ships runnable dependency-self-contained Container Lab bundles", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const temporaryRoot = await mkdtemp(join(tmpdir(), "skizzles-container-lab-plugin-"));
    temporaryRoots.push(temporaryRoot);
    const stagedPlugin = join(temporaryRoot, "staged");
    const isolatedPlugin = join(temporaryRoot, "isolated");
    await stagePlugin(repoRoot, stagedPlugin);
    await cp(stagedPlugin, isolatedPlugin, { recursive: true });

    const runtimeRoot = join(isolatedPlugin, "packages/codex-container-lab");
    expect(await filesUnder(runtimeRoot)).toEqual([
      "LICENSE",
      "cli/install/com.openai.codex-container-lab-reaper.plist",
      "cli/src/cli.ts",
      "cli/src/reaper-cli.ts",
      "docs/architecture.md",
      "docs/completion-contract.md",
      "docs/installation.md",
      "docs/manifest.md",
      "docs/safety.md",
    ]);

    for (const entrypoint of ["cli/src/cli.ts", "cli/src/reaper-cli.ts"]) {
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

  test("exercises bundled YAML manifest configuration with a fake Docker binary", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const root = await mkdtemp(join(tmpdir(), "skizzles-container-lab-bundle-config-"));
    temporaryRoots.push(root);
    const plugin = join(root, "plugin");
    const source = join(root, "source");
    const stateRoot = join(root, "state");
    const runtimeRoot = join(root, "runtime");
    const bin = join(root, "bin");
    await stagePlugin(repoRoot, plugin);
    await mkdir(bin);
    await writeFile(join(bin, "docker"), `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes("config")) console.log(JSON.stringify({ services: { lab: { image: "ubuntu:24.04" } } }));\nprocess.exit(0);\n`);
    await chmod(join(bin, "docker"), 0o755);
    await mkdir(source);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: ubuntu:24.04, service: lab }\nruntime: { workspace: /workspace, shell: [/bin/sh, -lc] }\n");
    Bun.spawnSync(["git", "init", "-q", source]);
    Bun.spawnSync(["git", "-C", source, "add", "."]);
    Bun.spawnSync(["git", "-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);

    const result = Bun.spawnSync([
      "bun", join(plugin, "packages/codex-container-lab/cli/src/cli.ts"),
      "--owner", "bundle-yaml", "--state-root", stateRoot, "--runtime-root", runtimeRoot,
      "lab", "create", "--name", "yaml", "--source", source,
    ], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const response = JSON.parse(result.stdout.toString()) as { labId: string; state: string };
    if (response.state !== "ready") {
      const stateFiles = await filesUnder(stateRoot);
      const state = await Promise.all(stateFiles.map(async (path) => `${path}: ${await readFile(join(stateRoot, path), "utf8")}`));
      throw new Error(`bundled configuration fixture failed: ${state.join("\\n")}`);
    }
    expect(response).toMatchObject({ labId: expect.stringMatching(/^yaml-/), state: "ready" });
  });

  test("rejects stale Container Lab descriptor metadata before staging", async () => {
    const root = await fixture();
    const descriptorPath = join(root, "integrations/container-lab.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.configuredRuntime = "9.9.9";
    await writeFile(descriptorPath, JSON.stringify(descriptor));

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "Container Lab descriptor must match the canonical package metadata and staged plugin inputs",
    );
  });

  test("rejects stale Container Lab provenance and canonical ownership paths before staging", async () => {
    const root = await fixture();
    const descriptorPath = join(root, "integrations/container-lab.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.ownership.provenanceCommit = "0000000000000000000000000000000000000000";
    descriptor.ownership.canonicalSource = "packages/other-container-lab";
    await writeFile(descriptorPath, JSON.stringify(descriptor));

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "Container Lab descriptor must match the canonical package metadata and staged plugin inputs",
    );
  });

  test("rejects Finder metadata in canonical package inputs", async () => {
    const root = await fixture();
    await write(root, "skills/.DS_Store", "local metadata");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "skills/.DS_Store looks like local or live state",
    );
  });

  test("rejects Finder metadata in generated output", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await write(root, "plugins/skizzles/.DS_Store", "local metadata");

    expect(checkPlugin(root)).rejects.toThrow(
      "generated plugin contains forbidden Finder metadata at .DS_Store",
    );
  });

  test("rejects machine-specific paths in distributable output", async () => {
    const root = await fixture();
    await write(root, "runtime/config.ts", "export const path = '/Users/alice/.codex';\n");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "contains machine-specific path /Users/alice/",
    );
  });

  test("rejects environment and credential artifacts", async () => {
    const root = await fixture();
    await write(root, "runtime/.env.production", "TOKEN=secret\n");
    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow("looks like local or live state");
  });

  test("validates creator-required manifest metadata", async () => {
    const root = await fixture();
    const manifestPath = join(root, "packages/core/plugin-template/.codex-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "not-semver";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "skizzles", version: "not-semver" }));
    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow("strict semver");
  });

  test("rejects hooks that bypass PLUGIN_ROOT", async () => {
    const root = await fixture();
    await write(root, "hooks/hooks.json", JSON.stringify({ hooks: [{ command: "bun runtime/hook.ts" }] }));

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "must resolve bundled commands through ${PLUGIN_ROOT}",
    );
  });

  test("rejects live-state artifacts", async () => {
    const root = await fixture();
    await write(root, "runtime/session.sqlite", "state");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toBeInstanceOf(PackagingError);
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-package-test-"));
  temporaryRoots.push(root);
  await write(
    root,
    "package.json",
    JSON.stringify({ name: "skizzles", version: "0.1.0", private: true }, null, 2),
  );
  await write(root, "skills/example/SKILL.md", "---\nname: example\ndescription: Fixture skill.\n---\n");
  await write(
    root,
    "packages/core/plugin-template/.codex-plugin/plugin.json",
    JSON.stringify(
      {
        name: "skizzles",
        version: "0.1.0",
        description: "fixture",
        author: { name: "Fixture" },
        skills: "./skills/",
        interface: {
          displayName: "Skizzles",
          shortDescription: "fixture",
          longDescription: "fixture",
          developerName: "Fixture",
          category: "Developer Tools",
          capabilities: [],
          defaultPrompt: ["Use fixture"],
        },
      },
      null,
      2,
    ),
  );
  await write(
    root,
    ".agents/plugins/marketplace.json",
    JSON.stringify(
      {
        name: "skizzles",
        plugins: [
          {
            name: "skizzles",
            source: { source: "local", path: "./plugins/skizzles" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Developer Tools",
          },
        ],
      },
      null,
      2,
    ),
  );
  await write(
    root,
    "packages/codex-container-lab/cli/src/cli.ts",
    "#!/usr/bin/env bun\nif (import.meta.main) console.log(JSON.stringify({ help: 'fixture cli' }));\n",
  );
  for (const path of ["config.ts", "core.ts", "doctor.ts", "harness.ts"]) {
    await write(root, `packages/installer/src/${path}`, `export const fixture = "${path}";\n`);
  }
  await write(root, "packages/installer/src/cli.ts", "console.log('fixture cli');\n");
  await write(root, "packages/installer/package.json", JSON.stringify({ name: "@skizzles/installer", version: "0.1.0" }));
  await write(
    root,
    "packages/codex-container-lab/cli/src/reaper-cli.ts",
    "#!/usr/bin/env bun\nif (import.meta.main) console.log(JSON.stringify({ help: 'fixture reaper' }));\n",
  );
  await write(root, "packages/codex-container-lab/cli/package.json", JSON.stringify({ name: "codex-container-lab", version: "0.1.0" }));
  await write(
    root,
    "packages/codex-container-lab/cli/install/com.openai.codex-container-lab-reaper.plist",
    "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>\n",
  );
  await write(root, "packages/codex-container-lab/LICENSE", "fixture license\n");
  for (const document of ["architecture", "completion-contract", "installation", "manifest", "safety"]) {
    await write(root, `packages/codex-container-lab/docs/${document}.md`, `# ${document}\n`);
  }
  await write(root, "skills/codex-container-lab/scripts/codex-container-lab", "#!/usr/bin/env bun\nconsole.log('fixture');\n");
  await chmod(join(root, "skills/codex-container-lab/scripts/codex-container-lab"), 0o755);
  await write(root, "integrations/container-lab.json", JSON.stringify({
    configuredRuntime: "0.1.0",
    ownership: {
      runtimeOwner: "skizzles",
      canonicalSource: "packages/codex-container-lab",
      provenanceCommit: "a2f44416ef467d9f54b3cb228e3bd050987a3c4c",
    },
    bundled: {
      operationalEntrypoint: "packages/codex-container-lab/cli/src/cli.ts",
      reaperEntrypoint: "packages/codex-container-lab/cli/src/reaper-cli.ts",
      launcher: "skills/codex-container-lab/scripts/codex-container-lab",
      launchAgentTemplate: "packages/codex-container-lab/cli/install/com.openai.codex-container-lab-reaper.plist",
      documentation: [
        "packages/codex-container-lab/docs/architecture.md",
        "packages/codex-container-lab/docs/completion-contract.md",
        "packages/codex-container-lab/docs/installation.md",
        "packages/codex-container-lab/docs/manifest.md",
        "packages/codex-container-lab/docs/safety.md",
      ],
    },
  }));
  return root;
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath);
      else files.push(relativePath);
    }
  }
  await visit(root);
  return files.sort();
}
