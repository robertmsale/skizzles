import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDockerRunner, dockerAvailable } from "./docker";
import { ContainerLabService } from "./service";
import { SHARED_IMAGE_BUILDER_NAME } from "./shared-image";
import {
  ensureSharedEnvironmentImage,
  gcSharedImageCache,
  gcSharedImages,
  inventorySharedImages,
} from "./shared-image-docker";
import { acquireSharedImageLease, readSharedImageRecord, releaseAllLeasesForLab } from "./shared-image-state";
import { ensureOwner, ownerKey, writeLab, type StateRoots } from "./state";
import type { LabMetadata } from "./types";

const probe = await dockerAvailable();
const enabled = probe.available;

const temporary: string[] = [];
const docker = defaultDockerRunner;
const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";

afterAll(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("shared image docker acceptance", () => {
  test("concurrent ensure, destroy, inventory, GC, and --no-prune preserve foreign resources", async () => {
    const pulled = await docker.run(["pull", "alpine:3.20"], { allowFailure: true, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
    expect(pulled.code).toBe(0);

    const repo = await environmentRepo();
    const roots = await stateRoots();
    const profile = {
      name: "toolchain" as const,
      context: join(repo, "environment"),
      dockerfile: join(repo, "environment", "Dockerfile"),
      platform,
      buildArgs: { TOOLCHAIN: "1" },
      services: ["app"],
    };
    const before = await resourceSnapshot();
    const foreignTag = `skizzles-foreign-${crypto.randomUUID().slice(0, 8)}`;
    const tagged = await docker.run(["tag", "alpine:3.20", foreignTag], { allowFailure: true, timeoutMs: 30_000 });
    expect(tagged.code).toBe(0);

    const [first, second] = await Promise.all([
      ensureSharedEnvironmentImage({
        stateRoot: roots.stateRoot, repoHash: "123456789abc", profile, repoRoot: repo, docker,
      }),
      ensureSharedEnvironmentImage({
        stateRoot: roots.stateRoot, repoHash: "123456789abc", profile, repoRoot: repo, docker,
      }),
    ]);
    expect(first.imageId).toBe(second.imageId);
    expect(first.digest).toBe(second.digest);

    const afterEnsure = await resourceSnapshot();
    expectPreserved(before, afterEnsure);
    expect(hasImage(afterEnsure.images, first.imageId)).toBe(true);

    const owner = "thread-shared-image-accept";
    await ensureOwner(roots.stateRoot, owner);
    await acquireSharedImageLease(roots.stateRoot, first, owner, "lab-1", {
      repoHash: "123456789abc", platform,
    });
    await writeLab(roots, failedLab(roots, owner, "lab-1", first));
    const service = new ContainerLabService(owner, roots, docker);
    await service.destroyLab("lab-1");
    const stillThere = await docker.run(["image", "inspect", "-f", "{{.Id}}", first.imageId], {
      allowFailure: true, timeoutMs: 10_000,
    });
    expect(stillThere.code).toBe(0);
    expect(stillThere.stdout.toString().trim()).toBe(first.imageId);
    const afterDestroy = await resourceSnapshot();
    expectPreserved(before, afterDestroy);
    expect(hasImage(afterDestroy.images, first.imageId)).toBe(true);

    const inventory = await inventorySharedImages(roots, docker, { maxAgeMs: 0 });
    expect(inventory.present).toBe(1);
    expect(inventory.activeLeases).toBe(0);
    expect(JSON.stringify(inventory)).not.toContain(owner);
    expect(JSON.stringify(inventory)).not.toContain(repo);

    const planned = await gcSharedImages(roots, docker, { mode: "plan", maxAgeMs: 0 });
    expect(planned.removed).toBe(0);
    expect(planned.eligible).toBe(1);

    const cachePlan = await gcSharedImageCache(docker, { stateRoot: roots.stateRoot, mode: "plan" });
    expect(cachePlan.applied).toBe(false);
    expect(cachePlan.builder).toBe(SHARED_IMAGE_BUILDER_NAME);

    const alpineBefore = await docker.run(["image", "inspect", "-f", "{{.Id}}", "alpine:3.20"], {
      allowFailure: true, timeoutMs: 10_000,
    });
    const applied = await gcSharedImages(roots, docker, { mode: "apply", maxAgeMs: 0 });
    expect(applied.removed).toBe(1);
    const gone = await docker.run(["image", "inspect", first.imageId], { allowFailure: true, timeoutMs: 10_000 });
    expect(gone.code).not.toBe(0);
    const alpineAfter = await docker.run(["image", "inspect", "-f", "{{.Id}}", "alpine:3.20"], {
      allowFailure: true, timeoutMs: 10_000,
    });
    expect(alpineAfter.stdout.toString()).toBe(alpineBefore.stdout.toString());
    const foreign = await docker.run(["image", "inspect", foreignTag], { allowFailure: true, timeoutMs: 10_000 });
    expect(foreign.code).toBe(0);

    const afterGc = await resourceSnapshot();
    expectPreserved(before, afterGc);
    expect(hasImage(afterGc.images, first.imageId)).toBe(false);

    await docker.run(["image", "rm", "--no-prune", foreignTag], { allowFailure: true, timeoutMs: 10_000 });
    await releaseAllLeasesForLab(roots.stateRoot, owner, "lab-1");
  }, 180_000);

  test("ensure leases atomically so immediate apply GC cannot remove the image", async () => {
    const repo = await environmentRepo();
    const roots = await stateRoots();
    const profile = {
      name: "toolchain" as const,
      context: join(repo, "environment"),
      dockerfile: join(repo, "environment", "Dockerfile"),
      platform,
      buildArgs: { TOOLCHAIN: "1" },
      services: ["app"],
    };
    const owner = "thread-shared-image-lease";
    const before = await resourceSnapshot();
    const reference = await ensureSharedEnvironmentImage({
      stateRoot: roots.stateRoot,
      repoHash: "123456789abc",
      profile,
      repoRoot: repo,
      docker,
      lease: { owner, labId: "lab-1" },
    });
    expect((await readSharedImageRecord(roots.stateRoot, reference.digest))?.leases).toHaveLength(1);
    const applied = await gcSharedImages(roots, docker, { mode: "apply", maxAgeMs: 0 });
    expect(applied.removed).toBe(0);
    const stillThere = await docker.run(["image", "inspect", "-f", "{{.Id}}", reference.imageId], {
      allowFailure: true, timeoutMs: 10_000,
    });
    expect(stillThere.code).toBe(0);
    expect(stillThere.stdout.toString().trim()).toBe(reference.imageId);
    expectPreserved(before, await resourceSnapshot());
    await releaseAllLeasesForLab(roots.stateRoot, owner, "lab-1");
    const removed = await gcSharedImages(roots, docker, { mode: "apply", maxAgeMs: 0 });
    expect(removed.removed).toBe(1);
    const gone = await docker.run(["image", "inspect", reference.imageId], { allowFailure: true, timeoutMs: 10_000 });
    expect(gone.code).not.toBe(0);
    expectPreserved(before, await resourceSnapshot());
  }, 180_000);
});

async function environmentRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shared-image-accept-"));
  temporary.push(root);
  await mkdir(join(root, "environment"));
  await writeFile(join(root, "environment", "Dockerfile"), `FROM alpine:3.20
ARG TOOLCHAIN=1
RUN echo "${crypto.randomUUID()}" > /etc/skizzles-env && echo $TOOLCHAIN
`);
  return root;
}

async function stateRoots(): Promise<StateRoots> {
  const root = await mkdtemp(join(tmpdir(), "shared-image-accept-state-"));
  temporary.push(root);
  return { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
}

async function resourceSnapshot(): Promise<{
  images: Set<string>;
  containers: Set<string>;
  networks: Set<string>;
  volumes: Set<string>;
}> {
  const [images, containers, networks, volumes] = await Promise.all([
    ids(["image", "ls", "-q", "--no-trunc"]),
    ids(["ps", "-aq", "--no-trunc"]),
    ids(["network", "ls", "-q"]),
    ids(["volume", "ls", "-q"]),
  ]);
  return { images, containers, networks, volumes };
}

async function ids(args: string[]): Promise<Set<string>> {
  const listed = await docker.run(args, {
    allowFailure: true, timeoutMs: 15_000, maxOutputBytes: 1024 * 1024,
  });
  return new Set(listed.stdout.toString().trim().split("\n").filter(Boolean));
}

function hasImage(images: Set<string>, imageId: string): boolean {
  const digest = imageId.startsWith("sha256:") ? imageId.slice(7) : imageId;
  return images.has(imageId) || images.has(digest) || images.has(`sha256:${digest}`) ||
    [...images].some((id) => id.endsWith(digest));
}

function expectPreserved(
  before: { images: Set<string>; containers: Set<string>; networks: Set<string>; volumes: Set<string> },
  after: { images: Set<string>; containers: Set<string>; networks: Set<string>; volumes: Set<string> },
): void {
  for (const id of before.containers) expect(after.containers.has(id)).toBe(true);
  for (const id of before.networks) expect(after.networks.has(id)).toBe(true);
  for (const id of before.volumes) expect(after.volumes.has(id)).toBe(true);
  for (const id of before.images) expect(after.images.has(id)).toBe(true);
}

function failedLab(
  roots: StateRoots,
  owner: string,
  id: string,
  reference: { profile: string; digest: string; imageId: string; tag: string },
): LabMetadata {
  const key = ownerKey(owner);
  const runtimeRoot = join(roots.runtimeRoot, key, id);
  const sourceRoot = join(roots.runtimeRoot, "source");
  return {
    version: 1,
    id,
    name: "lab",
    owner,
    ownerKey: key,
    repoHash: "123456789abc",
    composeProject: "ccl-share0001",
    state: "failed",
    sourceRoot,
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(sourceRoot, ".codex-container-lab.yaml"),
    commandService: "app",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    endpoints: [],
    findings: [],
    secretEnvironment: [],
    sharedImages: [reference],
  };
}
