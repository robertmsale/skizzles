import type { CommandResult } from "../execution/process";
import type { LabMetadata } from "../storage/records";
import { internalImageTag } from "./definition";
import { defaultDockerRunner, scrubDockerRunnerEnvironment, type DockerRunner } from "./docker-runner";
import type { LabRuntime } from "./runtime";

export async function destroyLabStack(runtime: LabRuntime, runner: DockerRunner = defaultDockerRunner): Promise<void> {
  await cleanupLabLabels(runtime.metadata, runtime.config.mode.kind === "dockerfile", runner);
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


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
