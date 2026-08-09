import { describe, expect, test } from "bun:test";
import { redactPublicText, redactPublicTextWithMetadata } from "./public-output";

describe("redactPublicText", () => {
  test("redacts quoted POSIX paths with spaces", () => {
    const message = `EPERM: operation not permitted, open "/Users/robertsale/Library/Application Support/OpenAI/codex-container-lab"`;

    expect(redactPublicText(message)).toBe("EPERM: operation not permitted, open [path]");
  });

  test("redacts unquoted POSIX paths with spaces in directory names", () => {
    const message = "EPERM: operation not permitted, open /Users/robertsale/Library/Application Support/OpenAI/codex-container-lab";

    expect(redactPublicText(message)).toBe("EPERM: operation not permitted, open [path]");
  });

  test("prefers complete redaction over leaking diagnostics after an ambiguous path", () => {
    const message = "EPERM: operation not permitted, open /Users/robertsale/Library/Application Support/OpenAI/codex-container-lab: operation not permitted";

    expect(redactPublicText(message)).toBe("EPERM: operation not permitted, open [path]");
  });

  test("redacts an unquoted terminal path component containing spaces", () => {
    expect(redactPublicText("open /Users/me/Application Support")).toBe("open [path]");
  });

  test("redacts multiple slash-delimited paths without leaking tails", () => {
    const message = "first /Users/me/Application Support; second /private/tmp/another path";

    expect(redactPublicText(message)).toBe("first [path]");
  });

  test("prefers complete redaction when terminal components resemble prose", () => {
    expect(redactPublicText("open /Users/Foo and Bar")).toBe("open [path]");
    expect(redactPublicText("open /Users/open operation permitted")).toBe("open [path]");
    expect(redactPublicText("open /Users/Foo, Bar")).toBe("open [path]");
  });

  test("redacts adjacent slash-delimited paths without leaking their tails", () => {
    const message = "paths /Users/Foo and Bar /private/tmp/another path";

    expect(redactPublicText(message)).toBe("paths [path]");
  });

  test("redacts newline-bearing POSIX paths through the captured tail", () => {
    expect(redactPublicText("open /Users/me/Application\nSupport\nnext diagnostic")).toBe("open [path]");
  });

  test("redacts unquoted spaced Windows and UNC paths through their tails", () => {
    expect(redactPublicText("open C:\\Users\\Foo Bar\\secret and later prose")).toBe("open [path]");
    expect(redactPublicText("open \\\\server\\share name\\secret and later prose")).toBe("open [path]");
  });

  test("reports intentional content removal separately from capture bounds", () => {
    expect(redactPublicTextWithMetadata("request path=/healthz/ready")).toEqual({
      text: "request path=[path]",
      contentRedacted: true,
    });
    expect(redactPublicTextWithMetadata("safe diagnostic")).toEqual({
      text: "safe diagnostic",
      contentRedacted: false,
    });
  });
});
