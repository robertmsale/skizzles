import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareTrees, stagePlugin } from "../src/plugin-package.ts";
import {
  mutateJson,
  PackageTestSandbox,
  runGit,
  writeFixture,
} from "./package-fixture.ts";

interface ContainerLabDescriptor {
  configuredRuntime: string;
  ownership: {
    provenanceCommit: string;
    canonicalSource: string;
  };
}

const sandbox = new PackageTestSandbox();
afterEach(() => sandbox.cleanup());

describe("canonical input staging", () => {
  test("stages allowlisted inputs and the complete installer src tree deterministically", async () => {
    const root = await sandbox.createRepository();
    await writeFixture(
      root,
      "skills/example/SKILL.md",
      "---\nname: example\ndescription: Example skill.\n---\n",
    );
    await writeFixture(
      root,
      "hooks/hooks.json",
      JSON.stringify({
        hooks: [{ command: "bun ${PLUGIN_ROOT}/runtime/hook.ts" }],
      }, null, 2),
    );
    await writeFixture(root, "runtime/hook.ts", "console.log('hook');\n");
    await writeFixture(root, "README.md", "must not be packaged\n");
    await writeFixture(
      root,
      "packages/skizzles-installer/src/modes/skills.ts",
      "export const mode = 'skills';\n",
    );

    const first = join(root, "stage-one");
    const second = join(root, "stage-two");
    await stagePlugin(root, first);
    await stagePlugin(root, second);

    expect(await compareTrees(first, second)).toEqual([]);
    expect(await readFile(join(first, "runtime/hook.ts"), "utf8")).toBe(
      "console.log('hook');\n",
    );
    expect(
      await readFile(
        join(first, "packages/skizzles-installer/src/modes/skills.ts"),
        "utf8",
      ),
    ).toBe("export const mode = 'skills';\n");
    expect(
      await readFile(
        join(first, "packages/skizzles-installer/package.json"),
        "utf8",
      ),
    ).toContain("@skizzles/installer");
    expect(await Bun.file(join(first, "README.md")).exists()).toBe(false);
  });

  test("rejects stale Container Lab descriptor metadata before staging", async () => {
    const root = await sandbox.createRepository();
    await mutateJson<ContainerLabDescriptor>(
      join(root, "integrations/container-lab.json"),
      (descriptor) => {
        descriptor.configuredRuntime = "9.9.9";
      },
    );

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "Container Lab descriptor must match the canonical package metadata and staged plugin inputs",
    );
  });

  test("rejects stale Container Lab provenance and ownership paths", async () => {
    const root = await sandbox.createRepository();
    await mutateJson<ContainerLabDescriptor>(
      join(root, "integrations/container-lab.json"),
      (descriptor) => {
        descriptor.ownership.provenanceCommit =
          "0000000000000000000000000000000000000000";
        descriptor.ownership.canonicalSource = "packages/other-container-lab";
      },
    );

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "Container Lab descriptor must match the canonical package metadata and staged plugin inputs",
    );
  });

  test("honors Git ignore rules in canonical inputs", async () => {
    const root = await sandbox.createRepository();
    await writeFixture(root, "skills/.DS_Store", "local metadata");
    const staged = join(root, "stage");

    await stagePlugin(root, staged);

    expect(await Bun.file(join(staged, "skills/.DS_Store")).exists()).toBe(false);
  });

  test("rejects tracked forbidden metadata", async () => {
    const root = await sandbox.createRepository();
    await writeFixture(root, "skills/.DS_Store", "local metadata");
    runGit(root, "add", "-f", "skills/.DS_Store");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "skills/.DS_Store looks like local or live state",
    );
  });

  test("packages uncommitted tracked content from the working tree", async () => {
    const root = await sandbox.createRepository();
    await writeFixture(root, "skills/example/SKILL.md", "uncommitted edit\n");
    const staged = join(root, "stage");

    await stagePlugin(root, staged);

    expect(await readFile(join(staged, "skills/example/SKILL.md"), "utf8")).toBe(
      "uncommitted edit\n",
    );
  });
});
