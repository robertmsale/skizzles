import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../src/auto-guardian-cli.ts");

describe("auto guardian CLI", () => {
  test("prints host-only help without talking to the daemon", async () => {
    const child = Bun.spawn(["bun", CLI, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const help = JSON.parse(stdout) as { help: string; policySource: string };
    expect(help.help).toContain("t3-auto-guardian {run|once|status}");
    expect(help.policySource).toContain("codex-rs/core/src/guardian");
    expect(help.help).toContain("t3-auto-guardian.toml");
    expect(help.help).toContain("grok, cursor, or opencode");
    expect(help.help).not.toContain("Provider-agnostic");
  });

  test("status reports the configured model and reasoning effort", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-auto-guardian-status-"));
    const configPath = join(root, "t3-auto-guardian.toml");
    await writeFile(configPath, `
enabled = true
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
`);
    const child = Bun.spawn(["bun", CLI, "status", "--config", configPath], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        T3_HOME: join(root, ".t3"),
        XDG_CONFIG_HOME: join(root, ".config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const status = JSON.parse(stdout) as { model: string; modelReasoningEffort: string };
    expect(status.model).toBe("gpt-5.6-luna");
    expect(status.modelReasoningEffort).toBe("low");
  });
});
