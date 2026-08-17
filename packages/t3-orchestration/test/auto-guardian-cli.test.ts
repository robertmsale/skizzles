import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("auto guardian CLI", () => {
  test("prints host-only help without talking to the daemon", async () => {
    const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/auto-guardian-cli.ts"), "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const help = JSON.parse(stdout) as { help: string; policySource: string };
    expect(help.help).toContain("t3-auto-guardian {run|once|status}");
    expect(help.policySource).toContain("codex-rs/core/src/guardian");
    expect(help.help).toContain("t3-auto-guardian.toml");
  });
});
