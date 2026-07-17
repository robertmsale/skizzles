import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureOwner,
  listLabs,
  ownerDirectory,
  ownerKey,
  readLab,
  resolveOwner,
  writeLab,
} from "./state";
import type { LabMetadata } from "./types";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("owner resolution and durable state", () => {
  test("uses an explicit exact owner before CODEX_THREAD_ID and never invents one", () => {
    expect(resolveOwner("explicit/owner", { CODEX_THREAD_ID: "environment" })).toBe("explicit/owner");
    expect(resolveOwner(undefined, { CODEX_THREAD_ID: "environment owner" })).toBe("environment owner");
    expect(() => resolveOwner(undefined, {})).toThrow("owner is required");
    expect(() => resolveOwner("", {})).toThrow("owner is required");
  });

  test("keys arbitrary exact owners by a collision-resistant hash and persists across readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-state-"));
    temporary.push(root);
    const owner = "thread/with spaces:and?characters";
    await ensureOwner(root, owner);
    expect(ownerDirectory(root, owner)).toBe(join(root, "owners", ownerKey(owner)));
    expect(ownerKey(owner)).toHaveLength(64);
    const lab = fixtureLab(root, owner);
    const roots = { stateRoot: root, runtimeRoot: join(root, "runtime") };
    await writeLab(roots, lab);
    expect(await readLab(roots, owner, lab.id)).toEqual(lab);
    expect(await listLabs(roots, owner)).toEqual([lab]);
  });

  test("creates only the owner and lab state directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-state-"));
    temporary.push(root);
    const owner = "thread-minimal-state";

    await ensureOwner(root, owner);

    expect((await readdir(ownerDirectory(root, owner))).sort()).toEqual(["labs", "owner.json"]);
  });

  test("accepts synchronous provisioning manifests without worker identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-state-"));
    temporary.push(root);
    const owner = "synchronous-provisioning";
    const roots = { stateRoot: root, runtimeRoot: join(root, "runtime") };
    const lab = { ...fixtureLab(root, owner), state: "provisioning" as const };

    await ensureOwner(root, owner);
    await writeLab(roots, lab);
    const persisted = await readLab(roots, owner, lab.id);

    expect(persisted).toEqual(lab);
    expect(Object.keys(persisted).sort()).toEqual(Object.keys(lab).sort());
  });
});

function fixtureLab(root: string, owner: string): LabMetadata {
  const key = ownerKey(owner);
  const runtimeRoot = join(root, "runtime", key, "lab-1");
  return {
    version: 1,
    id: "lab-1",
    name: "lab",
    owner,
    ownerKey: key,
    repoHash: "123456789abc",
    composeProject: "ccl-test-lab",
    state: "failed",
    sourceRoot: join(root, "source"),
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(root, "source", ".codex-container-lab.yaml"),
    commandService: "dev",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    endpoints: [],
    findings: [],
    secretEnvironment: [],
  };
}
