import { launchDockerRun, terminateDockerRun } from "../compose/attached";
import { destroyLabStack } from "../compose/cleanup";
import type { DockerRunner } from "../compose/docker-runner";
import { runtimeFromLab } from "../compose/runtime";
import { withFileLock } from "../storage/locks";
import type { LabMetadata } from "../storage/records";
import { readLab, writeLab, type StateRoots } from "../storage/state";
import { validateRunInput } from "./run-input";

export type RunOutput = {
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  stdin?: NodeJS.ReadableStream;
};

export type ActivityHeartbeatScheduler = (
  callback: () => Promise<void>,
  intervalMs: number,
) => () => void;

export type AttachedCommandOptions = {
  owner: string;
  roots: StateRoots;
  docker: DockerRunner;
  processEnvironment: NodeJS.ProcessEnv;
  labId: string;
  argv: string[];
  cwd: string;
  environment: Record<string, string>;
  timeoutSeconds: number;
  output: RunOutput;
  signal?: AbortSignal;
  activityLock: string;
  labLock: string;
  reconcileOwner: () => Promise<void>;
  requireReady: () => Promise<LabMetadata>;
  refreshActivity?: () => Promise<void>;
  activityHeartbeatMs?: number;
  startActivityHeartbeat?: ActivityHeartbeatScheduler;
};

export async function runAttachedCommand(options: AttachedCommandOptions): Promise<number> {
  validateRunInput(options.argv, options.cwd, options.environment, options.timeoutSeconds);
  await options.reconcileOwner();
  try {
    return await withFileLock(options.activityLock, async () => {
      if (options.signal?.aborted) return signalExitCode(options.signal);
      const lab = await options.requireReady();
      const runtime = runtimeFromLab(lab);
      for (const key of Object.keys(options.environment)) {
        if (!runtime.config.forwardEnvironment.includes(key)) {
          throw new Error(`run environment is not declared by the manifest: ${key}`);
        }
      }
      const identity = {
        runId: crypto.randomUUID(),
        cwd: options.cwd,
        argv: options.argv,
        environment: options.environment,
      };
      const child = launchDockerRun(runtime, identity, options.docker, options.processEnvironment);
      // The activity lock is held for the full attached command. Launch only
      // after exact validation, then persist the first refresh and heartbeat;
      // a refresh failure never terminates a genuine attached command.
      await options.refreshActivity?.().catch(() => undefined);
      const heartbeatMs = options.activityHeartbeatMs ?? 60_000;
      const stopHeartbeat = options.refreshActivity && heartbeatMs > 0
        ? (options.startActivityHeartbeat ?? startActivityHeartbeat)(async () => {
          await options.refreshActivity!().catch(() => undefined);
        }, heartbeatMs)
        : undefined;
      child.stdout.on("data", options.output.stdout);
      child.stderr.on("data", options.output.stderr);
      options.output.stdin?.pipe(child.stdin);
      let requestedExit: number | undefined;
      let stopping: Promise<void> | undefined;
      const stop = (exitCode: number, first: "INT" | "TERM") => {
        requestedExit ??= exitCode;
        if (!stopping) {
          stopping = stopAttachedCommand(options, lab, identity, child, first);
        }
      };
      const onAbort = () => stop(signalExitCode(options.signal), options.signal?.reason === "SIGINT" ? "INT" : "TERM");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const timeout = options.timeoutSeconds > 0
        ? setTimeout(() => stop(124, "TERM"), options.timeoutSeconds * 1000)
        : undefined;
      try {
        const code = await onceClosed(child);
        if (stopping) await stopping;
        return requestedExit ?? code;
      } finally {
        stopHeartbeat?.();
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        options.output.stdin?.unpipe(child.stdin);
      }
    }, { attempts: 600, delayMs: 50, signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) return signalExitCode(options.signal);
    throw error;
  }
}

function startActivityHeartbeat(callback: () => Promise<void>, intervalMs: number): () => void {
  const timer = setInterval(() => { void callback(); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function stopAttachedCommand(
  options: AttachedCommandOptions,
  lab: LabMetadata,
  identity: { runId: string },
  child: ReturnType<DockerRunner["spawn"]>,
  first: "INT" | "TERM",
): Promise<void> {
  const runtime = runtimeFromLab(lab);
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await terminateDockerRun(runtime, identity, first, options.docker);
    if (result.confirmed) break;
    if (result.status !== "unavailable") break;
    await Bun.sleep(100);
  }
  await Promise.race([onceClosed(child), Bun.sleep(2_000)]);
  if (child.exitCode !== null) return;
  try {
    const final = await terminateDockerRun(runtime, identity, "KILL", options.docker);
    if (!final.confirmed) {
      await destroyLabStack(runtime, options.docker);
      await withFileLock(options.labLock, async () => {
        const current = await readLab(options.roots, options.owner, options.labId);
        if (current.state === "ready") {
          current.state = "failed";
          current.error = "attached command identity became uncertain; the exact lab stack was removed and must be recreated";
          current.updatedAt = new Date().toISOString();
          await writeLab(options.roots, current);
        }
      });
    }
  } finally {
    child.kill("SIGKILL");
  }
}

function signalExitCode(signal?: AbortSignal): number {
  return signal?.reason === "SIGINT" ? 130 : signal?.reason === "SIGTERM" ? 143 : 124;
}

function onceClosed(child: ReturnType<DockerRunner["spawn"]>): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
