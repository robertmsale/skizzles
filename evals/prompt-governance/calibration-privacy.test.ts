import { expect, setDefaultTimeout, test } from "bun:test";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCalibration } from "./runner";

setDefaultTimeout(30_000);

interface PublicFile { readonly path: string; readonly relativePath: string; readonly mode: number }

async function publicFiles(root: string): Promise<PublicFile[]> {
  const files: PublicFile[] = [];
  async function visit(path: string, relativeRoot: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name); const relativePath = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(full, relativePath);
      else { const metadata = await lstat(full); files.push({ path: full, relativePath, mode: metadata.mode & 0o777 }); }
    }
  }
  await visit(root, "");
  return files;
}

async function cacheNames(): Promise<Set<string>> {
  return new Set((await readdir(tmpdir(), { withFileTypes: true })).filter((entry) => entry.name.startsWith("skizzles-prompt-governance-")).map((entry) => entry.name));
}

test("successful calibration keeps final, stdout, and stderr private", async () => {
  const root = await mkdtemp(join(tmpdir(), `skizzles-calibration-privacy-${randomUUID()}-`));
  const fake = join(tmpdir(), `skizzles-calibration-privacy-fake-${randomUUID()}.sh`);
  const stdoutSentinel = `calibration_stdout_${randomUUID()}`;
  const stderrSentinel = `calibration_stderr_${randomUUID()}`;
  const beforeCaches = await cacheNames();
  await writeFile(fake, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.146.0-alpha.14'; exit 0; fi
probe=/tmp/probe; out=/tmp/final.md
while [ "$#" -gt 0 ]; do case "$1" in -c) case "$2" in model_instructions_file=*) probe="\${2#model_instructions_file=}"; probe="\${probe#\\\"}"; probe="\${probe%\\\"}";; esac; shift 2;; -o) out=$2; shift 2;; *) shift;; esac; done
nonce=$(grep -o 'CALIBRATION_[A-Z0-9]*' "$probe" | tail -1)
printf '%s\\n' "$nonce" > "$out"
printf '%s\\n' '{"type":"turn.completed","payload":{"calibration_stdout":"${stdoutSentinel}"}}'
printf '%s\\n' '${stderrSentinel}' >&2
exit 0
`);
  await chmod(fake, 0o755);
  try {
    const calibrationPath = await runCalibration(join(import.meta.dir, "../.."), root, fake);
    const calibration = JSON.parse(await readFile(calibrationPath, "utf8")) as { passed: boolean };
    expect(calibration.passed).toBe(true);
    expect((await lstat(join(root, "calibration"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "calibration", "inputs"))).mode & 0o777).toBe(0o700);
    const files = await publicFiles(root);
    const names = files.map((file) => file.relativePath);
    for (const name of names) expect(name === "calibration/calibration.json" || name.startsWith("calibration/inputs/")).toBe(true);
    expect(names).not.toContain("calibration/final.md");
    expect(names).not.toContain("calibration/stderr.log");
    expect(names.some((name) => /(?:events|raw-stderr|supervised-|fixture\.diff)/.test(name))).toBe(false);
    for (const file of files) {
      expect(file.mode).toBe(0o600);
      expect(file.relativePath).not.toContain(stdoutSentinel);
      expect(file.relativePath).not.toContain(stderrSentinel);
      const body = await readFile(file.path, "utf8");
      expect(body).not.toContain(stdoutSentinel);
      expect(body).not.toContain(stderrSentinel);
    }
    const afterCaches = await cacheNames();
    expect([...afterCaches].filter((name) => !beforeCaches.has(name))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(fake, { force: true });
  }
});
