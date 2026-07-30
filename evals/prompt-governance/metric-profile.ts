import { sha256 } from "./fs";
import type { MetricName, MetricProfile, MetricSelector, MetricSelectorId } from "./types";

export const SELECTOR_REGISTRY_ID = "codex-root-instruction-v1";
export const SELECTOR_REGISTRY_SCHEMA = "prompt-governance-selector-registry-v1" as const;

const REGISTRY: Readonly<Record<MetricSelectorId, MetricSelector>> = {
  "fixture-done-payload-ok": { eventTypes: ["fixture.done"], path: "payload.ok", aggregation: "count" },
  "thread-started-token-count": { eventTypes: ["thread.started"], path: "payload.tokenCount", aggregation: "cumulative-total" },
};

export function resolveMetricSelector(id: MetricSelectorId | null): MetricSelector | null {
  return id === null ? null : REGISTRY[id] ?? null;
}

export function metricSelectorCommitment(id: MetricSelectorId | null): string | null {
  const selector = resolveMetricSelector(id);
  return selector && selector.eventTypes.length === 1 ? sha256(`${selector.eventTypes[0]}\u0000${selector.path}`) : null;
}

export function metricSelectionCommitment(enabled: readonly Exclude<MetricName, "subagents">[], selectorIds: Readonly<Partial<Record<Exclude<MetricName, "subagents">, MetricSelectorId>>>): string {
  const entries = enabled.map((name) => `${name}\u0000${selectorIds[name] ?? ""}\u0000${metricSelectorCommitment(selectorIds[name] ?? null) ?? ""}`).sort();
  return sha256(entries.join("\n"));
}

export function metricProfileSelector(profile: MetricProfile, name: MetricName): MetricSelector | null {
  if (name === "subagents") return null;
  return resolveMetricSelector(profile.selectorIds[name] ?? null);
}

export function isKnownSelector(id: MetricSelectorId | null): boolean {
  return id === null || Object.prototype.hasOwnProperty.call(REGISTRY, id);
}
