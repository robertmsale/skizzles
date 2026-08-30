import { describe, expect, test } from "bun:test";
import { parseMarkdownBlocks } from "../src/web/markdown.ts";

describe("board markdown", () => {
  test("preserves the first line of an untyped fenced block", () => {
    expect(parseMarkdownBlocks("Before\n```\nhello\nworld\n```\nAfter")).toEqual([
      { type: "text", text: "Before\n" },
      { type: "code", text: "hello\nworld\n" },
      { type: "text", text: "\nAfter" },
    ]);
  });

  test("parses a language only from the opening fence", () => {
    expect(parseMarkdownBlocks("```typescript\nconst hello = 'world';\n```")).toEqual([
      { type: "code", language: "typescript", text: "const hello = 'world';\n" },
    ]);
  });
});
