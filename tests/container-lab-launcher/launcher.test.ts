import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const canonicalLauncher = join(repositoryRoot, "skills/codex-container-lab/scripts/codex-container-lab");
const temporaryRoots: string[] = [];

afterEach(() => temporaryRoots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("Container Lab bundled launcher", () => {
  test("forwards attached argv, stdin, exit status, and termination signals", async () => {
    const normal = fixtureTarget("const stdin = await Bun.stdin.text(); console.log(JSON.stringify({ args: process.argv.slice(2), stdin })); process.exit(Number(process.env.FAKE_EXIT ?? 0));");
    const result = await invoke(normal, ["run", "--lab", "demo", "--", "printf", "hello"], "payload\n", { FAKE_EXIT: "23" });
    expect(result.exitCode).toBe(23);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["run", "--lab", "demo", "--", "printf", "hello"],
      stdin: "payload\n",
    });

    const waiting = fixtureTarget("process.on('SIGTERM', () => { console.log('terminated'); process.exit(143); }); setInterval(() => {}, 1_000);");
    const child = Bun.spawn(["bun", waiting], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    child.stdin.end();
    await Bun.sleep(50);
    child.kill("SIGTERM");
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(143);
    expect(stdout).toContain("terminated");
    expect(stderr).toBe("");
  });

  test("resolves the canonical and copied-plugin runtime without node_modules", async () => {
    const source = await invoke(canonicalLauncher, ["--help"]);
    expect(source.exitCode).toBe(0);
    expect(typeof (JSON.parse(source.stdout) as { help?: unknown }).help).toBe("string");

    const root = temporaryRoot();
    const plugin = join(root, "skizzles");
    cpSync(join(repositoryRoot, "plugins/skizzles"), plugin, { recursive: true });
    expect(existsSync(join(plugin, "node_modules"))).toBe(false);
    const staged = await invoke(join(plugin, "skills/codex-container-lab/scripts/codex-container-lab"), ["--help"]);
    expect(staged.exitCode).toBe(0);
    expect(typeof (JSON.parse(staged.stdout) as { help?: unknown }).help).toBe("string");
  });
});

function fixtureTarget(body: string): string {
  const root = temporaryRoot();
  const launcher = join(root, "skills/codex-container-lab/scripts/codex-container-lab");
  const target = join(root, "packages/codex-container-lab/cli/src/cli.ts");
  mkdirSync(dirname(launcher), { recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(launcher, readFileSync(canonicalLauncher));
  chmodSync(launcher, 0o755);
  writeFileSync(target, `#!/usr/bin/env bun\n${body}\n`);
  chmodSync(target, 0o755);
  return launcher;
}

async function invoke(path: string, args: string[], stdin?: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", path, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  if (stdin) child.stdin.write(stdin);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skizzles-container-lab-launcher-"));
  temporaryRoots.push(root);
  return root;
}
