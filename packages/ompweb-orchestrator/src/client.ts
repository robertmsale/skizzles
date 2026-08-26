export const DEFAULT_BASE_URL = "http://127.0.0.1:30177";
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface OmpwebClientOptions {
  baseUrl?: string;
  password?: string;
  cookie?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface CreateSessionOptions {
  cwd: string;
  message?: string;
}

interface ErrorPayload {
  error?: unknown;
  code?: unknown;
}

export class OmpwebError extends Error {
  readonly code: string | undefined;
  readonly status: number | undefined;

  constructor(message: string, options: { code?: string; status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "OmpwebError";
    this.code = options.code;
    this.status = options.status;
  }
}

export class OmpwebClient {
  readonly baseUrl: URL;
  readonly timeoutMs: number;

  private readonly password: string | undefined;
  private readonly suppliedCookie: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private authentication: Promise<string | undefined> | undefined;

  constructor(options: OmpwebClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = normalizeTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (options.password !== undefined && options.cookie !== undefined) {
      throw new OmpwebError("Use either an ompweb password or session cookie, not both", {
        code: "auth_options_conflict",
      });
    }
    this.password = normalizeSecret(options.password, "password");
    this.suppliedCookie = options.cookie === undefined ? undefined : normalizeCookie(options.cookie);
    this.fetchImpl = options.fetch ?? fetch;
  }

  listSessions(): Promise<unknown> {
    return this.request("api/sessions");
  }

  createSession(options: CreateSessionOptions): Promise<unknown> {
    const cwd = requiredString(options.cwd, "cwd");
    const message = options.message === undefined ? undefined : requiredString(options.message, "message");
    return this.request("api/agent/new", {
      method: "POST",
      body: JSON.stringify(message === undefined
        ? { cwd, type: "ensure_session" }
        : { cwd, type: "prompt", message }),
    });
  }

  sendMessage(sessionId: string, message: string): Promise<unknown> {
    const id = requiredString(sessionId, "session id");
    return this.request(`api/agent/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ type: "prompt", message: requiredString(message, "message") }),
    });
  }

  history(sessionId: string, includeState = false): Promise<unknown> {
    const id = requiredString(sessionId, "session id");
    const suffix = includeState ? "?includeState=1" : "";
    return this.request(`api/sessions/${encodeURIComponent(id)}${suffix}`);
  }

  status(sessionId: string): Promise<unknown> {
    const id = requiredString(sessionId, "session id");
    return this.request(`api/sessions/${encodeURIComponent(id)}/state`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const cookie = await this.authenticationCookie();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (cookie) headers.set("Cookie", cookie);

    const response = await this.fetchWithTimeout(this.endpoint(path), { ...init, headers });
    const payload = await parsePayload(response);
    if (!response.ok) throw responseError(response, payload, this.suppliedCookie !== undefined);
    return payload;
  }

  private authenticationCookie(): Promise<string | undefined> {
    if (this.suppliedCookie !== undefined) return Promise.resolve(this.suppliedCookie);
    if (this.password === undefined) return Promise.resolve(undefined);
    this.authentication ??= this.login();
    return this.authentication;
  }

  private async login(): Promise<string | undefined> {
    const response = await this.fetchWithTimeout(this.endpoint("api/web-auth/session"), {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ password: this.password }),
    });
    const payload = await parsePayload(response);
    if (response.status === 404 && isErrorPayload(payload) && payload.error === "Password protection is disabled") {
      return undefined;
    }
    if (!response.ok) throw responseError(response, payload, false);
    const setCookie = response.headers.get("set-cookie");
    const cookie = setCookie?.split(";", 1)[0]?.trim();
    if (!cookie?.startsWith("omp_web_session=")) {
      throw new OmpwebError("ompweb login succeeded without returning its session cookie", {
        code: "missing_session_cookie",
        status: response.status,
      });
    }
    return cookie;
  }

  private async fetchWithTimeout(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new OmpwebError(`ompweb request timed out after ${this.timeoutMs}ms`, {
          code: "request_timeout",
          cause: error,
        });
      }
      throw new OmpwebError(`Unable to reach ompweb at ${this.baseUrl.toString().replace(/\/$/, "")}: ${errorMessage(error)}`, {
        code: "connection_failed",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private endpoint(path: string): URL {
    return new URL(path.replace(/^\//, ""), this.baseUrl);
  }
}

export function normalizeBaseUrl(input: string): URL {
  let url: URL;
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
      code: "invalid_base_url",
    });
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function normalizeTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new OmpwebError("OMPWEB_TIMEOUT_MS must be an integer from 1 through 300000", {
      code: "invalid_timeout",
    });
  }
  return value;
}

function normalizeSecret(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.length) throw new OmpwebError(`ompweb ${label} must not be empty`, { code: `invalid_${label}` });
  return value;
}

function normalizeCookie(value: string): string {
  const cookie = value.trim();
  if (!cookie || /[\r\n]/.test(cookie)) {
    throw new OmpwebError("ompweb session cookie is empty or malformed", { code: "invalid_cookie" });
  }
  return cookie.startsWith("omp_web_session=") ? cookie : `omp_web_session=${cookie}`;
}

function requiredString(value: string, label: string): string {
  if (!value.trim()) throw new OmpwebError(`${label} is required`, { code: `${label.replaceAll(" ", "_")}_required` });
  return value;
}

async function parsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new OmpwebError(`ompweb returned invalid JSON (HTTP ${response.status})`, {
      code: "invalid_json_response",
      status: response.status,
      cause: error,
    });
  }
}

function responseError(response: Response, payload: unknown, suppliedCookie: boolean): OmpwebError {
  const serverMessage = isErrorPayload(payload) && typeof payload.error === "string"
    ? payload.error
    : `ompweb request failed with HTTP ${response.status}`;
  const code = isErrorPayload(payload) && typeof payload.code === "string" ? payload.code : undefined;
  if (response.status === 401 && code === "password_required") {
    return new OmpwebError(
      suppliedCookie
        ? "ompweb rejected the supplied session cookie"
        : "ompweb requires a password or session cookie",
      { code, status: response.status },
    );
  }
  return new OmpwebError(serverMessage, { code, status: response.status });
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
