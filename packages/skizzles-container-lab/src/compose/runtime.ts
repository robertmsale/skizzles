import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LabConfig } from "./config";
import {
  composeCommandArgs,
  generateBaseCompose,
  generateOverrideCompose,
  inspectComposeModel,
  validateSecretEnvironmentModel,
  type ComposeInspectionFinding,
  type ComposeModel,
} from "./definition";
import type { CommandResult } from "../execution/process";
import { redactPublicText } from "../public/output";
import type { Endpoint, LabMetadata, PersistedLabRuntime } from "../storage/records";
import {
  defaultDockerRunner,
  scrubSecretEnvironment,
  secretComposeEnvironment,
  type DockerRunner,
} from "./docker-runner";

export type LabRuntime = PersistedLabRuntime & { metadata: LabMetadata };

export async function prepareLabRuntime(
  metadata: LabMetadata,
  config: LabConfig,
  runner: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LabRuntime> {
  await mkdir(metadata.runtimeRoot, { recursive: true, mode: 0o700 });
  const base = generateBaseCompose(config);
  const baseFile = base === undefined ? undefined : join(metadata.runtimeRoot, "base.compose.yaml");
  if (baseFile && base !== undefined) await writeFile(baseFile, base, { mode: 0o600 });
  const overrideFile = join(metadata.runtimeRoot, "override.compose.yaml");
  await writeFile(overrideFile, "{}\n", { mode: 0o600 });
  const composeArgs = composeCommandArgs(config, { projectName: metadata.composeProject, overrideFile, baseFile });
  const composeEnvironment = secretComposeEnvironment(config.secretEnvironment, environment);
  const sourceModel = await normalizedModel(composeArgs, runner, composeEnvironment);
  validateSecretEnvironmentModel(sourceModel, config.secretEnvironment, composeEnvironment);
  const findings = inspectComposeModel(sourceModel);
  const override = generateOverrideCompose(config, sourceModel, {
    workspaceHostPath: metadata.workspace,
    owner: metadata.owner,
    ownerKey: metadata.ownerKey,
    labId: metadata.id,
  });
  await writeFile(overrideFile, override, { mode: 0o600 });
  const finalModel = await normalizedModel(composeArgs, runner, composeEnvironment);
  validateSecretEnvironmentModel(finalModel, config.secretEnvironment, composeEnvironment);
  return { metadata, config, composeArgs, baseFile, overrideFile, findings };
}

async function normalizedModel(
  composeArgs: string[],
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ComposeModel> {
  let result: CommandResult;
  try {
    result = await runner.run([...composeArgs, "config", "--no-interpolate", "--format", "json"], {
      timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024, allowFailure: true, env: environment,
    });
  } catch {
    throw new Error("Docker Compose configuration failed; secret-bearing diagnostics redacted");
  }
  if (result.code === 0) {
    try { return JSON.parse(result.stdout.toString()) as ComposeModel; } catch {}
  }
  let yaml: CommandResult;
  try {
    yaml = await runner.run([...composeArgs, "config", "--no-interpolate"], {
      timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024, allowFailure: true, env: environment,
    });
  } catch {
    throw new Error("Docker Compose configuration failed; secret-bearing diagnostics redacted");
  }
  if (yaml.code !== 0) throw new Error("Docker Compose configuration failed; secret-bearing diagnostics redacted");
  return parseYaml(yaml.stdout.toString()) as ComposeModel;
}

export async function composeCommand(
  runtime: LabRuntime,
  args: string[],
  options: { timeoutMs?: number; allowFailure?: boolean; signal?: AbortSignal } = {},
  runner: DockerRunner = defaultDockerRunner,
): Promise<CommandResult> {
  return await runner.run([...runtime.composeArgs, ...args], {
    timeoutMs: options.timeoutMs,
    allowFailure: options.allowFailure,
    maxOutputBytes: 4 * 1024 * 1024,
    signal: options.signal,
    env: scrubSecretEnvironment(runtime.config.secretEnvironment, process.env),
  });
}

export async function provisionLabStack(
  runtime: LabRuntime,
  signal?: AbortSignal,
  runner: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Endpoint[]> {
  let provisioned: CommandResult;
  try {
    provisioned = await runner.run([...runtime.composeArgs, "up", "-d", "--wait", "--wait-timeout", "180"], {
      timeoutMs: 30 * 60_000,
      signal,
      allowFailure: true,
      maxOutputBytes: 4 * 1024 * 1024,
      env: secretComposeEnvironment(runtime.config.secretEnvironment, environment),
    });
  } catch {
    throw new Error(signal?.aborted
      ? "Docker Compose up aborted; secret-bearing diagnostics redacted"
      : "Docker Compose up failed; secret-bearing diagnostics redacted");
  }
  if (provisioned.code !== 0) {
    let diagnostic = `${provisioned.stdout.toString()}\n${provisioned.stderr.toString()}`;
    for (const name of runtime.config.secretEnvironment) {
      const value = environment[name];
      if (value) diagnostic = diagnostic.split(value).join("[secret-value-redacted]");
    }
    await writeFile(
      "/tmp/ccl-compose-failure-redacted.log",
      redactPublicText(diagnostic),
      { mode: 0o600 },
    );
    throw new Error("Docker Compose up failed; secret-bearing diagnostics redacted");
  }
  const compatibility = [
    `test -d ${shellQuote(runtime.config.runtime.workspace)}`,
    `test -w ${shellQuote(runtime.config.runtime.workspace)}`,
    "command -v setsid >/dev/null 2>&1",
  ].join(" && ");
  const verified = await composeCommand(runtime, [
    "exec", "-T", runtime.config.mode.commandService, ...runtime.config.runtime.shell, compatibility,
  ], { allowFailure: true, timeoutMs: 20_000, signal }, runner);
  if (verified.code !== 0) {
    throw new Error("command service compatibility check failed: configured shell, writable workspace, and setsid are required");
  }
  const endpoints: Endpoint[] = [];
  for (const port of runtime.config.ports) {
    const result = await composeCommand(runtime, ["port", port.service, String(port.target)], { timeoutMs: 20_000 }, runner);
    const loopback = result.stdout.toString().trim().split("\n")
      .map((line) => line.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1])
      .filter((value): value is string => value !== undefined);
    if (loopback.length !== 1) throw new Error(`unable to uniquely resolve declared loopback port ${port.name}`);
    endpoints.push({
      name: port.name,
      service: port.service,
      target: port.target,
      url: `${port.scheme ?? "tcp"}://127.0.0.1:${loopback[0]!}`,
    });
  }
  return endpoints;
}

export async function stackStatus(runtime: LabRuntime, runner: DockerRunner = defaultDockerRunner): Promise<unknown> {
  const result = await composeCommand(runtime, ["ps", "--format", "json"], { allowFailure: true, timeoutMs: 20_000 }, runner);
  if (result.code !== 0) return { available: false, error: compactError(result.stderr.toString()) };
  const raw = result.stdout.toString().trim();
  if (!raw) return { available: true, services: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    return { available: true, services: summarizeServices(Array.isArray(parsed) ? parsed : [parsed]) };
  } catch {
    try {
      return { available: true, services: summarizeServices(raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown)) };
    } catch {
      return { available: false, error: "Docker returned an invalid bounded status response" };
    }
  }
}

export async function stackLogs(
  runtime: LabRuntime,
  service: string,
  tailLines: number,
  runner: DockerRunner = defaultDockerRunner,
): Promise<{ text: string; truncated: boolean }> {
  if (tailLines < 1 || tailLines > 500) throw new Error("tail-lines must be 1..500");
  const model = await normalizedModel(
    runtime.composeArgs,
    runner,
    scrubSecretEnvironment(runtime.config.secretEnvironment, process.env),
  );
  if (!Object.hasOwn(model.services ?? {}, service)) throw new Error(`unknown Compose service: ${service}`);
  const result = await composeCommand(runtime, ["logs", "--no-color", "--tail", String(tailLines), service], {
    allowFailure: true, timeoutMs: 20_000,
  }, runner);
  return boundedLogTail(`${result.stdout}${result.stderr}`, tailLines, 8 * 1024);
}

function summarizeServices(values: unknown[]): Array<{
  service: string;
  state: string;
  health?: string;
  exitCode?: number;
}> {
  return values.slice(0, 16).flatMap((value) => {
    if (!isRecord(value)) return [];
    const service = typeof value.Service === "string" ? value.Service : typeof value.Name === "string" ? value.Name : undefined;
    const state = typeof value.State === "string" ? value.State : undefined;
    if (!service || !state) return [];
    const summary: { service: string; state: string; health?: string; exitCode?: number } = {
      service: service.slice(0, 128), state: state.slice(0, 64),
    };
    if (typeof value.Health === "string" && value.Health) summary.health = value.Health.slice(0, 64);
    const exitCode = typeof value.ExitCode === "number" ? value.ExitCode : Number(value.ExitCode);
    if (Number.isInteger(exitCode)) summary.exitCode = exitCode;
    return [summary];
  });
}

function boundedLogTail(value: string, maxLines: number, maxBytes: number): { text: string; truncated: boolean } {
  const sanitized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�").trimEnd();
  const lines = sanitized.split("\n");
  let selected = lines.slice(-maxLines).join("\n");
  let truncated = lines.length > maxLines;
  let bytes = Buffer.from(selected);
  if (bytes.byteLength > maxBytes) {
    bytes = bytes.subarray(bytes.byteLength - maxBytes);
    selected = bytes.toString("utf8").replace(/^�/, "");
    truncated = true;
  }
  return { text: selected, truncated };
}

export function runtimeFromLab(metadata: LabMetadata): LabRuntime {
  if (!metadata.runtime) throw new Error(`lab runtime is unavailable: ${metadata.id}`);
  return { metadata, ...metadata.runtime };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function compactError(value: string): string {
  return redactPublicText(value.trim(), 2_000, 6);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
