import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { parseLabConfig } from "./config";
import {
  composeCommandArgs,
  generateBaseCompose,
  generateOverrideCompose,
  inspectComposeModel,
  type ComposeModel,
} from "./compose";

const repoRoot = "/tmp/example-repository";

describe("Compose generation", () => {
  test("builds one internal service for image and dockerfile shorthand", () => {
    const imageConfig = parseLabConfig(`
image: { name: node:24, service: dev }
runtime: { workspace: /src, shell: [/bin/bash, -lc] }
`, repoRoot);
    expect(parseYaml(generateBaseCompose(imageConfig)!)).toEqual({
      services: {
        dev: {
          working_dir: "/src",
          command: ["/bin/bash", "-lc", "while :; do sleep 2147483647; done"],
          image: "node:24",
        },
      },
    });

    const dockerfileConfig = parseLabConfig(`
dockerfile: { path: Dockerfile.dev, context: ., service: dev }
`, repoRoot);
    const base = parseYaml(generateBaseCompose(dockerfileConfig)!);
    expect(base.services.dev.build).toEqual({
      context: repoRoot,
      dockerfile: `${repoRoot}/Dockerfile.dev`,
    });
    const override = parseYaml(generateOverrideCompose(dockerfileConfig, { services: { dev: {} } }, {
      workspaceHostPath: "/tmp/workspace", owner: "thread", ownerKey: "a".repeat(64), labId: "lab",
    }));
    expect(override.services.dev.image).toBe(`codex-container-lab:${"a".repeat(24)}-lab`);
    expect(override.services.dev.build.labels).toEqual({
      "io.openai.codex-container-lab.managed": "true",
      "io.openai.codex-container-lab.owner": "thread",
      "io.openai.codex-container-lab.lab": "lab",
    });
  });

  test("generates managed overrides across normalized resources", () => {
    const config = parseLabConfig(`
compose: { files: [compose.yaml], command_service: api }
runtime: { workspace: /src, shell: [/bin/sh, -lc] }
ports:
  web: { service: api, target: 8080, scheme: http }
  metrics: { service: database, target: 9187 }
environment: [TERM]
`, repoRoot);
    const model: ComposeModel = {
      services: { api: {}, database: {} },
      volumes: { data: {}, host_data: { external: true } },
      networks: { backend: {}, shared: { external: { name: "shared-network" } } },
    };
    const override = parseYaml(generateOverrideCompose(config, model, {
      workspaceHostPath: "/tmp/lab/workspace",
      owner: "thread-1",
      ownerKey: "a".repeat(64),
      labId: "lab-2",
    }));

    const labels = {
      "io.openai.codex-container-lab.managed": "true",
      "io.openai.codex-container-lab.owner": "thread-1",
      "io.openai.codex-container-lab.lab": "lab-2",
    };
    expect(override.services.database).toEqual({ labels, ports: ["127.0.0.1::9187"] });
    expect(override.services.api).toEqual({
      labels,
      init: true,
      working_dir: "/src",
      volumes: [
        { type: "bind", source: "/tmp/lab/workspace", target: "/src" },
      ],
      ports: ["127.0.0.1::8080"],
      environment: ["TERM"],
    });
    expect(override.volumes.data).toEqual({ labels });
    expect(override.networks.backend).toEqual({ labels });
    expect(override.volumes.host_data).toBeUndefined();
    expect(override.networks.shared).toBeUndefined();
  });

  test("requires the configured command service", () => {
    const config = parseLabConfig("image: { name: node:24, service: dev }", repoRoot);
    expect(() => generateOverrideCompose(config, { services: { other: {} } }, {
      workspaceHostPath: "/tmp/workspace",
      owner: "thread",
      ownerKey: "a".repeat(64),
      labId: "l",
    })).toThrow("command service is absent");
  });

  test("requires each declared port service in the normalized model", () => {
    const config = parseLabConfig(`
image: { name: node:24, service: dev }
ports:
  web: { service: missing, target: 8080 }
`, repoRoot);
    expect(() => generateOverrideCompose(config, { services: { dev: {} } }, {
      workspaceHostPath: "/tmp/workspace",
      owner: "thread",
      ownerKey: "a".repeat(64),
      labId: "l",
    })).toThrow("declared port web references absent service");
  });

  test("rejects a declared target already published by project Compose", () => {
    const config = parseLabConfig(`
image: { name: node:24, service: dev }
ports:
  web: { service: dev, target: 8080 }
`, repoRoot);
    expect(() => generateOverrideCompose(config, { services: { dev: { ports: [{ target: 8080, published: "8080" }] } } }, {
      workspaceHostPath: "/tmp/workspace", owner: "thread", ownerKey: "a".repeat(64), labId: "l",
    })).toThrow("overlaps a project publication");
  });

  test("preserves project directory and source Compose file order", () => {
    const config = parseLabConfig(`
compose:
  files: [compose.yaml, compose.local.yaml]
  command_service: api
`, repoRoot);
    expect(composeCommandArgs(config, {
      projectName: "ccl-session-lab",
      overrideFile: "/tmp/lab/override.yaml",
    })).toEqual([
      "compose",
      "--project-directory", repoRoot,
      "--project-name", "ccl-session-lab",
      "-f", `${repoRoot}/compose.yaml`,
      "-f", `${repoRoot}/compose.local.yaml`,
      "-f", "/tmp/lab/override.yaml",
    ]);
  });
});

describe("inspectComposeModel", () => {
  test("reports notable privilege surfaces and redacts sensitive details", () => {
    const findings = inspectComposeModel({
      services: {
        api: {
          privileged: true,
          pid: "host",
          cap_add: ["SYS_ADMIN"],
          devices: ["/dev/kvm:/dev/kvm"],
          volumes: [
            { type: "bind", source: "/Users/example/private", target: "/src" },
            "/var/run/docker.sock:/var/run/docker.sock",
          ],
          ports: [
            { target: 3000, published: "3000", host_ip: "0.0.0.0" },
            { target: 4000, published: "0", host_ip: "127.0.0.1" },
          ],
          secrets: ["production-token"],
          configs: [{ source: "private-config" }],
        },
      },
      secrets: { "production-token": { file: "/private/token" } },
      configs: { "private-config": { file: "/private/config" } },
    });

    expect(findings.map((finding) => finding.surface)).toEqual([
      "privileged",
      "host-namespace",
      "capability",
      "device",
      "host-bind",
      "host-bind",
      "socket-bind",
      "fixed-port",
      "non-loopback-port",
      "secret",
      "config",
      "secret",
      "config",
    ]);
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain("/Users/example/private");
    expect(serialized).not.toContain("docker.sock");
    expect(serialized).not.toContain("production-token");
    expect(serialized).not.toContain("private-config");
    expect(serialized).not.toContain("3000");
  });

  test("does not flag random loopback publication", () => {
    expect(inspectComposeModel({ services: { api: { ports: ["127.0.0.1::8080"] } } })).toEqual([]);
  });

  test("reports engine API and build credential forwarding without exposing identities", () => {
    const findings = inspectComposeModel({ services: { api: {
      use_api_socket: true,
      build: { ssh: ["default"], secrets: ["registry-token"] },
    } } });
    expect(findings.map((finding) => finding.surface)).toEqual(["socket-bind", "secret", "secret"]);
    expect(JSON.stringify(findings)).not.toContain("registry-token");
    expect(JSON.stringify(findings)).not.toContain("default");
  });
});
