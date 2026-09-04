import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resultFields } from "../../../skills/grok-worker/scripts/grok-worker";
const cli = resolve("skills/grok-worker/scripts/grok-worker.ts");
describe("Grok worker", () => {
  test("does not accept errors, malformed output, or turn exhaustion as completion", () => {
    expect(resultFields("oops", 0).state).toBe("failed");
    expect(resultFields('{"type":"error","message":"denied"}', 0).state).toBe("failed");
    expect(resultFields('{"text":"partial","stopReason":"max_turns"}', 0).state).toBe("failed");
    const r = resultFields(JSON.stringify({ text: "x".repeat(20000), thought: "private", stopReason: "end_turn" }), 0);
    expect(r.summary?.length).toBe(12000);
    expect(r).not.toHaveProperty("thought");
  });
  test("detached execution, compact waits, resume settings, exclusion and cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-worker-test-"));
    const fake = join(dir, "grok");
    await writeFile(fake, `#!/usr/bin/env bun
const args = process.argv.slice(2);
await Bun.write(process.env.ARGV_LOG!, JSON.stringify(args));
const prompt = await Bun.file(args[args.indexOf('--prompt-file') + 1]!).text();
if (prompt === 'slow') await Bun.sleep(30000);
console.log(JSON.stringify({text: 'done', stopReason: 'end_turn', thought: 'DO_NOT_FORWARD'}));
`, { mode: 0o700 });
    const env = { ...process.env, GROK_WORKER_STATE_DIR: join(dir, "state"), GROK_WORKER_BINARY: fake, ARGV_LOG: join(dir, "args.json") };
    const run = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw Error(err);
      return JSON.parse(out);
    };
    try {
      const prompt = join(dir, "prompt"); await writeFile(prompt, "hello");
      const job = await run("spawn", "--cwd", dir, "--prompt-file", prompt, "--model", "test-model", "--effort", "low");
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
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 20000);
});
