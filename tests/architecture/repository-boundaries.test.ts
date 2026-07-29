import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const generatedPrefixes = ["assets/agents/", "plugins/skizzles/"];
const forbiddenPackageModules = new Set([
  "core.ts",
  "helpers.ts",
  "service.ts",
  "types.ts",
  "utils.ts",
]);
const forbiddenWorkspaceReferences = [
  ["packages", "core"].join("/"),
  ["packages", "installer"].join("/"),
  ["packages", "codex-container-lab"].join("/"),
  ["@skizzles", "core"].join("/"),
  ["codex-container-lab", "workspace:"].join("@"),
];

describe("repository architecture boundaries", () => {
  test("workspace packages use one flat skizzles namespace", async () => {
    const rootManifest = await readJson(join(repositoryRoot, "package.json"));
    expect(rootManifest.workspaces).toEqual(["packages/skizzles-*"]);

    const packagesRoot = join(repositoryRoot, "packages");
    const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(packageDirectories.length).toBeGreaterThan(0);
    for (const directory of packageDirectories) {
      expect(directory).toMatch(/^skizzles-[a-z0-9]+(?:-[a-z0-9]+)*$/);
      const packageRoot = join(packagesRoot, directory);
      const manifest = await readJson(join(packageRoot, "package.json"));
      expect(manifest.name).toMatch(/^@skizzles\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(await nestedPackageManifests(packageRoot)).toEqual([]);
    }
  });

  test("authored TypeScript stays reviewable and uses capability names", async () => {
    const violations: string[] = [];
    for (const path of await authoredFiles()) {
      if (!path.endsWith(".ts")) continue;
      const name = path.split("/").at(-1)!;
      if (path.startsWith("packages/") && forbiddenPackageModules.has(name)) {
        violations.push(`${path}: generic package module name`);
      }
      const source = await readFile(join(repositoryRoot, path), "utf8");
      const lines = physicalLines(source);
      if (lines > 450) violations.push(`${path}: ${lines} lines`);
    }
    expect(violations).toEqual([]);
  });

  test("Container Lab source root exposes only executable entrypoints", async () => {
    const sourceRoot = join(
      repositoryRoot,
      "packages",
      "skizzles-container-lab",
      "src",
    );
    const rootTypeScript = (await readdir(sourceRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();
    expect(rootTypeScript).toEqual(["cli.ts", "reaper-cli.ts"]);
  });

  test("cross-package consumers use declared public surfaces", async () => {
    const violations: string[] = [];
    for (const path of await authoredFiles()) {
      if (!path.endsWith(".ts")) continue;
      const source = await readFile(join(repositoryRoot, path), "utf8");
      if (/(?:from|import)\s*\(?["'][^"']*packages\/skizzles-[^"']+\/src\//.test(source)) {
        violations.push(path);
      }
    }
    expect(violations).toEqual([]);
  });

  test("authored files contain no exact duplicates or oversized artifacts", async () => {
    const hashes = new Map<string, string>();
    const duplicates: string[] = [];
    const oversized: string[] = [];

    for (const path of await authoredFiles()) {
      const content = await readFile(join(repositoryRoot, path));
      if (content.byteLength > 1024 * 1024) {
        oversized.push(`${path}: ${content.byteLength} bytes`);
      }
      if (content.byteLength === 0) continue;
      const hash = createHash("sha256").update(content).digest("hex");
      const owner = hashes.get(hash);
      if (owner) duplicates.push(`${owner} == ${path}`);
      else hashes.set(hash, path);
    }

    expect(oversized).toEqual([]);
    expect(duplicates).toEqual([]);
  });

  test("authored contracts do not retain obsolete workspace paths", async () => {
    const violations: string[] = [];
    for (const path of await authoredFiles()) {
      const content = await readFile(join(repositoryRoot, path));
      if (content.includes(0)) continue;
      const text = content.toString("utf8");
      for (const reference of forbiddenWorkspaceReferences) {
        if (text.includes(reference)) violations.push(`${path}: ${reference}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

async function authoredFiles(): Promise<string[]> {
  const result = Bun.spawnSync([
    "git",
    "-C",
    repositoryRoot,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git inventory failed: ${result.stderr.toString("utf8").trim()}`);
  }

  const inventory = result.stdout.toString("utf8")
    .split("\0")
    .filter((path) => path !== "")
    .filter((path) => !generatedPrefixes.some((prefix) => path.startsWith(prefix)))
    .sort((left, right) => left.localeCompare(right, "en"));
  const files: string[] = [];
  for (const path of inventory) {
    try {
      if ((await lstat(join(repositoryRoot, path))).isFile()) files.push(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return files;
}

async function nestedPackageManifests(packageRoot: string): Promise<string[]> {
  const manifests: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === "package.json" && dirname(path) !== packageRoot) {
        manifests.push(relative(packageRoot, path).split(sep).join("/"));
      }
    }
  };
  await visit(packageRoot);
  return manifests.sort();
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error(`${path} must be a regular file`);
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function physicalLines(source: string): number {
  if (source === "") return 0;
  const breaks = source.match(/\n/g)?.length ?? 0;
  return source.endsWith("\n") ? breaks : breaks + 1;
}
