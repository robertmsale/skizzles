import { spawn } from "node:child_process";

export type CommandResult = { code: number; stdout: Buffer; stderr: Buffer };
export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowFailure?: boolean;
  maxOutputBytes?: number;
  rejectOnOutputLimit?: boolean;
  signal?: AbortSignal;
};

export async function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const ownsProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: ownsProcessGroup,
    });
    const cap = options.maxOutputBytes ?? 4 * 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let cleanupStarted = false;
    let cleanupSignalSent = false;
    let forceKillSent = false;
    let cleanupError: Error | undefined;
    let outputOverflow: "stdout" | "stderr" | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const signalTree = (signal: NodeJS.Signals): boolean => {
      try {
        if (ownsProcessGroup && child.pid !== undefined) {
          process.kill(-child.pid, signal);
          return true;
        }
        return child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        cleanupError = new Error(
          `${command} cleanup failed sending ${signal}: ${(error as Error).message}`,
        );
        return false;
      }
    };
    const terminate = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      if (!ownsProcessGroup) {
        forceKillSent = true;
        signalTree("SIGKILL");
        return;
      }
      if (signalTree("SIGTERM")) {
        cleanupSignalSent = true;
        forceKill = setTimeout(() => {
          forceKillSent = true;
          signalTree("SIGKILL");
        }, 100);
      }
    };
    const collect = (
      stream: "stdout" | "stderr",
      chunks: Buffer[],
      chunk: Buffer,
      current: number,
    ): number => {
      const remaining = cap - current;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      const next = current + chunk.byteLength;
      if (options.rejectOnOutputLimit && next > cap && outputOverflow === undefined) {
        outputOverflow = stream;
        terminate();
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = collect("stdout", stdout, chunk, stdoutBytes); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes = collect("stderr", stderr, chunk, stderrBytes); });
    const abort = () => terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = options.timeoutMs ? setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs) : undefined;
    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", terminate);
    child.once("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (cleanupSignalSent && !forceKillSent) {
        forceKillSent = true;
        signalTree("SIGKILL");
      }
      options.signal?.removeEventListener("abort", abort);
      if (cleanupError) return reject(cleanupError);
      if (outputOverflow) {
        return reject(new Error(`${command} ${outputOverflow} exceeded ${cap} byte output limit`));
      }
      const result = {
        code: code ?? (timedOut ? 124 : 1),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (options.signal?.aborted) return reject(new Error(`${command} aborted`));
      if (result.code !== 0 && !options.allowFailure) {
        return reject(new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.stderr.toString().trim()}`));
      }
      resolve(result);
    });
  });
}
