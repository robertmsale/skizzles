import { spawn } from "node:child_process";

type LifecycleOptions = {
  repoRoot: string;
  serverName: string;
};

type LifecycleSnapshot = {
  ok: boolean;
  server: string;
  repoRoot: string;
  startedAt: string;
  stack: "disabled" | "started" | "stopped" | "failed";
  detail?: string;
};

export type ProjectLifecycle = {
  start: () => Promise<void>;
  cleanup: () => Promise<void>;
  snapshot: (verbose?: boolean) => LifecycleSnapshot;
};

export function createLifecycle(options: LifecycleOptions): ProjectLifecycle {
  let started = false;
  let cleaned = false;
  let stack: LifecycleSnapshot["stack"] = "disabled";
  let detail: string | undefined;
  const startedAt = new Date().toISOString();

  async function runLifecycleCommand(command: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, {
        cwd: options.repoRoot,
        shell: true,
        stdio: ["ignore", "ignore", "pipe"],
      });

      child.stderr.on("data", (chunk: Buffer) => {
        console.error(`[${options.serverName}] ${chunk.toString().trimEnd()}`);
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`lifecycle command failed with exit code ${code}`));
      });
    });
  }

  async function start(): Promise<void> {
    if (started) {
      return;
    }
    started = true;

    const startCommand = process.env.MCP_STACK_START;
    if (!startCommand) {
      return;
    }

    try {
      await runLifecycleCommand(startCommand);
      stack = "started";
    } catch (error) {
      stack = "failed";
      detail = error instanceof Error ? error.message : String(error);
      console.error(`[${options.serverName}] stack start failed: ${detail}`);
      throw error;
    }
  }

  async function cleanup(): Promise<void> {
    if (cleaned) {
      return;
    }
    cleaned = true;

    const stopCommand = process.env.MCP_STACK_STOP;
    if (!stopCommand) {
      return;
    }

    try {
      await runLifecycleCommand(stopCommand);
      stack = "stopped";
    } catch (error) {
      stack = "failed";
      detail = error instanceof Error ? error.message : String(error);
      console.error(`[${options.serverName}] stack cleanup failed: ${detail}`);
    }
  }

  function snapshot(verbose = false): LifecycleSnapshot {
    const result: LifecycleSnapshot = {
      ok: stack !== "failed",
      server: options.serverName,
      repoRoot: options.repoRoot,
      startedAt,
      stack,
    };
    if (verbose && detail) {
      result.detail = detail;
    }
    return result;
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      cleanup()
        .catch((error) => {
          console.error(`[${options.serverName}] cleanup failed: ${error}`);
        })
        .finally(() => process.exit(0));
    });
  }

  process.once("beforeExit", () => {
    if (!cleaned) {
      void cleanup();
    }
  });

  return { start, cleanup, snapshot };
}
