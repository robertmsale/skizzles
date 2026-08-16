import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

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
});
