import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupLabLabels, dockerAvailable, DockerProvisioningFailure, ensureSharedCompilerCache, launchDockerRun, prepareLabRuntime, PROVISIONING_FAILURE_DIAGNOSTIC_FILE, provisionLabStack, stackLogs, stackStatus, terminateDockerRun, type DockerRunner, type DockerSpawnOptions, type LabRuntime } from "./docker";
import { SHARED_COMPILER_CACHE_CONTAINER, SHARED_COMPILER_CACHE_IMAGE, SHARED_COMPILER_CACHE_LABELS, SHARED_COMPILER_CACHE_NETWORK } from "./compose";
import { parseLabConfig } from "./config";
import { redactComposeFailureWithMetadata } from "./log-framing";
import type { RunOptions, CommandResult } from "./process";
import type { LabMetadata } from "./types";

class MockDocker implements DockerRunner {
  calls: string[][] = [];
  spawnCalls: string[][] = [];
  spawnOptions: Array<DockerSpawnOptions | undefined> = [];
  responses: Array<CommandResult> = [];
  async run(args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    return this.responses.shift() ?? result("");
  }
  spawn(args: string[], options?: DockerSpawnOptions): ChildProcessWithoutNullStreams {
    this.spawnCalls.push(args);
    this.spawnOptions.push(options);
    return new EventEmitter() as ChildProcessWithoutNullStreams;
  }
}

describe("Docker health probe", () => {
  test("returns availability without adding a diagnostic on success", async () => {
    const docker = new MockDocker();
    docker.responses.push(result("27.1.0\n"));
    const probe = await dockerAvailable(docker, ["TOKEN"], {
      PATH: "/usr/bin",
      TOKEN: "secret-health-value",
      DOCKER_CONTEXT: "orbstack",
    });
    expect(probe).toEqual({ available: true });
    expect(docker.calls[0]).toEqual(["info", "--format", "{{.ServerVersion}}"]);
    expect(docker.spawnOptions).toHaveLength(0);
  });

  test("classifies bounded Docker failures without exposing stderr", async () => {
    const cases = [
      ["permission", "permission denied while trying to connect to the Docker daemon", "permission"],
      ["context", 'Failed to initialize: context "linux": context not found: open /private/docker/meta.json: no such file or directory', "context"],
      ["daemon", "Cannot connect to the Docker daemon. Is the docker daemon running?", "daemon"],
      ["unreachable", "ssh: connect to host 192.0.2.10 port 22: Connection refused", "unreachable"],
    ] as const;
    for (const [, stderr, reason] of cases) {
      const docker = new MockDocker();
      docker.responses.push(resultWithError(stderr));
      const probe = await dockerAvailable(docker, [], { DOCKER_CONTEXT: "linux" });
      expect(probe).toMatchObject({ available: false, diagnostic: { reason, context: "linux" } });
      expect(JSON.stringify(probe)).not.toContain(stderr);
      expect((probe as { available: false; diagnostic: { nextAction: string } }).diagnostic.nextAction).not.toBe("");
    }
  });

  test("classifies thrown spawn and timeout failures", async () => {
    const spawnFailure: DockerRunner = {
      run: async () => { throw new Error("spawn docker failed"); },
      spawn: () => new EventEmitter() as ChildProcessWithoutNullStreams,
    };
    await expect(dockerAvailable(spawnFailure)).resolves.toMatchObject({
      available: false,
      diagnostic: { reason: "spawn" },
    });

    const timeoutFailure: DockerRunner = {
      run: async () => { throw new Error("Docker health check timed out"); },
      spawn: () => new EventEmitter() as ChildProcessWithoutNullStreams,
    };
    await expect(dockerAvailable(timeoutFailure)).resolves.toMatchObject({
      available: false,
      diagnostic: { reason: "timeout" },
    });
  });

  test("only returns a context that matches the strict identifier allowlist", async () => {
    const docker = new MockDocker();
    docker.responses.push(resultWithError('docker: context "/tmp/private-token" does not exist'));
    const probe = await dockerAvailable(docker, [], { DOCKER_CONTEXT: "/tmp/private-token" });
    expect(probe).toMatchObject({ available: false, diagnostic: { reason: "context" } });
    expect(JSON.stringify(probe)).not.toContain("/tmp/private-token");
  });
});

class SecretRecordingDocker implements DockerRunner {
  calls: Array<{ args: string[]; options?: RunOptions }> = [];
  spawnCalls: Array<{ args: string[]; options?: DockerSpawnOptions }> = [];
  failConfig = false;
  failUp = false;
  constructor(readonly sentinel: string) {}
  async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ args, options });
    if (args.includes("config")) {
      if (this.failConfig) return resultWithError(`configuration echoed ${this.sentinel}`);
      return result(JSON.stringify({
        services: { dev: {} },
        secrets: { registry: { environment: "REGISTRY_TOKEN" } },
      }));
    }
    if (args.includes("up") && this.failUp) return resultWithError(`up echoed ${this.sentinel}`);
    return result("");
  }
  spawn(args: string[], options?: DockerSpawnOptions): ChildProcessWithoutNullStreams {
    this.spawnCalls.push({ args, options });
    return new EventEmitter() as ChildProcessWithoutNullStreams;
  }
}

class ComposeFailureDocker implements DockerRunner {
  calls: string[][] = [];
  constructor(readonly sentinel: string, readonly psOutput: string) {}
  async run(args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    if (args.includes("config")) return result(JSON.stringify({ services: { dev: {} } }));
    if (args.includes("up")) return resultWithError(`failed ${this.sentinel} /private/tmp/ccl-project ${"a".repeat(64)}`);
    if (args.includes("ps") && args.includes("--all")) return result(this.psOutput);
    return result("");
  }
  spawn(): ChildProcessWithoutNullStreams { return new EventEmitter() as ChildProcessWithoutNullStreams; }
}

class SharedCacheDocker implements DockerRunner {
  calls: string[][] = [];
  networkExists = false;
  containerExists = false;
  containerStatus: "running" | "exited" = "running";
  networkCollision = false;
  containerCollision = false;
  pingFailures = 0;

  async run(args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    if (args[0] === "network" && args[1] === "inspect") {
      if (!this.networkExists && !this.networkCollision) return resultWithError(`Error: network ${SHARED_COMPILER_CACHE_NETWORK} not found`);
      return result(JSON.stringify({
        Name: this.networkCollision ? "unrelated-network" : SHARED_COMPILER_CACHE_NETWORK,
        Driver: "bridge",
        Scope: "local",
        Internal: false,
        Labels: SHARED_COMPILER_CACHE_LABELS,
      }));
    }
    if (args[0] === "network" && args[1] === "create") {
      if (this.networkCollision) return resultWithError("network name already in use");
      this.networkExists = true;
      return result("network-id");
    }
    if (args[0] === "container" && args[1] === "inspect") {
      if (!this.containerExists && !this.containerCollision) return resultWithError(`Error: No such container: ${SHARED_COMPILER_CACHE_CONTAINER}`);
      return result(JSON.stringify({
        Name: this.containerCollision ? "/unrelated-container" : `/${SHARED_COMPILER_CACHE_CONTAINER}`,
        Config: {
          Image: SHARED_COMPILER_CACHE_IMAGE,
          Labels: SHARED_COMPILER_CACHE_LABELS,
          Cmd: ["redis-server", "--maxmemory", "16gb", "--maxmemory-policy", "allkeys-lru", "--save", "", "--appendonly", "no"],
        },
        HostConfig: { RestartPolicy: { Name: "unless-stopped" }, PortBindings: null },
        NetworkSettings: { Networks: { [SHARED_COMPILER_CACHE_NETWORK]: {} } },
        State: { Status: this.containerStatus },
      }));
    }
    if (args[0] === "run") {
      if (this.containerCollision) return resultWithError("container name already in use");
      this.containerExists = true;
      this.containerStatus = "running";
      return result("container-id");
    }
    if (args[0] === "start") {
      this.containerStatus = "running";
      return result("container-id");
    }
    if (args[0] === "exec") {
      if (this.pingFailures > 0) {
        this.pingFailures--;
        return resultWithError("redis is starting");
      }
      return result("PONG\n");
    }
    return result("");
  }

  spawn(): ChildProcessWithoutNullStreams {
    return new EventEmitter() as ChildProcessWithoutNullStreams;
  }
}

describe("shared compiler cache", () => {
  test("creates matching resources once and is idempotent", async () => {
    const docker = new SharedCacheDocker();
    await ensureSharedCompilerCache(docker);
    await ensureSharedCompilerCache(docker);
    expect(docker.calls.filter((args) => args[0] === "network" && args[1] === "create")).toHaveLength(1);
    expect(docker.calls.filter((args) => args[0] === "run")).toHaveLength(1);
    expect(docker.calls.filter((args) => args[0] === "exec")).toHaveLength(2);
    const create = docker.calls.find((args) => args[0] === "run")!;
    expect(create).toContain(SHARED_COMPILER_CACHE_IMAGE);
    expect(create).toContain("--restart");
    expect(create).toContain("unless-stopped");
    expect(create).not.toContain("--publish");
    expect(create).not.toContain("io.openai.codex-container-lab.managed=true");
  });

  test("retries a transient Redis readiness failure within the bounded probe window", async () => {
    const docker = new SharedCacheDocker();
    docker.pingFailures = 2;
    await ensureSharedCompilerCache(docker);
    expect(docker.calls.filter((args) => args[0] === "exec")).toHaveLength(3);
  });

  test("starts a matching stopped container and rejects unrelated collisions", async () => {
    const stopped = new SharedCacheDocker();
    stopped.networkExists = true;
    stopped.containerExists = true;
    stopped.containerStatus = "exited";
    await ensureSharedCompilerCache(stopped);
    expect(stopped.calls.filter((args) => args[0] === "start")).toHaveLength(1);

    const networkCollision = new SharedCacheDocker();
    networkCollision.networkCollision = true;
    await expect(ensureSharedCompilerCache(networkCollision)).rejects.toThrow("mismatched identity");

    const containerCollision = new SharedCacheDocker();
    containerCollision.networkExists = true;
    containerCollision.containerCollision = true;
    await expect(ensureSharedCompilerCache(containerCollision)).rejects.toThrow("mismatched identity");
  });

  test("does not inspect or create shared resources without compiler-cache opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-no-cache-"));
    try {
      const docker = new MockDocker();
      docker.responses.push(
        result(JSON.stringify({ services: { dev: {} } })),
        result(JSON.stringify({ services: { dev: {} } })),
      );
      const config = parseLabConfig("image: { name: node:24, service: dev }", join(root, "source"));
      await prepareLabRuntime(labAt(root), config, docker);
      expect(docker.calls.some((args) => ["network", "container", "run", "start", "exec"].includes(args[0] ?? ""))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("secret environment materialization", () => {
  test("keeps values ephemeral and sends them only to Compose config and up", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-"));
    const sentinel = "sentinel-registry-token-8fca7b";
    try {
      const docker = new SecretRecordingDocker(sentinel);
      const config = parseLabConfig(`
image: { name: node:24, service: dev }
environment: [TERM]
secret_environment: [REGISTRY_TOKEN]
`, join(root, "source"));
      const metadata = labAt(root);
      metadata.secretEnvironment = ["REGISTRY_TOKEN"];
      const environment = { PATH: "/usr/bin:/bin", TERM: "xterm", REGISTRY_TOKEN: sentinel };
      const prepared = await prepareLabRuntime(metadata, config, docker, environment);
      await provisionLabStack(prepared, undefined, docker, environment);
      launchDockerRun(prepared, {
        runId: "11111111-1111-4111-8111-111111111111",
        cwd: ".",
        argv: ["true"],
        environment: {},
      }, docker, environment);
      await cleanupLabLabels(metadata, false, docker, environment);

      const durable = JSON.stringify({ metadata, runtime: prepared, findings: prepared.findings });
      expect(durable).not.toContain(sentinel);
      expect(prepared.findings.some((finding) => finding.surface === "secret")).toBe(true);
      expect(JSON.stringify(prepared.findings)).not.toContain("REGISTRY_TOKEN");
      expect(prepared.composeArgs.join("\0")).not.toContain(sentinel);
      expect(await readFile(prepared.baseFile!, "utf8")).not.toContain(sentinel);
      expect(await readFile(prepared.overrideFile, "utf8")).not.toContain(sentinel);

      const carryingSecret = docker.calls.filter((call) => call.options?.env?.REGISTRY_TOKEN === sentinel);
      expect(carryingSecret.length).toBeGreaterThanOrEqual(3);
      expect(carryingSecret.every((call) => call.args.includes("config") || call.args.includes("up"))).toBe(true);
      for (const call of docker.calls.filter((call) => !call.args.includes("config") && !call.args.includes("up"))) {
        expect(Object.hasOwn(call.options?.env ?? {}, "REGISTRY_TOKEN")).toBe(false);
      }
      expect(docker.spawnCalls).toHaveLength(1);
      expect(Object.hasOwn(docker.spawnCalls[0]!.options?.env ?? {}, "REGISTRY_TOKEN")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces secret-bearing Compose config and up diagnostics with fixed errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-secret-error-"));
    const sentinel = "sentinel-error-token-290ea1";
    try {
      const config = parseLabConfig("image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n", join(root, "source"));
      const environment = { PATH: "/usr/bin:/bin", REGISTRY_TOKEN: sentinel };
      const configFailure = new SecretRecordingDocker(sentinel);
      configFailure.failConfig = true;
      let configError: unknown;
      try { await prepareLabRuntime(labAt(root), config, configFailure, environment); }
      catch (error) { configError = error; }
      expect(configError).toBeInstanceOf(Error);
      expect((configError as Error).message).toBe("Docker Compose configuration failed; secret-bearing diagnostics redacted");
      expect((configError as Error).message).not.toContain(sentinel);

      const upFailure = new SecretRecordingDocker(sentinel);
      const prepared = await prepareLabRuntime(labAt(root), config, upFailure, environment);
      upFailure.failUp = true;
      let upError: unknown;
      try { await provisionLabStack(prepared, undefined, upFailure, environment); }
      catch (error) { upError = error; }
      expect(upError).toBeInstanceOf(Error);
      expect((upError as Error).message).toBe("Docker Compose up failed; secret-bearing diagnostics redacted");
      expect((upError as Error).message).not.toContain(sentinel);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("failed Compose diagnostics", () => {
  test("captures --all service exits before cleanup and writes only bounded owner-scoped evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-compose-failure-"));
    const sentinel = "sentinel-compose-secret-4f17";
    try {
      const config = parseLabConfig("image: { name: node:24, service: dev }\nsecret_environment: [REGISTRY_TOKEN]\n", join(root, "source"));
      const environment = { PATH: "/usr/bin:/bin", REGISTRY_TOKEN: sentinel };
      const docker = new ComposeFailureDocker(sentinel, JSON.stringify([
        { Service: "dev", State: "exited", Health: "unhealthy", ExitCode: 17, ID: "container-private", Project: "ccl-private" },
      ]));
      const prepared = await prepareLabRuntime(labAt(root), config, docker, environment);
      let failure: unknown;
      try { await provisionLabStack(prepared, undefined, docker, environment); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(DockerProvisioningFailure);
      const diagnostic = (failure as DockerProvisioningFailure).diagnostic;
      expect(diagnostic.phase).toBe("compose-up");
      expect(diagnostic.services).toEqual([{ service: "dev", state: "exited", health: "unhealthy", exitCode: 17 }]);
      expect(diagnostic.evidence?.available).toBe(true);
      const up = docker.calls.findIndex((args) => args.includes("up"));
      const ps = docker.calls.findIndex((args) => args.includes("ps") && args.includes("--all"));
      expect(ps).toBeGreaterThan(up);
      const artifact = join(labAt(root).runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE);
      const info = await lstat(artifact);
      expect(info.isFile()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.mode & 0o777).toBe(0o600);
      const text = await readFile(artifact, "utf8");
      expect(text).not.toContain(sentinel);
      expect(text).toContain("/private/tmp");
      expect(text).toContain("failed");
      expect(text).not.toContain("ccl-private");
      expect(text).not.toContain("a".repeat(64));
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("capture failure preserves the fixed Compose error", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-compose-failure-write-"));
    try {
      const config = parseLabConfig("image: { name: node:24, service: dev }\n", join(root, "source"));
      const docker = new ComposeFailureDocker("unused", "not-json");
      const prepared = await prepareLabRuntime(labAt(root), config, docker);
      await rm(prepared.metadata.runtimeRoot, { recursive: true, force: true });
      await expect(provisionLabStack(prepared, undefined, docker)).rejects.toThrow(
        "Docker Compose up failed; secret-bearing diagnostics redacted",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("exact Docker cleanup", () => {
  test("maps a repository-relative run cwd beneath the configured container workspace", () => {
    const docker = new MockDocker();
    launchDockerRun(runtime(), {
      runId: "00000000-0000-4000-8000-000000000000",
      cwd: "packages/api",
      argv: ["pwd"],
      environment: {},
    }, docker);
    const spawned = docker.spawnCalls[0]!;
    const workdir = spawned.indexOf("--workdir");
    expect(spawned[workdir + 1]).toBe("/workspace/packages/api");
  });

  test("uses managed + exact owner + exact lab filters and Compose ownership filters", async () => {
    const docker = new MockDocker();
    await cleanupLabLabels(lab(), false, docker);
    const listCalls = docker.calls.filter((args) => args.includes("--filter"));
    expect(listCalls).toHaveLength(6);
    for (const args of listCalls) {
      expect(args).toContain("label=io.openai.codex-container-lab.managed=true");
      expect(args).toContain("label=io.openai.codex-container-lab.owner=thread/exact");
      expect(args).toContain("label=io.openai.codex-container-lab.lab=lab-1");
      expect(args.join(" ")).not.toContain("prune");
    }
    for (const args of listCalls.filter((args) => args[0] === "volume" || args[0] === "network")) {
      expect(args).toContain("label=com.docker.compose.project=ccl-project");
      expect(args).toContain(`label=com.docker.compose.${args[0]}`);
    }
  });

  test("refuses a volume whose inspected labels do not prove exact ownership", async () => {
    const docker = new MockDocker();
    docker.responses.push(result(""), result(""), result("volume-id\n"), result(JSON.stringify({
      "io.openai.codex-container-lab.managed": "true",
      "io.openai.codex-container-lab.owner": "another-thread",
      "io.openai.codex-container-lab.lab": "lab-1",
      "com.docker.compose.project": "ccl-project",
      "com.docker.compose.volume": "data",
    })));
    await expect(cleanupLabLabels(lab(), false, docker)).rejects.toThrow("exact ownership labels");
    expect(docker.calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
  });

  test("refuses more than 1000 exact-labelled resources", async () => {
    const docker = new MockDocker();
    docker.responses.push(result(Array.from({ length: 1001 }, (_, index) => `id-${index}`).join("\n")));
    await expect(cleanupLabLabels(lab(), false, docker)).rejects.toThrow("cleanup bound");
    expect(docker.calls.some((args) => args.includes("rm"))).toBe(false);
  });

  test("verifies exact image labels and removes only the immutable image identity", async () => {
    const docker = new MockDocker();
    const imageId = `sha256:${"b".repeat(64)}`;
    docker.responses.push(...emptyResourceListings(), result(JSON.stringify({
      id: imageId,
      labels: {
        "io.openai.codex-container-lab.managed": "true",
        "io.openai.codex-container-lab.owner": "thread/exact",
        "io.openai.codex-container-lab.lab": "lab-1",
      },
    })), result(""));

    await cleanupLabLabels(lab(), true, docker);

    const tag = `codex-container-lab:${"a".repeat(24)}-lab-1`;
    expect(docker.calls.find((args) => args[0] === "image" && args[1] === "inspect")?.at(-1)).toBe(tag);
    expect(docker.calls.filter((args) => args[0] === "image" && args[1] === "rm")).toEqual([
      ["image", "rm", "--no-prune", imageId],
    ]);
  });

  test("refuses malformed or mismatched internal image inspection", async () => {
    for (const inspection of [
      "not-json",
      JSON.stringify({ id: "mutable-tag", labels: exactImageLabels() }),
      JSON.stringify({ id: `sha256:${"b".repeat(64)}`, labels: { ...exactImageLabels(),
        "io.openai.codex-container-lab.owner": "another-thread" } }),
    ]) {
      const docker = new MockDocker();
      docker.responses.push(...emptyResourceListings(), result(inspection));
      await expect(cleanupLabLabels(lab(), true, docker)).rejects.toThrow(/ownership|exact ownership labels/);
      expect(docker.calls.some((args) => args[0] === "image" && args[1] === "rm")).toBe(false);
    }
  });

  test("tolerates only an exact missing-image inspection response", async () => {
    const tag = `codex-container-lab:${"a".repeat(24)}-lab-1`;
    const absent = new MockDocker();
    absent.responses.push(...emptyResourceListings(), resultWithError(`Error response from daemon: No such image: ${tag}`));
    await expect(cleanupLabLabels(lab(), true, absent)).resolves.toBeUndefined();
    expect(absent.calls.some((args) => args[0] === "image" && args[1] === "rm")).toBe(false);

    const uncertain = new MockDocker();
    uncertain.responses.push(...emptyResourceListings(), resultWithError(`daemon unavailable; No such image: ${tag}`));
    await expect(cleanupLabLabels(lab(), true, uncertain)).rejects.toThrow("unable to inspect");
    expect(uncertain.calls.some((args) => args[0] === "image" && args[1] === "rm")).toBe(false);
  });

  test("binds cancellation to an ephemeral run identity and removes the pid file on normal completion", async () => {
    const docker = new MockDocker();
    const identity = { runId: "11111111-1111-4111-8111-111111111111", cwd: ".", argv: ["echo", "hello"], environment: {} };
    launchDockerRun(runtime(), identity, docker);
    const spawned = docker.spawnCalls[0]!;
    const shell = spawned.indexOf("/bin/sh");
    expect(spawned.slice(shell, shell + 2)).toEqual(["/bin/sh", "-lc"]);
    const wrapper = spawned[shell + 2]!;
    expect(wrapper).toContain(`CODEX_CONTAINER_LAB_RUN_ID=${identity.runId}`);
    expect(wrapper).toContain("exec 3<&0");
    expect(wrapper).toContain('setsid "$@" <&3 3<&- & child=$!');
    expect(wrapper).toContain("exec 3<&-");
    expect(wrapper).toContain(`printf '%s %s\\n' '${identity.runId}'`);
    expect(wrapper).toContain(`rm -f '/tmp/.codex-container-lab-run-${identity.runId}.pid'`);
    expect(wrapper).toContain('kill -TERM -- -"$child"');
    expect(wrapper).toContain('kill -KILL -- -"$child"');
    expect(wrapper.indexOf("kill -KILL")).toBeLessThan(wrapper.indexOf("rm -f"));

    docker.responses.push(result("codex-container-lab-termination:signaled\n"));
    const termination = await terminateDockerRun(runtime(), identity, "TERM", docker);
    expect(termination).toEqual({ confirmed: true, status: "signaled" });
    const killScript = docker.calls.at(-1)!.at(-1)!;
    expect(killScript).toContain("/proc/$pid/environ");
    expect(killScript).toContain(`CODEX_CONTAINER_LAB_RUN_ID=${identity.runId}`);
    expect(killScript).toContain(`[ \"$recorded_token\" = '${identity.runId}' ]`);
    expect(killScript).toContain("grep -Fqx");
    expect(killScript).toContain("kill -TERM -- -\"$pid\"");
  });

  test("preserves redirected stdin for the background attached command", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-stdin-"));
    try {
      const setsid = join(root, "setsid");
      await writeFile(setsid, "#!/bin/sh\nexec \"$@\"\n");
      await chmod(setsid, 0o755);
      const docker: DockerRunner = {
        run: async () => result(""),
        spawn: (args, options) => {
          const shell = args.indexOf("/bin/sh");
          return spawn(args[shell]!, args.slice(shell + 1), {
            env: { ...options?.env, PATH: `${root}:${process.env.PATH ?? ""}` },
            stdio: ["pipe", "pipe", "pipe"],
          });
        },
      };
      const child = launchDockerRun(runtime(), {
        runId: "22222222-2222-4222-8222-222222222222",
        cwd: ".",
        argv: ["cat"],
        environment: {},
      }, docker);
      child.stdin.end("stdin-forwarded\n");
      const [stdout, stderr, code] = await Promise.all([
        streamText(child.stdout),
        streamText(child.stderr),
        new Promise<number>((resolve) => child.once("close", (value) => resolve(value ?? 1))),
      ]);
      expect({ stdout, stderr, code }).toEqual({ stdout: "stdin-forwarded\n", stderr: "", code: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports token mismatch and Docker exec failure as unconfirmed termination", async () => {
    const mismatch = new MockDocker();
    mismatch.responses.push(result("codex-container-lab-termination:identity-mismatch\n"));
    expect(await terminateDockerRun(runtime(), { runId: "run-1" }, "KILL", mismatch)).toEqual({
      confirmed: false,
      status: "identity-mismatch",
    });

    const failed = new MockDocker();
    failed.responses.push(resultWithError("Docker service unavailable"));
    expect(await terminateDockerRun(runtime(), { runId: "run-1" }, "KILL", failed)).toEqual({
      confirmed: false,
      status: "docker-failure",
    });
  });

  test("reports an exact recorded process group absence as confirmed", async () => {
    const docker = new MockDocker();
    docker.responses.push(result("codex-container-lab-termination:absent\n"));
    expect(await terminateDockerRun(runtime(), { runId: "run-1" }, "KILL", docker)).toEqual({
      confirmed: true,
      status: "absent",
    });
  });

  test("service logs enforce both line and hard UTF-8 byte caps", async () => {
    const docker = new MockDocker();
    docker.responses.push(result('{"services":{"dev":{}}}'), result(frameComposeLog(Array.from({ length: 900 }, (_, index) => `${index}: ${"\\\"".repeat(40)}`).join("\n"))));
    const transcript = await stackLogs(runtime(), "dev", 500, docker);
    expect(transcript.truncated).toBe(true);
    expect(Buffer.byteLength(transcript.text)).toBeLessThanOrEqual(8 * 1024);
    expect(transcript.text.split("\n").length).toBeLessThanOrEqual(500);
    expect(Buffer.byteLength(JSON.stringify({ labId: "lab-1", service: "dev", transcript }))).toBeLessThan(16 * 1024);
  });

  test("stack logs preserve safe diagnostics while replacing declared secrets and controls", async () => {
    const docker = new MockDocker();
    const secret = "registry-token-from-environment-8f31";
    const configured = runtime();
    configured.config.secretEnvironment = ["REGISTRY_TOKEN"];
    docker.responses.push(
      result('{"services":{"dev":{}}}'),
      {
        code: 0,
        stdout: Buffer.from(frameComposeLog([
          `build secret=${secret}\u0000\u0001`,
          "compiler: failed at C:\\Users\\Robert\\Library\\Application Support\\Codex\\src\\main.ts",
          "request: GET https://example.invalid/api/v1/workspace/secret",
          "unc=\\\\server\\share name\\artifact",
        ].join("\n"))),
        stderr: Buffer.from(frameComposeLog("stderr path /Users/robertsale/private logs\n")),
      },
    );

    const transcript = await stackLogs(configured, "dev", 8, docker, { REGISTRY_TOKEN: secret });
    const publicTranscript = {
      ...transcript,
      bytes: Buffer.byteLength(transcript.text),
      lines: transcript.text ? transcript.text.split("\n").length : 0,
    };
    const encoded = JSON.stringify({ labId: "lab-1", service: "dev", transcript: publicTranscript });

    expect(transcript.truncated).toBe(false);
    expect(publicTranscript.bytes).toBe(Buffer.byteLength(transcript.text));
    expect(publicTranscript.lines).toBe(transcript.text ? transcript.text.split("\n").length : 0);
    expect(publicTranscript.lines).toBeLessThanOrEqual(8);
    expect(publicTranscript.bytes).toBeLessThanOrEqual(8 * 1024);
    expect(transcript.text).toContain("secret=[secret-value-redacted]��");
    expect(transcript.text).toContain("/Users/robertsale/private logs");
    expect(transcript.text).toContain("C:\\Users\\Robert\\Library\\Application Support\\Codex\\src\\main.ts");
    expect(transcript.text).toContain("\\\\server\\share name\\artifact");
    expect(transcript.text).toContain("https://example.invalid/api/v1/workspace/secret");
    expect(encoded).not.toContain(secret);
    expect(encoded).toContain("/Users/robertsale/private logs");
    expect(encoded).toContain("https://example.invalid/api/v1/workspace/secret");
    expect(encoded).not.toContain("\u0000");
    expect(encoded).not.toContain("\u0001");
  });

  test("preserves each Compose frame and later causal records while replacing secrets", async () => {
    const docker = new MockDocker();
    const secret = "declared-log-secret-0d9f";
    const configured = runtime();
    configured.config.secretEnvironment = ["REGISTRY_TOKEN"];
    const frames = [
      "INFO request method=GET path=/healthz/ready",
      "ERROR database readiness failed: tenant schema unavailable",
      "Error: readiness failed\n    at bootstrap (/app/server.ts:12:7)",
      "request-id=123e4567-e89b-42d3-a456-426614174000",
      "POSIX /private/tmp/cause",
      "Windows C:\\Users\\Robert\\AppData\\Local\\cause",
      "UNC \\\\server\\share\\cause",
      "URL https://example.invalid/api/v1/secret",
      `secret=${secret}\u0001`,
    ].join("\n");
    docker.responses.push(result('{"services":{"dev":{}}}'), {
      code: 0,
      stdout: Buffer.from(frameComposeLog(frames)),
      stderr: Buffer.alloc(0),
    });

    const transcript = await stackLogs(configured, "dev", 20, docker, { REGISTRY_TOKEN: secret });

    expect(transcript.text).toContain("ERROR database readiness failed: tenant schema unavailable");
    expect(transcript.text).toContain("at bootstrap (/app/server.ts:12:7)");
    expect(transcript.text).toContain("123e4567-e89b-42d3-a456-426614174000");
    expect(transcript.text).toContain("path=/healthz/ready");
    expect(transcript.text).toContain("/private/tmp/cause");
    expect(transcript.text).toContain("C:\\Users\\Robert\\AppData\\Local\\cause");
    expect(transcript.text).toContain("\\\\server\\share\\cause");
    expect(transcript.text).toContain("https://example.invalid/api/v1/secret");
    expect(transcript.text).not.toContain(secret);
    expect(transcript.text).toContain("secret=[secret-value-redacted]�");
    expect(transcript.text).not.toContain("\u0001");
    expect(transcript.truncated).toBe(false);
    expect(transcript.contentRedacted).toBe(true);
  });

  test("fails closed when a declared secret crosses same-stream or merged-stream frames", async () => {
    const secret = "DECLARED_SECRET_12345";
    for (const streams of [
      {
        stdout: [
          "2026-08-08T00:00:00.000000000Z DECLARED_",
          "2026-08-08T00:00:01.000000000Z SECRET_",
          "2026-08-08T00:00:02.000000000Z 12345",
        ].join("\n"),
        stderr: "",
      },
      {
        stdout: "2026-08-08T00:00:02.000000000Z DECLARED_SECRET_",
        stderr: "2026-08-08T00:00:03.000000000Z 12345",
      },
    ]) {
      const docker = new MockDocker();
      const configured = runtime();
      configured.config.secretEnvironment = ["REGISTRY_TOKEN"];
      docker.responses.push(result('{"services":{"dev":{}}}'), {
        code: 0,
        stdout: Buffer.from(streams.stdout),
        stderr: Buffer.from(streams.stderr),
      });

      const transcript = await stackLogs(configured, "dev", 20, docker, { REGISTRY_TOKEN: secret });

      expect(transcript).toEqual({ text: "", truncated: true, contentRedacted: true });
      expect(transcript.text).not.toContain("DECLARED_SECRET_");
      expect(transcript.text).not.toContain("12345");
    }
  });

  test("keeps ordinary whole-frame secret replacement available", async () => {
    const docker = new MockDocker();
    const secret = "DECLARED_SECRET_12345";
    const configured = runtime();
    configured.config.secretEnvironment = ["REGISTRY_TOKEN"];
    docker.responses.push(result('{"services":{"dev":{}}}'), result(
      "2026-08-08T00:00:00.000000000Z secret=DECLARED_SECRET_12345\n" +
        "2026-08-08T00:00:01.000000000Z later-safe-error",
    ));

    const transcript = await stackLogs(configured, "dev", 20, docker, { REGISTRY_TOKEN: secret });

    expect(transcript.text).toContain("secret=[secret-value-redacted]");
    expect(transcript.text).toContain("later-safe-error");
    expect(transcript.truncated).toBe(false);
    expect(transcript.contentRedacted).toBe(true);
  });

  test("fails closed when a declared secret crosses embedded continuation boundaries", async () => {
    const secret = "DECLARED_SECRET_12345";
    for (const value of [
      "2026-08-08T00:00:00.000000000Z DECLARED_SECRET_\n12345",
      "2026-08-08T00:00:00.000000000Z DECLARED_\n\nSECRET_\n12345",
      "2026-08-08T00:00:00.000000000Z DECLARED_\nSECRET_\n2026-08-08T00:00:01.000000000Z 12345",
    ]) {
      const docker = new MockDocker();
      const configured = runtime();
      configured.config.secretEnvironment = ["REGISTRY_TOKEN"];
      docker.responses.push(result('{"services":{"dev":{}}}'), result(value));

      const transcript = await stackLogs(configured, "dev", 20, docker, { REGISTRY_TOKEN: secret });

      expect(transcript).toEqual({ text: "", truncated: true, contentRedacted: true });
    }
  });

  test("scans compose-up stdout and stderr fragments before joining them", () => {
    const secret = "DECLARED_SECRET_12345";
    const redacted = redactComposeFailureWithMetadata(
      "DECLARED_\nSECRET_12345",
      runtime(),
      [secret],
      ["DECLARED_\nSECRET_", "12345"],
    );

    expect(redacted).toEqual({ text: "", contentRedacted: true, incomplete: true });
  });

  test("fails closed when compose-up redaction markers reconstruct a secret", () => {
    const secret = "[redacted]TAIL";
    const redacted = redactComposeFailureWithMetadata(
      `${runtime().metadata.ownerKey}\nTAIL`,
      runtime(),
      [secret],
      [runtime().metadata.ownerKey, "TAIL"],
    );

    expect(redacted).toEqual({ text: "", contentRedacted: true, incomplete: true });
  });

  test("fails closed for one-character and newline-bearing declared secrets", async () => {
    for (const secret of ["x", "line\r\nsecret"]) {
      const docker = new MockDocker();
      const configured = runtime();
      configured.config.secretEnvironment = ["REGISTRY_TOKEN"];
      docker.responses.push(result('{"services":{"dev":{}}}'), result(
        `2026-08-08T00:00:00.000000000Z value=${secret}`,
      ));

      const transcript = await stackLogs(configured, "dev", 20, docker, { REGISTRY_TOKEN: secret });

      if (secret === "x") {
        expect(transcript.text).toContain("value=[secret-value-redacted]");
        expect(transcript.truncated).toBe(false);
        expect(transcript.contentRedacted).toBe(true);
      } else {
        expect(transcript).toEqual({ text: "", truncated: true, contentRedacted: true });
      }
    }
  });

  test.each([
    "2026-00-01T00:00:00.000000000Z value=bad-month",
    "2026-13-01T00:00:00.000000000Z value=bad-month",
    "2026-01-00T00:00:00.000000000Z value=bad-day",
    "2026-04-31T00:00:00.000000000Z value=bad-day",
    "2026-02-29T00:00:00.000000000Z value=bad-non-leap-day",
    "2026-08-08T24:00:00.000000000Z value=bad-hour",
    "2026-08-08T00:60:00.000000000Z value=bad-minute",
    "2026-08-08T00:00:60.000000000Z value=bad-second",
  ])("rejects noncanonical Compose timestamp %s", async (line) => {
    const docker = new MockDocker();
    docker.responses.push(result('{"services":{"dev":{}}}'), result(line));

    const transcript = await stackLogs(runtime(), "dev", 20, docker);

    expect(transcript).toEqual({ text: "[stdout-unavailable]", truncated: true, contentRedacted: true });
  });

  test("accepts leap-day timestamps only on leap years", async () => {
    const docker = new MockDocker();
    docker.responses.push(result('{"services":{"dev":{}}}'), result(
      "2024-02-29T23:59:59.000000000Z leap-day-valid",
    ));

    const transcript = await stackLogs(runtime(), "dev", 20, docker);

    expect(transcript).toEqual({ text: "leap-day-valid", truncated: false, contentRedacted: false });
  });

  test("preserves newline-bearing path continuations within one frame", async () => {
    const docker = new MockDocker();
    docker.responses.push(result('{"services":{"dev":{}}}'), result(
      "2026-08-08T00:00:00.000000000Z open /Users/me/Application\nSupport\nnext diagnostic\n" +
        "2026-08-08T00:00:01.000000000Z DB_READINESS_FALSE",
    ));

    const transcript = await stackLogs(runtime(), "dev", 20, docker);

    expect(transcript.text).toBe("open /Users/me/Application\nSupport\nnext diagnostic\nDB_READINESS_FALSE");
    expect(transcript.text).toContain("Support");
    expect(transcript.text).toContain("next diagnostic");
    expect(transcript.contentRedacted).toBe(false);
  });

  test("rejects malformed or unframed Compose output without publishing a prefix", async () => {
    const docker = new MockDocker();
    docker.responses.push(result('{"services":{"dev":{}}}'), result(
      "INFO request path=/healthz/ready\nERROR database readiness failed\n",
    ));

    const transcript = await stackLogs(runtime(), "dev", 20, docker);

    expect(transcript.text).toBe("[stdout-unavailable]");
    expect(transcript.truncated).toBe(true);
    expect(transcript.contentRedacted).toBe(true);
  });

  test("fails closed when public markers reconstruct a declared secret across captures", async () => {
    const scenarios = [
      { secret: "[stdout-unavailable]TAIL", stdout: "not-a-framed-record\n", stderr: frameComposeLog("TAIL") },
      { secret: "[redacted]TAIL", stdout: frameComposeLog(runtime().metadata.ownerKey), stderr: frameComposeLog("TAIL") },
    ];
    for (const scenario of scenarios) {
      const docker = new MockDocker();
      const configured = runtime();
      configured.config.secretEnvironment = ["REGISTRY_TOKEN"];
      docker.responses.push(result('{"services":{"dev":{}}}'), {
        code: 0,
        stdout: Buffer.from(scenario.stdout),
        stderr: Buffer.from(scenario.stderr),
      });

      const transcript = await stackLogs(configured, "dev", 20, docker, { REGISTRY_TOKEN: scenario.secret });

      expect(transcript).toEqual({ text: "", truncated: true, contentRedacted: true });
    }
  });

  test("fails closed when a declared secret collides with a public marker", async () => {
    const docker = new MockDocker();
    const configured = runtime();
    configured.config.secretEnvironment = ["REGISTRY_TOKEN"];
    docker.responses.push(result('{"services":{"dev":{}}}'), result(
      "not-a-framed-record\n",
    ));

    const transcript = await stackLogs(configured, "dev", 20, docker, {
      REGISTRY_TOKEN: "stdout-unavailable",
    });

    expect(transcript.text).toBe("");
    expect(transcript.contentRedacted).toBe(true);
  });

  test("never publishes retained prefixes from truncated stdout or stderr captures", async () => {
    const secret = "declared-secret-value-split-at-capture-8f31";
    const prefix = secret.slice(0, -1);
    for (const stream of ["stdout", "stderr"] as const) {
      const docker = new MockDocker();
      const configured = runtime();
      configured.config.secretEnvironment = ["REGISTRY_TOKEN"];
      docker.responses.push(result('{"services":{"dev":{}}}'), {
        code: 0,
        stdout: stream === "stdout" ? Buffer.from(`prefix=${prefix}`) : Buffer.alloc(0),
        stderr: stream === "stderr" ? Buffer.from(`prefix=${prefix}`) : Buffer.alloc(0),
        ...(stream === "stdout" ? { stdoutTruncated: true } : { stderrTruncated: true }),
      });

      const transcript = await stackLogs(configured, "dev", 4, docker, { REGISTRY_TOKEN: secret });

      expect(transcript.truncated).toBe(true);
      expect(transcript.text).toContain(`[${stream}-truncated]`);
      expect(transcript.text).not.toContain(prefix);
    }
  });

  test("merges independently framed stdout and stderr records by timestamp", async () => {
    const docker = new MockDocker();
    docker.responses.push(result('{"services":{"dev":{}}}'), {
      code: 0,
      stdout: Buffer.from(frameComposeLog("2026-08-08T00:00:02.000000000Z stdout-later")),
      stderr: Buffer.from(frameComposeLog("2026-08-08T00:00:01.000000000Z stderr-earlier")),
    });

    const transcript = await stackLogs(runtime(), "dev", 2, docker);

    expect(transcript.text).toBe("stderr-earlier\nstdout-later");
    expect(transcript.text.split("\n").length).toBe(2);
    expect(transcript.truncated).toBe(false);
    expect(transcript.contentRedacted).toBe(false);
  });

  test("stack status reduces Compose output to purpose-built service summaries", async () => {
    const docker = new MockDocker();
    docker.responses.push(result(JSON.stringify([{ Service: "dev", State: "running", Health: "healthy", ExitCode: 0,
      ID: "container-secret", Project: "internal-project", Publishers: [{ URL: "0.0.0.0" }] }])));
    expect(await stackStatus(runtime(), docker)).toEqual({ available: true, services: [
      { service: "dev", state: "running", health: "healthy", exitCode: 0 },
    ] });
  });

  test("stack status failures preserve safe evidence while masking exact runtime metadata", async () => {
    const docker = new MockDocker();
    const configured = runtime();
    configured.config.secretEnvironment = ["REGISTRY_TOKEN"];
    const secret = "stack-status-secret-8f31";
    const ownerHash = "b".repeat(64);
    docker.responses.push(resultWithError(
      `compose -f /private/tmp/status/override.yaml --project-name ccl-secret failed for ${ownerHash} ${secret} codex-container-lab:private-image`,
    ));
    const encoded = JSON.stringify(await stackStatus(configured, docker, { environment: { REGISTRY_TOKEN: secret } }));
    expect(encoded).toContain("/private/tmp/status/override.yaml");
    expect(encoded).toContain(ownerHash);
    expect(encoded).toContain("ccl-secret");
    expect(encoded).toContain("codex-container-lab:private-image");
    expect(encoded).toContain("failed");
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain(configured.metadata.runtimeRoot);
  });
});

function runtime(): LabRuntime {
  const metadata = lab();
  return {
    metadata,
    config: {
      repoRoot: "/tmp/source",
      manifestPath: "/tmp/source/.codex-container-lab.yaml",
      mode: { kind: "image", image: "node:24", commandService: "dev" },
      runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] },
      ports: [],
      forwardEnvironment: [],
      secretEnvironment: [],
      sharedImages: [],
    },
    composeArgs: ["compose", "--project-name", "ccl-project"],
    overrideFile: "/tmp/runtime/override.compose.yaml",
    findings: [],
  };
}

function frameComposeLog(value: string): string {
  const timestamp = "2026-08-08T00:00:00.000000000Z";
  return value.split("\n").map((line) => /^\d{4}-\d{2}-\d{2}T/.test(line) ? line : `${timestamp} ${line}`).join("\n");
}

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.once("error", reject);
  });
}

function lab(): LabMetadata {
  return {
    version: 1,
    id: "lab-1",
    name: "lab",
    owner: "thread/exact",
    ownerKey: "a".repeat(64),
    repoHash: "123456789abc",
    composeProject: "ccl-project",
    state: "failed",
    sourceRoot: "/tmp/source",
    runtimeRoot: "/tmp/runtime",
    workspace: "/tmp/runtime/workspace",
    manifestPath: "/tmp/source/.codex-container-lab.yaml",
    commandService: "dev",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    endpoints: [],
    findings: [],
    secretEnvironment: [],
  };
}

function labAt(root: string): LabMetadata {
  const runtimeRoot = join(root, "runtime");
  return {
    ...lab(),
    sourceRoot: join(root, "source"),
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(root, "source", ".codex-container-lab.yaml"),
  };
}

function result(stdout: string, code = 0): CommandResult {
  return { code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

function resultWithError(stderr: string): CommandResult {
  return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) };
}

function emptyResourceListings(): CommandResult[] {
  return Array.from({ length: 6 }, () => result(""));
}

function exactImageLabels(): Record<string, string> {
  return {
    "io.openai.codex-container-lab.managed": "true",
    "io.openai.codex-container-lab.owner": "thread/exact",
    "io.openai.codex-container-lab.lab": "lab-1",
  };
}
