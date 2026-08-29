import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { DockerRunner } from "./docker";
import type { CommandResult, RunOptions } from "./process";
import {
  SHARED_IMAGE_BUILDER_NAME,
  SHARED_IMAGE_BUILDER_IDENTITY,
  SHARED_IMAGE_BUILDER_IDENTITY_ENV,
  fingerprintSharedImage,
  sharedImageLabels,
} from "./shared-image";
import {
  ensureSharedEnvironmentImage,
  gcSharedImageCache,
  gcSharedImages,
  inventorySharedImageBuilderCache,
  inventorySharedImages,
} from "./shared-image-docker";
import {
  acquireSharedImageLease,
  ensureSharedImageRecord,
  readSharedImageRecord,
  releaseAllLeasesForLab,
} from "./shared-image-state";
import type { StateRoots } from "./state";
import type { SharedImageProfile } from "./config";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const IMAGE_ID = `sha256:${"ab".repeat(32)}`;
const CREATED_AT = new Date(0).toISOString();

describe("shared image ensure", () => {
  test("reuses an existing cataloged image without a second build", async () => {
    const repo = await environmentRepo();
    const roots = await stateRoots();
    const docker = new ScriptedDocker();
    const profile = testProfile(repo);
    docker.inspectMissingOnce = true;
    docker.builderPresent = true;
    const first = await ensureSharedEnvironmentImage({
      stateRoot: roots.stateRoot,
      repoHash: "123456789abc",
      profile,
      repoRoot: repo,
      docker,
    });
    expect(first.imageId).toBe(IMAGE_ID);
    expect(docker.builds).toBe(1);
    docker.inspectMissingOnce = false;
    const second = await ensureSharedEnvironmentImage({
      stateRoot: roots.stateRoot,
      repoHash: "123456789abc",
      profile,
      repoRoot: repo,
      docker,
    });
    expect(second.imageId).toBe(first.imageId);
    expect(docker.builds).toBe(1);
  });

  test("concurrent ensures for one digest issue a single build", async () => {
    const repo = await environmentRepo();
    const roots = await stateRoots();
    const docker = new ScriptedDocker();
    docker.inspectMissingOnce = true;
    docker.builderPresent = true;
    docker.buildDelayMs = 50;
    const profile = testProfile(repo);
    const options = {
      stateRoot: roots.stateRoot,
      repoHash: "123456789abc",
      profile,
      repoRoot: repo,
      docker,
    };
    const [left, right] = await Promise.all([
      ensureSharedEnvironmentImage(options),
      ensureSharedEnvironmentImage(options),
    ]);
    expect(left.imageId).toBe(right.imageId);
    expect(docker.builds).toBe(1);
  });

  test("builds from a snapshot so later live-tree mutations are not consumed", async () => {
    const repo = await environmentRepo();
    const roots = await stateRoots();
    const docker = new ScriptedDocker();
    docker.inspectMissingOnce = true;
    docker.builderPresent = true;
    const profile = testProfile(repo);
    const original = await readFile(profile.dockerfile, "utf8");
    docker.onBuild = async (args) => {
      const contextArg = args.at(-1)!;
      const dockerfileArg = args[args.indexOf("--file") + 1]!;
      expect(contextArg).not.toBe(profile.context);
      expect(dockerfileArg).not.toBe(profile.dockerfile);
      expect(await readFile(dockerfileArg, "utf8")).toBe(original);
      await writeFile(join(profile.context, ".env"), "TOKEN=1\n");
      await writeFile(profile.dockerfile, "FROM alpine:3.20\nRUN echo mutated\n");
      expect(await readFile(dockerfileArg, "utf8")).toBe(original);
      expect(await Bun.file(join(contextArg, ".env")).exists()).toBe(false);
    };
    await ensureSharedEnvironmentImage({
      stateRoot: roots.stateRoot,
      repoHash: "123456789abc",
      profile,
      repoRoot: repo,
      docker,
    });
    expect(docker.builds).toBe(1);
    expect(docker.buildArgs.at(-1)).not.toBe(profile.context);
  });

  test("ensure leases inside the digest lock so apply GC cannot yank the image", async () => {
    const repo = await environmentRepo();
    const roots = await stateRoots();
    const docker = new ScriptedDocker();
    docker.inspectMissingOnce = true;
    docker.builderPresent = true;
    docker.buildDelayMs = 150;
    const profile = testProfile(repo);
    const fingerprint = await fingerprintSharedImage(repo, profile);
    const ensure = ensureSharedEnvironmentImage({
      stateRoot: roots.stateRoot,
      repoHash: "123456789abc",
      profile,
      repoRoot: repo,
      docker,
      lease: { owner: "thread-a", labId: "lab-1" },
    });
    const started = Date.now();
    while (!(await readSharedImageRecord(roots.stateRoot, fingerprint.digest))) {
      if (Date.now() - started > 2_000) throw new Error("shared image record was not created");
      await Bun.sleep(5);
    }
    const gc = gcSharedImages(roots, docker, {
      mode: "apply",
      maxAgeMs: 0,
      now: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const [reference, collected] = await Promise.all([ensure, gc]);
    expect(reference.digest).toBe(fingerprint.digest);
    expect(collected.removed).toBe(0);
    expect((await readSharedImageRecord(roots.stateRoot, fingerprint.digest))?.leases).toHaveLength(1);
    expect(docker.removals).toEqual([]);
    expect(docker.images.has(reference.imageId)).toBe(true);
  });
});

describe("shared image GC", () => {
  test("plan and apply use docker image rm --no-prune and skip leased or foreign images", async () => {
    const roots = await stateRoots();
    const digest = "ef".repeat(32);
    const tag = `skizzles-shared-image:env-${digest}`;
    const labels = sharedImageLabels({
      profile: "toolchain",
      digest,
      repoHash: "123456789abc",
      platform: "linux/arm64",
      createdAt: CREATED_AT,
    });
    await ensureSharedImageRecord(roots.stateRoot, {
      digest,
      profile: "toolchain",
      repoHash: "123456789abc",
      platform: "linux/arm64",
      tag,
      imageId: IMAGE_ID,
      lastUsedAt: new Date(0).toISOString(),
      createdAt: CREATED_AT,
    });
    const docker = new ScriptedDocker();
    docker.images.set(IMAGE_ID, { id: IMAGE_ID, labels, size: 4096, repotags: [tag] });
    docker.images.set(tag, { id: IMAGE_ID, labels, size: 4096, repotags: [tag] });

    await acquireSharedImageLease(roots.stateRoot, {
      profile: "toolchain", digest, imageId: IMAGE_ID, tag,
    }, "thread-a", "lab-1", { repoHash: "123456789abc", platform: "linux/arm64" }, new Date(0));
    const blocked = await gcSharedImages(roots, docker, { mode: "apply", maxAgeMs: 0 });
    expect(blocked.removed).toBe(0);
    expect(docker.removals).toEqual([]);

    await releaseAllLeasesForLab(roots.stateRoot, "thread-a", "lab-1", new Date(0));
    expect((await readSharedImageRecord(roots.stateRoot, digest))?.leases).toEqual([]);
    const planned = await gcSharedImages(roots, docker, { mode: "plan", maxAgeMs: 0 });
    expect(planned.mode).toBe("plan");
    expect(planned.removed).toBe(0);
    expect(planned.eligible).toBe(1);
    expect(docker.removals).toEqual([]);

    const applied = await gcSharedImages(roots, docker, { mode: "apply", maxAgeMs: 0 });
    expect(applied.removed).toBe(1);
    expect(docker.removals).toEqual([["image", "rm", "--no-prune", IMAGE_ID]]);
  });

  test("refuses cache GC against a missing or mismatched builder and never calls system prune", async () => {
    const roots = await stateRoots();
    const missing = new ScriptedDocker();
    missing.builderPresent = false;
    const absent = await gcSharedImageCache(missing, { stateRoot: roots.stateRoot, mode: "apply" });
    expect(absent.applied).toBe(false);
    expect(absent.findings[0]?.code).toBe("builder-absent");

    const foreign = new ScriptedDocker();
    foreign.builderPresent = true;
    foreign.builderDriver = "docker";
    const mismatch = await gcSharedImageCache(foreign, { stateRoot: roots.stateRoot, mode: "apply" });
    expect(mismatch.applied).toBe(false);
    expect(mismatch.findings.some((finding) => finding.code === "builder-mismatch")).toBe(true);
    expect(foreign.calls.some((args) => args.includes("prune") && args[0] === "system")).toBe(false);
    expect(foreign.calls.some((args) => args.includes("system"))).toBe(false);
  });

  test("refuses cache GC against a same-name foreign docker-container builder", async () => {
    const roots = await stateRoots();
    const foreign = new ScriptedDocker();
    foreign.builderPresent = true;
    foreign.builderDriver = "docker-container";
    foreign.builderOwned = false;
    const mismatch = await gcSharedImageCache(foreign, { stateRoot: roots.stateRoot, mode: "apply" });
    expect(mismatch.applied).toBe(false);
    expect(mismatch.findings.some((finding) => finding.code === "builder-mismatch")).toBe(true);
    expect(foreign.calls.some((args) => args.includes("prune"))).toBe(false);
  });

  test("builder cache inventory reports bytes only for the verified namespace", async () => {
    const matching = new ScriptedDocker();
    matching.builderPresent = true;
    expect(await inventorySharedImageBuilderCache(matching)).toEqual({
      present: true,
      namespaceOwned: true,
      bytes: 1048576,
      reclaimableBytes: 0,
    });
    expect(matching.calls.some((args) => args.includes("prune"))).toBe(false);

    const missing = new ScriptedDocker();
    missing.builderPresent = false;
    expect(await inventorySharedImageBuilderCache(missing)).toEqual({
      present: false,
      namespaceOwned: false,
      bytes: 0,
    });
    expect(missing.calls.some((args) => args[1] === "du")).toBe(false);
  });

  test("inventory stays bounded and counts untracked labeled images without deleting them", async () => {
    const roots = await stateRoots();
    const docker = new ScriptedDocker();
    docker.untrackedIds = [`sha256:${"11".repeat(32)}`];
    const inventory = await inventorySharedImages(roots, docker);
    expect(inventory).toEqual({
      cataloged: 0,
      present: 0,
      activeLeases: 0,
      eligible: 0,
      bytes: 0,
      reclaimableBytes: 0,
      untracked: 1,
    });
    expect(docker.removals).toEqual([]);
    expect(JSON.stringify(inventory)).not.toContain("/tmp");
    expect(JSON.stringify(inventory)).not.toContain("thread");
  });

  test("malformed labels and tag drift retain the image", async () => {
    const roots = await stateRoots();
    const digest = "aa".repeat(32);
    const tag = `skizzles-shared-image:env-${digest}`;
    await ensureSharedImageRecord(roots.stateRoot, {
      digest,
      profile: "toolchain",
      repoHash: "123456789abc",
      platform: "linux/arm64",
      tag,
      imageId: IMAGE_ID,
      lastUsedAt: new Date(0).toISOString(),
      createdAt: CREATED_AT,
    });
    const docker = new ScriptedDocker();
    docker.images.set(IMAGE_ID, {
      id: IMAGE_ID,
      labels: { "io.openai.skizzles.shared-image.managed": "true" },
      size: 12,
      repotags: ["other:latest"],
    });
    const result = await gcSharedImages(roots, docker, { mode: "apply", maxAgeMs: 0 });
    expect(result.removed).toBe(0);
    expect(docker.removals).toEqual([]);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

class ScriptedDocker implements DockerRunner {
  calls: string[][] = [];
  builds = 0;
  inspectMissingOnce = false;
  builderPresent = false;
  builderName = SHARED_IMAGE_BUILDER_NAME;
  builderDriver = "docker-container";
  builderOwned = true;
  buildDelayMs = 0;
  buildArgs: string[] = [];
  onBuild?: (args: string[]) => Promise<void>;
  images = new Map<string, { id: string; labels: Record<string, string>; size: number; repotags: string[] }>();
  untrackedIds: string[] = [];
  removals: string[][] = [];
  private seenInspect = false;

  async run(args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    if (args[0] === "image" && args[1] === "inspect") {
      const reference = args.at(-1)!;
      const image = this.images.get(reference);
      if (image) return result(JSON.stringify({
        id: image.id, labels: image.labels, size: image.size, repotags: image.repotags,
      }));
      if (this.inspectMissingOnce && !this.seenInspect) {
        this.seenInspect = true;
        return resultWithError(`Error: No such image: ${reference}`);
      }
      if (this.images.size > 0) return resultWithError(`Error: No such image: ${reference}`);
      const digest = /env-([a-f0-9]{64})$/.exec(reference)?.[1];
      if (digest && this.seenInspect) {
        const labels = sharedImageLabels({
          profile: "toolchain",
          digest,
          repoHash: "123456789abc",
          platform: "linux/arm64",
          createdAt: CREATED_AT,
        });
        return result(JSON.stringify({ id: IMAGE_ID, labels, size: 2048, repotags: [reference] }));
      }
      return resultWithError(`Error: No such image: ${reference}`);
    }
    if (args[0] === "image" && args[1] === "ls") {
      return result(this.untrackedIds.join("\n"));
    }
    if (args[0] === "image" && args[1] === "rm") {
      this.removals.push(args);
      const id = args.at(-1)!;
      this.images.delete(id);
      for (const [key, image] of this.images) if (image.id === id) this.images.delete(key);
      return result("");
    }
    if (args[0] === "buildx" && args[1] === "inspect") {
      if (!this.builderPresent || args[2] !== this.builderName) {
        return resultWithError(`ERROR: no builder "${args[2]}" found`);
      }
      return result(`Name:          ${this.builderName}\nDriver:        ${this.builderDriver}\n\nNodes:\nName:          ${this.builderName}0\n`);
    }
    if (args[0] === "buildx" && args[1] === "create") {
      this.builderPresent = true;
      this.builderOwned = true;
      return result("");
    }
    if (args[0] === "inspect") {
      if (!this.builderPresent) return resultWithError("Error: No such object");
      const env = this.builderOwned
        ? [`${SHARED_IMAGE_BUILDER_IDENTITY_ENV}=${SHARED_IMAGE_BUILDER_IDENTITY}`]
        : ["PATH=/usr/bin"];
      return result(JSON.stringify(env));
    }
    if (args[0] === "buildx" && args[1] === "build") {
      this.builds += 1;
      this.buildArgs = args;
      if (this.onBuild) await this.onBuild(args);
      if (this.buildDelayMs) await Bun.sleep(this.buildDelayMs);
      const iidIndex = args.indexOf("--iidfile");
      if (iidIndex >= 0) await writeFile(args[iidIndex + 1]!, IMAGE_ID);
      const tagIndex = args.indexOf("--tag");
      const tag = tagIndex >= 0 ? args[tagIndex + 1]! : "";
      const digest = /env-([a-f0-9]{64})$/.exec(tag)?.[1] ?? "ab".repeat(32);
      const labels = sharedImageLabels({
        profile: "toolchain",
        digest,
        repoHash: "123456789abc",
        platform: "linux/arm64",
        createdAt: CREATED_AT,
      });
      this.images.set(tag, { id: IMAGE_ID, labels, size: 2048, repotags: [tag] });
      this.images.set(IMAGE_ID, { id: IMAGE_ID, labels, size: 2048, repotags: [tag] });
      this.seenInspect = true;
      return result("");
    }
    if (args[0] === "buildx" && args[1] === "du") {
      return result("Total: 1.0 MiB\nReclaimable: 0 B\n");
    }
    if (args[0] === "buildx" && args[1] === "prune") {
      return result("");
    }
    return result("");
  }

  spawn(): ChildProcessWithoutNullStreams {
    return new EventEmitter() as ChildProcessWithoutNullStreams;
  }
}

async function environmentRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shared-image-docker-"));
  temporary.push(root);
  await mkdir(join(root, "environment"));
  await writeFile(join(root, "environment", "Dockerfile"), "FROM alpine:3.20\nARG TOOLCHAIN=1\nRUN echo $TOOLCHAIN\n");
  return root;
}

async function stateRoots(): Promise<StateRoots> {
  const root = await mkdtemp(join(tmpdir(), "shared-image-docker-state-"));
  temporary.push(root);
  return { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
}

function testProfile(repoRoot: string): SharedImageProfile {
  return {
    name: "toolchain",
    context: join(repoRoot, "environment"),
    dockerfile: join(repoRoot, "environment", "Dockerfile"),
    platform: "linux/arm64",
    buildArgs: { TOOLCHAIN: "1" },
    services: ["app"],
  };
}

function result(stdout: string): CommandResult {
  return { code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

function resultWithError(stderr: string): CommandResult {
  return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) };
}
