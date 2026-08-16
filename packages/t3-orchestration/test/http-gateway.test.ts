import { afterEach, describe, expect, test } from "bun:test";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createTailscaleGateway } from "../src/http-gateway.ts";

const servers: ReturnType<typeof createTailscaleGateway>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function invoke(
  headers: Record<string, string>,
  body: string = JSON.stringify({ op: "projects.list" }),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createTailscaleGateway(["owner@example.com"], async (command) => ({ command }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/v1/request",
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

async function health(): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const server = createTailscaleGateway(["owner@example.com"], async () => undefined);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json() as Record<string, unknown>,
  };
}

describe("Tailscale HTTP gateway", () => {
  test("exposes a non-dispatching readiness fingerprint for the host installer", async () => {
    const response = await health();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-t3-orchestration-gateway")).toBe("1");
    expect(response.body).toEqual({ ok: true, result: { service: "t3-orchestrationd", schema: 1 } });
  });

  test("executes commands only for an explicitly allowed verified identity", async () => {
    expect(await invoke({
      "tailscale-user-login": "Owner@Example.com",
      "x-forwarded-proto": "https",
    })).toEqual({
      status: 200,
      body: { ok: true, result: { command: { op: "projects.list" } } },
    });
  });

  test("rejects missing, unauthorized, and browser-origin identities before dispatch", async () => {
    expect((await invoke({ "x-forwarded-proto": "https" })).status).toBe(401);
    expect((await invoke({ "x-forwarded-proto": "https", "tailscale-user-login": "other@example.com" })).status).toBe(403);
    expect((await invoke({
      "x-forwarded-proto": "https",
      "tailscale-user-login": "owner@example.com",
      origin: "https://malicious.example",
    })).status).toBe(403);
  });

  test("requires Tailscale HTTPS proxy provenance and bounded JSON", async () => {
    expect((await invoke({ "tailscale-user-login": "owner@example.com" })).status).toBe(401);
    const malformed = await invoke({
      "x-forwarded-proto": "https",
      "tailscale-user-login": "owner@example.com",
    }, "{");
    expect(malformed.status).toBe(200);
    expect(malformed.body.ok).toBe(false);
    expect(typeof malformed.body.error).toBe("string");
    const oversized = await invoke({
      "x-forwarded-proto": "https",
      "tailscale-user-login": "owner@example.com",
    }, JSON.stringify({ op: "projects.list", padding: "x".repeat(1_048_576) }));
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({ ok: false, error: "request exceeds 1 MiB" });
  });
});
