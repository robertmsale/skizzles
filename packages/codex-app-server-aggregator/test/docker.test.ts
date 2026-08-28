import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendConnection } from "../src/backend.ts";
import {
  APP_SERVER_READY_MARKER,
  DockerBackendFactory,
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
      repoUrl: "https://example.invalid/repository.git",
      dockerBinary,
    });
    const transport = await factory.create();
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
});

function fakeDockerScript(logPath: string, startupDelayMs: number): string {
  return `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
if (args[0] === "create") {
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
