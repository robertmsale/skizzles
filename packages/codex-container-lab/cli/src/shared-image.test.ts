import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLabConfig } from "./config";
import {
  fingerprintSharedImage,
  hasExactSharedImageLabels,
  rejectUnaccountedBuildArgs,
  rejectUnsafeDockerfile,
  sharedImageLabels,
  sharedImageTag,
  type SharedImageProfile,
} from "./shared-image";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("shared image digest", () => {
  test("is deterministic across owners, labs, and checkout paths", async () => {
    const first = await environmentRepo("alpha");
    const second = await environmentRepo("beta");
    const profile = (repoRoot: string): SharedImageProfile => ({
      name: "toolchain",
      context: join(repoRoot, "environment"),
      dockerfile: join(repoRoot, "environment", "Dockerfile"),
      platform: "linux/arm64",
      buildArgs: { TOOLCHAIN: "1" },
      services: ["app"],
    });
    const left = await fingerprintSharedImage(first, profile(first));
    const right = await fingerprintSharedImage(second, profile(second));
    expect(left.digest).toBe(right.digest);
    expect(left.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(left.tag).toBe(sharedImageTag(left.digest));
    expect(left.files.map((file) => file.path)).toEqual(["Dockerfile"]);
  });

  test("ignores source edits outside the environment context", async () => {
    const root = await environmentRepo("source-edit");
    const profile = testProfile(root);
    const before = await fingerprintSharedImage(root, profile);
    await writeFile(join(root, "app.rs"), "fn main() {}\n");
    const after = await fingerprintSharedImage(root, profile);
    expect(after.digest).toBe(before.digest);
  });

  test("changes when Dockerfile, context, target, build-arg, or platform changes", async () => {
    const root = await environmentRepo("inputs");
    const base = await fingerprintSharedImage(root, testProfile(root));
    await writeFile(join(root, "environment", "Dockerfile"), "FROM alpine:3.20\nARG TOOLCHAIN=1\nRUN echo changed\n");
    expect((await fingerprintSharedImage(root, testProfile(root))).digest).not.toBe(base.digest);

    const fresh = await environmentRepo("inputs-2");
    const withFile = await fingerprintSharedImage(fresh, testProfile(fresh));
    await writeFile(join(fresh, "environment", "packages.txt"), "git\n");
    expect((await fingerprintSharedImage(fresh, testProfile(fresh))).digest).not.toBe(withFile.digest);

    const targeted = await environmentRepo("target");
    const beforeTarget = await fingerprintSharedImage(targeted, testProfile(targeted));
    expect((await fingerprintSharedImage(targeted, { ...testProfile(targeted), target: "runtime" })).digest)
      .not.toBe(beforeTarget.digest);

    const args = await environmentRepo("args");
    const beforeArgs = await fingerprintSharedImage(args, testProfile(args));
    expect((await fingerprintSharedImage(args, { ...testProfile(args), buildArgs: { TOOLCHAIN: "2" } })).digest)
      .not.toBe(beforeArgs.digest);

    const platform = await environmentRepo("platform");
    const beforePlatform = await fingerprintSharedImage(platform, testProfile(platform));
    expect((await fingerprintSharedImage(platform, { ...testProfile(platform), platform: "linux/amd64" })).digest)
      .not.toBe(beforePlatform.digest);
  });

  test("respects dockerignore and still hashes the ignore file", async () => {
    const root = await environmentRepo("ignore");
    await writeFile(join(root, "environment", ".dockerignore"), "scratch.txt\n");
    await writeFile(join(root, "environment", "scratch.txt"), "one\n");
    const before = await fingerprintSharedImage(root, testProfile(root));
    expect(before.files.some((file) => file.path === "scratch.txt")).toBe(false);
    await writeFile(join(root, "environment", "scratch.txt"), "two\n");
    expect((await fingerprintSharedImage(root, testProfile(root))).digest).toBe(before.digest);
    await writeFile(join(root, "environment", ".dockerignore"), "scratch.txt\n# note\n");
    expect((await fingerprintSharedImage(root, testProfile(root))).digest).not.toBe(before.digest);
  });

  test("hashes dockerignore exceptions inside ignored directories", async () => {
    const root = await environmentRepo("ignore-exception");
    await mkdir(join(root, "environment", "keepdir"));
    await writeFile(join(root, "environment", "keepdir", "keep.txt"), "keep-one\n");
    await writeFile(join(root, "environment", "keepdir", "drop.txt"), "drop\n");
    await writeFile(join(root, "environment", ".dockerignore"), "**\n!Dockerfile\n!keepdir/\n!keepdir/keep.txt\n");
    const before = await fingerprintSharedImage(root, testProfile(root));
    expect(before.files.map((file) => file.path).sort()).toEqual(["Dockerfile", "keepdir/keep.txt"]);
    await writeFile(join(root, "environment", "keepdir", "keep.txt"), "keep-two\n");
    const afterKeep = await fingerprintSharedImage(root, testProfile(root));
    expect(afterKeep.digest).not.toBe(before.digest);
    await writeFile(join(root, "environment", "keepdir", "drop.txt"), "drop-two\n");
    expect((await fingerprintSharedImage(root, testProfile(root))).digest).toBe(afterKeep.digest);
  });
});

describe("shared image safety", () => {
  test("rejects secret, SSH, bind, and remote Dockerfile inputs", () => {
    expect(() => rejectUnsafeDockerfile("toolchain", "RUN --mount=type=secret,id=token cat /run/secrets/token\n"))
      .toThrow("secret mount");
    expect(() => rejectUnsafeDockerfile("toolchain", "RUN --mount=type=ssh,id=default git clone git@example.com/repo\n"))
      .toThrow("SSH mount");
    expect(() => rejectUnsafeDockerfile("toolchain", "RUN --mount=type=bind,source=/etc,target=/host cat /host/passwd\n"))
      .toThrow("bind mount");
    expect(() => rejectUnsafeDockerfile("toolchain", 'RUN --mount=id=token,type="secret" cat /run/secrets/token\n'))
      .toThrow("secret mount");
    expect(() => rejectUnsafeDockerfile("toolchain", "ADD https://example.com/rootfs.tgz /opt\n"))
      .toThrow("remote ADD");
    expect(() => rejectUnaccountedBuildArgs("toolchain", "ARG TOKEN\nFROM alpine\n", {}))
      .toThrow("ARG TOKEN");
    expect(() => rejectUnaccountedBuildArgs("toolchain", "ARG TOKEN=dev\nFROM alpine\n", {})).not.toThrow();
  });

  test("rejects secret files, Git metadata, and escaping symlinks in context", async () => {
    const secrets = await environmentRepo("secrets");
    await writeFile(join(secrets, "environment", ".env"), "TOKEN=1\n");
    await expect(fingerprintSharedImage(secrets, testProfile(secrets))).rejects.toThrow("secret or mutable input");

    const git = await environmentRepo("gitmeta");
    await mkdir(join(git, "environment", ".git"));
    await expect(fingerprintSharedImage(git, testProfile(git))).rejects.toThrow("mutable Git metadata");

    const links = await environmentRepo("links");
    await symlink("/etc/passwd", join(links, "environment", "passwd"));
    await expect(fingerprintSharedImage(links, testProfile(links))).rejects.toThrow("relative");
  });

  test("requires the exact Skizzles label set and ignores extra non-namespace labels", () => {
    const createdAt = new Date(0).toISOString();
    const labels = sharedImageLabels({
      profile: "toolchain",
      digest: "a".repeat(64),
      repoHash: "123456789abc",
      platform: "linux/arm64",
      createdAt,
    });
    expect(hasExactSharedImageLabels({ ...labels, "org.opencontainers.image.created": createdAt }, {
      profile: "toolchain",
      digest: "a".repeat(64),
      repoHash: "123456789abc",
      platform: "linux/arm64",
    })).toBe(true);
    expect(hasExactSharedImageLabels({ ...labels, "io.openai.skizzles.shared-image.extra": "nope" }, {
      profile: "toolchain",
      digest: "a".repeat(64),
      repoHash: "123456789abc",
      platform: "linux/arm64",
    })).toBe(false);
    expect(JSON.stringify(labels)).not.toContain("/tmp");
    expect(JSON.stringify(labels)).not.toContain("/Users");
    expect(JSON.stringify(labels)).not.toContain("thread");
  });
});

describe("shared image manifest parsing", () => {
  test("parses named environment profiles and rejects shorthand reuse", () => {
    const config = parseLabConfig(`
compose: { files: [compose.yaml], command_service: app }
shared_images:
  toolchain:
    context: environment
    dockerfile: environment/Dockerfile
    platform: linux/arm64
    build_args: { TOOLCHAIN: "1" }
    services: [app]
`, "/tmp/example-repository");
    expect(config.sharedImages).toEqual([{
      name: "toolchain",
      context: "/tmp/example-repository/environment",
      dockerfile: "/tmp/example-repository/environment/Dockerfile",
      platform: "linux/arm64",
      buildArgs: { TOOLCHAIN: "1" },
      services: ["app"],
    }]);

    expect(() => parseLabConfig(`
image: { name: node:24, service: app }
shared_images:
  toolchain:
    context: environment
    dockerfile: environment/Dockerfile
    platform: linux/arm64
    services: [app]
`, "/tmp/example-repository")).toThrow("requires compose mode");
  });
});

async function environmentRepo(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `shared-image-${label}-`));
  temporary.push(root);
  await mkdir(join(root, "environment"));
  await writeFile(join(root, "environment", "Dockerfile"), "FROM alpine:3.20\nARG TOOLCHAIN=1\nRUN echo $TOOLCHAIN\n");
  return root;
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
