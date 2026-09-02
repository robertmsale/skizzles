import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("OMP orchestration installer", () => {
  test("installs and uninstalls an owned client surface", async () => {
    const root = await fixture();
    const env = fixtureEnv(root);
    const install = runInstaller(["--client-only"], env);
    expect(install.exitCode).toBe(0);
    expect(JSON.parse(install.stdout!.toString())).toMatchObject({ installed: true, mode: "client" });
    expect(await readlink(join(root, "home/.local/bin/ompctl"))).toBe(join(root, "install/runtime/src/cli.ts"));
    expect(await readlink(join(root, "home/.codex/skills/omp-orchestration"))).toBe(join(root, "install/skill"));
    const help = Bun.spawnSync([join(root, "home/.local/bin/ompctl"), "--help"], { env, stdout: "pipe", stderr: "pipe" });
    expect(help.exitCode).toBe(0);
    expect(JSON.parse(help.stdout.toString())).toHaveProperty("help");
    const skillHelp = Bun.spawnSync([
      process.execPath, join(root, "home/.codex/skills/omp-orchestration/scripts/ompctl"), "--help",
    ], { env: { ...env, PATH: "" }, stdout: "pipe", stderr: "pipe" });
    expect(skillHelp.exitCode).toBe(0);
    expect(JSON.parse(skillHelp.stdout.toString())).toHaveProperty("help");
    expect(runInstaller(["--uninstall"], env).exitCode).toBe(0);
    expect(existsSync(join(root, "install"))).toBe(false);
    expect(existsSync(join(root, "home/.local/bin/ompctl"))).toBe(false);
  });

  test("host install writes no bearer secret into its LaunchAgent", async () => {
    const root = await fixture();
    const fakeLaunchctl = join(root, "bin/launchctl");
    const fakeOmp = join(root, "bin/omp");
    await Bun.write(fakeLaunchctl, "#!/bin/sh\nexit 0\n");
    await Bun.write(fakeOmp, "#!/bin/sh\nexit 0\n");
    await chmod(fakeLaunchctl, 0o755);
    await chmod(fakeOmp, 0o755);
    const env = { ...fixtureEnv(root), PATH: join(root, "bin") };
    const install = runInstaller([], env);
    expect(install.exitCode).toBe(0);
    const plist = await readFile(join(root, "home/Library/LaunchAgents/io.github.skizzles.omp-orchestration.plist"), "utf8");
    expect(plist).not.toContain("OMP_ORCHESTRATION_HTTP_TOKEN");
    expect(plist).toContain("<key>OMP_BINARY</key>");
    expect(plist).toContain("scripts/launch.ts");
    await rm(fakeOmp);
    expect(runInstaller(["--client-only"], env).exitCode).toBe(0);
    expect(existsSync(join(root, "home/.local/bin/omp-orchestrationd"))).toBe(false);
    expect(existsSync(join(root, "home/Library/LaunchAgents/io.github.skizzles.omp-orchestration.plist"))).toBe(false);
    expect(runInstaller(["--uninstall"], env).exitCode).toBe(0);
  });

  test("refuses runtime drift and an unowned install root", async () => {
    const root = await fixture();
    const env = fixtureEnv(root);
    expect(runInstaller(["--client-only"], env).exitCode).toBe(0);
    await Bun.write(join(root, "install/runtime/README.md"), "foreign change\n");
    const drifted = runInstaller(["--uninstall"], env);
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stderr!.toString()).toContain("managed runtime drifted");

    const foreignRoot = await fixture();
    const foreignEnv = fixtureEnv(foreignRoot);
    await mkdir(join(foreignRoot, "install"));
    const foreign = runInstaller(["--client-only"], foreignEnv);
    expect(foreign.exitCode).toBe(1);
    expect(foreign.stderr!.toString()).toContain("refusing unowned installation directory");

    const broad = runInstaller(["--client-only"], { ...fixtureEnv(foreignRoot), OMP_ORCHESTRATION_INSTALL_ROOT: "/" });
    expect(broad.exitCode).toBe(1);
    expect(broad.stderr!.toString()).toContain("is too broad");
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-omp-install-test-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  return root;
}

function fixtureEnv(root: string): Record<string, string> {
  return {
    HOME: join(root, "home"),
    OMP_ORCHESTRATION_INSTALL_ROOT: join(root, "install"),
    PATH: process.env.PATH ?? "",
  };
}

function runInstaller(args: string[], env: Record<string, string>): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/install.ts"), ...args], {
    cwd: dirname(import.meta.dir), env, stdout: "pipe", stderr: "pipe",
  });
}
