import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { BackendFactory, BackendTransport } from "./backend.ts";
import type { RegisteredProject } from "./state.ts";

export const CONTAINER_WORKSPACE = "/workspace/repo";
export const DEFAULT_IMAGE = "skizzles/codex-app-server:0.149.1";
export const APP_SERVER_READY_MARKER = "__SKIZZLES_CODEX_APP_SERVER_READY__";

export type DockerBackendOptions = {
  image?: string | undefined;
  codexHomeTemplate?: string | undefined;
  providerCommand?: string | undefined;
  providerReadyUrl?: string | undefined;
  passEnv?: string[] | undefined;
  dockerBinary?: string | undefined;
  containerHost?: string | undefined;
  hostGatewayMode?: HostGatewayMode | undefined;
};

export type HostGatewayMode = "auto" | "native" | "host-gateway";

export class DockerBackendFactory implements BackendFactory {
  private readonly options: Omit<
    DockerBackendOptions,
    "image" | "dockerBinary" | "containerHost" | "hostGatewayMode"
  > & {
    image: string;
    dockerBinary: string;
    containerHost: string;
    hostGatewayMode: HostGatewayMode;
  };

  constructor(options: DockerBackendOptions) {
    const image = options.image ?? DEFAULT_IMAGE;
    const dockerBinary = options.dockerBinary ?? "docker";
    validateText("image", image);
    validateText("docker binary", dockerBinary);
    if (options.codexHomeTemplate) {
      const path = validateCodexHomeTemplate(options.codexHomeTemplate);
      options = { ...options, codexHomeTemplate: path };
    }
    const containerHost = options.containerHost ?? "host.docker.internal";
    validateHostname(containerHost);
    const hostGatewayMode = options.hostGatewayMode ?? "auto";
    if (!(["auto", "native", "host-gateway"] as const).includes(hostGatewayMode)) {
      throw new Error(`invalid host gateway mode: ${hostGatewayMode}`);
    }
    for (const name of options.passEnv ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid environment variable name: ${name}`);
    }
    this.options = { ...options, image, dockerBinary, containerHost, hostGatewayMode };
  }

  async create(project: RegisteredProject): Promise<BackendTransport> {
    if (project.cloneUrl === null) {
      throw new Error(`project is host-only because it has no container-reachable Git origin: ${project.cwd}`);
    }
    validateText("repo URL", project.cloneUrl);
    const machineId = crypto.randomUUID();
    const name = `skizzles-codex-${machineId}`;
    const args = [
      "create",
      "--interactive",
      "--name", name,
      "--label", "dev.skizzles.codex-aggregator=true",
      "--label", `dev.skizzles.machine-id=${machineId}`,
      "--env", `CODEX_AGGREGATOR_REPO_URL=${project.cloneUrl}`,
      "--env", `CODEX_AGGREGATOR_WORKSPACE=${CONTAINER_WORKSPACE}`,
      "--env", `CODEX_AGGREGATOR_CONTAINER_HOST=${this.options.containerHost}`,
    ];
    const gatewayMode = await resolveHostGatewayMode(
      this.options.dockerBinary,
      this.options.hostGatewayMode,
    );
    if (gatewayMode === "host-gateway") {
      args.push("--add-host", `${this.options.containerHost}:host-gateway`);
    }
    if (this.options.providerCommand) args.push("--env", `CODEX_AGGREGATOR_PROVIDER_COMMAND=${this.options.providerCommand}`);
    if (this.options.providerReadyUrl) args.push("--env", `CODEX_AGGREGATOR_PROVIDER_READY_URL=${this.options.providerReadyUrl}`);
    for (const name of this.options.passEnv ?? []) args.push("--env", name);
    if (this.options.codexHomeTemplate) {
      args.push("--mount", `type=bind,src=${this.options.codexHomeTemplate},dst=/codex-home-seed,readonly`);
    }
    args.push(this.options.image);

    let containerId: string | undefined;
    try {
      containerId = (await runDocker(this.options.dockerBinary, args)).trim();
      if (!containerId) throw new Error("docker create returned no container id");
      const process = Bun.spawn([this.options.dockerBinary, "start", "--attach", "--interactive", containerId], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      return new DockerTransport({
        machineId,
        containerId,
        workspace: CONTAINER_WORKSPACE,
        dockerBinary: this.options.dockerBinary,
        process,
      });
    } catch (error) {
      if (containerId) await removeContainer(this.options.dockerBinary, containerId);
      throw error;
    }
  }

  async remove(containerId: string): Promise<void> {
    await removeContainer(this.options.dockerBinary, containerId);
  }

  async inspect(containerId: string): Promise<string | null> {
    const process = Bun.spawn([
      this.options.dockerBinary,
      "inspect",
      "--format",
      "{{.State.Status}}",
      containerId,
    ], { stdout: "pipe", stderr: "ignore" });
    const [stdout, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited]);
    return exitCode === 0 ? stdout.trim() || "unknown" : null;
  }
}

class DockerTransport implements BackendTransport {
  readonly machineId: string;
  readonly containerId: string;
  readonly workspace: string;
  readonly kind = "container" as const;
  readonly disposable = true;
  readonly ready: Promise<void>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  private destroyPromise: Promise<void> | undefined;
  private destroyed = false;
  private inputEnded = false;

  constructor(private readonly values: {
    machineId: string;
    containerId: string;
    workspace: string;
    dockerBinary: string;
    process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  }) {
    this.machineId = values.machineId;
    this.containerId = values.containerId;
    this.workspace = values.workspace;
    const gated = gateOnReady(values.process.stdout);
    this.ready = gated.ready;
    this.stdout = gated.stdout;
    this.stderr = values.process.stderr;
  }

  write(line: string): void {
    if (this.destroyed || this.inputEnded) throw new Error(`container ${this.containerId} is closed`);
    this.values.process.stdin.write(line);
    this.values.process.stdin.flush();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.destroyPromise) return this.destroyPromise;
    const attempt = (async () => {
      if (!this.inputEnded) {
        this.inputEnded = true;
        this.values.process.stdin.end();
      }
      await removeContainer(this.values.dockerBinary, this.containerId);
      this.destroyed = true;
      await Promise.race([this.values.process.exited, Bun.sleep(2_000).then(() => this.values.process.kill())]);
    })();
    this.destroyPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.destroyPromise === attempt) this.destroyPromise = undefined;
      throw error;
    }
  }
}

function gateOnReady(source: ReadableStream<Uint8Array>): {
  ready: Promise<void>;
  stdout: ReadableStream<Uint8Array>;
} {
  const expected = new TextEncoder().encode(`${APP_SERVER_READY_MARKER}\n`);
  const reader = source.getReader();
  let offset = 0;
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = (reason: unknown): Error => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (!settled) {
      settled = true;
      rejectReady(error);
    }
    return error;
  };

  const stdout = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (offset !== expected.length) {
              controller.error(fail("container exited before app-server readiness"));
            } else {
              controller.close();
            }
            return;
          }

          let index = 0;
          while (offset < expected.length && index < value.length) {
            if (value[index] !== expected[offset]) {
              controller.error(fail("container stdout did not begin with the app-server readiness marker"));
              await reader.cancel().catch(() => undefined);
              return;
            }
            offset++;
            index++;
          }
          if (offset !== expected.length) continue;
          if (!settled) {
            settled = true;
            resolveReady();
          }
          if (index < value.length) controller.enqueue(value.slice(index));
          return;
        }
      } catch (error) {
        controller.error(fail(error));
      }
    },
    async cancel(reason) {
      fail(reason ?? "container stdout was cancelled before app-server readiness");
      await reader.cancel(reason);
    },
  });
  return { ready, stdout };
}

async function runDocker(binary: string, args: string[]): Promise<string> {
  const process = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`docker ${args[0] ?? "command"} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  return stdout;
}

async function removeContainer(binary: string, containerId: string): Promise<void> {
  const process = Bun.spawn([binary, "rm", "--force", containerId], { stdout: "ignore", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`docker rm failed: ${stderr.trim() || `exit ${exitCode}`}`);
}

function validateText(label: string, value: string): void {
  if (!value.trim() || /[\0\r\n]/.test(value)) throw new Error(`invalid ${label}`);
}

function validateHostname(value: string): void {
  if (
    value.length > 253 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) ||
    value.split(".").some((part) => part.length > 63 || part.startsWith("-") || part.endsWith("-"))
  ) {
    throw new Error(`invalid container host name: ${value}`);
  }
}

async function resolveHostGatewayMode(binary: string, requested: HostGatewayMode): Promise<Exclude<HostGatewayMode, "auto">> {
  if (requested !== "auto") return requested;
  try {
    const context = (await runDocker(binary, ["context", "show"])).trim();
    if (/orbstack|desktop|colima|rancher/.test(context.toLowerCase())) return "native";
    const inspected = JSON.parse(await runDocker(binary, ["context", "inspect", context])) as unknown;
    const first = Array.isArray(inspected) ? inspected[0] : undefined;
    const endpoints = first !== null && typeof first === "object"
      ? (first as Record<string, unknown>).Endpoints
      : undefined;
    const docker = endpoints !== null && typeof endpoints === "object"
      ? (endpoints as Record<string, unknown>).docker
      : undefined;
    const endpoint = docker !== null && typeof docker === "object"
      ? (docker as Record<string, unknown>).Host
      : undefined;
    if (typeof endpoint === "string" && /orbstack|docker\.desktop|colima|rancher/.test(endpoint.toLowerCase())) {
      return "native";
    }
    if (typeof endpoint === "string" && /^(?:tcp|ssh):\/\//.test(endpoint)) return "host-gateway";
    if (typeof endpoint === "string" && endpoint.startsWith("unix://") && process.platform !== "linux") {
      return "native";
    }
  } catch {
    // Fall back to the platform default when context discovery is unavailable.
  }
  return process.platform === "linux" ? "host-gateway" : "native";
}

export function validateCodexHomeTemplate(rawPath: string): string {
  const path = resolve(rawPath);
  const root = lstatSync(path);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error(`Codex home template is not a regular directory: ${path}`);
  }

  const forbidden = new Set([
    ".env",
    "auth.json",
    "credentials.json",
    "history.jsonl",
    "sessions",
    "rollouts",
    "logs",
    "log",
    "cache",
    "tmp",
  ]);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      const relativePath = relative(path, entryPath);
      const normalizedName = entry.name.toLowerCase();
      const isSecret = normalizedName === ".env"
        || normalizedName.startsWith(".env.")
        || normalizedName === "auth.json"
        || normalizedName === "credentials.json";
      if (forbidden.has(normalizedName) || isSecret || /(?:^|\.)sqlite3?$|\.db$/i.test(entry.name)) {
        throw new Error(`Codex home template contains runtime or secret state: ${relativePath}`);
      }
      if (entry.isSymbolicLink()) throw new Error(`Codex home template contains a symlink: ${relativePath}`);
      if (entry.isDirectory()) visit(entryPath);
      else if (!entry.isFile()) throw new Error(`Codex home template contains a special file: ${relativePath}`);
    }
  };
  visit(path);

  const configPath = resolve(path, "config.toml");
  const config = lstatSync(configPath);
  if (!config.isFile() || config.isSymbolicLink()) {
    throw new Error(`Codex home template must contain a regular config.toml: ${path}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Codex home template config.toml is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const catalog of namedStringValues(parsed, "model_catalog_json")) {
    if (isAbsolute(catalog)) throw new Error("model_catalog_json must be relative to the Codex home template");
    const catalogPath = resolve(path, catalog);
    const withinRoot = relative(path, catalogPath);
    if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
      throw new Error("model_catalog_json escapes the Codex home template");
    }
    const catalogStat = lstatSync(catalogPath);
    if (!catalogStat.isFile() || catalogStat.isSymbolicLink()) {
      throw new Error(`model_catalog_json is not a regular template file: ${catalog}`);
    }
    let catalogJson: unknown;
    try {
      catalogJson = JSON.parse(readFileSync(catalogPath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`model_catalog_json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const models = catalogJson !== null && typeof catalogJson === "object" && !Array.isArray(catalogJson)
      ? (catalogJson as Record<string, unknown>).models
      : undefined;
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error("model_catalog_json must contain a non-empty models array");
    }
  }
  return path;
}

function namedStringValues(value: unknown, key: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => namedStringValues(item, key));
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = record[key];
  if (own !== undefined && typeof own !== "string") throw new Error(`${key} must be a string path`);
  return [
    ...(typeof own === "string" ? [own] : []),
    ...Object.entries(record)
      .filter(([name]) => name !== key)
      .flatMap(([, child]) => namedStringValues(child, key)),
  ];
}
