import { afterEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { OmpManager } from "../src/manager.ts";
import { createHttpServer } from "../src/http-server.ts";

const servers: ReturnType<typeof createHttpServer>[] = [];
const TOKEN = "test-token-at-least-24-characters";
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

async function origin(token = TOKEN, allowedProjects?: ReadonlySet<string>, manager = {} as OmpManager): Promise<string> {
  const server = createHttpServer(manager, { token, allowedProjects });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("HTTP ingress authentication", () => {
  test("keeps health public but distinguishes missing and invalid bearer credentials", async () => {
    const url = await origin();
    expect((await fetch(`${url}/v1/health`)).status).toBe(200);
    const missing = await fetch(`${url}/v1/request`, { method: "POST" });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ code: "unauthenticated" });
    const invalid = await fetch(`${url}/v1/request`, { method: "POST", headers: { authorization: "Bearer nope" } });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toMatchObject({ code: "invalid_session" });
  });

  test("rejects browser origins and out-of-scope projects", async () => {
    const url = await origin(TOKEN, new Set(["allowed"]));
    const browser = await fetch(`${url}/v1/request`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, origin: "https://example.test", "content-type": "application/json" }, body: JSON.stringify({ op: "health" }),
    });
    expect(browser.status).toBe(403);
    const forbidden = await fetch(`${url}/v1/request`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ op: "maintainers.status", projectId: "forbidden" }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "unauthorized" });
  });

  test("filters project discovery for a scoped token", async () => {
    const manager = { projects: { list: () => [{ id: "allowed" }, { id: "hidden" }] } } as unknown as OmpManager;
    const url = await origin(TOKEN, new Set(["allowed"]), manager);
    const response = await fetch(`${url}/v1/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "projects.list" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: [{ id: "allowed" }] });
    const add = await fetch(`${url}/v1/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "projects.add", projectId: "allowed", id: "new", cwd: "/tmp/new" }),
    });
    expect(add.status).toBe(403);
    expect(await add.json()).toMatchObject({ code: "unauthorized" });
  });

  test("reports malformed JSON and route encoding as client errors", async () => {
    const url = await origin();
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const malformed = await fetch(`${url}/v1/request`, { method: "POST", headers, body: "{" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_request" });
    const route = await fetch(`${url}/v1/projects/%ZZ/inbox`, { method: "POST", headers, body: "{}" });
    expect(route.status).toBe(400);
    expect(await route.json()).toMatchObject({ code: "invalid_request" });
  });

  test("does not let an inbox body override its routed operation or project", async () => {
    const manager = { acceptIngress: async (input: unknown) => input } as unknown as OmpManager;
    const url = await origin(TOKEN, new Set(["allowed"]), manager);
    const response = await fetch(`${url}/v1/projects/allowed/inbox`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        op: "projects.remove", projectId: "hidden", source: "test", sourceKey: "one",
        kind: "test", message: "hello",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { projectId: "allowed" } });
  });
});
