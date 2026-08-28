import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli.ts";
import { DEFAULT_IMAGE } from "../src/docker.ts";

describe("aggregator CLI", () => {
  test("requires a repository and collects explicit provider env names", () => {
    expect(() => parseArgs([])).toThrow("--repo is required");
    expect(parseArgs(["--repo", "https://example.test/repo.git", "--pass-env", "OPENAI_API_KEY", "--pass-env", "PROVIDER_TOKEN"]))
      .toMatchObject({
        repoUrl: "https://example.test/repo.git",
        image: DEFAULT_IMAGE,
        passEnv: ["OPENAI_API_KEY", "PROVIDER_TOKEN"],
      });
  });
});
