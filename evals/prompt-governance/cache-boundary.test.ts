import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCacheOutside, createPrivateCache, openPrivateCache, parseCacheLocator, privateCachePath, removePrivateCache } from "./cache";
import { executeRun } from "./capture";

test("forged handles fail before genuine cache deletion", async () => {
  const created = await createPrivateCache(); const cache = created.handle; const root = privateCachePath(created.locator.id); const foreign = await mkdtemp(join(tmpdir(), "skizzles-foreign-cache-"));
  await writeFile(join(foreign, "sentinel"), "keep");
  try {
    await expect(removePrivateCache({ locator: created.locator } as never)).rejects.toThrow("verified handle required");
    expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("keep");
    expect((await lstat(root)).isDirectory()).toBe(true);
  } finally { await removePrivateCache(cache); await rm(foreign, { recursive: true, force: true }); }
});

test("cache locators require canonical lowercase UUIDs", async () => {
  const identity = { device: 1, inode: 1 };
  const commitment = "0".repeat(64);
  for (const id of ["-".repeat(36), "a".repeat(36), "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", "00000000-0000-0000-0000-000000000000x"]) {
    await expect(createPrivateCache(id)).rejects.toThrow("identifier");
    expect(() => parseCacheLocator({ id, commitment, identity })).toThrow("values");
  }
});

test("cache boundary rejects a public symlink alias", async () => {
  const created = await createPrivateCache(); const cache = created.handle; const root = privateCachePath(created.locator.id); const parent = await mkdtemp(join(tmpdir(), "skizzles-cache-alias-")); const alias = join(parent, "artifact-root");
  await symlink(root, alias);
  try {
    await expect(assertCacheOutside(cache, alias)).rejects.toThrow("aliases");
    const reopened = await openPrivateCache(created.locator);
    expect(privateCachePath(reopened.locator.id)).toBe(root);
  } finally { await removePrivateCache(cache); await rm(parent, { recursive: true, force: true }); }
});

test("cache cleanup refuses a symlink replacement", async () => {
  const created = await createPrivateCache(); const cache = created.handle; const expected = privateCachePath(created.locator.id); const foreign = await mkdtemp(join(tmpdir(), "skizzles-cache-replacement-"));
  await removePrivateCache(cache); await symlink(foreign, expected);
  try {
    await expect(removePrivateCache(cache)).rejects.toThrow("private-cache-integrity");
    expect((await lstat(foreign)).isDirectory()).toBe(true);
  } finally { await rm(expected, { force: true }); await rm(foreign, { recursive: true, force: true }); }
});

test("marker symlinks fail before any marker read", async () => {
  const created = await createPrivateCache(); const cache = created.handle; const root = privateCachePath(created.locator.id); const marker = join(root, ".skizzles-cache-owner"); const target = await mkdtemp(join(tmpdir(), "skizzles-marker-target-"));
  await rm(marker); await symlink(join(target, "marker"), marker);
  try {
    await expect(openPrivateCache(created.locator)).rejects.toThrow("owner marker");
    await expect(removePrivateCache(cache)).rejects.toThrow("owner marker");
    expect((await lstat(target)).isDirectory()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

test("cache cleanup refuses a missing owner marker without deleting payloads", async () => {
  const created = await createPrivateCache(); const cache = created.handle; const root = privateCachePath(created.locator.id); await writeFile(join(root, "payload"), "keep"); await rm(join(root, ".skizzles-cache-owner"));
  try { await expect(removePrivateCache(cache)).rejects.toThrow("private-cache-integrity"); expect(await readFile(join(root, "payload"), "utf8")).toBe("keep"); } finally { await rm(root, { recursive: true, force: true }); }
});

test("opening a deleted cache reports missing rather than integrity", async () => {
  const created = await createPrivateCache();
  await rm(privateCachePath(created.locator.id), { recursive: true, force: true });
  await expect(openPrivateCache(created.locator)).rejects.toThrow("private-cache-missing");
});

test("direct capture cannot fall back to the public artifact root", async () => {
  const root = await mkdtemp(join(tmpdir(), "skizzles-direct-public-"));
  try { await expect(executeRun({ repositoryRoot: root, artifactRoot: root } as never)).rejects.toThrow(); expect((await readdir(root)).length).toBe(0); } finally { await rm(root, { recursive: true, force: true }); }
});
