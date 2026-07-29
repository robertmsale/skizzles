import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { cp, lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCodexCommand, commandText } from "./command";
import { createFixture, type FixtureHandle } from "./fixture";
import { ensureDirectory, readCappedText, redactSensitiveText, sha256, snapshotHash, snapshotTree, writeText } from "./fs";
import { writeDiffArtifact } from "./git";
import { copyFrozenOverlay, type OverlayPair } from "./overlays";
import { classifyAuthoritySignals, emptyObservedMetricPaths, inspectJsonlSchema, metricPaths, parseObservedMetrics, unavailableMetrics } from "./events";
import { verifyRun } from "./verifier";
import type { CaptureResult, Condition, MetricProfile, PilotCaseId, RunManifest, VerifierResult } from "./types";

export const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;
export const DEFAULT_KILL_GRACE_MS = 3_000;
export const DEFAULT_STDOUT_CAP_BYTES = 4 * 1024 * 1024;
export const DEFAULT_STDERR_CAP_BYTES = 1 * 1024 * 1024;
export const DEFAULT_FINAL_ANSWER_CAP_BYTES = 64 * 1024;

export interface ExecuteRunOptions {
  readonly repositoryRoot: string;
  readonly artifactRoot: string;
  readonly caseId: PilotCaseId;
  readonly condition: Condition;
  readonly repetition: number;
  readonly overlays: OverlayPair;
  readonly codexBinary?: string;
  readonly codexVersion?: string;
  readonly metricProfile?: MetricProfile;
  readonly deadlineMs?: number;
  readonly killGraceMs?: number;
  readonly runId?: string;
  readonly expectedFixtureBaselineTreeHash?: string;
}

export async function executeRun(options: ExecuteRunOptions): Promise<CaptureResult> {
  const runId = options.runId ?? randomUUID();
  const runRoot = join(options.artifactRoot, "runs", runId);
  await ensureDirectory(options.artifactRoot);
  await ensureDirectory(join(options.artifactRoot, "runs"));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(runRoot));
  const fixtureRoot = join(runRoot, "fixture");
  const fixture = await createFixture(options.caseId, fixtureRoot);
  if (options.expectedFixtureBaselineTreeHash && fixture.baselineTreeHash !== options.expectedFixtureBaselineTreeHash) {
    throw new Error(`fixture baseline hash differs for ${options.caseId}`);
  }
  await assertFixtureInstructionBoundary(fixtureRoot);
  const selectedOverlay = options.overlays[options.condition];
  const instructionFile = await copyFrozenOverlay(selectedOverlay, join(runRoot, "instructions.md"));
  const finalAnswerPath = join(runRoot, "final.md");
  // Keep Codex's raw -o output in a private temporary directory. Only the
  // redacted bounded text is written to the durable campaign artifact.
  const finalOutputRoot = await mkdtemp(join(tmpdir(), "skizzles-prompt-eval-final-"));
  const finalOutputPath = join(finalOutputRoot, "final.md");
  const rawEventsPath = join(runRoot, "events.jsonl");
  const stderrPath = join(runRoot, "stderr.log");
  const verifierPath = join(runRoot, "verifier.json");
  const verifierSource = fixture.pilotCase.fixtureFiles["verify.mjs"] ?? "";
  const command = buildCodexCommand({
    fixtureRoot,
    instructionFile,
    finalMessagePath: finalOutputPath,
    ...(options.codexBinary ? { codexBinary: options.codexBinary } : {}),
  });
  const codexVersion = options.codexVersion ?? getCodexVersion(options.codexBinary);
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const startedAt = new Date().toISOString();
  const runManifest: RunManifest = {
    schemaVersion: "prompt-governance-run-v1",
    runId,
    caseId: options.caseId,
    condition: options.condition,
    repetition: options.repetition,
    fixtureRoot,
    artifactRoot: runRoot,
    overlays: [options.overlays.baseline, options.overlays.candidate],
    fileAllowlist: fixture.pilotCase.allowlist,
    expectedNoWrite: fixture.pilotCase.expectedNoWrite,
    codexVersion,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    command,
    baselineHead: fixture.baselineCommit,
    fixtureBaselineTreeHash: fixture.baselineTreeHash,
    oracleVerifierHash: sha256(verifierSource),
    headMoved: false,
    outputTruncated: false,
    timedOut: false,
    drainTimedOut: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutStoredBytes: 0,
    stderrStoredBytes: 0,
    finalAnswerBytes: 0,
    finalAnswerStoredBytes: 0,
    finalAnswerTruncated: false,
    diffBytes: 0,
    diffStoredBytes: 0,
    diffTruncated: false,
    authorityViolations: [],
    infrastructureFailure: false,
    verificationSkipped: false,
    snapshotSourcePreHash: "",
    snapshotSourcePostHash: "",
    snapshotCopyHash: "",
    snapshotVerificationPostHash: "",
    snapshotStable: false,
    processGroupTeardown: "best-effort",
    deadlineMs,
    killGraceMs,
    environmentKeys: ["CODEX_HOME", "PATH", "HOME", "TMPDIR"],
    networkPolicy: "sandbox_workspace_write.network_access=false; web_search=disabled; top-level HOME/CODEX_HOME remain caller-managed for auth; model child HOME is fixture-owned by shell_environment_policy.set; Codex service transport remains host-managed",
    approvalPolicy: "--ask-for-approval never (top-level before exec); supported approval policy, not a sandbox bypass",
    startedAt,
  };
  await writeText(join(runRoot, "run-manifest.json"), `${JSON.stringify(runManifest, null, 2)}\n`);

  const execution = await spawnCodex(command, fixture.pilotCase.taskPrompt, fixtureRoot, runRoot, deadlineMs, killGraceMs);
  await writeText(rawEventsPath, redactSensitiveText(execution.stdout));
  await writeText(stderrPath, redactSensitiveText(execution.stderr));
  const finalCapture = await readOptionalCapped(finalOutputPath, DEFAULT_FINAL_ANSWER_CAP_BYTES);
  const finalAnswer = redactSensitiveText(finalCapture.text);
  await writeText(finalAnswerPath, `${finalAnswer}${finalCapture.truncated ? "\n[final answer truncated by harness]\n" : ""}`);
  await rm(finalOutputRoot, { recursive: true, force: true });
  const knownInfrastructureFailure = execution.exitCode !== 0 || execution.timedOut || execution.drainTimedOut || execution.outputTruncated || finalCapture.truncated;
  let infrastructureFailure = knownInfrastructureFailure;
  let verificationSkipped = knownInfrastructureFailure;
  let snapshotSourcePreHash = "";
  let snapshotSourcePostHash = "";
  let snapshotCopyHash = "";
  let snapshotVerificationPostHash = "";
  let snapshotStable = false;
  let verifier: VerifierResult;
  let diffArtifact: Awaited<ReturnType<typeof writeDiffArtifact>>;
  let snapshotQuarantineRoot: string | undefined;
  if (knownInfrastructureFailure) {
    const reason = `verification skipped before verifier/diff (exitCode=${execution.exitCode}, timedOut=${execution.timedOut}, drainTimedOut=${execution.drainTimedOut}, outputTruncated=${execution.outputTruncated}, finalAnswerTruncated=${finalCapture.truncated})`;
    verifier = skippedVerifier(fixture, verifierSource, reason);
    diffArtifact = await skippedDiff(runRoot, reason);
  } else {
    try {
      const sourcePreHash = snapshotHash(await snapshotTree(fixtureRoot));
      snapshotQuarantineRoot = await mkdtemp(join(tmpdir(), "skizzles-prompt-eval-snapshot-"));
      const verificationRoot = join(snapshotQuarantineRoot, "fixture");
      await cp(fixtureRoot, verificationRoot, { recursive: true, dereference: false });
      const copyHash = snapshotHash(await snapshotTree(verificationRoot));
      const sourcePostHash = snapshotHash(await snapshotTree(fixtureRoot));
      snapshotSourcePreHash = sourcePreHash;
      snapshotCopyHash = copyHash;
      snapshotSourcePostHash = sourcePostHash;
      snapshotStable = sourcePreHash === sourcePostHash && sourcePreHash === copyHash;
      if (!snapshotStable) throw new Error("fixture snapshot changed while being quarantined");
      const oracleVerifierPath = join(verificationRoot, "oracle-verify.mjs");
      try {
        await lstat(oracleVerifierPath);
        throw new Error("fixture used the reserved oracle-verify.mjs path");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await writeText(oracleVerifierPath, verifierSource);
      verifier = await verifyRun(verificationRoot, fixture.pilotCase, finalAnswerPath, fixture.baselineSnapshot, fixture.baselineTreeHash, fixture.baselineCommit, oracleVerifierPath, ["oracle-verify.mjs"]);
      await rm(oracleVerifierPath, { force: true });
      diffArtifact = await writeDiffArtifact(runRoot, verificationRoot, fixture.baselineCommit);
      snapshotVerificationPostHash = snapshotHash(await snapshotTree(verificationRoot));
      if (snapshotVerificationPostHash !== copyHash) throw new Error("fixture snapshot changed during verifier/diff");
    } catch (error) {
      infrastructureFailure = true;
      verificationSkipped = true;
      snapshotStable = false;
      const reason = `verification snapshot failure: ${error instanceof Error ? error.message : String(error)}`;
      verifier = skippedVerifier(fixture, verifierSource, reason);
      diffArtifact = await skippedDiff(runRoot, reason);
    } finally {
      if (snapshotQuarantineRoot) await rm(snapshotQuarantineRoot, { recursive: true, force: true });
    }
  }
  await writeText(verifierPath, `${JSON.stringify(verifier, null, 2)}\n`);
  const authorityViolations = classifyAuthoritySignals(execution.stdout, execution.stderr);
  const observedJsonlSchema = inspectJsonlSchema(execution.stdout);
  const observedMetricPaths = options.metricProfile ? metricPaths(options.metricProfile) : emptyObservedMetricPaths();
  const completedRun: RunManifest = {
    ...runManifest,
    finishedAt: new Date().toISOString(),
    exitCode: execution.exitCode,
    headMoved: verifier.headMoved,
    outputTruncated: execution.outputTruncated,
    timedOut: execution.timedOut,
    drainTimedOut: execution.drainTimedOut,
    stdoutBytes: execution.stdoutBytes,
    stderrBytes: execution.stderrBytes,
    stdoutStoredBytes: execution.stdoutStoredBytes,
    stderrStoredBytes: execution.stderrStoredBytes,
    finalAnswerBytes: finalCapture.bytes,
    finalAnswerStoredBytes: Buffer.byteLength(finalAnswer),
    finalAnswerTruncated: finalCapture.truncated,
    diffBytes: diffArtifact.bytes,
    diffStoredBytes: diffArtifact.storedBytes,
    diffTruncated: diffArtifact.truncated,
    authorityViolations,
    infrastructureFailure: infrastructureFailure || diffArtifact.truncated,
    verificationSkipped,
    snapshotSourcePreHash,
    snapshotSourcePostHash,
    snapshotCopyHash,
    snapshotVerificationPostHash,
    snapshotStable,
  };
  await writeText(join(runRoot, "run-manifest.json"), `${JSON.stringify(completedRun, null, 2)}\n`);
  const capture: CaptureResult = {
    schemaVersion: "prompt-governance-capture-v1",
    run: completedRun,
    commandText: commandText(command),
    codexVersion,
    startedAt,
    finishedAt: completedRun.finishedAt!,
    exitCode: execution.exitCode,
    taskPrompt: fixture.pilotCase.taskPrompt,
    finalAnswer,
    rawEventsPath,
    finalAnswerPath,
    diffPath: diffArtifact.path,
    verifierPath,
    fileAllowlist: fixture.pilotCase.allowlist,
    verifier,
    observedJsonlSchema,
    secondaryMetrics: knownInfrastructureFailure || !options.metricProfile ? unavailableMetrics() : parseObservedMetrics(execution.stdout, options.metricProfile),
    observedMetricPaths,
    outputTruncated: execution.outputTruncated,
    timedOut: execution.timedOut,
    drainTimedOut: execution.drainTimedOut,
    stdoutBytes: execution.stdoutBytes,
    stderrBytes: execution.stderrBytes,
    stdoutStoredBytes: execution.stdoutStoredBytes,
    stderrStoredBytes: execution.stderrStoredBytes,
    ...(options.metricProfile ? { metricProfileId: options.metricProfile.profileId } : {}),
    finalAnswerBytes: finalCapture.bytes,
    finalAnswerStoredBytes: Buffer.byteLength(finalAnswer),
    finalAnswerTruncated: finalCapture.truncated,
    diffBytes: diffArtifact.bytes,
    diffStoredBytes: diffArtifact.storedBytes,
    diffTruncated: diffArtifact.truncated,
    authorityViolations,
    infrastructureFailure: infrastructureFailure || diffArtifact.truncated,
    verificationSkipped,
    snapshotStable,
  };
  await writeText(join(runRoot, "capture.json"), `${JSON.stringify(capture, null, 2)}\n`);
  return capture;
}

function skippedVerifier(fixture: FixtureHandle, verifierSource: string, reason: string): VerifierResult {
  return {
    passed: false,
    exitCode: 127,
    stdout: "",
    stderr: reason,
    changedPaths: [],
    unsafePaths: [],
    expectedNoWrite: fixture.pilotCase.expectedNoWrite,
    baselineTreeHash: fixture.baselineTreeHash,
    finalTreeHash: "unavailable",
    baselineHead: fixture.baselineCommit,
    finalHead: fixture.baselineCommit,
    headMoved: false,
    oracleVerifierHash: sha256(verifierSource),
  };
}

async function skippedDiff(runRoot: string, reason: string): Promise<Awaited<ReturnType<typeof writeDiffArtifact>>> {
  const path = join(runRoot, "fixture.diff");
  const text = `[diff skipped: ${reason}]\n`;
  await writeText(path, text);
  return { path, bytes: Buffer.byteLength(text), storedBytes: Buffer.byteLength(text), truncated: false };
}

interface SupervisorResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly drainTimedOut?: boolean;
  readonly stdout: { readonly bytes: number; readonly storedBytes: number; readonly truncated: boolean };
  readonly stderr: { readonly bytes: number; readonly storedBytes: number; readonly truncated: boolean };
}

export interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
  readonly drainTimedOut: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutStoredBytes: number;
  readonly stderrStoredBytes: number;
}

async function spawnCodex(
  command: readonly string[],
  prompt: string,
  cwd: string,
  runRoot: string,
  deadlineMs: number,
  killGraceMs: number,
  stdoutCapBytes = DEFAULT_STDOUT_CAP_BYTES,
  stderrCapBytes = DEFAULT_STDERR_CAP_BYTES,
): Promise<SpawnResult> {
  const supervisor = join(import.meta.dir, "supervisor.py");
  const quarantineRoot = await mkdtemp(join(tmpdir(), "skizzles-prompt-eval-quarantine-"));
  const stdoutPath = join(quarantineRoot, "stdout.bin");
  const stderrPath = join(quarantineRoot, "stderr.bin");
  const statusPath = join(quarantineRoot, "status.json");
  const python = resolveBinary("python3");
  const supervisorCommand = [
    python,
    supervisor,
    "--cwd", cwd,
    "--stdout", stdoutPath,
    "--stderr", stderrPath,
    "--stdout-cap", String(stdoutCapBytes),
    "--stderr-cap", String(stderrCapBytes),
    "--timeout-ms", String(deadlineMs),
    "--grace-ms", String(killGraceMs),
    "--status", statusPath,
    "--",
    ...command,
  ];
  try {
    const result = Bun.spawnSync({
      cmd: supervisorCommand,
      cwd: runRoot,
      stdin: new TextEncoder().encode(prompt),
      stdout: "ignore",
      stderr: "pipe",
      env: buildEvaluationEnvironment(),
    });
    const statusText = await readOptional(statusPath, 16 * 1024);
    const supervisorResult = parseSupervisorResult(statusText, result.exitCode);
    const stdout = await readOptional(stdoutPath, DEFAULT_STDOUT_CAP_BYTES);
    const stderr = await readOptional(stderrPath, DEFAULT_STDERR_CAP_BYTES);
    const safeStdout = redactSensitiveText(stdout);
    const safeStderr = redactSensitiveText(stderr);
    await writeText(join(runRoot, "supervised-stdout.bin"), safeStdout);
    await writeText(join(runRoot, "supervised-stderr.bin"), safeStderr);
    return {
      exitCode: supervisorResult.exitCode,
      stdout,
      stderr: `${new TextDecoder().decode(result.stderr)}${stderr}`,
      outputTruncated: supervisorResult.stdout.truncated || supervisorResult.stderr.truncated,
      timedOut: supervisorResult.timedOut,
      drainTimedOut: supervisorResult.drainTimedOut ?? false,
      stdoutBytes: supervisorResult.stdout.bytes,
      stderrBytes: supervisorResult.stderr.bytes,
      stdoutStoredBytes: supervisorResult.stdout.storedBytes,
      stderrStoredBytes: supervisorResult.stderr.storedBytes,
    };
  } finally {
    await rm(quarantineRoot, { recursive: true, force: true });
  }
}

export async function spawnCodexForCalibration(
  command: readonly string[],
  prompt: string,
  cwd: string,
  runRoot: string,
  deadlineMs = DEFAULT_DEADLINE_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  stdoutCapBytes = DEFAULT_STDOUT_CAP_BYTES,
  stderrCapBytes = DEFAULT_STDERR_CAP_BYTES,
): Promise<SpawnResult> {
  return spawnCodex(command, prompt, cwd, runRoot, deadlineMs, killGraceMs, stdoutCapBytes, stderrCapBytes);
}

function parseSupervisorResult(text: string, fallbackExitCode: number): SupervisorResult {
  try {
    const parsed = JSON.parse(text) as Partial<SupervisorResult>;
    if (typeof parsed.exitCode === "number" && typeof parsed.timedOut === "boolean") {
      const normalizeStream = (stream: Partial<SupervisorResult["stdout"]> | undefined) => ({
        bytes: typeof stream?.bytes === "number" && Number.isFinite(stream.bytes) && stream.bytes >= 0 ? stream.bytes : 0,
        storedBytes: typeof stream?.storedBytes === "number" && Number.isFinite(stream.storedBytes) && stream.storedBytes >= 0 ? stream.storedBytes : 0,
        truncated: typeof stream?.truncated === "boolean" ? stream.truncated : Boolean(parsed.drainTimedOut ?? parsed.timedOut),
      });
      return {
        exitCode: parsed.exitCode,
        timedOut: parsed.timedOut,
        ...(typeof parsed.drainTimedOut === "boolean" ? { drainTimedOut: parsed.drainTimedOut } : {}),
        stdout: normalizeStream(parsed.stdout),
        stderr: normalizeStream(parsed.stderr),
      };
    }
  } catch {
    // The stderr/status artifact records the failure; return a bounded synthetic result.
  }
  return { exitCode: fallbackExitCode || 127, timedOut: false, stdout: { bytes: 0, storedBytes: 0, truncated: true }, stderr: { bytes: 0, storedBytes: 0, truncated: true } };
}
export function buildEvaluationEnvironment(sourceEnvironment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = new Set(["CODEX_HOME", "PATH", "HOME", "TMPDIR"]);
  const environment = Object.fromEntries(Object.entries(sourceEnvironment).filter(([key, value]) => allowed.has(key) && value !== undefined && value !== "")) as Record<string, string>;
  const codexHome = sourceEnvironment.CODEX_HOME || (sourceEnvironment.HOME && (() => { const path = join(sourceEnvironment.HOME!, ".codex"); try { return statSync(path).isDirectory() ? path : undefined; } catch { return undefined; } })());
  if (codexHome) environment.CODEX_HOME = codexHome;
  return environment;
}
function resolveBinary(binary = "codex"): string {
  if (binary.includes("/")) return execFileSync("realpath", [binary], { encoding: "utf8" }).trim();
  return execFileSync("which", [binary], { encoding: "utf8" }).trim();
}

export function getCodexVersion(binary = "codex"): string {
  try {
    const path = resolveBinary(binary);
    const result = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "pipe", env: buildEvaluationEnvironment() });
    const stdout = new TextDecoder().decode(result.stdout).trim();
    const stderr = new TextDecoder().decode(result.stderr).trim();
    return stdout || stderr || `unavailable (exit ${result.exitCode})`;
  } catch (error) {
    return `unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
}

export function resolveCodexPath(binary = "codex"): string {
  return resolveBinary(binary);
}

export function assertExactCodexVersion(version: string): void {
  if (version !== "codex-cli 0.146.0-alpha.14") throw new Error(`unsupported Codex version for prompt evaluation: ${version}`);
}

async function assertFixtureInstructionBoundary(fixtureRoot: string): Promise<void> {
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(fixtureRoot, { recursive: true }));
  const forbidden = entries.filter((entry) => entry === "AGENTS.md" || entry.endsWith("/AGENTS.md") || entry === ".codex" || entry.includes("/.codex/") || entry.endsWith(".rules"));
  if (forbidden.length > 0) throw new Error(`fixture contains an instruction-policy file: ${forbidden.join(", ")}`);
}

async function readOptionalCapped(path: string, cap: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  try {
    return await readCappedText(path, cap);
  } catch {
    return { text: "", bytes: 0, truncated: true };
  }
}

async function readOptional(path: string, cap: number): Promise<string> {
  return (await readOptionalCapped(path, cap)).text;
}
