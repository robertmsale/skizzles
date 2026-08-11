import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const hook = join(repositoryRoot, "hooks/approve-safe-operations.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "skizzles-permission-policy-"));
  temporaryDirectories.push(path);
  return path;
}

function invoke(event: unknown): string {
  const result = Bun.spawnSync(["bun", hook], {
    stdin: new TextEncoder().encode(JSON.stringify(event)),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  return new TextDecoder().decode(result.stdout);
}

function permission(command: string, toolName = "Bash", cwd = repositoryRoot): unknown {
  return {
    hook_event_name: "PermissionRequest",
    cwd,
    tool_name: toolName,
    tool_input: { command },
  };
}

function expectAllowed(output: string): void {
  expect(JSON.parse(output)).toEqual({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  });
}

describe("hot-reloadable permission policy", () => {
  test("allows representative local development commands", () => {
    for (const command of [
      "cargo test -p skizzles",
      "cargo +nightly clippy --workspace",
      "npm run typecheck && git status --short",
      "xcrun --sdk iphonesimulator xcodebuild -scheme App build",
      "fvm flutter test",
      "rustup run nightly cargo check",
      "git add src && git commit -m 'focused change'",
    ]) {
      expectAllowed(invoke(permission(command)));
    }
  });

  test("leaves consequential or shell-complex commands for Guardian", () => {
    for (const command of [
      "git rebase main",
      "git cherry-pick HEAD",
      "git reset --hard HEAD",
      "git stash",
      "git fetch --prune origin",
      "git fetch origin +refs/heads/main:refs/heads/feature",
      "git push origin main",
      "git branch -D other",
      "git branch -d other",
      "git commit --amend --no-edit",
      "git switch -C main",
      "git commit --no-verify -m change",
      "/tmp/git status",
      "PATH=/tmp git status",
      "npx vercel deploy --prod",
      "npm exec -- wrangler deploy",
      "pnpx firebase deploy",
      "npm publish",
      "bun run deploy",
      "npm run --silent deploy",
      "npm run --if-present deploy",
      "bun run --silent deploy",
      "yarn run --silent deploy",
      "pnpm run --silent deploy",
      "bazel run //tools:deploy",
      "gradle publishToMavenCentral",
      "npm install --global eslint",
      "npm install --location=global eslint",
      "npm install --location global eslint",
      "npm install -gD eslint",
      "bun add -g eslint",
      "npm install --prefix ~/.local evil",
      "npm install --prefix ~robertsale/.local evil",
      "npm install --prefix {..,/tmp}/local evil",
      "cargo test \"--target-dir=$HOME/.cache/target\"",
      "cargo test \"--target-dir=$(printf /tmp/target)\"",
      "cargo test \"--target-dir=`printf /tmp/target`\"",
      "cargo install cargo-nextest",
      "cargo install --root ~/.local evil",
      "cargo test --target-dir ~robertsale/.cache/target",
      "flutter publish",
      "flutter pub publish",
      "pod trunk push Package.podspec",
      "pod repo push trunk Package.podspec",
      "make -f /tmp/Makefile release",
      "xcodebuild -exportArchive -archivePath App.xcarchive",
      "xcrun xcodebuild -exportArchive -archivePath App.xcarchive",
      "xcodebuild -archivePath ~/Desktop/App.xcarchive archive",
      "xcodebuild -archivePath ~robertsale/Desktop/App.xcarchive archive",
      "env --chdir=/ cargo test",
      "xcrun simctl erase all",
      "xcrun simctl --set default erase all",
      "cargo test | tee output.log",
      "cargo test > output.log",
      "echo $(cargo test)",
    ]) {
      expect(invoke(permission(command)), command).toBe("");
    }
  });

  test("allows patches wholly contained in one Git worktree outside the task cwd", () => {
    const root = temporaryDirectory();
    Bun.spawnSync(["git", "init", "-q", root]);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/existing.ts"), "old\n");
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${join(root, "src/existing.ts")}`,
      "@@",
      "-old",
      "+new",
      `*** Add File: ${join(root, "src/new.ts")}`,
      "+new",
      "*** End Patch",
    ].join("\n");

    expectAllowed(invoke(permission(patch, "apply_patch", repositoryRoot)));
  });

  test("leaves non-repository, Git metadata, and cross-repository patches for Guardian", () => {
    const first = temporaryDirectory();
    const second = temporaryDirectory();
    Bun.spawnSync(["git", "init", "-q", first]);
    Bun.spawnSync(["git", "init", "-q", second]);
    const cases = [
      `*** Begin Patch\n*** Add File: ${join(temporaryDirectory(), "plain.txt")}\n+x\n*** End Patch`,
      `*** Begin Patch\n*** Add File: ${join(first, ".git/config")}\n+x\n*** End Patch`,
      `*** Begin Patch\n*** Add File: ${join(first, "one.txt")}\n+x\n*** Add File: ${join(second, "two.txt")}\n+x\n*** End Patch`,
    ];

    for (const patch of cases) {
      expect(invoke(permission(patch, "apply_patch", repositoryRoot))).toBe("");
    }
  });

  test("fails open for unrelated or malformed hook events", () => {
    expect(invoke({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cargo test" } })).toBe("");
    expect(invoke({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: {} })).toBe("");
    expect(invoke(["PermissionRequest"])).toBe("");
  });
});
