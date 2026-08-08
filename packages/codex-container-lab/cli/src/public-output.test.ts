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

    expect(redactPublicText(message)).toBe("EPERM: operation not permitted, open [path]: operation not permitted");
  });

  test("redacts an unquoted terminal path component containing spaces", () => {
    expect(redactPublicText("open /Users/me/Application Support")).toBe("open [path]");
  });

  test("redacts multiple paths without swallowing the prose between them", () => {
    const message = "first /Users/me/Application Support; second /private/tmp/another path";

    expect(redactPublicText(message)).toBe("first [path]; second [path]");
  });

  test("prefers complete redaction when terminal components resemble prose", () => {
    expect(redactPublicText("open /Users/Foo and Bar")).toBe("open [path]");
    expect(redactPublicText("open /Users/open operation permitted")).toBe("open [path]");
  });

  test("redacts adjacent slash-delimited paths without leaking their tails", () => {
    const message = "paths /Users/Foo and Bar /private/tmp/another path";

    expect(redactPublicText(message)).toBe("paths [path] [path]");
  });
});
