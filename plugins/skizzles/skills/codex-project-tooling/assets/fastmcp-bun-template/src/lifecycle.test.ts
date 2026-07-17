import { describe, expect, test } from "bun:test";
import { createLifecycle } from "./lifecycle";

describe("project lifecycle", () => {
  test("reports a compact disabled snapshot by default", () => {
    const lifecycle = createLifecycle({
      repoRoot: "/tmp/example",
      serverName: "test-server",
    });

    expect(lifecycle.snapshot()).toMatchObject({
      ok: true,
      repoRoot: "/tmp/example",
      server: "test-server",
      stack: "disabled",
    });
  });
});
