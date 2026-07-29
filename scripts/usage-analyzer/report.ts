import {
  CREDIT_RATES,
  CREDIT_SCHEMA_VERSION,
  addCredit,
  addUsage,
  emptyAggregate,
  emptyCredit,
  emptyUsage,
  mergeAggregate,
  type Aggregate,
  type CreditEquivalent,
  type Usage,
} from "./aggregation";
import { type Options } from "./options";
import {
  type Actor,
  type ParsedRollout,
  type RateSnapshot,
  type SessionSummary,
  bucketKey,
} from "./rollout";

export type SerializedUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWriteObserved: boolean;
  uncachedInputTokens: number;
  ordinaryInputTokens: number;
  cachePercent: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  comparisonProxy: number;
};

export type SerializedCredit = {
  pricedCredits: number;
  fullyPricedInferences: number;
  partiallyPricedInferences: number;
  unpricedInferences: number;
  cacheWrite: CreditEquivalent["cacheWrite"];
  unpricedUsage: SerializedUsage & {
    inferences: number;
    models: Record<string, SerializedUsage & { inferences: number }>;
  };
};

export type SerializedAggregate = SerializedUsage & {
  sessions: number;
  inferences: number;
  creditEquivalent: SerializedCredit;
};

type MeterRange = {
  firstUsedPercent: number;
  lastUsedPercent: number;
  changePoints: number;
};

export type UsageReport = {
  range: {
    from: string;
    to: string;
    timezone: string;
    bucket: Options["bucket"];
    cachedWeight: number;
    rolloutFiles: number;
  };
  pricing: {
    schemaVersion: string;
    unit: string;
    rates: typeof CREDIT_RATES;
    disclaimer: string;
  };
  rateLimit: (MeterRange & { resetsAt: string | null }) | null;
  actors: Record<string, SerializedAggregate>;
  models: Record<string, SerializedAggregate>;
  subagentRoutes: Record<string, SerializedAggregate>;
  subagentRoles: Record<string, SerializedAggregate>;
  subagentTiers: Record<string, SerializedAggregate>;
  guardian: SerializedUsage & {
    reviews: number;
    allow: number;
    deny: number;
    unknown: number;
    durationMs: number;
    averageDurationMs: number;
    creditEquivalent: SerializedCredit;
  };
  topRootTasks: Array<SerializedUsage & {
    id: string;
    title: string;
    creditEquivalent: SerializedCredit;
    actors: Record<string, SerializedAggregate>;
  }>;
  timeline: Record<string, SerializedAggregate & { rateLimit: MeterRange | null }>;
};

const subagentRoles = new Set([
  "triage",
  "worker",
  "designer",
  "qa",
  "review",
  "deployment",
]);

function serializableUsage(usage: Usage): SerializedUsage {
  return {
    inputTokens: usage.input,
    cachedInputTokens: usage.cached,
    cacheWriteInputTokens: usage.cacheWrite,
    cacheWriteObserved: usage.cacheWriteObserved,
    uncachedInputTokens: usage.input - usage.cached,
    ordinaryInputTokens: Math.max(0, usage.input - usage.cached - usage.cacheWrite),
    cachePercent: usage.input ? usage.cached / usage.input * 100 : 0,
    outputTokens: usage.output,
    reasoningTokens: usage.reasoning,
    totalTokens: usage.total,
    comparisonProxy: usage.proxy,
  };
}

function serializableRawUsage(
  usage: Usage,
  inferences: number,
): SerializedUsage & { inferences: number } {
  return { inferences, ...serializableUsage(usage) };
}

function serializableCredit(credit: CreditEquivalent): SerializedCredit {
  return {
    pricedCredits: Number(credit.pricedCredits.toFixed(9)),
    fullyPricedInferences: credit.fullyPricedInferences,
    partiallyPricedInferences: credit.partiallyPricedInferences,
    unpricedInferences: credit.unpricedInferences,
    cacheWrite: { ...credit.cacheWrite },
    unpricedUsage: {
      ...serializableRawUsage(
        credit.unpricedUsage.usage,
        credit.unpricedUsage.inferences,
      ),
      models: Object.fromEntries(
        [...credit.unpricedUsage.models].map(([model, aggregate]) => [
          model,
          serializableRawUsage(aggregate.usage, aggregate.inferences),
        ]),
      ),
    },
  };
}

function serializableAggregate(aggregate: Aggregate): SerializedAggregate {
  return {
    sessions: aggregate.sessions.size,
    inferences: aggregate.inferences,
    ...serializableUsage(aggregate.usage),
    creditEquivalent: serializableCredit(aggregate.credit),
  };
}

function aggregateRecord(
  aggregates: Map<string, Aggregate>,
): Record<string, SerializedAggregate> {
  return Object.fromEntries(
    [...aggregates].map(([key, value]) => [key, serializableAggregate(value)]),
  );
}

function addSession(target: Aggregate, session: SessionSummary): void {
  addUsage(target.usage, session.usage);
  addCredit(target.credit, session.credit);
  target.inferences += session.inferences;
  target.sessions.add(session.id);
}

function rootId(
  session: SessionSummary,
  sessions: Map<string, SessionSummary>,
): string {
  let current = session;
  const visited = new Set([current.id]);
  while (current.parentId) {
    if (visited.has(current.parentId)) break;
    visited.add(current.parentId);
    const parent = sessions.get(current.parentId);
    if (!parent) return current.parentId;
    current = parent;
  }
  return current.id;
}

function groupRatesByBucket(
  rates: RateSnapshot[],
  bucket: Options["bucket"],
): Map<string, RateSnapshot[]> {
  const grouped = new Map<string, RateSnapshot[]>();
  for (const rate of rates) {
    const key = bucketKey(rate.timestamp, bucket);
    const bucketRates = grouped.get(key) ?? [];
    bucketRates.push(rate);
    grouped.set(key, bucketRates);
  }
  return grouped;
}

export function buildReport(
  options: Options,
  rolloutFiles: number,
  parsedRollouts: ParsedRollout[],
  titles: Map<string, string>,
): UsageReport {
  const sessions = new Map<string, SessionSummary>();
  const rates: RateSnapshot[] = [];
  const timeline = new Map<string, Aggregate>();
  for (const item of parsedRollouts) {
    sessions.set(item.session.id, item.session);
    rates.push(...item.rates);
    for (const [key, aggregate] of item.timeline) {
      const target = timeline.get(key) ?? emptyAggregate();
      mergeAggregate(target, aggregate);
      timeline.set(key, target);
    }
  }

  const actors = new Map<string, Aggregate>();
  const models = new Map<string, Aggregate>();
  const routes = new Map<string, Aggregate>();
  const roles = new Map<string, Aggregate>();
  const tiers = new Map<string, Aggregate>();
  const rootTasks = new Map<string, Map<Actor, Aggregate>>();
  let reviews = 0;
  let reviewAllow = 0;
  let reviewDeny = 0;
  let reviewDurationMs = 0;

  for (const session of sessions.values()) {
    if (!session.inferences && !session.reviewCount) continue;
    const actor = actors.get(session.actor) ?? emptyAggregate();
    addSession(actor, session);
    actors.set(session.actor, actor);

    for (const [model, aggregate] of session.models) {
      const target = models.get(model) ?? emptyAggregate();
      mergeAggregate(target, aggregate);
      models.set(model, target);
    }

    if (session.actor === "subagent") {
      for (const [route, aggregate] of session.routes) {
        const target = routes.get(route) ?? emptyAggregate();
        mergeAggregate(target, aggregate);
        routes.set(route, target);
      }
      const name = session.agentPath?.split("/").filter(Boolean).at(-1) ?? "unknown";
      const parts = name.split("__");
      const role = subagentRoles.has(parts[0]!)
        ? parts[0]!
        : subagentRoles.has(parts[1]!)
          ? parts[1]!
          : "unclassified";
      const roleTarget = roles.get(role) ?? emptyAggregate();
      addSession(roleTarget, session);
      roles.set(role, roleTarget);
      if (parts.length >= 3 && subagentRoles.has(parts[1]!)) {
        const tier = parts[0]!;
        const tierTarget = tiers.get(tier) ?? emptyAggregate();
        addSession(tierTarget, session);
        tiers.set(tier, tierTarget);
      }
    }

    const root = rootId(session, sessions);
    const byActor = rootTasks.get(root) ?? new Map<Actor, Aggregate>();
    const rootActor = byActor.get(session.actor) ?? emptyAggregate();
    addSession(rootActor, session);
    byActor.set(session.actor, rootActor);
    rootTasks.set(root, byActor);
    reviews += session.reviewCount;
    reviewAllow += session.reviewAllow;
    reviewDeny += session.reviewDeny;
    reviewDurationMs += session.reviewDurationMs;
  }

  rates.sort((left, right) => left.timestamp - right.timestamp);
  const ratesByBucket = groupRatesByBucket(rates, options.bucket);
  const rankedRoots = [...rootTasks.entries()]
    .map(([id, byActor]) => {
      const total = emptyAggregate();
      for (const aggregate of byActor.values()) mergeAggregate(total, aggregate);
      return { id, title: titles.get(id) ?? id, total, byActor };
    })
    .sort((left, right) => right.total.usage.proxy - left.total.usage.proxy);

  const firstRate = rates[0];
  const lastRate = rates.at(-1);
  return {
    range: {
      from: new Date(options.from).toISOString(),
      to: new Date(options.to).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      bucket: options.bucket,
      cachedWeight: options.cachedWeight,
      rolloutFiles,
    },
    pricing: {
      schemaVersion: CREDIT_SCHEMA_VERSION,
      unit: "creditsPerMillionTokens",
      rates: CREDIT_RATES,
      disclaimer: "Credit equivalent only; not account quota or invoice. Unknown/unrated models are unpriced.",
    },
    rateLimit: firstRate && lastRate
      ? {
          firstUsedPercent: firstRate.usedPercent,
          lastUsedPercent: lastRate.usedPercent,
          changePoints: lastRate.usedPercent - firstRate.usedPercent,
          resetsAt: lastRate.resetsAt
            ? new Date(lastRate.resetsAt).toISOString()
            : null,
        }
      : null,
    actors: aggregateRecord(actors),
    models: aggregateRecord(models),
    subagentRoutes: aggregateRecord(routes),
    subagentRoles: aggregateRecord(roles),
    subagentTiers: aggregateRecord(tiers),
    guardian: {
      reviews,
      allow: reviewAllow,
      deny: reviewDeny,
      unknown: reviews - reviewAllow - reviewDeny,
      durationMs: reviewDurationMs,
      averageDurationMs: reviews ? reviewDurationMs / reviews : 0,
      ...serializableUsage(actors.get("guardian")?.usage ?? emptyUsage()),
      creditEquivalent: serializableCredit(
        actors.get("guardian")?.credit ?? emptyCredit(),
      ),
    },
    topRootTasks: rankedRoots.slice(0, options.top).map(
      ({ id, title, total, byActor }) => ({
        id,
        title,
        ...serializableUsage(total.usage),
        creditEquivalent: serializableCredit(total.credit),
        actors: aggregateRecord(byActor),
      }),
    ),
    timeline: Object.fromEntries(
      [...timeline]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => {
          const bucketRates = ratesByBucket.get(key) ?? [];
          const first = bucketRates[0];
          const last = bucketRates.at(-1);
          return [
            key,
            {
              ...serializableAggregate(value),
              rateLimit: first && last
                ? {
                    firstUsedPercent: first.usedPercent,
                    lastUsedPercent: last.usedPercent,
                    changePoints: last.usedPercent - first.usedPercent,
                  }
                : null,
            },
          ];
        }),
    ),
  };
}
