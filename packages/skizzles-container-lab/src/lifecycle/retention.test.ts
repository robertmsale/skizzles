import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ContainerLabWorkflow } from "./workflow";
import { runAttachedCommand } from "./attached-workflow";
import type { DockerRunner, DockerSpawnOptions } from "../compose/docker-runner";
import type { CommandResult, RunOptions } from "../execution/process";
import { runCommand } from "../execution/process";
import { ensureOwner, ownerKey, readLab, writeLab } from "../storage/state";
import type { LabMetadata } from "../storage/records";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

class RecordingDocker implements DockerRunner {
  calls: string[][] = [];
  runCalls: Array<{ args: string[]; options?: RunOptions }> = [];
  spawnCalls: Array<{ args: string[]; options?: DockerSpawnOptions }> = [];
  child?: ChildProcessWithoutNullStreams;
  readonly spawned: Promise<void>;
  private resolveSpawned!: () => void;
  model: unknown = { services: { dev: {} } };
  constructor() { this.spawned = new Promise<void>((resolve) => { this.resolveSpawned = resolve; }); }
  async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args); this.runCalls.push({ args, options });
    if (args.includes("config")) return { code: 0, stdout: Buffer.from(JSON.stringify(this.model)), stderr: Buffer.alloc(0) };
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  spawn(args: string[], options?: DockerSpawnOptions): ChildProcessWithoutNullStreams {
    this.calls.push(args); this.spawnCalls.push({ args, options });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
    this.child = child; this.resolveSpawned(); return child;
  }
}

class FailingLogsDocker extends RecordingDocker {
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    if (args.includes("config")) {
      this.calls.push(args); this.runCalls.push({ args, options });
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("docker failed") };
    }
    return await super.run(args, options);
  }
}

describe("Container Lab activity retention", () => {
  test("refreshes a valid lease after a successful status operation", async () => {
    const fixture = await durableFixture("thread-status-lease", "ready", true);
    const fixed = new Date("2026-02-03T04:05:06.000Z");
    const service = new ContainerLabWorkflow(fixture.owner, fixture.roots, new RecordingDocker(), process.env, () => fixed);
    await service.labStatus(fixture.lab.id);
    expect((await readLab(fixture.roots, fixture.owner, fixture.lab.id)).lastActivityAt).toBe(fixed.toISOString());
  });

  test("refreshes successful logs and sync only for the requested lab", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-refresh-matrix-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const fixed = new Date("2026-03-04T05:06:07.000Z");
    const docker = new RecordingDocker();
    const service = new ContainerLabWorkflow("thread-refresh-matrix", roots, docker, process.env, () => fixed);
    const first = await service.createLab("first", source);
    const second = await service.createLab("second", source);
    const firstLab = await readLab(roots, "thread-refresh-matrix", first.labId);
    const secondLab = await readLab(roots, "thread-refresh-matrix", second.labId);
    const old = new Date("2026-01-01T00:00:00.000Z").toISOString();
    firstLab.lastActivityAt = old;
    secondLab.lastActivityAt = old;
    await writeLab(roots, firstLab);
    await writeLab(roots, secondLab);

    await service.logs(first.labId, "dev", 10);
    expect((await readLab(roots, "thread-refresh-matrix", first.labId)).lastActivityAt).toBe(fixed.toISOString());
    expect((await readLab(roots, "thread-refresh-matrix", second.labId)).lastActivityAt).toBe(old);
    const preview = await service.preview(first.labId, "push");
    expect((await readLab(roots, "thread-refresh-matrix", first.labId)).lastActivityAt).toBe(fixed.toISOString());
    await service.apply(first.labId, "push", preview.token);
    expect((await readLab(roots, "thread-refresh-matrix", first.labId)).lastActivityAt).toBe(fixed.toISOString());

    await expect(service.apply(first.labId, "push", "invalid-token")).rejects.toThrow();
    await expect(service.labStatus("missing-lab")).rejects.toThrow();
    await expect(service.run(first.labId, ["true"], ".", { NOT_DECLARED: "value" }, 30, { stdout: () => {}, stderr: () => {} })).rejects.toThrow();
    expect((await readLab(roots, "thread-refresh-matrix", first.labId)).lastActivityAt).toBe(fixed.toISOString());
  });

  test("failed Docker log inspection does not refresh the lease", async () => {
    const fixture = await durableFixture("thread-failed-log-refresh", "ready", true);
    const old = new Date("2026-01-01T00:00:00.000Z").toISOString();
    fixture.lab.lastActivityAt = old;
    await writeLab(fixture.roots, fixture.lab);
    const service = new ContainerLabWorkflow(fixture.owner, fixture.roots, new FailingLogsDocker(), process.env, () => new Date("2026-03-04T05:06:07.000Z"));
    await expect(service.logs(fixture.lab.id, "dev", 10)).rejects.toThrow();
    expect((await readLab(fixture.roots, fixture.owner, fixture.lab.id)).lastActivityAt).toBe(old);
  });

  test("heartbeat refreshes only the requested attached lab and survives persistence failure", async () => {
    const fixture = await durableFixture("thread-run-heartbeat", "ready", true);
    const otherRuntimeRoot = join(fixture.roots.runtimeRoot, fixture.lab.ownerKey, "lab-2");
    const other = { ...fixture.lab, id: "lab-2", runtimeRoot: otherRuntimeRoot, workspace: join(otherRuntimeRoot, "workspace"), runtime: readyRuntime(fixture.lab.sourceRoot, otherRuntimeRoot) };
    await mkdir(other.workspace, { recursive: true });
    await writeFile(join(otherRuntimeRoot, "base.compose.yaml"), "services: {}\n");
    await writeFile(join(otherRuntimeRoot, "override.compose.yaml"), "services: {}\n");
    await writeLab(fixture.roots, other);
    const original = new Date("2026-01-01T00:00:00.000Z").toISOString();
    fixture.lab.lastActivityAt = original;
    other.lastActivityAt = original;
    await writeLab(fixture.roots, fixture.lab);
    await writeLab(fixture.roots, other);
    let now = new Date("2026-01-02T00:00:00.000Z");
    let heartbeat!: () => Promise<void>;
    let heartbeatReadyResolve!: () => void;
    const heartbeatReady = new Promise<void>((resolve) => { heartbeatReadyResolve = resolve; });
    const docker = new RecordingDocker();
    const service = new ContainerLabWorkflow(
      fixture.owner, fixture.roots, docker, process.env, () => now, 1_000,
      (callback) => { heartbeat = callback; heartbeatReadyResolve(); return () => {}; },
    );
    const running = service.run(fixture.lab.id, ["true"], ".", {}, 30, { stdout: () => {}, stderr: () => {} });
    await Promise.all([docker.spawned, heartbeatReady]);
    now = new Date("2026-01-03T00:00:00.000Z");
    await heartbeat();
    expect((await readLab(fixture.roots, fixture.owner, fixture.lab.id)).lastActivityAt).toBe(now.toISOString());
    expect((await readLab(fixture.roots, fixture.owner, other.id)).lastActivityAt).toBe(original);
    Object.assign(docker.child!, { exitCode: 17 });
    docker.child!.emit("close", 17);
    expect(await running).toBe(17);

    const failing = new RecordingDocker();
    let failedHeartbeatReadyResolve!: () => void;
    const failedHeartbeatReady = new Promise<void>((resolve) => { failedHeartbeatReadyResolve = resolve; });
    const runWithFailedRefresh = runAttachedCommand({
      owner: fixture.owner,
      roots: fixture.roots,
      docker: failing,
      processEnvironment: process.env,
      labId: fixture.lab.id,
      argv: ["true"],
      cwd: ".",
      environment: {},
      timeoutSeconds: 30,
      output: { stdout: () => {}, stderr: () => {} },
      activityLock: join(fixture.roots.stateRoot, "owners", fixture.lab.ownerKey, ".locks", `activity-${fixture.lab.id}`),
      labLock: join(fixture.roots.stateRoot, "owners", fixture.lab.ownerKey, ".locks", `lab-${fixture.lab.id}`),
      reconcileOwner: async () => {},
      requireReady: async () => fixture.lab,
      refreshActivity: async () => { throw new Error("state write failed"); },
      activityHeartbeatMs: 1_000,
      startActivityHeartbeat: (callback) => { heartbeat = callback; failedHeartbeatReadyResolve(); return () => {}; },
    });
    await Promise.all([failing.spawned, failedHeartbeatReady]);
    await heartbeat();
    Object.assign(failing.child!, { exitCode: 19 });
    failing.child!.emit("close", 19);
    expect(await runWithFailedRefresh).toBe(19);
  });
});

async function durableFixture(owner: string, state: LabMetadata["state"], createRuntime = false) {
  const root = await mkdtemp(join(tmpdir(), "container-lab-durable-"));
  temporary.push(root);
  const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
  const key = ownerKey(owner);
  const runtimeRoot = join(roots.runtimeRoot, key, "lab-1");
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot, { recursive: true });
  if (createRuntime) {
    await mkdir(join(runtimeRoot, "workspace"), { recursive: true });
    await writeFile(join(sourceRoot, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await writeFile(join(runtimeRoot, "base.compose.yaml"), "services: {}\n");
    await writeFile(join(runtimeRoot, "override.compose.yaml"), "services: {}\n");
  }
  await ensureOwner(roots.stateRoot, owner);
  const lab: LabMetadata = {
    version: 1, id: "lab-1", name: "lab", owner, ownerKey: key, repoHash: "123456789abc",
    composeProject: "ccl-durable", state, sourceRoot, runtimeRoot, workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(sourceRoot, ".codex-container-lab.yaml"), commandService: state === "ready" ? "dev" : "pending",
    modeKind: state === "ready" ? "image" : undefined, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    endpoints: [], findings: [], secretEnvironment: [], runtime: state === "ready" ? readyRuntime(sourceRoot, runtimeRoot) : undefined,
  };
  await writeLab(roots, lab);
  return { root, roots, owner, lab };
}

function readyRuntime(sourceRoot: string, runtimeRoot: string): NonNullable<LabMetadata["runtime"]> {
  const baseFile = join(runtimeRoot, "base.compose.yaml");
  const overrideFile = join(runtimeRoot, "override.compose.yaml");
  return {
    config: { repoRoot: sourceRoot, manifestPath: join(sourceRoot, ".codex-container-lab.yaml"), mode: { kind: "image", image: "node:24", commandService: "dev" }, runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] }, ports: [], forwardEnvironment: [], secretEnvironment: [] },
    composeArgs: ["compose", "--project-directory", sourceRoot, "--project-name", "ccl-durable", "-f", baseFile, "-f", overrideFile],
    baseFile, overrideFile, findings: [],
  };
}
