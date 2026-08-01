import { spawn } from "node:child_process";

export type OutputCapturePolicy = "head" | "tail";
export type CommandResult = {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};
export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowFailure?: boolean;
  maxOutputBytes?: number;
  stdoutCapture?: OutputCapturePolicy;
  stderrCapture?: OutputCapturePolicy;
  signal?: AbortSignal;
};

type CaptureState = {
  chunks: Buffer[];
  bytes: number;
  totalBytes: number;
  truncated: boolean;
  policy: OutputCapturePolicy;
};

export async function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cap = options.maxOutputBytes ?? 4 * 1024 * 1024;
    const stdout: CaptureState = captureState(options.stdoutCapture);
    const stderr: CaptureState = captureState(options.stderrCapture);
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, cap));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, cap));
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = options.timeoutMs ? setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs) : undefined;
    child.once("error", reject);
    child.once("close", (code) => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      const result = {
        code: code ?? (timedOut ? 124 : 1),
        stdout: Buffer.concat(stdout.chunks),
        stderr: Buffer.concat(stderr.chunks),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
      if (options.signal?.aborted) return reject(new Error(`${command} aborted`));
      if (result.code !== 0 && !options.allowFailure) {
        return reject(new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.stderr.toString().trim()}`));
      }
      resolve(result);
    });
  });
}

function captureState(policy: OutputCapturePolicy | undefined): CaptureState {
  return { chunks: [], bytes: 0, totalBytes: 0, truncated: false, policy: policy ?? "head" };
}

function collect(state: CaptureState, chunk: Buffer, cap: number): void {
  state.totalBytes += chunk.byteLength;
  if (state.totalBytes > cap) state.truncated = true;
  if (cap <= 0) return;
  if (state.policy === "head") {
    const remaining = cap - state.bytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      state.chunks.push(retained);
      state.bytes += retained.byteLength;
    }
    return;
  }
  if (chunk.byteLength >= cap) {
    const retained = Buffer.from(chunk.subarray(chunk.byteLength - cap));
    state.chunks = [retained];
    state.bytes = retained.byteLength;
    return;
  }
  let excess = state.bytes + chunk.byteLength - cap;
  while (excess > 0 && state.chunks.length > 0) {
    const first = state.chunks[0]!;
    if (first.byteLength <= excess) {
      state.chunks.shift();
      state.bytes -= first.byteLength;
      excess -= first.byteLength;
    } else {
      state.chunks[0] = first.subarray(excess);
      state.bytes -= excess;
      excess = 0;
    }
  }
  state.chunks.push(chunk);
  state.bytes += chunk.byteLength;
}
