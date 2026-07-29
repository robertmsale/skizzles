#!/usr/bin/env bun

import { runAnalysis } from "./usage-analyzer/pipeline";

runAnalysis(Bun.argv.slice(2)).catch((error) => {
  console.error(`analyze.ts: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
