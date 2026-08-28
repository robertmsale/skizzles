import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendFactory, BackendTransport } from "./backend.ts";

export const CONTAINER_WORKSPACE = "/workspace/repo";
export const DEFAULT_IMAGE = "skizzles/codex-app-server:0.149.1";
export const APP_SERVER_READY_MARKER = "__SKIZZLES_CODEX_APP_SERVER_READY__";

export type DockerBackendOptions = {
  repoUrl: string;
  image?: string | undefined;
  repoRef?: string | undefined;
  codexHomeTemplate?: string | undefined;
  providerCommand?: string | undefined;
  providerReadyUrl?: string | undefined;
  passEnv?: string[] | undefined;
  dockerBinary?: string | undefined;
};

export class DockerBackendFactory implements BackendFactory {
  private readonly options: Omit<DockerBackendOptions, "image" | "dockerBinary"> & {
    image: string;
    dockerBinary: string;
  };

  constructor(options: DockerBackendOptions) {
    validateText("repo URL", options.repoUrl);
    const image = options.image ?? DEFAULT_IMAGE;
    const dockerBinary = options.dockerBinary ?? "docker";
    validateText("image", image);
    validateText("docker binary", dockerBinary);
    if (options.codexHomeTemplate) {
      const path = resolve(options.codexHomeTemplate);
      if (!statSync(path).isDirectory()) throw new Error(`Codex home template is not a directory: ${path}`);
      options = { ...options, codexHomeTemplate: path };
    }
    for (const name of options.passEnv ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid environment variable name: ${name}`);
    }
    this.options = { ...options, image, dockerBinary };
  }

  async create(): Promise<BackendTransport> {
    const machineId = crypto.randomUUID();
    const name = `skizzles-codex-${machineId}`;
    const args = [
      "create",
      "--interactive",
      "--name", name,
      "--label", "dev.skizzles.codex-aggregator=true",
      "--label", `dev.skizzles.machine-id=${machineId}`,
      "--add-host", "host.docker.internal:host-gateway",
      "--env", `CODEX_AGGREGATOR_REPO_URL=${this.options.repoUrl}`,
      "--env", `CODEX_AGGREGATOR_WORKSPACE=${CONTAINER_WORKSPACE}`,
    ];
    if (this.options.repoRef) args.push("--env", `CODEX_AGGREGATOR_REPO_REF=${this.options.repoRef}`);
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
}

class DockerTransport implements BackendTransport {
  readonly machineId: string;
  readonly containerId: string;
  readonly workspace: string;
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
