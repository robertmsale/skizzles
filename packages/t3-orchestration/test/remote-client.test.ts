import { afterEach, describe, expect, test } from "bun:test";
import { daemonRequest } from "../src/client.ts";
import { normalizeRemoteUrl } from "../src/remote-config.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("remote daemon client", () => {
  test("accepts only credential-free HTTPS origins for persistent configuration", () => {
    expect(normalizeRemoteUrl("https://host.tailnet.ts.net/")).toBe("https://host.tailnet.ts.net");
    for (const invalid of [
      "http://host.tailnet.ts.net",
      "https://example.com",
      "https://127.0.0.1",
      "https://user:pass@host.tailnet.ts.net",
      "https://host.tailnet.ts.net/path",
      "https://host.tailnet.ts.net/?query=1",
    ]) expect(() => normalizeRemoteUrl(invalid)).toThrow();
  });

  test("sends one JSON request without exposing the host T3 bearer", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://host.tailnet.ts.net/v1/request");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({ op: "projects.list" });
      return new Response('{"ok":true,"result":{"projects":[]}}\n', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    expect(await daemonRequest({ op: "projects.list" }, undefined, 1_000, "https://host.tailnet.ts.net")).toEqual({
      ok: true,
      result: { projects: [] },
    });
  });

  test("does not retry an ambiguous failed request", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      throw new Error("connection lost");
    }) as typeof fetch;
    await expect(daemonRequest({ op: "tasks.send" }, undefined, 1_000, "https://host.tailnet.ts.net")).rejects.toThrow("connection lost");
    expect(requests).toBe(1);
  });

  test("rejects redirects and oversized streamed responses", async () => {
    let requests = 0;
    globalThis.fetch = (async (_input, init) => {
      requests++;
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 307, headers: { location: "https://example.com" } });
    }) as typeof fetch;
    await expect(daemonRequest({ op: "tasks.send", message: "private" }, undefined, 1_000, "https://host.tailnet.ts.net")).rejects.toThrow("redirect rejected");
    expect(requests).toBe(1);

    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    }), { status: 200 })) as typeof fetch;
    await expect(daemonRequest({ op: "projects.list" }, undefined, 1_000, "https://host.tailnet.ts.net")).rejects.toThrow("response exceeds 1 MiB");
  });
});
