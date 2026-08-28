#!/usr/bin/env bun
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(packageRoot, "src/generated");
const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-app-server-types-"));

const selected = [
  "AbsolutePathBuf.ts",
  "ClientInfo.ts",
  "ClientNotification.ts",
  "InitializeCapabilities.ts",
  "InitializeParams.ts",
  "InitializeResponse.ts",
  "RequestId.ts",
  "serde_json/JsonValue.ts",
  "v2/SortDirection.ts",
  "v2/ThreadArchiveParams.ts",
  "v2/ThreadArchiveResponse.ts",
  "v2/ThreadDeleteParams.ts",
  "v2/ThreadDeleteResponse.ts",
  "v2/ThreadListParams.ts",
  "v2/ThreadLoadedListParams.ts",
  "v2/ThreadLoadedListResponse.ts",
  "v2/ThreadSortKey.ts",
  "v2/ThreadSourceKind.ts",
] as const;

try {
  const version = command(["codex", "--version"]).trim();
  command(["codex", "app-server", "generate-ts", "--experimental", "--out", temporaryRoot]);
  rmSync(outputRoot, { recursive: true, force: true });
  for (const relative of selected) {
    const source = join(temporaryRoot, relative);
    const target = join(outputRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, "runtime.json"), `${JSON.stringify({
    codexVersion: version,
    generator: "codex app-server generate-ts --experimental",
    selected,
  }, null, 2)}\n`);
  process.stdout.write(`generated ${selected.length} app-server DTO files from ${version}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function command(argv: string[]): string {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  const stderr = Buffer.from(result.stderr).toString("utf8");
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr.trim()}`);
  return Buffer.from(result.stdout).toString("utf8");
}
