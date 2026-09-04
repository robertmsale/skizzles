#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, rm, realpath, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export type Job = {
  id: string; sessionId: string; cwd: string; binary: string; model: string; effort: string;
  maxTurns: number; timeoutMs: number; turn: number; cursor: string;
  state: "starting" | "running" | "completed" | "failed" | "cancelled";
  supervisorPid?: number; exitCode?: number | null; summary?: string; stopReason?: string;
  usage?: unknown; costUsd?: number; error?: string;
};
const root = resolve(process.env.GROK_WORKER_STATE_DIR ?? join(homedir(), ".local/state/skizzles/grok-worker"));
const limit = 12000;
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
async function read(id: string): Promise<Job> { return JSON.parse(await readFile(join(file(id), "job.json"), "utf8")); }
function compact(j: Job) {
  return { id: j.id, cursor: j.cursor, state: j.state, turn: j.turn, cwd: j.cwd,
    model: j.model, effort: j.effort, sessionId: j.sessionId,
    ...(j.error ? { error: j.error } : {}) };
}
export function grokArgs(j: Job, prompt: string, rules: string): string[] {
  return ["--cwd", j.cwd, "--model", j.model, "--reasoning-effort", j.effort,
    "--permission-mode", "bypassPermissions", "--no-subagents", "--no-plan",
    "--max-turns", String(j.maxTurns), "--output-format", "json", "--rules", rules,
    ...(j.turn === 1 ? ["--session-id", j.sessionId] : ["--resume", j.sessionId]),
    "--prompt-file", prompt];
}
export function resultFields(raw: string, exitCode: number | null): Partial<Job> {
  let result: any;
  try { result = JSON.parse(raw); } catch { return { state: "failed", error: "Grok returned invalid JSON; inspect the local output artifact." }; }
  if (exitCode !== 0 || result.type === "error" || typeof result.text !== "string") {
    return { state: "failed", error: String(result.message ?? `Grok exited ${exitCode} without a text result`).slice(0, 2000) };
  }
  return { state: result.stopReason === "end_turn" ? "completed" : "failed",
    summary: result.text.slice(0, limit), stopReason: String(result.stopReason ?? "unknown"),
    usage: result.usage, costUsd: result.total_cost_usd,
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
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (!child?.pid || killTimer) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    killTimer = setTimeout(() => { try { process.kill(-child!.pid!, "SIGKILL"); } catch {} }, 3000);
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
    child = spawn(j.binary, grokArgs(j, join(dir, `${j.turn}.prompt.txt`), rules), {
      cwd: j.cwd, stdio: ["ignore", out.fd, err.fd], detached: true,
    });
    const code = await new Promise<number | null>((accept, reject) => {
      child!.once("error", reject); child!.once("close", accept);
    });
    j.exitCode = code;
    Object.assign(j, resultFields(await readFile(join(dir, `${j.turn}.stdout.json`), "utf8"), code));
    if (cancelled) { j.state = "cancelled"; j.error = "Cancelled; workspace edits are preserved."; }
    else if (timedOut) { j.state = "failed"; j.error = "Execution deadline exceeded; workspace edits are preserved."; }
  } catch (e) { j.state = "failed"; j.error = String(e).slice(0, 2000); }
  finally {
    clearInterval(poll); clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
    await out.close(); await err.close();
    j.cursor = `${j.turn}:terminal`;
    await save(j);
    await rm(join(dir, "busy"), { recursive: true, force: true });
  }
}
async function launch(j: Job, prompt: string) {
  const dir = file(j.id);
  await mkdir(join(dir, "busy")); // Atomic per-job exclusion: only one turn may run.
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
  if (cmd === "_supervise") { await supervise(args[0]!); return; }
  if (cmd === "spawn") {
    const o = options(args, ["--cwd", "--prompt-file", "--model", "--effort", "--max-turns", "--timeout-ms"]);
    if (!o["--cwd"] || !o["--prompt-file"]) throw Error("spawn requires --cwd and --prompt-file");
    const binary = Bun.which(process.env.GROK_WORKER_BINARY ?? "grok");
    if (!binary) throw Error("Grok executable not found");
    const j: Job = { id: randomUUID(), sessionId: randomUUID(), cwd: await realpath(o["--cwd"]), binary,
      model: o["--model"] ?? "grok-4.6", effort: o["--effort"] ?? "high",
      maxTurns: integer(o["--max-turns"], 64, 1000), timeoutMs: integer(o["--timeout-ms"], 1800000, 86400000),
      turn: 1, cursor: "1:running", state: "starting" };
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
    if (active(j)) throw Error("Job is active; wait or cancel before followup");
    const prompt = await readFile(resolve(o["--prompt-file"]), "utf8");
    if (!prompt.trim()) throw Error("Empty prompt");
    j = { id: j.id, sessionId: j.sessionId, cwd: j.cwd, binary: j.binary, model: j.model, effort: j.effort,
      maxTurns: j.maxTurns, timeoutMs: j.timeoutMs, turn: j.turn + 1, cursor: `${j.turn + 1}:running`, state: "starting" };
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
