import { sha256 } from "./fs";
import type { MetricName, MetricProfile, MetricSelector, MetricSelectorId } from "./types";

export const SELECTOR_REGISTRY_ID = "codex-root-instruction-v2";
export const SELECTOR_REGISTRY_SCHEMA = "prompt-governance-selector-registry-v2" as const;

const REGISTRY: Readonly<Record<MetricSelectorId, MetricSelector>> = {
  "turn-completed-token-usage": { eventTypes: ["turn.completed"], paths: ["usage.input_tokens", "usage.output_tokens"], aggregation: "sum-components" },
};
const SELECTOR_METRICS: Readonly<Record<MetricSelectorId, Exclude<MetricName, "subagents">>> = { "turn-completed-token-usage": "tokens" };

export function resolveMetricSelector(id: MetricSelectorId | null): MetricSelector | null {
  return id === null ? null : REGISTRY[id] ?? null;
}

export function metricSelectorCommitments(id: MetricSelectorId | null): string[] {
  const selector = resolveMetricSelector(id);
  if (!selector || selector.eventTypes.length === 0 || selector.paths.length === 0) return [];
  if (selector.eventTypes.some((eventType) => !/^[a-z][a-z0-9_.:-]*$/.test(eventType)) || selector.paths.some((path) => !/^[a-z][a-z0-9_.-]*(?:\.[a-z][a-z0-9_.-]*)*$/.test(path))) return [];
  return selector.eventTypes.flatMap((eventType) => selector.paths.map((path) => sha256(`${eventType}\u0000${path}`))).sort();
}

export function selectorMetric(id: MetricSelectorId | null): Exclude<MetricName, "subagents"> | null {
  return id === null ? null : SELECTOR_METRICS[id] ?? null;
}

export function metricSelectionCommitment(enabled: readonly Exclude<MetricName, "subagents">[], selectorIds: Readonly<Partial<Record<Exclude<MetricName, "subagents">, MetricSelectorId>>>): string {
  const entries = enabled.map((name) => `${name}\u0000${selectorIds[name] ?? ""}\u0000${metricSelectorCommitments(selectorIds[name] ?? null).join(",")}`).sort();
  return sha256(entries.join("\n"));
}

export function metricProfileSelector(profile: MetricProfile, name: MetricName): MetricSelector | null {
  if (name === "subagents") return null;
  return resolveMetricSelector(profile.selectorIds[name] ?? null);
}

export function isKnownSelector(id: MetricSelectorId | null): boolean {
  return id === null || Object.prototype.hasOwnProperty.call(REGISTRY, id);
}
