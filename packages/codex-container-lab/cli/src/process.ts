import { spawn } from "node:child_process";

export type CommandResult = { code: number; stdout: Buffer; stderr: Buffer };
export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowFailure?: boolean;
  maxOutputBytes?: number;
  signal?: AbortSignal;
};

export async function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cap = options.maxOutputBytes ?? 4 * 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const collect = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const remaining = cap - current;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return current + chunk.byteLength;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = collect(stdout, chunk, stdoutBytes); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes = collect(stderr, chunk, stderrBytes); });
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = options.timeoutMs ? setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs) : undefined;
    child.once("error", reject);
    child.once("close", (code) => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      const result = { code: code ?? (timedOut ? 124 : 1), stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (options.signal?.aborted) return reject(new Error(`${command} aborted`));
      if (result.code !== 0 && !options.allowFailure) {
        return reject(new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.stderr.toString().trim()}`));
      }
      resolve(result);
    });
  });
}
