import { sha256 } from "./fs";
import { relative } from "node:path";
import type { CalibrationRecord, CaptureResult, ObservedJsonlSchema, PersistedCalibrationEvidence, PersistedCaptureEvidence } from "./types";

export function selectorCommitment(schema: ObservedJsonlSchema): string[] {
  return schema.eventPathPairs.map((pair) => sha256(pair)).sort();
}

export function projectCalibrationEvidence(calibration: CalibrationRecord, publicRoot: string): PersistedCalibrationEvidence {
  return {
    schemaVersion: "prompt-governance-calibration-v5",
    scope: calibration.scope,
    passed: calibration.passed,
    codexVersion: calibration.codexVersion,
    overlays: calibration.overlays.map(({ condition, sourceRevision, sha256: hash, byteLength, overlayId, materializedPath }) => ({ condition, sourceRevision, sha256: hash, byteLength, overlayId, materializedPath: relative(publicRoot, materializedPath) })),
    observedJsonlSchema: {
      schemaVersion: calibration.observedJsonlSchema.schemaVersion,
      lineCount: calibration.observedJsonlSchema.lineCount,
      validJsonLines: calibration.observedJsonlSchema.validJsonLines,
      invalidJsonLines: calibration.observedJsonlSchema.invalidJsonLines,
      schemaFingerprint: calibration.observedJsonlSchema.schemaFingerprint,
    },
    selectorCommitment: calibration.selectorCommitment,
    rawSchemaOnly: true,
    noWritePassed: calibration.noWritePassed,
    acknowledgementPassed: calibration.acknowledgementPassed,
    authorityViolationCount: calibration.authorityViolations.length,
    failureCategory: calibration.failureCategory,
    measurementScope: calibration.measurementScope,
    measurementScopeFingerprint: calibration.measurementScopeFingerprint,
    finalAnswerBytes: calibration.finalAnswerBytes,
    finalAnswerStoredBytes: calibration.finalAnswerStoredBytes,
    finalAnswerTruncated: calibration.finalAnswerTruncated,
    exitCode: calibration.exitCode,
    outputTruncated: calibration.outputTruncated,
    timedOut: calibration.timedOut,
    drainTimedOut: calibration.drainTimedOut,
    fixtureBaselineTreeHash: calibration.fixtureBaselineTreeHash,
    baselineHead: calibration.baselineHead,
    schemaFingerprint: calibration.schemaFingerprint,
  };
}

export function projectCaptureEvidence(capture: CaptureResult): PersistedCaptureEvidence {
  return {
    schemaVersion: "prompt-governance-capture-evidence-v1",
    run: {
      runId: capture.run.runId,
      caseId: capture.run.caseId,
      condition: capture.run.condition,
      repetition: capture.run.repetition,
      fixtureBaselineTreeHash: capture.run.fixtureBaselineTreeHash,
      oracleVerifierHash: capture.run.oracleVerifierHash,
    },
    runId: capture.run.runId,
    caseId: capture.run.caseId,
    condition: capture.run.condition,
    repetition: capture.run.repetition,
    codexVersion: capture.codexVersion,
    model: capture.run.model,
    reasoningEffort: capture.run.reasoningEffort,
    fixtureBaselineTreeHash: capture.run.fixtureBaselineTreeHash,
    oracleVerifierHash: capture.run.oracleVerifierHash,
    measurementScopeFingerprint: sha256(JSON.stringify(capture.run.measurementScope)),
    verifierPassed: capture.verifier.passed,
    verifierExitCode: capture.verifier.exitCode,
    expectedNoWrite: capture.verifier.expectedNoWrite,
    headMoved: capture.verifier.headMoved,
    changedPathCount: capture.verifier.changedPaths.length,
    unsafePathCount: capture.verifier.unsafePaths.length,
    observedJsonlSchemaFingerprint: capture.observedJsonlSchema.schemaFingerprint,
    observedJsonlLineCount: capture.observedJsonlSchema.lineCount,
    secondaryMetrics: capture.secondaryMetrics,
    observedMetricPathCount: Object.values(capture.observedMetricPaths).reduce((sum, paths) => sum + paths.length, 0),
    outputTruncated: capture.outputTruncated,
    timedOut: capture.timedOut,
    drainTimedOut: capture.drainTimedOut,
    finalAnswerTruncated: capture.finalAnswerTruncated,
    diffTruncated: capture.diffTruncated,
    stdoutBytes: capture.stdoutBytes,
    stderrBytes: capture.stderrBytes,
    stdoutStoredBytes: capture.stdoutStoredBytes,
    stderrStoredBytes: capture.stderrStoredBytes,
    finalAnswerBytes: capture.finalAnswerBytes,
    finalAnswerStoredBytes: capture.finalAnswerStoredBytes,
    diffBytes: capture.diffBytes,
    diffStoredBytes: capture.diffStoredBytes,
    authorityViolationCount: capture.authorityViolations.length,
    infrastructureFailure: capture.infrastructureFailure,
    verificationSkipped: capture.verificationSkipped,
    snapshotStable: capture.snapshotStable,
  };
}
