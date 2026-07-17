import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOwner, ownerKey, writeLab } from "./state";
import type { LabMetadata } from "./types";
import { runCommand } from "./process";
import { withFileLock } from "./locks";
import { serializePublicJson } from "./cli";
import { initializeSyncBaseline } from "./sync";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("CLI process boundary", () => {
  test("real public serialization clips worst-case escaped transcripts to 16 KiB", () => {
    const encoded = serializePublicJson({ labId: "lab-1", service: "dev", transcript: {
      text: '\\"'.repeat(8 * 1024), bytes: 16 * 1024, lines: 1, truncated: false,
    } });
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(16 * 1024);
    const parsed = JSON.parse(encoded);
    expect(parsed.transcript.truncated).toBe(true);
    expect(parsed.transcript.bytes).toBeLessThanOrEqual(8 * 1024);
  });
  test("reads durable lab state from a fresh Bun process and emits one JSON value", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-cli-"));
    temporary.push(root);
    const stateRoot = join(root, "state");
    const runtimeRoot = join(root, "runtime");
    const owner = "thread-process";
    await ensureOwner(stateRoot, owner);
    await writeLab({ stateRoot, runtimeRoot }, fixtureLab(root, owner));
    const processResult = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "cli.ts"),
      "--owner", owner,
      "--state-root", stateRoot,
      "--runtime-root", runtimeRoot,
      "lab", "list",
    ], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
      processResult.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as { labs: Array<{ labId: string; state: string }> };
    expect(parsed.labs).toHaveLength(1);
    expect(parsed.labs[0]?.labId).toBe("lab-1");
    expect(stdout).not.toContain(owner);
    expect(stdout).not.toContain("ownerKey");
    expect(stdout).not.toContain("runtimeRoot");
  });

  test("status serializes a compact redacted DTO under the public byte ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-status-"));
    temporary.push(root);
    const owner = "thread-status";
    const stateRoot = join(root, "state");
    const runtimeRoot = join(root, "runtime");
    const lab = fixtureLab(root, owner);
    lab.error = `failure under ${lab.runtimeRoot}/private`;
    lab.findings = Array.from({ length: 64 }, () => ({ surface: "host-bind", detail: "host path redacted" }));
    await ensureOwner(stateRoot, owner);
    await writeLab({ stateRoot, runtimeRoot }, lab);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "--owner", owner,
      "--state-root", stateRoot, "--runtime-root", runtimeRoot, "lab", "status", "--lab", lab.id], { stdout: "pipe", stderr: "pipe" });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(16 * 1024);
    const parsed = JSON.parse(stdout);
    expect(Object.keys(parsed).sort()).toEqual(["error", "findingCount", "findings", "labId", "name", "state", "updatedAt"]);
    expect(parsed.findings).toHaveLength(12);
    expect(parsed.findingCount).toBe(64);
    for (const forbidden of [owner, lab.ownerKey, lab.runtimeRoot, "ownerKey", "composeArgs", "managedImage"]) expect(stdout).not.toContain(forbidden);
  });

  test("refuses to invent an owner when neither override nor CODEX_THREAD_ID exists", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "lab", "list"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).not.toBe(0);
    expect(JSON.parse(stderr).error.message).toContain("owner is required");
  });

  test("sync preview fails closed before persisting a token when 100 visible long paths exceed the public budget", async () => {
    const fixture = await oversizedPreviewFixture();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "--owner", fixture.owner,
      "--state-root", fixture.stateRoot, "--runtime-root", fixture.runtimeRoot,
      "sync", "preview", "--lab", "lab-1", "--direction", "push"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(16 * 1024);
    const diagnostic = JSON.parse(stderr) as { error: { code: string; message: string } };
    expect(diagnostic.error).toEqual({
      code: "OPERATION_FAILED",
      message: "Synchronization preview cannot be exposed within the 16 KiB public output budget; reduce the change set before applying",
    });
    expect(await readdir(join(fixture.lab.runtimeRoot, "sync", "lab-1", "previews"))).toEqual([]);
  });

  test("run streams before exit and propagates the attached exit code without a JSON footer", async () => {
    const fixture = await attachedFixture();
    const child = spawnRun(fixture, { FAKE_EXIT: "23" });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("early-output");
    expect(await child.exited).toBe(23);
    expect(await drain(reader)).not.toContain("{\"");
    expect(await new Response(child.stderr).text()).toContain("early-error");
  });

  test("SIGINT performs exact attached process-group cleanup and exits 130", async () => {
    const fixture = await attachedFixture();
    const child = spawnRun(fixture);
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("early-output");
    const pid = Number((await waitForFile(fixture.pidPath)).trim());
    const descendant = Number((await waitForFile(fixture.descendantPath)).trim());
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    await drain(reader);
    expect(await waitForProcessExit(pid)).toBe(true);
    expect(await waitForProcessExit(descendant)).toBe(true);
  });

  test("SIGTERM performs exact attached process-group cleanup and exits 143", async () => {
    const fixture = await attachedFixture();
    const child = spawnRun(fixture);
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("early-output");
    const pid = Number((await waitForFile(fixture.pidPath)).trim());
    const descendant = Number((await waitForFile(fixture.descendantPath)).trim());
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    await drain(reader);
    expect(await waitForProcessExit(pid)).toBe(true);
    expect(await waitForProcessExit(descendant)).toBe(true);
  });

  test("timeout performs exact attached process-group cleanup and exits 124", async () => {
    const fixture = await attachedFixture();
    const child = spawnRun(fixture, {}, 1);
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("early-output");
    const pid = Number((await waitForFile(fixture.pidPath)).trim());
    const descendant = Number((await waitForFile(fixture.descendantPath)).trim());
    expect(await child.exited).toBe(124);
    await drain(reader);
    expect(await waitForProcessExit(pid)).toBe(true);
    expect(await waitForProcessExit(descendant)).toBe(true);
  });

  test("SIGINT cancels promptly while waiting for another attached activity", async () => {
    const fixture = await attachedFixture();
    const activity = join(fixture.stateRoot, "owners", ownerKey(fixture.owner), ".locks", "activity-lab-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withFileLock(activity, async () => await gate);
    await Bun.sleep(20);
    const child = spawnRun(fixture);
    await Bun.sleep(100);
    child.kill("SIGINT");
    const exit = await Promise.race([child.exited, Bun.sleep(2_000).then(() => -1)]);
    release();
    await held;
    expect(exit).toBe(130);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await Bun.file(fixture.pidPath).exists()).toBe(false);
  });

  test("LaunchAgent uses absolute Bun and reaper paths and is valid plist XML", async () => {
    const path = join(import.meta.dir, "..", "install", "com.openai.codex-container-lab-reaper.plist");
    const source = await readFile(path, "utf8");
    expect(source).toContain("<string>__BUN_ABSOLUTE_PATH__</string>");
    expect(source).toContain("<string>__REAPER_ABSOLUTE_PATH__</string>");
    expect(source.indexOf("__BUN_ABSOLUTE_PATH__")).toBeLessThan(source.indexOf("__REAPER_ABSOLUTE_PATH__"));
    expect(source).not.toContain("/usr/bin/env");
    expect((await runCommand("/usr/bin/plutil", ["-lint", path])).stdout.toString()).toContain("OK");
  });
});

function fixtureLab(root: string, owner: string): LabMetadata {
  const key = ownerKey(owner);
  const runtimeRoot = join(root, "runtime", key, "lab-1");
  return {
    version: 1,
    id: "lab-1",
    name: "lab",
    owner,
    ownerKey: key,
    repoHash: "123456789abc",
    composeProject: "ccl-process",
    state: "failed",
    sourceRoot: join(root, "source"),
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(root, "source", ".codex-container-lab.yaml"),
    commandService: "dev",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    endpoints: [],
    findings: [],
    secretEnvironment: [],
  };
}

async function oversizedPreviewFixture() {
  const root = await mkdtemp(join(tmpdir(), "container-lab-sync-preview-cli-"));
  temporary.push(root);
  const owner = "thread-sync-preview";
  const stateRoot = join(root, "state");
  const runtimeRoot = join(root, "runtime");
  const lab = fixtureLab(root, owner);
  lab.state = "ready";
  lab.modeKind = "image";
  await mkdir(lab.sourceRoot, { recursive: true });
  await mkdir(lab.workspace, { recursive: true });
  for (const repository of [lab.sourceRoot, lab.workspace]) {
    execFileSync("git", ["init", "-q", repository]);
    await writeFile(join(repository, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
  }
  const commonGit = execFileSync("git", ["-C", lab.sourceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  lab.repoHash = createHash("sha256").update(await realpath(commonGit)).digest("hex").slice(0, 12);
  const baseFile = join(lab.runtimeRoot, "base.compose.yaml");
  const overrideFile = join(lab.runtimeRoot, "override.compose.yaml");
  await writeFile(baseFile, "services: {}\n");
  await writeFile(overrideFile, "services: {}\n");
  lab.runtime = {
    config: { repoRoot: lab.sourceRoot, manifestPath: lab.manifestPath, mode: { kind: "image", image: "node:24", commandService: "dev" }, runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] }, ports: [], forwardEnvironment: [], secretEnvironment: [] },
    composeArgs: ["compose", "--project-directory", lab.sourceRoot, "--project-name", lab.composeProject, "-f", baseFile, "-f", overrideFile],
    baseFile, overrideFile, findings: [],
  };
  await ensureOwner(stateRoot, owner);
  await writeLab({ stateRoot, runtimeRoot }, lab);
  await initializeSyncBaseline({ stateRoot: lab.runtimeRoot, labId: lab.id }, lab.workspace);
  for (let index = 0; index < 100; index++) {
    const pathname = `${String(index).padStart(3, "0")}-${"x".repeat(220)}`;
    await writeFile(join(lab.sourceRoot, pathname), "updated\n");
  }
  return { owner, stateRoot, runtimeRoot, lab };
}

async function attachedFixture() {
  const root = await mkdtemp(join(tmpdir(), "container-lab-run-cli-"));
  temporary.push(root);
  const owner = "thread-attached-run";
  const stateRoot = join(root, "state");
  const runtimeRoot = join(root, "runtime");
  const lab = fixtureLab(root, owner);
  lab.state = "ready";
  lab.modeKind = "image";
  const baseFile = join(lab.runtimeRoot, "base.compose.yaml");
  const overrideFile = join(lab.runtimeRoot, "override.compose.yaml");
  await mkdir(lab.workspace, { recursive: true });
  await mkdir(lab.sourceRoot, { recursive: true });
  await writeFile(lab.manifestPath, "image: { name: node:24, service: dev }\n");
  await writeFile(baseFile, "services: {}\n");
  await writeFile(overrideFile, "services: {}\n");
  lab.runtime = {
    config: { repoRoot: lab.sourceRoot, manifestPath: lab.manifestPath, mode: { kind: "image", image: "node:24", commandService: "dev" }, runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] }, ports: [], forwardEnvironment: [], secretEnvironment: [] },
    composeArgs: ["compose", "--project-directory", lab.sourceRoot, "--project-name", lab.composeProject, "-f", baseFile, "-f", overrideFile],
    baseFile, overrideFile, findings: [],
  };
  await ensureOwner(stateRoot, owner);
  await writeLab({ stateRoot, runtimeRoot }, lab);
  const bin = join(root, "bin");
  await mkdir(bin);
  const dockerPath = join(bin, "docker");
  const pidPath = join(root, "run.pid");
  const descendantPath = join(root, "descendant.pid");
  await writeFile(dockerPath, `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst joined = args.join(" ");\nconst pidPath = process.env.FAKE_PID_FILE;\nif (joined.includes("termination_result()")) {\n  let pid; try { pid = Number((await Bun.file(pidPath).text()).trim()); } catch { console.log("codex-container-lab-termination:unavailable"); process.exit(0); }\n  const signal = joined.includes("kill -INT") ? "SIGINT" : joined.includes("kill -TERM") ? "SIGTERM" : "SIGKILL";\n  try { process.kill(-pid, signal); console.log("codex-container-lab-termination:signaled"); } catch { console.log("codex-container-lab-termination:absent"); }\n  process.exit(0);\n}\nconsole.log("early-output"); console.error("early-error");\nif (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));\nconst running = Bun.spawn(["/bin/sh", "-c", "trap 'exit 130' INT; trap 'exit 143' TERM; (trap '' INT TERM; while :; do sleep 1; done) & echo $! > $FAKE_DESC_FILE; while :; do sleep 1; done"], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" });\nawait Bun.write(pidPath, String(running.pid));\nconst code = await running.exited;\ntry { process.kill(-running.pid, "SIGTERM"); } catch {}\nawait Bun.sleep(100);\ntry { process.kill(-running.pid, 0); process.kill(-running.pid, "SIGKILL"); } catch {}\nfor (let i=0;i<100;i++) { try { process.kill(-running.pid, 0); await Bun.sleep(10); } catch { break; } }\nprocess.exit(code);\n`);
  await chmod(dockerPath, 0o755);
  return { root, owner, stateRoot, runtimeRoot, pidPath, descendantPath, bin };
}

function spawnRun(fixture: Awaited<ReturnType<typeof attachedFixture>>, extra: Record<string, string> = {}, timeoutSeconds?: number) {
  return Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "--owner", fixture.owner,
    "--state-root", fixture.stateRoot, "--runtime-root", fixture.runtimeRoot,
    "run", "--lab", "lab-1", ...(timeoutSeconds === undefined ? [] : ["--timeout-seconds", String(timeoutSeconds)]), "--", "echo", "hello"], {
    stdout: "pipe", stderr: "pipe", stdin: "pipe",
    env: { ...process.env, ...extra, PATH: `${fixture.bin}:${process.env.PATH ?? ""}`, FAKE_PID_FILE: fixture.pidPath, FAKE_DESC_FILE: fixture.descendantPath },
  });
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let output = "";
  for (;;) { const next = await reader.read(); if (next.done) return output; output += new TextDecoder().decode(next.value); }
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await Bun.file(path).text(); } catch { await Bun.sleep(10); }
  }
  throw new Error("fixture PID was not published");
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!processExists(pid)) return true;
    await Bun.sleep(10);
  }
  return false;
}
