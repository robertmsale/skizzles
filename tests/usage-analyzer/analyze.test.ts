import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "bun:test";

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
    actors: {}, models: {}, subagentTiers: {}, topRootTasks: [], timeline: {},
  });
  expect(await snapshot(home)).toEqual(before);
});

test("aggregates synthetic active and archived rollouts, reads titles, and leaves inputs unchanged", async () => {
  const home = await fixtureHome();
  const sessions = join(home, "sessions", "2026", "07", "02");
  const archived = join(home, "archived_sessions", "2026", "07", "02");
  await writeJsonl(join(sessions, `${rootId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: rootId, source: "cli" } },
    { timestamp, type: "turn_context", payload: { model: "gpt-fixture" } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } }, rate_limits: { primary: { used_percent: 12.5, resets_at: 1_783_050_000 } } } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } } },
  ]);
  await writeJsonl(join(archived, `${rootId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: rootId, source: "cli" } },
  ]);
  await writeJsonl(join(archived, `${childId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: childId, source: { subagent: { thread_spawn: { parent_thread_id: rootId, agent_path: "/root/scoped__worker__fixture" } } } } },
    { timestamp, type: "turn_context", payload: { model: "gpt-fixture" } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 5, output_tokens: 10, total_tokens: 60 } } } },
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
  const report = JSON.parse(result.stdout);
  expect(report.range).toMatchObject({ rolloutFiles: 3, bucket: "hour", cachedWeight: 0.5 });
  expect(report.actors.root).toMatchObject({ sessions: 1, inferences: 1, inputTokens: 100, cachedInputTokens: 40, comparisonProxy: 100 });
  expect(report.actors.subagent).toMatchObject({ sessions: 1, inferences: 1, inputTokens: 50, cachedInputTokens: 5, comparisonProxy: 57.5 });
  expect(report.models["gpt-fixture"]).toMatchObject({ sessions: 2, inferences: 2, inputTokens: 150 });
  expect(report.subagentTiers.scoped).toMatchObject({ sessions: 1, inferences: 1 });
  expect(report.guardian).toMatchObject({ reviews: 1, allow: 1, deny: 0, durationMs: 500 });
  expect(report.rateLimit).toMatchObject({ firstUsedPercent: 12.5, lastUsedPercent: 12.5 });
  expect(report.topRootTasks).toHaveLength(1);
  expect(report.topRootTasks[0]).toMatchObject({ id: rootId, title: "Synthetic root", comparisonProxy: 157.5 });
  expect(Object.values(report.timeline)).toHaveLength(1);
  expect(await snapshot(home)).toEqual(before);
});
