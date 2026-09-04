#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm, realpath, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export type Job = {
  id: string; sessionId: string; cwd: string; binary: string; model: string; effort: string;
  maxTurns: number; timeoutMs: number; turn: number; cursor: string;
  state: "starting" | "running" | "completed" | "blocked" | "failed" | "cancelled" | "orphaned";
  startedAt: number; childPid?: number; supervisorPid?: number; exitCode?: number | null; summary?: string; stopReason?: string;
  usage?: unknown; costUsd?: number; error?: string;
};
const root = resolve(process.env.GROK_WORKER_STATE_DIR ?? join(homedir(), ".local/state/skizzles/grok-worker"));
const limit = 12000;
const reportSchema = JSON.stringify({
  type: "object", properties: {
    outcome: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string", description: "Concise final report: outcome, changed paths, validation commands/results, and remaining blockers or risks. No progress narration." },
  }, required: ["outcome", "summary"], additionalProperties: false,
});
const active = (j: Job) => j.state === "starting" || j.state === "running";
const file = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid job ID");
  return join(root, id);
};
async function save(j: Job) {
  const path = join(file(j.id), "job.json");
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(j), { mode: 0o600 });
  await rename(tmp, path);
}
async function read(id: string): Promise<Job> {
  const j: Job = JSON.parse(await readFile(join(file(id), "job.json"), "utf8"));
  if (active(j)) {
    let missing = !j.supervisorPid && Date.now() - j.startedAt > 15000;
    if (j.supervisorPid) {
      try { process.kill(j.supervisorPid, 0); }
      catch (e) { missing = (e as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    if (missing) {
      j.state = "orphaned"; j.cursor = `${j.turn}:orphaned`;
      j.error = "Supervisor unavailable. Worker may still be running; inspect local job/process state before manual recovery. Followup is blocked.";
    }
  }
  return j;
}
function compact(j: Job) {
  return { id: j.id, cursor: j.cursor, state: j.state, turn: j.turn, cwd: j.cwd,
    model: j.model, effort: j.effort, sessionId: j.sessionId,
    ...(j.error ? { error: j.error } : {}) };
}
export function grokArgs(j: Job, prompt: string, rules: string): string[] {
  return ["--cwd", j.cwd, "--model", j.model, "--reasoning-effort", j.effort,
    "--permission-mode", "bypassPermissions", "--no-subagents", "--no-plan",
    "--max-turns", String(j.maxTurns), "--output-format", "json", "--json-schema", reportSchema, "--rules", rules,
    ...(j.turn === 1 ? ["--session-id", j.sessionId] : ["--resume", j.sessionId]),
    "--prompt-file", prompt];
}
export function resultFields(raw: string, exitCode: number | null): Partial<Job> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { state: "failed", error: "Grok returned invalid JSON; inspect the local output artifact." }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "failed", error: "Grok returned an invalid result object; inspect the local output artifact." };
  }
  const result = parsed as Record<string, unknown>;
  if (exitCode !== 0 || result.type === "error") {
    return { state: "failed", error: String(result.message ?? `Grok exited ${exitCode}`).slice(0, 2000) };
  }
  // Grok's text concatenates narration across tool calls. Only structuredOutput is the final report.
  const report = result.structuredOutput as { outcome?: unknown; summary?: unknown } | undefined;
  if (!report || typeof report.summary !== "string" || !["completed", "blocked"].includes(String(report.outcome))) {
    return { state: "failed", error: "Grok returned no valid structured final report; inspect the local output artifact." };
  }
  return { state: result.stopReason === "end_turn" ? report.outcome as "completed" | "blocked" : "failed",
    summary: report.summary.slice(0, limit), stopReason: String(result.stopReason ?? "unknown"),
    ...(result.usage && typeof result.usage === "object" ? {
      usage: Object.fromEntries(Object.entries(result.usage).filter(([key, value]) =>
        ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens"].includes(key)
        && typeof value === "number" && Number.isFinite(value))),
    } : {}),
    ...(typeof result.total_cost_usd === "number" ? { costUsd: result.total_cost_usd } : {}),
    ...(result.stopReason === "end_turn" ? {} : { error: `Grok stopped: ${result.stopReason ?? "unknown"}` }) };
}
async function supervise(id: string) {
  const j = await read(id);
  const dir = file(id);
  j.supervisorPid = process.pid;
  j.state = "running";
  await save(j);
  let child: ReturnType<typeof spawn> | undefined;
  let cancelled = false;
  let timedOut = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!child?.pid || stopping) return;
    const group = child.pid;
    try { process.kill(-group, "SIGTERM"); } catch {}
    stopping = new Promise<void>(accept => setTimeout(() => {
      try { process.kill(-group, "SIGKILL"); } catch {}
      accept();
    }, 3000));
  };
  const signal = () => { cancelled = true; stop(); };
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);
  const out = await open(join(dir, `${j.turn}.stdout.json`), "w", 0o600);
  const err = await open(join(dir, `${j.turn}.stderr.log`), "w", 0o600);
  const poll = setInterval(async () => {
    if (await Bun.file(join(dir, `${j.turn}.cancel`)).exists()) { cancelled = true; stop(); }
  }, 200);
  const timer = setTimeout(() => { timedOut = true; stop(); }, j.timeoutMs);
  try {
    const rules = await readFile(join(import.meta.dir, "../worker-rules.md"), "utf8");
    cancelled ||= existsSync(join(dir, `${j.turn}.cancel`));
    if (cancelled || timedOut) {
      j.state = cancelled ? "cancelled" : "failed";
      j.error = cancelled ? "Cancelled before Grok started; workspace edits are preserved."
        : "Execution deadline exceeded before Grok started; workspace edits are preserved.";
      return;
    }
    child = spawn(j.binary, grokArgs(j, join(dir, `${j.turn}.prompt.txt`), rules), {
      cwd: j.cwd, stdio: ["ignore", out.fd, err.fd], detached: true,
    });
    const completion = new Promise<{ code: number | null; error?: Error }>((accept) => {
      child!.once("error", error => accept({ code: null, error }));
      child!.once("close", code => accept({ code }));
    });
    if (child.pid) j.childPid = child.pid;
    await save(j);
    const outcome = await completion;
    if (outcome.error) throw outcome.error;
    const code = outcome.code;
    j.exitCode = code;
    const output = Bun.file(join(dir, `${j.turn}.stdout.json`));
    Object.assign(j, output.size > 16 * 1024 * 1024
      ? { state: "failed", error: "Grok output exceeded 16 MiB; inspect the local artifact." }
      : resultFields(await output.text(), code));
    if (cancelled) { j.state = "cancelled"; j.error = "Cancelled; workspace edits are preserved."; }
    else if (timedOut) { j.state = "failed"; j.error = "Execution deadline exceeded; workspace edits are preserved."; }
  } catch (e) { stop(); j.state = "failed"; j.error = String(e).slice(0, 2000); }
  finally {
    clearInterval(poll); clearTimeout(timer);
    if (stopping) await stopping;
    await out.close(); await err.close();
    j.cursor = `${j.turn}:terminal`;
    await save(j);
    await rm(join(dir, "busy"), { recursive: true, force: true });
  }
}
async function launch(j: Job, prompt: string) {
  const dir = file(j.id);
  await mkdir(join(dir, "busy")); // Atomic per-job exclusion: only one turn may run.
  // Recheck under the lock: two followups may have read the same completed turn.
  const previous = await Bun.file(join(dir, "job.json")).exists() ? await read(j.id) : undefined;
  if (previous && (active(previous) || previous.state === "orphaned" || previous.turn !== j.turn - 1)) {
    await rm(join(dir, "busy"), { recursive: true, force: true });
    throw Error("Job changed while dispatching; read status before retrying");
  }
  try {
    await writeFile(join(dir, `${j.turn}.prompt.txt`), prompt, { mode: 0o600 });
    await save(j);
    const log = await open(join(dir, `${j.turn}.supervisor.log`), "w", 0o600);
    try {
      const child = spawn(process.execPath, [import.meta.path, "_supervise", j.id], {
        detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, GROK_WORKER_STATE_DIR: root },
      });
      await new Promise<void>((accept, reject) => { child.once("spawn", accept); child.once("error", reject); });
      child.unref();
    } finally { await log.close(); }
  } catch (e) {
    j.state = "failed"; j.error = String(e); j.cursor = `${j.turn}:terminal`; await save(j);
    await rm(join(dir, "busy"), { recursive: true, force: true }); throw e;
  }
}
const help = `grok-worker spawn --cwd PATH --prompt-file PATH [--model grok-4.6] [--effort high] [--max-turns 64] [--timeout-ms 1800000]
grok-worker status|result|cancel ID
grok-worker wait ID [--after CURSOR] [--timeout-ms 58000]
grok-worker followup ID --prompt-file PATH
grok-worker inspect ID [--stream stderr|stdout|supervisor] [--tail-bytes 4000]
Requires Bun and an authenticated Grok CLI. Runs trusted Grok with bypassPermissions, no nested agents, in the given existing workspace.
State: GROK_WORKER_STATE_DIR or ~/.local/state/skizzles/grok-worker. GROK_WORKER_BINARY selects an explicit executable.
`;
function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!allowed.includes(key) || value === undefined || Object.hasOwn(result, key)) throw Error(`Invalid option: ${key}`);
    result[key] = value;
  }
  return result;
}
function integer(value: string | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > max) throw Error(`Expected integer between 0 and ${max}`);
  return Number(value);
}
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "--help") { console.log(help); return; }
  if (cmd === "_supervise") {
    const id = args[0]!;
    try { await supervise(id); }
    catch (e) {
      const j = await read(id);
      j.state = "failed"; j.error = `Supervisor failed: ${String(e).slice(0, 2000)}`;
      j.cursor = `${j.turn}:terminal`; await save(j);
      await rm(join(file(id), "busy"), { recursive: true, force: true });
    }
    return;
  }
  if (cmd === "spawn") {
    if (process.platform === "win32") throw Error("Grok worker requires POSIX process groups (macOS or Linux)");
    const o = options(args, ["--cwd", "--prompt-file", "--model", "--effort", "--max-turns", "--timeout-ms"]);
    if (!o["--cwd"] || !o["--prompt-file"]) throw Error("spawn requires --cwd and --prompt-file");
    const binary = Bun.which(process.env.GROK_WORKER_BINARY ?? "grok");
    if (!binary) throw Error("Grok executable not found");
    const j: Job = { id: randomUUID(), sessionId: randomUUID(), cwd: await realpath(o["--cwd"]), binary,
      model: o["--model"] ?? "grok-4.6", effort: o["--effort"] ?? "high",
      maxTurns: integer(o["--max-turns"], 64, 1000), timeoutMs: integer(o["--timeout-ms"], 1800000, 86400000),
      turn: 1, startedAt: Date.now(), cursor: "1:running", state: "starting" };
    if (!j.maxTurns || !j.timeoutMs) throw Error("Turn and execution limits must be positive");
    const prompt = await readFile(resolve(o["--prompt-file"]), "utf8");
    if (!prompt.trim()) throw Error("Empty prompt");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(file(j.id), { mode: 0o700 });
    await launch(j, prompt); console.log(JSON.stringify(compact(j))); return;
  }
  const id = args.shift(); if (!id) throw Error("Job ID required");
  let j = await read(id);
  if (cmd === "followup") {
    const o = options(args, ["--prompt-file"]);
    if (!o["--prompt-file"]) throw Error("followup requires --prompt-file");
    if (active(j) || j.state === "orphaned") throw Error("Job is active or orphaned; inspect status before followup");
    const prompt = await readFile(resolve(o["--prompt-file"]), "utf8");
    if (!prompt.trim()) throw Error("Empty prompt");
    j = { id: j.id, sessionId: j.sessionId, cwd: j.cwd, binary: j.binary, model: j.model, effort: j.effort,
      maxTurns: j.maxTurns, timeoutMs: j.timeoutMs, startedAt: Date.now(), turn: j.turn + 1, cursor: `${j.turn + 1}:running`, state: "starting" };
    await launch(j, prompt); console.log(JSON.stringify(compact(j))); return;
  }
  if (cmd === "wait") {
    const o = options(args, ["--after", "--timeout-ms"]);
    const deadline = Date.now() + integer(o["--timeout-ms"], 58000, 58000);
    while (Date.now() < deadline && (active(j) || j.cursor === o["--after"])) {
      await Bun.sleep(Math.min(200, Math.max(0, deadline - Date.now()))); j = await read(id);
    }
    console.log(JSON.stringify({ ...compact(j), changed: !active(j) && j.cursor !== o["--after"] })); return;
  }
  if (cmd === "inspect") {
    const o = options(args, ["--stream", "--tail-bytes"]);
    const stream = o["--stream"] ?? "stderr";
    const suffix = { stderr: "stderr.log", stdout: "stdout.json", supervisor: "supervisor.log" }[stream];
    if (!suffix) throw Error("Invalid stream");
    const count = integer(o["--tail-bytes"], 4000, 12000);
    const f = Bun.file(join(file(id), `${j.turn}.${suffix}`));
    console.log(await f.slice(Math.max(0, f.size - count)).text()); return;
  }
  options(args, []);
  if (cmd === "cancel") {
    if (active(j)) await writeFile(join(file(id), `${j.turn}.cancel`), "cancel", { mode: 0o600 });
    console.log(JSON.stringify({ ...compact(j), cancellationRequested: active(j) }));
  } else if (cmd === "status") console.log(JSON.stringify(compact(j)));
  else if (cmd === "result") console.log(JSON.stringify({ ...compact(j), summary: j.summary, stopReason: j.stopReason,
    usage: j.usage, costUsd: j.costUsd, artifacts: file(id) }));
  else throw Error(`Unknown command: ${cmd}`);
}
if (import.meta.main) main().catch(e => { console.error(String(e)); process.exitCode = 1; });
