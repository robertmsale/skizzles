import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageCanonicalInputs } from "./canonical-inputs.ts";
import { stageContainerLabRuntime } from "./container-lab.ts";
import { rejectFinderMetadata } from "./distribution-policy.ts";
import { validateGeneratedPlugin } from "./metadata-policy.ts";
import { PackagingError } from "./packaging-error.ts";
import {
  packagePaths,
  PLUGIN_NAME,
  type PackagePaths,
} from "./artifact-layout.ts";
import { compareTrees } from "./tree-comparison.ts";

export async function stagePlugin(repoRoot: string, destination: string): Promise<void> {
  const paths = packagePaths(repoRoot);
  await rm(destination, { force: true, recursive: true });
  await mkdir(destination, { recursive: true });
  await stageCanonicalInputs(paths.repoRoot, destination);
  await stageContainerLabRuntime(paths.repoRoot, destination);
  await validateGeneratedPlugin(
    paths.repoRoot,
    destination,
    paths.marketplacePath,
  );
}

export async function buildPlugin(repoRoot?: string): Promise<void> {
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

export async function checkPlugin(repoRoot?: string): Promise<void> {
  const paths = packagePaths(repoRoot);
  const comparisonRoot = await mkdtemp(
    join(tmpdir(), `${PLUGIN_NAME}-package-check-`),
  );

  try {
    await stagePlugin(paths.repoRoot, comparisonRoot);
    await rejectFinderMetadata(paths.generatedRoot, "generated plugin");
    const drift = await compareTrees(comparisonRoot, paths.generatedRoot);
    if (drift.length > 0) {
      throw new PackagingError(
        `Generated plugin diverges from canonical sources:\n${
          drift.map((line) => `- ${line}`).join("\n")
        }\nRun \`bun run plugin:build\`.`,
      );
    }
  } finally {
    await rm(comparisonRoot, { force: true, recursive: true });
  }
}

export { packagePaths };
export type { PackagePaths };
