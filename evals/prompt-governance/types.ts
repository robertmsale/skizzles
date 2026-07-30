export type Condition = "baseline" | "candidate";

export type PilotCaseId =
  | "bounded-fix"
  | "evidence-gated-hardening"
  | "material-ambiguity"
  | "read-only-diagnosis";

export interface PilotCase {
  readonly id: PilotCaseId;
  readonly title: string;
  readonly taskPrompt: string;
  readonly allowlist: readonly string[];
  readonly expectedNoWrite: boolean;
  readonly fixtureFiles: Readonly<Record<string, string>>;
  readonly verifier: string;
}

export type AmbientManagedPolicy = "not-detected" | "detected" | "unknown";

export interface MeasurementScope {
  readonly schemaVersion: "prompt-governance-measurement-scope-v1";
  readonly authMode: "caller-managed-CODEX_HOME";
  readonly userConfigLoaded: true;
  readonly userProjectRulesIgnored: true;
  readonly taskScope: "root-instruction-only";
  readonly subagents: "disabled-not-observed";
  readonly fixedFlags: readonly string[];
  readonly configControls: readonly string[];
  readonly codexHomePresent: boolean;
  readonly homePresent: boolean;
  readonly tmpdirPresent: boolean;
  readonly codexBinary: string;
  readonly codexVersion: string;
  readonly ambientManagedPolicy: AmbientManagedPolicy;
}

export interface TreeEntry {
  readonly kind: "file" | "symlink";
  readonly sha256: string;
  readonly byteLength: number;
  readonly target?: string;
}

export type TreeSnapshot = Readonly<Record<string, TreeEntry>>;

export interface OverlayRecord {
  readonly condition: Condition;
  readonly sourceRevision: string;
  readonly materializedPath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly overlayId: string;
}

export interface RunManifest {
  readonly schemaVersion: "prompt-governance-run-v2";
  readonly runId: string;
  readonly caseId: PilotCaseId;
  readonly condition: Condition;
  readonly repetition: number;
  readonly fixtureRoot: string;
  readonly artifactRoot: string;
  readonly overlays: readonly OverlayRecord[];
  readonly fileAllowlist: readonly string[];
  readonly expectedNoWrite: boolean;
  readonly codexVersion: string;
  readonly model: "gpt-5.6-sol";
  readonly reasoningEffort: "high";
  readonly command: readonly string[];
  readonly measurementScope: MeasurementScope;
  readonly baselineHead: string;
  readonly fixtureBaselineTreeHash: string;
  readonly oracleVerifierHash: string;
  readonly headMoved: boolean;
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
  readonly drainTimedOut: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutStoredBytes: number;
  readonly stderrStoredBytes: number;
  readonly finalAnswerBytes: number;
  readonly finalAnswerStoredBytes: number;
  readonly finalAnswerTruncated: boolean;
  readonly diffBytes: number;
  readonly diffStoredBytes: number;
  readonly diffTruncated: boolean;
  readonly authorityViolations: readonly string[];
  readonly infrastructureFailure: boolean;
  readonly verificationSkipped: boolean;
  readonly snapshotSourcePreHash: string;
  readonly snapshotSourcePostHash: string;
  readonly snapshotCopyHash: string;
  readonly snapshotVerificationPostHash: string;
  readonly snapshotStable: boolean;
  readonly processGroupTeardown: "best-effort";
  readonly deadlineMs: number;
  readonly killGraceMs: number;
  readonly environmentKeys: readonly string[];
  readonly networkPolicy: string;
  readonly approvalPolicy: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
}

export interface VerifierResult {
  readonly passed: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly changedPaths: readonly string[];
  readonly unsafePaths: readonly string[];
  readonly expectedNoWrite: boolean;
  readonly baselineTreeHash: string;
  readonly finalTreeHash: string;
  readonly baselineHead: string;
  readonly finalHead: string;
  readonly headMoved: boolean;
  readonly oracleVerifierHash: string;
}

export interface ObservedJsonlSchema {
  readonly schemaVersion: "observed-jsonl-v1";
  readonly lineCount: number;
  readonly validJsonLines: number;
  readonly invalidJsonLines: number;
  readonly eventTypes: readonly string[];
  readonly topLevelKeys: readonly string[];
  readonly payloadKeys: readonly string[];
  readonly observedPaths: readonly string[];
  readonly eventPathPairs: readonly string[];
  readonly schemaFingerprint: string;
}

export type ObservedMetric = number | "unavailable";

export interface SecondaryMetrics {
  readonly toolLoops: ObservedMetric;
  readonly tokens: ObservedMetric;
  readonly subagents: ObservedMetric;
  readonly rework: ObservedMetric;
  readonly unnecessaryClarification: ObservedMetric;
}

export interface ObservedMetricPaths {
  readonly tokens: readonly string[];
  readonly subagents: readonly string[];
  readonly rework: readonly string[];
  readonly toolLoops: readonly string[];
  readonly unnecessaryClarification: readonly string[];
}

export type MetricName = keyof SecondaryMetrics;

export interface MetricSelector {
  readonly eventTypes: readonly string[];
  readonly paths: readonly string[];
  readonly aggregation: "delta" | "cumulative-total" | "count" | "sum-components";
}

export type MetricSelectorId = string;

/** A reviewed, schema-specific parser contract. Calibration never creates this. */
export interface MetricProfile {
  readonly schemaVersion: "prompt-governance-metric-selection-v3";
  readonly registryId: string;
  readonly selectorCommitmentHash: string;
  readonly schemaFingerprint: string;
  readonly enabledMetrics: readonly Exclude<MetricName, "subagents">[];
  readonly selectorIds: Readonly<Partial<Record<Exclude<MetricName, "subagents">, MetricSelectorId>>>;
}

export interface CalibrationRecord {
  readonly schemaVersion: "prompt-governance-calibration-v5";
  readonly scope: "root-instruction-pilot";
  readonly passed: boolean;
  readonly codexVersion: string;
  readonly codexBinary: string;
  readonly overlays: readonly OverlayRecord[];
  readonly observedJsonlSchema: ObservedJsonlSchema;
  readonly rawSchemaOnly: true;
  readonly noWritePassed: boolean;
  readonly acknowledgementPassed: boolean;
  readonly authorityViolations: readonly string[];
  readonly failureCategory: string;
  readonly measurementScope: MeasurementScope;
  readonly measurementScopeFingerprint: string;
  readonly finalAnswerBytes: number;
  readonly finalAnswerStoredBytes: number;
  readonly finalAnswerTruncated: boolean;
  readonly exitCode: number;
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
  readonly drainTimedOut: boolean;
  readonly probeNonce: string;
  readonly probeSha256: string;
  readonly fixtureBaselineTreeHash: string;
  readonly baselineHead: string;
  readonly schemaFingerprint: string;
  readonly artifactRoot: string;
  readonly selectorCommitment: readonly string[];
}

export interface CaptureResult {
  readonly schemaVersion: "prompt-governance-capture-v2";
  readonly run: RunManifest;
  readonly commandText: string;
  readonly codexVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number;
  readonly taskPrompt: string;
  readonly finalAnswer: string;
  readonly rawEventsPath: string;
  readonly finalAnswerPath: string;
  readonly diffPath: string;
  readonly verifierPath: string;
  readonly fileAllowlist: readonly string[];
  readonly verifier: VerifierResult;
  readonly observedJsonlSchema: ObservedJsonlSchema;
  readonly secondaryMetrics: SecondaryMetrics;
  readonly observedMetricPaths: ObservedMetricPaths;
  readonly metricProfileId?: string;
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
  readonly drainTimedOut: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutStoredBytes: number;
  readonly stderrStoredBytes: number;
  readonly finalAnswerBytes: number;
  readonly finalAnswerStoredBytes: number;
  readonly finalAnswerTruncated: boolean;
  readonly diffBytes: number;
  readonly diffStoredBytes: number;
  readonly diffTruncated: boolean;
  readonly authorityViolations: readonly string[];
  readonly infrastructureFailure: boolean;
  readonly verificationSkipped: boolean;
  readonly snapshotStable: boolean;
}

export const driftDimensions = [
  "boundary",
  "decision",
  "mechanism",
  "process",
  "evidence",
  "authority",
  "completion",
] as const;

export type DriftDimension = (typeof driftDimensions)[number];

export interface BlindScore {
  readonly schemaVersion: "prompt-governance-blind-score-v1";
  readonly blindId: string;
  readonly reviewerId: string;
  readonly scores: Readonly<Record<DriftDimension, 0 | 1 | 2 | 3>>;
  readonly rationale: Readonly<Record<DriftDimension, string>>;
}

export interface BlindReviewBundle {
  readonly schemaVersion: "prompt-governance-blind-review-v2";
  readonly blindId: string;
  readonly caseId: PilotCaseId;
  readonly taskPrompt: string;
  readonly finalAnswer: string;
  readonly diff: string;
  readonly verifier: Pick<VerifierResult, "passed" | "exitCode" | "changedPaths" | "unsafePaths" | "expectedNoWrite" | "headMoved">;
  readonly driftRubric: Readonly<Record<DriftDimension, string>>;
}

/** Content-free calibration evidence safe to persist under the public root. */
export interface PersistedCalibrationEvidence {
  readonly schemaVersion: "prompt-governance-calibration-v5";
  readonly scope: "root-instruction-pilot";
  readonly passed: boolean;
  readonly codexVersion: string;
  readonly overlays: readonly Readonly<Pick<OverlayRecord, "condition" | "sourceRevision" | "sha256" | "byteLength" | "overlayId" | "materializedPath">>[];
  readonly observedJsonlSchema: Pick<ObservedJsonlSchema, "schemaVersion" | "lineCount" | "validJsonLines" | "invalidJsonLines" | "schemaFingerprint">;
  readonly selectorCommitment: readonly string[];
  readonly rawSchemaOnly: true;
  readonly noWritePassed: boolean;
  readonly acknowledgementPassed: boolean;
  readonly authorityViolationCount: number;
  readonly failureCategory: string;
  readonly measurementScope: Omit<MeasurementScope, "codexBinary"> & { readonly codexBinary: string };
  readonly measurementScopeFingerprint: string;
  readonly finalAnswerBytes: number;
  readonly finalAnswerStoredBytes: number;
  readonly finalAnswerTruncated: boolean;
  readonly exitCode: number;
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
  readonly drainTimedOut: boolean;
  readonly fixtureBaselineTreeHash: string;
  readonly baselineHead: string;
  readonly schemaFingerprint: string;
}

/** Content-free capture evidence safe to persist under the public root. */
export interface PersistedCaptureEvidence {
  readonly schemaVersion: "prompt-governance-capture-evidence-v1";
  readonly run: Readonly<{
    readonly runId: string;
    readonly caseId: PilotCaseId;
    readonly condition: Condition;
    readonly repetition: number;
    readonly fixtureBaselineTreeHash: string;
    readonly oracleVerifierHash: string;
  }>;
  readonly runId: string;
  readonly caseId: PilotCaseId;
  readonly condition: Condition;
  readonly repetition: number;
  readonly codexVersion: string;
  readonly model: "gpt-5.6-sol";
  readonly reasoningEffort: "high";
  readonly fixtureBaselineTreeHash: string;
  readonly oracleVerifierHash: string;
  readonly measurementScopeFingerprint: string;
  readonly verifierPassed: boolean;
  readonly verifierExitCode: number;
  readonly expectedNoWrite: boolean;
  readonly headMoved: boolean;
  readonly changedPathCount: number;
  readonly unsafePathCount: number;
  readonly observedJsonlSchemaFingerprint: string;
  readonly observedJsonlLineCount: number;
  readonly secondaryMetrics: SecondaryMetrics;
  readonly observedMetricPathCount: number;
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
  readonly drainTimedOut: boolean;
  readonly finalAnswerTruncated: boolean;
  readonly diffTruncated: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutStoredBytes: number;
  readonly stderrStoredBytes: number;
  readonly finalAnswerBytes: number;
  readonly finalAnswerStoredBytes: number;
  readonly diffBytes: number;
  readonly diffStoredBytes: number;
  readonly authorityViolationCount: number;
  readonly infrastructureFailure: boolean;
  readonly verificationSkipped: boolean;
  readonly snapshotStable: boolean;
}

export interface PersistedPilotPlan {
  readonly schemaVersion: "prompt-governance-pilot-plan-v3";
  readonly protocol: typeof import("./protocol").evaluationProtocol;
  readonly execute: boolean;
  readonly repetitions: number;
  readonly expectedRunCount: number;
  readonly confirmedRunCount: number | null;
  readonly codexVersion: string;
  readonly calibrationRequired: true;
  readonly calibrationHash: string;
  readonly measurementScopeFingerprint: string;
  readonly metricProfileHash: string;
  readonly overlayHashes: Readonly<Record<Condition, string>>;
  readonly privateScheduleHash: string;
  readonly cacheLocator: import("./cache").CacheLocator | null;
  readonly schedule: readonly Pick<ScheduleEntry, "sequence" | "runId" | "caseId" | "repetition">[];
  readonly fixtureBaselineTreeHashes: Readonly<Record<PilotCaseId, string>>;
  readonly note: string;
}

export interface ScheduleEntry {
  readonly sequence: number;
  readonly runId: string;
  readonly caseId: PilotCaseId;
  readonly repetition: number;
  readonly condition?: Condition;
}
