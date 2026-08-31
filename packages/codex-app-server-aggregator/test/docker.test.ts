import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendConnection } from "../src/backend.ts";
import {
  APP_SERVER_READY_MARKER,
  DockerBackendFactory,
  validateCodexHomeTemplate,
} from "../src/docker.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Docker backend process boundary", () => {
  test("starts the RPC timeout only after the attached container reports app-server readiness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "skizzles-docker-boundary-"));
    temporaryDirectories.push(directory);
    const logPath = join(directory, "docker.log");
    const dockerBinary = join(directory, "docker");
    writeFileSync(dockerBinary, fakeDockerScript(logPath, 100));
    chmodSync(dockerBinary, 0o755);

    const factory = new DockerBackendFactory({
      dockerBinary,
      hostGatewayMode: "native",
    });
    const transport = await factory.create({
      cwd: join(directory, "project"),
      cloneUrl: "https://example.invalid/repository.git",
      createdAt: 1,
      updatedAt: 1,
    });
    const backend = new BackendConnection(transport, {
      onNotification: () => undefined,
      onServerRequest: () => undefined,
    }, { requestTimeoutMs: 50 });

    const startedAt = performance.now();
    const outcome = await backend.initialize({
      clientInfo: { name: "test", title: "Test", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    expect(outcome).toMatchObject({ result: { platformOs: "linux" } });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(75);

    const timedOut = await backend.call("model/list", {});
    expect(timedOut).toEqual({ error: { code: -32002, message: "backend request timed out: model/list" } });
    await backend.close();
    expect(readFileSync(logPath, "utf8")).toContain("rm --force fake-container");
  });

  test("uses native backend DNS unless an operator explicitly requests host-gateway", async () => {
    const directory = mkdtempSync(join(tmpdir(), "skizzles-docker-network-"));
    temporaryDirectories.push(directory);
    const logPath = join(directory, "docker.log");
    const dockerBinary = join(directory, "docker");
    writeFileSync(dockerBinary, fakeDockerScript(logPath, 0, "orbstack"));
    chmodSync(dockerBinary, 0o755);
    const project = {
      cwd: join(directory, "project"),
      cloneUrl: "https://example.invalid/repository.git",
      createdAt: 1,
      updatedAt: 1,
    };

    const native = new DockerBackendFactory({ dockerBinary, hostGatewayMode: "native" });
    const nativeTransport = await native.create(project);
    await nativeTransport.ready;
    await nativeTransport.destroy();
    expect(readFileSync(logPath, "utf8")).not.toContain("--add-host");

    writeFileSync(logPath, "");
    const automatic = new DockerBackendFactory({ dockerBinary, hostGatewayMode: "auto" });
    const automaticTransport = await automatic.create(project);
    await automaticTransport.ready;
    await automaticTransport.destroy();
    const automaticLog = readFileSync(logPath, "utf8");
    expect(automaticLog).toContain("context show");
    expect(automaticLog).not.toContain("--add-host");

    writeFileSync(logPath, "");
    writeFileSync(dockerBinary, fakeDockerScript(logPath, 0, "remote-linux", "tcp://docker.example.test:2376"));
    const remote = new DockerBackendFactory({ dockerBinary, hostGatewayMode: "auto" });
    const remoteTransport = await remote.create(project);
    await remoteTransport.ready;
    await remoteTransport.destroy();
    const remoteLog = readFileSync(logPath, "utf8");
    expect(remoteLog).toContain("context inspect remote-linux");
    expect(remoteLog).toContain("--add-host host.docker.internal:host-gateway");

    writeFileSync(logPath, "");
    const gateway = new DockerBackendFactory({
      dockerBinary,
      containerHost: "host.orbstack.internal",
      hostGatewayMode: "host-gateway",
    });
    const gatewayTransport = await gateway.create(project);
    await gatewayTransport.ready;
    await gatewayTransport.destroy();
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("--add-host host.orbstack.internal:host-gateway");
    expect(log).toContain("CODEX_AGGREGATOR_CONTAINER_HOST=host.orbstack.internal");
  });

  test("accepts only sanitized, self-contained Codex home templates", () => {
    const directory = mkdtempSync(join(tmpdir(), "skizzles-codex-home-template-"));
    temporaryDirectories.push(directory);
    const seed = join(directory, "seed");
    mkdirSync(seed);
    writeFileSync(join(seed, "config.toml"), [
      'model_catalog_json = "models.json"',
      "[model_providers.opencodex]",
      'base_url = "http://{{SKIZZLES_CONTAINER_HOST}}:8080/v1"',
      "",
    ].join("\n"));
    writeFileSync(join(seed, "models.json"), JSON.stringify({ models: [{ id: "grok" }] }));
    expect(validateCodexHomeTemplate(seed)).toBe(seed);

    writeFileSync(join(seed, "auth.json"), "{}");
    expect(() => validateCodexHomeTemplate(seed)).toThrow("runtime or secret state");
    rmSync(join(seed, "auth.json"));

    mkdirSync(join(seed, "profiles", "sessions"), { recursive: true });
    expect(() => validateCodexHomeTemplate(seed)).toThrow("runtime or secret state: profiles/sessions");
    rmSync(join(seed, "profiles"), { recursive: true });

    writeFileSync(join(seed, ".env.local"), "TOKEN=secret\n");
    expect(() => validateCodexHomeTemplate(seed)).toThrow("runtime or secret state: .env.local");
    rmSync(join(seed, ".env.local"));

    symlinkSync(join(seed, "models.json"), join(seed, "linked-models.json"));
    expect(() => validateCodexHomeTemplate(seed)).toThrow("contains a symlink");
  });
});

function fakeDockerScript(
  logPath: string,
  startupDelayMs: number,
  contextName?: string,
  contextHost?: string,
): string {
  return `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const contextName = ${JSON.stringify(contextName ?? null)};
const contextHost = ${JSON.stringify(contextHost ?? null)};
appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
if (args[0] === "context" && args[1] === "show" && contextName) {
  process.stdout.write(contextName + "\\n");
} else if (args[0] === "context" && args[1] === "inspect" && contextHost) {
  process.stdout.write(JSON.stringify([{ Endpoints: { docker: { Host: contextHost } } }]) + "\\n");
} else if (args[0] === "create") {
  process.stdout.write("fake-container\\n");
} else if (args[0] === "start") {
  await Bun.sleep(${startupDelayMs});
  process.stdout.write(${JSON.stringify(`${APP_SERVER_READY_MARKER}\n`)});
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: {
          userAgent: "fake-codex/0.149.1",
          codexHome: "/codex-home",
          platformFamily: "unix",
          platformOs: "linux",
        },
      }) + "\\n");
    }
  }
} else if (args[0] !== "rm") {
  process.exitCode = 2;
}
`;
}
