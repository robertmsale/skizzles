import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { cp, lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCodexCommand, commandControlDescriptor, commandText } from "./command";
import { createFixture, type FixtureHandle } from "./fixture";
import { ensureDirectory, readCappedText, redactSensitiveText, sanitizeTelemetryLine, sha256, snapshotHash, snapshotTree, writeText } from "./fs";
import { writeDiffArtifact } from "./git";
import { copyFrozenOverlay, type OverlayPair } from "./overlays";
import { classifyAuthoritySignals, emptyObservedMetricPaths, inspectJsonlSchema, metricPaths, parseObservedMetrics, unavailableMetrics } from "./events";
import { verifyRun } from "./verifier";
import { assertCacheOutside, ensurePrivateDirectory, privateArtifactPath, type VerifiedPrivateCache } from "./cache"; import { isRecord } from "./records";
import type { CaptureResult, Condition, MeasurementScope, MetricProfile, PilotCaseId, RunManifest, VerifierResult } from "./types";
export const DEFAULT_DEADLINE_MS = 10 * 60 * 1000; export const DEFAULT_KILL_GRACE_MS = 3_000; export const DEFAULT_STDOUT_CAP_BYTES = 4 * 1024 * 1024; export const DEFAULT_STDERR_CAP_BYTES = 1 * 1024 * 1024; export const DEFAULT_FINAL_ANSWER_CAP_BYTES = 64 * 1024;
export interface ExecuteRunOptions {
  readonly repositoryRoot: string;
  readonly artifactRoot: string;
  /** Verified private execution cache. Public artifact roots never receive model output. */
  readonly cache: VerifiedPrivateCache;
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
  await ensureDirectory(options.artifactRoot);
  await assertCacheOutside(options.cache, options.artifactRoot);
  const runRoot = privateArtifactPath(options.cache, "runs", runId);
  await ensurePrivateDirectory(options.cache, "runs");
  await ensurePrivateDirectory(options.cache, "runs", runId);
  const fixtureRoot = privateArtifactPath(options.cache, "runs", runId, "fixture");
  const fixture = await createFixture(options.caseId, fixtureRoot);
  if (options.expectedFixtureBaselineTreeHash && fixture.baselineTreeHash !== options.expectedFixtureBaselineTreeHash) {
    throw new Error(`fixture baseline hash differs for ${options.caseId}`);
  }
  await assertFixtureInstructionBoundary(fixtureRoot);
  const selectedOverlay = options.overlays[options.condition];
  const instructionFile = await copyFrozenOverlay(selectedOverlay, privateArtifactPath(options.cache, "runs", runId, "instructions.md"));
  const finalAnswerPath = privateArtifactPath(options.cache, "runs", runId, "final.md");
  const finalOutputRoot = await mkdtemp(join(tmpdir(), "skizzles-prompt-eval-final-")); const finalOutputPath = join(finalOutputRoot, "final.md");
  const rawEventsPath = privateArtifactPath(options.cache, "runs", runId, "events.jsonl"); const stderrPath = privateArtifactPath(options.cache, "runs", runId, "stderr.log"); const verifierPath = privateArtifactPath(options.cache, "runs", runId, "verifier.json");
  const verifierSource = fixture.pilotCase.fixtureFiles["verify.mjs"] ?? "";
  const command = buildCodexCommand({
    fixtureRoot,
    instructionFile,
    finalMessagePath: finalOutputPath,
    ...(options.codexBinary ? { codexBinary: options.codexBinary } : {}),
  });
  const codexVersion = options.codexVersion ?? getCodexVersion(options.codexBinary); const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS; const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS; const startedAt = new Date().toISOString();
  const runManifest: RunManifest = {
    schemaVersion: "prompt-governance-run-v2",
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
    measurementScope: buildMeasurementScope(command, codexVersion),
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
    networkPolicy: "sandbox_workspace_write.network_access=false; web_search=disabled; paired comparison under caller-authenticated local Codex config; top-level HOME/CODEX_HOME remain caller-managed; features.hooks=false; model child HOME is fixture-owned by shell_environment_policy.set; Codex service transport remains host-managed",
    approvalPolicy: "--ask-for-approval never (top-level before exec); supported approval policy, not a sandbox bypass",
    startedAt,
  };
  await writeText(privateArtifactPath(options.cache, "runs", runId, "run-manifest.json"), `${JSON.stringify(runManifest, null, 2)}\n`);
  let execution: SpawnResult;
  let finalCapture: { text: string; bytes: number; truncated: boolean };
  try {
    execution = await spawnCodex(command, fixture.pilotCase.taskPrompt, fixtureRoot, runRoot, deadlineMs, killGraceMs);
    finalCapture = await readOptionalCapped(finalOutputPath, DEFAULT_FINAL_ANSWER_CAP_BYTES);
  } finally {
    await rm(finalOutputRoot, { recursive: true, force: true });
  }
  const authorityViolations = classifyAuthoritySignals(execution.stdout, execution.stderr);
  const knownInfrastructureFailure = execution.captureComplete === false || execution.exitCode !== 0 || execution.timedOut || execution.drainTimedOut || execution.outputTruncated || finalCapture.truncated || authorityViolations.length > 0;
  const failureStatus = failureCategory({ ...execution, finalAnswerTruncated: finalCapture.truncated, authorityViolations });
  const persistedEvents = knownInfrastructureFailure ? failureStatus : sanitizeTelemetryEvents(execution.stdout);
  const persistedStderr = knownInfrastructureFailure ? failureStatus : safeStreamStatus("stderr", execution.stderrBytes, execution.stderrStoredBytes, execution.outputTruncated);
  const finalAnswer = knownInfrastructureFailure ? failureStatus : redactSensitiveText(finalCapture.text);
  await writeText(rawEventsPath, persistedEvents);
  await writeText(stderrPath, persistedStderr);
  await writeText(privateArtifactPath(options.cache, "runs", runId, "raw-stderr.bin"), execution.stderr);
  await writeText(privateArtifactPath(options.cache, "runs", runId, "supervised-stdout.bin"), persistedEvents);
  await writeText(privateArtifactPath(options.cache, "runs", runId, "supervised-stderr.bin"), persistedStderr);
  await writeText(finalAnswerPath, knownInfrastructureFailure ? failureStatus : `${finalAnswer}${finalCapture.truncated ? "\n[final answer truncated by harness]\n" : ""}`);
  let infrastructureFailure = knownInfrastructureFailure; let verificationSkipped = knownInfrastructureFailure;
  let snapshotSourcePreHash = ""; let snapshotSourcePostHash = ""; let snapshotCopyHash = ""; let snapshotVerificationPostHash = ""; let snapshotStable = false;
  let verifier: VerifierResult;
  let diffArtifact: Awaited<ReturnType<typeof writeDiffArtifact>>;
  let snapshotQuarantineRoot: string | undefined;
  if (knownInfrastructureFailure) {
    const reason = failureStatus.trim();
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
  // Snapshot/verifier failures occur after capture; only sanitized verifier fields and diff artifacts become durable.
  const persistedVerifier = { ...verifier, stdout: redactSensitiveText(verifier.stdout), stderr: redactSensitiveText(verifier.stderr) };
  await writeText(verifierPath, `${JSON.stringify(persistedVerifier, null, 2)}\n`);
  const observedJsonlSchema = knownInfrastructureFailure ? inspectJsonlSchema("") : inspectJsonlSchema(persistedEvents);
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
  await writeText(privateArtifactPath(options.cache, "runs", runId, "run-manifest.json"), `${JSON.stringify(completedRun, null, 2)}\n`);
  const capture: CaptureResult = {
    schemaVersion: "prompt-governance-capture-v2",
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
    verifier: persistedVerifier,
    observedJsonlSchema,
    secondaryMetrics: knownInfrastructureFailure || !options.metricProfile ? unavailableMetrics() : parseObservedMetrics(persistedEvents, options.metricProfile),
    observedMetricPaths,
    outputTruncated: execution.outputTruncated,
    timedOut: execution.timedOut,
    drainTimedOut: execution.drainTimedOut,
    stdoutBytes: execution.stdoutBytes,
    stderrBytes: execution.stderrBytes,
    stdoutStoredBytes: execution.stdoutStoredBytes,
    stderrStoredBytes: execution.stderrStoredBytes,
    ...(options.metricProfile ? { metricProfileId: options.metricProfile.registryId } : {}),
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
  await writeText(privateArtifactPath(options.cache, "runs", runId, "capture.json"), `${JSON.stringify(capture, null, 2)}\n`);
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
  readonly captureComplete: boolean; readonly captureFailureCategory: string;
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
  readonly captureComplete?: boolean; readonly captureFailureCategory?: string;
}
export interface FailureCategoryInput extends SpawnResult {
  readonly finalAnswerTruncated: boolean;
  readonly authorityViolations: readonly string[];
  readonly additionalCategories?: readonly string[];
}
export function failureCategory(input: FailureCategoryInput): string {
  const categories = [...(input.additionalCategories ?? []), ...(input.captureFailureCategory && /^[a-z][a-z0-9-]*$/.test(input.captureFailureCategory) ? [input.captureFailureCategory] : []), ...input.authorityViolations.map((value) => `authority:${value}`), ...(input.exitCode !== 0 ? ["nonzero-exit"] : []), ...(input.timedOut ? ["timeout"] : []), ...(input.drainTimedOut ? ["drain-timeout"] : []), ...(input.outputTruncated ? ["output-truncated"] : []), ...(input.finalAnswerTruncated ? ["final-answer-truncated"] : [])].filter((value) => /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)?$/.test(value));
  return `${JSON.stringify({ status: "capture-failure", categories, exitCode: input.exitCode, timedOut: input.timedOut, drainTimedOut: input.drainTimedOut, outputTruncated: input.outputTruncated, finalAnswerTruncated: input.finalAnswerTruncated })}\n`;
}
export function safeStreamStatus(stream: string, bytes: number, storedBytes: number, truncated: boolean): string {
  return `${JSON.stringify({ status: "stream-suppressed", stream, bytes, storedBytes, truncated })}\n`;
}
export function sanitizeTelemetryEvents(rawEvents: string): string {
  return rawEvents.split(/\r?\n/).flatMap((line) => {
    const safe = line.trim() ? sanitizeTelemetryLine(line) : undefined;
    return safe ? [`${safe}\n`] : [];
  }).join("");
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
    const supervisorResult = parseSupervisorResult(statusText, result.exitCode, stdoutCapBytes, stderrCapBytes);
    const stdout = await readOptional(stdoutPath, DEFAULT_STDOUT_CAP_BYTES);
    const stderr = await readOptional(stderrPath, DEFAULT_STDERR_CAP_BYTES);
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
      captureComplete: supervisorResult.captureComplete,
      captureFailureCategory: supervisorResult.captureFailureCategory,
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
export function parseSupervisorResult(text: string, supervisorExitCode: number, stdoutCapBytes = DEFAULT_STDOUT_CAP_BYTES, stderrCapBytes = DEFAULT_STDERR_CAP_BYTES): SupervisorResult {
  const fallback = (category = "internal"): SupervisorResult => ({ exitCode: supervisorExitCode || 127, timedOut: false, drainTimedOut: false, stdout: { bytes: 0, storedBytes: 0, truncated: false }, stderr: { bytes: 0, storedBytes: 0, truncated: false }, captureComplete: false, captureFailureCategory: category });
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return fallback();
    const required = ["captureComplete", "drainTimedOut", "exitCode", "failureCategory", "interrupted", "schemaVersion", "status", "stderr", "stdout", "timedOut"];
    if (Object.keys(parsed).sort().join(",") !== required.slice().sort().join(",") || parsed.schemaVersion !== "supervisor-status-v2" || (parsed.status !== "complete" && parsed.status !== "failed")) return fallback();
    if (!isSafeInteger(parsed.exitCode) || typeof parsed.timedOut !== "boolean" || typeof parsed.drainTimedOut !== "boolean" || typeof parsed.interrupted !== "boolean" || typeof parsed.captureComplete !== "boolean" || typeof parsed.failureCategory !== "string" || !["", "stream-open", "stream-read", "stream-write", "stream-close", "spawn", "input", "status-write", "internal"].includes(parsed.failureCategory)) return fallback();
    const stdout = parseSupervisorStream(parsed.stdout, stdoutCapBytes); const stderr = parseSupervisorStream(parsed.stderr, stderrCapBytes);
    if (!stdout || !stderr) return fallback();
    if (parsed.status === "complete") return supervisorExitCode === 0 && parsed.captureComplete && parsed.failureCategory === "" && !parsed.timedOut && !parsed.drainTimedOut && !parsed.interrupted && stdout.storedBytes === Math.min(stdout.bytes, stdoutCapBytes) && stderr.storedBytes === Math.min(stderr.bytes, stderrCapBytes) ? { exitCode: parsed.exitCode, timedOut: false, drainTimedOut: false, stdout, stderr, captureComplete: true, captureFailureCategory: "" } : fallback();
    return supervisorExitCode === 125 && !parsed.captureComplete && parsed.exitCode === 125 && (Boolean(parsed.failureCategory) || parsed.timedOut || parsed.drainTimedOut || parsed.interrupted) ? { exitCode: 125, timedOut: parsed.timedOut, drainTimedOut: parsed.drainTimedOut, stdout, stderr, captureComplete: false, captureFailureCategory: parsed.failureCategory } : fallback();
  } catch {
    return fallback();
  }
}
function parseSupervisorStream(value: unknown, cap: number): SupervisorResult["stdout"] | undefined { if (!isRecord(value) || Object.keys(value).sort().join(",") !== "bytes,storedBytes,truncated" || !isSafeInteger(value.bytes) || !isSafeInteger(value.storedBytes) || value.bytes < 0 || value.storedBytes < 0 || value.storedBytes > value.bytes || value.storedBytes > cap || typeof value.truncated !== "boolean" || value.truncated !== (value.bytes > cap)) return undefined; return { bytes: value.bytes, storedBytes: value.storedBytes, truncated: value.truncated }; }
function isSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }
export function buildEvaluationEnvironment(sourceEnvironment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = new Set(["CODEX_HOME", "PATH", "HOME", "TMPDIR"]);
  const environment = Object.fromEntries(Object.entries(sourceEnvironment).filter(([key, value]) => allowed.has(key) && value !== undefined && value !== "")) as Record<string, string>;
  const codexHome = sourceEnvironment.CODEX_HOME || (sourceEnvironment.HOME && (() => { const path = join(sourceEnvironment.HOME!, ".codex"); try { return statSync(path).isDirectory() ? path : undefined; } catch { return undefined; } })());
  if (codexHome) environment.CODEX_HOME = codexHome;
  return environment;
}
export function buildMeasurementScope(command: readonly string[], codexVersion: string, sourceEnvironment: NodeJS.ProcessEnv = process.env): MeasurementScope {
  const environment = buildEvaluationEnvironment(sourceEnvironment);
  const controls = commandControlDescriptor(command);
  return { schemaVersion: "prompt-governance-measurement-scope-v1", authMode: "caller-managed-CODEX_HOME", userConfigLoaded: true, userProjectRulesIgnored: true, taskScope: "root-instruction-only", subagents: "disabled-not-observed", fixedFlags: controls.fixedFlags, configControls: controls.configControls, codexHomePresent: Boolean(environment.CODEX_HOME), homePresent: Boolean(environment.HOME), tmpdirPresent: Boolean(environment.TMPDIR), codexBinary: sha256(command[0] ?? "codex"), codexVersion, ambientManagedPolicy: "unknown" };
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
