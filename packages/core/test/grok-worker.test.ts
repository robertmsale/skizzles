import { describe, test, expect } from "bun:test";
import { cp, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { resultFields } from "../../../skills/grok-worker/scripts/grok-worker";
const cli = resolve("skills/grok-worker/scripts/grok-worker.ts");
describe("Grok worker", () => {
  test("does not accept errors, malformed output, or turn exhaustion as completion", () => {
    expect(resultFields("oops", 0).state).toBe("failed");
    expect(resultFields("null", 0).state).toBe("failed");
    expect(resultFields('{"type":"error","message":"denied"}', 0).state).toBe("failed");
    expect(resultFields('{"structuredOutput":{"outcome":"completed","summary":"partial"},"stopReason":"max_turns"}', 0).state).toBe("failed");
    const r = resultFields(JSON.stringify({ structuredOutput: { outcome: "completed", summary: "x".repeat(20000) }, text: "private narration", thought: "private", stopReason: "end_turn" }), 0);
    expect(r.summary?.length).toBe(12000);
    expect(r).not.toHaveProperty("thought");
    expect(JSON.stringify(r)).not.toContain("private narration");
    expect(resultFields(JSON.stringify({ text: "narration only", stopReason: "end_turn" }), 0).state).toBe("failed");
    expect(resultFields(JSON.stringify({ structuredOutput: { outcome: "blocked", summary: "Need a fixture" }, stopReason: "end_turn" }), 0).state).toBe("blocked");
  });
  test("detached execution, compact waits, resume settings, exclusion and cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-worker-test-"));
    const fake = join(dir, "grok");
    await writeFile(fake, `#!/usr/bin/env bun
const args = process.argv.slice(2);
await Bun.write(process.env.ARGV_LOG!, JSON.stringify(args));
const prompt = await Bun.file(args[args.indexOf('--prompt-file') + 1]!).text();
if (prompt === 'slow') await Bun.sleep(30000);
console.log(JSON.stringify({structuredOutput: {outcome: 'completed', summary: 'done'}, text: 'DO_NOT_FORWARD', stopReason: 'end_turn', thought: 'DO_NOT_FORWARD'}));
`, { mode: 0o700 });
    const env = { ...process.env, GROK_WORKER_STATE_DIR: join(dir, "state"), GROK_WORKER_BINARY: fake, ARGV_LOG: join(dir, "args.json") };
    const run = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw Error(err);
      return JSON.parse(out);
    };
    let runningId: string | undefined;
    try {
      const prompt = join(dir, "prompt"); await writeFile(prompt, "hello");
      const job = await run("spawn", "--cwd", dir, "--prompt-file", prompt, "--model", "test-model", "--effort", "low");
      runningId = job.id;
      const first = await run("wait", job.id, "--timeout-ms", "10000");
      expect(first.state).toBe("completed"); expect(first).not.toHaveProperty("summary");
      const result = await run("result", job.id); expect(result.summary).toBe("done");
      expect(JSON.stringify(result)).not.toContain("DO_NOT_FORWARD");
      expect((await run("wait", job.id, "--after", first.cursor, "--timeout-ms", "0")).changed).toBe(false);
      await writeFile(prompt, "slow");
      await run("followup", job.id, "--prompt-file", prompt);
      await expect(run("followup", job.id, "--prompt-file", prompt)).rejects.toThrow();
      for (let i = 0; i < 100; i++) {
        const args = await Bun.file(env.ARGV_LOG).json();
        if (args.includes("--resume")) break;
        await Bun.sleep(20);
      }
      const args = await Bun.file(env.ARGV_LOG).json();
      expect(args).toContain("--resume"); expect(args).toContain(job.sessionId);
      expect(args).toContain("test-model"); expect(args).toContain("low");
      expect(args).toContain("--no-subagents"); expect(args).toContain("bypassPermissions");
      expect(args).not.toContain("--worktree"); expect(args).toContain(job.cwd);
      await run("cancel", job.id);
      expect((await run("wait", job.id, "--timeout-ms", "10000")).state).toBe("cancelled");
    } finally {
      if (runningId) {
        await run("cancel", runningId).catch(() => {});
        await run("wait", runningId, "--timeout-ms", "10000").catch(() => {});
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
  test("copied skill enforces deadlines and reports dead supervisors without permitting takeover", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-worker-copy-"));
    await cp(resolve("skills/grok-worker"), join(dir, "skill"), { recursive: true });
    const binary = join(dir, "grok");
    await writeFile(binary, "#!/usr/bin/env bun\nawait Bun.sleep(30000);\n", { mode: 0o700 });
    const prompt = join(dir, "prompt"); await writeFile(prompt, "slow");
    const state = join(dir, "state");
    const run = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, join(dir, "skill/scripts/grok-worker.ts"), ...args], {
        env: { ...process.env, GROK_WORKER_STATE_DIR: state, GROK_WORKER_BINARY: binary }, stdout: "pipe", stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code) throw Error(err);
      return JSON.parse(out);
    };
    try {
      const j = await run("spawn", "--cwd", dir, "--prompt-file", prompt, "--timeout-ms", "250");
      const terminal = await run("wait", j.id, "--timeout-ms", "10000");
      expect(terminal.state).toBe("failed"); expect(terminal.error).toContain("deadline");
      const path = join(state, j.id, "job.json");
      const stored = await Bun.file(path).json();
      // Simulate a launcher that died before its supervisor could register.
      await writeFile(path, JSON.stringify({ ...stored, state: "starting", supervisorPid: undefined, startedAt: 0 }));
      expect((await run("wait", j.id, "--timeout-ms", "0")).state).toBe("orphaned");
      await expect(run("followup", j.id, "--prompt-file", prompt)).rejects.toThrow("orphaned");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 15000);

  test("does not start a writer when the deadline expires during instruction loading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-worker-startup-"));
    const skill = join(dir, "skill");
    await cp(resolve("skills/grok-worker"), skill, { recursive: true });
    const rules = join(skill, "worker-rules.md");
    await rm(rules);
    expect(Bun.spawnSync(["mkfifo", rules]).exitCode).toBe(0);
    const binary = join(dir, "grok");
    const marker = join(dir, "writer-started");
    await writeFile(binary, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, 'started');\nconsole.log(JSON.stringify({structuredOutput:{outcome:'completed',summary:'done'},stopReason:'end_turn'}));\n`, { mode: 0o700 });
    const prompt = join(dir, "prompt"); await writeFile(prompt, "test");
    const state = join(dir, "state");
    const run = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, join(skill, "scripts/grok-worker.ts"), ...args], {
        env: { ...process.env, GROK_WORKER_STATE_DIR: state, GROK_WORKER_BINARY: binary }, stdout: "pipe", stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code) throw Error(err);
      return JSON.parse(out);
    };
    try {
      const j = await run("spawn", "--cwd", dir, "--prompt-file", prompt, "--timeout-ms", "50");
      // FIFO holds the supervisor in instruction loading until its deadline has fired.
      await Bun.sleep(500);
      await writeFile(rules, "worker rules");
      const terminal = await run("wait", j.id, "--timeout-ms", "10000");
      expect(terminal.state).toBe("failed");
      expect(terminal.error).toContain("before Grok started");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 15000);

  test("honors acknowledged cancellation before the supervisor starts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-worker-pre-cancel-"));
    const id = crypto.randomUUID();
    const state = join(dir, "state"); const jobDir = join(state, id);
    await mkdir(join(jobDir, "busy"), { recursive: true });
    const marker = join(dir, "writer-started"); const binary = join(dir, "grok");
    await writeFile(binary, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, 'started');\nconsole.log(JSON.stringify({structuredOutput:{outcome:'completed',summary:'done'},stopReason:'end_turn'}));\n`, { mode: 0o700 });
    await writeFile(join(jobDir, "1.prompt.txt"), "test");
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      id, sessionId: crypto.randomUUID(), cwd: dir, binary, model: "test", effort: "low", maxTurns: 1,
      timeoutMs: 10000, turn: 1, cursor: "1:running", state: "starting", startedAt: Date.now(),
    }));
    const run = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, cli, ...args], {
        env: { ...process.env, GROK_WORKER_STATE_DIR: state }, stdout: "pipe", stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code) throw Error(err);
      return out;
    };
    try {
      const db = new Database(join(jobDir, "control.sqlite"), { create: true });
      db.exec("BEGIN IMMEDIATE");
      let acknowledged = false;
      const cancellation = run("cancel", id).then(value => { acknowledged = true; return value; });
      try {
        await Bun.sleep(100);
        expect(acknowledged).toBe(false);
        expect(await Bun.file(join(jobDir, "1.cancel")).exists()).toBe(false);
      } finally { db.exec("COMMIT"); db.close(); }
      expect(JSON.parse(await cancellation).cancellationRequested).toBe(true);
      await run("_supervise", id);
      expect(JSON.parse(await run("status", id)).state).toBe("cancelled");
      expect(await Bun.file(marker).exists()).toBe(false);
      // A controller holding the SQLite gate must not hide an elapsed deadline
      // from the supervisor's event loop while SQLite waits synchronously.
      await rm(join(jobDir, "1.cancel"));
      const previous = await Bun.file(join(jobDir, "job.json")).json();
      await writeFile(join(jobDir, "job.json"), JSON.stringify({ ...previous,
        state: "starting", supervisorPid: undefined, startedAt: Date.now(), timeoutMs: 50,
      }));
      const deadlineGate = new Database(join(jobDir, "control.sqlite"));
      deadlineGate.exec("BEGIN IMMEDIATE");
      const supervisor = run("_supervise", id);
      try {
        for (let i = 0; i < 100; i++) {
          if ((await Bun.file(join(jobDir, "job.json")).json()).state === "running") break;
          await Bun.sleep(10);
        }
        await Bun.sleep(200);
        expect(await Bun.file(marker).exists()).toBe(false);
      } finally { deadlineGate.exec("COMMIT"); deadlineGate.close(); }
      await supervisor;
      const afterDeadline = JSON.parse(await run("status", id));
      expect(afterDeadline.state).toBe("failed");
      expect(afterDeadline.error).toContain("deadline");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

});
