#!/usr/bin/env bun
import { resolve } from "node:path";

const env = { ...process.env };
if (env.OMP_ORCHESTRATION_HTTP_PORT && !env.OMP_ORCHESTRATION_HTTP_TOKEN) {
  const token = Bun.spawnSync([
    "security", "find-generic-password", "-s", "skizzles-omp-orchestration", "-a", "http-token", "-w",
  ], { stdout: "pipe", stderr: "pipe" });
  if (token.exitCode !== 0 || !token.stdout.toString().trim()) {
    process.stderr.write("OMP HTTP ingress is enabled but its Keychain token is unavailable\n");
    process.exit(1);
  }
  env.OMP_ORCHESTRATION_HTTP_TOKEN = token.stdout.toString().trim();
}

const daemon = resolve(import.meta.dir, "../src/daemon.ts");
const child = Bun.spawn([process.execPath, daemon], { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
