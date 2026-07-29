import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRun } from "./capture";
import { materializeInstructionOverlays } from "./overlays";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

test("quiet detached writes cannot alter the quarantined verification snapshot", async () => {
  const root = await tempRoot("skizzles-prompt-eval-quiet-setsid-");
  const fake = join(root, "fake-quiet.sh");
  await writeFile(fake, `#!/bin/sh
fixture=
out=
while [ "$#" -gt 0 ]; do case "$1" in --cd) fixture="$2"; shift 2 ;; -o) out="$2"; shift 2 ;; *) shift ;; esac; done
case "$fixture" in /*/fixture) ;; *) echo "missing absolute --cd fixture" >&2; exit 99 ;; esac
python3 -c 'import os,sys,time; os.setsid(); open(sys.argv[2], "w").write(str(os.getpid())); time.sleep(0.35); runroot=os.path.dirname(sys.argv[1]); [open(path, "w").write("forged") for path in [os.path.join(runroot, "verification-fixture", "src", "counter.mjs"), os.path.join(runroot, "src", "counter.mjs")] if os.path.isdir(os.path.dirname(path))]; open(os.path.join(sys.argv[1], "late.txt"), "w").write("late\\n")' "$fixture" "$(dirname "$fixture")/late.pid" >/dev/null 2>&1 &
printf '%s\\n' 'export function increment(value) {' '  if (import.meta.url.includes("/fixture/src/")) return value + 1;' '  return value;' '}' > "$fixture/src/counter.mjs"
printf '%s\\n' 'quiet snapshot complete' > "$out"
`);
  await chmod(fake, 0o755);
  const overlays = await materializeInstructionOverlays(join(import.meta.dir, "../.."), join(root, "frozen"));
  let pidPath: string | undefined;
  try {
    const capture = await executeRun({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, caseId: "bounded-fix", condition: "baseline", repetition: 1, overlays, codexBinary: fake, deadlineMs: 1_000, killGraceMs: 25 });
    pidPath = join(capture.run.fixtureRoot, "../late.pid");
    await Bun.sleep(600);
    expect(capture.verifier.passed).toBe(true); expect(capture.verifier.changedPaths).not.toContain("oracle-verify.mjs");
    expect(capture.run.snapshotStable).toBe(true);
    expect(await readFile(join(capture.run.fixtureRoot, "late.txt"), "utf8")).toBe("late\n");
    expect(await readFile(capture.diffPath, "utf8")).not.toContain("late.txt");
    await expect(readFile(join(capture.run.fixtureRoot, "../verification-fixture"))).rejects.toThrow();
  } finally {
    try { if (pidPath) process.kill(Number(await readFile(pidPath, "utf8")), "SIGKILL"); } catch { /* child cleanup is best effort */ }
  }
});
