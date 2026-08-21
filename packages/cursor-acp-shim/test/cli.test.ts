import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_RETRIES } from "../src/supervisor.ts";
import { MAX_RETRY_OVERRIDE, parseRetries } from "../src/cli.ts";

describe("T3_CURSOR_ACP_MAX_RETRIES", () => {
  test("defaults to 10 retries after the first failure", () => {
    expect(DEFAULT_MAX_RETRIES).toBe(10);
    expect(parseRetries(undefined)).toBe(10);
    expect(parseRetries("")).toBe(10);
    expect(parseRetries("10")).toBe(10);
  });

  test("accepts 0 through 32 including the old 8 cap", () => {
    expect(parseRetries("0")).toBe(0);
    expect(parseRetries("8")).toBe(8);
    expect(parseRetries(String(MAX_RETRY_OVERRIDE))).toBe(32);
    expect(() => parseRetries("33")).toThrow("0 through 32");
    expect(() => parseRetries("-1")).toThrow("0 through 32");
    expect(() => parseRetries("1.5")).toThrow("0 through 32");
  });
});
