import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const canonicalLauncher = join(repositoryRoot, "skills/t3-orchestration/scripts/t3ctl");
const temporaryRoots: string[] = [];

afterEach(() => temporaryRoots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("T3 orchestration bundled launcher", () => {
  test("forwards argv, stdin, and exit status", async () => {
    const launcher = fixtureTarget("const stdin = await Bun.stdin.text(); console.log(JSON.stringify({ args: process.argv.slice(2), stdin })); process.exit(23);");
    const result = await invoke(launcher, ["tasks", "send", "thread", "--message", "hello"], "payload\n");
    expect(result.exitCode).toBe(23);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["tasks", "send", "thread", "--message", "hello"],
      stdin: "payload\n",
    });
  });

  test("resolves canonical and copied-plugin runtimes without node_modules", async () => {
    const source = await invoke(canonicalLauncher, ["--help"]);
    expect(source.exitCode).toBe(0);
    expect(typeof (JSON.parse(source.stdout) as { help?: unknown }).help).toBe("string");

    const root = temporaryRoot();
    const plugin = join(root, "skizzles");
    cpSync(join(repositoryRoot, "plugins/skizzles"), plugin, { recursive: true });
    expect(existsSync(join(plugin, "node_modules"))).toBe(false);
    const staged = await invoke(join(plugin, "skills/t3-orchestration/scripts/t3ctl"), ["--help"]);
    expect(staged.exitCode).toBe(0);
    expect(typeof (JSON.parse(staged.stdout) as { help?: unknown }).help).toBe("string");
  });

  test("resolves the receipt-owned installed runtime without PATH", async () => {
    const root = temporaryRoot();
    const launcher = join(root, "skill/scripts/t3ctl");
    const runtime = join(root, "runtime/cli.ts");
    mkdirSync(dirname(launcher), { recursive: true });
    mkdirSync(dirname(runtime), { recursive: true });
    writeFileSync(launcher, readFileSync(canonicalLauncher));
    chmodSync(launcher, 0o755);
    writeFileSync(runtime, "console.log(JSON.stringify({ installed: true, args: process.argv.slice(2) }));\n");

    const result = await invoke(launcher, ["projects", "list"], undefined, { PATH: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ installed: true, args: ["projects", "list"] });
  });

  test("uses a distinct PATH binary from a skill-only install without recursing", async () => {
    const root = temporaryRoot();
    const launcher = skillOnlyLauncher(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(launcher, join(bin, "t3ctl"));
    const fallback = join(root, "fallback", "t3ctl");
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, `#!${process.execPath}\nconsole.log(JSON.stringify({ fallback: true, args: process.argv.slice(2) }));\n`);
    chmodSync(fallback, 0o755);

    const result = await invoke(launcher, ["projects", "list"], undefined, {
      PATH: `${bin}:${dirname(fallback)}:${process.env.PATH ?? ""}`,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ fallback: true, args: ["projects", "list"] });
    expect(result.stderr).toBe("");
  });

  test("explains a missing runtime for a skill-only install", async () => {
    const root = temporaryRoot();
    const result = await invoke(skillOnlyLauncher(root), ["projects", "list"], undefined, { PATH: join(root, "empty") });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("skill-only install contains guidance");
    expect(result.stderr).toContain("full Skizzles plugin");
  });
});

function fixtureTarget(body: string): string {
  const root = temporaryRoot();
  const launcher = join(root, "skills/t3-orchestration/scripts/t3ctl");
  const target = join(root, "packages/t3-orchestration/src/cli.ts");
  mkdirSync(dirname(launcher), { recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(launcher, readFileSync(canonicalLauncher));
  chmodSync(launcher, 0o755);
  writeFileSync(target, `#!/usr/bin/env bun\n${body}\n`);
  chmodSync(target, 0o755);
  return launcher;
}

function skillOnlyLauncher(root: string): string {
  const launcher = join(root, "skills/t3-orchestration/scripts/t3ctl");
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, readFileSync(canonicalLauncher));
  chmodSync(launcher, 0o755);
  return launcher;
}

async function invoke(path: string, args: string[], stdin?: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, path, ...args], {
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
  const root = mkdtempSync(join(tmpdir(), "skizzles-t3-orchestration-launcher-"));
  temporaryRoots.push(root);
  return root;
}
