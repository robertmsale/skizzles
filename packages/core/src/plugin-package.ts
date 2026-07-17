import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "skizzles";
const TEMPLATE_PATH = "packages/core/plugin-template";
const GENERATED_PATH = `plugins/${PLUGIN_NAME}`;
const MARKETPLACE_PATH = ".agents/plugins/marketplace.json";
const CONTAINER_LAB_SOURCE_PATH = "packages/codex-container-lab";
const CONTAINER_LAB_PROVENANCE = "a2f44416ef467d9f54b3cb228e3bd050987a3c4c";

const CONTAINER_LAB_ENTRYPOINTS = [
  "cli/src/cli.ts",
  "cli/src/reaper-cli.ts",
] as const;

const CONTAINER_LAB_STATIC_INPUTS = [
  "LICENSE",
  "cli/install/com.openai.codex-container-lab-reaper.plist",
  "docs/architecture.md",
  "docs/completion-contract.md",
  "docs/installation.md",
  "docs/manifest.md",
  "docs/safety.md",
] as const;

const CONTAINER_LAB_LAUNCHER = "skills/codex-container-lab/scripts/codex-container-lab";

const CANONICAL_INPUTS = [
  ["skills", "skills"],
  ["hooks", "hooks"],
  ["scripts", "scripts"],
  ["runtime", "runtime"],
  ["integrations", "integrations"],
  ["assets", "assets"],
] as const;

const BLOCKED_NAMES = new Set([
  ".DS_Store",
  ".env",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "node_modules",
]);

const BLOCKED_SUFFIXES = [".db", ".log", ".sqlite", ".sqlite3"];
const BLOCKED_CREDENTIAL_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "service-account.json",
]);
const MACHINE_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/i,
];

export class PackagingError extends Error {}

export interface PackagePaths {
  repoRoot: string;
  templateRoot: string;
  generatedRoot: string;
  marketplacePath: string;
}

export function packagePaths(repoRoot = defaultRepoRoot()): PackagePaths {
  const absoluteRoot = resolve(repoRoot);
  return {
    repoRoot: absoluteRoot,
    templateRoot: join(absoluteRoot, TEMPLATE_PATH),
    generatedRoot: join(absoluteRoot, GENERATED_PATH),
    marketplacePath: join(absoluteRoot, MARKETPLACE_PATH),
  };
}

export async function stagePlugin(repoRoot: string, destination: string): Promise<void> {
  const paths = packagePaths(repoRoot);
  await rm(destination, { force: true, recursive: true });
  await mkdir(destination, { recursive: true });
  await copyCanonicalTree(paths.templateRoot, destination, "plugin template");

  for (const [sourcePath, destinationPath] of CANONICAL_INPUTS) {
    const source = join(paths.repoRoot, sourcePath);
    if (!(await exists(source))) continue;
    await copyCanonicalTree(source, join(destination, destinationPath), sourcePath);
  }

  await stageContainerLabRuntime(paths.repoRoot, destination);

  await validateGeneratedPlugin(paths.repoRoot, destination, paths.marketplacePath);
}

export async function buildPlugin(repoRoot = defaultRepoRoot()): Promise<void> {
  const paths = packagePaths(repoRoot);
  const stageParent = dirname(paths.generatedRoot);
  await mkdir(stageParent, { recursive: true });
  const stagingRoot = await mkdtemp(join(stageParent, `.${PLUGIN_NAME}-stage-`));

  try {
    await stagePlugin(paths.repoRoot, stagingRoot);
    await rm(paths.generatedRoot, { force: true, recursive: true });
    await rename(stagingRoot, paths.generatedRoot);
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }
}

export async function checkPlugin(repoRoot = defaultRepoRoot()): Promise<void> {
  const paths = packagePaths(repoRoot);
  const comparisonRoot = await mkdtemp(join(tmpdir(), `${PLUGIN_NAME}-package-check-`));

  try {
    await stagePlugin(paths.repoRoot, comparisonRoot);
    await rejectFinderMetadata(paths.generatedRoot, "generated plugin");
    const drift = await compareTrees(comparisonRoot, paths.generatedRoot);
    if (drift.length > 0) {
      throw new PackagingError(
        `Generated plugin diverges from canonical sources:\n${drift.map((line) => `- ${line}`).join("\n")}\nRun \`bun run plugin:build\`.`,
      );
    }
  } finally {
    await rm(comparisonRoot, { force: true, recursive: true });
  }
}

export async function compareTrees(expectedRoot: string, actualRoot: string): Promise<string[]> {
  const expectedFiles = await listFiles(expectedRoot);
  const actualFiles = await listFiles(actualRoot);
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const differences: string[] = [];

  for (const path of expectedFiles) {
    if (!actualSet.has(path)) {
      differences.push(`missing ${path}`);
      continue;
    }
    const [expected, actual] = await Promise.all([
      readFile(join(expectedRoot, path)),
      readFile(join(actualRoot, path)),
    ]);
    if (!expected.equals(actual)) differences.push(`changed ${path}`);
    const [expectedMetadata, actualMetadata] = await Promise.all([
      lstat(join(expectedRoot, path)),
      lstat(join(actualRoot, path)),
    ]);
    if ((expectedMetadata.mode & 0o777) !== (actualMetadata.mode & 0o777)) {
      differences.push(`changed mode ${path}`);
    }
  }

  for (const path of actualFiles) {
    if (!expectedSet.has(path)) differences.push(`unexpected ${path}`);
  }

  return differences;
}

async function validateGeneratedPlugin(
  repoRoot: string,
  pluginRoot: string,
  marketplacePath: string,
): Promise<void> {
  const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  const manifest = await readJsonObject(manifestPath, "plugin manifest");
  const rootPackage = await readJsonObject(join(repoRoot, "package.json"), "root package.json");

  if (manifest.name !== PLUGIN_NAME) {
    throw new PackagingError(`Plugin manifest name must be ${PLUGIN_NAME}.`);
  }
  if (manifest.version !== rootPackage.version) {
    throw new PackagingError("Plugin manifest and root package versions must match.");
  }
  await validateManifest(manifest, pluginRoot);
  if ("hooks" in manifest) {
    throw new PackagingError("plugin.json intentionally omits `hooks`; keep the canonical default discovery path at hooks/hooks.json.");
  }

  const marketplace = await readJsonObject(marketplacePath, "marketplace metadata");
  validateMarketplaceEntry(marketplace);

  const hooksPath = join(pluginRoot, "hooks", "hooks.json");
  if (await exists(hooksPath)) {
    const hooks = await readJsonObject(hooksPath, "hooks/hooks.json");
    validateHookCommands(hooks, "hooks/hooks.json");
  }

  await validateContainerLabRuntime(pluginRoot);
  await validateContainerLabDescriptor(repoRoot, pluginRoot);
  await rejectForbiddenDistributableContent(pluginRoot);
}

async function stageContainerLabRuntime(repoRoot: string, pluginRoot: string): Promise<void> {
  const sourceRoot = join(repoRoot, CONTAINER_LAB_SOURCE_PATH);
  const destinationRoot = join(pluginRoot, CONTAINER_LAB_SOURCE_PATH);
  const bundleRoot = join(destinationRoot, "cli", "src");
  await mkdir(bundleRoot, { recursive: true });

  for (const path of CONTAINER_LAB_ENTRYPOINTS) {
    const destination = join(bundleRoot, path.split("/").at(-1)!);
    const build = Bun.spawnSync([
      process.execPath,
      "build",
      join(CONTAINER_LAB_SOURCE_PATH, path),
      "--target=bun",
      "--format=esm",
      `--outfile=${destination}`,
    ], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (build.exitCode !== 0) {
      const details = Buffer.concat([Buffer.from(build.stdout), Buffer.from(build.stderr)]).toString("utf8").trim();
      throw new PackagingError(`Unable to bundle Container Lab runtime ${path}:\n${details}`);
    }
  }

  const bundledFiles = await listFiles(bundleRoot);
  const expectedFiles = CONTAINER_LAB_ENTRYPOINTS.map((path) => path.split("/").at(-1)!);
  if (bundledFiles.length !== expectedFiles.length || expectedFiles.some((path) => !bundledFiles.includes(path))) {
    throw new PackagingError(`Container Lab bundling produced unexpected files: ${bundledFiles.join(", ")}.`);
  }
  await Promise.all(expectedFiles.map((path) => chmod(join(bundleRoot, path), 0o755)));

  for (const path of CONTAINER_LAB_STATIC_INPUTS) {
    await copyCanonicalFile(
      join(sourceRoot, path),
      join(destinationRoot, path),
      `${CONTAINER_LAB_SOURCE_PATH}/${path}`,
    );
  }
}

async function validateContainerLabRuntime(pluginRoot: string): Promise<void> {
  const runtimeRoot = join(pluginRoot, CONTAINER_LAB_SOURCE_PATH);
  for (const path of CONTAINER_LAB_ENTRYPOINTS) {
    const bundledPath = join(runtimeRoot, path);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(bundledPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new PackagingError(`Container Lab runtime is missing ${path}.`);
      }
      throw error;
    }
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new PackagingError(`Container Lab runtime ${path} must be an executable regular file.`);
    }
  }
}

async function validateContainerLabDescriptor(repoRoot: string, pluginRoot: string): Promise<void> {
  const descriptor = await readJsonObject(join(repoRoot, "integrations/container-lab.json"), "Container Lab descriptor");
  const packageMetadata = await readJsonObject(
    join(repoRoot, CONTAINER_LAB_SOURCE_PATH, "cli/package.json"),
    "Container Lab package metadata",
  );
  const bundled = descriptor.bundled;
  const ownership = descriptor.ownership;
  const expectedDocumentation = CONTAINER_LAB_STATIC_INPUTS
    .filter((path) => path.startsWith("docs/"))
    .map((path) => `${CONTAINER_LAB_SOURCE_PATH}/${path}`);
  const expected = {
    operationalEntrypoint: `${CONTAINER_LAB_SOURCE_PATH}/cli/src/cli.ts`,
    reaperEntrypoint: `${CONTAINER_LAB_SOURCE_PATH}/cli/src/reaper-cli.ts`,
    launcher: CONTAINER_LAB_LAUNCHER,
    launchAgentTemplate: `${CONTAINER_LAB_SOURCE_PATH}/cli/install/com.openai.codex-container-lab-reaper.plist`,
  };

  if (
    descriptor.configuredRuntime !== packageMetadata.version ||
    !isObject(ownership) || ownership.runtimeOwner !== "skizzles" || ownership.canonicalSource !== CONTAINER_LAB_SOURCE_PATH ||
    ownership.provenanceCommit !== CONTAINER_LAB_PROVENANCE ||
    !isObject(bundled) || Object.entries(expected).some(([key, value]) => bundled[key] !== value) ||
    !Array.isArray(bundled.documentation) || !sameStrings(bundled.documentation, expectedDocumentation)
  ) {
    throw new PackagingError("Container Lab descriptor must match the canonical package metadata and staged plugin inputs.");
  }

  for (const path of [
    expected.operationalEntrypoint,
    expected.reaperEntrypoint,
    expected.launcher,
    expected.launchAgentTemplate,
    ...expectedDocumentation,
  ]) {
    if (!(await exists(join(repoRoot, path))) || !(await exists(join(pluginRoot, path)))) {
      throw new PackagingError(`Container Lab descriptor path is not a canonical and staged input: ${path}.`);
    }
  }
}

function sameStrings(actual: unknown[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function validateManifest(manifest: Record<string, unknown>, pluginRoot: string): Promise<void> {
  if (typeof manifest.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new PackagingError("Plugin manifest version must be strict semver.");
  }
  if (typeof manifest.description !== "string" || manifest.description.trim() === "") {
    throw new PackagingError("Plugin manifest requires a description.");
  }
  if (!isObject(manifest.author) || typeof manifest.author.name !== "string" || manifest.author.name.trim() === "") {
    throw new PackagingError("Plugin manifest requires author.name.");
  }
  const interfaceValue = manifest.interface;
  if (!isObject(interfaceValue)) throw new PackagingError("Plugin manifest requires interface metadata.");
  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"] as const) {
    if (typeof interfaceValue[field] !== "string" || interfaceValue[field].trim() === "") {
      throw new PackagingError(`Plugin interface requires ${field}.`);
    }
  }
  if (!Array.isArray(interfaceValue.capabilities) || !interfaceValue.capabilities.every((value) => typeof value === "string")) {
    throw new PackagingError("Plugin interface capabilities must be an array of strings.");
  }
  if (!Array.isArray(interfaceValue.defaultPrompt) || interfaceValue.defaultPrompt.length > 3 ||
      !interfaceValue.defaultPrompt.every((value) => typeof value === "string" && value.length <= 128)) {
    throw new PackagingError("Plugin interface defaultPrompt must contain at most three strings of 128 characters or fewer.");
  }
  for (const field of ["composerIcon", "logo", "logoDark"] as const) {
    const value = interfaceValue[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.startsWith("./") || value.includes("..") || !(await exists(join(pluginRoot, value)))) {
      throw new PackagingError(`Plugin interface ${field} must reference an existing bundled file.`);
    }
  }
}

function validateMarketplaceEntry(marketplace: Record<string, unknown>): void {
  const plugins = marketplace.plugins;
  if (!Array.isArray(plugins)) {
    throw new PackagingError("Marketplace metadata must contain a plugins array.");
  }
  const entry = plugins.find(
    (candidate): candidate is Record<string, unknown> =>
      isObject(candidate) && candidate.name === PLUGIN_NAME,
  );
  if (entry === undefined) {
    throw new PackagingError(`Marketplace metadata is missing ${PLUGIN_NAME}.`);
  }
  const source = entry.source;
  if (!isObject(source) || source.source !== "local" || source.path !== `./plugins/${PLUGIN_NAME}`) {
    throw new PackagingError("Marketplace source must be local at ./plugins/skizzles.");
  }
  const policy = entry.policy;
  if (
    !isObject(policy) ||
    !["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(String(policy.installation)) ||
    !["ON_INSTALL", "ON_USE"].includes(String(policy.authentication)) ||
    typeof entry.category !== "string"
  ) {
    throw new PackagingError("Marketplace entry must include installation, authentication, and category metadata.");
  }
}

function validateHookCommands(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateHookCommands(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (key === "command") {
      const commands = typeof item === "string" ? [item] : Array.isArray(item) ? item : [];
      if (commands.length === 0 || !commands.every((command) => typeof command === "string")) {
        throw new PackagingError(`${itemPath} must be a command string or array of command strings.`);
      }
      for (const command of commands) {
        if (!command.includes("${PLUGIN_ROOT}")) {
          throw new PackagingError(`${itemPath} must resolve bundled commands through \${PLUGIN_ROOT}.`);
        }
      }
    }
    validateHookCommands(item, itemPath);
  }
}

async function rejectForbiddenDistributableContent(pluginRoot: string): Promise<void> {
  for (const path of await listFiles(pluginRoot)) {
    const content = await readFile(join(pluginRoot, path));
    const text = content.toString("utf8");
    const match = MACHINE_PATH_PATTERNS.find((pattern) => pattern.test(text))?.exec(text)?.[0];
    if (match) {
      throw new PackagingError(`${path} contains machine-specific path ${match}.`);
    }
  }
}

async function copyCanonicalTree(sourceRoot: string, destinationRoot: string, label: string): Promise<void> {
  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory()) throw new PackagingError(`${label} must be a directory.`);
  await mkdir(destinationRoot, { recursive: true });

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    assertDistributableName(entry.name, `${label}/${entry.name}`);
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    const sourceMetadata = await lstat(source);
    if (sourceMetadata.isSymbolicLink()) {
      throw new PackagingError(`${label}/${entry.name} is a symlink; distributable inputs must be self-contained.`);
    }
    if (sourceMetadata.isDirectory()) {
      await copyCanonicalTree(source, destination, `${label}/${entry.name}`);
    } else if (sourceMetadata.isFile()) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } else {
      throw new PackagingError(`${label}/${entry.name} is not a regular file or directory.`);
    }
  }
}

async function copyCanonicalFile(source: string, destination: string, label: string): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PackagingError(`${label} must be a self-contained regular file.`);
  }
  assertDistributableName(source.split(sep).at(-1)!, label);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, metadata.mode & 0o777);
}

async function rejectFinderMetadata(root: string, label: string): Promise<void> {
  for (const path of await listFiles(root)) {
    if (path.split("/").includes(".DS_Store")) {
      throw new PackagingError(`${label} contains forbidden Finder metadata at ${path}.`);
    }
  }
}

function assertDistributableName(name: string, path: string): void {
  const lowerName = name.toLowerCase();
  if (BLOCKED_NAMES.has(name) || lowerName === ".env" || lowerName.startsWith(".env.") ||
      BLOCKED_CREDENTIAL_NAMES.has(lowerName) || BLOCKED_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))) {
    throw new PackagingError(`${path} looks like local or live state and cannot be packaged.`);
  }
}

async function listFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new PackagingError(`${root} must be a directory.`);
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) throw new PackagingError(`${path} is an unsupported symlink.`);
      if (metadata.isDirectory()) await visit(absolutePath);
      else if (metadata.isFile()) files.push(path);
      else throw new PackagingError(`${path} is not a regular file or directory.`);
    }
  }

  await visit(root);
  return files;
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new PackagingError(`Unable to read ${label} at ${path}: ${String(error)}`);
  }
  if (!isObject(value)) throw new PackagingError(`${label} must contain a JSON object.`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "build") {
    await buildPlugin();
    console.log(`Built ${GENERATED_PATH} from canonical sources.`);
    return;
  }
  if (command === "check") {
    await checkPlugin();
    console.log(`${GENERATED_PATH} matches canonical sources.`);
    return;
  }
  throw new PackagingError("Usage: bun run packages/core/src/plugin-package.ts <build|check>");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
