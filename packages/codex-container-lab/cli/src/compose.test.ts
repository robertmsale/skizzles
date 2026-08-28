import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { parseLabConfig } from "./config";
import {
  composeCommandArgs,
  generateBaseCompose,
  generateOverrideCompose,
  inspectComposeModel,
  SHARED_COMPILER_CACHE_CONTAINER,
  SHARED_COMPILER_CACHE_ENDPOINT,
  SHARED_COMPILER_CACHE_NETWORK,
  validateSecretEnvironmentModel,
  type ComposeModel,
  assertMappedServicesConsumeSharedImages,
  inspectProjectScopedBuilds,
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

  test("adds the external shared compiler cache without replacing project networks or images", () => {
    const config = parseLabConfig(`
image: { name: downstream-owned:latest, service: dev }
runtime: { compiler_cache: sccache-redis }
`, repoRoot);
    const override = parseYaml(generateOverrideCompose(config, {
      services: { dev: { networks: { backend: { aliases: ["dev"] } } } },
      networks: { backend: {} },
    }, {
      workspaceHostPath: "/tmp/workspace",
      owner: "thread",
      ownerKey: "a".repeat(64),
      labId: "lab",
    }));

    expect(override.services.dev.environment).toEqual([
      `SCCACHE_REDIS_ENDPOINT=${SHARED_COMPILER_CACHE_ENDPOINT}`,
    ]);
    expect(override.services.dev.networks).toEqual({
      backend: { aliases: ["dev"] },
      [SHARED_COMPILER_CACHE_NETWORK]: {},
    });
    expect(override.networks[SHARED_COMPILER_CACHE_NETWORK]).toEqual({
      external: true,
      name: SHARED_COMPILER_CACHE_NETWORK,
    });
    expect(override.services.dev.image).toBeUndefined();
    expect(JSON.stringify(override)).not.toContain("RUSTC_WRAPPER");
    expect(SHARED_COMPILER_CACHE_CONTAINER).toBe("skizzles-sccache-redis");
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

  test("maps shared environment images and resets leftover project builds", () => {
    const config = parseLabConfig(`
compose: { files: [compose.yaml], command_service: app }
shared_images:
  toolchain:
    context: environment
    dockerfile: environment/Dockerfile
    platform: linux/arm64
    services: [app]
`, repoRoot);
    const digest = "ab".repeat(32);
    const imageId = `sha256:${"cd".repeat(32)}`;
    const reference = {
      profile: "toolchain",
      digest,
      imageId,
      tag: `skizzles-shared-image:env-${digest}`,
    };
    const yaml = generateOverrideCompose(config, { services: { app: {}, worker: { build: "." } } }, {
      workspaceHostPath: "/tmp/lab/workspace",
      owner: "thread-1",
      ownerKey: "a".repeat(64),
      labId: "lab-2",
    }, [reference]);
    expect(yaml).toContain("!reset");
    expect(yaml).toContain(imageId);
    expect(yaml).toMatch(new RegExp(`image:\\s*${imageId}`));
    expect(yaml).toMatch(/pull_policy:\s*never/);
    expect(inspectProjectScopedBuilds({ services: { app: { build: "." }, worker: { build: "." } } }, new Set(["app"])))
      .toEqual([{ service: "worker", surface: "project-build", detail: "service keeps a project-scoped Compose build" }]);
    expect(() => assertMappedServicesConsumeSharedImages({
      services: { app: { image: imageId } },
    }, config, [reference])).not.toThrow();
    expect(() => assertMappedServicesConsumeSharedImages({
      services: { app: { image: imageId, build: "." } },
    }, config, [reference])).toThrow("project-scoped build path");
    expect(() => assertMappedServicesConsumeSharedImages({
      services: { app: { image: imageId, pull_policy: "always" } },
    }, config, [reference])).toThrow("pull policy");
    expect(() => assertMappedServicesConsumeSharedImages({
      services: { app: { image: imageId, pull_policy: "build" } },
    }, config, [reference])).toThrow("pull policy");
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

describe("validateSecretEnvironmentModel", () => {
  test("accepts an allowlisted present top-level environment secret source", () => {
    expect(() => validateSecretEnvironmentModel({
      services: { api: {} },
      secrets: { token: { environment: "REGISTRY_TOKEN" } },
    }, ["REGISTRY_TOKEN"], { REGISTRY_TOKEN: "sentinel-value" })).not.toThrow();
  });

  test("rejects undeclared and unavailable environment secret sources using names only", () => {
    expect(() => validateSecretEnvironmentModel({
      secrets: { token: { environment: "UNDECLARED_TOKEN" } },
    }, [], { UNDECLARED_TOKEN: "sentinel-value" })).toThrow("not declared: UNDECLARED_TOKEN");
    expect(() => validateSecretEnvironmentModel({
      secrets: { token: { environment: "MISSING_TOKEN" } },
    }, ["MISSING_TOKEN"], {})).toThrow("unavailable: MISSING_TOKEN");
  });

  test("rejects name references from plaintext service environment without value matching", () => {
    for (const environment of [
      { REGISTRY_TOKEN: "literal-does-not-matter" },
      { OTHER: "${REGISTRY_TOKEN}" },
      ["OTHER=$REGISTRY_TOKEN"],
    ]) {
      expect(() => validateSecretEnvironmentModel({ services: { api: { environment } } },
        ["REGISTRY_TOKEN"], { REGISTRY_TOKEN: "sentinel-value" })).toThrow("api:REGISTRY_TOKEN");
    }
    expect(() => validateSecretEnvironmentModel({
      services: { api: { environment: { OTHER: "common-value" } } },
    }, ["REGISTRY_TOKEN"], { REGISTRY_TOKEN: "common-value" })).not.toThrow();
  });

  test("rejects declared secret references throughout the normalized model", () => {
    const models: ComposeModel[] = [
      { services: { api: { command: ["/bin/sh", "-lc", "echo $REGISTRY_TOKEN"] } } },
      { services: { api: { build: { args: { TOKEN: "${REGISTRY_TOKEN}" } } } } },
      { services: { api: { labels: { "example.leak": "token=${REGISTRY_TOKEN:-missing}" } } } },
      { services: { api: { healthcheck: { test: ["CMD-SHELL", "test -n \"${REGISTRY_TOKEN/untrusted}\""] } } } },
    ];
    for (const model of models) {
      expect(() => validateSecretEnvironmentModel(model, ["REGISTRY_TOKEN"], {
        REGISTRY_TOKEN: "sentinel-value",
      })).toThrow("Compose model references declared secret environment source: REGISTRY_TOKEN");
    }
  });

  test("accepts normal secret source declarations and service attachments", () => {
    expect(() => validateSecretEnvironmentModel({
      services: { api: { secrets: ["REGISTRY_TOKEN", { source: "REGISTRY_TOKEN", target: "registry-token" }] } },
      secrets: { REGISTRY_TOKEN: { environment: "REGISTRY_TOKEN" } },
    }, ["REGISTRY_TOKEN"], { REGISTRY_TOKEN: "sentinel-value" })).not.toThrow();
  });
});
