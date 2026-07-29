import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const packageRoot = resolve(import.meta.dir, "../..");
export const hook = join(packageRoot, "hooks/manage-command-output.ts");
export const runner = join(packageRoot, "runtime/codex-command.ts");
export const defaultPermissionMode = "default";
export const bypassPermissionsMode = "bypassPermissions";

const runnerCommand = 'bun "${PLUGIN_ROOT}/runtime/codex-command.ts"';

export function createTestDirectories() {
  const directories: string[] = [];
  return {
    create(): string {
      const directory = mkdtempSync(join(tmpdir(), "codex-command-test-"));
      directories.push(directory);
      return directory;
    },
    cleanup(): void {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

export function invoke(
  executable: string,
  arguments_: string[],
  options: {
    stdin?: string;
    env?: Record<string, string | undefined>;
  } = {},
) {
  return Bun.spawnSync(["bun", executable, ...arguments_], {
    stdin: options.stdin ? new TextEncoder().encode(options.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
}

export function invokeHook(
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
    : defaultPermissionMode;
  return invoke(hook, [], {
    stdin: JSON.stringify({
      hook_event_name: "PreToolUse",
      ...(permissionMode === undefined ? {} : { permission_mode: permissionMode }),
      tool_input: { ...toolInput, [key]: command },
    }),
  });
}

export function text(output: Uint8Array | undefined): string {
  return new TextDecoder().decode(output);
}

export function encode(script: string): string {
  return JSON.stringify(script);
}

export function rewrittenCommand(script: string): string {
  return `${runnerCommand} run --json ${shellSingleQuote(encode(script))}`;
}

export function artifactPath(output: string): string {
  const match = output.match(/\[codex-command\] artifact: ([^\n]+)/);
  if (!match) throw new Error(`artifact path missing from output: ${output}`);
  return match[1]!;
}

export async function waitForFile(
  path: string,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

export async function waitForProcessExit(
  pid: number,
  timeoutMilliseconds = 1_000,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (processExists(pid)) {
    if (performance.now() >= deadline) return false;
    await Bun.sleep(10);
  }
  return true;
}

export function stopProcess(pid: number): void {
  if (!processExists(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between observation and delivery.
  }
}

export function spawnRunner(
  script: string,
  root: string,
  env: Record<string, string> = {},
) {
  return Bun.spawn(["bun", runner, "run", "--json", encode(script)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CODEX_COMMAND_OUTPUT_DIR: root, ...env },
  });
}

export function exitWithin(
  child: Bun.Subprocess,
  timeoutMilliseconds: number,
): Promise<number | undefined> {
  return Promise.race([
    child.exited,
    Bun.sleep(timeoutMilliseconds).then(() => undefined),
  ]);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
