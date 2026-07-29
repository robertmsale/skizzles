import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPilotCase } from "./cases";
import { canonicalFixtureSnapshotHash, createFixture } from "./fixture";
import { canonicalBlindRubric, createBlindReviewBundle, renderBlindReviewContent } from "./blind";
import { buildCodexCommand } from "./command";
import { executeRun, getCodexVersion, resolveCodexPath, assertExactCodexVersion, DEFAULT_DEADLINE_MS, DEFAULT_KILL_GRACE_MS, DEFAULT_STDOUT_CAP_BYTES } from "./capture";
import type { SpawnResult } from "./capture";
import { changedFromBaseline, git } from "./git";
import { ensureDirectory, readCappedText, readText, redactSensitiveText, sha256, writeAtomicText, writeText } from "./fs";
import { materializeInstructionOverlays, type OverlayPair } from "./overlays";
import { inspectJsonlSchema } from "./events";
import { evaluationProtocol } from "./protocol";
import { evaluateDriftGate, validateBlindScore, type BlindMapping } from "./scoring";
import type { BlindScore, CalibrationRecord, CaptureResult, Condition, MetricProfile, PilotCaseId } from "./types";

export interface PilotOptions {
  readonly repositoryRoot: string;
  readonly artifactRoot: string;
  readonly execute: boolean;
  readonly repetitions: number;
  readonly confirmRuns?: number;
  readonly codexBinary?: string;
}

interface ScheduleEntry {
  readonly sequence: number;
  readonly runId: string;
  readonly caseId: PilotCaseId;
  readonly repetition: number;
  readonly condition: Condition;
}

interface PrivateScheduleEntry extends ScheduleEntry {
  readonly blindId: string;
}

export async function runCalibration(repositoryRoot: string, artifactRoot: string, codexBinary = "codex"): Promise<string> {
  const codexPath = resolveCodexPath(codexBinary);
  const codexVersion = getCodexVersion(codexPath);
  assertExactCodexVersion(codexVersion);
  await ensureDirectory(artifactRoot);
  const calibrationRoot = join(artifactRoot, "calibration");
  await ensureFreshDirectory(calibrationRoot);
  const fixtureRoot = join(calibrationRoot, "fixture");
  const fixture = await createFixture("material-ambiguity", fixtureRoot);
  const overlays = await materializeInstructionOverlays(repositoryRoot, calibrationRoot);
  const baselineText = await readText(overlays.baseline.materializedPath);
  const probeNonce = `CALIBRATION_${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
  const probePath = join(calibrationRoot, "probe-instructions.md");
  await writeText(probePath, `${baselineText}\n\nWhen asked for the instruction calibration phrase, respond with exactly ${probeNonce}.\n`);
  const probeSha256 = sha256(await readFile(probePath));
  const finalAnswerPath = join(calibrationRoot, "final.md");
  const finalOutputRoot = await mkdtemp(join(tmpdir(), "skizzles-prompt-eval-final-"));
  const finalOutputPath = join(finalOutputRoot, "final.md");
  const command = buildCodexCommand({ fixtureRoot, instructionFile: probePath, finalMessagePath: finalOutputPath, codexBinary: codexPath });
  const execution = await runSupervisedCommand(command, "Read the fixture only. Do not edit files. State the instruction calibration phrase without naming it in this request.\n", fixtureRoot, calibrationRoot);
  const finalCapture = await readOptionalCapped(finalOutputPath, DEFAULT_STDOUT_CAP_BYTES);
  const finalAnswer = redactSensitiveText(finalCapture.text);
  await writeText(finalAnswerPath, `${finalAnswer}${finalCapture.truncated ? "\n[final answer truncated by harness]\n" : ""}`);
  await rm(finalOutputRoot, { recursive: true, force: true });
  const changed = await changedFromBaseline(fixtureRoot, fixture.baselineSnapshot);
  const finalHead = git(fixtureRoot, ["rev-parse", "HEAD"]).trim();
  const noWritePassed = changed.paths.length === 0 && finalHead === fixture.baselineCommit;
  const observedJsonlSchema = inspectJsonlSchema(execution.stdout);
  const calibration: CalibrationRecord = {
    schemaVersion: "prompt-governance-calibration-v2",
    scope: "root-instruction-pilot",
    passed: execution.exitCode === 0 && !execution.outputTruncated && !execution.timedOut && !execution.drainTimedOut && !finalCapture.truncated && noWritePassed && finalAnswer.trim() === probeNonce,
    codexVersion,
    codexBinary: codexPath,
    overlays: [overlays.baseline, overlays.candidate],
    observedJsonlSchema,
    rawSchemaOnly: true,
    noWritePassed,
    acknowledgementPassed: finalAnswer.trim() === probeNonce,
    finalAnswerBytes: finalCapture.bytes,
    finalAnswerStoredBytes: Buffer.byteLength(finalAnswer),
    finalAnswerTruncated: finalCapture.truncated,
    exitCode: execution.exitCode,
    outputTruncated: execution.outputTruncated,
    timedOut: execution.timedOut,
    drainTimedOut: execution.drainTimedOut,
    probeNonce,
    probeSha256,
    fixtureBaselineTreeHash: fixture.baselineTreeHash,
    baselineHead: fixture.baselineCommit,
    schemaFingerprint: observedJsonlSchema.schemaFingerprint,
    artifactRoot: calibrationRoot,
  };
  await writeText(join(calibrationRoot, "events.jsonl"), redactSensitiveText(execution.stdout));
  await writeText(join(calibrationRoot, "stderr.log"), redactSensitiveText(execution.stderr));
  await writeText(join(calibrationRoot, "calibration.json"), `${JSON.stringify(calibration, null, 2)}\n`);
  return join(calibrationRoot, "calibration.json");
}

export async function runPilot(options: PilotOptions): Promise<string> {
  await ensureDirectory(options.artifactRoot);
  const planPath = join(options.artifactRoot, "pilot-plan.json");
  const existingPlan = await readJsonIfPresent(planPath);
  const scheduleEntries = existingPlan ? readPlanSchedule(existingPlan) : schedule(options.repetitions);
  const expectedRunCount = scheduleEntries.length;
  const calibration = await readCalibrationIfPresent(options.artifactRoot);
  if (!calibration?.passed) throw new Error("pilot requires a passing calibration artifact before planning or execution");
  validateCalibration(calibration);
  const metricProfile = await readMetricProfile(options.artifactRoot);
  validateMetricProfile(metricProfile, calibration);
  const codexPath = resolveCodexPath(options.codexBinary ?? "codex");
  const codexVersion = getCodexVersion(codexPath);
  assertExactCodexVersion(codexVersion);
  if (options.execute) {
    if (options.repetitions !== evaluationProtocol.repetitions) throw new Error(`paid pilot requires exactly ${evaluationProtocol.repetitions} repetitions`);
    if (options.confirmRuns !== expectedRunCount) throw new Error(`paid pilot requires --confirm-runs ${expectedRunCount}`);
    if (!existingPlan || existingPlan.execute !== false) throw new Error("paid pilot requires an unchanged reviewed dry plan");
  }
  if (!options.execute) {
    await assertAbsent(planPath);
    await assertAbsent(join(options.artifactRoot, "pilot-result.json"));
    await assertAbsent(join(options.artifactRoot, "runs"));
    await assertAbsent(join(options.artifactRoot, "reviewer"));
    await assertAbsent(join(options.artifactRoot, "private"));
  }
  if (codexVersion !== calibration.codexVersion) throw new Error("Codex version differs from calibration");
  const overlays = await validatedCalibrationOverlays(calibration);
  const mappingPath = join(options.artifactRoot, "private", "blind-mapping.json");
  const scheduleMappingPath = join(options.artifactRoot, "private", "schedule-mapping.json");
  const scheduleMapping = await preparePrivateSchedule(scheduleEntries, scheduleMappingPath);
  const calibrationHash = sha256(await readFile(join(options.artifactRoot, "calibration", "calibration.json")));
  const metricProfileHash = sha256(await readFile(join(options.artifactRoot, "metric-profile.json")));
  const privateScheduleHash = sha256(await readFile(scheduleMappingPath));
  const overlayHashes = Object.fromEntries(["baseline", "candidate"].map((condition) => [condition, overlays[condition as Condition].sha256]));
  if (options.execute && existingPlan) await validateReviewedPlan(existingPlan, options, calibrationHash, metricProfileHash, privateScheduleHash, overlayHashes, codexPath, codexVersion);
  const plan = existingPlan ?? {
    schemaVersion: "prompt-governance-pilot-plan-v2",
    protocol: evaluationProtocol,
    repositoryRoot: options.repositoryRoot,
    artifactRoot: options.artifactRoot,
    execute: options.execute,
    repetitions: options.repetitions,
    expectedRunCount,
    confirmedRunCount: options.confirmRuns ?? null,
    codexBinary: codexPath,
    codexVersion,
    calibrationPath: join(options.artifactRoot, "calibration", "calibration.json"),
    calibrationRequired: true,
    frozenOverlays: calibration?.overlays ?? null,
    calibrationHash,
    metricProfileHash,
    overlayHashes,
    privateScheduleHash,
    schedule: scheduleEntries.map(({ sequence, runId, caseId, repetition }) => ({ sequence, runId, caseId, repetition })),
    fixtureBaselineTreeHashes: fixtureHashes(),
    note: "Dry run only. Review this plan, then rerun with --execute and an exact run-count confirmation.",
  };
  if (!existingPlan) {
    const serializedPlan = `${JSON.stringify(plan, null, 2)}\n`;
    await writeAtomicText(planPath, serializedPlan);
    await writeAtomicText(`${planPath}.sha256`, `${sha256(serializedPlan)}\n`);
  }
  if (!options.execute) return planPath;
  const reviewerRoot = join(options.artifactRoot, "reviewer");
  const captures: CaptureResult[] = [];
  const expectedFixtureHashes = fixtureHashes();
  for (const item of scheduleEntries) {
    const capture = await executeRun({
      repositoryRoot: options.repositoryRoot,
      artifactRoot: options.artifactRoot,
      caseId: item.caseId,
      condition: item.condition,
      repetition: item.repetition,
      overlays,
      codexBinary: codexPath,
      codexVersion,
      ...(metricProfile ? { metricProfile } : {}),
      deadlineMs: DEFAULT_DEADLINE_MS,
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      runId: item.runId,
      expectedFixtureBaselineTreeHash: expectedFixtureHashes[item.caseId],
    });
    captures.push(capture);
    await createBlindReviewBundle(capture, reviewerRoot, mappingPath, scheduleMapping.find((entry) => entry.runId === item.runId)!.blindId);
    await writePartialResult(options.artifactRoot, plan, captures, null);
    const stopReason = capture.authorityViolations.length > 0
      ? `authority violation: ${capture.authorityViolations.join(", ")}`
      : capture.verifier.unsafePaths.length > 0
        ? `write outside declared allowlist: ${capture.verifier.unsafePaths.join(", ")}`
      : capture.infrastructureFailure || capture.verifier.headMoved
        ? `infrastructure failure in sequence ${item.sequence} (timedOut=${capture.timedOut}, drainTimedOut=${capture.drainTimedOut}, verificationSkipped=${capture.verificationSkipped}, outputTruncated=${capture.outputTruncated}, finalAnswerTruncated=${capture.finalAnswerTruncated}, diffTruncated=${capture.diffTruncated}, exitCode=${capture.exitCode})`
      : !capture.verifier.passed
        ? `deterministic verifier failure in sequence ${item.sequence}: ${capture.verifier.stderr.trim().slice(0, 256)}`
        : null;
    if (stopReason) {
      await writePartialResult(options.artifactRoot, plan, captures, stopReason);
      throw new Error(`pilot stopped safely after sequence ${item.sequence}: ${stopReason}`);
    }
  }
  const resultPath = join(options.artifactRoot, "pilot-result.json");
  await writeAtomicText(resultPath, `${JSON.stringify({ ...plan, status: "awaiting-review", captures }, null, 2)}\n`);
  return resultPath;
}

export async function reviewPilot(artifactRoot: string): Promise<string> {
  const mapping = JSON.parse(await readFile(join(artifactRoot, "private", "schedule-mapping.json"), "utf8")) as BlindMapping[];
  const blindMapping = JSON.parse(await readFile(join(artifactRoot, "private", "blind-mapping.json"), "utf8")) as BlindMapping[];
  const exportedBundles = new Set((await readdir(join(artifactRoot, "reviewer", "blind"))).filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -5)));
  validateExportedBlindBundles(mapping, exportedBundles);
  const pilot = JSON.parse(await readFile(join(artifactRoot, "pilot-result.json"), "utf8")) as { captures?: CaptureResult[] };
  const captures = pilot.captures ?? [];
  const bundles = await Promise.all(mapping.map(async (entry) => JSON.parse(await readFile(join(artifactRoot, "reviewer", "blind", `${entry.blindId}.json`), "utf8")) as unknown));
  await validateBlindBundles(mapping, captures, bundles);
  const scoreRoot = join(artifactRoot, "reviewer", "scores");
  const scoreFiles = await readdir(scoreRoot);
  const scores: BlindScore[] = [];
  for (const file of scoreFiles.filter((entry) => entry.endsWith(".json")).sort()) {
    scores.push(validateBlindScore(JSON.parse(await readFile(join(scoreRoot, file), "utf8"))));
  }
  validatePrivateReviewArtifacts(mapping, blindMapping, captures);
  const correctnessByRun = new Map(captures.map((capture) => [capture.run.runId, capture.verifier.passed]));
  const gate = evaluateDriftGate(scores, mapping, {
    correctness: Object.fromEntries(blindMapping.map((entry) => [entry.blindId, correctnessByRun.get(entry.runId) === true])),
  });
  const secondaryImprovementObserved = reproducibleSecondaryImprovement(captures);
  const result = { ...gate, secondaryImprovementObserved, passed: gate.passed && secondaryImprovementObserved };
  const path = join(artifactRoot, "review-result.json");
  await writeAtomicText(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

export function validatePrivateReviewArtifacts(scheduleMapping: readonly BlindMapping[], blindMapping: readonly BlindMapping[], captures: readonly CaptureResult[]): void {
  if (scheduleMapping.length === 0 || blindMapping.length !== scheduleMapping.length) throw new Error("private blind mapping is incomplete");
  const scheduleByRun = new Map(scheduleMapping.map((entry) => [entry.runId, entry]));
  const seenBlind = new Set<string>();
  const seenRuns = new Set<string>();
  for (const entry of blindMapping) {
    if (seenBlind.has(entry.blindId) || seenRuns.has(entry.runId)) throw new Error("private blind mapping is not one-to-one");
    const expected = scheduleByRun.get(entry.runId);
    if (!expected || expected.blindId !== entry.blindId || expected.condition !== entry.condition || expected.caseId !== entry.caseId || expected.repetition !== entry.repetition) throw new Error("private blind mapping does not match the frozen schedule");
    seenBlind.add(entry.blindId);
    seenRuns.add(entry.runId);
  }
  if (captures.length !== scheduleMapping.length) throw new Error("pilot captures do not cover the frozen schedule");
  const seenCaptureRuns = new Set<string>();
  for (const capture of captures) {
    if (seenCaptureRuns.has(capture.run.runId)) throw new Error("pilot captures contain duplicate runs");
    const expected = scheduleByRun.get(capture.run.runId);
    if (!expected || expected.condition !== capture.run.condition || expected.caseId !== capture.run.caseId || expected.repetition !== capture.run.repetition) throw new Error("pilot capture does not match the frozen schedule");
    seenCaptureRuns.add(capture.run.runId);
  }
}

export function validateExportedBlindBundles(mapping: readonly BlindMapping[], exportedBundleIds: ReadonlySet<string>): void {
  const expectedBundleIds = new Set(mapping.map((entry) => entry.blindId));
  if (exportedBundleIds.size !== expectedBundleIds.size || [...expectedBundleIds].some((blindId) => !exportedBundleIds.has(blindId))) {
    throw new Error("review corpus contains missing or extra blind bundles");
  }
}

export async function validateBlindBundles(mapping: readonly BlindMapping[], captures: readonly CaptureResult[], bundles: readonly unknown[]): Promise<void> {
  const capturesByRun = new Map(captures.map((capture) => [capture.run.runId, capture]));
  if (bundles.length !== mapping.length) throw new Error("review corpus bundle count does not match the frozen schedule");
  for (const [index, entry] of mapping.entries()) {
    const bundle = bundles[index];
    const capture = capturesByRun.get(entry.runId);
    if (!isRecord(bundle) || bundle.schemaVersion !== "prompt-governance-blind-review-v1" || bundle.blindId !== entry.blindId || bundle.caseId !== entry.caseId) throw new Error("blind bundle identity does not match the private schedule");
    if (!capture || !isRecord(bundle.verifier)) throw new Error("blind bundle is missing its mapped capture verifier");
    const rubric = canonicalBlindRubric();
    if (!isRecord(bundle.driftRubric) || Object.keys(bundle.driftRubric).length !== Object.keys(rubric).length || Object.entries(rubric).some(([dimension, text]) => bundle.driftRubric[dimension] !== text)) throw new Error("blind bundle rubric does not match the canonical seven-dimension rubric");
    const expectedContent = await renderBlindReviewContent(capture);
    if (bundle.taskPrompt !== expectedContent.taskPrompt || bundle.finalAnswer !== expectedContent.finalAnswer || bundle.diff !== expectedContent.diff) throw new Error("blind bundle scored content does not match its mapped capture");
    const verifier = bundle.verifier;
    if (verifier.passed !== capture.verifier.passed || verifier.exitCode !== capture.verifier.exitCode || verifier.expectedNoWrite !== capture.verifier.expectedNoWrite || verifier.headMoved !== capture.verifier.headMoved || JSON.stringify(verifier.changedPaths) !== JSON.stringify(capture.verifier.changedPaths) || JSON.stringify(verifier.unsafePaths) !== JSON.stringify(capture.verifier.unsafePaths)) throw new Error("blind bundle verifier facts do not match its mapped capture");
  }
}

export function reproducibleSecondaryImprovement(captures: readonly CaptureResult[]): boolean {
  const metrics = ["tokens", "subagents", "rework", "toolLoops", "unnecessaryClarification"] as const;
  for (const metric of metrics) {
    let supported = true;
    let strictlyLower = false;
    for (const baseline of captures.filter((capture) => capture.run.condition === "baseline")) {
      const candidate = captures.find((capture) => capture.run.caseId === baseline.run.caseId && capture.run.repetition === baseline.run.repetition && capture.run.condition === "candidate");
      const baselineValue = baseline.secondaryMetrics[metric];
      const candidateValue = candidate?.secondaryMetrics[metric];
      if (typeof baselineValue !== "number" || typeof candidateValue !== "number") { supported = false; break; }
      if (candidateValue > baselineValue) { supported = false; break; }
      if (candidateValue < baselineValue) strictlyLower = true;
    }
    if (supported && strictlyLower) return true;
  }
  return false;
}

export function schedule(repetitions: number): ScheduleEntry[] {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error(`repetitions must be an integer from 1 to 3: ${repetitions}`);
  const result: ScheduleEntry[] = [];
  let sequence = 0;
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const conditions: readonly Condition[] = repetition % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const caseId of ["bounded-fix", "evidence-gated-hardening", "material-ambiguity", "read-only-diagnosis"] as const) {
      for (const condition of conditions) {
        result.push({ sequence: sequence++, runId: randomUUID(), caseId, repetition, condition });
      }
    }
  }
  return result;
}

async function runSupervisedCommand(command: readonly string[], prompt: string, cwd: string, artifactRoot: string): Promise<SpawnResult> {
  const { spawnCodexForCalibration } = await import("./capture");
  return spawnCodexForCalibration(command, prompt, cwd, artifactRoot);
}

async function readOptionalCapped(path: string, cap: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  try {
    return await readCappedText(path, cap);
  } catch {
    return { text: "", bytes: 0, truncated: true };
  }
}

async function readCalibrationIfPresent(root: string): Promise<CalibrationRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(root, "calibration", "calibration.json"), "utf8")) as CalibrationRecord;
  } catch {
    return undefined;
  }
}

async function readJsonIfPresent(path: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function validatedCalibrationOverlays(calibration: CalibrationRecord): Promise<OverlayPair> {
  const records = calibration.overlays;
  if (records.length !== 2) throw new Error("calibration must contain baseline and candidate overlays");
  for (const record of records) {
    const contents = await readText(record.materializedPath);
    if (sha256(contents) !== record.sha256) throw new Error(`calibrated overlay changed: ${record.overlayId}`);
  }
  const baseline = records.find((record) => record.condition === "baseline");
  const candidate = records.find((record) => record.condition === "candidate");
  if (!baseline || !candidate) throw new Error("calibration overlays are incomplete");
  return { baseline, candidate };
}

function validateCalibration(calibration: CalibrationRecord): void {
  if (calibration.schemaVersion !== "prompt-governance-calibration-v2" || calibration.rawSchemaOnly !== true) throw new Error("calibration must remain raw-schema-only");
  if (!calibration.acknowledgementPassed || !calibration.noWritePassed || calibration.outputTruncated || calibration.timedOut || calibration.drainTimedOut) throw new Error("calibration probe did not pass");
  if (calibration.schemaFingerprint !== calibration.observedJsonlSchema.schemaFingerprint) throw new Error("calibration schema fingerprint mismatch");
}

async function readMetricProfile(root: string): Promise<MetricProfile> {
  try {
    return JSON.parse(await readFile(join(root, "metric-profile.json"), "utf8")) as MetricProfile;
  } catch {
    throw new Error("paid pilot requires a separately reviewed metric-profile.json artifact");
  }
}

export function validateMetricProfile(profile: MetricProfile, calibration: CalibrationRecord): void {
  if (profile.schemaVersion !== "prompt-governance-metric-profile-v1" || profile.parserVersion !== "metric-profile-v1") throw new Error("metric profile schema is not accepted");
  if (!profile.profileId?.trim() || !profile.reviewedBy?.trim() || !profile.reviewedAt?.trim()) throw new Error("metric profile requires review metadata");
  if (!Number.isFinite(Date.parse(profile.reviewedAt))) throw new Error("metric profile reviewedAt is invalid");
  if (profile.codexVersion !== calibration.codexVersion || profile.schemaFingerprint !== calibration.schemaFingerprint) throw new Error("metric profile does not match calibrated Codex schema");
  const metricNames = ["tokens", "subagents", "rework", "toolLoops", "unnecessaryClarification"] as const;
  if (!profile.selectors || typeof profile.selectors !== "object") throw new Error("metric profile requires a complete selector map");
  if (Object.keys(profile.selectors).some((name) => !(metricNames as readonly string[]).includes(name)) || metricNames.some((name) => !Object.prototype.hasOwnProperty.call(profile.selectors, name))) throw new Error("metric profile selector map must contain exactly the five metric keys");
  if (!metricNames.some((name) => profile.selectors[name] !== null)) throw new Error("metric profile requires at least one observed secondary metric");
  for (const name of metricNames) {
    const selector = profile.selectors[name];
    if (selector && (!Array.isArray(selector.eventTypes) || selector.eventTypes.length === 0 || !selector.path || !["delta", "cumulative-total", "count"].includes(selector.aggregation))) {
      throw new Error(`metric profile selector is invalid for ${name}`);
    }
    if (selector && (selector.eventTypes.some((eventType) => !calibration.observedJsonlSchema.eventTypes.includes(eventType)) || !calibration.observedJsonlSchema.observedPaths.includes(selector.path))) throw new Error(`metric profile selector for ${name} is absent from the reviewed calibration schema`);
  }
}

function readPlanSchedule(plan: Record<string, any>): ScheduleEntry[] {
  if (!Array.isArray(plan.schedule) || plan.schedule.length === 0) throw new Error("pilot plan has no frozen schedule");
  return plan.schedule.map((entry: any, index: number) => {
    if (typeof entry.sequence !== "number" || typeof entry.runId !== "string" || typeof entry.caseId !== "string" || typeof entry.repetition !== "number") throw new Error("pilot plan schedule is invalid");
    const odd = entry.repetition % 2 === 1;
    const first = index % 2 === 0;
    return { sequence: entry.sequence, runId: entry.runId, caseId: entry.caseId as PilotCaseId, repetition: entry.repetition, condition: (odd === first ? "baseline" : "candidate") as Condition };
  });
}

async function validateReviewedPlan(plan: Record<string, any>, options: PilotOptions, calibrationHash: string, metricProfileHash: string, privateScheduleHash: string, overlayHashes: Readonly<Record<string, string>>, codexPath: string, codexVersion: string): Promise<void> {
  if (plan.schemaVersion !== "prompt-governance-pilot-plan-v2" || plan.execute !== false) throw new Error("pilot plan is not an unchanged dry plan");
  const serializedPlan = `${JSON.stringify(plan, null, 2)}\n`;
  const expectedHash = (await readFile(`${join(options.artifactRoot, "pilot-plan.json")}.sha256`, "utf8")).trim();
  if (sha256(serializedPlan) !== expectedHash) throw new Error("pilot plan integrity hash changed");
  if (plan.repositoryRoot !== options.repositoryRoot || plan.artifactRoot !== options.artifactRoot || plan.repetitions !== options.repetitions) throw new Error("pilot plan scope changed");
  if (plan.expectedRunCount !== schedule(options.repetitions).length) throw new Error("pilot plan run count changed");
  if (JSON.stringify(plan.fixtureBaselineTreeHashes) !== JSON.stringify(fixtureHashes())) throw new Error("pilot plan fixture hashes changed");
  if (plan.calibrationHash !== calibrationHash || plan.metricProfileHash !== metricProfileHash || plan.privateScheduleHash !== privateScheduleHash) throw new Error("pilot plan reviewed input hash changed");
  if (JSON.stringify(plan.overlayHashes) !== JSON.stringify(overlayHashes) || plan.codexBinary !== codexPath || plan.codexVersion !== codexVersion) throw new Error("pilot plan reviewed overlay or binary changed");
}

async function preparePrivateSchedule(entries: readonly ScheduleEntry[], path: string): Promise<PrivateScheduleEntry[]> {
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as PrivateScheduleEntry[];
    if (existing.length !== entries.length || existing.some((entry, index) => entry.runId !== entries[index]?.runId || entry.sequence !== entries[index]?.sequence || entry.caseId !== entries[index]?.caseId || entry.repetition !== entries[index]?.repetition || entry.condition !== entries[index]?.condition || !entry.blindId)) throw new Error("private schedule mapping changed");
    return existing;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const mapping = entries.map((entry) => ({ ...entry, blindId: randomUUID() }));
    await writeAtomicText(path, `${JSON.stringify(mapping, null, 2)}\n`);
    return mapping;
  }
}

async function writePartialResult(root: string, plan: Record<string, any>, captures: readonly CaptureResult[], stopReason: string | null): Promise<void> {
  await writeAtomicText(join(root, "pilot-result.json"), `${JSON.stringify({ ...plan, status: stopReason ? "stopped" : "partial", stopReason, captures }, null, 2)}\n`);
}

function fixtureHashes(): Readonly<Record<PilotCaseId, string>> {
  const entries: Record<PilotCaseId, string> = {} as Record<PilotCaseId, string>;
  for (const caseId of ["bounded-fix", "evidence-gated-hardening", "material-ambiguity", "read-only-diagnosis"] as const) {
    const fixture = getPilotCase(caseId);
    entries[caseId] = canonicalFixtureSnapshotHash(fixture);
  }
  return entries;
}

async function ensureFreshDirectory(path: string): Promise<void> {
  await mkdir(path);
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await readFile(path);
    throw new Error(`artifact already exists; refusing to overwrite: ${path}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
