import { GENERATED_PATH } from "./artifact-layout.ts";
import { PackagingError } from "./packaging-error.ts";
import { buildPlugin, checkPlugin } from "./staging-pipeline.ts";

export { packagePaths } from "./artifact-layout.ts";
export type { PackagePaths } from "./artifact-layout.ts";
export { PackagingError } from "./packaging-error.ts";
export { buildPlugin, checkPlugin, stagePlugin } from "./staging-pipeline.ts";
export { compareTrees } from "./tree-comparison.ts";

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
  throw new PackagingError(
    "Usage: bun run packages/skizzles-plugin/src/plugin-package.ts <build|check>",
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
