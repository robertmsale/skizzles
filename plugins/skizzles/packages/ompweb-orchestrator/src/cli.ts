#!/usr/bin/env bun
// @bun

// packages/ompweb-orchestrator/src/client.ts
var DEFAULT_BASE_URL = "http://127.0.0.1:30177";
var DEFAULT_TIMEOUT_MS = 60000;

class OmpwebError extends Error {
  code;
  status;
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "OmpwebError";
    this.code = options.code;
    this.status = options.status;
  }
}

class OmpwebClient {
  baseUrl;
  timeoutMs;
  password;
  suppliedCookie;
  fetchImpl;
  authentication;
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = normalizeTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (options.password !== undefined && options.cookie !== undefined) {
      throw new OmpwebError("Use either an ompweb password or session cookie, not both", {
        code: "auth_options_conflict"
      });
    }
    this.password = normalizeSecret(options.password, "password");
    this.suppliedCookie = options.cookie === undefined ? undefined : normalizeCookie(options.cookie);
    this.fetchImpl = options.fetch ?? fetch;
  }
  listSessions() {
    return this.request("api/sessions");
  }
  createSession(options) {
    const cwd = requiredString(options.cwd, "cwd");
    const message = options.message === undefined ? undefined : requiredString(options.message, "message");
    return this.request("api/agent/new", {
      method: "POST",
      body: JSON.stringify(message === undefined ? { cwd, type: "ensure_session" } : { cwd, type: "prompt", message })
    });
  }
  sendMessage(sessionId, message) {
    const id = requiredString(sessionId, "session id");
    return this.request(`api/agent/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ type: "prompt", message: requiredString(message, "message") })
    });
  }
  history(sessionId, includeState = false) {
    const id = requiredString(sessionId, "session id");
    const suffix = includeState ? "?includeState=1" : "";
    return this.request(`api/sessions/${encodeURIComponent(id)}${suffix}`);
  }
  status(sessionId) {
    const id = requiredString(sessionId, "session id");
    return this.request(`api/sessions/${encodeURIComponent(id)}/state`);
  }
  async request(path, init = {}) {
    const cookie = await this.authenticationCookie();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (cookie)
      headers.set("Cookie", cookie);
    const response = await this.fetchWithTimeout(this.endpoint(path), { ...init, headers });
    const payload = await parsePayload(response);
    if (!response.ok)
      throw responseError(response, payload, this.suppliedCookie !== undefined);
    return payload;
  }
  authenticationCookie() {
    if (this.suppliedCookie !== undefined)
      return Promise.resolve(this.suppliedCookie);
    if (this.password === undefined)
      return Promise.resolve(undefined);
    this.authentication ??= this.login();
    return this.authentication;
  }
  async login() {
    const response = await this.fetchWithTimeout(this.endpoint("api/web-auth/session"), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ password: this.password })
    });
    const payload = await parsePayload(response);
    if (response.status === 404 && isErrorPayload(payload) && payload.error === "Password protection is disabled") {
      return;
    }
    if (!response.ok)
      throw responseError(response, payload, false);
    const setCookie = response.headers.get("set-cookie");
    const cookie = setCookie?.split(";", 1)[0]?.trim();
    if (!cookie?.startsWith("omp_web_session=")) {
      throw new OmpwebError("ompweb login succeeded without returning its session cookie", {
        code: "missing_session_cookie",
        status: response.status
      });
    }
    return cookie;
  }
  async fetchWithTimeout(url, init) {
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new OmpwebError(`ompweb request timed out after ${this.timeoutMs}ms`, {
          code: "request_timeout",
          cause: error
        });
      }
      throw new OmpwebError(`Unable to reach ompweb at ${this.baseUrl.toString().replace(/\/$/, "")}: ${errorMessage(error)}`, {
        code: "connection_failed",
        cause: error
      });
    } finally {
      clearTimeout(timer);
    }
  }
  endpoint(path) {
    return new URL(path.replace(/^\//, ""), this.baseUrl);
  }
}
function normalizeBaseUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new OmpwebError(`Invalid ompweb base URL: ${input}`, { code: "invalid_base_url", cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OmpwebError("ompweb base URL must use http or https", { code: "invalid_base_url" });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new OmpwebError("ompweb base URL must not contain credentials, a query, or a fragment", {
      code: "invalid_base_url"
    });
  }
  if (!url.pathname.endsWith("/"))
    url.pathname += "/";
  return url;
}
function normalizeTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300000) {
    throw new OmpwebError("OMPWEB_TIMEOUT_MS must be an integer from 1 through 300000", {
      code: "invalid_timeout"
    });
  }
  return value;
}
function normalizeSecret(value, label) {
  if (value === undefined)
    return;
  if (!value.length)
    throw new OmpwebError(`ompweb ${label} must not be empty`, { code: `invalid_${label}` });
  return value;
}
function normalizeCookie(value) {
  const cookie = value.trim();
  if (!cookie || /[\r\n]/.test(cookie)) {
    throw new OmpwebError("ompweb session cookie is empty or malformed", { code: "invalid_cookie" });
  }
  return cookie.startsWith("omp_web_session=") ? cookie : `omp_web_session=${cookie}`;
}
function requiredString(value, label) {
  if (!value.trim())
    throw new OmpwebError(`${label} is required`, { code: `${label.replaceAll(" ", "_")}_required` });
  return value;
}
async function parsePayload(response) {
  const text = await response.text();
  if (!text)
    return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OmpwebError(`ompweb returned invalid JSON (HTTP ${response.status})`, {
      code: "invalid_json_response",
      status: response.status,
      cause: error
    });
  }
}
function responseError(response, payload, suppliedCookie) {
  const serverMessage = isErrorPayload(payload) && typeof payload.error === "string" ? payload.error : `ompweb request failed with HTTP ${response.status}`;
  const code = isErrorPayload(payload) && typeof payload.code === "string" ? payload.code : undefined;
  if (response.status === 401 && code === "password_required") {
    return new OmpwebError(suppliedCookie ? "ompweb rejected the supplied session cookie" : "ompweb requires a password or session cookie", { code, status: response.status });
  }
  return new OmpwebError(serverMessage, { code, status: response.status });
}
function isErrorPayload(value) {
  return typeof value === "object" && value !== null;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// packages/ompweb-orchestrator/src/cli.ts
var USAGE = `ompctl [--base-url URL] [--password PASSWORD | --cookie COOKIE] sessions COMMAND

Commands:
  ompctl sessions list
  ompctl sessions create --cwd PATH [--message TEXT]
  ompctl sessions send ID --message TEXT
  ompctl sessions history ID [--include-state]
  ompctl sessions status ID

Configuration:
  OMPWEB_URL         Base URL (default: ${DEFAULT_BASE_URL})
  OMPWEB_PASSWORD    Password used to obtain an HTTP-only session cookie
  OMPWEB_COOKIE      Existing omp_web_session cookie value or Cookie header pair
  OMPWEB_TIMEOUT_MS  Request timeout from 1 through 300000 (default: ${DEFAULT_TIMEOUT_MS})

Global flags override environment variables. Prefer environment variables over
credential flags so secrets do not enter shell history or process listings.`;
async function execute(argv, env = process.env, fetchImpl = fetch) {
  if (argv.includes("--help") || argv.includes("-h"))
    return { help: USAGE };
  const options = parseGlobalOptions(argv, env);
  const [resource, command, ...args] = options.commandArgs;
  if (resource !== "sessions" || command === undefined)
    throw usageError();
  const client = new OmpwebClient({
    baseUrl: options.baseUrl,
    password: options.password,
    cookie: options.cookie,
    timeoutMs: options.timeoutMs,
    fetch: fetchImpl
  });
  switch (command) {
    case "list":
      assertNoArgs(args);
      return client.listSessions();
    case "create": {
      const flags = parseCommandFlags(args, new Set(["--cwd", "--message"]));
      return client.createSession({
        cwd: requiredFlag(flags, "--cwd"),
        ...flags.has("--message") ? { message: requiredFlag(flags, "--message") } : {}
      });
    }
    case "send": {
      const { id, rest } = sessionId(args);
      const flags = parseCommandFlags(rest, new Set(["--message"]));
      return client.sendMessage(id, requiredFlag(flags, "--message"));
    }
    case "history": {
      const { id, rest } = sessionId(args);
      const flags = parseCommandFlags(rest, new Set, new Set(["--include-state"]));
      return client.history(id, flags.has("--include-state"));
    }
    case "status": {
      const { id, rest } = sessionId(args);
      assertNoArgs(rest);
      return client.status(id);
    }
    default:
      throw usageError();
  }
}
function parseGlobalOptions(argv, env) {
  const commandArgs = [];
  const values = new Map;
  const globalFlags = new Set(["--base-url", "--password", "--cookie", "--timeout-ms"]);
  for (let index = 0;index < argv.length; index += 1) {
    const arg = argv[index];
    if (!globalFlags.has(arg)) {
      commandArgs.push(arg);
      continue;
    }
    if (values.has(arg))
      throw new OmpwebError(`Duplicate option ${arg}`, { code: "duplicate_option" });
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new OmpwebError(`${arg} requires a value`, { code: "option_value_required" });
    }
    values.set(arg, value);
    index += 1;
  }
  const timeoutValue = values.get("--timeout-ms") ?? env.OMPWEB_TIMEOUT_MS;
  const timeoutMs = timeoutValue === undefined || timeoutValue === "" ? DEFAULT_TIMEOUT_MS : Number(timeoutValue);
  return {
    baseUrl: values.get("--base-url") ?? env.OMPWEB_URL ?? DEFAULT_BASE_URL,
    password: values.get("--password") ?? nonemptyEnv(env.OMPWEB_PASSWORD),
    cookie: values.get("--cookie") ?? nonemptyEnv(env.OMPWEB_COOKIE),
    timeoutMs,
    commandArgs
  };
}
function parseCommandFlags(args, valueFlags, booleanFlags = new Set) {
  const values = new Map;
  for (let index = 0;index < args.length; index += 1) {
    const arg = args[index];
    if (values.has(arg))
      throw new OmpwebError(`Duplicate option ${arg}`, { code: "duplicate_option" });
    if (booleanFlags.has(arg)) {
      values.set(arg, true);
      continue;
    }
    if (!valueFlags.has(arg))
      throw new OmpwebError(`Unknown option ${arg}`, { code: "unknown_option" });
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new OmpwebError(`${arg} requires a value`, { code: "option_value_required" });
    }
    values.set(arg, value);
    index += 1;
  }
  return values;
}
function requiredFlag(flags, name) {
  const value = flags.get(name);
  if (typeof value !== "string")
    throw new OmpwebError(`${name} is required`, { code: "option_required" });
  return value;
}
function sessionId(args) {
  const [id, ...rest] = args;
  if (id === undefined || id.startsWith("--")) {
    throw new OmpwebError("session ID is required", { code: "session_id_required" });
  }
  return { id, rest };
}
function assertNoArgs(args) {
  if (args.length > 0)
    throw new OmpwebError(`Unexpected argument ${args[0]}`, { code: "unexpected_argument" });
}
function nonemptyEnv(value) {
  return value === "" ? undefined : value;
}
function usageError() {
  return new OmpwebError(USAGE, { code: "usage" });
}
function errorPayload(error) {
  if (error instanceof OmpwebError) {
    return {
      error: error.message,
      ...error.code === undefined ? {} : { code: error.code },
      ...error.status === undefined ? {} : { status: error.status }
    };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}
if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await execute(process.argv.slice(2)))}
`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(errorPayload(error))}
`);
    process.exit(1);
  }
}
export {
  errorPayload,
  execute,
  parseGlobalOptions
};
