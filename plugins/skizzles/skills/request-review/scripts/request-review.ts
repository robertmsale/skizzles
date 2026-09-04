#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

process.umask(0o077);
const home = homedir();
const stateRoot = join(home, ".local/state/skizzles/request-review");
const configPath = join(home, ".config/skizzles/request-review/config.toml");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const help = "request-review.ts run --cwd PATH (--base REF | --commit HEAD) [--rerun]\nrequest-review.ts result REVIEW_ID\nOperator settings: ~/.config/skizzles/request-review/config.toml";
type RecordData = {
  id: string; status: "running" | "completed" | "failed" | "stale"; cwd: string;
  head: string; base?: string; commit?: string; model: string; reasoningEffort: string;
  configHash: string; runnerHash: string; codexVersion: string; startedAt: string; finishedAt?: string;
  reviewerPid?: number; error?: string; reportPath: string;
};
async function atomic(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}
async function record(id: string): Promise<RecordData> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Invalid review ID");
  return JSON.parse(await readFile(join(stateRoot, "reviews", id, "review.json"), "utf8"));
}
async function emit(data: RecordData, cached = false) {
  let report: string | undefined;
  if (data.status === "completed" || data.status === "stale") {
    const file = Bun.file(data.reportPath);
    report = await file.slice(0, 64_000).text();
    if (file.size > 64_000) report += "\n[Report truncated; full report is at reportPath.]";
  }
  console.log(JSON.stringify({ ...data, cached, report }));
}
async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw Error(`Git ${args[0]} failed: ${err.trim()}`);
  return out.trim();
}
async function snapshot(cwd: string) {
  if (await git(cwd, "status", "--porcelain", "--untracked-files=all")) throw Error("Review requires a clean committed workspace, including untracked files");
  return git(cwd, "rev-parse", "HEAD");
}
function alive(pid?: number) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help") { console.log(help); return; }
  if (args[0] === "result") {
    if (args.length !== 2) throw Error(help);
    await emit(await record(args[1]!)); return;
  }
  if (args.shift() !== "run") throw Error(help);
  if (process.env.SKIZZLES_REVIEW_ACTIVE === "1") throw Error("Recursive review requests are not allowed");
  if (process.platform === "win32") throw Error("Review runner currently requires macOS or Linux process groups");
  const opts = new Map<string, string>(); let rerun = false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--rerun" && !rerun) { rerun = true; continue; }
    if (!["--cwd", "--base", "--commit"].includes(flag) || opts.has(flag)) throw Error(`Unknown or repeated option: ${flag}`);
    const value = args.shift();
    if (!value?.trim() || value.startsWith("--")) throw Error(`Missing value for ${flag}`);
    opts.set(flag, value);
  }
  if (!opts.has("--cwd") || Number(opts.has("--base")) + Number(opts.has("--commit")) !== 1) throw Error(help);
  const rawConfig = await readFile(configPath, "utf8").catch(() => { throw Error(`Operator configuration missing or unreadable: ${configPath}`); });
  const config = Bun.TOML.parse(rawConfig) as Record<string, unknown>;
  if (Object.keys(config).some((key) => !["model", "reasoning_effort", "timeout_seconds", "codex_binary"].includes(key))) throw Error("Unknown reviewer configuration field");
  const model = config.model, effort = config.reasoning_effort, timeout = config.timeout_seconds ?? 1800;
  if (typeof model !== "string" || !model.trim() || typeof effort !== "string" || !["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) throw Error("Invalid reviewer model/reasoning configuration");
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 7200) throw Error("timeout_seconds must be an integer from 1 through 7200");
  if (config.codex_binary !== undefined && (typeof config.codex_binary !== "string" || !config.codex_binary.startsWith("/"))) throw Error("codex_binary must be an absolute path");
  const binary = config.codex_binary as string | undefined ?? "codex";
  const cwd = await git(resolve(opts.get("--cwd")!), "rev-parse", "--show-toplevel");
  const gateDir = join(stateRoot, "workspaces", hash(cwd));
  await mkdir(gateDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(gateDir, "gate.sqlite"));
  db.exec("PRAGMA busy_timeout=0");
  try { db.exec("BEGIN IMMEDIATE"); } catch { db.close(); throw Error("A review request is already active for this workspace"); }
  try {
    const activePath = join(gateDir, "active.json");
    let previous: RecordData | undefined;
    try { previous = JSON.parse(await readFile(activePath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous?.status === "running" && (!previous.reviewerPid || alive(previous.reviewerPid))) throw Error(`Previous reviewer may still be running (PID ${previous.reviewerPid}); inspect before retrying`);
    const head = await snapshot(cwd);
    const ref = opts.get("--base") ?? opts.get("--commit")!;
    const resolved = await git(cwd, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
    const base = opts.has("--base") ? await git(cwd, "merge-base", head, resolved) : undefined;
    if (!base && resolved !== head) throw Error("--commit must resolve to current HEAD so review context matches the candidate");
    if (base && !await git(cwd, "diff", "--name-only", base, head)) throw Error("No reviewable changes against this base");
    const version = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [versionText, versionErr, versionCode] = await Promise.all([new Response(version.stdout).text(), new Response(version.stderr).text(), version.exited]);
    if (versionCode) throw Error(`Could not identify Codex: ${versionErr.trim()}`);
    const configHash = hash(rawConfig);
    const runnerHash = hash(await readFile(import.meta.path, "utf8"));
    const id = hash(JSON.stringify({ format: 1, cwd, head, base, commit: base ? undefined : head, configHash, runnerHash, codexVersion: versionText.trim() }));
    const dir = join(stateRoot, "reviews", id);
    let prior: RecordData | undefined;
    try { prior = await record(id); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (prior && !rerun) {
      if (await snapshot(cwd) !== head) throw Error("Candidate changed before cached review delivery");
      await emit(prior, true);
      if (prior.status !== "completed") process.exitCode = 1;
      return;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const attempt = randomUUID();
    const reportPath = join(dir, `${attempt}.report.txt`);
    const data: RecordData = { id, cwd, head, ...(base ? { base } : { commit: head }), model, reasoningEffort: effort, configHash, runnerHash, codexVersion: versionText.trim(), status: "running", startedAt: new Date().toISOString(), reportPath };
    const persist = async () => { await atomic(join(dir, "review.json"), data); await atomic(activePath, data); };
    let stdout: Awaited<ReturnType<typeof open>> | undefined;
    let stderr: Awaited<ReturnType<typeof open>> | undefined;
    const argv = ["exec", "--ignore-user-config", "--ephemeral", "-s", "read-only", "-m", model,
      "-c", `review_model=${JSON.stringify(model)}`, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`,
      "-c", "project_doc_max_bytes=0", "-c", "skills.include_instructions=false",
      "--json", "-o", reportPath, "review", ...(base ? ["--base", base] : ["--commit", head])];
    let child: ReturnType<typeof spawn> | undefined;
    let ended: Promise<number | null> | undefined;
    let killed = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      killed = true;
      if (!child?.pid) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      if (!killTimer) killTimer = setTimeout(() => { try { process.kill(-child!.pid!, "SIGKILL"); } catch {} }, 3000);
    };
    const timer = setTimeout(stop, timeout * 1000);
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    try {
      if (await snapshot(cwd) !== head) throw Error("Candidate changed before launch");
      stdout = await open(join(dir, `${attempt}.events.jsonl`), "wx", 0o600);
      stderr = await open(join(dir, `${attempt}.stderr.log`), "wx", 0o600);
      await persist();
      if (killed) throw Error("Review was cancelled or timed out before launch");
      child = spawn(binary, argv, { cwd, detached: true, env: { ...process.env, SKIZZLES_REVIEW_ACTIVE: "1" }, stdio: ["ignore", stdout.fd, stderr.fd] });
      ended = new Promise<number | null>((resolveExit, reject) => { child!.once("error", reject); child!.once("close", resolveExit); });
      void ended.catch(() => {});
      data.reviewerPid = child.pid;
      await persist();
      const code = await ended;
      if (killed) { await new Promise((r) => setTimeout(r, 3100)); throw Error("Review was cancelled or timed out"); }
      if (code !== 0) throw Error(`Codex review exited with code ${code}; inspect local logs`);
      if (!(await readFile(reportPath, "utf8")).trim()) throw Error("Codex produced no final review report");
      try { if (await snapshot(cwd) !== head) throw Error("HEAD changed"); data.status = "completed"; }
      catch { data.status = "stale"; data.error = "Workspace changed during review; report applies only to recorded candidate"; }
    } catch (error) {
      if (child?.pid && alive(child.pid)) { stop(); await ended?.catch(() => {}); await new Promise((r) => setTimeout(r, 3100)); }
      data.status = "failed"; data.error = error instanceof Error ? error.message : String(error); }
    finally {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      await stdout?.close(); await stderr?.close();
      data.finishedAt = new Date().toISOString(); await persist();
    }
    await emit(data);
    if (data.status !== "completed") process.exitCode = 1;
  } finally { db.exec("ROLLBACK"); db.close(); }
}
main().catch((error) => { console.log(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
