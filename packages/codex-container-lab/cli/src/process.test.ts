import { describe, expect, test } from "bun:test";
import { runCommand } from "./process";

describe("runCommand", () => {
  test("bounds captured output", async () => {
    const result = await runCommand("sh", ["-c", "printf 123456789"], { maxOutputBytes: 4 });
    expect(result.stdout.toString()).toBe("1234");
  });

  test("reports failures", async () => {
    await expect(runCommand("sh", ["-c", "echo nope >&2; exit 7"])).rejects.toThrow("failed (7): nope");
  });
});
