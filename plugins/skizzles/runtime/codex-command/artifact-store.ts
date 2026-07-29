import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type RunStatus = {
  id: string;
  command: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  signal?: string;
  shell: string;
  stdoutObservedBytes: number;
  stderrObservedBytes: number;
  stdoutStoredBytes: number;
  stderrStoredBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  artifactCapture: "active" | "unavailable";
  drainIncomplete: boolean;
};

export type RunArtifacts = {
  directory?: string;
  stdoutFile?: number;
  stderrFile?: number;
  statusPath?: string;
  available: boolean;
  error?: unknown;
};

const tailBytes = 1_200;

export function commandOutputRoot(): string {
  if (process.env.CODEX_COMMAND_OUTPUT_DIR) return process.env.CODEX_COMMAND_OUTPUT_DIR;
  const candidate = resolve(tmpdir());
  const cwd = resolve(process.cwd());
  const fromWorkingTree = relative(cwd, candidate);
  const safeTemporaryDirectory = fromWorkingTree === ""
      || (!fromWorkingTree.startsWith("..") && !isAbsolute(fromWorkingTree))
    ? "/tmp"
    : candidate;
  return join(safeTemporaryDirectory, "codex-command-output");
}

export function prepareRunArtifacts(root: string, id: string, maximumDiskBytes: number): RunArtifacts {
  let directory: string | undefined;
  let stdoutFile: number | undefined;
  let stderrFile: number | undefined;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    cleanOldRuns(root, maximumDiskBytes);
    directory = ensureRunDirectory(root, id);
    stdoutFile = createArtifact(join(directory, "stdout.log"));
    stderrFile = createArtifact(join(directory, "stderr.log"));
    return {
      directory,
      stdoutFile,
      stderrFile,
      statusPath: join(directory, "status.json"),
      available: true,
    };
  } catch (error) {
    closeArtifactFile(stdoutFile);
    closeArtifactFile(stderrFile);
    return {
      ...(directory === undefined ? {} : { directory }),
      available: false,
      error,
    };
  }
}

export function closeArtifactFile(file: number | undefined): void {
  if (file === undefined) return;
  try {
    closeSync(file);
  } catch {}
}

export function writeRunStatus(path: string, status: RunStatus): void {
  try {
    writeFileSync(path, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {}
}

export function readArtifact(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function readArtifactTail(path: string): string {
  try {
    const content = readFileSync(path);
    return content.subarray(Math.max(0, content.length - tailBytes)).toString("utf8");
  } catch {
    return "";
  }
}

export function requireRunDirectory(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid run id");
  const directory = join(commandOutputRoot(), id);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`run not found: ${id}`);
  }
  return directory;
}

function ensureRunDirectory(root: string, id: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const directory = join(root, id);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function cleanOldRuns(root: string, limit: number): void {
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = join(root, entry.name);
        const info = statSync(path);
        let size = 0;
        for (const file of readdirSync(path)) {
          try {
            const candidate = join(path, file);
            if (statSync(candidate).isFile()) size += statSync(candidate).size;
          } catch {}
        }
        return { path, mtime: info.mtimeMs, size };
      })
      .sort((left, right) => left.mtime - right.mtime);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= limit) break;
      rmSync(entry.path, { recursive: true, force: true });
      total -= entry.size;
    }
  } catch {
    // Cleanup is best effort; a run must still be able to execute.
  }
}

function createArtifact(path: string): number {
  return openSync(path, "wx", 0o600);
}
