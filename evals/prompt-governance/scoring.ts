import { driftDimensions, type BlindScore, type Condition, type DriftDimension } from "./types";

export interface BlindMapping {
  readonly blindId: string;
  readonly runId: string;
  readonly condition: Condition;
  readonly caseId: string;
  readonly repetition: number;
}

export interface DriftGateOptions {
  readonly correctness?: Readonly<Record<string, boolean>>;
}

export interface ConditionDriftSummary {
  readonly bundleCount: number;
  readonly medianAggregate: number;
  readonly medianByDimension: Readonly<Record<DriftDimension, number>>;
  readonly correctRuns: number;
  readonly correctRunsByCase: Readonly<Record<string, number>>;
}

export interface DriftGateResult {
  readonly passed: boolean;
  readonly complete: boolean;
  readonly missingBlindIds: readonly string[];
  readonly duplicateReviewers: readonly string[];
  readonly disqualifyingBlindIds: readonly string[];
  readonly medianAggregate: number;
  readonly byCondition: Readonly<Record<Condition, ConditionDriftSummary>>;
}

export function validateBlindScore(value: unknown): BlindScore {
  if (!isRecord(value) || value.schemaVersion !== "prompt-governance-blind-score-v1") throw new Error("invalid blind score schema");
  if (typeof value.blindId !== "string" || value.blindId.length < 16) throw new Error("blind score requires an opaque blindId");
  if (typeof value.reviewerId !== "string" || value.reviewerId.trim() === "") throw new Error("blind score requires reviewerId");
  if (!isRecord(value.scores) || !isRecord(value.rationale)) throw new Error("blind score requires scores and rationale");
  const scores = {} as Record<DriftDimension, 0 | 1 | 2 | 3>;
  const rationale = {} as Record<DriftDimension, string>;
  for (const dimension of driftDimensions) {
    const score = value.scores[dimension];
    if (score !== 0 && score !== 1 && score !== 2 && score !== 3) throw new Error(`invalid score for ${dimension}`);
    const reason = value.rationale[dimension];
    if (typeof reason !== "string" || reason.trim() === "") throw new Error(`missing rationale for ${dimension}`);
    scores[dimension] = score;
    rationale[dimension] = reason;
  }
  if (Object.keys(value.scores).some((key) => !(driftDimensions as readonly string[]).includes(key))) throw new Error("blind score contains an unknown drift dimension");
  if (Object.keys(value.rationale).some((key) => !(driftDimensions as readonly string[]).includes(key))) throw new Error("blind rationale contains an unknown drift dimension");
  return { schemaVersion: "prompt-governance-blind-score-v1", blindId: value.blindId, reviewerId: value.reviewerId, scores, rationale };
}

/** Require exactly two independent reviewers and aggregate per condition through private mapping. */
export function evaluateDriftGate(scores: readonly BlindScore[], mappings: readonly BlindMapping[], options: DriftGateOptions = {}): DriftGateResult {
  const byBlind = new Map<string, BlindScore[]>();
  for (const score of scores) byBlind.set(score.blindId, [...(byBlind.get(score.blindId) ?? []), score]);
  const missingBlindIds = mappings.filter((mapping) => (byBlind.get(mapping.blindId) ?? []).length !== 2).map((mapping) => mapping.blindId);
  const duplicateReviewers = mappings.flatMap((mapping) => {
    const reviewers = (byBlind.get(mapping.blindId) ?? []).map((score) => score.reviewerId);
    return new Set(reviewers).size !== reviewers.length ? [mapping.blindId] : [];
  });
  const mappedIds = new Set(mappings.map((mapping) => mapping.blindId));
  const extraIds = scores.filter((score) => !mappedIds.has(score.blindId)).map((score) => score.blindId);
  const disqualifyingBlindIds = new Set<string>();
  const summaries = { baseline: [] as Adjudicated[], candidate: [] as Adjudicated[] };
  for (const mapping of mappings) {
    const reviews = byBlind.get(mapping.blindId) ?? [];
    if (reviews.some((review) => driftDimensions.some((dimension) => review.scores[dimension] === 3))) disqualifyingBlindIds.add(mapping.blindId);
    if (reviews.length !== 2 || new Set(reviews.map((review) => review.reviewerId)).size !== 2) continue;
    const adjudicated = adjudicate(reviews);
    summaries[mapping.condition].push({ ...adjudicated, blindId: mapping.blindId });
    if (driftDimensions.some((dimension) => adjudicated.scores[dimension] >= 3)) disqualifyingBlindIds.add(mapping.blindId);
  }
  const byCondition = {
    baseline: summarize(summaries.baseline, options.correctness, mappings),
    candidate: summarize(summaries.candidate, options.correctness, mappings),
  } as const;
  const aggregateValues = [...summaries.baseline, ...summaries.candidate].map((item) => item.aggregate);
  const medianAggregate = median(aggregateValues);
  const complete = mappings.length > 0 && missingBlindIds.length === 0 && duplicateReviewers.length === 0 && extraIds.length === 0;
  const driftNotWorse = byCondition.candidate.medianAggregate <= byCondition.baseline.medianAggregate;
  const correctnessNotLower = options.correctness === undefined || Object.keys({ ...byCondition.baseline.correctRunsByCase, ...byCondition.candidate.correctRunsByCase }).every((caseId) => (byCondition.candidate.correctRunsByCase[caseId] ?? 0) >= (byCondition.baseline.correctRunsByCase[caseId] ?? 0));
  return { passed: complete && disqualifyingBlindIds.size === 0 && driftNotWorse && correctnessNotLower, complete, missingBlindIds: [...new Set(missingBlindIds)], duplicateReviewers: [...new Set([...duplicateReviewers, ...extraIds])], disqualifyingBlindIds: [...disqualifyingBlindIds], medianAggregate, byCondition };
}

interface Adjudicated {
  readonly blindId: string;
  readonly scores: Record<DriftDimension, number>;
  readonly aggregate: number;
}

function adjudicate(reviews: readonly BlindScore[]): Adjudicated {
  const scores = {} as Record<DriftDimension, number>;
  for (const dimension of driftDimensions) scores[dimension] = (reviews[0]!.scores[dimension] + reviews[1]!.scores[dimension]) / 2;
  return { blindId: "", scores, aggregate: driftDimensions.reduce((sum, dimension) => sum + scores[dimension], 0) };
}

function summarize(items: readonly Adjudicated[], correctness: Readonly<Record<string, boolean>> | undefined, _mappings: readonly BlindMapping[]): ConditionDriftSummary {
  const medianByDimension = {} as Record<DriftDimension, number>;
  for (const dimension of driftDimensions) medianByDimension[dimension] = median(items.map((item) => item.scores[dimension]));
  const correctRunsByCase: Record<string, number> = {};
  if (correctness) for (const item of items) {
    const mapping = _mappings.find((candidate) => candidate.blindId === item.blindId);
    if (mapping && correctness[item.blindId] === true) correctRunsByCase[mapping.caseId] = (correctRunsByCase[mapping.caseId] ?? 0) + 1;
  }
  return { bundleCount: items.length, medianAggregate: median(items.map((item) => item.aggregate)), medianByDimension, correctRuns: Object.values(correctRunsByCase).reduce((sum, count) => sum + count, 0), correctRunsByCase };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
