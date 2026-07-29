import { basename } from "node:path";
import {
  addCredit,
  addUsage,
  aggregateInference,
  asNumber,
  creditFor,
  emptyCredit,
  emptyUsage,
  usageDelta,
  usageFrom,
  type Aggregate,
  type CreditEquivalent,
  type Usage,
} from "./aggregation";
import { type Options } from "./options";

export type Actor = "root" | "subagent" | "guardian" | "other";

export type RateSnapshot = {
  timestamp: number;
  usedPercent: number;
  resetsAt?: number;
};

export type SessionSummary = {
  id: string;
  actor: Actor;
  parentId?: string | undefined;
  agentPath?: string | undefined;
  usage: Usage;
  inferences: number;
  models: Map<string, Aggregate>;
  routes: Map<string, Aggregate>;
  credit: CreditEquivalent;
  reviewCount: number;
  reviewAllow: number;
  reviewDeny: number;
  reviewDurationMs: number;
};

export type ParsedRollout = {
  session: SessionSummary;
  rates: RateSnapshot[];
  timeline: Map<string, Aggregate>;
};

export type LineReader = (path: string) => AsyncIterable<string>;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object"
    ? value as JsonObject
    : undefined;
}

function parseEvent(line: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function classify(source: unknown): Actor {
  const sourceObject = asObject(source);
  const subagent = sourceObject?.subagent;
  if (asObject(subagent)?.other === "guardian") return "guardian";
  if (subagent) return "subagent";
  if (source === "vscode" || source === "cli" || source === "exec") return "root";
  return "other";
}

export function bucketKey(timestamp: number, bucket: Options["bucket"]): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return bucket === "hour" ? `${day} ${pad(date.getHours())}:00` : day;
}

async function findForkBoundary(
  path: string,
  read: LineReader,
): Promise<{ forked: boolean; turnId?: string }> {
  let forked = false;
  let turnId: string | undefined;
  let sawSessionMeta = false;
  for await (const line of read(path)) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    if (!event) continue;
    const payload = asObject(event.payload);
    if (event.type === "session_meta") {
      if (sawSessionMeta) continue;
      sawSessionMeta = true;
      forked = classify(payload?.source) === "subagent"
        && typeof payload?.forked_from_id === "string";
      if (!forked) return { forked: false };
    }
    if (
      forked
      && event.type === "event_msg"
      && payload?.type === "task_started"
      && typeof payload.turn_id === "string"
    ) {
      turnId = payload.turn_id;
    }
  }
  return { forked, ...(turnId ? { turnId } : {}) };
}

function createSession(path: string): SessionSummary {
  const fallbackId = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1]
    ?? basename(path);
  return {
    id: fallbackId,
    actor: "other",
    usage: emptyUsage(),
    inferences: 0,
    models: new Map(),
    routes: new Map(),
    credit: emptyCredit(),
    reviewCount: 0,
    reviewAllow: 0,
    reviewDeny: 0,
    reviewDurationMs: 0,
  };
}

function applySessionMeta(session: SessionSummary, payload: JsonObject | undefined): void {
  const source = asObject(payload?.source);
  const subagent = asObject(source?.subagent);
  const threadSpawn = asObject(subagent?.thread_spawn);
  session.id = (payload?.id ?? payload?.session_id ?? session.id) as string;
  session.actor = classify(payload?.source);
  session.parentId = (
    payload?.parent_thread_id
    ?? threadSpawn?.parent_thread_id
  ) as string | undefined;
  session.agentPath = (
    payload?.agent_path
    ?? threadSpawn?.agent_path
  ) as string | undefined;
}

function recordGuardianReview(session: SessionSummary, payload: JsonObject): void {
  session.reviewCount += 1;
  session.reviewDurationMs += asNumber(payload.duration_ms);
  try {
    const assessment = asObject(JSON.parse((payload.last_agent_message ?? "{}") as string));
    if (assessment?.outcome === "allow") session.reviewAllow += 1;
    if (assessment?.outcome === "deny") session.reviewDeny += 1;
  } catch {
    // Preserve old non-JSON review counts.
  }
}

export async function parseRollout(
  path: string,
  options: Options,
  read: LineReader,
): Promise<ParsedRollout> {
  const forkBoundary = await findForkBoundary(path, read);
  const session = createSession(path);
  const rates: RateSnapshot[] = [];
  const timeline = new Map<string, Aggregate>();
  let currentModel = "unknown";
  let currentEffort = "unknown";
  let previousTotal: unknown;
  let previousSignature: string | undefined;
  let reachedOwnTurn = !forkBoundary.forked;
  let sawSessionMeta = false;

  for await (const line of read(path)) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    if (!event) continue;
    const payload = asObject(event.payload);
    const timestamp = Date.parse(event.timestamp as string);

    if (event.type === "session_meta") {
      if (sawSessionMeta) continue;
      sawSessionMeta = true;
      applySessionMeta(session, payload);
      continue;
    }

    if (event.type === "turn_context") {
      if (
        forkBoundary.forked
        && forkBoundary.turnId !== undefined
        && payload?.turn_id === forkBoundary.turnId
      ) {
        reachedOwnTurn = true;
      }
      if (!reachedOwnTurn) continue;
      currentModel = (payload?.model ?? currentModel) as string;
      currentEffort = (payload?.effort ?? payload?.reasoning_effort ?? currentEffort) as string;
      continue;
    }

    const info = asObject(payload?.info);
    if (!Number.isFinite(timestamp) || timestamp < options.from || timestamp > options.to) {
      if (event.type === "event_msg" && payload?.type === "token_count") {
        previousTotal = info?.total_token_usage ?? previousTotal;
        previousSignature = previousTotal
          ? JSON.stringify(previousTotal)
          : previousSignature;
      }
      continue;
    }

    if (event.type === "event_msg" && payload?.type === "token_count") {
      const total = info?.total_token_usage;
      const signature = total ? JSON.stringify(total) : undefined;
      if (!reachedOwnTurn) {
        previousTotal = total ?? previousTotal;
        previousSignature = signature ?? previousSignature;
        continue;
      }
      if (signature && signature === previousSignature) continue;
      const rawLast = info?.last_token_usage;
      const usage = rawLast
        ? usageFrom(rawLast, options.cachedWeight)
        : usageDelta(total, previousTotal, options.cachedWeight);
      previousTotal = total ?? previousTotal;
      previousSignature = signature ?? previousSignature;
      if (usage.total <= 0 && usage.input <= 0 && usage.output <= 0) continue;

      const credit = creditFor(currentModel, usage);
      addUsage(session.usage, usage);
      addCredit(session.credit, credit);
      session.inferences += 1;
      aggregateInference(session.models, currentModel, session.id, usage, credit);
      aggregateInference(
        session.routes,
        `${currentModel}/${currentEffort}`,
        session.id,
        usage,
        credit,
      );
      aggregateInference(
        timeline,
        bucketKey(timestamp, options.bucket),
        session.id,
        usage,
        credit,
      );

      const rateLimits = asObject(payload.rate_limits);
      const primary = asObject(rateLimits?.primary);
      if (typeof primary?.used_percent === "number") {
        rates.push({
          timestamp,
          usedPercent: primary.used_percent,
          ...(typeof primary.resets_at === "number"
            ? { resetsAt: primary.resets_at * 1000 }
            : {}),
        });
      }
    }

    if (
      session.actor === "guardian"
      && event.type === "event_msg"
      && payload?.type === "task_complete"
    ) {
      recordGuardianReview(session, payload);
    }
  }

  return { session, rates, timeline };
}
