import { describe, expect, test } from "bun:test";
import { execute } from "../src/cli.ts";

function fixture(handler: (request: Request) => Response | Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
}

describe("ompctl", () => {
  test("maps list, create, send, history, and status to ompweb 0.3.5 endpoints", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const fetchImpl = fixture(async (request) => {
      requests.push({
        path: new URL(request.url).pathname + new URL(request.url).search,
        method: request.method,
        body: request.method === "POST" ? await request.json() : undefined,
      });
      return Response.json({ ok: true });
    });
    const env = { OMPWEB_URL: "http://ompweb.test" };

    await execute(["sessions", "list"], env, fetchImpl);
    await execute(["sessions", "create", "--cwd", "/workspace"], env, fetchImpl);
    await execute(["sessions", "create", "--cwd", "/workspace", "--message", "start"], env, fetchImpl);
    await execute(["sessions", "send", "session/id", "--message", "continue"], env, fetchImpl);
    await execute(["sessions", "history", "session/id", "--include-state"], env, fetchImpl);
    await execute(["sessions", "status", "session/id"], env, fetchImpl);

    expect(requests).toEqual([
      { path: "/api/sessions", method: "GET", body: undefined },
      { path: "/api/agent/new", method: "POST", body: { cwd: "/workspace", type: "ensure_session" } },
      { path: "/api/agent/new", method: "POST", body: { cwd: "/workspace", type: "prompt", message: "start" } },
      { path: "/api/agent/session%2Fid", method: "POST", body: { type: "prompt", message: "continue" } },
      { path: "/api/sessions/session%2Fid?includeState=1", method: "GET", body: undefined },
      { path: "/api/sessions/session%2Fid/state", method: "GET", body: undefined },
    ]);
  });

  test("flag base URL overrides the environment and preserves a path prefix", async () => {
    let seenPath = "";
    const fetchImpl = fixture((request) => {
      seenPath = new URL(request.url).pathname;
      return Response.json({ sessions: [] });
    });

    await execute(
      ["sessions", "list", "--base-url", "http://ompweb.test/ompweb"],
      { OMPWEB_URL: "http://127.0.0.1:1" },
      fetchImpl,
    );

    expect(seenPath).toBe("/ompweb/api/sessions");
  });

  test("password login forwards only the signed cookie to API requests", async () => {
    const seen: Array<{ path: string; cookie: string | null; body: unknown }> = [];
    const fetchImpl = fixture(async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() : undefined;
      seen.push({ path, cookie: request.headers.get("cookie"), body });
      if (path === "/api/web-auth/session") {
        return Response.json({ ok: true }, { headers: { "Set-Cookie": "omp_web_session=signed; HttpOnly; Path=/" } });
      }
      return Response.json({ sessions: [] });
    });

    await execute(
      ["sessions", "list"],
      { OMPWEB_URL: "http://ompweb.test", OMPWEB_PASSWORD: "secret" },
      fetchImpl,
    );

    expect(seen).toEqual([
      { path: "/api/web-auth/session", cookie: null, body: { password: "secret" } },
      { path: "/api/sessions", cookie: "omp_web_session=signed", body: undefined },
    ]);
  });

  test("password configuration tolerates a server with protection disabled", async () => {
    const paths: string[] = [];
    const fetchImpl = fixture((request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return path === "/api/web-auth/session"
        ? Response.json({ error: "Password protection is disabled" }, { status: 404 })
        : Response.json({ sessions: [] });
    });

    await execute(
      ["sessions", "list"],
      { OMPWEB_URL: "http://ompweb.test", OMPWEB_PASSWORD: "configured-elsewhere" },
      fetchImpl,
    );

    expect(paths).toEqual(["/api/web-auth/session", "/api/sessions"]);
  });

  test("reports missing credentials separately from a rejected supplied cookie", async () => {
    const fetchImpl = fixture(() => Response.json(
      { error: "Password required", code: "password_required" },
      { status: 401 },
    ));

    expect(execute(["sessions", "list"], { OMPWEB_URL: "http://ompweb.test" }, fetchImpl)).rejects.toMatchObject({
      message: "ompweb requires a password or session cookie",
      code: "password_required",
      status: 401,
    });
    expect(execute(
      ["sessions", "list"],
      { OMPWEB_URL: "http://ompweb.test", OMPWEB_COOKIE: "stale" },
      fetchImpl,
    )).rejects.toMatchObject({
      message: "ompweb rejected the supplied session cookie",
      code: "password_required",
      status: 401,
    });
  });

  test("rejects conflicting credentials and malformed commands before network access", async () => {
    expect(execute(["sessions", "list"], {
      OMPWEB_PASSWORD: "secret",
      OMPWEB_COOKIE: "signed",
    })).rejects.toMatchObject({ code: "auth_options_conflict" });
    expect(execute(["sessions", "send", "id"], {})).rejects.toMatchObject({ code: "option_required" });
    expect(execute(["sessions", "history"], {})).rejects.toMatchObject({ code: "session_id_required" });
  });

  test("prints machine-readable help without contacting ompweb", async () => {
    expect(await execute(["--help"], {})).toEqual({
      help: expect.stringContaining("ompctl sessions create --cwd PATH [--message TEXT]"),
    });
  });
});
