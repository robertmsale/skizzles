#!/usr/bin/env bun
import { daemonRequest } from "./client.ts";
import { configuredRemoteUrl } from "./remote-config.ts";
import { cleanSettledWorktrees, createDefaultReaperDependencies, formatReaperLogs } from "./worktree-reaper.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(JSON.stringify({ help: "t3-worktree-reaper [--dry-run]\nCleans cargo/flutter artifacts from settled or archived T3 worktrees. Does not delete worktrees or source." }));
  process.exit(0);
}
const unknown = args.filter((argument) => argument !== "--dry-run");
if (unknown.length) {
  console.error(`Unknown option ${unknown[0]}`);
  process.exit(1);
}

try {
  if (await configuredRemoteUrl()) {
    throw new Error("t3-worktree-reaper is host-local and refuses remote t3ctl mode; it only talks to the existing local t3-orchestrationd socket");
  }
  const report = await cleanSettledWorktrees(createDefaultReaperDependencies((payload) => daemonRequest(payload)), {
    dryRun: args.includes("--dry-run"),
  });
  console.log(JSON.stringify({ ...report, log: formatReaperLogs(report) }, null, 2));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
