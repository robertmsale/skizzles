import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  const process = Bun.spawn(["bun", resolve(import.meta.dir, "../scripts/install-guardian.ts"), ...args], {
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

describe("auto guardian installer", () => {
  test("installs a distinct receipt-owned LaunchAgent and PATH link", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, fixture.environment);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as { launchAgentLabel: string; launchAgent: string };
    expect(payload.launchAgentLabel).toBe("io.github.skizzles.t3-auto-guardian");
    expect(payload.launchAgent).toBe(join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist"));
    const runtimeCli = join(root, ".local/share/skizzles/t3-auto-guardian/runtime/auto-guardian-cli.ts");
    expect(await readlink(join(root, ".local/bin/t3-auto-guardian"))).toBe(runtimeCli);
    expect((await lstat(runtimeCli)).mode & 0o111).not.toBe(0);
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian/runtime/daemon.ts"))).rejects.toThrow();
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian/runtime/cli.ts"))).rejects.toThrow();
    const plist = await readFile(payload.launchAgent, "utf8");
    expect(plist).toContain("io.github.skizzles.t3-auto-guardian");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).not.toContain("io.github.t3-orchestration.daemon");
    expect(plist).not.toContain("io.github.skizzles.t3-worktree-reaper");
    expect(JSON.parse(await readFile(join(root, ".local/share/skizzles/t3-auto-guardian/install-receipt.json"), "utf8"))).toMatchObject({
      schema: 1,
      runtimeRoot: join(root, ".local/share/skizzles/t3-auto-guardian/runtime"),
    });
    await expect(lstat(join(root, "Library/LaunchAgents/io.github.t3-orchestration.daemon.plist"))).rejects.toThrow();
    await expect(lstat(join(root, "Library/LaunchAgents/io.github.skizzles.t3-worktree-reaper.plist"))).rejects.toThrow();

    const uninstall = await installWithEnvironment(root, fixture.environment, "--uninstall");
    expect(uninstall.exitCode).toBe(0);
    await expect(lstat(join(root, ".local/bin/t3-auto-guardian"))).rejects.toThrow();
    await expect(lstat(payload.launchAgent)).rejects.toThrow();
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian"))).rejects.toThrow();
  });

  test("refuses --client-only and unknown flags", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const client = await install(root, "--client-only");
    expect(client.exitCode).not.toBe(0);
    expect(client.stderr).toContain("host-only and refuses --client-only");
    const unknown = await install(root, "--with-daemon");
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown installer option --with-daemon");
  });

  test("refuses foreign PATH links and LaunchAgents", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const foreign = join(root, "foreign-guardian");
    const target = join(root, ".local/bin/t3-auto-guardian");
    await mkdir(root, { recursive: true });
    await writeFile(foreign, "foreign");
    await mkdir(join(target, ".."), { recursive: true });
    await symlink(foreign, target);
    const result = await installWithEnvironment(root, fixture.environment);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Refusing to replace unowned path");
    expect(await readlink(target)).toBe(foreign);
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian"))).rejects.toThrow();
  });

  test("recovers a crash after the previous install root is renamed", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const link = join(root, ".local/bin/t3-auto-guardian");
    const firstTarget = await readlink(link);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-moved",
    });
    expect(crashed.exitCode).toBe(75);
    expect(await readlink(link)).toBe(firstTarget);
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).toBe("");
    expect(await readlink(link)).toBe(join(root, ".local/share/skizzles/t3-auto-guardian/runtime/auto-guardian-cli.ts"));
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian.journal"))).rejects.toThrow();
  });

  test("recovers a first-install crash after the new root is in place", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installed",
    });
    expect(crashed.exitCode).toBe(75);
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).toBe(0);
    expect(await readlink(join(root, ".local/bin/t3-auto-guardian"))).toBe(
      join(root, ".local/share/skizzles/t3-auto-guardian/runtime/auto-guardian-cli.ts"),
    );
  });

  test("refuses to unload a loaded guardian without receipt ownership", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root, { loaded: true });
    const result = await installWithEnvironment(root, fixture.environment);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Refusing to replace loaded io.github.skizzles.t3-auto-guardian without an install receipt");
    expect((await readFile(fixture.log, "utf8")).trim().split("\n")).toEqual(["print"]);
    expect(await readFile(fixture.state, "utf8")).toBe("loaded");
  });

  test("recovers a crash after the destination plist is replaced", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const link = join(root, ".local/bin/t3-auto-guardian");
    const plist = join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist");
    const firstTarget = await readlink(link);
    const firstPlist = await readFile(plist, "utf8");
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "plist-installed",
    });
    expect(crashed.exitCode).toBe(75);
    expect(await readlink(link)).toBe(firstTarget);
    expect(await readFile(plist, "utf8")).toBe(firstPlist);
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).toBe("");
    expect(await readlink(link)).toBe(join(root, ".local/share/skizzles/t3-auto-guardian/runtime/auto-guardian-cli.ts"));
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian.journal"))).rejects.toThrow();
    const uninstalled = await installWithEnvironment(root, fixture.environment, "--uninstall");
    expect(uninstalled.exitCode).toBe(0);
    await expect(lstat(link)).rejects.toThrow();
    await expect(lstat(plist)).rejects.toThrow();
  });

  test("recovers a crash after uninstall moves a receipt-owned destination", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const link = join(root, ".local/bin/t3-auto-guardian");
    const plist = join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist");
    const firstTarget = await readlink(link);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "uninstall-link-moved",
    }, "--uninstall");
    expect(crashed.exitCode).toBe(75);
    expect((await lstat(plist)).isFile()).toBe(true);
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).toBe("");
    expect(await readlink(link)).toBe(firstTarget);
    const uninstalled = await installWithEnvironment(root, fixture.environment, "--uninstall");
    expect(uninstalled.exitCode).toBe(0);
    await expect(lstat(link)).rejects.toThrow();
    await expect(lstat(plist)).rejects.toThrow();
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian"))).rejects.toThrow();
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian.journal"))).rejects.toThrow();
  });

  test("resumes --uninstall after a destination-move crash", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "uninstall-plist-moved",
    }, "--uninstall");
    expect(crashed.exitCode).toBe(75);
    const recovered = await installWithEnvironment(root, fixture.environment, "--uninstall");
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).toBe("");
    await expect(lstat(join(root, ".local/bin/t3-auto-guardian"))).rejects.toThrow();
    await expect(lstat(join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist"))).rejects.toThrow();
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian"))).rejects.toThrow();
  });

  test("serializes concurrent installer entrypoints onto one owned install", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const [first, second] = await Promise.all([
      installWithEnvironment(root, fixture.environment),
      installWithEnvironment(root, fixture.environment),
    ]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(second.stderr).toBe("");
    const link = join(root, ".local/bin/t3-auto-guardian");
    const receipt = JSON.parse(await readFile(join(root, ".local/share/skizzles/t3-auto-guardian/install-receipt.json"), "utf8")) as { runtimeRoot: string };
    expect(await readlink(link)).toBe(join(root, ".local/share/skizzles/t3-auto-guardian/runtime/auto-guardian-cli.ts"));
    expect(receipt.runtimeRoot).toBe(join(root, ".local/share/skizzles/t3-auto-guardian/runtime"));
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian.journal"))).rejects.toThrow();
    const uninstalled = await installWithEnvironment(root, fixture.environment, "--uninstall");
    expect(uninstalled.exitCode).toBe(0);
  });

  test("serializes concurrent installers that share HOME destinations but not installRoot", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const firstRoot = join(root, "roots/a");
    const secondRoot = join(root, "roots/b");
    const [first, second] = await Promise.all([
      installWithEnvironment(root, { ...fixture.environment, T3_AUTO_GUARDIAN_INSTALL_ROOT: firstRoot }),
      installWithEnvironment(root, { ...fixture.environment, T3_AUTO_GUARDIAN_INSTALL_ROOT: secondRoot }),
    ]);
    const outcomes = [first, second];
    const succeeded = outcomes.filter((result) => result.exitCode === 0);
    const failed = outcomes.filter((result) => result.exitCode !== 0);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.stderr).toContain("Refusing to replace unowned path");
    const winnerRoot = first.exitCode === 0 ? firstRoot : secondRoot;
    const link = join(root, ".local/bin/t3-auto-guardian");
    const receipt = JSON.parse(await readFile(join(winnerRoot, "install-receipt.json"), "utf8")) as { runtimeRoot: string };
    expect(await readlink(link)).toBe(join(winnerRoot, "runtime/auto-guardian-cli.ts"));
    expect(receipt.runtimeRoot).toBe(join(winnerRoot, "runtime"));
    const loserRoot = first.exitCode === 0 ? secondRoot : firstRoot;
    await expect(lstat(join(loserRoot, "install-receipt.json"))).rejects.toThrow();
    const uninstalled = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_ROOT: winnerRoot,
    }, "--uninstall");
    expect(uninstalled.exitCode).toBe(0);
    await expect(lstat(link)).rejects.toThrow();
  });

  test("restores a loaded LaunchAgent after an uninstall bootout crash", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    expect(await readFile(fixture.state, "utf8")).toBe("loaded");
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "uninstall-bootout",
    }, "--uninstall");
    expect(crashed.exitCode).toBe(75);
    expect(await lstat(fixture.state).then(() => "loaded").catch(() => "missing")).toBe("missing");
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).toBe("");
    expect(await readFile(fixture.state, "utf8")).toBe("loaded");
    expect(await readlink(join(root, ".local/bin/t3-auto-guardian"))).toBe(
      join(root, ".local/share/skizzles/t3-auto-guardian/runtime/auto-guardian-cli.ts"),
    );
  });

  test("recovers a first-install crash after the new root is journaled but not placed", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installing",
    });
    expect(crashed.exitCode).toBe(75);
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian"))).rejects.toThrow();
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).toBe("");
    expect(await readlink(join(root, ".local/bin/t3-auto-guardian"))).toBe(
      join(root, ".local/share/skizzles/t3-auto-guardian/runtime/auto-guardian-cli.ts"),
    );
    const uninstalled = await installWithEnvironment(root, fixture.environment, "--uninstall");
    expect(uninstalled.exitCode).toBe(0);
  });

  test("does not delete a replacement install root after a pre-rename crash", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installing",
    });
    expect(crashed.exitCode).toBe(75);
    const installRoot = join(root, ".local/share/skizzles/t3-auto-guardian");
    await mkdir(join(installRoot, "runtime"), { recursive: true });
    await writeFile(join(installRoot, "install-receipt.json"), `${JSON.stringify({
      version: 1,
      schema: 1,
      runtimeVersion: "0.0.0",
      runtimeRoot: join(installRoot, "runtime"),
      runtime: [],
      links: [],
      files: [],
    }, null, 2)}\n`);
    await writeFile(join(installRoot, "runtime", "planted.txt"), "foreign-root");
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).not.toBe(0);
    expect(await readFile(join(installRoot, "runtime", "planted.txt"), "utf8")).toBe("foreign-root");
  });

  test("does not delete a replacement root after the journaled inode is no longer live", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installed",
    });
    expect(crashed.exitCode).toBe(75);
    const installRoot = join(root, ".local/share/skizzles/t3-auto-guardian");
    await rm(installRoot, { recursive: true, force: true });
    await mkdir(join(installRoot, "runtime"), { recursive: true });
    await writeFile(join(installRoot, "runtime", "foreign-marker.txt"), "keep-replaced");
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).not.toBe(0);
    expect(await readFile(join(installRoot, "runtime", "foreign-marker.txt"), "utf8")).toBe("keep-replaced");
  });

  test("does not delete a same-inode install root after foreign content is added", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installed",
    });
    expect(crashed.exitCode).toBe(75);
    const installRoot = join(root, ".local/share/skizzles/t3-auto-guardian");
    await writeFile(join(installRoot, "foreign-marker.txt"), "keep-same-inode");
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).not.toBe(0);
    expect(await readFile(join(installRoot, "foreign-marker.txt"), "utf8")).toBe("keep-same-inode");
  });

  test("does not delete a same-inode install root after a tracked child is removed", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installed",
    });
    expect(crashed.exitCode).toBe(75);
    const installRoot = join(root, ".local/share/skizzles/t3-auto-guardian");
    await rm(join(installRoot, "runtime/auto-guardian.ts"));
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).not.toBe(0);
    expect(await lstat(installRoot).then(() => "present").catch(() => "missing")).toBe("present");
    await expect(lstat(join(installRoot, "runtime"))).resolves.toBeTruthy();
  });

  test("does not delete a same-inode transaction root after foreign content is added", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installing",
    });
    expect(crashed.exitCode).toBe(75);
    const journal = JSON.parse(await readFile(join(root, ".local/share/skizzles/t3-auto-guardian.journal"), "utf8")) as {
      transactionRoot: string;
    };
    await writeFile(join(journal.transactionRoot, "foreign-keep.txt"), "keep-tx-child");
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(await readFile(join(journal.transactionRoot, "foreign-keep.txt"), "utf8")).toBe("keep-tx-child");
    expect(recovered.exitCode).toBe(0);
  });

  test("does not delete a replaced transaction root during recovery", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installing",
    });
    expect(crashed.exitCode).toBe(75);
    const journal = JSON.parse(await readFile(join(root, ".local/share/skizzles/t3-auto-guardian.journal"), "utf8")) as {
      transactionRoot: string;
    };
    await rm(journal.transactionRoot, { recursive: true, force: true });
    await mkdir(journal.transactionRoot, { recursive: true });
    await writeFile(join(journal.transactionRoot, "foreign-keep.txt"), "keep-tx");
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(await readFile(join(journal.transactionRoot, "foreign-keep.txt"), "utf8")).toBe("keep-tx");
    expect(recovered.exitCode).toBe(0);
  });

  test("does not delete a replacement root that replays the staged receipt hash", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installing",
    });
    expect(crashed.exitCode).toBe(75);
    const journal = JSON.parse(await readFile(join(root, ".local/share/skizzles/t3-auto-guardian.journal"), "utf8")) as {
      transactionRoot: string;
    };
    const installRoot = join(root, ".local/share/skizzles/t3-auto-guardian");
    await mkdir(join(installRoot, "runtime"), { recursive: true });
    await copyFile(join(journal.transactionRoot, "new-install/install-receipt.json"), join(installRoot, "install-receipt.json"));
    await writeFile(join(installRoot, "runtime", "foreign-marker.txt"), "keep-me");
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).not.toBe(0);
    expect(await readFile(join(installRoot, "runtime", "foreign-marker.txt"), "utf8")).toBe("keep-me");
    expect((await readdir(installRoot)).includes("runtime")).toBe(true);
  });

  test("A-crash then B-install then A-recovery cannot clobber a completed B install", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const rootA = join(root, "roots/a");
    const rootB = join(root, "roots/b");
    expect((await installWithEnvironment(root, { ...fixture.environment, T3_AUTO_GUARDIAN_INSTALL_ROOT: rootA })).exitCode).toBe(0);
    const link = join(root, ".local/bin/t3-auto-guardian");
    const plist = join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist");
    const aTarget = await readlink(link);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_ROOT: rootA,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "uninstall-plist-moved",
    }, "--uninstall");
    expect(crashed.exitCode).toBe(75);
    const bInstall = await installWithEnvironment(root, { ...fixture.environment, T3_AUTO_GUARDIAN_INSTALL_ROOT: rootB });
    expect(bInstall.exitCode).not.toBe(0);
    expect(await readlink(link)).toBe(aTarget);
    await expect(lstat(join(rootB, "install-receipt.json"))).rejects.toThrow();
    const aRecovered = await installWithEnvironment(root, { ...fixture.environment, T3_AUTO_GUARDIAN_INSTALL_ROOT: rootA });
    expect(aRecovered.exitCode).toBe(0);
    expect(await readlink(link)).toBe(aTarget);
    const planted = join(root, "planted-b/auto-guardian-cli.ts");
    await mkdir(join(root, "planted-b"), { recursive: true });
    await writeFile(planted, "#!/usr/bin/env bun\n");
    const crashedAgain = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_ROOT: rootA,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "uninstall-plist-moved",
    }, "--uninstall");
    expect(crashedAgain.exitCode).toBe(75);
    await mkdir(join(link, ".."), { recursive: true });
    await symlink(planted, link);
    await writeFile(plist, "planted-b-plist");
    const afterPlanted = await installWithEnvironment(root, { ...fixture.environment, T3_AUTO_GUARDIAN_INSTALL_ROOT: rootA });
    expect(afterPlanted.exitCode).not.toBe(0);
    expect(await readlink(link)).toBe(planted);
    expect(await readFile(plist, "utf8")).toBe("planted-b-plist");
  });

  test("legacy install journal recovery does not remove a completed second-root destination", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const rootA = join(root, "roots/a");
    const rootB = join(root, "roots/b");
    expect((await installWithEnvironment(root, { ...fixture.environment, T3_AUTO_GUARDIAN_INSTALL_ROOT: rootB })).exitCode).toBe(0);
    const link = join(root, ".local/bin/t3-auto-guardian");
    const plist = join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist");
    const bTarget = await readlink(link);
    const bPlist = await readFile(plist, "utf8");
    const transactionRoot = join(root, "legacy-a-transaction");
    await mkdir(transactionRoot, { recursive: true });
    await writeFile(join(dirname(rootA), "t3-auto-guardian.journal"), `${JSON.stringify({
      version: 1,
      kind: "install",
      phase: "destinations-moved",
      transactionRoot,
      installRoot: rootA,
      destinations: [
        { destination: link, installed: true },
        { destination: plist, installed: true },
      ],
      installedRoot: true,
    }, null, 2)}\n`);
    const recovered = await installWithEnvironment(root, { ...fixture.environment, T3_AUTO_GUARDIAN_INSTALL_ROOT: rootA });
    expect(recovered.exitCode).not.toBe(0);
    expect(await readlink(link)).toBe(bTarget);
    expect(await readFile(plist, "utf8")).toBe(bPlist);
    expect(JSON.parse(await readFile(join(rootB, "install-receipt.json"), "utf8"))).toMatchObject({
      runtimeRoot: join(rootB, "runtime"),
    });
  });
});
