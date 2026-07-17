#!/usr/bin/env bun

/**
 * Read-only local usage analysis for Codex rollout files.
 *
 * This intentionally reads only CODEX_HOME sessions, archived_sessions, and
 * the newest optional state_*.sqlite title index. It does not write to them.
 */
import { Database } from "bun:sqlite";
import { basename, join } from "node:path";

type Usage = { input: number; cached: number; output: number; reasoning: number; total: number; proxy: number };
type Actor = "root" | "subagent" | "guardian" | "other";
type Aggregate = { usage: Usage; inferences: number; sessions: Set<string> };
type RateSnapshot = { timestamp: number; usedPercent: number; resetsAt?: number };
type SessionSummary = {
  id: string; actor: Actor; parentId?: string; agentPath?: string; usage: Usage;
  inferences: number; models: Map<string, Aggregate>; routes: Map<string, Aggregate>; reviewCount: number;
  reviewAllow: number; reviewDeny: number; reviewDurationMs: number;
};
type Options = { from: number; to: number; bucket: "hour" | "day"; cachedWeight: number; top: number; json: boolean };

const subagentRoles = new Set(["triage", "worker", "designer", "qa", "review", "deployment"]);
const emptyUsage = (): Usage => ({ input: 0, cached: 0, output: 0, reasoning: 0, total: 0, proxy: 0 });
const emptyAggregate = (): Aggregate => ({ usage: emptyUsage(), inferences: 0, sessions: new Set() });
const asNumber = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

function addUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.cached += source.cached;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.total += source.total;
  target.proxy += source.proxy;
}

function usageFrom(raw: any, cachedWeight: number): Usage {
  const input = asNumber(raw?.input_tokens);
  const cached = Math.min(input, asNumber(raw?.cached_input_tokens));
  const output = asNumber(raw?.output_tokens);
  return {
    input, cached, output,
    reasoning: asNumber(raw?.reasoning_output_tokens),
    total: asNumber(raw?.total_tokens) || input + output,
    proxy: input - cached + cached * cachedWeight + output,
  };
}

function usageDelta(current: any, previous: any, cachedWeight: number): Usage {
  return usageFrom({
    input_tokens: Math.max(0, asNumber(current?.input_tokens) - asNumber(previous?.input_tokens)),
    cached_input_tokens: Math.max(0, asNumber(current?.cached_input_tokens) - asNumber(previous?.cached_input_tokens)),
    output_tokens: Math.max(0, asNumber(current?.output_tokens) - asNumber(previous?.output_tokens)),
    reasoning_output_tokens: Math.max(0, asNumber(current?.reasoning_output_tokens) - asNumber(previous?.reasoning_output_tokens)),
    total_tokens: Math.max(0, asNumber(current?.total_tokens) - asNumber(previous?.total_tokens)),
  }, cachedWeight);
}

function parseDate(value: string, endOfDay = false): number {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return new Date(Number(year), Number(month) - 1, Number(day), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime();
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (local) {
    const [, year, month, day, hour, minute, second = "0"] = local;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid date/time: ${value}`);
  return timestamp;
}

function printHelp(): void {
  console.log(`Usage: bun scripts/analyze.ts --from <date/time> [options]

Analyze Codex rollout usage across active and archived sessions. By default,
the analyzer uses $CODEX_HOME when set, otherwise $HOME/.codex.

Options:
  --from <value>          Inclusive range start (required)
  --to <value>            Inclusive range end (default: now)
  --bucket hour|day       Timeline granularity (default: day)
  --cached-weight <0..1>  Cache-adjusted comparison weight (default: 0.1)
  --top <count>           Maximum rows in ranked tables (default: 10)
  --json                  Emit machine-readable JSON
  -h, --help              Show this help

Local forms like "2026-07-13 07:00" use the machine timezone. A date-only
--to value includes that entire local day. The comparison proxy is not quota
or billing: uncached input + cached input * weight + output.`);
}

function parseArgs(argv: string[]): Options {
  let from: number | undefined;
  let to = Date.now();
  let bucket: Options["bucket"] = "day";
  let cachedWeight = 0.1;
  let top = 10;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--from") from = parseDate(next());
    else if (arg === "--to") to = parseDate(next(), true);
    else if (arg === "--bucket") {
      const value = next();
      if (value !== "hour" && value !== "day") throw new Error("--bucket must be hour or day");
      bucket = value;
    } else if (arg === "--cached-weight") cachedWeight = Number(next());
    else if (arg === "--top") top = Number(next());
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (from === undefined) throw new Error("--from is required");
  if (!Number.isFinite(cachedWeight) || cachedWeight < 0 || cachedWeight > 1) throw new Error("--cached-weight must be between 0 and 1");
  if (!Number.isInteger(top) || top < 1) throw new Error("--top must be a positive integer");
  if (from > to) throw new Error("--from must not be after --to");
  return { from, to, bucket, cachedWeight, top, json };
}

async function listRollouts(codexHome: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const root of [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]) {
    try {
      for await (const relative of new Bun.Glob("**/*.jsonl").scan({ cwd: root, onlyFiles: true })) candidates.push(join(root, relative));
    } catch {
      // A fresh Codex home may not have both directories yet.
    }
  }
  const byId = new Map<string, { path: string; size: number }>();
  for (const path of candidates) {
    const id = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1] ?? path;
    const size = Bun.file(path).size;
    const existing = byId.get(id);
    if (!existing || size > existing.size) byId.set(id, { path, size });
  }
  return [...byId.values()].map(({ path }) => path).sort();
}

async function* lines(path: string): AsyncGenerator<string> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) { yield pending.slice(0, newline); pending = pending.slice(newline + 1); }
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

function classify(source: any): Actor {
  if (source?.subagent?.other === "guardian") return "guardian";
  if (source?.subagent) return "subagent";
  if (source === "vscode" || source === "cli" || source === "exec") return "root";
  return "other";
}

function aggregateInto(map: Map<string, Aggregate>, key: string, id: string, usage: Usage): void {
  const aggregate = map.get(key) ?? emptyAggregate();
  addUsage(aggregate.usage, usage);
  aggregate.inferences += 1;
  aggregate.sessions.add(id);
  map.set(key, aggregate);
}

function bucketKey(timestamp: number, bucket: Options["bucket"]): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return bucket === "hour" ? `${day} ${pad(date.getHours())}:00` : day;
}

async function findForkBoundary(path: string): Promise<{ forked: boolean; turnId?: string }> {
  let forked = false;
  let turnId: string | undefined;
  for await (const line of lines(path)) {
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    const payload = event.payload;
    if (event.type === "session_meta") {
      forked = classify(payload?.source) === "subagent" && typeof payload?.forked_from_id === "string";
      if (!forked) return { forked: false };
    }
    if (forked && event.type === "event_msg" && payload?.type === "task_started" && typeof payload?.turn_id === "string") {
      turnId = payload.turn_id;
    }
  }
  return { forked, ...(turnId ? { turnId } : {}) };
}

async function parseRollout(path: string, options: Options): Promise<{ session: SessionSummary; rates: RateSnapshot[]; timeline: Map<string, Aggregate> }> {
  const forkBoundary = await findForkBoundary(path);
  const fallbackId = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1] ?? basename(path);
  const session: SessionSummary = { id: fallbackId, actor: "other", usage: emptyUsage(), inferences: 0, models: new Map(), routes: new Map(), reviewCount: 0, reviewAllow: 0, reviewDeny: 0, reviewDurationMs: 0 };
  const rates: RateSnapshot[] = [];
  const timeline = new Map<string, Aggregate>();
  let currentModel = "unknown";
  let currentEffort = "unknown";
  let previousTotal: any;
  let previousSignature: string | undefined;
  let reachedOwnTurn = !forkBoundary.forked;
  for await (const line of lines(path)) {
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    const timestamp = Date.parse(event.timestamp);
    const payload = event.payload;
    if (event.type === "session_meta") {
      session.id = payload?.id ?? payload?.session_id ?? session.id;
      session.actor = classify(payload?.source);
      session.parentId = payload?.parent_thread_id ?? payload?.source?.subagent?.thread_spawn?.parent_thread_id;
      session.agentPath = payload?.agent_path ?? payload?.source?.subagent?.thread_spawn?.agent_path;
      continue;
    }
    if (event.type === "turn_context") {
      if (forkBoundary.forked && forkBoundary.turnId !== undefined && payload?.turn_id === forkBoundary.turnId) reachedOwnTurn = true;
      if (!reachedOwnTurn) continue;
      currentModel = payload?.model ?? currentModel;
      currentEffort = payload?.effort ?? payload?.reasoning_effort ?? currentEffort;
      continue;
    }
    if (!Number.isFinite(timestamp) || timestamp < options.from || timestamp > options.to) {
      if (event.type === "event_msg" && payload?.type === "token_count") {
        previousTotal = payload?.info?.total_token_usage ?? previousTotal;
        previousSignature = previousTotal ? JSON.stringify(previousTotal) : previousSignature;
      }
      continue;
    }
    if (event.type === "event_msg" && payload?.type === "token_count") {
      const total = payload?.info?.total_token_usage;
      const signature = total ? JSON.stringify(total) : undefined;
      if (!reachedOwnTurn) {
        previousTotal = total ?? previousTotal;
        previousSignature = signature ?? previousSignature;
        continue;
      }
      if (signature && signature === previousSignature) continue;
      const rawLast = payload?.info?.last_token_usage;
      const usage = rawLast ? usageFrom(rawLast, options.cachedWeight) : usageDelta(total, previousTotal, options.cachedWeight);
      previousTotal = total ?? previousTotal;
      previousSignature = signature ?? previousSignature;
      if (usage.total <= 0 && usage.input <= 0 && usage.output <= 0) continue;
      addUsage(session.usage, usage);
      session.inferences += 1;
      aggregateInto(session.models, currentModel, session.id, usage);
      aggregateInto(session.routes, `${currentModel}/${currentEffort}`, session.id, usage);
      aggregateInto(timeline, bucketKey(timestamp, options.bucket), session.id, usage);
      const primary = payload?.rate_limits?.primary;
      if (typeof primary?.used_percent === "number") rates.push({ timestamp, usedPercent: primary.used_percent, ...(typeof primary.resets_at === "number" ? { resetsAt: primary.resets_at * 1000 } : {}) });
    }
    if (session.actor === "guardian" && event.type === "event_msg" && payload?.type === "task_complete") {
      session.reviewCount += 1;
      session.reviewDurationMs += asNumber(payload?.duration_ms);
      try {
        const assessment = JSON.parse(payload?.last_agent_message ?? "{}");
        if (assessment.outcome === "allow") session.reviewAllow += 1;
        if (assessment.outcome === "deny") session.reviewDeny += 1;
      } catch { /* Preserve old non-JSON review counts. */ }
    }
  }
  return { session, rates, timeline };
}

function loadTitles(codexHome: string): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    const databases = [...new Bun.Glob("state_*.sqlite").scanSync({ cwd: codexHome, onlyFiles: true })].sort((left, right) => Number(/state_(\d+)\.sqlite$/.exec(right)?.[1] ?? 0) - Number(/state_(\d+)\.sqlite$/.exec(left)?.[1] ?? 0));
    const newest = databases[0];
    if (!newest) return titles;
    const db = new Database(join(codexHome, newest), { readonly: true });
    try {
      for (const row of db.query("SELECT id, title FROM threads").all() as Array<{ id: string; title: string }>) titles.set(row.id, row.title);
    } finally { db.close(); }
  } catch {
    // Rollout analysis works without Desktop's optional title index.
  }
  return titles;
}

function rootId(session: SessionSummary, sessions: Map<string, SessionSummary>): string {
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

function serializableUsage(usage: Usage) {
  return { inputTokens: usage.input, cachedInputTokens: usage.cached, uncachedInputTokens: usage.input - usage.cached, cachePercent: usage.input ? usage.cached / usage.input * 100 : 0, outputTokens: usage.output, reasoningTokens: usage.reasoning, totalTokens: usage.total, comparisonProxy: usage.proxy };
}
function serializableAggregate(aggregate: Aggregate) { return { sessions: aggregate.sessions.size, inferences: aggregate.inferences, ...serializableUsage(aggregate.usage) }; }

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
  const paths = await listRollouts(codexHome);
  const sessions = new Map<string, SessionSummary>();
  const rates: RateSnapshot[] = [];
  const timeline = new Map<string, Aggregate>();
  for (let index = 0; index < paths.length; index += 8) {
    const parsed = await Promise.all(paths.slice(index, index + 8).map((path) => parseRollout(path, options)));
    for (const item of parsed) {
      sessions.set(item.session.id, item.session);
      rates.push(...item.rates);
      for (const [key, aggregate] of item.timeline) {
        const target = timeline.get(key) ?? emptyAggregate();
        addUsage(target.usage, aggregate.usage);
        target.inferences += aggregate.inferences;
        for (const id of aggregate.sessions) target.sessions.add(id);
        timeline.set(key, target);
      }
    }
  }
  const actors = new Map<string, Aggregate>();
  const models = new Map<string, Aggregate>();
  const routes = new Map<string, Aggregate>();
  const roles = new Map<string, Aggregate>();
  const tiers = new Map<string, Aggregate>();
  const rootTasks = new Map<string, Map<Actor, Aggregate>>();
  let reviews = 0; let reviewAllow = 0; let reviewDeny = 0; let reviewDurationMs = 0;
  for (const session of sessions.values()) {
    if (!session.inferences && !session.reviewCount) continue;
    const actor = actors.get(session.actor) ?? emptyAggregate();
    addUsage(actor.usage, session.usage); actor.inferences += session.inferences; actor.sessions.add(session.id); actors.set(session.actor, actor);
    for (const [model, aggregate] of session.models) {
      const target = models.get(model) ?? emptyAggregate();
      addUsage(target.usage, aggregate.usage); target.inferences += aggregate.inferences; target.sessions.add(session.id); models.set(model, target);
    }
    if (session.actor === "subagent") {
      for (const [route, aggregate] of session.routes) {
        const target = routes.get(route) ?? emptyAggregate();
        addUsage(target.usage, aggregate.usage); target.inferences += aggregate.inferences; target.sessions.add(session.id); routes.set(route, target);
      }
      const name = session.agentPath?.split("/").filter(Boolean).at(-1) ?? "unknown";
      const parts = name.split("__");
      const role = subagentRoles.has(parts[0]!) ? parts[0]! : subagentRoles.has(parts[1]!) ? parts[1]! : "unclassified";
      const roleTarget = roles.get(role) ?? emptyAggregate();
      addUsage(roleTarget.usage, session.usage); roleTarget.inferences += session.inferences; roleTarget.sessions.add(session.id); roles.set(role, roleTarget);
      if (parts.length >= 3 && subagentRoles.has(parts[1]!)) {
        const tier = parts[0]!;
        const tierTarget = tiers.get(tier) ?? emptyAggregate();
        addUsage(tierTarget.usage, session.usage); tierTarget.inferences += session.inferences; tierTarget.sessions.add(session.id); tiers.set(tier, tierTarget);
      }
    }
    const root = rootId(session, sessions);
    const byActor = rootTasks.get(root) ?? new Map<Actor, Aggregate>();
    const rootActor = byActor.get(session.actor) ?? emptyAggregate();
    addUsage(rootActor.usage, session.usage); rootActor.inferences += session.inferences; rootActor.sessions.add(session.id); byActor.set(session.actor, rootActor); rootTasks.set(root, byActor);
    reviews += session.reviewCount; reviewAllow += session.reviewAllow; reviewDeny += session.reviewDeny; reviewDurationMs += session.reviewDurationMs;
  }
  rates.sort((a, b) => a.timestamp - b.timestamp);
  const ratesByBucket = new Map<string, RateSnapshot[]>();
  for (const rate of rates) { const key = bucketKey(rate.timestamp, options.bucket); const bucketRates = ratesByBucket.get(key) ?? []; bucketRates.push(rate); ratesByBucket.set(key, bucketRates); }
  const titles = loadTitles(codexHome);
  const rankedRoots = [...rootTasks.entries()].map(([id, byActor]) => {
    const total = emptyUsage(); for (const aggregate of byActor.values()) addUsage(total, aggregate.usage);
    return { id, title: titles.get(id) ?? id, total, byActor };
  }).sort((left, right) => right.total.proxy - left.total.proxy);
  const report = {
    range: { from: new Date(options.from).toISOString(), to: new Date(options.to).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, bucket: options.bucket, cachedWeight: options.cachedWeight, rolloutFiles: paths.length },
    rateLimit: rates.length ? { firstUsedPercent: rates[0]!.usedPercent, lastUsedPercent: rates.at(-1)!.usedPercent, changePoints: rates.at(-1)!.usedPercent - rates[0]!.usedPercent, resetsAt: rates.at(-1)!.resetsAt ? new Date(rates.at(-1)!.resetsAt!).toISOString() : null } : null,
    actors: Object.fromEntries([...actors].map(([key, value]) => [key, serializableAggregate(value)])),
    models: Object.fromEntries([...models].map(([key, value]) => [key, serializableAggregate(value)])),
    subagentRoutes: Object.fromEntries([...routes].map(([key, value]) => [key, serializableAggregate(value)])),
    subagentRoles: Object.fromEntries([...roles].map(([key, value]) => [key, serializableAggregate(value)])),
    subagentTiers: Object.fromEntries([...tiers].map(([key, value]) => [key, serializableAggregate(value)])),
    guardian: { reviews, allow: reviewAllow, deny: reviewDeny, unknown: reviews - reviewAllow - reviewDeny, durationMs: reviewDurationMs, averageDurationMs: reviews ? reviewDurationMs / reviews : 0, ...serializableUsage(actors.get("guardian")?.usage ?? emptyUsage()) },
    topRootTasks: rankedRoots.slice(0, options.top).map(({ id, title, total, byActor }) => ({ id, title, ...serializableUsage(total), actors: Object.fromEntries([...byActor].map(([key, value]) => [key, serializableAggregate(value)])) })),
    timeline: Object.fromEntries([...timeline].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => {
      const bucketRates = ratesByBucket.get(key) ?? []; const first = bucketRates[0]; const last = bucketRates.at(-1);
      return [key, { ...serializableAggregate(value), rateLimit: first && last ? { firstUsedPercent: first.usedPercent, lastUsedPercent: last.usedPercent, changePoints: last.usedPercent - first.usedPercent } : null }];
    })),
  };
  if (options.json) console.log(JSON.stringify(report, null, 2)); else printHuman(report);
}

function formatNumber(value: number): string { return value >= 1_000_000_000 ? `${(value / 1_000_000_000).toFixed(2)}B` : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : Math.round(value).toString(); }
function totalProxy(object: Record<string, any>): number { return Object.values(object).reduce((total: number, value: any) => total + value.comparisonProxy, 0); }
function percent(part: number, whole: number): string { return whole ? `${(part / whole * 100).toFixed(1)}%` : "0.0%"; }
function rankedRows(object: Record<string, any>): Array<[string, any]> { return Object.entries(object).sort((left, right) => right[1].comparisonProxy - left[1].comparisonProxy); }
function printTable(title: string, headers: string[], rows: string[][]): void {
  if (!rows.length) return;
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)));
  console.log(`\n${title}`); console.log(headers.map((value, index) => value.padEnd(widths[index]!)).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(row.map((value, index) => value.padEnd(widths[index]!)).join("  "));
}
function usageRow(name: string, value: any, total: number): string[] { return [name, String(value.sessions), String(value.inferences), formatNumber(value.totalTokens), formatNumber(value.uncachedInputTokens), `${value.cachePercent.toFixed(1)}%`, formatNumber(value.outputTokens), formatNumber(value.comparisonProxy), percent(value.comparisonProxy, total)]; }
function printHuman(report: any): void {
  console.log(`Codex usage: ${new Date(report.range.from).toLocaleString()} -> ${new Date(report.range.to).toLocaleString()}`);
  console.log(`Rollouts ${report.range.rolloutFiles} | cache proxy weight ${report.range.cachedWeight}`);
  if (report.rateLimit) {
    const reset = report.rateLimit.resetsAt ? new Date(report.rateLimit.resetsAt).toLocaleString() : "unknown";
    const change = report.rateLimit.changePoints >= 0 ? `+${report.rateLimit.changePoints}` : String(report.rateLimit.changePoints);
    console.log(`Weekly meter ${report.rateLimit.firstUsedPercent}% -> ${report.rateLimit.lastUsedPercent}% (${change} points) | resets ${reset}`);
  }
  printTable("Actors", ["actor", "sessions", "calls", "total", "uncached", "cache", "output", "proxy", "share"], rankedRows(report.actors).map(([name, value]) => usageRow(name, value, totalProxy(report.actors))));
  printTable("Models", ["model", "sessions", "calls", "total", "uncached", "cache", "output", "proxy", "share"], rankedRows(report.models).map(([name, value]) => usageRow(name, value, totalProxy(report.models))));
  if (Object.keys(report.subagentRoutes).length) printTable("Subagent routes", ["model/effort", "agents", "calls", "total", "uncached", "cache", "output", "proxy", "share"], rankedRows(report.subagentRoutes).map(([name, value]) => usageRow(name, value, totalProxy(report.subagentRoutes))));
  if (Object.keys(report.subagentRoles).length) printTable("Subagent roles", ["role", "agents", "calls", "total", "uncached", "cache", "output", "proxy", "share"], rankedRows(report.subagentRoles).map(([name, value]) => usageRow(name, value, totalProxy(report.subagentRoles))));
  if (Object.keys(report.subagentTiers).length) printTable("Legacy subagent tiers", ["tier", "agents", "calls", "total", "uncached", "cache", "output", "proxy", "share"], rankedRows(report.subagentTiers).map(([name, value]) => usageRow(name, value, totalProxy(report.subagentTiers))));
  const guardian = report.guardian;
  console.log(`\nGuardian\n  reviews ${guardian.reviews} (${guardian.allow} allow, ${guardian.deny} deny, ${guardian.unknown} unknown) | avg ${guardian.averageDurationMs ? `${(guardian.averageDurationMs / 1000).toFixed(1)}s` : "n/a"} | cache ${guardian.cachePercent.toFixed(1)}% | proxy ${formatNumber(guardian.comparisonProxy)}`);
  printTable("Top root tasks", ["task", "proxy", "root", "agents", "guardian", "agent%", "id"], report.topRootTasks.map((task: any) => {
    const root = task.actors.root?.comparisonProxy ?? 0;
    const subagent = task.actors.subagent?.comparisonProxy ?? 0;
    const guardianProxy = task.actors.guardian?.comparisonProxy ?? 0;
    const label = task.title.length <= 42 ? task.title : `${task.title.slice(0, 41)}…`;
    return [label, formatNumber(task.comparisonProxy), formatNumber(root), formatNumber(subagent), formatNumber(guardianProxy), percent(subagent, task.comparisonProxy), task.id.slice(0, 8)];
  }));
  printTable("Timeline", [report.range.bucket, "sessions", "calls", "total", "uncached", "cache", "output", "proxy", "meter"], Object.entries(report.timeline).map(([key, value]: any) => [key, String(value.sessions), String(value.inferences), formatNumber(value.totalTokens), formatNumber(value.uncachedInputTokens), `${value.cachePercent.toFixed(1)}%`, formatNumber(value.outputTokens), formatNumber(value.comparisonProxy), value.rateLimit ? `${value.rateLimit.firstUsedPercent}%→${value.rateLimit.lastUsedPercent}%` : "n/a"]));
  console.log("\nProxy = uncached input + cached input * weight + output. It is comparative, not billing or quota.");
}

main().catch((error) => { console.error(`analyze.ts: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
