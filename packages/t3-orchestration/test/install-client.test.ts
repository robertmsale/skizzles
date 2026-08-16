import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function install(root: string, ...args: string[]): Promise<{ exitCode: number; stderr: string }> {
  return installWithEnvironment(root, {}, ...args);
}

async function installWithEnvironment(
  root: string,
  environment: Record<string, string>,
  ...args: string[]
): Promise<{ exitCode: number; stderr: string }> {
  const process = Bun.spawn(["bun", resolve(import.meta.dir, "../scripts/install.ts"), ...args], {
    env: { ...Bun.env, HOME: root, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await process.exited, stderr: await new Response(process.stderr).text() };
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

describe("host installer", () => {
  test("unloads a newly bootstrapped service when activation fails", async () => {
    const root = `/tmp/t3-host-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root, { kickstartExit: 42 });
    const result = await installWithEnvironment(root, fixture.environment);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Could not start io.github.t3-orchestration.daemon");
    expect((await readFile(fixture.log, "utf8")).trim().split("\n")).toEqual([
      "print",
      "print",
      "bootstrap",
      "kickstart",
      "print",
      "bootout",
      "print",
      "print",
    ]);
    await expect(lstat(fixture.state)).rejects.toThrow();
    await expect(lstat(join(root, ".local/share/skizzles/t3-orchestration"))).rejects.toThrow();
    await expect(lstat(join(root, "Library/LaunchAgents/io.github.t3-orchestration.daemon.plist"))).rejects.toThrow();
  });

  test("refuses to unload a loaded service without receipt ownership", async () => {
    const root = `/tmp/t3-host-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root, { loaded: true });

    const result = await installWithEnvironment(root, fixture.environment);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Refusing to replace loaded io.github.t3-orchestration.daemon without a host install receipt");
    expect((await readFile(fixture.log, "utf8")).trim().split("\n")).toEqual(["print"]);
    expect(await readFile(fixture.state, "utf8")).toBe("loaded");
    await expect(lstat(join(root, ".local/share/skizzles/t3-orchestration"))).rejects.toThrow();
  });
});

describe("client-only installer", () => {
  test("installs only the CLI and skill on a clean client", async () => {
    const root = `/tmp/t3-client-install-${crypto.randomUUID()}`;
    roots.push(root);
    expect((await install(root, "--client-only")).exitCode).toBe(0);
    expect((await lstat(join(root, ".local/bin/t3ctl"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, ".local/bin/t3ctl"))).toBe(
      join(root, ".local/share/skizzles/t3-orchestration/runtime/cli.ts"),
    );
    await expect(lstat(join(root, ".local/bin/t3-orchestrationd"))).rejects.toThrow();
    expect((await lstat(join(root, ".codex/skills/t3-orchestration"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, ".local/share/skizzles/t3-orchestration"))).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".local/share/skizzles/t3-orchestration/install-receipt.json"), "utf8"))).toMatchObject({
      schema: 1,
      mode: "client",
      runtimeRoot: join(root, ".local/share/skizzles/t3-orchestration/runtime"),
    });

    expect((await install(root, "--uninstall")).exitCode).toBe(0);
    await expect(lstat(join(root, ".local/bin/t3ctl"))).rejects.toThrow();
    await expect(lstat(join(root, ".codex/skills/t3-orchestration"))).rejects.toThrow();
    await expect(lstat(join(root, ".local/share/skizzles/t3-orchestration"))).rejects.toThrow();
    await expect(lstat(join(root, ".local/share/skizzles/t3-orchestration/install-receipt.json"))).rejects.toThrow();
  });

  test("refuses foreign links without changing their targets", async () => {
    const root = `/tmp/t3-client-install-${crypto.randomUUID()}`;
    roots.push(root);
    const foreign = join(root, "foreign-cli");
    const target = join(root, ".local/bin/t3ctl");
    await mkdir(root, { recursive: true });
    await writeFile(foreign, "foreign");
    await mkdir(join(target, ".."), { recursive: true });
    await symlink(foreign, target);

    const result = await install(root, "--client-only");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Refusing to replace unowned path");
    expect(await readlink(target)).toBe(foreign);
    await expect(lstat(join(root, ".local/share/skizzles/t3-orchestration"))).rejects.toThrow();
  });

  test("refuses to leave an existing host daemon active", async () => {
    const root = `/tmp/t3-client-install-${crypto.randomUUID()}`;
    roots.push(root);
    const daemon = join(root, ".local/bin/t3-orchestrationd");
    await mkdir(join(daemon, ".."), { recursive: true });
    await writeFile(daemon, "host-owned");
    const result = await install(root, "--client-only");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Client-only install refuses existing host artifact");
    expect(await readFile(daemon, "utf8")).toBe("host-owned");
  });

  test("refuses uninstall after a managed link drifts", async () => {
    const root = `/tmp/t3-client-install-${crypto.randomUUID()}`;
    roots.push(root);
    expect((await install(root, "--client-only")).exitCode).toBe(0);
    const link = join(root, ".local/bin/t3ctl");
    const foreign = join(root, "foreign-cli");
    await writeFile(foreign, "foreign");
    await rm(link);
    await symlink(foreign, link);

    const result = await install(root, "--uninstall");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Managed link drifted");
    expect(await readlink(link)).toBe(foreign);
    expect((await lstat(join(root, ".local/share/skizzles/t3-orchestration"))).isDirectory()).toBe(true);
  });
});
