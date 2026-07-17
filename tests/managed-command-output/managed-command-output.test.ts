import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "../..");
const hook = join(packageRoot, "hooks/manage-command-output.ts");
const runner = join(packageRoot, "runtime/codex-command.ts");
const runnerCommand = 'bun "${PLUGIN_ROOT}/runtime/codex-command.ts"';
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-command-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function invoke(executable: string, arguments_: string[], options: { stdin?: string; env?: Record<string, string | undefined> } = {}) {
  return Bun.spawnSync(["bun", executable, ...arguments_], {
    stdin: options.stdin ? new TextEncoder().encode(options.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
}

function text(output: Uint8Array | undefined): string {
  return new TextDecoder().decode(output);
}

function encode(script: string): string {
  return Buffer.from(script).toString("base64url");
}

function artifactPath(output: string): string {
  const match = output.match(/\[codex-command\] artifact: ([^\n]+)/);
  if (!match) throw new Error(`artifact path missing from output: ${output}`);
  return match[1]!;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("managed command output hook", () => {
  test("passes through unknown commands and comments or quoted lookalikes", () => {
    for (const cmd of ["echo flutter test", "# bun test\necho okay", "printf 'dart test'"]) {
      const result = invoke(hook, [], { stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { cmd } }) });
      expect(result.exitCode).toBe(0);
      expect(text(result.stdout)).toBe("");
    }
  });

  test("rewrites through a portable PLUGIN_ROOT runner with a round-trippable encoding", () => {
    const cmd = "flutter test --reporter expanded && echo complete > result.txt";
    const result = invoke(hook, [], { stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { cmd, workdir: "/tmp" } }) });
    const payload = JSON.parse(text(result.stdout));
    const rewritten = payload.hookSpecificOutput.updatedInput.cmd as string;
    expect(rewritten).toStartWith(`${runnerCommand} run --base64url `);
    expect(Buffer.from(rewritten.split(" ").at(-1)!, "base64url").toString()).toBe(cmd);
    expect(payload.hookSpecificOutput.updatedInput.workdir).toBe("/tmp");
    expect(rewritten).not.toContain("/Users/");
  });

  test("the placeholder resolves to this package when the rewritten command reaches a shell", () => {
    const root = temporaryDirectory();
    const encoded = encode("echo portable-runner");
    const command = `${runnerCommand} run --base64url ${encoded}`;
    const result = Bun.spawnSync(["/bin/sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PLUGIN_ROOT: packageRoot, CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toContain("portable-runner");
  });

  test("finds a recognized command after leading commands and preserves the entire script", () => {
    const command = "echo header; flutter test; echo header; cat log";
    const result = invoke(hook, [], { stdin: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command, timeout: 120_000 },
    }) });
    const payload = JSON.parse(text(result.stdout));
    const rewritten = payload.hookSpecificOutput.updatedInput.command as string;
    expect(Buffer.from(rewritten.split(" ").at(-1)!, "base64url").toString()).toBe(command);
    expect(payload.hookSpecificOutput.updatedInput.timeout).toBe(120_000);
  });

  test("does not classify quoted, commented, substitution, or heredoc-like lookalikes", () => {
    for (const command of [
      "echo 'header; flutter test'",
      "echo header; # flutter test\necho footer",
      "echo $(flutter test)",
      "cat <<EOF\nflutter test\nEOF",
    ]) {
      const result = invoke(hook, [], { stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { command } }) });
      expect(text(result.stdout)).toBe("");
    }
  });

  test("recognizes high-value build and test commands through common launchers", () => {
    for (const command of [
      "cargo build --workspace", "cargo +nightly test --workspace", "cargo nextest run", "cargo llvm-cov --workspace", "cargo install cargo-insta", "RUST_LOG=debug cargo clippy --workspace", "env RUST_BACKTRACE=1 cargo check", "rustup run nightly cargo test", "xcodebuild -workspace App.xcworkspace -scheme App test", "xcrun --sdk iphonesimulator xcodebuild -scheme App build", "/usr/bin/xcodebuild -scheme App build", "swift build", "xcrun swift test", "gradle build", "./gradlew :app:testDebugUnitTest --no-daemon", "./gradlew connectedDebugAndroidTest", "fvm flutter test",
    ]) {
      const result = invoke(hook, [], { stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { command } }) });
      expect(text(result.stdout), command).not.toBe("");
    }
  });

  test("recognizes literal Container Lab launchers with supported global options before run", () => {
    for (const command of [
      "codex-container-lab --owner thread-1 --state-root /tmp/state --runtime-root /tmp/runtime run --lab experiment -- echo hello",
      "/tmp/source/skills/codex-container-lab/scripts/codex-container-lab --owner thread-1 run --lab experiment -- echo hello",
      "bun /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab --owner thread-1 run --lab experiment -- echo hello",
      "A=1 /tmp/source/skills/codex-container-lab/scripts/codex-container-lab --owner thread-1 run --lab experiment -- echo hello",
      "env A=1 /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab --state-root /tmp/state run --lab experiment -- echo hello",
    ]) {
      const result = invoke(hook, [], { stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { command } }) });
      expect(text(result.stdout), command).not.toBe("");
    }
  });

  test("does not mistake Container Lab lookalikes or unsupported global options for attached runs", () => {
    for (const command of [
      "echo /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab --owner thread run",
      "'/tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab' run --lab experiment -- echo hello",
      "# codex-container-lab --owner thread run --lab experiment -- echo hello\necho okay",
      "codex-container-lab --unknown value run --lab experiment -- echo hello",
      "codex-container-lab --db /tmp/state.sqlite run --lab experiment -- echo hello",
      "codex-container-lab --owner review --state-root /tmp/state --runtime-root /tmp/runtime \"health\" run --lab experiment -- echo hello",
      "codex-container-lab --owner \"review\" --state-root /tmp/state --runtime-root /tmp/runtime run --lab experiment -- echo hello",
      "A=1 \"codex-container-lab\" run --lab experiment -- echo hello",
      "A=1 /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab --owner review \"\" run --lab experiment -- echo hello",
      "env A=1 \"/tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab\" run --lab experiment -- echo hello",
      "codex-container-lab --owner thread health",
    ]) {
      const result = invoke(hook, [], { stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { command } }) });
      expect(text(result.stdout), command).toBe("");
    }
  });

  test("leaves low-value formatter and informational commands alone", () => {
    for (const command of ["dart format .", "cargo metadata --format-version 1", "cargo fmt --check", "swift --version", "gradle tasks", "./gradlew properties"]) {
      const result = invoke(hook, [], { stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { command } }) });
      expect(text(result.stdout), command).toBe("");
    }
  });
});

describe("managed command output runner", () => {
  test("preserves exit code and captures externally visible output", () => {
    const root = temporaryDirectory();
    const result = invoke(runner, ["run", "--base64url", encode("echo visible; echo failure >&2; exit 23")], { env: { CODEX_COMMAND_OUTPUT_DIR: root } });
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
    const result = invoke(runner, ["run", "--base64url", encode(`echo redirected > '${redirected}'; echo captured`)], { env: { CODEX_COMMAND_OUTPUT_DIR: root } });
    expect(result.exitCode).toBe(0);
    const path = artifactPath(text(result.stdout));
    expect(readFileSync(redirected, "utf8")).toBe("redirected\n");
    expect(readFileSync(join(path, "stdout.log"), "utf8")).toBe("captured\n");
  });

  test("caps artifacts and emits heartbeat status", () => {
    const root = temporaryDirectory();
    const result = invoke(runner, ["run", "--base64url", encode("for i in 1 2 3; do printf 1234567890; sleep 0.04; done")], { env: { CODEX_COMMAND_OUTPUT_DIR: root, CODEX_COMMAND_MAX_BYTES: "12", CODEX_COMMAND_HEARTBEAT_MS: "25" } });
    const path = artifactPath(text(result.stdout));
    const status = JSON.parse(readFileSync(join(path, "status.json"), "utf8"));
    expect(readFileSync(join(path, "stdout.log")).length).toBe(12);
    expect(status.stdoutObservedBytes).toBe(30);
    expect(status.stdoutStoredBytes).toBe(12);
    expect(status.stdoutTruncated).toBe(true);
    expect(text(result.stdout)).toMatch(/\| \d+s \| \d+B \| \d+B \|/);
  });

  test("bounds drain time when a background process keeps output descriptors open", () => {
    const root = temporaryDirectory();
    const startedAt = performance.now();
    const result = invoke(runner, ["run", "--base64url", encode("sleep 2 &")], { env: { CODEX_COMMAND_OUTPUT_DIR: root, CODEX_COMMAND_DRAIN_MS: "25" } });
    expect(result.exitCode).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(500);
    const path = artifactPath(text(result.stdout));
    const status = JSON.parse(readFileSync(join(path, "status.json"), "utf8"));
    expect(status.drainIncomplete).toBe(true);
  });

  test("runs even when artifact setup fails", () => {
    const root = temporaryDirectory();
    const blocked = join(root, "not-a-directory");
    writeFileSync(blocked, "file");
    chmodSync(blocked, 0o400);
    const result = invoke(runner, ["run", "--base64url", encode("echo still-runs; echo visible-error >&2; exit 7")], { env: { CODEX_COMMAND_OUTPUT_DIR: blocked } });
    expect(result.exitCode).toBe(7);
    expect(text(result.stderr)).toContain("artifact capture unavailable");
    expect(text(result.stdout)).toContain("artifact: unavailable");
    expect(text(result.stdout)).toContain("still-runs");
    expect(text(result.stderr)).toContain("visible-error");
  });

  test("uses the invoking zsh and supports process substitution", () => {
    if (!Bun.file("/bin/zsh").size) return;
    const root = temporaryDirectory();
    const result = invoke(runner, ["run", "--base64url", encode("cat <(printf process-substitution)")], { env: { CODEX_COMMAND_OUTPUT_DIR: root, SHELL: "/bin/zsh" } });
    expect(result.exitCode).toBe(0);
    const path = artifactPath(text(result.stdout));
    expect(readFileSync(join(path, "stdout.log"), "utf8")).toBe("process-substitution");
    expect(JSON.parse(readFileSync(join(path, "status.json"), "utf8")).shell).toBe("/bin/zsh");
  });

  test("prints one artifact path, change-only progress, full small output, and compact completion", () => {
    const root = temporaryDirectory();
    const result = invoke(runner, ["run", "--base64url", encode("sleep 0.08; printf compact; printf warning >&2")], { env: { CODEX_COMMAND_OUTPUT_DIR: root, CODEX_COMMAND_HEARTBEAT_MS: "25" } });
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
    const result = invoke(runner, ["run", "--base64url", encode("printf 1234567890")], { env: { CODEX_COMMAND_OUTPUT_DIR: root, CODEX_COMMAND_INLINE_BYTES: "5" } });
    const output = text(result.stdout);
    expect(output).toContain("[codex-command] stdout tail:\n1234567890");
    expect(output).not.toContain("[codex-command] stdout:\n");
    expect(output.match(/\[codex-command\] artifact:/g)).toHaveLength(1);
  });
});
