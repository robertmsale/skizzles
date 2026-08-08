import { describe, expect, test } from "bun:test";
import { redactPublicText } from "./public-output";

describe("redactPublicText", () => {
  test("redacts quoted POSIX paths with spaces", () => {
    const message = `EPERM: operation not permitted, open "/Users/robertsale/Library/Application Support/OpenAI/codex-container-lab"`;

    expect(redactPublicText(message)).toBe("EPERM: operation not permitted, open [path]");
  });

  test("redacts unquoted POSIX paths with spaces in directory names", () => {
    const message = "EPERM: operation not permitted, open /Users/robertsale/Library/Application Support/OpenAI/codex-container-lab";

    expect(redactPublicText(message)).toBe("EPERM: operation not permitted, open [path]");
  });

  test("keeps diagnostics following an unquoted path", () => {
    const message = "EPERM: operation not permitted, open /Users/robertsale/Library/Application Support/OpenAI/codex-container-lab: operation not permitted";

    expect(redactPublicText(message)).toBe("EPERM: operation not permitted, open [path] operation not permitted");
  });
});
