import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ContainerLabService } from "./service";
import { PROVISIONING_FAILURE_DIAGNOSTIC_FILE, type DockerRunner, type DockerSpawnOptions } from "./docker";
import type { CommandResult, RunOptions } from "./process";
import { runCommand } from "./process";
import { ensureOwner, labManifestPath, ownerKey, readLab, writeLab } from "./state";
import type { LabMetadata } from "./types";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

class RecordingDocker implements DockerRunner {
  calls: string[][] = [];
  runCalls: Array<{ args: string[]; options?: RunOptions }> = [];
  spawnCalls: Array<{ args: string[]; options?: DockerSpawnOptions }> = [];
  child?: ChildProcessWithoutNullStreams;
  model: unknown = { services: { dev: {} } };
  async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    this.runCalls.push({ args, options });
    if (args.includes("config")) return { code: 0, stdout: Buffer.from(JSON.stringify(this.model)), stderr: Buffer.alloc(0) };
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  spawn(args: string[], options?: DockerSpawnOptions): ChildProcessWithoutNullStreams {
    this.calls.push(args);
    this.spawnCalls.push({ args, options });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
    this.child = child;
    return child;
  }
}

class SecretDiagnosticDocker extends RecordingDocker {
  constructor(private readonly sentinel: string) { super(); }
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    if (args.includes("config")) {
      this.calls.push(args);
      this.runCalls.push({ args, options });
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(`secret diagnostic: ${this.sentinel}`) };
    }
    return await super.run(args, options);
  }
}

class InterruptingDocker extends RecordingDocker {
  constructor(private readonly controller: AbortController) { super(); }
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    if (args.includes("up")) {
      this.calls.push(args);
      this.controller.abort("SIGTERM");
      throw new Error("docker compose up aborted");
    }
    return await super.run(args, options);
  }
}

class DestructiveDocker extends RecordingDocker {
  private listed = false;
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    if (args[0] === "ps" && args[1] === "-aq" && !this.listed) {
      this.listed = true;
      return { code: 0, stdout: Buffer.from("container-1\n"), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "rm" && args[1] === "-f") {
      Object.assign(this.child!, { exitCode: 137 });
      this.child!.emit("close", 137);
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

class ComposeFailureServiceDocker extends RecordingDocker {
  constructor(private readonly sentinel: string, private readonly exitCode = 23, private readonly failureText?: string) { super(); }
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    this.runCalls.push({ args, options });
    if (args.includes("config")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify({ services: { dev: {} } })), stderr: Buffer.alloc(0) };
    }
    if (args.includes("up")) {
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(this.failureText ?? `Compose failed ${this.sentinel} /private/tmp/project`) };
    }
    if (args.includes("ps") && args.includes("--all")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify([
        { Service: "dev", State: "exited", Health: "unhealthy", ExitCode: this.exitCode, ID: "private-container-id", Project: "ccl-private" },
      ])), stderr: Buffer.alloc(0) };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

class LargeComposeFailureServiceDocker extends RecordingDocker {
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    this.runCalls.push({ args, options });
    if (args.includes("config")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify({ services: { dev: {} } })), stderr: Buffer.alloc(0) };
    }
    if (args.includes("up")) {
      const script = [
        "const { writeSync } = require('node:fs');",
        "const prefix = 'BUILD_EXPORT_PREFIX\\n'.repeat(300_000);",
        "writeSync(1, prefix);",
        "writeSync(2, prefix);",
        "writeSync(2, '\\nTERMINAL_DEV_EXIT_17\\nTERMINAL_COMPOSE_FAILURE_DEV\\n');",
        "process.exitCode = 1;",
      ].join(" ");
      return await runCommand(process.execPath, ["-e", script], options);
    }
    if (args.includes("ps") && args.includes("--all")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify([
        { Service: "dev", State: "exited", ExitCode: 17 },
      ])), stderr: Buffer.alloc(0) };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

class ServiceLogsDocker extends RecordingDocker {
  constructor(
    private readonly statuses: unknown[],
    private readonly logs: Record<string, string | CommandResult | Error | ((options?: RunOptions) => CommandResult)>,
    private readonly modelServices: string[] = ["dev"],
    private readonly lifecycle = "LIFECYCLE_MARKER",
  ) { super(); }
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    this.runCalls.push({ args, options });
    if (args.includes("config")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify({
        services: Object.fromEntries(this.modelServices.map((service) => [service, {}])),
      })), stderr: Buffer.alloc(0) };
    }
    if (args.includes("up")) {
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(this.lifecycle) };
    }
    if (args.includes("ps") && args.includes("--all")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify(this.statuses)), stderr: Buffer.alloc(0) };
    }
    if (args.includes("logs")) {
      const service = args.at(-1)!;
      const log = this.logs[service] ?? "";
      if (log instanceof Error) throw log;
      if (typeof log === "function") {
        const result = log(options);
        return {
          ...result,
          stdout: result.stdoutTruncated === true ? result.stdout : Buffer.from(frameComposeLog(service, result.stdout.toString())),
          stderr: result.stderrTruncated === true ? result.stderr : Buffer.from(frameComposeLog(service, result.stderr.toString())),
        };
      }
      if (typeof log === "string") return { code: 0, stdout: Buffer.from(frameComposeLog(service, log)), stderr: Buffer.alloc(0) };
      return {
        ...log,
        stdout: log.stdoutTruncated === true ? log.stdout : Buffer.from(frameComposeLog(service, log.stdout.toString())),
        stderr: log.stderrTruncated === true ? log.stderr : Buffer.from(frameComposeLog(service, log.stderr.toString())),
      };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

class ReadyServiceLogsDocker extends RecordingDocker {
  constructor(private readonly log: string) { super(); }
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    if (args.includes("logs")) {
      this.calls.push(args);
      this.runCalls.push({ args, options });
      return { code: 0, stdout: Buffer.from(frameComposeLog("dev", this.log)), stderr: Buffer.alloc(0) };
    }
    return await super.run(args, options);
  }
}

function frameComposeLog(service: string, value: string): string {
  const timestamp = "2026-08-08T00:00:00.000000000Z";
  return value.split("\n").map((line) => `${timestamp} ${line}`).join("\n");
}

describe("attached service lifecycle", () => {
  test("public service logs use the configured secret environment for redaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-ready-service-logs-"));
    temporary.push(root);
    const source = join(root, "source");
    const secret = "ready-service-log-secret-8f31";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ReadyServiceLogsDocker(`secret=${secret} path=/Users/robertsale/Library/Application Support/Codex\n`);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-ready-service-logs", roots, docker, {
      PATH: process.env.PATH,
      REGISTRY_TOKEN: secret,
    });

    const created = await service.createLab("ready-service-logs", source);
    expect(created.state).toBe("ready");
    const response = await service.logs(created.labId, "dev", 4) as {
      labId: string;
      service: string;
      transcript: { text: string; bytes: number; lines: number; truncated: boolean };
    };
    expect(response.labId).toBe(created.labId);
    expect(response.service).toBe("dev");
    expect(response.transcript.text).toContain("[path]");
    expect(response.transcript.text).not.toContain(secret);
    expect(response.transcript.text).not.toContain("/Users/robertsale/Library/Application Support/Codex");
    expect(response.transcript.bytes).toBe(Buffer.byteLength(response.transcript.text));
    expect(response.transcript.lines).toBe(response.transcript.text.split("\n").length);
    await service.destroyLab(created.labId);
  });

  test("create provisions synchronously and returns only lab identity and terminal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-create-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const result = await new ContainerLabService("thread-create", roots, new RecordingDocker()).createLab("experiment", source);
    expect(Object.keys(result).sort()).toEqual(["labId", "state"]);
    expect(result.state).toBe("ready");
    expect((await readLab(roots, "thread-create", result.labId)).state).toBe("ready");
  });

  test("persists only secret names and never exposes the provisioning value", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-create-"));
    temporary.push(root);
    const source = join(root, "source");
    const sentinel = "sentinel-service-token-c89fd0";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new RecordingDocker();
    docker.model = {
      services: { dev: {} },
      secrets: { registry: { environment: "REGISTRY_TOKEN" } },
    };
    const service = new ContainerLabService("thread-secret", roots, docker, {
      PATH: process.env.PATH,
      REGISTRY_TOKEN: sentinel,
    });

    const created = await service.createLab("secret", source);
    expect(created.state).toBe("ready");
    const lab = await readLab(roots, "thread-secret", created.labId);
    expect(lab.secretEnvironment).toEqual(["REGISTRY_TOKEN"]);
    expect(lab.runtime?.config.secretEnvironment).toEqual(["REGISTRY_TOKEN"]);
    expect(JSON.stringify(lab)).not.toContain(sentinel);
    expect(readFileSync(labManifestPath(roots.stateRoot, lab.owner, lab.id), "utf8")).not.toContain(sentinel);
    expect(readFileSync(lab.runtime!.baseFile!, "utf8")).not.toContain(sentinel);
    expect(readFileSync(lab.runtime!.overrideFile, "utf8")).not.toContain(sentinel);
    expect(JSON.stringify(await service.labStatus(lab.id))).not.toContain(sentinel);

    const carryingSecret = docker.runCalls.filter((call) => call.options?.env?.REGISTRY_TOKEN === sentinel);
    expect(carryingSecret.length).toBeGreaterThanOrEqual(3);
    expect(carryingSecret.every((call) => call.args.includes("config") || call.args.includes("up"))).toBe(true);
    expect(docker.calls.every((args) => !args.includes(sentinel))).toBe(true);
  });

  test("fails before Docker when a declared secret environment value is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-missing-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [MISSING_TOKEN]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new RecordingDocker();
    const service = new ContainerLabService("thread-secret-missing", roots, docker, { PATH: process.env.PATH });

    const created = await service.createLab("secret", source);
    const lab = await readLab(roots, "thread-secret-missing", created.labId);
    expect(lab.state).toBe("failed");
    expect(lab.secretEnvironment).toEqual(["MISSING_TOKEN"]);
    expect(lab.error).toBe("secret environment variable is unavailable: MISSING_TOKEN");
    expect(docker.calls).toEqual([]);
  });

  test("persists a fixed redacted error when Compose echoes a secret value", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-failure-"));
    temporary.push(root);
    const source = join(root, "source");
    const sentinel = "sentinel-persisted-error-d3c116";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new SecretDiagnosticDocker(sentinel);
    const service = new ContainerLabService("thread-secret-failure", roots, docker, {
      PATH: process.env.PATH,
      REGISTRY_TOKEN: sentinel,
    });

    const created = await service.createLab("secret", source);
    const lab = await readLab(roots, "thread-secret-failure", created.labId);
    expect(lab.state).toBe("failed");
    expect(lab.error).toBe("Docker Compose configuration failed; secret-bearing diagnostics redacted");
    expect(JSON.stringify(lab)).not.toContain(sentinel);
    expect(JSON.stringify(await service.labStatus(lab.id))).not.toContain(sentinel);
    await service.destroyLab(lab.id);
    for (const call of docker.runCalls.filter((call) => !call.args.includes("config") && !call.args.includes("up"))) {
      expect(Object.hasOwn(call.options?.env ?? {}, "REGISTRY_TOKEN")).toBe(false);
    }
  });

  test("persists failed Compose evidence, serves it across service instances, and removes it on destroy", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-failed-diagnostic-"));
    temporary.push(root);
    const source = join(root, "source");
    const sentinel = "sentinel-failed-compose-7b22";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new ComposeFailureServiceDocker(sentinel);
    const service = new ContainerLabService("thread-failed-diagnostic", roots, docker, {
      PATH: process.env.PATH,
      REGISTRY_TOKEN: sentinel,
    });

    const created = await service.createLab("failed", source);
    expect(Object.keys(created).sort()).toEqual(["labId", "state"]);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-failed-diagnostic", created.labId);
    expect(lab.provisioningFailure).toMatchObject({
      phase: "compose-up",
      services: [{ service: "dev", state: "exited", health: "unhealthy", exitCode: 23 }],
    });
    const status = JSON.stringify(await service.labStatus(created.labId));
    expect(status).toContain("provisioningFailure");
    expect(status).toContain("exited");
    for (const forbidden of [sentinel, "/private/tmp", "ccl-private", "private-container-id", lab.ownerKey, lab.runtimeRoot]) {
      expect(status).not.toContain(forbidden);
    }
    expect(Buffer.byteLength(status)).toBeLessThanOrEqual(16 * 1024);
    const artifact = join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE);
    expect(lab.provisioningFailure?.evidence?.available).toBe(true);
    expect(await Bun.file(artifact).exists()).toBe(true);

    const fresh = new ContainerLabService("thread-failed-diagnostic", roots, docker, { PATH: process.env.PATH });
    const diagnostic = JSON.stringify(await fresh.diagnostic(created.labId));
    expect(diagnostic).toContain('"phase":"compose-up"');
    expect(diagnostic).toContain("exited");
    expect(diagnostic).not.toContain(sentinel);
    expect(diagnostic).not.toContain("/private/tmp");
    expect(diagnostic).not.toContain(lab.runtimeRoot);
    expect(diagnostic).not.toContain(PROVISIONING_FAILURE_DIAGNOSTIC_FILE);
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(16 * 1024);

    await expect(new ContainerLabService("another-owner", roots, docker).diagnostic(created.labId)).rejects.toThrow();
    expect((await fresh.destroyLab(created.labId)).destroyed).toBe(true);
    expect(await Bun.file(artifact).exists()).toBe(false);
    await expect(readLab(roots, "thread-failed-diagnostic", created.labId)).rejects.toThrow();
  });

  test("retains terminal Compose failure lines after the upstream output cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-terminal-diagnostic-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new LargeComposeFailureServiceDocker();
    const service = new ContainerLabService("thread-terminal-diagnostic", roots, docker, { PATH: process.env.PATH });

    const created = await service.createLab("terminal", source);
    expect(created.state).toBe("failed");
    const up = docker.runCalls.find((call) => call.args.includes("up"));
    expect(up?.options).toMatchObject({
      maxOutputBytes: 4 * 1024 * 1024,
      stdoutCapture: "tail",
      stderrCapture: "tail",
    });
    const lab = await readLab(roots, "thread-terminal-diagnostic", created.labId);
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, truncated: true });
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toContain("TERMINAL_DEV_EXIT_17");
    expect(artifact).toContain("TERMINAL_COMPOSE_FAILURE_DEV");
    expect(Buffer.byteLength(artifact)).toBeLessThanOrEqual(8 * 1024);
    expect(artifact.split("\n").length).toBeLessThanOrEqual(500);

    const status = JSON.stringify(await service.labStatus(created.labId));
    expect(status).toContain('"truncated":true');
    expect(status).not.toContain(lab.runtimeRoot);
    const diagnostic = JSON.stringify(await service.diagnostic(created.labId));
    expect(diagnostic).toContain("TERMINAL_COMPOSE_FAILURE_DEV");
    expect(diagnostic).toContain("TERMINAL_DEV_EXIT_17");
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(16 * 1024);
    await service.destroyLab(created.labId);
  });

  test("combines lifecycle and failed-service logs while excluding healthy, exit-zero, and unexposed services", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-selection-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }
ports:
  api: { service: api, target: 8080 }
`);
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const statuses = [
      { Service: "dev", State: "exited", ExitCode: 17 },
      { Service: "api", State: "running", Health: "healthy", ExitCode: 0 },
      { Service: "exit-zero", State: "exited", ExitCode: 0 },
      { Service: "database", State: "exited", ExitCode: 17 },
    ];
    const docker = new ServiceLogsDocker(statuses, {
      dev: "MIGRATION_ERROR_MARKER",
      api: "HEALTHY_SERVICE_MARKER",
      database: "UNEXPOSED_SIDECAR_MARKER",
    }, ["dev", "api"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-selection", roots, docker);

    const created = await service.createLab("service-logs", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-selection", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toContain("--- compose-up ---");
    expect(artifact).toContain("LIFECYCLE_MARKER");
    expect(artifact).toContain("--- service:dev ---");
    expect(artifact).toContain("MIGRATION_ERROR_MARKER");
    expect(artifact).not.toContain("HEALTHY_SERVICE_MARKER");
    expect(artifact).not.toContain("UNEXPOSED_SIDECAR_MARKER");
    const logsCalls = docker.runCalls.filter((call) => call.args.includes("logs"));
    expect(logsCalls.map((call) => call.args.at(-1))).toEqual(["dev"]);
    const logsArgs = logsCalls[0]!.args;
    const logsIndex = logsArgs.indexOf("logs");
    expect(logsArgs.slice(logsIndex)).toEqual(["logs", "--no-color", "--timestamps", "--no-log-prefix", "--tail", "374", "dev"]);
    expect(lab.provisioningFailure?.services).toEqual([
      { service: "dev", state: "exited", exitCode: 17 },
      { service: "api", state: "running", health: "healthy", exitCode: 0 },
      { service: "exit-zero", state: "exited", exitCode: 0 },
      { service: "database", state: "exited", exitCode: 17 },
    ]);
    const diagnostic = JSON.stringify(await service.diagnostic(created.labId));
    expect(diagnostic).toContain("MIGRATION_ERROR_MARKER");
    expect(diagnostic).not.toContain("HEALTHY_SERVICE_MARKER");
    await service.destroyLab(created.labId);
  });

  test("keeps safe service evidence when a secret equals the trusted service name", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-header-secret-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [LAB_SECRET]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
      dev: "SAFE_BODY_MARKER",
    }, ["dev"], "SAFE_LIFECYCLE_MARKER");
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-header-secret", roots, docker, {
      PATH: process.env.PATH,
      LAB_SECRET: "dev",
    });

    const created = await service.createLab("header-secret", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-header-secret", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toContain("--- service:dev ---");
    expect(artifact).toContain("SAFE_BODY_MARKER");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: expect.any(Number) });
    await service.destroyLab(created.labId);
  });

  test("redacts a service-body secret without treating its trusted header as a leak", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-body-secret-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [LAB_SECRET]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
      dev: "BODY_dev_MARKER",
    }, ["dev"], "SAFE_LIFECYCLE_MARKER");
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-body-secret", roots, docker, {
      PATH: process.env.PATH,
      LAB_SECRET: "dev",
    });

    const created = await service.createLab("body-secret", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-body-secret", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    const body = artifact.slice(artifact.indexOf("--- service:dev ---") + "--- service:dev ---".length);
    expect(artifact).toContain("--- service:dev ---");
    expect(artifact).toContain("[secret-value-redacted]");
    expect(body).not.toContain("dev");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true });
    await service.destroyLab(created.labId);
  });

  test("erases the artifact when service-body control sanitization recreates a declared secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-control-secret-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [TOKEN_REPLACEMENT]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
      dev: "\u0001",
    }, ["dev"], "SAFE_LIFECYCLE_MARKER");
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-control-secret", roots, docker, {
      PATH: process.env.PATH,
      TOKEN_REPLACEMENT: "�",
    });

    const created = await service.createLab("control-secret", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-control-secret", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toBe("");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0 });
    await service.destroyLab(created.labId);
  });

  test("checks body and framing provenance for boundary, one-character, and newline secrets", async () => {
    const scenarios = [
      { name: "one-character-frame", secret: "d", body: "SAFE_BODY_MARKER", empty: false },
      { name: "newline-frame", secret: "\n", body: "SAFE_BODY_MARKER", empty: true },
      { name: "one-character-body", secret: "d", body: "BODY_d_MARKER", empty: true },
      { name: "newline-body", secret: "\n", body: "BODY\nMARKER", empty: true },
      { name: "mixed-boundary", secret: "-\nS", body: "SAFE_BODY_MARKER", empty: true },
    ];
    for (const scenario of scenarios) {
      const root = await mkdtemp(join(tmpdir(), `container-lab-service-log-${scenario.name}-`));
      temporary.push(root);
      const source = join(root, "source");
      await runCommand("git", ["init", source]);
      await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [LAB_SECRET]\n");
      await runCommand("git", ["-C", source, "add", "."]);
      await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
      const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
        dev: scenario.body,
      }, ["dev"], "SAFE_LIFECYCLE_MARKER");
      const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
      const owner = `thread-service-log-${scenario.name}`;
      const service = new ContainerLabService(owner, roots, docker, {
        PATH: process.env.PATH,
        LAB_SECRET: scenario.secret,
      });

      const created = await service.createLab(`service-${scenario.name}`, source);
      expect(created.state).toBe("failed");
      const lab = await readLab(roots, owner, created.labId);
      const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
      if (scenario.empty) {
        expect(artifact).toBe("");
        expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0 });
      } else {
        const header = "--- service:dev ---";
        expect(artifact).toContain(header);
        const body = artifact.slice(artifact.indexOf(header) + header.length).replace(/^\n/, "");
        expect(body).not.toContain(scenario.secret);
      }
      await service.destroyLab(created.labId);
    }
  });

  test("erases a secret reconstructed from lifecycle body into service framing", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-lifecycle-boundary-"));
    temporary.push(root);
    const source = join(root, "source");
    const secret = "END\n--- service:dev ---";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [LAB_SECRET]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
      dev: "SAFE_SERVICE_MARKER",
    }, ["dev"], "END");
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-lifecycle-boundary", roots, docker, {
      PATH: process.env.PATH,
      LAB_SECRET: secret,
    });

    const created = await service.createLab("lifecycle-boundary", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-lifecycle-boundary", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toBe("");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0 });
    await service.destroyLab(created.labId);
  });

  test("erases a secret reconstructed from one service body into the next service framing", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-service-boundary-"));
    temporary.push(root);
    const source = join(root, "source");
    const secret = "END\n--- service:api ---";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }
ports:
  api: { service: api, target: 8080 }
secret_environment: [LAB_SECRET]
`);
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([
      { Service: "dev", State: "exited", ExitCode: 17 },
      { Service: "api", State: "exited", ExitCode: 23 },
    ], {
      dev: "END",
      api: "SAFE_API_MARKER",
    }, ["dev", "api"], "SAFE_LIFECYCLE_MARKER");
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-service-boundary", roots, docker, {
      PATH: process.env.PATH,
      LAB_SECRET: secret,
    });

    const created = await service.createLab("service-boundary", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-service-boundary", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toBe("");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0 });
    await service.destroyLab(created.labId);
  });

  test("captures unhealthy manifest services even with a zero or absent exit code", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-unhealthy-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }
ports:
  api: { service: api, target: 8080 }
  worker: { service: worker, target: 8081 }
`);
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([
      { Service: "dev", State: "running", Health: "healthy", ExitCode: 0 },
      { Service: "api", State: "running", Health: "unhealthy", ExitCode: 0 },
      { Service: "worker", State: "running", Health: "unhealthy" },
    ], {
      api: "UNHEALTHY_ZERO_EXIT_MARKER",
      worker: "UNHEALTHY_MISSING_EXIT_MARKER",
    }, ["dev", "api", "worker"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-unhealthy", roots, docker);

    const created = await service.createLab("service-unhealthy", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-unhealthy", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toContain("UNHEALTHY_ZERO_EXIT_MARKER");
    expect(artifact).toContain("UNHEALTHY_MISSING_EXIT_MARKER");
    expect(docker.runCalls.filter((call) => call.args.includes("logs")).map((call) => call.args.at(-1))).toEqual(["api", "worker"]);
    await service.destroyLab(created.labId);
  });

  test("selects a manifest service when any duplicate status row is terminally failed", async () => {
    const scenarios = [
      {
        name: "failing-first",
        statuses: [
          { Service: "dev", State: "exited", ExitCode: 17 },
          { Service: "dev", State: "running", Health: "healthy", ExitCode: 0 },
        ],
        marker: "DUPLICATE_FAILING_FIRST_MARKER",
      },
      {
        name: "healthy-first",
        statuses: [
          { Service: "dev", State: "running", Health: "healthy", ExitCode: 0 },
          { Service: "dev", State: "exited", ExitCode: 17 },
        ],
        marker: "DUPLICATE_HEALTHY_FIRST_MARKER",
      },
    ];
    for (const scenario of scenarios) {
      const root = await mkdtemp(join(tmpdir(), `container-lab-service-log-${scenario.name}-`));
      temporary.push(root);
      const source = join(root, "source");
      await runCommand("git", ["init", source]);
      await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
      await runCommand("git", ["-C", source, "add", "."]);
      await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
      const docker = new ServiceLogsDocker(scenario.statuses, { dev: scenario.marker });
      const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
      const owner = `thread-service-log-${scenario.name}`;
      const service = new ContainerLabService(owner, roots, docker);

      const created = await service.createLab(`service-${scenario.name}`, source);
      expect(created.state).toBe("failed");
      const lab = await readLab(roots, owner, created.labId);
      const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
      expect(artifact).toContain(scenario.marker);
      expect(docker.runCalls.filter((call) => call.args.includes("logs")).map((call) => call.args.at(-1))).toEqual(["dev"]);
      await service.destroyLab(created.labId);
    }
  });

  test("selects command and declared port services in manifest order beyond public summary limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-order-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }
ports:
  api: { service: api, target: 8080 }
  worker: { service: worker, target: 8081 }
  jobs: { service: jobs, target: 8082 }
  metrics: { service: metrics, target: 8083 }
`);
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const sidecars = Array.from({ length: 16 }, (_, index) => ({ Service: `sidecar-${index}`, State: "exited", ExitCode: 17 }));
    const candidates = ["dev", "api", "worker", "jobs", "metrics"];
    const statuses = [...sidecars, ...candidates.map((Service) => ({ Service, State: "exited", ExitCode: 17 }))];
    const logs = Object.fromEntries(candidates.map((service) => [service, `TERMINAL_${service.toUpperCase()}_MARKER`])) as Record<string, string>;
    const docker = new ServiceLogsDocker(statuses, logs, ["dev", "api", "worker", "jobs", "metrics", ...sidecars.map((row) => row.Service)]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-order", roots, docker);

    const created = await service.createLab("service-order", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-order", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(docker.runCalls.filter((call) => call.args.includes("logs")).map((call) => call.args.at(-1))).toEqual(["dev", "api", "worker", "jobs"]);
    for (const serviceName of ["dev", "api", "worker", "jobs"]) expect(artifact).toContain(`TERMINAL_${serviceName.toUpperCase()}_MARKER`);
    expect(artifact).not.toContain("TERMINAL_METRICS_MARKER");
    expect(lab.provisioningFailure?.serviceCount).toBe(21);
    expect(JSON.stringify(await service.labStatus(created.labId))).not.toContain("TERMINAL_API_MARKER");
    await service.destroyLab(created.labId);
  });

  test("fairly preserves terminal markers for every selected service within the aggregate cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-fairness-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }
ports:
  api: { service: api, target: 8080 }
  worker: { service: worker, target: 8081 }
  jobs: { service: jobs, target: 8082 }
`);
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const selected = ["dev", "api", "worker", "jobs"];
    const statuses = selected.map((Service) => ({ Service, State: "exited", ExitCode: 17 }));
    const logs = Object.fromEntries(selected.map((serviceName) => [
      serviceName,
      `${"NOISY_${serviceName}_PREFIX\\n".repeat(400)}TERMINAL_${serviceName.toUpperCase()}_MARKER`,
    ])) as Record<string, string>;
    const docker = new ServiceLogsDocker(statuses, logs, selected);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-fairness", roots, docker);

    const created = await service.createLab("service-fairness", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-fairness", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    for (const serviceName of selected) expect(artifact).toContain(`TERMINAL_${serviceName.toUpperCase()}_MARKER`);
    expect(Buffer.byteLength(artifact)).toBeLessThanOrEqual(8 * 1024);
    expect(artifact.split("\n").length).toBeLessThanOrEqual(500);
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, truncated: true });
    for (const call of docker.runCalls.filter((entry) => entry.args.includes("logs"))) {
      expect(call.options).toMatchObject({ stdoutCapture: "tail", stderrCapture: "tail" });
    }
    await service.destroyLab(created.labId);
  });

  test("allocates equal service log stream caps without trimming either terminal stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-stream-cap-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const stdoutMarker = "STDOUT_TERMINAL_MARKER";
    const stderrMarker = "STDERR_TERMINAL_MARKER";
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], {
      dev: (options) => {
        const streamBytes = options?.maxOutputBytes ?? 0;
        const stream = (marker: string) => {
          const markerBytes = Buffer.from(marker);
          return Buffer.concat([markerBytes, Buffer.alloc(Math.max(0, streamBytes - markerBytes.byteLength), "x")]);
        };
        return { code: 0, stdout: stream(stdoutMarker), stderr: stream(stderrMarker) };
      },
    });
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-stream-cap", roots, docker);

    const created = await service.createLab("service-stream-cap", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-stream-cap", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toContain(stdoutMarker);
    expect(artifact).toContain(stderrMarker);
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, truncated: false });
    await service.destroyLab(created.labId);
  });

  test("fails closed across service log secrets, paths, and control bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-redaction-"));
    temporary.push(root);
    const source = join(root, "source");
    const secret = "service-log-secret-8f31";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const statuses = [{ Service: "dev", State: "exited", ExitCode: 17 }];
    const docker = new ServiceLogsDocker(statuses, {
      dev: `secret=${secret} path=/private/tmp/adversarial windows=C:\\Users\\adversarial\\AppData\\Local\\Docker\\secret unc=\\\\server\\share\\secret project=ccl-private id=${"a".repeat(64)}\u0001`,
    });
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-redaction", roots, docker, {
      PATH: process.env.PATH,
      REGISTRY_TOKEN: secret,
    });

    const created = await service.createLab("service-redaction", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-redaction", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    const status = JSON.stringify(await service.labStatus(created.labId));
    const diagnostic = JSON.stringify(await service.diagnostic(created.labId));
    const logsCall = docker.runCalls.find((call) => call.args.includes("logs"));
    expect(logsCall).toBeDefined();
    expect(logsCall?.options?.env?.REGISTRY_TOKEN).toBeUndefined();
    for (const value of [artifact, status, diagnostic]) {
      expect(value).not.toContain(secret);
      expect(value).not.toContain("/private/tmp");
      expect(value).not.toContain("C:\\Users\\adversarial\\AppData\\Local\\Docker\\secret");
      expect(value).not.toContain("\\\\server\\share\\secret");
      expect(value).not.toContain("ccl-private");
      expect(value).not.toContain("a".repeat(64));
      expect(value).not.toContain("\u0001");
    }
    expect(Buffer.byteLength(artifact)).toBeLessThanOrEqual(8 * 1024);
    await service.destroyLab(created.labId);
  });

  test("keeps the fixed Compose error when selected service log capture fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-service-log-failure-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const docker = new ServiceLogsDocker([{ Service: "dev", State: "exited", ExitCode: 17 }], { dev: new Error("logs unavailable") });
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const service = new ContainerLabService("thread-service-log-failure", roots, docker);

    const created = await service.createLab("service-log-failure", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-service-log-failure", created.labId);
    expect(lab.error).toBe("Docker Compose up failed; secret-bearing diagnostics redacted");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, truncated: true });
    await service.destroyLab(created.labId);
  });

  test("omits an out-of-contract Compose exit code without masking the original failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-failed-exit-code-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new ComposeFailureServiceDocker("sentinel-invalid-exit", 999);
    const service = new ContainerLabService("thread-invalid-exit", roots, docker, { PATH: process.env.PATH });

    const created = await service.createLab("invalid-exit", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-invalid-exit", created.labId);
    expect(lab.error).toBe("Docker Compose up failed; secret-bearing diagnostics redacted");
    expect(lab.provisioningFailure?.services).toEqual([{ service: "dev", state: "exited", health: "unhealthy" }]);
    await service.destroyLab(created.labId);
  });

  test("replaces overlapping secret values longest-first across all diagnostic surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-overlap-secret-"));
    temporary.push(root);
    const source = join(root, "source");
    const short = "token";
    const long = "token-private-suffix";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [TOKEN_SHORT, TOKEN_LONG]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new ComposeFailureServiceDocker(long);
    const service = new ContainerLabService("thread-overlap-secret", roots, docker, {
      PATH: process.env.PATH,
      TOKEN_SHORT: short,
      TOKEN_LONG: long,
    });

    const created = await service.createLab("overlap-secret", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-overlap-secret", created.labId);
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    const status = JSON.stringify(await service.labStatus(created.labId));
    const diagnostic = JSON.stringify(await service.diagnostic(created.labId));
    for (const value of [short, long, "private-suffix"]) {
      expect(artifact).not.toContain(value);
      expect(status).not.toContain(value);
      expect(diagnostic).not.toContain(value);
    }
    await service.destroyLab(created.labId);
  });

  test("falls back to an empty transcript when a secret collides with the replacement marker", async () => {
    for (const [secret, name] of [["secret", "TOKEN_SECRET"], ["[secret-value-redacted]", "TOKEN_MARKER"]] as const) {
      const root = await mkdtemp(join(tmpdir(), "container-lab-marker-secret-"));
      temporary.push(root);
      const source = join(root, "source");
      await runCommand("git", ["init", source]);
      await writeFile(join(source, ".codex-container-lab.yaml"), `image: { name: node:24, service: dev }\nsecret_environment: [${name}]\n`);
      await runCommand("git", ["-C", source, "add", "."]);
      await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
      const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
      const docker = new ComposeFailureServiceDocker(secret);
      const service = new ContainerLabService(`thread-marker-${name.toLowerCase()}`, roots, docker, {
        PATH: process.env.PATH,
        [name]: secret,
      });

      const created = await service.createLab("marker-secret", source);
      expect(created.state).toBe("failed");
      const lab = await readLab(roots, `thread-marker-${name.toLowerCase()}`, created.labId);
      expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0, truncated: false });
      const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
      expect(artifact).toBe("");

      const status = JSON.stringify(await service.labStatus(created.labId));
      expect(status).toContain('"bytes":0');
      expect(status).toContain('"lines":0');
      expect(status).not.toContain("[secret-value-redacted]");
      const diagnostic = await service.diagnostic(created.labId) as { diagnostic: { transcript: { text: string } } };
      expect(diagnostic.diagnostic.transcript.text).toBe("");
      expect(JSON.stringify(diagnostic.diagnostic.transcript)).not.toContain(secret);
      await service.destroyLab(created.labId);
    }
  });

  test("falls back to an empty transcript when sanitization introduces a declared secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-sanitized-secret-"));
    temporary.push(root);
    const source = join(root, "source");
    const secret = "�";
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\nsecret_environment: [TOKEN_REPLACEMENT]\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const docker = new ComposeFailureServiceDocker(secret, 23, "Compose failed \u0001");
    const service = new ContainerLabService("thread-sanitized-secret", roots, docker, {
      PATH: process.env.PATH,
      TOKEN_REPLACEMENT: secret,
    });

    const created = await service.createLab("sanitized", source);
    expect(created.state).toBe("failed");
    const lab = await readLab(roots, "thread-sanitized-secret", created.labId);
    expect(lab.error).toBe("Docker Compose up failed; secret-bearing diagnostics redacted");
    expect(lab.provisioningFailure?.evidence).toMatchObject({ available: true, bytes: 0, lines: 0, truncated: false });
    const artifact = await Bun.file(join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE)).text();
    expect(artifact).toBe("");

    const status = JSON.stringify(await service.labStatus(created.labId));
    expect(status).toContain('"bytes":0');
    expect(status).toContain('"lines":0');
    expect(status).not.toContain(secret);
    const diagnostic = JSON.stringify(await service.diagnostic(created.labId));
    expect(diagnostic).toContain('"text":""');
    expect(diagnostic).not.toContain(secret);
    await service.destroyLab(created.labId);
  });

  test("keeps legacy failed manifests readable without diagnostics", async () => {
    const fixture = await durableFixture("thread-legacy-failed", "failed");
    const service = new ContainerLabService(fixture.owner, fixture.roots, new RecordingDocker());
    expect((await service.labStatus(fixture.lab.id) as { state: string }).state).toBe("failed");
    await expect(service.diagnostic(fixture.lab.id)).rejects.toThrow("unavailable");
  });

  test("health scrubs the union of secret names from known labs", async () => {
    const fixture = await durableFixture("thread-health-secrets", "ready", true);
    fixture.lab.secretEnvironment = ["REGISTRY_TOKEN"];
    fixture.lab.runtime!.config.secretEnvironment = ["REGISTRY_TOKEN"];
    await writeLab(fixture.roots, fixture.lab);
    const docker = new RecordingDocker();
    const service = new ContainerLabService(fixture.owner, fixture.roots, docker, {
      PATH: process.env.PATH,
      REGISTRY_TOKEN: "sentinel-health-token",
    });

    expect((await service.health()).dockerAvailable).toBe(true);
    const info = docker.runCalls.find((call) => call.args[0] === "info");
    expect(info).toBeDefined();
    expect(Object.hasOwn(info!.options?.env ?? {}, "REGISTRY_TOKEN")).toBe(false);
  });

  test("loads legacy version-1 ready state without secret metadata for status and destroy", async () => {
    const fixture = await durableFixture("thread-legacy-ready", "ready", true);
    const path = labManifestPath(fixture.roots.stateRoot, fixture.owner, fixture.lab.id);
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.secretEnvironment;
    delete legacy.runtime.config.secretEnvironment;
    writeFileSync(path, JSON.stringify(legacy));
    const docker = new RecordingDocker();
    const service = new ContainerLabService(fixture.owner, fixture.roots, docker);

    expect((await service.labStatus(fixture.lab.id) as { state: string }).state).toBe("ready");
    expect((await readLab(fixture.roots, fixture.owner, fixture.lab.id)).secretEnvironment).toEqual([]);
    expect(await service.destroyLab(fixture.lab.id)).toEqual({ labId: fixture.lab.id, destroyed: true });
  });

  test("interrupted synchronous provisioning records a recoverable failed lab", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-interrupted-create-"));
    temporary.push(root);
    const source = join(root, "source");
    await runCommand("git", ["init", source]);
    await writeFile(join(source, ".codex-container-lab.yaml"), "image: { name: node:24, service: dev }\n");
    await runCommand("git", ["-C", source, "add", "."]);
    await runCommand("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
    const controller = new AbortController();
    const result = await new ContainerLabService("thread-interrupt", roots, new InterruptingDocker(controller))
      .createLab("experiment", source, controller.signal);
    expect(result.state).toBe("failed");
    const persisted = await readLab(roots, "thread-interrupt", result.labId);
    expect(persisted.state).toBe("failed");
    expect(persisted.error).toContain("aborted");
  });

  test("streams an attached argv run and returns its exact exit status", async () => {
    const fixture = await durableFixture("thread-run", "ready", true);
    const docker = new RecordingDocker();
    const service = new ContainerLabService(fixture.owner, fixture.roots, docker);
    let stdout = "";
    let stderr = "";
    let stdin = "";
    const input = new PassThrough();
    const running = service.run(fixture.lab.id, ["printf", "%s", "hello world"], ".", {}, 30, {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; },
      stdin: input,
    });
    await Bun.sleep(5);
    docker.child!.stdin.on("data", (chunk) => { stdin += chunk; });
    input.write("interactive-input\n");
    (docker.child!.stdout as PassThrough).write("early\n");
    (docker.child!.stderr as PassThrough).write("warning\n");
    await Bun.sleep(5);
    expect(stdout).toBe("early\n");
    expect(stderr).toBe("warning\n");
    expect(stdin).toBe("interactive-input\n");
    Object.assign(docker.child!, { exitCode: 23 });
    docker.child!.emit("close", 23);
    expect(await running).toBe(23);
    expect(docker.calls.find((call) => call.includes("exec"))).toContain("hello world");
  });

  test("an already-aborted run never launches a container process", async () => {
    const fixture = await durableFixture("thread-pre-abort", "ready", true);
    const docker = new RecordingDocker();
    const controller = new AbortController();
    controller.abort("SIGINT");
    expect(await new ContainerLabService(fixture.owner, fixture.roots, docker).run(
      fixture.lab.id, ["true"], ".", {}, 30, { stdout: () => {}, stderr: () => {} }, controller.signal,
    )).toBe(130);
    expect(docker.child).toBeUndefined();
  });

  test("destroy removes exact containers first, then waits for attached activity before filesystem cleanup", async () => {
    const fixture = await durableFixture("thread-destroy-active", "ready", true);
    const docker = new DestructiveDocker();
    const service = new ContainerLabService(fixture.owner, fixture.roots, docker);
    const running = service.run(fixture.lab.id, ["sleep", "100"], ".", {}, 0, { stdout: () => {}, stderr: () => {} });
    await Bun.sleep(5);
    expect(await service.destroyLab(fixture.lab.id)).toEqual({ labId: fixture.lab.id, destroyed: true });
    expect(await running).toBe(137);
    expect(docker.calls.some((args) => args[0] === "rm" && args[1] === "-f" && args.includes("container-1"))).toBe(true);
  });

  test("a tampered runtime path fails closed before destroy touches Docker or outside data", async () => {
    const fixture = await durableFixture("thread-tampered", "failed");
    const sentinel = join(fixture.root, "outside", "sentinel.txt");
    await mkdir(join(fixture.root, "outside"), { recursive: true });
    await writeFile(sentinel, "keep");
    const path = labManifestPath(fixture.roots.stateRoot, fixture.owner, fixture.lab.id);
    const corrupted = JSON.parse(readFileSync(path, "utf8"));
    corrupted.runtimeRoot = join(fixture.root, "outside");
    corrupted.workspace = join(fixture.root, "outside", "workspace");
    writeFileSync(path, JSON.stringify(corrupted));
    const docker = new RecordingDocker();
    await expect(new ContainerLabService(fixture.owner, fixture.roots, docker).destroyLab(fixture.lab.id)).rejects.toThrow("invalid lab manifest");
    expect(await Bun.file(sentinel).text()).toBe("keep");
    expect(docker.calls).toEqual([]);
  });

  test("a symlinked owner runtime parent fails closed before cleanup", async () => {
    const fixture = await durableFixture("thread-destroy-symlink", "ready", true);
    const ownerRuntime = join(fixture.roots.runtimeRoot, fixture.lab.ownerKey);
    const outside = join(fixture.root, "outside-runtime-owner");
    await rename(ownerRuntime, outside);
    await symlink(outside, ownerRuntime, "dir");
    const docker = new RecordingDocker();
    await expect(new ContainerLabService(fixture.owner, fixture.roots, docker).destroyLab(fixture.lab.id)).rejects.toThrow("unsafe indirection");
    expect(docker.calls).toEqual([]);
  });

  test("public lab views omit internal persistence fields", async () => {
    const fixture = await durableFixture("thread-output", "failed");
    const service = new ContainerLabService(fixture.owner, fixture.roots, new RecordingDocker());
    const encoded = JSON.stringify(await service.labStatus(fixture.lab.id));
    for (const forbidden of ["ownerKey", "runtimeRoot", "sourceRoot", "composeArgs", "manifestPath", fixture.lab.ownerKey]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(Buffer.byteLength(encoded)).toBeLessThan(16 * 1024);
  });

  test("durable runtime validation rejects invalid and overlapping secret environment names", async () => {
    const fixture = await durableFixture("thread-secret-state", "ready", true);
    fixture.lab.runtime!.config.secretEnvironment = ["BAD-NAME"];
    await expect(writeLab(fixture.roots, fixture.lab)).rejects.toThrow("invalid secret environment");
    fixture.lab.runtime!.config.secretEnvironment = ["TERM"];
    fixture.lab.runtime!.config.forwardEnvironment = ["TERM"];
    await expect(writeLab(fixture.roots, fixture.lab)).rejects.toThrow("invalid secret environment");
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
