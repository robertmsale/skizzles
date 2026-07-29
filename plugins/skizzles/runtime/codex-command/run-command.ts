import { accessSync, constants } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  closeArtifactFile,
  commandOutputRoot,
  prepareRunArtifacts,
  readArtifact,
  readArtifactTail,
  type RunStatus,
  writeRunStatus,
} from "./artifact-store.ts";
import {
  captureOutput,
  initialCaptureState,
  printCapturedOutput,
} from "./output-capture.ts";
import { type ManagedChild, superviseProcessTree } from "./process-supervisor.ts";

const defaultMaximumBytes = 16 * 1024 * 1024;
const defaultMaximumDiskBytes = 256 * 1024 * 1024;
const defaultHeartbeatMilliseconds = 30_000;
const defaultDrainMilliseconds = 750;
const defaultInlineBytes = 10 * 1024;
const defaultSignalGraceMilliseconds = 750;
const maximumSignalGraceMilliseconds = 60_000;
const captureCancellationMilliseconds = 25;

export async function runManagedCommand(script: string): Promise<number> {
  const root = commandOutputRoot();
  const id = runId();
  const maximumBytes = integerEnvironment("CODEX_COMMAND_MAX_BYTES", defaultMaximumBytes, 1);
  const heartbeatMilliseconds = integerEnvironment(
    "CODEX_COMMAND_HEARTBEAT_MS",
    defaultHeartbeatMilliseconds,
    25,
  );
  const drainMilliseconds = integerEnvironment(
    "CODEX_COMMAND_DRAIN_MS",
    defaultDrainMilliseconds,
    0,
  );
  const inlineBytes = integerEnvironment("CODEX_COMMAND_INLINE_BYTES", defaultInlineBytes, 0);
  const signalGraceMilliseconds = integerEnvironment(
    "CODEX_COMMAND_SIGNAL_GRACE_MS",
    defaultSignalGraceMilliseconds,
    0,
    maximumSignalGraceMilliseconds,
  );
  const artifacts = prepareRunArtifacts(
    root,
    id,
    integerEnvironment("CODEX_COMMAND_MAX_DISK_BYTES", defaultMaximumDiskBytes, maximumBytes),
  );
  if (!artifacts.available) {
    console.error(
      `[codex-command] warning: artifact capture unavailable (${
        artifacts.error instanceof Error ? artifacts.error.message : "unknown error"
      }); supervising without artifacts`,
    );
  }

  const visiblePath = artifacts.directory ?? "unavailable";
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
    artifactCapture: artifacts.available ? "active" : "unavailable",
    drainIncomplete: false,
  };
  if (artifacts.statusPath) writeRunStatus(artifacts.statusPath, status);
  console.log(`[codex-command] artifact: ${visiblePath}`);
  console.log("| seconds | out | err |");

  let child: ManagedChild;
  const processStartedAt = performance.now();
  try {
    child = Bun.spawn([shell, "-c", script], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch (error) {
    status.completedAt = new Date().toISOString();
    status.exitCode = 127;
    if (artifacts.statusPath) writeRunStatus(artifacts.statusPath, status);
    closeArtifactFile(artifacts.stdoutFile);
    closeArtifactFile(artifacts.stderrFile);
    console.error(
      `[codex-command] unable to start command: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return 127;
  }

  const signals = superviseProcessTree(child, signalGraceMilliseconds);
  const shouldForward = !artifacts.available
    || Boolean(process.stdout.isTTY || process.stderr.isTTY);
  const stdoutState = initialCaptureState();
  const stderrState = initialCaptureState();
  const stdoutCapture = captureOutput(
    child.stdout,
    "stdout",
    artifacts.stdoutFile,
    maximumBytes,
    shouldForward,
    stdoutState,
  );
  const stderrCapture = captureOutput(
    child.stderr,
    "stderr",
    artifacts.stderrFile,
    maximumBytes,
    shouldForward,
    stderrState,
  );
  let lastReportedStdoutBytes = 0;
  let lastReportedStderrBytes = 0;
  const reportProgress = () => {
    if (
      stdoutState.observedBytes === lastReportedStdoutBytes
      && stderrState.observedBytes === lastReportedStderrBytes
    ) {
      return;
    }
    const seconds = Math.floor((performance.now() - processStartedAt) / 1_000);
    console.log(`| ${seconds}s | ${stdoutState.observedBytes}B | ${stderrState.observedBytes}B |`);
    lastReportedStdoutBytes = stdoutState.observedBytes;
    lastReportedStderrBytes = stderrState.observedBytes;
  };
  const heartbeat = setInterval(() => {
    applyCaptureState(status, stdoutState, stderrState);
    if (artifacts.statusPath) writeRunStatus(artifacts.statusPath, status);
    reportProgress();
  }, heartbeatMilliseconds);
  heartbeat.unref();

  const shellExitCode = await child.exited;
  signals.markShellExited();
  await Promise.race([
    Promise.all([stdoutCapture.done, stderrCapture.done]),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, drainMilliseconds)),
  ]);
  const drainedNaturally = stdoutState.finished && stderrState.finished;
  const exitCode = await signals.finish(shellExitCode);
  if (!stdoutState.finished || !stderrState.finished) {
    await Promise.race([
      Promise.all([stdoutCapture.done, stderrCapture.done]),
      Bun.sleep(captureCancellationMilliseconds),
    ]);
  }
  if (!stdoutState.finished || !stderrState.finished) {
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
  }
  status.drainIncomplete = !drainedNaturally;
  status.completedAt = new Date().toISOString();
  status.exitCode = exitCode;
  if (signals.receivedSignal) status.signal = signals.receivedSignal;
  applyCaptureState(status, stdoutState, stderrState);
  clearInterval(heartbeat);
  signals.close();
  closeArtifactFile(artifacts.stdoutFile);
  closeArtifactFile(artifacts.stderrFile);
  if (artifacts.statusPath) writeRunStatus(artifacts.statusPath, status);

  reportProgress();
  if (!shouldForward && artifacts.available && artifacts.directory) {
    printRetainedOutput(artifacts.directory, status, inlineBytes);
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

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

/** Uses the invoking shell only when it is an absolute executable with familiar
 * `-c` semantics. /bin/sh is the portable, non-recursive fallback. */
function commandShell(): string {
  const candidate = process.env.SHELL;
  if (
    candidate
    && isAbsolute(candidate)
    && ["bash", "dash", "ksh", "sh", "zsh"].includes(basename(candidate))
  ) {
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

function applyCaptureState(
  status: RunStatus,
  stdout: ReturnType<typeof initialCaptureState>,
  stderr: ReturnType<typeof initialCaptureState>,
): void {
  status.stdoutObservedBytes = stdout.observedBytes;
  status.stderrObservedBytes = stderr.observedBytes;
  status.stdoutStoredBytes = stdout.storedBytes;
  status.stderrStoredBytes = stderr.storedBytes;
  status.stdoutTruncated = stdout.truncated;
  status.stderrTruncated = stderr.truncated;
}

function printRetainedOutput(directory: string, status: RunStatus, inlineBytes: number): void {
  const combinedBytes = status.stdoutObservedBytes + status.stderrObservedBytes;
  const printFullOutput = combinedBytes <= inlineBytes
    && !status.stdoutTruncated
    && !status.stderrTruncated;
  if (printFullOutput) {
    printCapturedOutput("stdout", readArtifact(join(directory, "stdout.log")));
    printCapturedOutput("stderr", readArtifact(join(directory, "stderr.log")));
  } else {
    printCapturedOutput("stdout tail", readArtifactTail(join(directory, "stdout.log")));
    printCapturedOutput("stderr tail", readArtifactTail(join(directory, "stderr.log")));
  }
}
