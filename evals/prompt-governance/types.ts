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
  readonly schemaVersion: "prompt-governance-run-v1";
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
  readonly path: string;
  readonly aggregation: "delta" | "cumulative-total" | "count";
}

/** A reviewed, schema-specific parser contract. Calibration never creates this. */
export interface MetricProfile {
  readonly schemaVersion: "prompt-governance-metric-profile-v1";
  readonly profileId: string;
  readonly codexVersion: string;
  readonly schemaFingerprint: string;
  readonly parserVersion: "metric-profile-v1";
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly selectors: Readonly<Record<MetricName, MetricSelector | null>>;
}

export interface CalibrationRecord {
  readonly schemaVersion: "prompt-governance-calibration-v2";
  readonly scope: "root-instruction-pilot";
  readonly passed: boolean;
  readonly codexVersion: string;
  readonly codexBinary: string;
  readonly overlays: readonly OverlayRecord[];
  readonly observedJsonlSchema: ObservedJsonlSchema;
  readonly rawSchemaOnly: true;
  readonly noWritePassed: boolean;
  readonly acknowledgementPassed: boolean;
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
}

export interface CaptureResult {
  readonly schemaVersion: "prompt-governance-capture-v1";
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
  readonly schemaVersion: "prompt-governance-blind-review-v1";
  readonly blindId: string;
  readonly caseId: PilotCaseId;
  readonly taskPrompt: string;
  readonly finalAnswer: string;
  readonly diff: string;
  readonly verifier: Pick<VerifierResult, "passed" | "exitCode" | "changedPaths" | "unsafePaths" | "expectedNoWrite" | "headMoved">;
  readonly driftRubric: Readonly<Record<DriftDimension, string>>;
}
