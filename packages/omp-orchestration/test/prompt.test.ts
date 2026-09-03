import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("maintainer prompt", () => {
  test("prevents boolean-false task schemas from rejecting prose jobs", async () => {
    const prompt = await Bun.file(join(import.meta.dir, "../prompts/maintainer.md")).text();
    expect(prompt).toContain("omit both `outputSchema` and `schemaMode`");
    expect(prompt).toContain("Never pass `outputSchema: false`");
  });
});
