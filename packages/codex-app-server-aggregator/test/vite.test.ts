import { describe, expect, test } from "bun:test";
import { REST_ORIGIN, rewriteViteProxyOrigin, VITE_ORIGIN } from "../vite.config.ts";

describe("Vite development proxy", () => {
  test("rewrites only the documented loopback development Origin", () => {
    expect(rewriteViteProxyOrigin(VITE_ORIGIN)).toBe(REST_ORIGIN);
    expect(rewriteViteProxyOrigin("http://127.0.0.1:5174")).toBe("http://127.0.0.1:5174");
    expect(rewriteViteProxyOrigin("https://attacker.test")).toBe("https://attacker.test");
    expect(rewriteViteProxyOrigin(undefined)).toBeUndefined();
  });
});
