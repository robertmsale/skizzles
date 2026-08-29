import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LabConfig } from "./config";
import {
  composeCommandArgs,
  generateBaseCompose,
  generateOverrideCompose,
  internalImageTag,
  inspectComposeModel,
  inspectProjectScopedBuilds,
  assertMappedServicesConsumeSharedImages,
  SHARED_COMPILER_CACHE_CONTAINER,
  SHARED_COMPILER_CACHE_IMAGE,
  SHARED_COMPILER_CACHE_LABELS,
  SHARED_COMPILER_CACHE_NETWORK,
  validateSecretEnvironmentModel,
  type ComposeInspectionFinding,
  type ComposeModel,
} from "./compose";
import { runCommand, type RunOptions, type CommandResult } from "./process";
import {
  redactComposeFailureWithMetadata,
  redactComposeLogStreams,
  secretCrossesFragmentBoundary,
  type RedactionResult,
} from "./log-framing";
import type { Endpoint, LabMetadata, PersistedLabRuntime, ProvisioningFailureDiagnostic } from "./types";

export type LabRuntime = PersistedLabRuntime & { metadata: LabMetadata };

export interface DockerRunner {
  run(args: string[], options?: RunOptions): Promise<CommandResult>;
  spawn(args: string[], options?: DockerSpawnOptions): ChildProcessWithoutNullStreams;
}

export type DockerSpawnOptions = { env?: NodeJS.ProcessEnv };

/** The only durable path used for a failed Compose-up transcript. */
export const PROVISIONING_FAILURE_DIAGNOSTIC_FILE = "provisioning-failure.compose-up.log";

export class DockerProvisioningFailure extends Error {
  constructor(
    message: string,
    readonly diagnostic: ProvisioningFailureDiagnostic,
  ) {
    super(message);
    this.name = "DockerProvisioningFailure";
  }
}

export type DockerRunTerminationResult =
  | { confirmed: true; status: "signaled" | "absent" }
  | { confirmed: false; status: "identity-mismatch" | "unavailable" | "docker-failure" };

export const defaultDockerRunner: DockerRunner = {
  run: async (args, options = {}) => await runCommand("docker", args, options),
  spawn: (args, options = {}) => spawn("docker", args, {
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  }),
};

const SHARED_COMPILER_CACHE_COMMAND = [
  "redis-server",
  "--maxmemory", "16gb",
  "--maxmemory-policy", "allkeys-lru",
  "--save", "",
  "--appendonly", "no",
];

/**
 * Ensure the one Skizzles-owned Redis cache exists and is healthy.
 *
 * This resource is deliberately outside every lab's ownership labels and
 * lifecycle.  It is created only by the explicit compiler-cache opt-in and
 * is never discovered by per-lab cleanup.
 */
export async function ensureSharedCompilerCache(runner: DockerRunner = defaultDockerRunner): Promise<void> {
  await ensureSharedCompilerCacheNetwork(runner);
  let existing = await inspectSharedCompilerCacheContainer(runner);
  if (existing === "missing") {
    const created = await runner.run([
      "run", "--detach",
      "--name", SHARED_COMPILER_CACHE_CONTAINER,
      "--network", SHARED_COMPILER_CACHE_NETWORK,
      "--network-alias", SHARED_COMPILER_CACHE_CONTAINER,
      "--restart", "unless-stopped",
      ...Object.entries(SHARED_COMPILER_CACHE_LABELS).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      SHARED_COMPILER_CACHE_IMAGE,
      ...SHARED_COMPILER_CACHE_COMMAND,
    ], { allowFailure: true, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    if (created.code !== 0) {
      // Another process may have won the create race. Re-inspect and adopt
      // only if the resulting container proves the complete identity.
      const raced = await inspectSharedCompilerCacheContainer(runner);
      if (raced === "missing") throw new Error("failed to create shared compiler cache container");
      existing = raced;
    } else {
      existing = await inspectSharedCompilerCacheContainer(runner);
      if (existing === "missing") throw new Error("shared compiler cache container disappeared after creation");
    }
  }
  if (existing !== "running") {
    const started = await runner.run(["start", SHARED_COMPILER_CACHE_CONTAINER], {
      allowFailure: true, timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
    });
    if (started.code !== 0) throw new Error("failed to start shared compiler cache container");
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    const ping = await runner.run(["exec", SHARED_COMPILER_CACHE_CONTAINER, "redis-cli", "ping"], {
      allowFailure: true, timeoutMs: 500, maxOutputBytes: 64 * 1024,
    });
    if (ping.code === 0 && ping.stdout.toString().trim() === "PONG") return;
    if (attempt < 29) await delay(100);
  }
  throw new Error("shared compiler cache did not respond to redis-cli ping");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensureSharedCompilerCacheNetwork(runner: DockerRunner): Promise<void> {
  const existing = await inspectSharedCompilerCacheNetwork(runner);
  if (existing !== "missing") return;
  const created = await runner.run([
    "network", "create", "--driver", "bridge",
    ...Object.entries(SHARED_COMPILER_CACHE_LABELS).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    SHARED_COMPILER_CACHE_NETWORK,
  ], { allowFailure: true, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  if (created.code !== 0) {
    const raced = await inspectSharedCompilerCacheNetwork(runner);
    if (raced === "missing") throw new Error("failed to create shared compiler cache network");
  } else {
    const verified = await inspectSharedCompilerCacheNetwork(runner);
    if (verified === "missing") throw new Error("shared compiler cache network disappeared after creation");
  }
}

type SharedResourceInspection = "missing" | "running" | "stopped";

async function inspectSharedCompilerCacheNetwork(runner: DockerRunner): Promise<"missing" | "matching"> {
  const inspected = await runner.run([
    "network", "inspect", SHARED_COMPILER_CACHE_NETWORK, "--format", "{{json .}}",
  ], { allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
  if (inspected.code !== 0) {
    if (isExactMissingResource(inspected, "network", SHARED_COMPILER_CACHE_NETWORK)) return "missing";
    throw new Error("unable to inspect shared compiler cache network");
  }
  const network = parseInspection(inspected.stdout.toString());
  if (!isRecord(network) || network.Name !== SHARED_COMPILER_CACHE_NETWORK || network.Driver !== "bridge" ||
      network.Scope !== "local" || network.Internal !== false || !hasExactSharedLabels(network.Labels)) {
    throw new Error("refusing shared compiler cache network with mismatched identity");
  }
  return "matching";
}

async function inspectSharedCompilerCacheContainer(runner: DockerRunner): Promise<SharedResourceInspection> {
  const inspected = await runner.run([
    "container", "inspect", SHARED_COMPILER_CACHE_CONTAINER, "--format", "{{json .}}",
  ], { allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
  if (inspected.code !== 0) {
    if (isExactMissingResource(inspected, "container", SHARED_COMPILER_CACHE_CONTAINER)) return "missing";
    throw new Error("unable to inspect shared compiler cache container");
  }
  const container = parseInspection(inspected.stdout.toString());
  if (!isRecord(container) || container.Name !== `/${SHARED_COMPILER_CACHE_CONTAINER}` ||
      !isRecord(container.Config) || container.Config.Image !== SHARED_COMPILER_CACHE_IMAGE ||
      !hasExactSharedLabels(container.Config.Labels) ||
      !isRecord(container.HostConfig) || !isRecord(container.HostConfig.RestartPolicy) ||
      container.HostConfig.RestartPolicy.Name !== "unless-stopped" ||
      !isEmptyPortBindings(container.HostConfig.PortBindings) ||
      !isExpectedCommand(container.Config.Cmd) ||
      !isRecord(container.NetworkSettings) || !isExclusiveSharedNetwork(container.NetworkSettings.Networks) ||
      !isRecord(container.State) || typeof container.State.Status !== "string") {
    throw new Error("refusing shared compiler cache container with mismatched identity");
  }
  if (container.State.Status === "running") return "running";
  if (["created", "restarting", "exited", "dead", "paused"].includes(container.State.Status)) return "stopped";
  throw new Error("refusing shared compiler cache container with unknown state");
}

function parseInspection(value: string): unknown {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    throw new Error("invalid shared compiler cache Docker inspection");
  }
}

function isExactMissingResource(result: CommandResult, kind: "network" | "container", name: string): boolean {
  if (result.stdout.toString().trim() !== "") return false;
  const diagnostic = result.stderr.toString().trim();
  const expected = kind === "container"
    ? [`Error: No such container: ${name}`, `Error response from daemon: No such container: ${name}`]
    : [`Error: network ${name} not found`, `Error response from daemon: network ${name} not found`];
  return expected.includes(diagnostic);
}

function hasExactSharedLabels(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (Object.keys(value).length !== Object.keys(SHARED_COMPILER_CACHE_LABELS).length) return false;
  for (const [key, expected] of Object.entries(SHARED_COMPILER_CACHE_LABELS)) {
    if (value[key] !== expected) return false;
  }
  return true;
}

function isEmptyPortBindings(value: unknown): boolean {
  return value === null || (isRecord(value) && Object.keys(value).length === 0);
}

function isExpectedCommand(value: unknown): boolean {
  return Array.isArray(value) && value.length === SHARED_COMPILER_CACHE_COMMAND.length &&
    value.every((item, index) => item === SHARED_COMPILER_CACHE_COMMAND[index]);
}

function isExclusiveSharedNetwork(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const names = Object.keys(value);
  return names.length === 1 && names[0] === SHARED_COMPILER_CACHE_NETWORK && isRecord(value[names[0]!]);
}

export type DockerUnavailableReason =
  | "timeout"
  | "spawn"
  | "not-found"
  | "context"
  | "permission"
  | "daemon"
  | "unreachable"
  | "other";

export type DockerAvailabilityDiagnostic = {
  reason: DockerUnavailableReason;
  context?: string;
  nextAction: string;
};

export type DockerProbeResult =
  | { available: true }
  | { available: false; diagnostic: DockerAvailabilityDiagnostic };

const SAFE_DOCKER_CONTEXT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const DOCKER_NEXT_ACTION: Record<DockerUnavailableReason, string> = {
  timeout: "Retry the Docker health check; if it persists, restart Docker.",
  spawn: "Check that the Docker CLI can start, then retry.",
  "not-found": "Install Docker and ensure the Docker CLI is available on PATH.",
  context: "Remove the unavailable Docker context or select an available one, then retry.",
  permission: "Grant access to the Docker daemon, then retry.",
  daemon: "Start Docker Desktop or the Docker daemon, then retry.",
  unreachable: "Check that the Docker daemon endpoint is reachable, then retry.",
  other: "Check Docker configuration and daemon logs, then retry.",
};

/** Probe Docker while retaining only a bounded, actionable failure category. */
export async function dockerAvailable(
  runner: DockerRunner = defaultDockerRunner,
  secretEnvironment: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DockerProbeResult> {
  const probeEnvironment = scrubSecretEnvironment(secretEnvironment, environment);
  const context = safeDockerContext(probeEnvironment.DOCKER_CONTEXT);
  try {
    const result = await runner.run(["info", "--format", "{{.ServerVersion}}"], {
      allowFailure: true,
      timeoutMs: 10_000,
      env: probeEnvironment,
    });
    if (result.code === 0) return { available: true };
    return { available: false, diagnostic: dockerFailureDiagnostic(result.stderr.toString(), result.code, context) };
  } catch (error) {
    return { available: false, diagnostic: dockerFailureDiagnostic(error, undefined, context) };
  }
}

/** Descriptive alias for callers that prefer the probe terminology. */
export const dockerProbe = dockerAvailable;

function safeDockerContext(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_DOCKER_CONTEXT.test(value) ? value : undefined;
}

function dockerFailureDiagnostic(value: unknown, code: number | undefined, context: string | undefined): DockerAvailabilityDiagnostic {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : "";
  const normalized = text.toLowerCase();
  const failureContext = context ?? contextFromFailure(text);
  const timedOut = value instanceof Error && (value.name === "TimeoutError" || (isNodeError(value) && value.code === "ETIMEDOUT"));
  const reason: DockerUnavailableReason = code === 124 || timedOut || /(?:timed? ?out|timeout|deadline exceeded)/.test(normalized)
    ? "timeout"
    : /(?:context .* does not exist|context .* not found|unknown context)/.test(normalized)
      ? "context"
      : isSpawnNotFound(value, normalized)
        ? "not-found"
        : isSpawnFailure(value, normalized)
          ? "spawn"
          : /(?:permission denied|operation not permitted|eacces)/.test(normalized)
            ? "permission"
            : /(?:cannot connect to the docker daemon|docker daemon.*(?:not running|unavailable)|is the docker daemon running|error response from daemon)/.test(normalized)
              ? "daemon"
              : /(?:connection refused|network is unreachable|no route to host|host is down|unreachable|econnrefused|dial tcp)/.test(normalized)
                ? "unreachable"
                : "other";
  return {
    reason,
    ...(failureContext ? { context: failureContext } : {}),
    nextAction: DOCKER_NEXT_ACTION[reason],
  };
}

function contextFromFailure(value: string): string | undefined {
  const match = value.match(/\bcontext\s+["']?([A-Za-z0-9][A-Za-z0-9_.-]{0,63})["']?\s+(?:does not exist|not found)\b/i);
  return safeDockerContext(match?.[1]);
}

function isSpawnNotFound(value: unknown, normalized: string): boolean {
  return (isNodeError(value) && value.code === "ENOENT") || /(?:command not found|no such file or directory|\benoent\b)/.test(normalized);
}

function isSpawnFailure(value: unknown, normalized: string): boolean {
  return (isNodeError(value) && typeof value.code === "string" && ["E2BIG", "EAGAIN", "EMFILE", "ENOMEM"].includes(value.code)) ||
    /(?:spawn .* failed|failed to spawn)/.test(normalized);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && typeof value.code === "string";
}

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
  const sharedImages = metadata.sharedImages ?? [];
  const mappedServices = new Set(config.sharedImages.flatMap((profile) => profile.services));
  findings.push(...inspectProjectScopedBuilds(sourceModel, mappedServices));
  const override = generateOverrideCompose(config, sourceModel, {
    workspaceHostPath: metadata.workspace,
    owner: metadata.owner,
    ownerKey: metadata.ownerKey,
    labId: metadata.id,
  }, sharedImages);
  if (config.runtime.compilerCache === "sccache-redis") {
    await ensureSharedCompilerCache(scrubDockerRunnerEnvironment(runner, config.secretEnvironment, environment));
    findings.push({ surface: "shared-cache", detail: "shared compiler cache enabled" });
  }
  await writeFile(overrideFile, override, { mode: 0o600 });
  const finalModel = await normalizedModel(composeArgs, runner, composeEnvironment);
  validateSecretEnvironmentModel(finalModel, config.secretEnvironment, composeEnvironment);
  assertMappedServicesConsumeSharedImages(finalModel, config, sharedImages);
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
  options: { timeoutMs?: number; allowFailure?: boolean; signal?: AbortSignal; environment?: NodeJS.ProcessEnv } = {},
  runner: DockerRunner = defaultDockerRunner,
): Promise<CommandResult> {
  return await runner.run([...runtime.composeArgs, ...args], {
    timeoutMs: options.timeoutMs,
    allowFailure: options.allowFailure,
    maxOutputBytes: 4 * 1024 * 1024,
    signal: options.signal,
    env: scrubSecretEnvironment(runtime.config.secretEnvironment, options.environment ?? process.env),
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
      stdoutCapture: "tail",
      stderrCapture: "tail",
      env: secretComposeEnvironment(runtime.config.secretEnvironment, environment),
    });
  } catch {
    const message = signal?.aborted
      ? "Docker Compose up aborted; secret-bearing diagnostics redacted"
      : "Docker Compose up failed; secret-bearing diagnostics redacted";
    throw new DockerProvisioningFailure(message, await captureComposeFailure(runtime, undefined, runner, environment));
  }
  if (provisioned.code !== 0) {
    throw new DockerProvisioningFailure(
      "Docker Compose up failed; secret-bearing diagnostics redacted",
      await captureComposeFailure(runtime, provisioned, runner, environment),
    );
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

export async function stackStatus(
  runtime: LabRuntime,
  runner: DockerRunner = defaultDockerRunner,
  options: { all?: boolean; environment?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
  const status = await listStackServiceSummaries(runtime, runner, options.environment, options.all === true);
  if (!status.available) return { available: false, error: status.error };
  return {
    available: true,
    ...(options.all ? { serviceCount: status.serviceCount } : {}),
    services: status.services.slice(0, 16),
  };
}

type ServiceSummary = {
  service: string;
  state: string;
  health?: string;
  exitCode?: number;
};

type StackServiceStatus = {
  available: boolean;
  services: ServiceSummary[];
  serviceCount: number;
  error?: string;
};

async function listStackServiceSummaries(
  runtime: LabRuntime,
  runner: DockerRunner,
  environment?: NodeJS.ProcessEnv,
  all = true,
): Promise<StackServiceStatus> {
  let result: CommandResult;
  try {
    result = await composeCommand(runtime, ["ps", ...(all ? ["--all"] : []), "--format", "json"], {
      allowFailure: true,
      timeoutMs: 20_000,
      environment,
    }, runner);
  } catch {
    return { available: false, services: [], serviceCount: 0, error: "Docker returned an unavailable status response" };
  }
  if (result.code !== 0) {
    return {
      available: false,
      services: [],
      serviceCount: 0,
      error: compactError(result.stderr.toString(), runtime, environment),
    };
  }
  const raw = result.stdout.toString().trim();
  if (!raw) return { available: true, services: [], serviceCount: 0 };
  const values = parseStatusValues(raw, 1_000);
  if (!values) {
    return { available: false, services: [], serviceCount: 0, error: "Docker returned an invalid bounded status response" };
  }
  return {
    available: true,
    services: summarizeServices(values, 1_000),
    serviceCount: values.length,
  };
}

function parseStatusValues(raw: string, maximum: number): unknown[] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (Array.isArray(parsed) ? parsed : [parsed]).slice(0, maximum);
  } catch {
    try {
      return raw.split("\n").filter(Boolean).slice(0, maximum).map((line) => JSON.parse(line) as unknown);
    } catch {
      return undefined;
    }
  }
}

async function captureComposeFailure(
  runtime: LabRuntime,
  provisioned: CommandResult | undefined,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<ProvisioningFailureDiagnostic> {
  const capturedAt = new Date().toISOString();
  let services: ProvisioningFailureDiagnostic["services"] = [];
  let serviceCount = 0;
  let candidates: string[] = [];
  let allServices: ServiceSummary[] = [];
  try {
    const status = await listStackServiceSummaries(runtime, runner, environment, true);
    if (status.available) {
      allServices = status.services;
      services = allServices.slice(0, 16);
      serviceCount = status.serviceCount;
      candidates = selectFailedDiagnosticServices(runtime, allServices);
    }
  } catch {
    // Capturing diagnostics is deliberately best effort. The original
    // Compose failure remains authoritative when Docker is unavailable.
  }

  const rawFragments = provisioned === undefined
    ? []
    : [provisioned.stdout.toString(), provisioned.stderr.toString()].filter((part) => part.length > 0);
  const raw = rawFragments.join("\n");
  const secretValues = declaredSecretValues(runtime, environment);
  const lifecycleBytes = candidates.length > 0 ? 2_048 - 1 : 8 * 1024;
  const lifecycleLines = candidates.length > 0 ? 125 : 500;
  const lifecycle = buildDiagnosticSegment(
    "compose-up",
    lifecycleLines,
    lifecycleBytes,
    provisioned?.stdoutTruncated === true || provisioned?.stderrTruncated === true,
    redactComposeFailureWithMetadata(raw, runtime, secretValues, rawFragments),
    secretValues,
  );
  const serviceBytes = divideDiagnosticBudget(6 * 1024 - Math.max(0, candidates.length - 1), candidates.length);
  const serviceLines = divideDiagnosticBudget(375, candidates.length);
  const segments = [lifecycle];
  for (const [index, service] of candidates.entries()) {
    const captured = await captureFailedServiceLogs(
      runtime,
      service,
      Math.max(1, (serviceLines[index] ?? 1) - 1),
      Math.max(1, serviceBytes[index] ?? 1),
      runner,
      environment,
      secretValues,
    );
    segments.push(buildDiagnosticSegment(
      `service:${service}`,
      serviceLines[index] ?? 1,
      serviceBytes[index] ?? 1,
      captured.truncated,
      captured.redacted,
      secretValues,
    ));
  }
  const aggregate = joinDiagnosticSegments(segments);
  let transcript = aggregate.text;
  let transcriptTruncated = segments.some((segment) => segment.truncated);
  const aggregateSecret = aggregateContainsSecret(transcript, aggregate.bodyRanges, secretValues);
  const aggregatePublicBoundary = secretCrossesFragmentBoundary(
    segments.map((segment) => segment.text),
    secretValues,
  );
  const privacyFailure = secretValues.some((secret) => /[\r\n]/.test(secret)) ||
    segments.some((segment) => segment.privacyFailure) ||
    aggregateSecret.found || aggregatePublicBoundary;
  const contentRedacted = segments.some((segment) => segment.contentRedacted) || privacyFailure;
  const aggregateBounds = Buffer.byteLength(transcript) > 8 * 1024 || transcript.split("\n").length > 500;
  if (privacyFailure || aggregateBounds) {
    transcript = "";
    transcriptTruncated ||= aggregateSecret.boundary || aggregatePublicBoundary || aggregateBounds;
  }
  const evidence = {
    kind: "compose-up" as const,
    available: false,
    bytes: 0,
    lines: 0,
    truncated: transcriptTruncated,
    contentRedacted,
  };
  try {
    await writeFailureTranscript(runtime.metadata.runtimeRoot, transcript);
    evidence.available = true;
    evidence.bytes = Buffer.byteLength(transcript);
    evidence.lines = transcript ? transcript.split("\n").length : 0;
  } catch {
    // A transcript write must never mask the exact Compose error or block
    // label-scoped cleanup in the service failure path.
  }
  return {
    phase: "compose-up",
    capturedAt,
    services,
    serviceCount,
    evidence,
  };
}

function selectFailedDiagnosticServices(runtime: LabRuntime, services: readonly ServiceSummary[]): string[] {
  const candidates = [...new Set([
    runtime.config.mode.commandService,
    ...runtime.config.ports.map((port) => port.service),
  ])];
  return candidates.filter((candidate) => services.some((summary) => {
    if (summary.service !== candidate) return false;
    const failedExit = summary.state.toLowerCase() === "exited" && summary.exitCode !== undefined && summary.exitCode !== 0;
    return failedExit || summary.health?.toLowerCase() === "unhealthy";
  })).slice(0, 4);
}

function divideDiagnosticBudget(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

async function captureFailedServiceLogs(
  runtime: LabRuntime,
  service: string,
  tailLines: number,
  segmentBytes: number,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
  secretValues: readonly string[],
): Promise<{ redacted: RedactionResult; truncated: boolean }> {
  const headerBytes = Buffer.byteLength(`--- service:${service} ---`);
  const bodyBytes = Math.max(0, segmentBytes - headerBytes - 1);
  const streamBytes = Math.floor(Math.max(0, bodyBytes - 1) / 2);
  let result: CommandResult;
  try {
    result = await runner.run([...runtime.composeArgs, "logs", "--no-color", "--timestamps", "--no-log-prefix", "--tail", String(tailLines), service], {
      allowFailure: true,
      timeoutMs: 20_000,
      maxOutputBytes: streamBytes,
      stdoutCapture: "tail",
      stderrCapture: "tail",
      env: scrubSecretEnvironment(runtime.config.secretEnvironment, environment),
    });
  } catch {
    return {
      redacted: { text: "[logs-unavailable]", contentRedacted: true },
      truncated: true,
    };
  }
  const capture = redactComposeLogStreams([
    { name: "stdout", value: result.stdout.toString(), truncated: result.stdoutTruncated === true },
    { name: "stderr", value: result.stderr.toString(), truncated: result.stderrTruncated === true },
  ], result.code, runtime, secretValues);
  return {
    redacted: capture.redacted,
    truncated: capture.truncated,
  };
}

function buildDiagnosticSegment(
  label: string,
  maxLines: number,
  maxBytes: number,
  upstreamTruncated: boolean,
  redacted: RedactionResult,
  secretValues: readonly string[],
): DiagnosticSegment {
  // Treat captured Compose output as untrusted until it has been redacted,
  // bounded, control-sanitized, and checked. The synthetic label is trusted
  // framing and is added only after that body pipeline completes.
  const header = `--- ${label} ---`;
  const body = boundedLogTail(
    redacted.text,
    Math.max(0, maxLines - 1),
    Math.max(0, maxBytes - Buffer.byteLength(header) - 1),
  );
  const privacyFailure = redacted.incomplete === true || bodyContainsSecret(body.text, header, secretValues);
  const text = body.text ? `${header}\n${body.text}` : header;
  return {
    text: privacyFailure ? "" : text,
    truncated: upstreamTruncated || redacted.incomplete === true || body.truncated,
    contentRedacted: redacted.contentRedacted,
    privacyFailure,
    bodyStart: body.text ? header.length + 1 : undefined,
    bodyEnd: body.text ? text.length : undefined,
  };
}

type DiagnosticSegment = {
  text: string;
  truncated: boolean;
  privacyFailure: boolean;
  contentRedacted: boolean;
  bodyStart?: number;
  bodyEnd?: number;
};

type DiagnosticBodyRange = { start: number; end: number };

function joinDiagnosticSegments(segments: readonly DiagnosticSegment[]): {
  text: string;
  bodyRanges: DiagnosticBodyRange[];
} {
  let text = "";
  const bodyRanges: DiagnosticBodyRange[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const separator = text ? "\n" : "";
    const offset = text.length + separator.length;
    text += `${separator}${segment.text}`;
    if (segment.bodyStart !== undefined && segment.bodyEnd !== undefined && segment.bodyStart < segment.bodyEnd) {
      bodyRanges.push({
        start: offset + segment.bodyStart,
        end: Math.min(offset + segment.bodyEnd, text.length),
      });
    }
  }
  return { text, bodyRanges };
}

function aggregateContainsSecret(
  text: string,
  bodyRanges: readonly DiagnosticBodyRange[],
  secretValues: readonly string[],
): { found: boolean; boundary: boolean } {
  const fragments = bodyRanges.map((range) => text.slice(range.start, range.end));
  const joined = fragments.join("");
  return {
    found: secretValues.some((secret) => secret.length > 0 && joined.includes(secret)),
    boundary: secretCrossesFragmentBoundary(fragments, secretValues),
  };
}

function bodyContainsSecret(body: string, header: string, secretValues: readonly string[]): boolean {
  // Ignore occurrences wholly in trusted framing (including its separator),
  // but fail closed when a value crosses into any untrusted body code unit.
  if (!body) return false;
  const framed = `${header}\n${body}`;
  const bodyStart = header.length + 1;
  return secretValues.some((secret) => {
    let start = framed.indexOf(secret);
    while (start >= 0) {
      if (start + secret.length > bodyStart) return true;
      start = framed.indexOf(secret, start + 1);
    }
    return false;
  });
}

async function writeFailureTranscript(runtimeRoot: string, text: string): Promise<void> {
  const root = await lstat(runtimeRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("invalid lab runtime root");
  }
  const destination = join(runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function declaredSecretValues(runtime: LabRuntime, environment: NodeJS.ProcessEnv): string[] {
  return [...new Set(runtime.config.secretEnvironment
    .map((name) => environment[name])
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0))]
    .sort((left, right) => right.length - left.length);
}

export async function stackLogs(
  runtime: LabRuntime,
  service: string,
  tailLines: number,
  runner: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ text: string; truncated: boolean; contentRedacted: boolean }> {
  if (tailLines < 1 || tailLines > 500) throw new Error("tail-lines must be 1..500");
  const model = await normalizedModel(
    runtime.composeArgs,
    runner,
    scrubSecretEnvironment(runtime.config.secretEnvironment, environment),
  );
  if (!Object.hasOwn(model.services ?? {}, service)) throw new Error(`unknown Compose service: ${service}`);
  const result = await composeCommand(runtime, ["logs", "--no-color", "--timestamps", "--no-log-prefix", "--tail", String(tailLines), service], {
    allowFailure: true, timeoutMs: 20_000, environment,
  }, runner);
  const secretValues = declaredSecretValues(runtime, environment);
  const capture = redactComposeLogStreams([
    { name: "stdout", value: result.stdout.toString(), truncated: result.stdoutTruncated === true },
    { name: "stderr", value: result.stderr.toString(), truncated: result.stderrTruncated === true },
  ], result.code, runtime, secretValues);
  const publicBoundary = secretCrossesFragmentBoundary([capture.redacted.text], secretValues);
  const privacyFailure = publicBoundary || secretValues.some((secret) => secret.length > 0 && capture.redacted.text.includes(secret));
  const publicText = privacyFailure ? "" : capture.redacted.text;
  const bounded = boundedLogTail(publicText, tailLines, 8 * 1024);
  return {
    ...bounded,
    truncated: bounded.truncated || capture.truncated || publicBoundary,
    contentRedacted: capture.redacted.contentRedacted || privacyFailure,
  };
}

export async function destroyLabStack(runtime: LabRuntime, runner: DockerRunner = defaultDockerRunner): Promise<void> {
  await cleanupLabLabels(runtime.metadata, runtime.config.mode.kind === "dockerfile", runner);
}

export async function countManagedLabResources(
  runner: DockerRunner = defaultDockerRunner,
): Promise<{ containers: number; volumes: number; networks: number }> {
  const filter = ["--filter", "label=io.openai.codex-container-lab.managed=true"];
  const containers = await listBounded("container", ["ps", "-aq", ...filter], runner);
  const volumes = await listBounded("volume", ["volume", "ls", "-q", ...filter], runner);
  const networks = await listBounded("network", ["network", "ls", "-q", ...filter], runner);
  return { containers: containers.length, volumes: volumes.length, networks: networks.length };
}

export async function cleanupLabLabels(
  metadata: LabMetadata,
  removeInternalImage: boolean,
  runner: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  runner = scrubDockerRunnerEnvironment(runner, metadata.secretEnvironment, environment);
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

  const removed = await runner.run(["image", "rm", "--no-prune", image.id], {
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
  environment: NodeJS.ProcessEnv = process.env,
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
  return runner.spawn(args, { env: scrubSecretEnvironment(runtime.config.secretEnvironment, environment) });
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

function summarizeServices(values: unknown[], maximum = 16): ServiceSummary[] {
  return values.slice(0, maximum).flatMap((value) => {
    if (!isRecord(value)) return [];
    const rawService = typeof value.Service === "string" ? value.Service : typeof value.Name === "string" ? value.Name : undefined;
    const rawState = typeof value.State === "string" ? value.State : undefined;
    if (!rawService || !rawState) return [];
    const service = rawService.slice(0, 128);
    const state = sanitizeDiagnosticField(rawState, 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(service) || !state) return [];
    const summary: { service: string; state: string; health?: string; exitCode?: number } = {
      service, state,
    };
    if (typeof value.Health === "string" && value.Health) {
      const health = sanitizeDiagnosticField(value.Health, 64);
      if (health) summary.health = health;
    }
    const exitCode = typeof value.ExitCode === "number" ? value.ExitCode :
      typeof value.ExitCode === "string" && value.ExitCode.trim() !== "" ? Number(value.ExitCode) : undefined;
    if (exitCode !== undefined && Number.isInteger(exitCode) && exitCode >= -1 && exitCode <= 255) {
      summary.exitCode = exitCode;
    }
    return [summary];
  });
}

function sanitizeDiagnosticField(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "�").slice(0, maximum);
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

function compactError(value: string, runtime: LabRuntime, environment?: NodeJS.ProcessEnv): string {
  const redacted = redactComposeFailureWithMetadata(
    value.trim(),
    runtime,
    declaredSecretValues(runtime, environment ?? process.env),
  );
  if (redacted.incomplete) return "";
  const bounded = redacted.text.split("\n").slice(-6).join("\n");
  const bytes = Buffer.from(bounded);
  if (bytes.byteLength <= 2_000) return bounded;
  return bytes.subarray(bytes.byteLength - 2_000).toString("utf8").replace(/^�/, "");
}

function secretComposeEnvironment(names: readonly string[], environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = scrubSecretEnvironment(names, environment);
  for (const name of names) {
    if (Object.hasOwn(environment, name) && typeof environment[name] === "string") result[name] = environment[name];
  }
  return result;
}

function scrubSecretEnvironment(names: readonly string[], environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of names) delete result[name];
  return result;
}

function scrubDockerRunnerEnvironment(
  runner: DockerRunner,
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): DockerRunner {
  if (names.length === 0) return runner;
  return {
    run: async (args, options = {}) => await runner.run(args, {
      ...options,
      env: scrubSecretEnvironment(names, options.env ?? environment),
    }),
    spawn: (args, options = {}) => runner.spawn(args, {
      ...options,
      env: scrubSecretEnvironment(names, options.env ?? environment),
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
