import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSupervisorResult } from "./capture";

setDefaultTimeout(10_000);

async function runSupervisor(root: string, stdoutPath: string, stderrPath: string, statusPath: string, command: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn(["python3", join(import.meta.dir, "supervisor.py"), "--cwd", root, "--stdout", stdoutPath, "--stderr", stderrPath, "--stdout-cap", "8", "--stderr-cap", "8", "--timeout-ms", "500", "--grace-ms", "50", "--status", statusPath, "--", ...command], { cwd: root, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  child.stdin.end();
  const exitCode = await child.exited;
  const stderr = child.stderr ? await new Response(child.stderr).text() : "";
  return { exitCode, stderr };
}

function completeStatus() {
  return { schemaVersion: "supervisor-status-v2", status: "complete", exitCode: 0, timedOut: false, drainTimedOut: false, interrupted: false, captureComplete: true, failureCategory: "", stdout: { bytes: 0, storedBytes: 0, truncated: false }, stderr: { bytes: 0, storedBytes: 0, truncated: false } };
}

function runPython(script: string): Record<string, unknown> {
  const result = Bun.spawnSync(["python3", "-c", script], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout)) as Record<string, unknown>;
}

test("stream output failure emits closed failed status", async () => {
  const root = await mkdtemp(join(tmpdir(), "skizzles-supervisor-stream-failure-"));
  const stdoutPath = join(root, "stdout-dir"); const stderrPath = join(root, "stderr.bin"); const statusPath = join(root, "status.json");
  await mkdir(stdoutPath);
  try {
    const result = await runSupervisor(root, stdoutPath, stderrPath, statusPath, ["python3", "-c", "import sys,time; sys.stdout.buffer.write(b'child-text'); sys.stdout.flush(); time.sleep(.2)"]);
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    expect(result.exitCode).not.toBe(0); expect(status.status).toBe("failed"); expect(status.exitCode).toBe(125); expect(status.captureComplete).toBe(false); expect(status.failureCategory).toBe("stream-open");
    const publicText = JSON.stringify(status) + result.stderr; expect(publicText).not.toContain(stdoutPath); expect(publicText).not.toContain("IsADirectoryError"); expect(publicText).not.toContain("child-text");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("status target failure exits nonzero without raw path output", async () => {
  const root = await mkdtemp(join(tmpdir(), "skizzles-supervisor-status-failure-"));
  const stdoutPath = join(root, "stdout.bin"); const stderrPath = join(root, "stderr.bin"); const statusPath = join(root, "status-dir");
  await mkdir(statusPath);
  try {
    const result = await runSupervisor(root, stdoutPath, stderrPath, statusPath, ["python3", "-c", "import sys; sys.stdout.buffer.write(b'child-text'); sys.stdout.flush()"]);
    expect(result.exitCode).not.toBe(0); expect(result.stderr).not.toContain(statusPath); expect(result.stderr).not.toContain("IsADirectoryError"); expect(await readdir(statusPath)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("status parser rejects mismatch, old schema, missing fields, and contradictory counters", () => {
  const complete = completeStatus();
  expect(parseSupervisorResult(JSON.stringify(complete), 0, 8, 8).captureComplete).toBe(true);
  expect(parseSupervisorResult(JSON.stringify(complete), 125, 8, 8).captureComplete).toBe(false);
  expect(parseSupervisorResult(JSON.stringify({ ...complete, schemaVersion: "supervisor-status-v1" }), 0, 8, 8).captureComplete).toBe(false);
  const { stdout: _stdout, ...missing } = complete;
  expect(parseSupervisorResult(JSON.stringify(missing), 0, 8, 8).captureComplete).toBe(false);
  expect(parseSupervisorResult(JSON.stringify({ ...complete, stdout: { bytes: 7, storedBytes: 3, truncated: false } }), 0, 8, 8).captureComplete).toBe(false);
  expect(parseSupervisorResult(JSON.stringify({ ...complete, stdout: { bytes: 9, storedBytes: 8, truncated: false } }), 0, 8, 8).captureComplete).toBe(false);
  const causeFree = parseSupervisorResult(JSON.stringify({ ...complete, status: "failed", exitCode: 125, captureComplete: false }), 125, 8, 8); expect(causeFree.captureComplete).toBe(false); expect(causeFree.captureFailureCategory).toBe("internal");
});

test("failed status preserves observed partial counts without success", () => {
  const failed = { ...completeStatus(), status: "failed", exitCode: 125, captureComplete: false, failureCategory: "stream-write", stdout: { bytes: 9, storedBytes: 8, truncated: true } };
  const parsed = parseSupervisorResult(JSON.stringify(failed), 125, 8, 8);
  expect(parsed.exitCode).toBe(125); expect(parsed.captureComplete).toBe(false); expect(parsed.captureFailureCategory).toBe("stream-write"); expect(parsed.stdout).toEqual({ bytes: 9, storedBytes: 8, truncated: true });
});

test("write_all retries short writes and closes failures", () => {
  const result = runPython(`import json,threading,sys; sys.path.insert(0,'.'); from supervisor import close_output,new_state,write_all
class W:
 def __init__(self, values): self.values=list(values)
 def write(self, data):
  value=self.values.pop(0)
  if value == 'error': raise OSError('hidden')
  return value
class C:
 def flush(self): pass
 def close(self): raise OSError('hidden')
a=write_all(W([3,2,1]), memoryview(b'abcdef')); b=write_all(W([3,0]), memoryview(b'abcdef')); c=write_all(W([3,'error']), memoryview(b'abcdef')); s=new_state(); e=threading.Event(); close_output(C(),s,threading.Lock(),e); print(json.dumps({'a':a,'b':b,'c':c,'failed':s['captureFailed'],'category':s['failureCategory']}))`);
  expect(result).toEqual({ a: [6, true], b: [3, false], c: [3, false], failed: true, category: "stream-close" });
});

test("RLIMIT short write is a failed stream capture with exact stored bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "skizzles-supervisor-rlimit-")); const stdoutPath = join(root, "stdout.bin"); const stderrPath = join(root, "stderr.bin"); const statusPath = join(root, "status.json");
  const launcher = "import os,resource,signal,sys; signal.signal(signal.SIGXFSZ,signal.SIG_IGN); resource.setrlimit(resource.RLIMIT_FSIZE,(1000,1000)); os.execv(sys.executable,[sys.executable,sys.argv[1],*sys.argv[2:]])";
  try {
    const child = Bun.spawn(["python3", "-c", launcher, join(import.meta.dir, "supervisor.py"), "--cwd", root, "--stdout", stdoutPath, "--stderr", stderrPath, "--stdout-cap", "65536", "--stderr-cap", "65536", "--timeout-ms", "1000", "--grace-ms", "50", "--status", statusPath, "--", "python3", "-c", "import sys; sys.stdout.buffer.write(b'Q'*2000); sys.stdout.flush()"], { cwd: root, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    child.stdin.end(); const exitCode = await child.exited; const status = JSON.parse(await readFile(statusPath, "utf8")); const stored = (status.stdout as { storedBytes: number }).storedBytes;
    expect(exitCode).toBe(125); expect(status.status).toBe("failed"); expect(status.captureComplete).toBe(false); expect(status.failureCategory).toBe("stream-write"); expect(status.stdout.bytes).toBe(2000); expect(stored).toBeGreaterThan(0); expect(stored).toBeLessThan(2000); expect((await readFile(stdoutPath)).byteLength).toBe(stored); expect(JSON.stringify(status)).not.toContain("EFBIG"); expect(JSON.stringify(status)).not.toContain("RLIMIT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cap truncation remains visible when the kept prefix short-writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "skizzles-supervisor-cap-write-")); const stdoutPath = join(root, "stdout.bin"); const stderrPath = join(root, "stderr.bin"); const statusPath = join(root, "status.json");
  const launcher = "import os,resource,signal,sys; signal.signal(signal.SIGXFSZ,signal.SIG_IGN); resource.setrlimit(resource.RLIMIT_FSIZE,(1000,1000)); os.execv(sys.executable,[sys.executable,sys.argv[1],*sys.argv[2:]])";
  try {
    const child = Bun.spawn(["python3", "-c", launcher, join(import.meta.dir, "supervisor.py"), "--cwd", root, "--stdout", stdoutPath, "--stderr", stderrPath, "--stdout-cap", "2000", "--stderr-cap", "2000", "--timeout-ms", "1000", "--grace-ms", "50", "--status", statusPath, "--", "python3", "-c", "import sys; sys.stdout.buffer.write(b'Q'*3000); sys.stdout.flush()"], { cwd: root, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    child.stdin.end(); const exitCode = await child.exited; const status = JSON.parse(await readFile(statusPath, "utf8")); const stdout = status.stdout as { bytes: number; storedBytes: number; truncated: boolean };
    expect(exitCode).toBe(125); expect(status.status).toBe("failed"); expect(status.failureCategory).toBe("stream-write"); expect(stdout.bytes).toBe(3000); expect(stdout.truncated).toBe(true); expect(stdout.storedBytes).toBeLessThan(2000); expect((await readFile(stdoutPath)).byteLength).toBe(stdout.storedBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
