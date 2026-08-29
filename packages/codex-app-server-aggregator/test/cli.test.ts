import { describe, expect, test } from "bun:test";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, parseArgs } from "../src/cli.ts";
import { DEFAULT_IMAGE } from "../src/docker.ts";

describe("aggregator CLI", () => {
  test("separates daemon infrastructure from the stdio connector", () => {
    expect(() => parseArgs([])).toThrow("expected serve or connect");
    expect(parseArgs(["serve", "--pass-env", "OPENAI_API_KEY", "--pass-env", "PROVIDER_TOKEN"]))
      .toMatchObject({
        mode: "serve",
        image: DEFAULT_IMAGE,
        passEnv: ["OPENAI_API_KEY", "PROVIDER_TOKEN"],
        httpHost: DEFAULT_HTTP_HOST,
        httpPort: DEFAULT_HTTP_PORT,
      });
    expect(parseArgs(["connect", "--socket", "/tmp/skizzles-aggregator-test.sock"]))
      .toEqual({ mode: "connect", socketPath: "/tmp/skizzles-aggregator-test.sock" });
    expect(() => parseArgs(["connect", "--pass-env", "TOKEN"]))
      .toThrow("connect accepts only --socket");
    expect(parseArgs(["serve", "--http-host", "localhost", "--http-port", "0", "--http-token-env", "REST_TOKEN"]))
      .toMatchObject({ httpHost: "localhost", httpPort: 0, httpTokenEnv: "REST_TOKEN" });
    expect(() => parseArgs(["serve", "--http-port", "65536"]))
      .toThrow("--http-port must be an integer from 0 through 65535");
  });
});
