import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactPath,
  createTestDirectories,
  encode,
  exitWithin,
  invoke,
  runner,
  spawnRunner,
  stopProcess,
  text,
  waitForFile,
  waitForProcessExit,
} from "./process-harness.ts";

const testDirectories = createTestDirectories();
const temporaryDirectory = () => testDirectories.create();
afterEach(() => testDirectories.cleanup());

describe("managed command output runner supervision", () => {
  test("settles a TERM-ignoring descendant after normal shell completion", async () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const descendantPidPath = join(root, "descendant.pid");
    const startedAt = performance.now();
    const result = invoke(
      runner,
      ["run", "--json", encode(`/bin/sh -c 'trap "" TERM; printf %s $$ > "${descendantPidPath}"; while :; do sleep 1; done' & exit 23`)],
      {
        env: {
          CODEX_COMMAND_OUTPUT_DIR: join(root, "artifacts"),
          CODEX_COMMAND_DRAIN_MS: "25",
          CODEX_COMMAND_SIGNAL_GRACE_MS: "100",
        },
      },
    );
    await waitForFile(descendantPidPath);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    const descendantExited = await waitForProcessExit(descendantPid);
    if (!descendantExited) stopProcess(descendantPid);

    expect(result.exitCode).toBe(23);
    expect(descendantExited).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    const path = artifactPath(text(result.stdout));
    const status = JSON.parse(readFileSync(join(path, "status.json"), "utf8"));
    expect(status.exitCode).toBe(23);
    expect(status.drainIncomplete).toBe(true);
  });

  test("cleans up a cooperative descendant after captured output drains completely", async () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const descendantPidPath = join(root, "descendant.pid");
    const terminatedPath = join(root, "terminated");
    const result = invoke(
      runner,
      ["run", "--json", encode(`/bin/sh -c 'trap "printf terminated > \\"${terminatedPath}\\"; exit 0" TERM; printf %s $$ > "${descendantPidPath}"; while :; do sleep 1; done' </dev/null >/dev/null 2>/dev/null & while [ ! -f '${descendantPidPath}' ]; do :; done`)],
      {
        env: {
          CODEX_COMMAND_OUTPUT_DIR: join(root, "artifacts"),
          CODEX_COMMAND_DRAIN_MS: "25",
          CODEX_COMMAND_SIGNAL_GRACE_MS: "500",
        },
      },
    );
    await waitForFile(descendantPidPath);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    const descendantExited = await waitForProcessExit(descendantPid);
    if (!descendantExited) stopProcess(descendantPid);

    expect(result.exitCode).toBe(0);
    expect(descendantExited).toBe(true);
    expect(readFileSync(terminatedPath, "utf8")).toBe("terminated");
    const status = JSON.parse(readFileSync(join(artifactPath(text(result.stdout)), "status.json"), "utf8"));
    expect(status.exitCode).toBe(0);
    expect(status.drainIncomplete).toBe(false);
  });
  test("forwards SIGTERM to the shell and preserves its handled exit", async () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const shellPidPath = join(root, "shell.pid");
    const child = spawnRunner(
      `trap 'printf handled >&2; exit 42' TERM; printf %s $$ > '${shellPidPath}'; while :; do :; done`,
      join(root, "artifacts"),
      { CODEX_COMMAND_SIGNAL_GRACE_MS: "250" },
    );
    await waitForFile(shellPidPath);
    const shellPid = Number.parseInt(readFileSync(shellPidPath, "utf8"), 10);
    process.kill(child.pid, "SIGTERM");
    const exitCode = await exitWithin(child, 1_500);
    if (exitCode === undefined) {
      stopProcess(shellPid);
      stopProcess(child.pid);
    }

    expect(exitCode).toBe(42);
    const output = await new Response(child.stdout).text();
    const directory = artifactPath(output);
    const status = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
    expect(status.signal).toBe("SIGTERM");
    expect(status.exitCode).toBe(42);
    expect(readFileSync(join(directory, "stderr.log"), "utf8")).toBe("handled");
  });

  test("escalates for a signal-ignoring shell and descendant without hanging", async () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const shellPidPath = join(root, "shell.pid");
    const descendantPidPath = join(root, "descendant.pid");
    const child = spawnRunner(
      `trap '' TERM; printf %s $$ > '${shellPidPath}'; /bin/sh -c 'trap "" TERM; printf %s $$ > "${descendantPidPath}"; while :; do sleep 1; done' & wait`,
      join(root, "artifacts"),
      { CODEX_COMMAND_SIGNAL_GRACE_MS: "100" },
    );
    await waitForFile(shellPidPath);
    await waitForFile(descendantPidPath);
    const shellPid = Number.parseInt(readFileSync(shellPidPath, "utf8"), 10);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    process.kill(child.pid, "SIGTERM");
    const exitCode = await exitWithin(child, 1_500);
    const shellExited = await waitForProcessExit(shellPid);
    const descendantExited = await waitForProcessExit(descendantPid);
    if (!shellExited) stopProcess(shellPid);
    if (!descendantExited) stopProcess(descendantPid);
    if (exitCode === undefined) stopProcess(child.pid);

    expect(exitCode).toBe(137);
    expect(shellExited).toBe(true);
    expect(descendantExited).toBe(true);
    const output = await new Response(child.stdout).text();
    const status = JSON.parse(readFileSync(join(artifactPath(output), "status.json"), "utf8"));
    expect(status.signal).toBe("SIGTERM");
    expect(status.exitCode).toBe(137);
  });

  test("cancels an ignoring descendant after the shell exits and drains captured output", async () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const shellPidPath = join(root, "shell.pid");
    const descendantPidPath = join(root, "descendant.pid");
    const child = spawnRunner(
      `printf %s $$ > '${shellPidPath}'; printf shell-output; /bin/sh -c 'trap "" TERM; printf %s $$ > "${descendantPidPath}"; while :; do sleep 1; done' &`,
      join(root, "artifacts"),
      { CODEX_COMMAND_DRAIN_MS: "5000", CODEX_COMMAND_SIGNAL_GRACE_MS: "100" },
    );
    await waitForFile(shellPidPath);
    await waitForFile(descendantPidPath);
    const shellPid = Number.parseInt(readFileSync(shellPidPath, "utf8"), 10);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    expect(await waitForProcessExit(shellPid)).toBe(true);

    process.kill(child.pid, "SIGTERM");
    const exitCode = await exitWithin(child, 1_500);
    const descendantExited = await waitForProcessExit(descendantPid);
    if (!descendantExited) stopProcess(descendantPid);
    if (exitCode === undefined) stopProcess(child.pid);

    expect(exitCode).toBe(143);
    expect(descendantExited).toBe(true);
    const output = await new Response(child.stdout).text();
    const directory = artifactPath(output);
    const status = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
    expect(status.signal).toBe("SIGTERM");
    expect(status.exitCode).toBe(143);
    expect(status.drainIncomplete).toBe(false);
    expect(readFileSync(join(directory, "stdout.log"), "utf8")).toBe("shell-output");
  });
});
