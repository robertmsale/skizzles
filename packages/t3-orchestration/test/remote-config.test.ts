import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { requireLocalReaperTransport, resolveRemoteConfigPath } from "../src/remote-config.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function run(args: string[], root: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["bun", resolve(import.meta.dir, "../src/cli.ts"), ...args], {
    env: {
      ...Bun.env,
      HOME: root,
      T3_ORCHESTRATION_REMOTE_CONFIG: join(root, "config/client.json"),
      T3_ORCHESTRATION_REMOTE_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}

describe("remote client configuration", () => {
  test("configures, reports, and clears an HTTPS tailnet endpoint", async () => {
    const root = `/tmp/t3-remote-config-${crypto.randomUUID()}`;
    roots.push(root);
    const url = "https://host.example-tailnet.ts.net";
    expect((await run(["remote", "configure", "--url", url], root)).exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(root, "config/client.json"), "utf8"))).toEqual({ url });
    expect((await stat(join(root, "config/client.json"))).mode & 0o777).toBe(0o600);

    const status = await run(["remote", "status"], root);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).url).toBe(url);

    expect((await run(["remote", "clear"], root)).exitCode).toBe(0);
    expect(JSON.parse((await run(["remote", "status"], root)).stdout).url).toBeNull();
  });

  test("trims padded remote-config selectors to one canonical path", () => {
    expect(resolveRemoteConfigPath(" remote.json ", "/tmp/home")).toBe(resolve("remote.json"));
    expect(resolveRemoteConfigPath(undefined, "/tmp/home")).toBe(join("/tmp/home", ".config/t3-orchestration/client.json"));
  });

  test("an explicit local reaper transport pin ignores remote t3ctl selectors", async () => {
    const previous = {
      transport: process.env.T3_WORKTREE_REAPER_TRANSPORT,
      url: process.env.T3_ORCHESTRATION_REMOTE_URL,
      config: process.env.T3_ORCHESTRATION_REMOTE_CONFIG,
    };
    process.env.T3_WORKTREE_REAPER_TRANSPORT = "local";
    process.env.T3_ORCHESTRATION_REMOTE_URL = "https://host.example.ts.net";
    process.env.T3_ORCHESTRATION_REMOTE_CONFIG = "/tmp/missing-remote.json";
    try {
      await expect(requireLocalReaperTransport()).resolves.toBeUndefined();
    } finally {
      if (previous.transport === undefined) delete process.env.T3_WORKTREE_REAPER_TRANSPORT;
      else process.env.T3_WORKTREE_REAPER_TRANSPORT = previous.transport;
      if (previous.url === undefined) delete process.env.T3_ORCHESTRATION_REMOTE_URL;
      else process.env.T3_ORCHESTRATION_REMOTE_URL = previous.url;
      if (previous.config === undefined) delete process.env.T3_ORCHESTRATION_REMOTE_CONFIG;
      else process.env.T3_ORCHESTRATION_REMOTE_CONFIG = previous.config;
    }
  });
});
