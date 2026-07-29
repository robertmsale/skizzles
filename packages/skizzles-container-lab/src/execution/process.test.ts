import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./process";

const temporary: string[] = [];
const posixTest = process.platform === "win32" ? test.skip : test;

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function processTreeScript(): Promise<{ env: NodeJS.ProcessEnv; marker: string; script: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "container-lab-process-"));
  temporary.push(root);
  const marker = path.join(root, "descendant.pid");
  const script = path.join(root, "descendant.ts");
  await writeFile(script, [
    'import { writeFileSync } from "node:fs";',
    'process.on("SIGTERM", () => {});',
    'writeFileSync(process.env.DESCENDANT_MARKER!, String(process.pid));',
    "setTimeout(() => process.exit(0), 2_000);",
  ].join("\n"));
  return {
    env: { ...process.env, DESCENDANT_MARKER: marker, DESCENDANT_SCRIPT: script, BUN_RUNTIME: process.execPath },
    marker,
    script: '"$BUN_RUNTIME" "$DESCENDANT_SCRIPT" & descendant=$!; while [ ! -s "$DESCENDANT_MARKER" ]; do sleep 0.01; done',
  };
}

async function cooperativeProcessTreeScript(): Promise<{
  cleanupMarker: string;
  env: NodeJS.ProcessEnv;
  marker: string;
  script: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "container-lab-cooperative-process-"));
  temporary.push(root);
  const marker = path.join(root, "descendant.pid");
  const cleanupMarker = path.join(root, "descendant.cleaned");
  const script = path.join(root, "descendant.ts");
  await writeFile(script, [
    'import { writeFileSync } from "node:fs";',
    "let cleaningUp = false;",
    'process.on("SIGTERM", () => {',
    "  if (cleaningUp) return;",
    "  cleaningUp = true;",
    "  setTimeout(() => {",
    '    writeFileSync(process.env.CLEANUP_MARKER!, "cleaned");',
    "    process.exit(0);",
    "  }, 50);",
    "});",
    'writeFileSync(process.env.DESCENDANT_MARKER!, String(process.pid));',
    "setInterval(() => {}, 1_000);",
  ].join("\n"));
  return {
    cleanupMarker,
    env: {
      ...process.env,
      BUN_RUNTIME: process.execPath,
      CLEANUP_MARKER: cleanupMarker,
      DESCENDANT_MARKER: marker,
      DESCENDANT_SCRIPT: script,
    },
    marker,
    script: '"$BUN_RUNTIME" "$DESCENDANT_SCRIPT" >/dev/null 2>&1 & while [ ! -s "$DESCENDANT_MARKER" ]; do sleep 0.01; done',
  };
}

async function descendantPid(marker: string): Promise<number> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      const value = Number.parseInt(await readFile(marker, "utf8"), 10);
      if (Number.isSafeInteger(value) && value > 0) return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error("descendant PID was not published");
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error(`descendant ${pid} survived runCommand cleanup`);
}

describe("runCommand", () => {
  test("rejects an already-aborted command before spawning it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "container-lab-pre-aborted-process-"));
    temporary.push(root);
    const marker = path.join(root, "spawned");
    const controller = new AbortController();
    controller.abort();
    const started = performance.now();

    await expect(runCommand(process.execPath, [
      "-e",
      `await Bun.write(${JSON.stringify(marker)}, "spawned"); await Bun.sleep(400);`,
    ], {
      signal: controller.signal,
    })).rejects.toThrow(`${process.execPath} aborted`);

    expect(performance.now() - started).toBeLessThan(200);
    expect(await Bun.file(marker).exists()).toBeFalse();
  });

  test("bounds captured output", async () => {
    const result = await runCommand("sh", ["-c", "printf 123456789"], { maxOutputBytes: 4 });
    expect(result.stdout.toString()).toBe("1234");
  });

  posixTest("rejects complete-looking output overflow and reaps the process group", async () => {
    const fixture = await processTreeScript();
    const completion = runCommand("sh", ["-c", `${fixture.script}; printf 'a\\0b\\0c\\0'; wait`], {
      env: fixture.env,
      maxOutputBytes: 4,
      rejectOnOutputLimit: true,
    });
    const rejection = expect(completion).rejects.toThrow("sh stdout exceeded 4 byte output limit");
    const pid = await descendantPid(fixture.marker);
    await rejection;
    await expectProcessGone(pid);
  });

  test("reports failures", async () => {
    await expect(runCommand("sh", ["-c", "echo nope >&2; exit 7"])).rejects.toThrow("failed (7): nope");
  });

  posixTest("timeout reaps descendants without waiting for inherited pipes", async () => {
    const fixture = await processTreeScript();
    const started = performance.now();
    const completion = runCommand("sh", ["-c", `${fixture.script}; wait`], {
      env: fixture.env,
      timeoutMs: 100,
      allowFailure: true,
    });
    const pid = await descendantPid(fixture.marker);
    await expect(completion).resolves.toMatchObject({ code: 124 });
    expect(performance.now() - started).toBeLessThan(1_000);
    await expectProcessGone(pid);
  });

  posixTest("timeout remains authoritative when the child handles TERM with success", async () => {
    const started = performance.now();
    const result = await runCommand("sh", [
      "-c",
      "trap 'exit 0' TERM; while :; do sleep 10; done",
    ], {
      timeoutMs: 100,
      allowFailure: true,
    });
    expect(result.code).toBe(124);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  posixTest("abort reaps a TERM-resistant descendant", async () => {
    const fixture = await processTreeScript();
    const controller = new AbortController();
    const started = performance.now();
    const completion = runCommand("sh", ["-c", `${fixture.script}; wait`], {
      env: fixture.env,
      signal: controller.signal,
    });
    const pid = await descendantPid(fixture.marker);
    controller.abort();
    await expect(completion).rejects.toThrow("sh aborted");
    expect(performance.now() - started).toBeLessThan(1_000);
    await expectProcessGone(pid);
  });

  posixTest("leader exit reaps a TERM-resistant descendant holding its pipes", async () => {
    const fixture = await processTreeScript();
    const started = performance.now();
    const completion = runCommand("sh", ["-c", `${fixture.script}; exit 0`], { env: fixture.env });
    const pid = await descendantPid(fixture.marker);
    await expect(completion).resolves.toMatchObject({ code: 0 });
    expect(performance.now() - started).toBeLessThan(1_000);
    await expectProcessGone(pid);
  });

  posixTest("leader exit preserves the TERM grace for a cooperative descendant with redirected pipes", async () => {
    const fixture = await cooperativeProcessTreeScript();
    const started = performance.now();
    const completion = runCommand("sh", ["-c", `${fixture.script}; exit 0`], { env: fixture.env });
    const pid = await descendantPid(fixture.marker);

    await expect(completion).resolves.toMatchObject({ code: 0 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(await readFile(fixture.cleanupMarker, "utf8")).toBe("cleaned");
    await expectProcessGone(pid);
  });
});
