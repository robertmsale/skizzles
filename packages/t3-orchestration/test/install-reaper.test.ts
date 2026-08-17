import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function install(root: string, ...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return installWithEnvironment(root, {}, ...args);
}

async function installWithEnvironment(
  root: string,
  environment: Record<string, string | undefined>,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = { ...Bun.env, HOME: root };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const process = Bun.spawn(["bun", resolve(import.meta.dir, "../scripts/install-reaper.ts"), ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}

async function launchctlFixture(
  root: string,
  options: { loaded?: boolean; kickstartExit?: number } = {},
): Promise<{ environment: Record<string, string>; log: string; state: string }> {
  const bin = join(root, "fake-bin");
  const state = join(root, "launchctl-state");
  const log = join(root, "launchctl.log");
  const launchctl = join(bin, "launchctl");
  await mkdir(bin, { recursive: true });
  if (options.loaded) await writeFile(state, "loaded");
  await writeFile(launchctl, `#!/bin/sh
echo "$1" >> "$MOCK_LAUNCHCTL_LOG"
case "$1" in
  print) test -f "$MOCK_LAUNCHCTL_STATE" ;;
  bootstrap) printf loaded > "$MOCK_LAUNCHCTL_STATE" ;;
  kickstart) exit "$MOCK_KICKSTART_EXIT" ;;
  bootout) rm -f "$MOCK_LAUNCHCTL_STATE" ;;
  *) exit 43 ;;
esac
`);
  await chmod(launchctl, 0o755);
  return {
    state,
    log,
    environment: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      UID: String(process.getuid?.() ?? 501),
      MOCK_KICKSTART_EXIT: String(options.kickstartExit ?? 0),
      MOCK_LAUNCHCTL_STATE: state,
      MOCK_LAUNCHCTL_LOG: log,
    },
  };
}

describe("worktree reaper installer", () => {
  test("installs a distinct receipt-owned LaunchAgent and PATH link", async () => {
    const root = `/tmp/t3-reaper-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, fixture.environment);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as { launchAgentLabel: string; launchAgent: string };
    expect(payload.launchAgentLabel).toBe("io.github.skizzles.t3-worktree-reaper");
    expect(payload.launchAgent).toBe(join(root, "Library/LaunchAgents/io.github.skizzles.t3-worktree-reaper.plist"));
    expect(await readlink(join(root, ".local/bin/t3-worktree-reaper"))).toBe(
      join(root, ".local/share/skizzles/t3-worktree-reaper/runtime/worktree-reaper-cli.ts"),
    );
    const plist = await readFile(payload.launchAgent, "utf8");
    expect(plist).toContain("io.github.skizzles.t3-worktree-reaper");
    expect(plist).toContain("<key>StartInterval</key><integer>1800</integer>");
    expect(plist).not.toContain("io.github.t3-orchestration.daemon");
    expect(JSON.parse(await readFile(join(root, ".local/share/skizzles/t3-worktree-reaper/install-receipt.json"), "utf8"))).toMatchObject({
      schema: 1,
      runtimeRoot: join(root, ".local/share/skizzles/t3-worktree-reaper/runtime"),
    });
    await expect(lstat(join(root, "Library/LaunchAgents/io.github.t3-orchestration.daemon.plist"))).rejects.toThrow();

    const uninstall = await installWithEnvironment(root, fixture.environment, "--uninstall");
    expect(uninstall.exitCode).toBe(0);
    await expect(lstat(join(root, ".local/bin/t3-worktree-reaper"))).rejects.toThrow();
    await expect(lstat(payload.launchAgent)).rejects.toThrow();
    await expect(lstat(join(root, ".local/share/skizzles/t3-worktree-reaper"))).rejects.toThrow();
  });

  test("refuses --client-only and unknown flags", async () => {
    const root = `/tmp/t3-reaper-install-${crypto.randomUUID()}`;
    roots.push(root);
    const client = await install(root, "--client-only");
    expect(client.exitCode).not.toBe(0);
    expect(client.stderr).toContain("host-only and refuses --client-only");
    const unknown = await install(root, "--with-daemon");
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown installer option --with-daemon");
  });

  test("refuses foreign PATH links and LaunchAgents", async () => {
    const root = `/tmp/t3-reaper-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const foreign = join(root, "foreign-reaper");
    const target = join(root, ".local/bin/t3-worktree-reaper");
    await mkdir(root, { recursive: true });
    await writeFile(foreign, "foreign");
    await mkdir(join(target, ".."), { recursive: true });
    await symlink(foreign, target);
    const result = await installWithEnvironment(root, fixture.environment);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Refusing to replace unowned path");
    expect(await readlink(target)).toBe(foreign);
    await expect(lstat(join(root, ".local/share/skizzles/t3-worktree-reaper"))).rejects.toThrow();
  });

  test("refuses to unload a loaded reaper without receipt ownership", async () => {
    const root = `/tmp/t3-reaper-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root, { loaded: true });
    const result = await installWithEnvironment(root, fixture.environment);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Refusing to replace loaded io.github.skizzles.t3-worktree-reaper without an install receipt");
    expect((await readFile(fixture.log, "utf8")).trim().split("\n")).toEqual(["print"]);
    expect(await readFile(fixture.state, "utf8")).toBe("loaded");
  });

  test("refuses uninstall after a managed link drifts", async () => {
    const root = `/tmp/t3-reaper-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const link = join(root, ".local/bin/t3-worktree-reaper");
    const foreign = join(root, "foreign-reaper");
    await writeFile(foreign, "foreign");
    await rm(link);
    await symlink(foreign, link);
    const result = await installWithEnvironment(root, fixture.environment, "--uninstall");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Managed link drifted");
    expect(await readlink(link)).toBe(foreign);
    expect((await lstat(join(root, ".local/share/skizzles/t3-worktree-reaper"))).isDirectory()).toBe(true);
  });
});
