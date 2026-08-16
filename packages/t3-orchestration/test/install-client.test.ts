import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function install(root: string): Promise<{ exitCode: number; stderr: string }> {
  const process = Bun.spawn(["bun", resolve(import.meta.dir, "../scripts/install.ts"), "--client-only"], {
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
    expect((await install(root)).exitCode).toBe(0);
    expect((await lstat(join(root, ".local/bin/t3ctl"))).isSymbolicLink()).toBe(true);
    await expect(lstat(join(root, ".local/bin/t3-orchestrationd"))).rejects.toThrow();
    expect((await lstat(join(root, ".codex/skills/t3-orchestration"))).isSymbolicLink()).toBe(true);
  });

  test("refuses to leave an existing host daemon active", async () => {
    const root = `/tmp/t3-client-install-${crypto.randomUUID()}`;
    roots.push(root);
    const daemon = join(root, ".local/bin/t3-orchestrationd");
    await mkdir(join(daemon, ".."), { recursive: true });
    await writeFile(daemon, "host-owned");
    const result = await install(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Client-only install refuses existing host artifact");
    expect(await readFile(daemon, "utf8")).toBe("host-owned");
  });
});
