import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_NAME = "skizzles";
export const TEMPLATE_PATH = "packages/skizzles-plugin/plugin-template";
export const GENERATED_PATH = `plugins/${PLUGIN_NAME}`;
export const MARKETPLACE_PATH = ".agents/plugins/marketplace.json";

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

function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}
