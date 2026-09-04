import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmpManager } from "../src/manager.ts";
import { createLocalServer } from "../src/local-server.ts";
import { daemonRequest } from "../src/client.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

test("mode-private local transport serves correlated JSON commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "skizzles-omp-local-"));
  const socketPath = join(root, "daemon.sock");
  const manager = { projects: { list: () => [{ id: "fixture", name: "Crème 🥧" }] } } as unknown as OmpManager;
  const server = createLocalServer(manager);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  expect(await daemonRequest({ op: "health" }, { socketPath })).toEqual({
    ok: true,
    result: { service: "omp-orchestrationd", schema: 1 },
  });
  expect(await daemonRequest({ op: "does.not.exist" }, { socketPath })).toMatchObject({ ok: false, code: "not_found" });
  expect(await daemonRequest({ op: "projects.list" }, { socketPath })).toEqual({
    ok: true,
    result: [{ id: "fixture", name: "Crème 🥧" }],
  });
});
