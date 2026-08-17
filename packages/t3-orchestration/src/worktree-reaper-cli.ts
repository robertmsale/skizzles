#!/usr/bin/env bun
import { daemonRequest } from "./client.ts";
import { configuredRemoteUrl } from "./remote-config.ts";
import { cleanSettledWorktrees, createDefaultReaperDependencies, formatReaperLogs } from "./worktree-reaper.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(JSON.stringify({ help: "t3-worktree-reaper [--dry-run] [--config PATH]\nCleans detected build artifacts from settled or archived T3 worktrees. Does not delete worktrees or source. Host config: ~/.config/skizzles/t3-worktree-reaper.toml" }));
  process.exit(0);
}
let configPath: string | undefined;
const unknown: string[] = [];
for (let index = 0; index < args.length; index++) {
  const argument = args[index]!;
  if (argument === "--dry-run") continue;
  if (argument === "--config") {
    configPath = args[++index];
    if (!configPath || configPath.startsWith("--")) {
      console.error("Missing value for --config");
      process.exit(1);
    }
    continue;
  }
  unknown.push(argument);
}
if (unknown.length) {
  console.error(`Unknown option ${unknown[0]}`);
  process.exit(1);
}

try {
  if (await configuredRemoteUrl()) {
    throw new Error("t3-worktree-reaper is host-local and refuses remote t3ctl mode; it only talks to the existing local t3-orchestrationd socket");
  }
  const { loadReaperConfig } = await import("./worktree-reaper-config.ts");
  const loaded = await loadReaperConfig(configPath);
  const report = await cleanSettledWorktrees(createDefaultReaperDependencies((payload) => daemonRequest(payload)), {
    dryRun: args.includes("--dry-run"),
    config: loaded.config,
    configPath: loaded.path,
  });
  console.log(JSON.stringify({ ...report, log: formatReaperLogs(report) }, null, 2));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
