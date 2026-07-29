import {
  type SerializedAggregate,
  type SerializedCredit,
  type UsageReport,
} from "./report";

function formatNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toString();
}

function formatCredits(value: number): string {
  return value >= 1_000
    ? `${(value / 1_000).toFixed(2)}K`
    : value.toFixed(2);
}

function percent(part: number, whole: number): string {
  return whole ? `${(part / whole * 100).toFixed(1)}%` : "0.0%";
}

function totalProxy(object: Record<string, SerializedAggregate>): number {
  return Object.values(object).reduce(
    (total, value) => total + value.comparisonProxy,
    0,
  );
}

function rankedRows(
  object: Record<string, SerializedAggregate>,
): Array<[string, SerializedAggregate]> {
  return Object.entries(object).sort(
    (left, right) => right[1].comparisonProxy - left[1].comparisonProxy,
  );
}

function tableLines(
  title: string,
  headers: string[],
  rows: string[][],
): string[] {
  if (!rows.length) return [];
  const widths = headers.map((header, column) =>
    Math.max(
      header.length,
      ...rows.map((row) => row[column]?.length ?? 0),
    )
  );
  return [
    "",
    title,
    headers.map((value, index) => value.padEnd(widths[index]!)).join("  "),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) =>
      row.map((value, index) => value.padEnd(widths[index]!)).join("  ")
    ),
  ];
}

function usageRow(
  name: string,
  value: SerializedAggregate,
  total: number,
): string[] {
  return [
    name,
    String(value.sessions),
    String(value.inferences),
    formatNumber(value.totalTokens),
    formatNumber(value.uncachedInputTokens),
    `${value.cachePercent.toFixed(1)}%`,
    formatNumber(value.outputTokens),
    formatNumber(value.comparisonProxy),
    percent(value.comparisonProxy, total),
  ];
}

function creditRow(
  name: string,
  credit: SerializedCredit,
  total: number,
): string[] {
  return [
    name,
    formatCredits(credit.pricedCredits),
    String(credit.fullyPricedInferences),
    String(credit.partiallyPricedInferences),
    String(credit.unpricedInferences),
    String(credit.cacheWrite.observedInferences),
    percent(credit.pricedCredits, total),
  ];
}

export function renderHuman(report: UsageReport): string {
  const lines = [
    `Codex usage: ${new Date(report.range.from).toLocaleString()} -> ${new Date(report.range.to).toLocaleString()}`,
    `Rollouts ${report.range.rolloutFiles} | cache proxy weight ${report.range.cachedWeight}`,
  ];

  if (report.rateLimit) {
    const reset = report.rateLimit.resetsAt
      ? new Date(report.rateLimit.resetsAt).toLocaleString()
      : "unknown";
    const change = report.rateLimit.changePoints >= 0
      ? `+${report.rateLimit.changePoints}`
      : String(report.rateLimit.changePoints);
    lines.push(
      `Weekly meter ${report.rateLimit.firstUsedPercent}% -> ${report.rateLimit.lastUsedPercent}% (${change} points) | resets ${reset}`,
    );
  }

  lines.push(...tableLines(
    "Actors",
    ["actor", "sessions", "calls", "total", "uncached", "cache", "output", "proxy", "share"],
    rankedRows(report.actors).map(([name, value]) =>
      usageRow(name, value, totalProxy(report.actors))
    ),
  ));

  const actorPricedTotal = Object.values(report.actors).reduce(
    (total, value) => total + value.creditEquivalent.pricedCredits,
    0,
  );
  lines.push(...tableLines(
    "Credits by actor (GPT-5.6 priced classes)",
    ["actor", "priced", "full", "partial", "unpriced", "cache write", "share"],
    Object.entries(report.actors)
      .sort(
        (left, right) =>
          right[1].creditEquivalent.pricedCredits
          - left[1].creditEquivalent.pricedCredits,
      )
      .map(([name, value]) =>
        creditRow(name, value.creditEquivalent, actorPricedTotal)
      ),
  ));

  lines.push(...tableLines(
    "Models",
    ["model", "sessions", "calls", "total", "uncached", "cache", "output", "proxy", "share"],
    rankedRows(report.models).map(([name, value]) =>
      usageRow(name, value, totalProxy(report.models))
    ),
  ));

  if (Object.keys(report.subagentRoutes).length) {
    lines.push(...tableLines(
      "Subagent routes",
      ["model/effort", "agents", "calls", "total", "uncached", "cache", "output", "proxy", "share"],
      rankedRows(report.subagentRoutes).map(([name, value]) =>
        usageRow(name, value, totalProxy(report.subagentRoutes))
      ),
    ));
  }
  if (Object.keys(report.subagentRoles).length) {
    lines.push(...tableLines(
      "Subagent roles",
      ["role", "agents", "calls", "total", "uncached", "cache", "output", "proxy", "share"],
      rankedRows(report.subagentRoles).map(([name, value]) =>
        usageRow(name, value, totalProxy(report.subagentRoles))
      ),
    ));
  }
  if (Object.keys(report.subagentTiers).length) {
    lines.push(...tableLines(
      "Legacy subagent tiers",
      ["tier", "agents", "calls", "total", "uncached", "cache", "output", "proxy", "share"],
      rankedRows(report.subagentTiers).map(([name, value]) =>
        usageRow(name, value, totalProxy(report.subagentTiers))
      ),
    ));
  }

  const guardian = report.guardian;
  const averageReviewDuration = guardian.averageDurationMs
    ? `${(guardian.averageDurationMs / 1000).toFixed(1)}s`
    : "n/a";
  const guardianSummary = [
    `  reviews ${guardian.reviews} (${guardian.allow} allow, ${guardian.deny} deny, ${guardian.unknown} unknown)`,
    ` | avg ${averageReviewDuration}`,
    ` | cache ${guardian.cachePercent.toFixed(1)}%`,
    ` | proxy ${formatNumber(guardian.comparisonProxy)}`,
  ].join("");
  lines.push(
    "",
    "Guardian",
    guardianSummary,
  );

  lines.push(...tableLines(
    "Top root tasks (priced credits are known-class; coverage below)",
    ["task", "proxy", "priced root", "priced agents", "priced total", "full", "partial", "unpriced", "agent%", "id"],
    report.topRootTasks.map((task) => {
      const pricedRoot = task.actors.root?.creditEquivalent.pricedCredits ?? 0;
      const pricedAgents = task.actors.subagent?.creditEquivalent.pricedCredits ?? 0;
      const pricedTotal = task.creditEquivalent.pricedCredits;
      const credit = task.creditEquivalent;
      const label = task.title.length <= 42
        ? task.title
        : `${task.title.slice(0, 41)}…`;
      return [
        label,
        formatNumber(task.comparisonProxy),
        formatCredits(pricedRoot),
        formatCredits(pricedAgents),
        formatCredits(pricedTotal),
        String(credit.fullyPricedInferences),
        String(credit.partiallyPricedInferences),
        String(credit.unpricedInferences),
        percent(pricedAgents, pricedTotal),
        task.id.slice(0, 8),
      ];
    }),
  ));

  lines.push(...tableLines(
    "Timeline",
    [report.range.bucket, "sessions", "calls", "total", "uncached", "cache", "output", "proxy", "meter"],
    Object.entries(report.timeline).map(([key, value]) => [
      key,
      String(value.sessions),
      String(value.inferences),
      formatNumber(value.totalTokens),
      formatNumber(value.uncachedInputTokens),
      `${value.cachePercent.toFixed(1)}%`,
      formatNumber(value.outputTokens),
      formatNumber(value.comparisonProxy),
      value.rateLimit
        ? `${value.rateLimit.firstUsedPercent}%→${value.rateLimit.lastUsedPercent}%`
        : "n/a",
    ]),
  ));

  lines.push(
    "",
    "Proxy = uncached input + cached input * weight + output. It is comparative, not billing or quota.",
    "Credits = GPT-5.6 model rate-card equivalent; cache-write coverage is shown as full/partial and unknown models are unpriced.",
  );
  return lines.join("\n");
}
