import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LabConfig } from "./config";
import {
  composeCommandArgs,
  generateBaseCompose,
  generateOverrideCompose,
  internalImageTag,
  inspectComposeModel,
  type ComposeInspectionFinding,
  type ComposeModel,
} from "./compose";
import { runCommand, type RunOptions, type CommandResult } from "./process";
import { redactPublicText } from "./public-output";
import type { Endpoint, LabMetadata, PersistedLabRuntime } from "./types";

export type LabRuntime = PersistedLabRuntime & { metadata: LabMetadata };

export interface DockerRunner {
  run(args: string[], options?: RunOptions): Promise<CommandResult>;
  spawn(args: string[]): ChildProcessWithoutNullStreams;
}

export type DockerRunTerminationResult =
  | { confirmed: true; status: "signaled" | "absent" }
  | { confirmed: false; status: "identity-mismatch" | "unavailable" | "docker-failure" };

export const defaultDockerRunner: DockerRunner = {
  run: async (args, options = {}) => await runCommand("docker", args, options),
  spawn: (args) => spawn("docker", args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] }),
};

export async function dockerAvailable(runner: DockerRunner = defaultDockerRunner): Promise<boolean> {
  return (await runner.run(["info", "--format", "{{.ServerVersion}}"], {
    allowFailure: true, timeoutMs: 10_000,
  })).code === 0;
}

export async function prepareLabRuntime(
  metadata: LabMetadata,
  config: LabConfig,
  runner: DockerRunner = defaultDockerRunner,
): Promise<LabRuntime> {
  await mkdir(metadata.runtimeRoot, { recursive: true, mode: 0o700 });
  const base = generateBaseCompose(config);
  const baseFile = base === undefined ? undefined : join(metadata.runtimeRoot, "base.compose.yaml");
  if (baseFile && base !== undefined) await writeFile(baseFile, base, { mode: 0o600 });
  const overrideFile = join(metadata.runtimeRoot, "override.compose.yaml");
  await writeFile(overrideFile, "{}\n", { mode: 0o600 });
  const composeArgs = composeCommandArgs(config, { projectName: metadata.composeProject, overrideFile, baseFile });
  const sourceModel = await normalizedModel(composeArgs, runner);
  const findings = inspectComposeModel(sourceModel);
  const override = generateOverrideCompose(config, sourceModel, {
    workspaceHostPath: metadata.workspace,
    owner: metadata.owner,
    ownerKey: metadata.ownerKey,
    labId: metadata.id,
  });
  await writeFile(overrideFile, override, { mode: 0o600 });
  await normalizedModel(composeArgs, runner);
  return { metadata, config, composeArgs, baseFile, overrideFile, findings };
}

async function normalizedModel(composeArgs: string[], runner: DockerRunner): Promise<ComposeModel> {
  const result = await runner.run([...composeArgs, "config", "--format", "json"], {
    timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024, allowFailure: true,
  });
  if (result.code === 0) {
    try { return JSON.parse(result.stdout.toString()) as ComposeModel; } catch {}
  }
  const yaml = await runner.run([...composeArgs, "config"], {
    timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024,
  });
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
  });
}

export async function provisionLabStack(
  runtime: LabRuntime,
  signal?: AbortSignal,
  runner: DockerRunner = defaultDockerRunner,
): Promise<Endpoint[]> {
  await composeCommand(runtime, ["up", "-d", "--wait", "--wait-timeout", "180"], { timeoutMs: 30 * 60_000, signal }, runner);
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
  const model = await normalizedModel(runtime.composeArgs, runner);
  if (!Object.hasOwn(model.services ?? {}, service)) throw new Error(`unknown Compose service: ${service}`);
  const result = await composeCommand(runtime, ["logs", "--no-color", "--tail", String(tailLines), service], {
    allowFailure: true, timeoutMs: 20_000,
  }, runner);
  return boundedLogTail(`${result.stdout}${result.stderr}`, tailLines, 8 * 1024);
}

export async function destroyLabStack(runtime: LabRuntime, runner: DockerRunner = defaultDockerRunner): Promise<void> {
  await cleanupLabLabels(runtime.metadata, runtime.config.mode.kind === "dockerfile", runner);
}

export async function cleanupLabLabels(
  metadata: LabMetadata,
  removeInternalImage: boolean,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  const exactFilters = [
    "--filter", "label=io.openai.codex-container-lab.managed=true",
    "--filter", `label=io.openai.codex-container-lab.owner=${metadata.owner}`,
    "--filter", `label=io.openai.codex-container-lab.lab=${metadata.id}`,
  ];
  const resources: Array<{
    kind: "container" | "volume" | "network";
    list: string[];
    remove: string[];
    ownership?: string;
  }> = [
    { kind: "container", list: ["ps", "-aq", ...exactFilters], remove: ["rm", "-f", "-v"] },
    {
      kind: "volume",
      list: ["volume", "ls", "-q", ...exactFilters,
        "--filter", `label=com.docker.compose.project=${metadata.composeProject}`,
        "--filter", "label=com.docker.compose.volume"],
      remove: ["volume", "rm"],
      ownership: "com.docker.compose.volume",
    },
    {
      kind: "network",
      list: ["network", "ls", "-q", ...exactFilters,
        "--filter", `label=com.docker.compose.project=${metadata.composeProject}`,
        "--filter", "label=com.docker.compose.network"],
      remove: ["network", "rm"],
      ownership: "com.docker.compose.network",
    },
  ];
  for (const resource of resources) {
    const ids = await listBounded(resource.kind, resource.list, runner);
    if (resource.ownership && resource.kind !== "container") {
      for (const id of ids) await verifyComposeResource(metadata, resource.kind, id, resource.ownership, runner);
    }
    if (ids.length) {
      const removed = await runner.run([...resource.remove, ...ids], {
        allowFailure: true, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024,
      });
      if (removed.code !== 0) throw new Error(`failed to remove managed lab ${resource.kind}s`);
    }
    const remaining = await listBounded(resource.kind, resource.list, runner);
    if (remaining.length) throw new Error(`managed lab ${resource.kind}s remain after cleanup`);
  }
  if (removeInternalImage) {
    await removeManagedInternalImage(metadata, runner);
  }
}

async function removeManagedInternalImage(metadata: LabMetadata, runner: DockerRunner): Promise<void> {
  const tag = internalImageTag(metadata.ownerKey, metadata.id);
  const inspected = await runner.run([
    "image", "inspect", "--format", '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}', tag,
  ], { allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  if (inspected.code !== 0) {
    if (isExactMissingImage(inspected, tag)) return;
    throw new Error("unable to inspect managed Dockerfile image ownership");
  }

  let image: unknown;
  try { image = JSON.parse(inspected.stdout.toString()); }
  catch { throw new Error("invalid managed Dockerfile image ownership inspection"); }
  if (!isRecord(image) || typeof image.id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(image.id) || !isRecord(image.labels)) {
    throw new Error("invalid managed Dockerfile image ownership inspection");
  }
  if (image.labels["io.openai.codex-container-lab.managed"] !== "true" ||
      image.labels["io.openai.codex-container-lab.owner"] !== metadata.owner ||
      image.labels["io.openai.codex-container-lab.lab"] !== metadata.id) {
    throw new Error("refusing to remove Dockerfile image without exact ownership labels");
  }

  const removed = await runner.run(["image", "rm", image.id], {
    allowFailure: true, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024,
  });
  if (removed.code !== 0) throw new Error("failed to remove managed Dockerfile image");
}

function isExactMissingImage(result: CommandResult, tag: string): boolean {
  if (result.stdout.toString().trim() !== "") return false;
  const diagnostic = result.stderr.toString().trim();
  return diagnostic === `Error: No such image: ${tag}` ||
    diagnostic === `Error response from daemon: No such image: ${tag}`;
}

async function listBounded(kind: string, args: string[], runner: DockerRunner): Promise<string[]> {
  const listed = await runner.run(args, { allowFailure: true, timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 });
  if (listed.code !== 0) throw new Error(`failed to list managed lab ${kind}s`);
  const ids = listed.stdout.toString().trim().split("\n").filter(Boolean);
  if (ids.length > 1_000) throw new Error(`managed lab ${kind}s exceed cleanup bound`);
  return ids;
}

async function verifyComposeResource(
  metadata: LabMetadata,
  kind: "volume" | "network",
  id: string,
  ownershipLabel: string,
  runner: DockerRunner,
): Promise<void> {
  const inspected = await runner.run([kind, "inspect", id, "--format", "{{json .Labels}}"], {
    allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 64 * 1024,
  });
  if (inspected.code !== 0) throw new Error(`unable to verify managed ${kind} ownership`);
  let labels: Record<string, unknown>;
  try { labels = JSON.parse(inspected.stdout.toString()) as Record<string, unknown>; }
  catch { throw new Error(`invalid managed ${kind} ownership labels`); }
  if (labels["io.openai.codex-container-lab.managed"] !== "true" ||
      labels["io.openai.codex-container-lab.owner"] !== metadata.owner ||
      labels["io.openai.codex-container-lab.lab"] !== metadata.id ||
      labels["com.docker.compose.project"] !== metadata.composeProject ||
      typeof labels[ownershipLabel] !== "string") {
    throw new Error(`refusing to remove ${kind} without exact ownership labels`);
  }
}

export type DockerRunIdentity = {
  runId: string;
  cwd: string;
  argv: string[];
  environment: Record<string, string>;
};

export function launchDockerRun(
  runtime: LabRuntime,
  invocation: DockerRunIdentity,
  runner: DockerRunner = defaultDockerRunner,
): ChildProcessWithoutNullStreams {
  const workdir = invocation.cwd === "." ? runtime.config.runtime.workspace : posix.join(runtime.config.runtime.workspace, invocation.cwd);
  const pidFile = `/tmp/.codex-container-lab-run-${invocation.runId}.pid`;
  const processIdentity = `CODEX_CONTAINER_LAB_RUN_ID=${invocation.runId}`;
  const wrapper = [
    "command -v setsid >/dev/null 2>&1 || { echo 'configured command service requires setsid' >&2; exit 127; }",
    "exec 3<&0",
    `${processIdentity} setsid "$@" <&3 3<&- & child=$!`,
    "exec 3<&-",
    `printf '%s %s\\n' ${shellQuote(invocation.runId)} "$child" > ${shellQuote(pidFile)}`,
    'wait "$child"; code=$?',
    'kill -TERM -- -"$child" 2>/dev/null || :',
    'attempt=0; while kill -0 -- -"$child" 2>/dev/null && [ "$attempt" -lt 20 ]; do sleep 0.1; attempt=$((attempt + 1)); done',
    'kill -KILL -- -"$child" 2>/dev/null || :',
    `rm -f ${shellQuote(pidFile)}`,
    'exit "$code"',
  ].join("; ");
  const args = [
    ...runtime.composeArgs, "exec", "-T", "--workdir", workdir,
    ...Object.entries(invocation.environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    runtime.config.mode.commandService, ...runtime.config.runtime.shell, wrapper,
    "codex-container-lab-run", ...invocation.argv,
  ];
  return runner.spawn(args);
}

export async function terminateDockerRun(
  runtime: LabRuntime,
  identity: Pick<DockerRunIdentity, "runId">,
  signal: "INT" | "TERM" | "KILL",
  runner: DockerRunner = defaultDockerRunner,
): Promise<DockerRunTerminationResult> {
  const pidFile = `/tmp/.codex-container-lab-run-${identity.runId}.pid`;
  const expectedIdentity = `CODEX_CONTAINER_LAB_RUN_ID=${identity.runId}`;
  const marker = "codex-container-lab-termination:";
  const killScript = [
    `termination_result() { printf '%s\\n' ${shellQuote(marker)}"$1"; exit 0; }`,
    `recorded_token=; pid=; extra=; read -r recorded_token pid extra < ${shellQuote(pidFile)} 2>/dev/null || termination_result unavailable`,
    `case "$pid" in ''|*[!0-9]*) termination_result identity-mismatch;; esac`,
    `[ -z "$extra" ] || termination_result identity-mismatch`,
    `[ "$recorded_token" = ${shellQuote(identity.runId)} ] || termination_result identity-mismatch`,
    `kill -0 -- -"$pid" 2>/dev/null || { rm -f ${shellQuote(pidFile)}; termination_result absent; }`,
    `[ -r "/proc/$pid/environ" ] || termination_result unavailable`,
    `command -v tr >/dev/null 2>&1 && command -v grep >/dev/null 2>&1 || termination_result unavailable`,
    `tr '\\000' '\\n' < "/proc/$pid/environ" | grep -Fqx -- ${shellQuote(expectedIdentity)} || termination_result identity-mismatch`,
    `kill -${signal} -- -"$pid" 2>/dev/null && { [ "${signal}" != KILL ] || rm -f ${shellQuote(pidFile)}; termination_result signaled; }`,
    `kill -0 -- -"$pid" 2>/dev/null || { rm -f ${shellQuote(pidFile)}; termination_result absent; }`,
    `termination_result unavailable`,
  ].join("; ");
  let result: CommandResult;
  try {
    result = await composeCommand(runtime, [
      "exec", "-T", runtime.config.mode.commandService, ...runtime.config.runtime.shell, killScript,
    ], { allowFailure: true, timeoutMs: 10_000 }, runner);
  } catch {
    return { confirmed: false, status: "docker-failure" };
  }
  if (result.code !== 0) return { confirmed: false, status: "docker-failure" };
  switch (result.stdout.toString().trim()) {
    case `${marker}signaled`: return { confirmed: true, status: "signaled" };
    case `${marker}absent`: return { confirmed: true, status: "absent" };
    case `${marker}identity-mismatch`: return { confirmed: false, status: "identity-mismatch" };
    case `${marker}unavailable`: return { confirmed: false, status: "unavailable" };
    default: return { confirmed: false, status: "unavailable" };
  }
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
