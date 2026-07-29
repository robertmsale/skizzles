import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export class PackageTestSandbox {
  readonly #temporaryRoots: string[] = [];

  async createTemporaryRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    this.#temporaryRoots.push(root);
    return root;
  }

  async createRepository(): Promise<string> {
    const root = await this.createTemporaryRoot("skizzles-package-test-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "skizzles", version: "0.1.0", private: true }, null, 2),
    );
    await writeFixture(
      root,
      "skills/example/SKILL.md",
      "---\nname: example\ndescription: Fixture skill.\n---\n",
    );
    await writeFixture(
      root,
      "packages/skizzles-plugin/plugin-template/.codex-plugin/plugin.json",
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
    await writeFixture(
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
    await writeFixture(
      root,
      "packages/skizzles-container-lab/src/cli.ts",
      "#!/usr/bin/env bun\nif (import.meta.main) console.log(JSON.stringify({ help: 'fixture cli' }));\n",
    );
    await writeFixture(
      root,
      "packages/skizzles-container-lab/src/reaper-cli.ts",
      "#!/usr/bin/env bun\nif (import.meta.main) console.log(JSON.stringify({ help: 'fixture reaper' }));\n",
    );
    await writeFixture(
      root,
      "packages/skizzles-container-lab/src/contracts/run.ts",
      "export const fixtureRunContract = true;\n",
    );
    await writeFixture(
      root,
      "packages/skizzles-container-lab/run-contract.ts",
      "export * from \"./src/contracts/run\";\n",
    );
    await writeFixture(
      root,
      "packages/skizzles-container-lab/package.json",
      JSON.stringify({ name: "@skizzles/container-lab", version: "0.1.0" }),
    );
    await writeFixture(
      root,
      "packages/skizzles-container-lab/install/com.openai.codex-container-lab-reaper.plist",
      "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>\n",
    );
    await writeFixture(
      root,
      "packages/skizzles-container-lab/LICENSE",
      "fixture license\n",
    );
    for (
      const document of [
        "architecture",
        "completion-contract",
        "installation",
        "manifest",
        "safety",
      ]
    ) {
      await writeFixture(
        root,
        `packages/skizzles-container-lab/docs/${document}.md`,
        `# ${document}\n`,
      );
    }
    await writeFixture(
      root,
      "packages/skizzles-installer/package.json",
      JSON.stringify({ name: "@skizzles/installer", version: "0.1.0" }),
    );
    await writeFixture(
      root,
      "packages/skizzles-installer/src/cli.ts",
      "console.log('fixture cli');\n",
    );
    for (
      const path of [
        "config.ts",
        "doctor.ts",
        "harness.ts",
        "managed-filesystem.ts",
        "skills-installation.ts",
        "configuration/codex-app-server.ts",
        "configuration/edit-policy.ts",
        "configuration/orchestration.ts",
        "configuration/receipt.ts",
      ]
    ) {
      await writeFixture(
        root,
        `packages/skizzles-installer/src/${path}`,
        `export const fixture = "${path}";\n`,
      );
    }
    await writeFixture(
      root,
      "skills/codex-container-lab/scripts/codex-container-lab",
      "#!/usr/bin/env bun\nconsole.log('fixture');\n",
    );
    await chmod(
      join(root, "skills/codex-container-lab/scripts/codex-container-lab"),
      0o755,
    );
    await writeFixture(
      root,
      "integrations/container-lab.json",
      JSON.stringify({
        configuredRuntime: "0.1.0",
        ownership: {
          runtimeOwner: "skizzles",
          canonicalSource: "packages/skizzles-container-lab",
          provenanceCommit: "a2f44416ef467d9f54b3cb228e3bd050987a3c4c",
        },
        bundled: {
          operationalEntrypoint: "packages/skizzles-container-lab/src/cli.ts",
          reaperEntrypoint: "packages/skizzles-container-lab/src/reaper-cli.ts",
          launcher: "skills/codex-container-lab/scripts/codex-container-lab",
          launchAgentTemplate:
            "packages/skizzles-container-lab/install/com.openai.codex-container-lab-reaper.plist",
          documentation: [
            "packages/skizzles-container-lab/docs/architecture.md",
            "packages/skizzles-container-lab/docs/completion-contract.md",
            "packages/skizzles-container-lab/docs/installation.md",
            "packages/skizzles-container-lab/docs/manifest.md",
            "packages/skizzles-container-lab/docs/safety.md",
          ],
        },
      }),
    );
    await writeFixture(root, ".gitignore", ".DS_Store\n");
    runGit(root, "init", "-q");
    runGit(root, "add", ".");
    return root;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.#temporaryRoots.splice(0).map((path) =>
        rm(path, { force: true, recursive: true })
      ),
    );
  }
}

export function runGit(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
}

export async function writeFixture(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function filesUnder(root: string): Promise<string[]> {
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

export async function mutateJson<Value>(
  path: string,
  mutate: (value: Value) => void,
): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as Value;
  mutate(value);
  await writeFile(path, JSON.stringify(value));
}
