import { describe, expect, test } from "bun:test";
import { httpCliMain, parseHttpCliArgs } from "../src/http-cli.ts";
import { AggregatorHttpClient } from "../src/http-client.ts";

describe("aggregator HTTP control CLI", () => {
  test("builds a native text input instead of requiring callers to memorize turn/start", async () => {
    const config = await parseHttpCliArgs([
      "--url", "http://aggregator.test:9000",
      "threads", "send", "thread/with/slash",
      "--message", "Run the focused tests",
      "--params", '{"model":"gpt-5.6-sol","effort":"high"}',
    ], { env: {} });

    expect(config).toEqual({
      baseUrl: "http://aggregator.test:9000",
      tokenEnv: "SKIZZLES_AGGREGATOR_TOKEN",
      timeoutMs: 65_000,
      command: {
        method: "POST",
        path: "/v1/threads/thread%2Fwith%2Fslash/turns",
        body: {
          model: "gpt-5.6-sol",
          effort: "high",
          input: [{ type: "text", text: "Run the focused tests", text_elements: [] }],
        },
      },
    });
  });

  test("supports stdin messages, list filters, lifecycle, and approval shortcuts", async () => {
    const sent = await parseHttpCliArgs(["threads", "send", "thread-1", "--stdin"], {
      env: { SKIZZLES_AGGREGATOR_URL: "http://localhost:7777" },
      readStdin: async () => "multiline\nrequest\n",
    });
    expect(sent.command).toMatchObject({
      body: { input: [{ type: "text", text: "multiline\nrequest" }] },
    });

    const listed = await parseHttpCliArgs([
      "threads", "list", "--cwd", "/tmp/project a", "--cwd", "/tmp/project-b",
      "--archived", "--limit", "20", "--search", "needle", "--sort-key", "updated_at",
    ], { env: {} });
    expect(listed.command).toEqual({
      method: "GET",
      path: "/v1/threads?cwd=%2Ftmp%2Fproject+a&cwd=%2Ftmp%2Fproject-b&archived=true&limit=20&searchTerm=needle&sortKey=updated_at",
    });

    expect((await parseHttpCliArgs(["threads", "archive", "thread-1"], { env: {} })).command)
      .toEqual({ method: "POST", path: "/v1/threads/thread-1/archive" });
    expect((await parseHttpCliArgs(["requests", "approve-session", "approval-1"], { env: {} })).command)
      .toEqual({
        method: "POST",
        path: "/v1/server-requests/approval-1/responses",
        body: { result: { decision: "acceptForSession" } },
      });
  });

  test("rejects ambiguous messages and malformed advanced JSON", async () => {
    await expect(parseHttpCliArgs(["threads", "send", "thread-1", "--message", "hello", "--stdin"], { env: {} }))
      .rejects.toThrow("exactly one of --message or --stdin");
    await expect(parseHttpCliArgs(["threads", "start", "/tmp/project", "--params", "[]"], { env: {} }))
      .rejects.toThrow("--params must be a JSON object");
    await expect(parseHttpCliArgs(["requests", "respond", "approval-1", "--result", "{"], { env: {} }))
      .rejects.toThrow("--result must be valid JSON");
  });

  test("sends bearer-authenticated requests and prints only JSON results", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    let stdout = "";
    const exitCode = await httpCliMain([
      "--url", "http://aggregator.test:9000",
      "--token-env", "TEST_TOKEN",
      "projects", "list",
    ], {
      env: { TEST_TOKEN: "secret-token" },
      fetch: async (input, init = {}) => {
        request = { url: String(input), init };
        return Response.json({ data: [{ cwd: "/tmp/project" }] });
      },
      stdout: (text) => { stdout += text; },
    });

    expect(exitCode).toBe(0);
    expect(request?.url).toBe("http://aggregator.test:9000/v1/projects");
    expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer secret-token");
    expect(JSON.parse(stdout)).toEqual({ data: [{ cwd: "/tmp/project" }] });
  });

  test("returns nonzero with structured HTTP errors and rejects unsafe base URLs", async () => {
    let stderr = "";
    const exitCode = await httpCliMain(["threads", "read", "missing"], {
      env: {},
      fetch: async () => Response.json({ error: { code: "unauthorized", message: "missing or invalid bearer token" } }, { status: 401 }),
      stderr: (text) => { stderr += text; },
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr)).toEqual({
      status: 401,
      body: { error: { code: "unauthorized", message: "missing or invalid bearer token" } },
    });
    expect(() => new AggregatorHttpClient({ baseUrl: "file:///tmp/socket" }))
      .toThrow("aggregator URL must use http or https");
    expect(() => new AggregatorHttpClient({ baseUrl: "http://localhost:8788/prefix" }))
      .toThrow("aggregator URL must be an origin without a path");
  });

  test("does not send a request when an explicitly selected token environment is missing", async () => {
    let called = false;
    let stderr = "";
    const exitCode = await httpCliMain(["--token-env", "MISSING_TOKEN", "health"], {
      env: {},
      fetch: async () => {
        called = true;
        return Response.json({ ok: true });
      },
      stderr: (text) => { stderr += text; },
    });
    expect(exitCode).toBe(1);
    expect(called).toBe(false);
    expect(JSON.parse(stderr)).toEqual({
      error: {
        kind: "client_error",
        message: "bearer token environment variable is empty or unset: MISSING_TOKEN",
      },
    });
  });
});
