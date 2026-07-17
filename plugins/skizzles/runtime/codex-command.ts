#!/usr/bin/env bun

import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

type StreamName = "stdout" | "stderr";

type RunStatus = {
  id: string;
  command: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  signal?: string;
  shell: string;
  stdoutObservedBytes: number;
  stderrObservedBytes: number;
  stdoutStoredBytes: number;
  stderrStoredBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  artifactCapture: "active" | "unavailable";
  drainIncomplete: boolean;
};

const defaultMaximumBytes = 16 * 1024 * 1024;
const defaultMaximumDiskBytes = 256 * 1024 * 1024;
const defaultHeartbeatMilliseconds = 30_000;
const defaultDrainMilliseconds = 750;
const defaultInlineBytes = 10 * 1024;
const tailBytes = 1_200;

function integerEnvironment(name: string, fallback: number, minimum: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function runRoot(): string {
  if (process.env.CODEX_COMMAND_OUTPUT_DIR) return process.env.CODEX_COMMAND_OUTPUT_DIR;
  const candidate = resolve(tmpdir());
  const cwd = resolve(process.cwd());
  const fromWorkingTree = relative(cwd, candidate);
  const safeTemporaryDirectory = fromWorkingTree === "" || (!fromWorkingTree.startsWith("..") && !isAbsolute(fromWorkingTree))
    ? "/tmp"
    : candidate;
  return join(safeTemporaryDirectory, "codex-command-output");
}

/** Uses the invoking shell only when it is an absolute executable with familiar
 * `-c` semantics. /bin/sh is the portable, non-recursive fallback. */
function commandShell(): string {
  const candidate = process.env.SHELL;
  if (candidate && isAbsolute(candidate) && ["bash", "dash", "ksh", "sh", "zsh"].includes(basename(candidate))) {
    try {
      accessSync(candidate, constants.X_OK);
      if (resolve(candidate) !== resolve(process.argv[1] ?? "")) return candidate;
    } catch {}
  }
  return "/bin/sh";
}

function runId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function usage(): never {
  console.error("usage: codex-command run --base64url <script> | status <run-id> | tail <run-id> [stdout|stderr] | errors <run-id> | search <text> [run-id]");
  process.exit(64);
}

function decodeScript(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("encoded script is not base64url");
  const result = Buffer.from(value, "base64url").toString("utf8");
  if (!result || Buffer.from(result, "utf8").toString("base64url") !== value) {
    throw new Error("encoded script is invalid");
  }
  return result;
}

function ensureRunDirectory(root: string, id: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const directory = join(root, id);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function cleanOldRuns(root: string, limit: number): void {
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = join(root, entry.name);
        const info = statSync(path);
        let size = 0;
        for (const file of readdirSync(path)) {
          try {
            const candidate = join(path, file);
            if (statSync(candidate).isFile()) size += statSync(candidate).size;
          } catch {}
        }
        return { path, mtime: info.mtimeMs, size };
      })
      .sort((left, right) => left.mtime - right.mtime);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= limit) break;
      rmSync(entry.path, { recursive: true, force: true });
      total -= entry.size;
    }
  } catch {
    // Cleanup is best effort; a run must still be able to execute.
  }
}

function createArtifact(path: string): number {
  return openSync(path, "wx", 0o600);
}

function closeArtifact(file: number | undefined): void {
  if (file === undefined) return;
  try {
    closeSync(file);
  } catch {}
}

function writeStatus(path: string, status: RunStatus): void {
  try {
    writeFileSync(path, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {}
}

function tail(path: string): string {
  try {
    const content = readFileSync(path);
    return content.subarray(Math.max(0, content.length - tailBytes)).toString("utf8");
  } catch {
    return "";
  }
}

function capture(
  stream: ReadableStream<Uint8Array> | null,
  streamName: StreamName,
  artifact: number | undefined,
  maximumBytes: number,
  forward: boolean,
  state: { observedBytes: number; storedBytes: number; truncated: boolean; finished: boolean },
): { done: Promise<void>; cancel: () => Promise<void> } {
  if (!stream) {
    state.finished = true;
    return { done: Promise.resolve(), cancel: async () => {} };
  }
  const reader = stream.getReader();
  const done = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        state.observedBytes += chunk.length;
        if (forward) {
          (streamName === "stdout" ? process.stdout : process.stderr).write(chunk);
        }
        if (artifact !== undefined) {
          const remaining = maximumBytes - state.storedBytes;
          if (remaining > 0) {
            const stored = chunk.subarray(0, remaining);
            try {
              const written = writeSync(artifact, stored);
              state.storedBytes += written;
              if (written !== chunk.length) state.truncated = true;
            } catch {
              state.truncated = true;
            }
          } else {
            state.truncated = true;
          }
        }
      }
    } catch {
      state.truncated = true;
    } finally {
      state.finished = true;
      reader.releaseLock();
    }
  })();
  return { done, cancel: () => reader.cancel().catch(() => {}) };
}

function artifactContents(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function printCaptured(label: string, content: string): void {
  if (!content) return;
  process.stdout.write(`[codex-command] ${label}:\n${content}`);
  if (!content.endsWith("\n")) process.stdout.write("\n");
}

async function run(script: string): Promise<number> {
  const root = runRoot();
  const id = runId();
  const maximumBytes = integerEnvironment("CODEX_COMMAND_MAX_BYTES", defaultMaximumBytes, 1);
  const heartbeatMilliseconds = integerEnvironment("CODEX_COMMAND_HEARTBEAT_MS", defaultHeartbeatMilliseconds, 25);
  const drainMilliseconds = integerEnvironment("CODEX_COMMAND_DRAIN_MS", defaultDrainMilliseconds, 0);
  const inlineBytes = integerEnvironment("CODEX_COMMAND_INLINE_BYTES", defaultInlineBytes, 0);
  let directory: string | undefined;
  let stdoutFile: number | undefined;
  let stderrFile: number | undefined;
  let statusPath: string | undefined;
  let artifactsAvailable = true;

  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    cleanOldRuns(root, integerEnvironment("CODEX_COMMAND_MAX_DISK_BYTES", defaultMaximumDiskBytes, maximumBytes));
    directory = ensureRunDirectory(root, id);
    stdoutFile = createArtifact(join(directory, "stdout.log"));
    stderrFile = createArtifact(join(directory, "stderr.log"));
    statusPath = join(directory, "status.json");
  } catch (error) {
    closeArtifact(stdoutFile);
    closeArtifact(stderrFile);
    stdoutFile = undefined;
    stderrFile = undefined;
    artifactsAvailable = false;
    console.error(`[codex-command] warning: artifact capture unavailable (${error instanceof Error ? error.message : "unknown error"}); supervising without artifacts`);
  }

  const visiblePath = directory ?? "unavailable";
  const shell = commandShell();
  const status: RunStatus = {
    id,
    command: script,
    startedAt: new Date().toISOString(),
    shell,
    stdoutObservedBytes: 0,
    stderrObservedBytes: 0,
    stdoutStoredBytes: 0,
    stderrStoredBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    artifactCapture: artifactsAvailable ? "active" : "unavailable",
    drainIncomplete: false,
  };
  if (statusPath) writeStatus(statusPath, status);
  console.log(`[codex-command] artifact: ${visiblePath}`);
  console.log("| seconds | out | err |");

  let child: Bun.Subprocess<"inherit", "pipe", "pipe">;
  const processStartedAt = performance.now();
  try {
    child = Bun.spawn([shell, "-c", script], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    status.completedAt = new Date().toISOString();
    status.exitCode = 127;
    if (statusPath) writeStatus(statusPath, status);
    closeArtifact(stdoutFile);
    closeArtifact(stderrFile);
    console.error(`[codex-command] unable to start command: ${error instanceof Error ? error.message : "unknown error"}`);
    return 127;
  }

  let signal: "SIGINT" | "SIGTERM" | "SIGHUP" | undefined;
  const forwardSignal = (received: typeof signal) => {
    signal = received;
    try {
      child.kill(received);
    } catch {}
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.on("SIGHUP", () => forwardSignal("SIGHUP"));

  const shouldForward = !artifactsAvailable || Boolean(process.stdout.isTTY || process.stderr.isTTY);
  const stdoutState = { observedBytes: 0, storedBytes: 0, truncated: false, finished: false };
  const stderrState = { observedBytes: 0, storedBytes: 0, truncated: false, finished: false };
  const stdoutCapture = capture(child.stdout, "stdout", stdoutFile, maximumBytes, shouldForward, stdoutState);
  const stderrCapture = capture(child.stderr, "stderr", stderrFile, maximumBytes, shouldForward, stderrState);
  let lastReportedStdoutBytes = 0;
  let lastReportedStderrBytes = 0;
  const reportProgress = () => {
    if (
      stdoutState.observedBytes === lastReportedStdoutBytes &&
      stderrState.observedBytes === lastReportedStderrBytes
    ) return;
    const seconds = Math.floor((performance.now() - processStartedAt) / 1_000);
    console.log(`| ${seconds}s | ${stdoutState.observedBytes}B | ${stderrState.observedBytes}B |`);
    lastReportedStdoutBytes = stdoutState.observedBytes;
    lastReportedStderrBytes = stderrState.observedBytes;
  };
  const heartbeat = setInterval(() => {
    status.stdoutObservedBytes = stdoutState.observedBytes;
    status.stderrObservedBytes = stderrState.observedBytes;
    status.stdoutStoredBytes = stdoutState.storedBytes;
    status.stderrStoredBytes = stderrState.storedBytes;
    status.stdoutTruncated = stdoutState.truncated;
    status.stderrTruncated = stderrState.truncated;
    if (statusPath) writeStatus(statusPath, status);
    reportProgress();
  }, heartbeatMilliseconds);
  heartbeat.unref();

  const exitCode = await child.exited;
  await Promise.race([
    Promise.all([stdoutCapture.done, stderrCapture.done]),
    new Promise<void>((resolve) => setTimeout(resolve, drainMilliseconds)),
  ]);
  status.drainIncomplete = !stdoutState.finished || !stderrState.finished;
  if (status.drainIncomplete) {
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
  }
  status.completedAt = new Date().toISOString();
  status.exitCode = exitCode;
  status.signal = signal;
  status.stdoutObservedBytes = stdoutState.observedBytes;
  status.stderrObservedBytes = stderrState.observedBytes;
  status.stdoutStoredBytes = stdoutState.storedBytes;
  status.stderrStoredBytes = stderrState.storedBytes;
  status.stdoutTruncated = stdoutState.truncated;
  status.stderrTruncated = stderrState.truncated;
  clearInterval(heartbeat);
  closeArtifact(stdoutFile);
  closeArtifact(stderrFile);
  if (statusPath) writeStatus(statusPath, status);

  reportProgress();
  if (!shouldForward && artifactsAvailable && directory) {
    const combinedBytes = status.stdoutObservedBytes + status.stderrObservedBytes;
    const printFullOutput = combinedBytes <= inlineBytes && !status.stdoutTruncated && !status.stderrTruncated;
    if (printFullOutput) {
      printCaptured("stdout", artifactContents(join(directory, "stdout.log")));
      printCaptured("stderr", artifactContents(join(directory, "stderr.log")));
    } else {
      printCaptured("stdout tail", tail(join(directory, "stdout.log")));
      printCaptured("stderr tail", tail(join(directory, "stderr.log")));
    }
  }
  if (status.stdoutTruncated || status.stderrTruncated) {
    console.log(
      `[codex-command] retained out=${status.stdoutStoredBytes}/${status.stdoutObservedBytes}B err=${status.stderrStoredBytes}/${status.stderrObservedBytes}B`,
    );
  }
  const outcome = status.signal ? `signal ${status.signal}` : `exit ${status.exitCode ?? "unknown"}`;
  const incomplete = status.drainIncomplete ? " drain-incomplete" : "";
  const elapsedSeconds = Math.floor((performance.now() - processStartedAt) / 1_000);
  console.log(`[codex-command] ${outcome} in ${elapsedSeconds}s${incomplete}`);
  return exitCode;
}

function requireRunDirectory(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid run id");
  const directory = join(runRoot(), id);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`run not found: ${id}`);
  return directory;
}

function statusCommand(id: string): void {
  process.stdout.write(readFileSync(join(requireRunDirectory(id), "status.json"), "utf8"));
}

function tailCommand(id: string, stream: string | undefined): void {
  const selected = stream ?? "stdout";
  if (selected !== "stdout" && selected !== "stderr") throw new Error("stream must be stdout or stderr");
  const filename = selected === "stdout" ? "stdout.log" : "stderr.log";
  const content = tail(join(requireRunDirectory(id), filename));
  process.stdout.write(content);
  if (!content.endsWith("\n")) process.stdout.write("\n");
}

function searchCommand(needle: string, id: string | undefined): void {
  if (!needle || needle.length > 256) throw new Error("search text must be 1-256 characters");
  const directories = id ? [requireRunDirectory(id)] : readdirSync(runRoot()).map((name) => join(runRoot(), name));
  for (const directory of directories) {
    for (const filename of ["stdout.log", "stderr.log"]) {
      const path = join(directory, filename);
      try {
        if (readFileSync(path, "utf8").includes(needle)) console.log(`${directory}/${filename}`);
      } catch {}
    }
  }
}

try {
  const [subcommand, ...arguments_] = process.argv.slice(2);
  if (subcommand === "run") {
    if (arguments_.length !== 2 || arguments_[0] !== "--base64url") usage();
    process.exit(await run(decodeScript(arguments_[1]!)));
  }
  if (subcommand === "status" && arguments_.length === 1) statusCommand(arguments_[0]!);
  else if (subcommand === "tail" && (arguments_.length === 1 || arguments_.length === 2)) tailCommand(arguments_[0]!, arguments_[1]);
  else if (subcommand === "errors" && arguments_.length === 1) tailCommand(arguments_[0]!, "stderr");
  else if (subcommand === "search" && (arguments_.length === 1 || arguments_.length === 2)) searchCommand(arguments_[0]!, arguments_[1]);
  else usage();
} catch (error) {
  console.error(`[codex-command] ${error instanceof Error ? error.message : "unexpected failure"}`);
  process.exit(64);
}
