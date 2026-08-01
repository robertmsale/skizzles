import { describe, expect, test } from "bun:test";
import { runCommand } from "./process";

describe("runCommand", () => {
  test("bounds captured output", async () => {
    const result = await runCommand("sh", ["-c", "printf 123456789"], { maxOutputBytes: 4 });
    expect(result.stdout.toString()).toBe("1234");
    expect(result.stdoutTruncated).toBe(true);
  });

  test("preserves prefix capture by default and supports per-stream rolling tails", async () => {
    const command = `printf 'HEAD${"A".repeat(80)}TAIL'; printf 'HEAD${"B".repeat(80)}TAIL' >&2`;
    const head = await runCommand("sh", ["-c", command], { maxOutputBytes: 64 });
    expect(head.stdout.toString()).toContain("HEAD");
    expect(head.stdout.toString()).not.toContain("TAIL");
    expect(head.stderr.toString()).toContain("HEAD");
    expect(head.stderr.toString()).not.toContain("TAIL");
    expect(head.stdoutTruncated).toBe(true);
    expect(head.stderrTruncated).toBe(true);

    const tail = await runCommand("sh", ["-c", command], {
      maxOutputBytes: 64,
      stdoutCapture: "tail",
      stderrCapture: "tail",
    });
    expect(tail.stdout.toString()).toContain("TAIL");
    expect(tail.stdout.toString()).not.toContain("HEAD");
    expect(tail.stderr.toString()).toContain("TAIL");
    expect(tail.stderr.toString()).not.toContain("HEAD");
    expect(tail.stdout.byteLength).toBeLessThanOrEqual(64);
    expect(tail.stderr.byteLength).toBeLessThanOrEqual(64);
    expect(tail.stdoutTruncated).toBe(true);
    expect(tail.stderrTruncated).toBe(true);
  });

  test("reports failures", async () => {
    await expect(runCommand("sh", ["-c", "echo nope >&2; exit 7"])).rejects.toThrow("failed (7): nope");
  });
});
