import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function install(root: string, ...args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const process = Bun.spawn(["bun", resolve(import.meta.dir, "../scripts/install.ts"), ...args], {
    env: { ...Bun.env, HOME: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await process.exited, stderr: await new Response(process.stderr).text() };
}

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
