import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  artifactPath,
  createTestDirectories,
  encode,
  invoke,
  runner,
  text,
} from "./process-harness.ts";

const testDirectories = createTestDirectories();
const temporaryDirectory = () => testDirectories.create();
afterEach(() => testDirectories.cleanup());

describe("managed command output runner", () => {
  test("preserves exit code and captures externally visible output", () => {
    const root = temporaryDirectory();
    const result = invoke(runner, ["run", "--json", encode("echo visible; echo failure >&2; exit 23")], { env: { CODEX_COMMAND_OUTPUT_DIR: root } });
    expect(result.exitCode).toBe(23);
    const path = artifactPath(text(result.stdout));
    expect(readFileSync(join(path, "stdout.log"), "utf8")).toContain("visible");
    expect(readFileSync(join(path, "stderr.log"), "utf8")).toContain("failure");
    const status = JSON.parse(readFileSync(join(path, "status.json"), "utf8"));
    expect(status.exitCode).toBe(23);
    expect(status.stdoutObservedBytes).toBe(8);
    expect(status.stdoutStoredBytes).toBe(8);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(path, "stdout.log")).mode & 0o777).toBe(0o600);
  });

  test("keeps explicit shell redirections out of captured output", () => {
    const root = temporaryDirectory();
    const redirected = join(root, "redirected.txt");
    const result = invoke(runner, ["run", "--json", encode(`echo redirected > '${redirected}'; echo captured`)], { env: { CODEX_COMMAND_OUTPUT_DIR: root } });
    expect(result.exitCode).toBe(0);
    const path = artifactPath(text(result.stdout));
    expect(readFileSync(redirected, "utf8")).toBe("redirected\n");
    expect(readFileSync(join(path, "stdout.log"), "utf8")).toBe("captured\n");
  });

  test("caps artifacts and emits heartbeat status", () => {
    const root = temporaryDirectory();
    const result = invoke(runner, ["run", "--json", encode("for i in 1 2 3; do printf 1234567890; sleep 0.04; done")], { env: { CODEX_COMMAND_OUTPUT_DIR: root, CODEX_COMMAND_MAX_BYTES: "12", CODEX_COMMAND_HEARTBEAT_MS: "25" } });
    const path = artifactPath(text(result.stdout));
    const status = JSON.parse(readFileSync(join(path, "status.json"), "utf8"));
    expect(readFileSync(join(path, "stdout.log")).length).toBe(12);
    expect(status.stdoutObservedBytes).toBe(30);
    expect(status.stdoutStoredBytes).toBe(12);
    expect(status.stdoutTruncated).toBe(true);
    expect(text(result.stdout)).toMatch(/\| \d+s \| \d+B \| \d+B \|/);
  });
  test("runs even when artifact setup fails", () => {
    const root = temporaryDirectory();
    const blocked = join(root, "not-a-directory");
    writeFileSync(blocked, "file");
    chmodSync(blocked, 0o400);
    const result = invoke(runner, ["run", "--json", encode("echo still-runs; echo visible-error >&2; exit 7")], { env: { CODEX_COMMAND_OUTPUT_DIR: blocked } });
    expect(result.exitCode).toBe(7);
    expect(text(result.stderr)).toContain("artifact capture unavailable");
    expect(text(result.stdout)).toContain("artifact: unavailable");
    expect(text(result.stdout)).toContain("still-runs");
    expect(text(result.stderr)).toContain("visible-error");
  });

  test("uses the invoking zsh and supports process substitution", () => {
    if (!Bun.file("/bin/zsh").size) return;
    const root = temporaryDirectory();
    const result = invoke(runner, ["run", "--json", encode("cat <(printf process-substitution)")], { env: { CODEX_COMMAND_OUTPUT_DIR: root, SHELL: "/bin/zsh" } });
    expect(result.exitCode).toBe(0);
    const path = artifactPath(text(result.stdout));
    expect(readFileSync(join(path, "stdout.log"), "utf8")).toBe("process-substitution");
    expect(JSON.parse(readFileSync(join(path, "status.json"), "utf8")).shell).toBe("/bin/zsh");
  });

  test("prints one artifact path, change-only progress, full small output, and compact completion", () => {
    const root = temporaryDirectory();
    const result = invoke(runner, ["run", "--json", encode("sleep 0.08; printf compact; printf warning >&2")], { env: { CODEX_COMMAND_OUTPUT_DIR: root, CODEX_COMMAND_HEARTBEAT_MS: "25" } });
    const output = text(result.stdout);
    expect(output.match(/\[codex-command\] artifact:/g)).toHaveLength(1);
    expect(output).toContain("| seconds | out | err |");
    expect(output).toContain("[codex-command] stdout:\ncompact");
    expect(output).toContain("[codex-command] stderr:\nwarning");
    expect(output).toMatch(/\[codex-command\] exit 0 in \d+s\n$/);
    expect(output).not.toContain("observed");
    expect(output).not.toContain("stored");
  });

  test("prints tails instead of the full transcript above the inline threshold", () => {
    const root = temporaryDirectory();
    const result = invoke(runner, ["run", "--json", encode("printf 1234567890")], { env: { CODEX_COMMAND_OUTPUT_DIR: root, CODEX_COMMAND_INLINE_BYTES: "5" } });
    const output = text(result.stdout);
    expect(output).toContain("[codex-command] stdout tail:\n1234567890");
    expect(output).not.toContain("[codex-command] stdout:\n");
    expect(output.match(/\[codex-command\] artifact:/g)).toHaveLength(1);
  });

  test("queries status, tails, errors, and search results from retained artifacts", () => {
    const root = temporaryDirectory();
    const run = invoke(
      runner,
      ["run", "--json", encode("printf searchable-output; printf searchable-error >&2")],
      { env: { CODEX_COMMAND_OUTPUT_DIR: root } },
    );
    const directory = artifactPath(text(run.stdout));
    const id = basename(directory);
    const env = { CODEX_COMMAND_OUTPUT_DIR: root };

    const status = invoke(runner, ["status", id], { env });
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(text(status.stdout)).id).toBe(id);

    const stdout = invoke(runner, ["tail", id], { env });
    expect(text(stdout.stdout)).toBe("searchable-output\n");
    const stderr = invoke(runner, ["errors", id], { env });
    expect(text(stderr.stdout)).toBe("searchable-error\n");

    const search = invoke(runner, ["search", "searchable-output", id], { env });
    expect(text(search.stdout)).toBe(`${directory}/stdout.log\n`);
  });
});
