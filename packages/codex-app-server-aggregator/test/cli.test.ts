import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli.ts";
import { DEFAULT_IMAGE } from "../src/docker.ts";

describe("aggregator CLI", () => {
  test("separates daemon infrastructure from the stdio connector", () => {
    expect(() => parseArgs([])).toThrow("expected serve or connect");
    expect(parseArgs(["serve", "--pass-env", "OPENAI_API_KEY", "--pass-env", "PROVIDER_TOKEN"]))
      .toMatchObject({
        mode: "serve",
        image: DEFAULT_IMAGE,
        passEnv: ["OPENAI_API_KEY", "PROVIDER_TOKEN"],
      });
    expect(parseArgs(["connect", "--socket", "/tmp/skizzles-aggregator-test.sock"]))
      .toEqual({ mode: "connect", socketPath: "/tmp/skizzles-aggregator-test.sock" });
    expect(() => parseArgs(["connect", "--pass-env", "TOKEN"]))
      .toThrow("connect accepts only --socket");
  });
});
