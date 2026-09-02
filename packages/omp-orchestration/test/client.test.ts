import { describe, expect, test } from "bun:test";
import { normalizeRemoteUrl } from "../src/client.ts";

describe("remote transport policy", () => {
  test.each([
    ["https://orchestration.example.test", "https://orchestration.example.test"],
    ["http://localhost:43873", "http://localhost:43873"],
    ["http://127.0.0.1:43873", "http://127.0.0.1:43873"],
    ["http://[::1]:43873", "http://[::1]:43873"],
    ["http://100.64.0.0:43873", "http://100.64.0.0:43873"],
    ["http://100.69.17.102:43873", "http://100.69.17.102:43873"],
    ["http://100.127.255.255:43873", "http://100.127.255.255:43873"],
    ["http://[fd7a:115c:a1e0::1]:43873", "http://[fd7a:115c:a1e0::1]:43873"],
  ])("accepts %s", (value, expected) => {
    expect(normalizeRemoteUrl(value)).toBe(expected);
  });

  test.each([
    "http://100.63.255.255:43873",
    "http://100.128.0.0:43873",
    "http://192.168.1.10:43873",
    "http://203.0.113.10:43873",
    "http://omp.example.test:43873",
    "http://[fd7a:115c:a1df:ffff::1]:43873",
  ])("rejects non-Tailscale plaintext endpoint %s", (value) => {
    expect(() => normalizeRemoteUrl(value)).toThrow("requires HTTPS or an HTTP loopback/Tailscale IP endpoint");
  });

  test.each([
    "https://user:secret@orchestration.example.test",
    "https://orchestration.example.test?token=secret",
    "https://orchestration.example.test#secret",
  ])("rejects URL-embedded credential material %s", (value) => {
    expect(() => normalizeRemoteUrl(value)).toThrow("must not contain credentials, query, or fragment");
  });

  test("rejects invalid URLs independently from disallowed transports", () => {
    expect(() => normalizeRemoteUrl("not a URL")).toThrow("OMP_ORCHESTRATION_URL is invalid");
  });
});
