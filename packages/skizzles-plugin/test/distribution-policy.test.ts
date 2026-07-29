import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  PackagingError,
  stagePlugin,
} from "../src/plugin-package.ts";
import {
  mutateJson,
  PackageTestSandbox,
  writeFixture,
} from "./package-fixture.ts";

const sandbox = new PackageTestSandbox();
afterEach(() => sandbox.cleanup());

describe("distributable safety and metadata policy", () => {
  test("rejects machine-specific paths", async () => {
    const root = await sandbox.createRepository();
    await writeFixture(
      root,
      "runtime/config.ts",
      "export const path = '/Users/alice/.codex';\n",
    );

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "contains machine-specific path /Users/alice/",
    );
  });

  test("rejects environment and credential artifacts", async () => {
    const root = await sandbox.createRepository();
    await writeFixture(root, "runtime/.env.production", "TOKEN=secret\n");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "looks like local or live state",
    );
  });

  test("validates creator-required manifest metadata", async () => {
    const root = await sandbox.createRepository();
    const manifestPath = join(
      root,
      "packages/skizzles-plugin/plugin-template/.codex-plugin/plugin.json",
    );
    await mutateJson<{ version: string }>(manifestPath, (manifest) => {
      manifest.version = "not-semver";
    });
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "skizzles", version: "not-semver" }),
    );

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "strict semver",
    );
  });

  test("rejects hooks that bypass PLUGIN_ROOT", async () => {
    const root = await sandbox.createRepository();
    await writeFixture(
      root,
      "hooks/hooks.json",
      JSON.stringify({ hooks: [{ command: "bun runtime/hook.ts" }] }),
    );

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "must resolve bundled commands through ${PLUGIN_ROOT}",
    );
  });

  test("rejects live-state artifacts", async () => {
    const root = await sandbox.createRepository();
    await writeFixture(root, "runtime/session.sqlite", "state");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toBeInstanceOf(
      PackagingError,
    );
  });
});
