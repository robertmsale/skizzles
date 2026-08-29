import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry } from "../src/projects.ts";
import { AggregatorState } from "../src/state.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("persistent project registry", () => {
  test("discovers the checkout origin and survives a database restart", async () => {
    const directory = temporaryDirectory();
    const cwd = join(directory, "project");
    await run("git", "init", cwd);
    await run("git", "-C", cwd, "remote", "add", "origin", "https://example.test/owner/project.git");
    const path = join(directory, "state.sqlite3");

    const firstState = new AggregatorState(path);
    const firstRegistry = new ProjectRegistry(firstState);
    const registered = await firstRegistry.register(cwd);
    expect(registered).toMatchObject({ cwd: realpathSync(cwd), cloneUrl: "https://example.test/owner/project.git" });
    firstState.close();

    const secondState = new AggregatorState(path);
    const secondRegistry = new ProjectRegistry(secondState);
    expect(secondRegistry.list()).toEqual([registered]);
    expect(await secondRegistry.find(cwd)).toEqual(registered);
    secondState.close();
  });

  test("updates a registered checkout and removes it by cwd", async () => {
    const directory = temporaryDirectory();
    const cwd = join(directory, "project");
    await run("git", "init", cwd);
    await run("git", "-C", cwd, "remote", "add", "origin", "ssh://git@example.test/first.git");
    const state = new AggregatorState(":memory:");
    const registry = new ProjectRegistry(state);

    const first = await registry.register(cwd);
    await run("git", "-C", cwd, "remote", "set-url", "origin", "git@example.test:owner/second.git");
    const second = await registry.register(cwd);
    expect(second).toMatchObject({
      cwd: realpathSync(cwd),
      cloneUrl: "git@example.test:owner/second.git",
      createdAt: first.createdAt,
    });
    expect(await registry.remove(cwd)).toBe(true);
    expect(registry.list()).toEqual([]);
    state.close();
  });

  test("rejects a subdirectory and a host-local clone source", async () => {
    const directory = temporaryDirectory();
    const cwd = join(directory, "project");
    const nested = join(cwd, "nested");
    await run("git", "init", cwd);
    await run("mkdir", nested);
    await run("git", "-C", cwd, "remote", "add", "origin", join(directory, "remote.git"));
    const state = new AggregatorState(":memory:");
    const registry = new ProjectRegistry(state);

    expect(registry.register(nested)).rejects.toThrow("checkout root");
    expect(registry.register(cwd)).rejects.toThrow("container-reachable Git remote");
    state.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "skizzles-project-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function run(...command: string[]): Promise<void> {
  const process = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `${command[0]} failed`);
}
