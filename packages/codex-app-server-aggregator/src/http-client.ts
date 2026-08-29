export const DEFAULT_AGGREGATOR_HTTP_URL = "http://127.0.0.1:8788";
export const DEFAULT_AGGREGATOR_TOKEN_ENV = "SKIZZLES_AGGREGATOR_TOKEN";
export const DEFAULT_HTTP_TIMEOUT_MS = 10 * 60_000;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type AggregatorHttpClientOptions = {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
};

export class AggregatorHttpClient {
  private readonly baseUrl: URL;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetch: FetchLike;

  constructor(options: AggregatorHttpClientOptions = {}) {
    this.baseUrl = parseBaseUrl(options.baseUrl ?? DEFAULT_AGGREGATOR_HTTP_URL);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("HTTP timeout must be a positive integer");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    const headers = new Headers({ accept: "application/json" });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    let response: Response;
    try {
      response = await this.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`aggregator HTTP request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    }
    const text = await response.text();
    const value = parseResponseBody(text, response.headers.get("content-type"));
    if (!response.ok) throw new AggregatorHttpError(response.status, value);
    return value;
  }
}

export class AggregatorHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`aggregator HTTP request failed with status ${status}`);
  }
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid aggregator URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("aggregator URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("aggregator URL must not contain credentials, a query, or a fragment");
  }
  if (url.pathname !== "/") throw new Error("aggregator URL must be an origin without a path");
  return url;
}

function parseResponseBody(text: string, contentType: string | null): unknown {
  if (!text) return null;
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("aggregator returned invalid JSON");
    }
  }
  return text;
}
