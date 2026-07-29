import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listFiles } from "./file-tree.ts";
import { PackagingError } from "./packaging-error.ts";

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

export async function rejectForbiddenDistributableContent(pluginRoot: string): Promise<void> {
  for (const path of await listFiles(pluginRoot)) {
    const text = (await readFile(join(pluginRoot, path))).toString("utf8");
    const match = MACHINE_PATH_PATTERNS.find((pattern) => pattern.test(text))?.exec(text)?.[0];
    if (match) {
      throw new PackagingError(`${path} contains machine-specific path ${match}.`);
    }
  }
}

export async function rejectFinderMetadata(root: string, label: string): Promise<void> {
  for (const path of await listFiles(root)) {
    if (path.split("/").includes(".DS_Store")) {
      throw new PackagingError(`${label} contains forbidden Finder metadata at ${path}.`);
    }
  }
}

export function assertDistributableName(name: string, path: string): void {
  const lowerName = name.toLowerCase();
  if (
    BLOCKED_NAMES.has(name) ||
    lowerName === ".env" ||
    lowerName.startsWith(".env.") ||
    BLOCKED_CREDENTIAL_NAMES.has(lowerName) ||
    BLOCKED_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))
  ) {
    throw new PackagingError(`${path} looks like local or live state and cannot be packaged.`);
  }
}

export function assertDistributablePath(relativePath: string, label: string): void {
  for (const name of relativePath.split("/")) assertDistributableName(name, label);
}
