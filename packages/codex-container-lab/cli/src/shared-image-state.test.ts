import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  acquireSharedImageLease,
  readSharedImageRecord,
  releaseAllLeasesForLab,
  releaseLabSharedImageLeases,
  sharedImageRecordPath,
} from "./shared-image-state";
import { ensureOwner, writeLab, type StateRoots } from "./state";
import type { LabMetadata, SharedImageReference } from "./types";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("shared image leases", () => {
  test("acquire is idempotent per owner+lab and release is exact", async () => {
    const roots = await stateRoots();
    const reference = sampleReference();
    await acquireSharedImageLease(roots.stateRoot, reference, "thread-a", "lab-1", extras());
    await acquireSharedImageLease(roots.stateRoot, reference, "thread-a", "lab-1", extras());
    await acquireSharedImageLease(roots.stateRoot, reference, "thread-b", "lab-2", extras());
    const record = await readSharedImageRecord(roots.stateRoot, reference.digest);
    expect(record?.leases).toHaveLength(2);
    expect(record?.leases.map((lease) => lease.labId).sort()).toEqual(["lab-1", "lab-2"]);

    await releaseLabSharedImageLeases(roots.stateRoot, {
      owner: "thread-a",
      id: "lab-1",
      sharedImages: [reference],
    });
    const after = await readSharedImageRecord(roots.stateRoot, reference.digest);
    expect(after?.leases).toHaveLength(1);
    expect(after?.leases[0]?.labId).toBe("lab-2");
  });

  test("releases a lease even when lab metadata never recorded the reference", async () => {
    const roots = await stateRoots();
    const reference = sampleReference();
    await acquireSharedImageLease(roots.stateRoot, reference, "thread-a", "lab-1", extras());
    await releaseAllLeasesForLab(roots.stateRoot, "thread-a", "lab-1");
    expect((await readSharedImageRecord(roots.stateRoot, reference.digest))?.leases).toEqual([]);
  });

  test("keeps a stale unresolved lease GC-ineligible after the catalog is written", async () => {
    const roots = await stateRoots();
    const reference = sampleReference();
    await acquireSharedImageLease(roots.stateRoot, reference, "thread-a", "lab-missing", extras());
    const record = await readSharedImageRecord(roots.stateRoot, reference.digest);
    expect(record?.leases).toHaveLength(1);
    expect(JSON.parse(await Bun.file(sharedImageRecordPath(roots.stateRoot, reference.digest)).text()).owner).toBeUndefined();
  });

  test("legacy v1 lab metadata without sharedImages remains writable", async () => {
    const roots = await stateRoots();
    const owner = "thread-legacy";
    await ensureOwner(roots.stateRoot, owner);
    await writeLab(roots, legacyLab(roots, owner));
  });
});

async function stateRoots(): Promise<StateRoots> {
  const root = await mkdtemp(join(tmpdir(), "shared-image-state-"));
  temporary.push(root);
  const roots = { stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime") };
  await mkdir(roots.stateRoot, { recursive: true });
  return roots;
}

function sampleReference(): SharedImageReference {
  const digest = "ab".repeat(32);
  return {
    profile: "toolchain",
    digest,
    imageId: `sha256:${"cd".repeat(32)}`,
    tag: `skizzles-shared-image:env-${digest}`,
  };
}

function extras(): { repoHash: string; platform: string } {
  return { repoHash: "123456789abc", platform: "linux/arm64" };
}

function legacyLab(roots: StateRoots, owner: string): LabMetadata {
  const ownerKey = createHash("sha256").update(owner).digest("hex");
  const runtimeRoot = join(roots.runtimeRoot, ownerKey, "lab-1");
  return {
    version: 1,
    id: "lab-1",
    name: "lab",
    owner,
    ownerKey,
    repoHash: "123456789abc",
    composeProject: "ccl-legacy01",
    state: "failed",
    sourceRoot: join(roots.runtimeRoot, "source"),
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(roots.runtimeRoot, "source", ".codex-container-lab.yaml"),
    commandService: "app",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    endpoints: [],
    findings: [],
    secretEnvironment: [],
  };
}
