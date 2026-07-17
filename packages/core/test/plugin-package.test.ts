import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  test("canonical hook discovery contract uses plugin-root commands", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const hooks = await Bun.file(join(repoRoot, "hooks/hooks.json")).json();

    expect(hooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "spawn_agent|collaboration.spawn_agent|followup_task|collaboration.followup_task",
            hooks: [
              {
                type: "command",
                command: 'bun "${PLUGIN_ROOT}/hooks/guard-agent-spawn.ts"',
                timeout: 5,
                statusMessage: "checking subagent dispatch and lifecycle policy",
              },
            ],
          },
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
        SubagentStart: [
          {
            hooks: [
              {
                type: "command",
                command: 'bun "${PLUGIN_ROOT}/hooks/guard-agent-spawn.ts"',
                timeout: 5,
                statusMessage: "applying subagent ownership and delegation policy",
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
    await write(root, "runtime/config.ts", "export const path = '/Users/robertsale/.codex';\n");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "contains machine-specific path /Users/robertsale",
    );
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
  return root;
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
