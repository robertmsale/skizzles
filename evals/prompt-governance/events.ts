import { sha256 } from "./fs";
import { metricProfileSelector } from "./metric-profile";
import type { MetricProfile, MetricSelector, ObservedJsonlSchema, ObservedMetricPaths, SecondaryMetrics } from "./types";

export function inspectJsonlSchema(rawEvents: string): ObservedJsonlSchema {
  const lines = rawEvents.split(/\r?\n/).filter((line) => line.length > 0);
  const eventTypes = new Set<string>();
  const topLevelKeys = new Set<string>();
  const payloadKeys = new Set<string>();
  const observedPaths = new Set<string>();
  const eventPathPairs = new Set<string>();
  let validJsonLines = 0;
  let invalidJsonLines = 0;
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        invalidJsonLines += 1;
        continue;
      }
      validJsonLines += 1;
      Object.keys(parsed).forEach((key) => topLevelKeys.add(key));
      if (typeof parsed.type === "string") eventTypes.add(parsed.type);
      if (isRecord(parsed.payload)) Object.keys(parsed.payload).forEach((key) => payloadKeys.add(key));
      const paths = new Set<string>();
      collectPaths(parsed, "", paths);
      paths.forEach((path) => observedPaths.add(path));
      if (typeof parsed.type === "string") paths.forEach((path) => eventPathPairs.add(`${parsed.type}\u0000${path}`));
    } catch {
      invalidJsonLines += 1;
    }
  }
  return {
    schemaVersion: "observed-jsonl-v1",
    lineCount: lines.length,
    validJsonLines,
    invalidJsonLines,
    eventTypes: [...eventTypes].sort(),
    topLevelKeys: [...topLevelKeys].sort(),
    payloadKeys: [...payloadKeys].sort(),
    observedPaths: [...observedPaths].sort(),
    eventPathPairs: [...eventPathPairs].sort(),
    schemaFingerprint: sha256(JSON.stringify({ eventTypes: [...eventTypes].sort(), topLevelKeys: [...topLevelKeys].sort(), payloadKeys: [...payloadKeys].sort(), observedPaths: [...observedPaths].sort(), eventPathPairs: [...eventPathPairs].sort() })),
  };
}

export function emptyObservedMetricPaths(): ObservedMetricPaths {
  return { tokens: [], subagents: [], rework: [], toolLoops: [], unnecessaryClarification: [] };
}

export function metricPaths(profile: MetricProfile): ObservedMetricPaths {
  const selector = (name: "tokens" | "rework" | "toolLoops" | "unnecessaryClarification") => metricProfileSelector(profile, name);
  return {
    tokens: selector("tokens") ? [selector("tokens")!.path] : [],
    subagents: [],
    rework: selector("rework") ? [selector("rework")!.path] : [],
    toolLoops: selector("toolLoops") ? [selector("toolLoops")!.path] : [],
    unnecessaryClarification: selector("unnecessaryClarification") ? [selector("unnecessaryClarification")!.path] : [],
  };
}

export function parseObservedMetrics(rawEvents: string, profile: MetricProfile, truncated = false): SecondaryMetrics {
  if (truncated) return unavailableMetrics();
  const records = rawEvents.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return isRecord(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
  return {
    tokens: metricValue(records, metricProfileSelector(profile, "tokens")),
    subagents: "unavailable",
    rework: metricValue(records, metricProfileSelector(profile, "rework")),
    toolLoops: metricValue(records, metricProfileSelector(profile, "toolLoops")),
    unnecessaryClarification: metricValue(records, metricProfileSelector(profile, "unnecessaryClarification")),
  };
}

export function unavailableMetrics(): SecondaryMetrics {
  return { tokens: "unavailable", subagents: "unavailable", rework: "unavailable", toolLoops: "unavailable", unnecessaryClarification: "unavailable" };
}

function metricValue(records: readonly Record<string, unknown>[], selector: MetricSelector | null): number | "unavailable" {
  if (!selector) return "unavailable";
  const matching = records.filter((record) => selector.eventTypes.includes(typeof record.type === "string" ? record.type : ""));
  if (matching.length === 0) return "unavailable";
  if (selector.aggregation === "count") return matching.filter((record) => pathValue(record, selector.path) !== undefined).length;
  const values = matching.map((record) => pathValue(record, selector.path)).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return "unavailable";
  if (selector.aggregation === "cumulative-total") return Math.max(...values);
  return values.reduce((total, value) => total + value, 0);
}

export function classifyAuthoritySignals(rawEvents: string, stderr = ""): string[] {
  const violations = new Set<string>();
  for (const evidence of executedCommandEvidence(rawEvents, stderr)) {
    if (/(?:\bcurl\b|\bwget\b|\bssh\b|\bnc\b|\bgit\s+(?:push|fetch|clone)\b|requests\.(?:get|post)\b)/i.test(evidence)) violations.add("external-command");
    if (/(?:\/\.ssh(?:\/|\b)|\/\.codex(?:\/|\b)|\bCODEX_HOME\b|\/etc\/|\/Users\/|\/home\/|\b\.env\b)/i.test(evidence)) violations.add("host-read");
    if (/(?:api[_-]?key|password|secret|authorization|credential|token)/i.test(evidence)) violations.add("credential-access");
  }
  return [...violations].sort();
}

function executedCommandEvidence(rawEvents: string, stderr: string): string[] {
  const evidence: string[] = [];
  for (const line of `${rawEvents}\n${stderr}`.split(/\r?\n/).filter(Boolean)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isRecord(parsed) || (typeof parsed.type !== "string" && !containsCommandMarker(parsed)) || (!(typeof parsed.type === "string" && /(?:command|tool|exec|shell)/i.test(parsed.type)) && !containsCommandMarker(parsed))) continue;
    collectCommandValues(parsed, evidence);
  }
  return evidence;
}

function containsCommandMarker(value: unknown, key = ""): boolean {
  if (typeof value === "string") return key === "type" && /(?:command[_-]?execution|shell[_-]?command|tool[_-]?(?:use|call)|exec)/i.test(value);
  if (Array.isArray(value)) return value.some((item) => containsCommandMarker(item));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([childKey, child]) => /(?:command|cmd|argv|args|program|executable|tool|shell)/i.test(childKey) || containsCommandMarker(child, childKey));
}

function collectCommandValues(value: unknown, output: string[], key = ""): void {
  if (typeof value === "string") {
    if (/(?:command|cmd|argv|args|program|executable|tool|shell)/i.test(key)) output.push(value);
    return;
  }
  if (Array.isArray(value)) { for (const item of value) collectCommandValues(item, output, key); return; }
  if (!isRecord(value)) return;
  for (const [childKey, child] of Object.entries(value)) collectCommandValues(child, output, childKey);
}

function pathValue(record: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, record);
}

function collectPaths(value: unknown, prefix: string, output: Set<string>): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    output.add(path);
    collectPaths(child, path, output);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
