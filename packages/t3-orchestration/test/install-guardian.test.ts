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

async function findFileWithContent(root: string, content: string): Promise<string | undefined> {
  const walk = async (directory: string): Promise<string | undefined> => {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return undefined;
    }
    for (const name of entries) {
      const path = join(directory, name);
      try {
        const metadata = await lstat(path);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          const found = await walk(path);
          if (found) return found;
        } else if (metadata.isFile() && !metadata.isSymbolicLink() && await readFile(path, "utf8") === content) {
          return path;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  };
  return walk(root);
}

async function findSymlinkTarget(root: string, target: string): Promise<string | undefined> {
  const walk = async (directory: string): Promise<string | undefined> => {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return undefined;
    }
    for (const name of entries) {
      const path = join(directory, name);
      try {
        const metadata = await lstat(path);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          const found = await walk(path);
          if (found) return found;
        } else if (metadata.isSymbolicLink() && await readlink(path) === target) {
          return path;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  };
  return walk(root);
}

async function selectedPosixPath(root: string, kind: "rename" | "unlink" | "rmdir" | "exclusive-unlink" | "exclusive-move" | "reclaim"): Promise<string> {
  const recorded = await readFile(
    join(root, ".local/share/skizzles", `t3-auto-guardian.posix-${kind}.selected`),
    "utf8",
  );
  const selected = recorded.trim();
  expect(selected.startsWith(`${root}/`)).toBe(true);
  return selected;
}

async function leftoverInstallGarbage(root: string): Promise<string[]> {
  const data = join(root, ".local/share/skizzles");
  const parent = dirname(data);
  const found: string[] = [];
  for (const dir of [data, parent]) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".t3-auto-guardian-husk-")) found.push(name);
      if (dir !== data) continue;
      if (
        name.includes("reclaim") ||
        name.startsWith(".t3-auto-guardian-transaction-") ||
        name.startsWith(".t3-auto-guardian-uninstall-") ||
        name.startsWith(".staged-links") ||
        name.endsWith(".cleared") ||
        /^t3-auto-guardian\.journal\.[^.]+\.tmp$/.test(name)
      ) found.push(name);
    }
  }
  return [...new Set(found)].sort();
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
    expect(await leftoverInstallGarbage(root)).toEqual([]);

    const uninstall = await installWithEnvironment(root, fixture.environment, "--uninstall");
    expect(uninstall.exitCode).toBe(0);
    await expect(lstat(join(root, ".local/bin/t3-auto-guardian"))).rejects.toThrow();
    await expect(lstat(payload.launchAgent)).rejects.toThrow();
    await expect(lstat(join(root, ".local/share/skizzles/t3-auto-guardian"))).rejects.toThrow();
    expect(await leftoverInstallGarbage(root)).toEqual([]);
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
    expect(await leftoverInstallGarbage(root)).toEqual([]);
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
    expect(await leftoverInstallGarbage(root)).toEqual([]);
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
    expect(await leftoverInstallGarbage(root)).toEqual([]);
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
    expect(await leftoverInstallGarbage(root)).toEqual([]);
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
    expect(await leftoverInstallGarbage(root)).toEqual([]);
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

  test("does not pathname-rm a foreign directory swapped onto the reclaim path", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installed",
    });
    expect(crashed.exitCode).toBe(75);
    const recovered = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_RECLAIM_SWAP: "1",
    });
    expect(recovered.exitCode).not.toBe(0);
    const installRoot = join(root, ".local/share/skizzles/t3-auto-guardian");
    expect(await readFile(join(installRoot, "foreign-reclaim.txt"), "utf8")).toBe("keep-reclaim");
  });

  test("does not recursive-rm a foreign staged-links replacement", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_STAGED_LINKS_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await findFileWithContent(root, "keep-staged")).toBeTruthy();
  });

  test("does not unlink a destination replaced after artifact validation", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "plist-installed",
    });
    expect(crashed.exitCode).toBe(75);
    const recovered = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_DEST_SWAP: "1",
    });
    expect(recovered.exitCode).not.toBe(0);
    const plist = join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist");
    expect(await readFile(plist, "utf8")).toBe("foreign-destination");
  });

  test("does not delete a descendant swapped after reclaim inode validation", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installed",
    });
    expect(crashed.exitCode).toBe(75);
    const recovered = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_DESCENDANT_SWAP: "1",
    });
    expect(recovered.exitCode).not.toBe(0);
    const installRoot = join(root, ".local/share/skizzles/t3-auto-guardian");
    expect(await readFile(join(installRoot, "runtime/auto-guardian.ts"), "utf8")).toBe("foreign-child");
  });

  test("does not rmdir a foreign reclaim root swapped after inode verification", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installed",
    });
    expect(crashed.exitCode).toBe(75);
    const recovered = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_RECLAIM_POST_FSTAT_SWAP: "1",
    });
    expect(recovered.exitCode).not.toBe(0);
    const installRoot = join(root, ".local/share/skizzles/t3-auto-guardian");
    expect(await readFile(join(installRoot, "foreign-post-fstat.txt"), "utf8")).toBe("keep-post-fstat");
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

  test("fails closed when a foreign link appears before first-install place", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const link = join(root, ".local/bin/t3-auto-guardian");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "link-place",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(link, "utf8")).toBe("foreign-link");
  });

  test("fails closed when a foreign plist appears before first-install place", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const plist = join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "plist-place",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(plist, "utf8")).toBe("foreign-plist");
  });

  test("fails closed when a owned link is replaced before reinstall backup", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const link = join(root, ".local/bin/t3-auto-guardian");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "link-backup",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(link, "utf8")).toBe("foreign-link");
  });

  test("fails closed when a owned plist is replaced before reinstall backup", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const plist = join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "plist-backup",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(plist, "utf8")).toBe("foreign-plist");
  });

  test("fails closed when a link is replaced before uninstall mutation", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const link = join(root, ".local/bin/t3-auto-guardian");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "uninstall-link",
    }, "--uninstall");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(link, "utf8")).toBe("foreign-link");
  });

  test("fails closed when a plist is replaced before uninstall mutation", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const plist = join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "uninstall-plist",
    }, "--uninstall");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(plist, "utf8")).toBe("foreign-plist");
  });

  test("fails closed when a foreign link appears after last first-install check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const link = join(root, ".local/bin/t3-auto-guardian");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "link-place-commit",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(link, "utf8")).toBe("foreign-link");
  });

  test("fails closed when a foreign plist appears after last first-install check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const plist = join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "plist-place-commit",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(plist, "utf8")).toBe("foreign-plist");
  });

  test("fails closed when an owned link is replaced after last reinstall backup check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const link = join(root, ".local/bin/t3-auto-guardian");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "link-backup-commit",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(link, "utf8")).toBe("foreign-link");
  });

  test("fails closed when an owned plist is replaced after last reinstall backup check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const plist = join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "plist-backup-commit",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(plist, "utf8")).toBe("foreign-plist");
  });

  test("fails closed when a link is replaced after last uninstall check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const link = join(root, ".local/bin/t3-auto-guardian");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "uninstall-link-commit",
    }, "--uninstall");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(link, "utf8")).toBe("foreign-link");
  });

  test("fails closed when a plist is replaced after last uninstall check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const plist = join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_FOREIGN_DEST: "uninstall-plist-commit",
    }, "--uninstall");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(plist, "utf8")).toBe("foreign-plist");
  });

  test("does not unlink a file substituted after its final dispose hash check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_DISPOSE_FILE_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await findFileWithContent(root, "foreign-dispose-file")).toBeTruthy();
  });

  test("does not unlink a link substituted after its final dispose readlink check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_DISPOSE_LINK_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await findSymlinkTarget(root, "/tmp/foreign-dispose-link")).toBeTruthy();
  });

  test("does not rmdir a directory substituted after its final emptiness check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_DISPOSE_DIR_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await findFileWithContent(root, "keep")).toBeTruthy();
  });

  test("does not follow a planted journal tmp symlink", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const stateDir = join(root, ".local/share/skizzles");
    const victim = join(root, "secret.txt");
    await mkdir(stateDir, { recursive: true });
    await writeFile(victim, "do-not-truncate");
    await symlink(victim, join(stateDir, "t3-auto-guardian.journal.tmp"));
    const result = await installWithEnvironment(root, fixture.environment);
    expect(result.exitCode).toBe(0);
    expect(await readFile(victim, "utf8")).toBe("do-not-truncate");
    expect(await leftoverInstallGarbage(root)).toEqual([]);
  });

  test("does not overwrite a planted journal symlink target", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const stateDir = join(root, ".local/share/skizzles");
    const victim = join(root, "secret.txt");
    await mkdir(stateDir, { recursive: true });
    await writeFile(victim, "do-not-truncate");
    await symlink(victim, join(stateDir, "t3-auto-guardian.journal"));
    const result = await installWithEnvironment(root, fixture.environment);
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(victim, "utf8")).toBe("do-not-truncate");
  });

  test("recovery of a complete staged-links journal disposes leftover trees", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "plist-installed",
    });
    expect(crashed.exitCode).toBe(75);
    const recovered = await installWithEnvironment(root, fixture.environment);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).toBe("");
    expect(await leftoverInstallGarbage(root)).toEqual([]);
    const uninstalled = await installWithEnvironment(root, fixture.environment, "--uninstall");
    expect(uninstalled.exitCode).toBe(0);
    expect(await leftoverInstallGarbage(root)).toEqual([]);
  });

  test("recovery of a full uninstall transaction disposes leftover trees", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "uninstall-root-moved",
    }, "--uninstall");
    expect(crashed.exitCode).toBe(75);
    const recovered = await installWithEnvironment(root, fixture.environment, "--uninstall");
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).toBe("");
    await expect(lstat(join(root, ".local/bin/t3-auto-guardian"))).rejects.toThrow();
    await expect(lstat(join(root, "Library/LaunchAgents/io.github.skizzles.t3-auto-guardian.plist"))).rejects.toThrow();
    expect(await leftoverInstallGarbage(root)).toEqual([]);
  });

  test("fails closed when relocate source is replaced after the last identity check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const installRoot = join(root, ".local/share/skizzles/t3-auto-guardian");
    const link = join(root, ".local/bin/t3-auto-guardian");
    const firstTarget = await readlink(link);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_RELOCATE_COMMIT: "1",
      T3_AUTO_GUARDIAN_RELOCATE_RESTORE_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(installRoot, "utf8")).toBe("foreign-link");
    expect(await readlink(link)).toBe(firstTarget);
  });

  test("fails closed when the journal is replaced after the last publish identity check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const journal = join(root, ".local/share/skizzles/t3-auto-guardian.journal");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_JOURNAL_PUBLISH_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(journal, "utf8")).toBe("foreign-link");
  });

  test("fails closed when the journal aside is replaced after the last unlink identity check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_JOURNAL_UNLINK_COMMIT: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await findFileWithContent(root, "foreign-link")).toBeTruthy();
  });

  test("fails closed when a dispose aside is replaced after the last hash/readlink check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_DISPOSE_UNLINK_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await findFileWithContent(root, "foreign-link")).toBeTruthy();
  });

  test("fails closed when a directory is replaced after the final emptiness and identity check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_DISPOSE_RMDIR_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
  });

  test("fails closed when an empty install root appears after the absence check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const installRoot = join(root, ".local/share/skizzles/t3-auto-guardian");
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_ROOT_PLACE_EMPTY: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect((await lstat(installRoot)).isDirectory()).toBe(true);
    expect(await readdir(installRoot)).toEqual([]);
  });

  test("fails closed when exclusiveRenameOwned source is replaced after its final identity check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_RENAME_FROM_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await findFileWithContent(root, "foreign-link")).toBeTruthy();
  });

  test("fails closed when unlinkSameNode target is replaced after its final identity check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_UNLINK_INODE_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    expect(await findFileWithContent(root, "foreign-link")).toBeTruthy();
  });

  test("fails closed when rmdirSameNode target is replaced after its final emptiness check", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_RMDIR_INODE_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
  });

  test("fails closed when a restore source is replaced after its identity is bound", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-moved",
    });
    expect(crashed.exitCode).toBe(75);
    const recovered = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_RENAME_FROM_SWAP: "1",
    });
    expect(recovered.exitCode).not.toBe(0);
    expect(await findFileWithContent(root, "foreign-link")).toBeTruthy();
  });

  test("fails closed when a destination-backup restore source is replaced after identity bind", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "link-backed-up",
    });
    expect(crashed.exitCode).toBe(75);
    const recovered = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_RENAME_FROM_SWAP: "1",
    });
    expect(recovered.exitCode).not.toBe(0);
    expect(await findFileWithContent(root, "foreign-link")).toBeTruthy();
  });

  test("does not mutate a selected path swapped after posixRenameIfInode validation", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_POSIX_RENAME_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    const selected = await selectedPosixPath(root, "rename");
    expect(await readFile(selected, "utf8")).toBe("foreign-link");
  });

  test("does not mutate a selected path swapped after posixUnlinkIfInode validation", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_POSIX_UNLINK_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    const selected = await selectedPosixPath(root, "unlink");
    expect(await readFile(selected, "utf8")).toBe("foreign-link");
  });

  test("does not mutate a selected path swapped after posixRmdirIfInode validation", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_POSIX_RMDIR_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    const selected = await selectedPosixPath(root, "rmdir");
    expect((await lstat(selected)).isDirectory()).toBe(true);
    expect(await readdir(selected)).toEqual([]);
  });

  test("does not mutate a selected path swapped after unlinkExclusiveRegularFile validation", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_EXCLUSIVE_UNLINK_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    const selected = await selectedPosixPath(root, "exclusive-unlink");
    expect(await readFile(selected, "utf8")).toBe("foreign-link");
  });

  test("does not mutate a selected path swapped after exclusiveMoveOwned validation", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    expect((await installWithEnvironment(root, fixture.environment)).exitCode).toBe(0);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_EXCLUSIVE_MOVE_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    const selected = await selectedPosixPath(root, "exclusive-move");
    expect(await readFile(selected, "utf8")).toBe("foreign-link");
  });

  test("fails closed when leftover husk dispose is swapped", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const crashed = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_INSTALL_CRASH: "root-installed",
    });
    expect(crashed.exitCode).toBe(75);
    const recovered = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_DISPOSE_DIR_SWAP: "1",
    });
    expect(recovered.exitCode).not.toBe(0);
    expect(await findFileWithContent(root, "keep")).toBeTruthy();
  });

  test("does not mutate a selected path swapped after reclaimOwnedDirectory validation", async () => {
    const root = `/tmp/t3-guardian-install-${crypto.randomUUID()}`;
    roots.push(root);
    const fixture = await launchctlFixture(root);
    const result = await installWithEnvironment(root, {
      ...fixture.environment,
      T3_AUTO_GUARDIAN_RECLAIM_HUSK_SWAP: "1",
    });
    expect(result.exitCode).not.toBe(0);
    const selected = await selectedPosixPath(root, "reclaim");
    expect(await readFile(selected, "utf8")).toBe("foreign-link");
  });
});
