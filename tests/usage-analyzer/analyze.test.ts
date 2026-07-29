import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { type UsageReport } from "../../scripts/usage-analyzer/report";

const analyzer = join(import.meta.dir, "../../scripts/analyze.ts");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "skizzles-usage-analyzer-"));
  fixtures.push(home);
  return home;
}

function run(home: string, args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, analyzer, ...args],
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, CODEX_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(result: ReturnType<typeof Bun.spawnSync>) {
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const content = await readFile(full);
        files[relative(root, full)] = createHash("sha256").update(content).digest("hex");
      }
    }
  }
  await visit(root);
  return files;
}

const rootId = "11111111-1111-1111-1111-111111111111";
const childId = "22222222-2222-2222-2222-222222222222";
const guardianId = "33333333-3333-3333-3333-333333333333";
const timestamp = "2026-07-02T12:00:00.000Z";

async function writeJsonl(path: string, events: unknown[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

test("prints portable help without touching a Codex home", async () => {
  const home = await fixtureHome();
  const result = output(run(home, ["--help"]));

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: bun scripts/analyze.ts");
  expect(result.stdout).not.toContain("~/.codex/scripts/analyze.ts");
  expect(await snapshot(home)).toEqual({});
});

test("returns an empty report when sessions and state files are absent", async () => {
  const home = await fixtureHome();
  const before = await snapshot(home);
  const result = output(run(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]));

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    range: { rolloutFiles: 0, bucket: "day" },
    actors: {}, models: {}, subagentRoutes: {}, subagentRoles: {}, subagentTiers: {}, topRootTasks: [], timeline: {},
  });
  expect(await snapshot(home)).toEqual(before);
});

test("aggregates synthetic active and archived rollouts, reads titles, and leaves inputs unchanged", async () => {
  const home = await fixtureHome();
  const sessions = join(home, "sessions", "2026", "07", "02");
  const archived = join(home, "archived_sessions", "2026", "07", "02");
  await writeJsonl(join(sessions, `${rootId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: rootId, source: "cli" } },
    { timestamp, type: "turn_context", payload: { model: "gpt-fixture", effort: "medium" } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } }, rate_limits: { primary: { used_percent: 12.5, resets_at: 1_783_050_000 } } } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } } },
  ]);
  await writeJsonl(join(archived, `${rootId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: rootId, source: "cli" } },
  ]);
  await writeJsonl(join(archived, `${childId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: childId, forked_from_id: rootId, source: { subagent: { thread_spawn: { parent_thread_id: rootId, agent_path: "/root/worker__fixture" } } } } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 999, cached_input_tokens: 0, output_tokens: 999, total_tokens: 1998 }, total_token_usage: { input_tokens: 999, cached_input_tokens: 0, output_tokens: 999, total_tokens: 1998 } } } },
    { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "inherited-turn" } },
    { timestamp, type: "turn_context", payload: { turn_id: "inherited-turn", model: "gpt-parent", effort: "high" } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 999, cached_input_tokens: 0, output_tokens: 999, total_tokens: 1998 }, total_token_usage: { input_tokens: 1998, cached_input_tokens: 0, output_tokens: 1998, total_tokens: 3996 } } } },
    { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
    { timestamp, type: "turn_context", payload: { turn_id: "child-turn", model: "gpt-fixture", effort: "medium" } },
    { timestamp, type: "session_meta", payload: { id: rootId, source: "cli" } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 2048, cached_input_tokens: 5, output_tokens: 2008, total_tokens: 4056 } } } },
  ]);
  await writeJsonl(join(archived, `${guardianId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: guardianId, source: { subagent: { other: "guardian", thread_spawn: { parent_thread_id: rootId } } } } },
    { timestamp, type: "event_msg", payload: { type: "task_complete", duration_ms: 500, last_agent_message: '{"outcome":"allow"}' } },
  ]);
  const db = new Database(join(home, "state_42.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT); INSERT INTO threads VALUES ('11111111-1111-1111-1111-111111111111', 'Synthetic root');");
  db.close();
  const before = await snapshot(home);

  const result = output(run(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--bucket", "hour", "--cached-weight", "0.5", "--top", "1", "--json"]));

  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout) as UsageReport;
  expect(report.range).toMatchObject({ rolloutFiles: 3, bucket: "hour", cachedWeight: 0.5 });
  expect(report.actors.root).toMatchObject({ sessions: 1, inferences: 1, inputTokens: 100, cachedInputTokens: 40, comparisonProxy: 100 });
  expect(report.actors.subagent).toMatchObject({ sessions: 1, inferences: 1, inputTokens: 50, cachedInputTokens: 5, comparisonProxy: 57.5 });
  expect(report.models["gpt-fixture"]).toMatchObject({ sessions: 2, inferences: 2, inputTokens: 150 });
  expect(report.subagentRoutes["gpt-fixture/medium"]).toMatchObject({ sessions: 1, inferences: 1 });
  expect(report.subagentRoles.worker).toMatchObject({ sessions: 1, inferences: 1 });
  expect(report.subagentTiers).toEqual({});
  expect(report.guardian).toMatchObject({ reviews: 1, allow: 1, deny: 0, durationMs: 500 });
  expect(report.rateLimit).toMatchObject({ firstUsedPercent: 12.5, lastUsedPercent: 12.5 });
  expect(report.topRootTasks).toHaveLength(1);
  expect(report.topRootTasks[0]).toMatchObject({ id: rootId, title: "Synthetic root", comparisonProxy: 157.5 });
  expect(report.topRootTasks[0]!.actors.root).toMatchObject({ sessions: 1, inferences: 1 });
  expect(report.topRootTasks[0]!.actors.subagent).toMatchObject({ sessions: 1, inferences: 1 });
  expect(Object.values(report.timeline)).toHaveLength(1);
  const aggregate = (
    values: Array<{
      inferences: number;
      inputTokens: number;
      creditEquivalent: { pricedCredits: number };
    }>,
  ) => values.reduce(
    (total, value) => ({
      inferences: total.inferences + value.inferences,
      inputTokens: total.inputTokens + value.inputTokens,
      pricedCredits: total.pricedCredits + value.creditEquivalent.pricedCredits,
    }),
    { inferences: 0, inputTokens: 0, pricedCredits: 0 },
  );
  const actorAggregate = aggregate(Object.values(report.actors));
  const modelAggregate = aggregate(Object.values(report.models));
  const timelineAggregate = aggregate(Object.values(report.timeline));
  expect(actorAggregate).toEqual({ inferences: 2, inputTokens: 150, pricedCredits: 0 });
  expect(modelAggregate).toEqual(actorAggregate);
  expect(timelineAggregate).toEqual(actorAggregate);
  expect(await snapshot(home)).toEqual(before);
});

test("preserves role and legacy tier attribution for historical task names", async () => {
  const home = await fixtureHome();
  const archived = join(home, "archived_sessions", "2026", "07", "02");
  await writeJsonl(join(archived, `${childId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: childId, source: { subagent: { thread_spawn: { parent_thread_id: rootId, agent_path: "/root/scoped__worker__fixture" } } } } },
    { timestamp, type: "turn_context", payload: { model: "gpt-fixture", effort: "high" } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 } } } },
  ]);

  const result = output(run(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]));

  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout) as UsageReport;
  expect(report.subagentRoutes["gpt-fixture/high"]).toMatchObject({ sessions: 1, inferences: 1 });
  expect(report.subagentRoles.worker).toMatchObject({ sessions: 1, inferences: 1 });
  expect(report.subagentTiers.scoped).toMatchObject({ sessions: 1, inferences: 1 });
});

test("prices GPT-5.6 roots and subagents with inclusive cache-write coverage", async () => {
  const home = await fixtureHome();
  const archived = join(home, "archived_sessions", "2026", "07", "02");
  const rootSolId = "44444444-4444-4444-4444-444444444444";
  const childId = "55555555-5555-5555-5555-555555555555";
  const unknownId = "66666666-6666-6666-6666-666666666666";
  const reviewId = "77777777-7777-7777-7777-777777777777";
  const token = (usage: Record<string, number>, total: Record<string, number> = usage) => ({ timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: total } } });

  await writeJsonl(join(archived, `${rootSolId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: rootSolId, source: "cli" } },
    { timestamp, type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "medium" } },
    token({ input_tokens: 1_000_000, cached_input_tokens: 200_000, cache_write_input_tokens: 100_000, output_tokens: 1_000_000, total_tokens: 2_000_000 }),
  ]);
  await writeJsonl(join(archived, `${childId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: childId, source: { subagent: { thread_spawn: { parent_thread_id: rootSolId, agent_path: "/root/worker__pricing" } } } } },
    { timestamp, type: "turn_context", payload: { model: "gpt-5.6-terra", effort: "medium" } },
    token({ input_tokens: 1_000_000, cached_input_tokens: 100_000, output_tokens: 500_000, total_tokens: 1_500_000 }),
    { timestamp, type: "turn_context", payload: { model: "gpt-5.6-luna", effort: "medium" } },
    token({ input_tokens: 2_000_000, cached_input_tokens: 100_000, cache_write_input_tokens: 100_000, output_tokens: 1_000_000, total_tokens: 3_000_000 }, { input_tokens: 3_000_000, cached_input_tokens: 200_000, cache_write_input_tokens: 100_000, output_tokens: 1_500_000, total_tokens: 4_500_000 }),
  ]);
  await writeJsonl(join(archived, `${unknownId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: unknownId, source: "cli" } },
    { timestamp, type: "turn_context", payload: { model: "gpt-fixture", effort: "medium" } },
    token({ input_tokens: 10_000, cached_input_tokens: 1_000, output_tokens: 2_000, total_tokens: 12_000 }),
  ]);
  await writeJsonl(join(archived, `${reviewId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: reviewId, source: "cli" } },
    { timestamp, type: "turn_context", payload: { model: "codex-auto-review", effort: "medium" } },
    token({ input_tokens: 20_000, cached_input_tokens: 5_000, output_tokens: 3_000, total_tokens: 23_000 }),
  ]);

  const result = output(run(home, ["--from", "2026-07-01", "--to", "2026-07-02", "--json"]));
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout) as UsageReport;
  expect(report.pricing).toMatchObject({ schemaVersion: "gpt-5.6-credit-equivalent-v1", unit: "creditsPerMillionTokens" });
  expect(report.pricing.rates["gpt-5.6-sol"]).toEqual({ uncachedInput: 125, cachedInput: 12.5, cacheWriteInput: 156.25, output: 750 });
  expect(report.actors.root!.creditEquivalent).toMatchObject({ pricedCredits: 855.625, fullyPricedInferences: 1, partiallyPricedInferences: 0, unpricedInferences: 2 });
  expect(report.actors.root!.cacheWriteInputTokens).toBe(100_000);
  expect(report.models["gpt-5.6-sol"]).toMatchObject({ uncachedInputTokens: 800_000, ordinaryInputTokens: 700_000 });
  expect(report.models["gpt-5.6-sol"]!.creditEquivalent).toMatchObject({ pricedCredits: 855.625, fullyPricedInferences: 1 });
  expect(report.models["gpt-5.6-terra"]!.creditEquivalent).toMatchObject({ pricedCredits: 244.375, fullyPricedInferences: 0, partiallyPricedInferences: 1 });
  expect(report.models["gpt-5.6-luna"]!.creditEquivalent).toMatchObject({ pricedCredits: 198.375, fullyPricedInferences: 1 });
  expect(report.models["gpt-fixture"]!.creditEquivalent).toMatchObject({ pricedCredits: 0, unpricedInferences: 1 });
  expect(report.models["codex-auto-review"]!.creditEquivalent.unpricedUsage.models["codex-auto-review"]).toMatchObject({ inferences: 1, inputTokens: 20_000 });
  expect(report.subagentRoutes["gpt-5.6-terra/medium"]!.creditEquivalent.partiallyPricedInferences).toBe(1);
  expect(report.subagentRoutes["gpt-5.6-luna/medium"]!.creditEquivalent.cacheWrite).toMatchObject({ observedInferences: 1, tokens: 100_000 });
  expect(report.topRootTasks[0]!.creditEquivalent.pricedCredits).toBe(1298.375);
});
