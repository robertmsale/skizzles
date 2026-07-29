import { afterEach, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { buildPlugin, checkPlugin } from "../src/plugin-package.ts";
import {
  PackageTestSandbox,
  writeFixture,
} from "./package-fixture.ts";

const sandbox = new PackageTestSandbox();
afterEach(() => sandbox.cleanup());

describe("generated plugin drift detection", () => {
  test("reports unexpected generated files", async () => {
    const root = await sandbox.createRepository();
    await buildPlugin(root);
    await checkPlugin(root);
    await writeFixture(root, "plugins/skizzles/unexpected.txt", "drift\n");

    expect(checkPlugin(root)).rejects.toThrow("unexpected unexpected.txt");
  });

  test("reports executable-mode drift", async () => {
    const root = await sandbox.createRepository();
    await writeFixture(root, "runtime/executable.ts", "console.log('ok');\n");
    await chmod(join(root, "runtime/executable.ts"), 0o755);
    await buildPlugin(root);
    await chmod(join(root, "plugins/skizzles/runtime/executable.ts"), 0o644);

    expect(checkPlugin(root)).rejects.toThrow(
      "changed mode runtime/executable.ts",
    );
  });

  test("reports drift in the bundled Container Lab runtime", async () => {
    const root = await sandbox.createRepository();
    await buildPlugin(root);
    await writeFixture(
      root,
      "packages/skizzles-container-lab/src/cli.ts",
      "#!/usr/bin/env bun\nconsole.log(JSON.stringify({ help: 'changed' }));\n",
    );

    expect(checkPlugin(root)).rejects.toThrow(
      "changed packages/skizzles-container-lab/src/cli.ts",
    );
  });

  test("rejects Finder metadata in generated output", async () => {
    const root = await sandbox.createRepository();
    await buildPlugin(root);
    await writeFixture(root, "plugins/skizzles/.DS_Store", "local metadata");

    expect(checkPlugin(root)).rejects.toThrow(
      "generated plugin contains forbidden Finder metadata at .DS_Store",
    );
  });
});
