import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isManagedContainerLabRun,
  parseContainerLabRunArguments,
} from "../../packages/skizzles-container-lab/run-contract.ts";
import {
  artifactPath,
  bypassPermissionsMode,
  createTestDirectories,
  hook,
  invoke,
  invokeHook,
  packageRoot,
  rewrittenCommand,
  text,
} from "./process-harness.ts";

const testDirectories = createTestDirectories();
const temporaryDirectory = () => testDirectories.create();
afterEach(() => testDirectories.cleanup());

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
      "cargo build --workspace", "cargo +nightly test --workspace", "cargo nextest run", "cargo llvm-cov --workspace", "RUST_LOG=debug cargo clippy --workspace", "env RUST_BACKTRACE=1 cargo check", "rustup run nightly cargo test", "xcodebuild -workspace App.xcworkspace -scheme App test", "xcodebuild -scheme \"test\" build", "xcrun --sdk iphonesimulator xcodebuild -scheme App build", "/usr/bin/xcodebuild -scheme App build", "swift build", "xcrun swift test", "gradle build", "./gradlew :app:testDebugUnitTest --no-daemon", "./gradlew connectedDebugAndroidTest", "fvm flutter test",
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
      "codex-container-lab run --lab experiment -- xcodebuild -scheme \"test\" build",
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
      "codex-container-lab run --lab experiment --env 1BAD=value -- cargo test",
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

  test("never allows a Container Lab run rejected by the canonical run parser", () => {
    const rejected = [
      ["--lab", "experiment"],
      ["--unknown", "value", "--", "cargo", "test"],
      ["--lab", "one", "--lab", "two", "--", "cargo", "test"],
      ["--lab", "experiment", "--cwd", "../outside", "--", "cargo", "test"],
      ["--lab", "experiment", "--env", "INVALID", "--", "cargo", "test"],
      ["--lab", "experiment", "--timeout-seconds", "later", "--", "cargo", "test"],
      ["--", "cargo", "test"],
    ];
    for (const args of rejected) {
      expect(parseContainerLabRunArguments(args).ok, args.join(" ")).toBe(false);
      const result = invokeHook(`codex-container-lab run ${args.join(" ")}`);
      expect(text(result.stdout), args.join(" ")).toBe("");
    }
  });

  test("never allows a Container Lab run rejected by the managed contract", () => {
    const args = [
      "--lab",
      "experiment",
      "--env",
      "1BAD=value",
      "--",
      "cargo",
      "test",
    ];
    const parsed = parseContainerLabRunArguments(args);
    expect(parsed.ok).toBe(true);
    expect(isManagedContainerLabRun(parsed)).toBe(false);
    const result = invokeHook(`codex-container-lab run ${args.join(" ")}`);
    expect(text(result.stdout)).toBe("");
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
