import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "../..");
const hook = join(packageRoot, "hooks/manage-command-output.ts");
const runner = join(packageRoot, "runtime/codex-command.ts");
const runnerCommand = 'bun "${PLUGIN_ROOT}/runtime/codex-command.ts"';
const bypassPermissionsMode = "bypassPermissions";
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

function invokeHook(
  command: string,
  options: {
    key?: "cmd" | "command";
    permissionMode?: unknown;
    toolInput?: Record<string, unknown>;
  } = {},
) {
  const { key = "command", toolInput = {} } = options;
  const permissionMode = Object.hasOwn(options, "permissionMode")
    ? options.permissionMode
    : bypassPermissionsMode;
  return invoke(hook, [], {
    stdin: JSON.stringify({
      hook_event_name: "PreToolUse",
      ...(permissionMode === undefined ? {} : { permission_mode: permissionMode }),
      tool_input: { ...toolInput, [key]: command },
    }),
  });
}

function text(output: Uint8Array | undefined): string {
  return new TextDecoder().decode(output);
}

function encode(script: string): string {
  return JSON.stringify(script);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function rewrittenCommand(script: string): string {
  return `${runnerCommand} run --json ${shellSingleQuote(encode(script))}`;
}

function artifactPath(output: string): string {
  const match = output.match(/\[codex-command\] artifact: ([^\n]+)/);
  if (!match) throw new Error(`artifact path missing from output: ${output}`);
  return match[1]!;
}

async function waitForFile(path: string, timeoutMilliseconds = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMilliseconds = 1_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (processExists(pid)) {
    if (performance.now() >= deadline) return false;
    await Bun.sleep(10);
  }
  return true;
}

function stopProcess(pid: number): void {
  if (!processExists(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between observation and delivery.
  }
}

function spawnRunner(script: string, root: string, env: Record<string, string> = {}) {
  return Bun.spawn(["bun", runner, "run", "--json", encode(script)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CODEX_COMMAND_OUTPUT_DIR: root, ...env },
  });
}

function exitWithin(child: Bun.Subprocess, timeoutMilliseconds: number): Promise<number | undefined> {
  return Promise.race([child.exited, Bun.sleep(timeoutMilliseconds).then(() => undefined)]);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("managed command output hook", () => {
  test("passes through unknown commands and comments or quoted lookalikes", () => {
    for (const cmd of ["echo flutter test", "# bun test\necho okay", "printf 'dart test'"]) {
      const result = invokeHook(cmd, { key: "cmd" });
      expect(result.exitCode).toBe(0);
      expect(text(result.stdout)).toBe("");
    }
  });

  test("rewrites through a portable PLUGIN_ROOT runner with a visible, shell-safe JSON encoding", () => {
    const cmd = "flutter test --name \"it's literal\"";
    const result = invokeHook(cmd, { key: "cmd", toolInput: { workdir: "/tmp" } });
    const payload = JSON.parse(text(result.stdout));
    expect(payload.hookSpecificOutput.permissionDecision).toBe("allow");
    const rewritten = payload.hookSpecificOutput.updatedInput.cmd as string;
    expect(rewritten).toBe(rewrittenCommand(cmd));
    expect(rewritten).toContain("flutter test");
    expect(payload.hookSpecificOutput.updatedInput.workdir).toBe("/tmp");
    expect(rewritten).not.toContain("/Users/");
  });

  test("the placeholder resolves without expanding the encoded script in the outer shell", () => {
    const root = temporaryDirectory();
    const script = "printf '%s\\n' 'literal $HOME `uname`'";
    const command = rewrittenCommand(script);
    const result = Bun.spawnSync(["/bin/sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PLUGIN_ROOT: packageRoot, CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toContain("literal $HOME `uname`");
    const path = artifactPath(text(result.stdout));
    expect(JSON.parse(readFileSync(join(path, "status.json"), "utf8")).command).toBe(script);
  });

  test("rewrites and preserves an entire script when every command is recognized", () => {
    const command = "flutter test; bun test; cargo check";
    const result = invoke(hook, [], { stdin: JSON.stringify({
      hook_event_name: "PreToolUse",
      permission_mode: bypassPermissionsMode,
      tool_name: "Bash",
      tool_input: { command, timeout: 120_000 },
    }) });
    const payload = JSON.parse(text(result.stdout));
    const rewritten = payload.hookSpecificOutput.updatedInput.command as string;
    expect(rewritten).toBe(rewrittenCommand(command));
    expect(payload.hookSpecificOutput.updatedInput.timeout).toBe(120_000);
  });

  test("does not classify quoted, commented, substitution, or heredoc-like lookalikes", () => {
    for (const command of [
      "echo 'header; flutter test'",
      "echo header; # flutter test\necho footer",
      "echo $(flutter test)",
      "cat <<EOF\nflutter test\nEOF",
    ]) {
      const result = invokeHook(command);
      expect(text(result.stdout)).toBe("");
    }
  });

  test("recognizes high-value build and test commands through common launchers", () => {
    for (const command of [
      "cargo build --workspace", "cargo +nightly test --workspace", "cargo nextest run", "cargo llvm-cov --workspace", "RUST_LOG=debug cargo clippy --workspace", "env RUST_BACKTRACE=1 cargo check", "rustup run nightly cargo test", "xcodebuild -workspace App.xcworkspace -scheme App test", "xcrun --sdk iphonesimulator xcodebuild -scheme App build", "/usr/bin/xcodebuild -scheme App build", "swift build", "xcrun swift test", "gradle build", "./gradlew :app:testDebugUnitTest --no-daemon", "./gradlew connectedDebugAndroidTest", "fvm flutter test",
    ]) {
      const result = invokeHook(command);
      expect(text(result.stdout), command).not.toBe("");
    }
  });

  test("recognizes literal Container Lab launchers with independently safe attached payloads", () => {
    for (const command of [
      "codex-container-lab --owner thread-1 --state-root /tmp/state --runtime-root /tmp/runtime run --lab experiment -- cargo test",
      "/tmp/source/skills/codex-container-lab/scripts/codex-container-lab --owner thread-1 run --lab experiment -- bun test",
      "bun /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab --owner thread-1 run --lab experiment -- cargo test",
      "A=1 /tmp/source/skills/codex-container-lab/scripts/codex-container-lab --owner thread-1 run --lab experiment -- flutter analyze",
      "env A=1 /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab --state-root /tmp/state run --lab experiment -- swift build",
      "env -i A=1 /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab run --lab experiment -- dart test",
      "env -u FOO A=1 /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab run --lab experiment -- cargo check",
      "env -C ./tmp A=1 /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab run --lab experiment -- just test",
      "env --unset=FOO A=1 /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab run --lab experiment -- gradle build",
      "env --chdir=./tmp A=1 /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab run --lab experiment -- xcodebuild -scheme App test",
      "A= /tmp/source/skills/codex-container-lab/scripts/codex-container-lab run --lab experiment -- cargo nextest run",
      "env A= /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab run --lab experiment -- bun run test",
      "codex-container-lab run --lab experiment -- cargo test -- --nocapture",
      "codex-container-lab run --lab experiment -- cargo test --package \"api tests\"",
      "codex-container-lab run --lab experiment -- rustup run \"nightly\" cargo test",
      "codex-container-lab run --lab experiment -- xcodebuild -scheme \"App Tests\" test",
    ]) {
      const result = invokeHook(command);
      expect(text(result.stdout), command).not.toBe("");
    }
  });

  test("preserves exact Container Lab text and host fields for supported run options", () => {
    const command = "codex-container-lab run --lab experiment --cwd packages/api --env RUST_LOG=debug --env EMPTY= --timeout-seconds 120 -- cargo test --workspace";
    const result = invokeHook(command, { toolInput: { workdir: "/tmp/project", timeout: 120_000 } });
    const payload = JSON.parse(text(result.stdout));
    expect(payload.hookSpecificOutput.updatedInput.command).toBe(rewrittenCommand(command));
    expect(payload.hookSpecificOutput.updatedInput.workdir).toBe("/tmp/project");
    expect(payload.hookSpecificOutput.updatedInput.timeout).toBe(120_000);
  });

  test("does not mistake Container Lab lookalikes, malformed runs, or unsafe payloads for managed commands", () => {
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
      "\"A=1\" codex-container-lab run --lab experiment -- echo hello",
      "A=\"1\" codex-container-lab run --lab experiment -- echo hello",
      "\"env\" A=1 codex-container-lab run --lab experiment -- echo hello",
      "env \"A=1\" codex-container-lab run --lab experiment -- echo hello",
      "env \"-i\" A=1 codex-container-lab run --lab experiment -- echo hello",
      "env -u \"FOO\" A=1 codex-container-lab run --lab experiment -- echo hello",
      "env -C \"./tmp\" A=1 codex-container-lab run --lab experiment -- echo hello",
      "env --unset= A=1 codex-container-lab run --lab experiment -- echo hello",
      "env --chdir= A=1 codex-container-lab run --lab experiment -- echo hello",
      "codex-container-lab --owner thread health",
      "codex-container-lab run --lab experiment",
      "codex-container-lab run --lab experiment cargo test",
      "codex-container-lab run -- cargo test",
      "codex-container-lab run --lab one --lab two -- cargo test",
      "codex-container-lab run --lab experiment --cwd one --cwd two -- cargo test",
      "codex-container-lab run --lab experiment --timeout-seconds 1 --timeout-seconds 2 -- cargo test",
      "codex-container-lab run --lab experiment --cwd -- cargo test",
      "codex-container-lab run --lab experiment --unknown value -- cargo test",
      "codex-container-lab run --lab experiment --env INVALID -- cargo test",
      "codex-container-lab run --lab experiment --cwd ../outside -- cargo test",
      "codex-container-lab run --lab experiment --timeout-seconds later -- cargo test",
      "codex-container-lab run --lab experiment --timeout-seconds 7201 -- cargo test",
      "codex-container-lab run --lab experiment \"--\" cargo test",
      "codex-container-lab run --lab experiment -- \"cargo\" test",
      "codex-container-lab run --lab experiment -- cargo \"test\"",
      "codex-container-lab run --lab experiment -- sh -c cargo test",
      "codex-container-lab run --lab experiment -- rm -rf /tmp/sentinel",
      "codex-container-lab run --lab experiment -- cargo install arbitrary-package",
      "codex-container-lab run --lab experiment -- cargo publish",
      "codex-container-lab run --lab experiment -- xcodebuild -scheme App archive",
      "codex-container-lab run --lab experiment -- deploy-production",
      "codex-container-lab run --lab experiment -- npm test",
    ]) {
      const result = invokeHook(command);
      expect(text(result.stdout), command).toBe("");
    }
  });

  test("preserves native approval unless bypassPermissions is explicit", () => {
    for (const permission_mode of [undefined, "default", "acceptEdits", "plan", "dontAsk", 42]) {
      const result = invokeHook("bun test", { permissionMode: permission_mode });
      expect(text(result.stdout), String(permission_mode)).toBe("");
    }
  });

  test("requires every command in the script to be eligible", () => {
    for (const command of [
      "echo header; flutter test",
      "flutter test; rm -rf /tmp/sentinel",
      "cargo check && deploy-production",
      "bun test | tee test.log",
    ]) {
      const result = invokeHook(command);
      expect(text(result.stdout), command).toBe("");
    }
  });

  test("leaves effectful Cargo and Xcode commands for the native boundary", () => {
    for (const command of [
      "cargo install arbitrary-package",
      "xcodebuild -scheme App archive",
      "xcodebuild -exportArchive -archivePath App.xcarchive",
      "xcodebuild -scheme App install",
    ]) {
      const result = invokeHook(command);
      expect(text(result.stdout), command).toBe("");
    }
  });

  test("requires literal launcher and action tokens for direct and attached commands", () => {
    for (const command of [
      "\"rustup\" run nightly cargo test",
      "rustup \"run\" nightly cargo test",
      "\"fvm\" flutter test",
      "\"xcrun\" --sdk iphonesimulator xcodebuild test",
      "swift \"test\" --parallel",
      "xcodebuild -scheme App \"test\"",
      "codex-container-lab run --lab experiment -- \"rustup\" run nightly cargo test",
      "codex-container-lab run --lab experiment -- rustup \"run\" nightly cargo test",
      "codex-container-lab run --lab experiment -- \"fvm\" flutter test",
      "codex-container-lab run --lab experiment -- \"xcrun\" --sdk iphonesimulator xcodebuild test",
      "codex-container-lab run --lab experiment -- swift \"test\" --parallel",
      "codex-container-lab run --lab experiment -- xcodebuild -scheme App \"test\"",
    ]) {
      const result = invokeHook(command);
      expect(text(result.stdout), command).toBe("");
    }
  });

  test("leaves ambiguous dual command fields unchanged", () => {
    const result = invoke(hook, [], {
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        permission_mode: bypassPermissionsMode,
        tool_input: { cmd: "bun test", command: "cargo test" },
      }),
    });
    expect(text(result.stdout)).toBe("");
  });

  test("leaves low-value formatter and informational commands alone", () => {
    for (const command of ["dart format .", "cargo metadata --format-version 1", "cargo fmt --check", "swift --version", "gradle tasks", "./gradlew properties"]) {
      const result = invokeHook(command);
      expect(text(result.stdout), command).toBe("");
    }
  });
});

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

  test("settles a TERM-ignoring descendant after normal shell completion", async () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const descendantPidPath = join(root, "descendant.pid");
    const startedAt = performance.now();
    const result = invoke(
      runner,
      ["run", "--json", encode(`/bin/sh -c 'trap "" TERM; printf %s $$ > "${descendantPidPath}"; while :; do sleep 1; done' & exit 23`)],
      {
        env: {
          CODEX_COMMAND_OUTPUT_DIR: join(root, "artifacts"),
          CODEX_COMMAND_DRAIN_MS: "25",
          CODEX_COMMAND_SIGNAL_GRACE_MS: "100",
        },
      },
    );
    await waitForFile(descendantPidPath);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    const descendantExited = await waitForProcessExit(descendantPid);
    if (!descendantExited) stopProcess(descendantPid);

    expect(result.exitCode).toBe(23);
    expect(descendantExited).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    const path = artifactPath(text(result.stdout));
    const status = JSON.parse(readFileSync(join(path, "status.json"), "utf8"));
    expect(status.exitCode).toBe(23);
    expect(status.drainIncomplete).toBe(true);
  });

  test("cleans up a cooperative descendant after captured output drains completely", async () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const descendantPidPath = join(root, "descendant.pid");
    const terminatedPath = join(root, "terminated");
    const result = invoke(
      runner,
      ["run", "--json", encode(`/bin/sh -c 'trap "printf terminated > \\"${terminatedPath}\\"; exit 0" TERM; printf %s $$ > "${descendantPidPath}"; while :; do sleep 1; done' </dev/null >/dev/null 2>/dev/null & while [ ! -f '${descendantPidPath}' ]; do :; done`)],
      {
        env: {
          CODEX_COMMAND_OUTPUT_DIR: join(root, "artifacts"),
          CODEX_COMMAND_DRAIN_MS: "25",
          CODEX_COMMAND_SIGNAL_GRACE_MS: "500",
        },
      },
    );
    await waitForFile(descendantPidPath);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    const descendantExited = await waitForProcessExit(descendantPid);
    if (!descendantExited) stopProcess(descendantPid);

    expect(result.exitCode).toBe(0);
    expect(descendantExited).toBe(true);
    expect(readFileSync(terminatedPath, "utf8")).toBe("terminated");
    const status = JSON.parse(readFileSync(join(artifactPath(text(result.stdout)), "status.json"), "utf8"));
    expect(status.exitCode).toBe(0);
    expect(status.drainIncomplete).toBe(false);
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

  test("forwards SIGTERM to the shell and preserves its handled exit", async () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const shellPidPath = join(root, "shell.pid");
    const child = spawnRunner(
      `trap 'printf handled >&2; exit 42' TERM; printf %s $$ > '${shellPidPath}'; while :; do :; done`,
      join(root, "artifacts"),
      { CODEX_COMMAND_SIGNAL_GRACE_MS: "250" },
    );
    await waitForFile(shellPidPath);
    const shellPid = Number.parseInt(readFileSync(shellPidPath, "utf8"), 10);
    process.kill(child.pid, "SIGTERM");
    const exitCode = await exitWithin(child, 1_500);
    if (exitCode === undefined) {
      stopProcess(shellPid);
      stopProcess(child.pid);
    }

    expect(exitCode).toBe(42);
    const output = await new Response(child.stdout).text();
    const directory = artifactPath(output);
    const status = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
    expect(status.signal).toBe("SIGTERM");
    expect(status.exitCode).toBe(42);
    expect(readFileSync(join(directory, "stderr.log"), "utf8")).toBe("handled");
  });

  test("escalates for a signal-ignoring shell and descendant without hanging", async () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const shellPidPath = join(root, "shell.pid");
    const descendantPidPath = join(root, "descendant.pid");
    const child = spawnRunner(
      `trap '' TERM; printf %s $$ > '${shellPidPath}'; /bin/sh -c 'trap "" TERM; printf %s $$ > "${descendantPidPath}"; while :; do sleep 1; done' & wait`,
      join(root, "artifacts"),
      { CODEX_COMMAND_SIGNAL_GRACE_MS: "100" },
    );
    await waitForFile(shellPidPath);
    await waitForFile(descendantPidPath);
    const shellPid = Number.parseInt(readFileSync(shellPidPath, "utf8"), 10);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    process.kill(child.pid, "SIGTERM");
    const exitCode = await exitWithin(child, 1_500);
    const shellExited = await waitForProcessExit(shellPid);
    const descendantExited = await waitForProcessExit(descendantPid);
    if (!shellExited) stopProcess(shellPid);
    if (!descendantExited) stopProcess(descendantPid);
    if (exitCode === undefined) stopProcess(child.pid);

    expect(exitCode).toBe(137);
    expect(shellExited).toBe(true);
    expect(descendantExited).toBe(true);
    const output = await new Response(child.stdout).text();
    const status = JSON.parse(readFileSync(join(artifactPath(output), "status.json"), "utf8"));
    expect(status.signal).toBe("SIGTERM");
    expect(status.exitCode).toBe(137);
  });

  test("cancels an ignoring descendant after the shell exits and drains captured output", async () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const shellPidPath = join(root, "shell.pid");
    const descendantPidPath = join(root, "descendant.pid");
    const child = spawnRunner(
      `printf %s $$ > '${shellPidPath}'; printf shell-output; /bin/sh -c 'trap "" TERM; printf %s $$ > "${descendantPidPath}"; while :; do sleep 1; done' &`,
      join(root, "artifacts"),
      { CODEX_COMMAND_DRAIN_MS: "5000", CODEX_COMMAND_SIGNAL_GRACE_MS: "100" },
    );
    await waitForFile(shellPidPath);
    await waitForFile(descendantPidPath);
    const shellPid = Number.parseInt(readFileSync(shellPidPath, "utf8"), 10);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    expect(await waitForProcessExit(shellPid)).toBe(true);

    process.kill(child.pid, "SIGTERM");
    const exitCode = await exitWithin(child, 1_500);
    const descendantExited = await waitForProcessExit(descendantPid);
    if (!descendantExited) stopProcess(descendantPid);
    if (exitCode === undefined) stopProcess(child.pid);

    expect(exitCode).toBe(143);
    expect(descendantExited).toBe(true);
    const output = await new Response(child.stdout).text();
    const directory = artifactPath(output);
    const status = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
    expect(status.signal).toBe("SIGTERM");
    expect(status.exitCode).toBe(143);
    expect(status.drainIncomplete).toBe(false);
    expect(readFileSync(join(directory, "stdout.log"), "utf8")).toBe("shell-output");
  });
});
