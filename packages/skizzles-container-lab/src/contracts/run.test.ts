import { describe, expect, test } from "bun:test";
import {
  isManagedContainerLabRun,
  parseContainerLabRunArguments,
} from "./run";

describe("Container Lab run contract", () => {
  test("parses the complete run option surface", () => {
    const result = parseContainerLabRunArguments([
      "--lab",
      "experiment",
      "--cwd",
      "packages/api",
      "--env",
      "RUST_LOG=debug",
      "--env",
      "EMPTY=",
      "--timeout-seconds",
      "120",
      "--",
      "cargo",
      "test",
      "--workspace",
    ]);

    expect(result).toEqual({
      ok: true,
      value: {
        lab: "experiment",
        cwd: "packages/api",
        environment: { RUST_LOG: "debug", EMPTY: "" },
        timeoutSeconds: 120,
        argv: ["cargo", "test", "--workspace"],
      },
    });
    expect(isManagedContainerLabRun(result)).toBe(true);
  });

  test("preserves CLI usage diagnostics", () => {
    const cases: Array<[string[], string]> = [
      [["--lab", "experiment"], "run requires -- before the command argv"],
      [["--unknown", "value", "--", "cargo"], "unknown argument: --unknown"],
      [["--lab", "--", "cargo"], "--lab requires a value"],
      [["--lab", "one", "--lab", "two", "--", "cargo"], "--lab may be provided only once"],
      [["--lab", "experiment", "--"], "run requires a command after --"],
      [["--lab", "experiment", "--cwd", "../outside", "--", "cargo"], "run --cwd must be a repository-relative workspace path, never an absolute container path"],
      [["--lab", "experiment", "--env", "INVALID", "--", "cargo"], "--env must be KEY=VALUE"],
      [["--lab", "experiment", "--timeout-seconds", "later", "--", "cargo"], "--timeout-seconds must be an integer"],
      [["--", "cargo"], "--lab is required"],
    ];

    for (const [args, message] of cases) {
      expect(parseContainerLabRunArguments(args)).toEqual({ ok: false, message });
    }
  });

  test("keeps the hook safety ceiling stricter than CLI syntax", () => {
    const result = parseContainerLabRunArguments([
      "--lab",
      "experiment",
      "--timeout-seconds",
      "7201",
      "--",
      "cargo",
      "test",
    ]);
    expect(result.ok).toBe(true);
    expect(isManagedContainerLabRun(result)).toBe(false);
  });

  test("keeps managed environment names compatible with runtime validation", () => {
    const result = parseContainerLabRunArguments([
      "--lab",
      "experiment",
      "--env",
      "1BAD=value",
      "--",
      "cargo",
      "test",
    ]);
    expect(result.ok).toBe(true);
    expect(isManagedContainerLabRun(result)).toBe(false);
  });
});
