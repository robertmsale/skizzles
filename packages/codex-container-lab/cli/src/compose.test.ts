import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { parseLabConfig } from "./config";
import {
  composeCommandArgs,
  generateBaseCompose,
  generateOverrideCompose,
  inspectComposeModel,
  validateReservedBuildxConfigModel,
  validateSecretEnvironmentModel,
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

describe("validateReservedBuildxConfigModel", () => {
  test("rejects reserved environment keys and list entries", () => {
    const models: ComposeModel[] = [
      { services: { api: { environment: ["BUILDX_CONFIG"] } } },
      { services: { api: { environment: ["BUILDX_CONFIG=/tmp/forwarded"] } } },
      { services: { api: { environment: { BUILDX_CONFIG: "/tmp/forwarded" } } } },
      { services: { api: { build: { args: ["BUILDX_CONFIG", "OTHER=value"] } } } },
      { services: { api: { build: { args: { BUILDX_CONFIG: "/tmp/forwarded" } } } } },
    ];
    for (const model of models) {
      expect(() => validateReservedBuildxConfigModel(model)).toThrow("reserved BUILDX_CONFIG");
    }
  });

  test("rejects interpolation references across bind sources, nested build args, labels, and commands", () => {
    const references = [
      "$BUILDX_CONFIG",
      "${BUILDX_CONFIG}",
      "${BUILDX_CONFIG:-/fallback}",
      "${BUILDX_CONFIG-/fallback}",
      "${BUILDX_CONFIG:?required}",
      "${BUILDX_CONFIG?required}",
      "${BUILDX_CONFIG:+/replacement}",
      "${BUILDX_CONFIG+/replacement}",
    ];
    for (const reference of references) {
      for (const model of [
        { services: { api: { volumes: [{ type: "bind", source: reference, target: "/config" }] } } },
        { services: { api: { build: { args: { NESTED: { value: reference } } } } } },
        { services: { api: { labels: { "example.value": reference } } } },
        { services: { api: { command: ["/bin/sh", "-lc", reference] } } },
      ] satisfies ComposeModel[]) {
        expect(() => validateReservedBuildxConfigModel(model)).toThrow("reserved BUILDX_CONFIG");
      }
    }
  });

  test("allows similar names, literal prose, and Compose-escaped dollar signs", () => {
    expect(() => validateReservedBuildxConfigModel({
      services: {
        api: {
          command: ["echo BUILDX_CONFIG", "$BUILDX_CONFIGURATION", "${BUILDX_CONFIG_SUFFIX}"],
          labels: { "example.text": "a literal BUILDX_CONFIG appears here" },
          volumes: ["$$BUILDX_CONFIG:/literal"],
          environment: ["OTHER=BUILDX_CONFIG"],
        },
      },
    })).not.toThrow();
  });

  test("walks nested arrays and objects without allowing a bypass", () => {
    expect(() => validateReservedBuildxConfigModel({
      services: { api: { extension: [{ nested: [{ deeper: { value: "${BUILDX_CONFIG}" } }] }] } },
    })).toThrow("reserved BUILDX_CONFIG");
  });

  test("fails closed on structurally unbounded models", () => {
    const values = Array.from({ length: 100_001 }, () => "literal");
    expect(() => validateReservedBuildxConfigModel({ services: { api: { command: values } } })).toThrow("reserved BUILDX_CONFIG");
  });

  test("stops before traversing a wide array or object fanout", () => {
    let arrayReads = 0;
    const wideArray = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") return 1_000_000;
        if (typeof property === "string" && /^\d+$/.test(property)) arrayReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => validateReservedBuildxConfigModel({ services: { api: { command: wideArray } } })).toThrow("reserved BUILDX_CONFIG");
    expect(arrayReads).toBeLessThan(100_000);

    const keys = Array.from({ length: 100_001 }, (_, index) => `literal-${index}`);
    let objectReads = 0;
    const wideObject = new Proxy(Object.create(null) as Record<string, unknown>, {
      ownKeys: () => keys,
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: "literal" }),
      get: (_target, property) => {
        if (typeof property === "string") objectReads++;
        return "literal";
      },
    });
    expect(() => validateReservedBuildxConfigModel({ services: { api: { extension: wideObject } } })).toThrow("reserved BUILDX_CONFIG");
    expect(objectReads).toBeLessThan(keys.length);
  });
});
