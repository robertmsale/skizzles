import { expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRun } from "./capture";
import { materializeInstructionOverlays } from "./overlays";
import { runCalibration, runPilot, reviewPilot } from "./runner";
import { createPrivateCache, openPrivateCache, privateArtifactPath, privateCachePath, removePrivateCache } from "./cache";
import { closedRationaleCode } from "./scoring";
import { driftDimensions } from "./types";
import { metricSelectionCommitment, SELECTOR_REGISTRY_ID } from "./metric-profile";

setDefaultTimeout(30_000);

async function allFiles(root: string): Promise<Array<{ path: string; relativePath: string }>> {
  const result: Array<{ path: string; relativePath: string }> = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path)) {
      const full = join(path, entry);
      if ((await stat(full)).isDirectory()) await visit(full);
      else result.push({ path: full, relativePath: full.slice(root.length + 1) });
    }
  }
  await visit(root);
  return result;
}

async function expectPrivateSentinel(path: string, sentinel: string): Promise<void> {
  expect(await readFile(path, "utf8")).toContain(sentinel);
}

function fakeCodex(sentinels: readonly string[], unsafe = false): string {
  const [source, unsafeName, unsafeBody, final, stdout, stderr, verifier, diff, events] = sentinels;
  const unsafeBlock = unsafe ? `if [ -f "$fixture/src/counter.mjs" ]; then printf '%s\\n' '${unsafeBody} ${diff}' > "$fixture/untracked-${unsafeName}"; fi` : "";
  return [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then printf '%s\\n' 'codex-cli 0.146.0-alpha.14'; exit 0; fi",
    "out=/tmp/final.md; fixture=/tmp/fixture; instructions=",
    'while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; --cd) fixture="$2"; shift 2;; -c) case "$2" in model_instructions_file=*) instructions="${2#model_instructions_file=}"; instructions="${instructions#\\"}"; instructions="${instructions%\\"}";; esac; shift 2;; *) shift;; esac; done',
    "prompt=$(cat)",
    `if printf '%s' "$prompt" | grep -qi 'calibration phrase'; then printf '%s\\n' "$(grep -o 'CALIBRATION_[A-Z0-9]*' "$instructions" | tail -1)" > "$out";`,
    `elif [ -f "$fixture/src/counter.mjs" ]; then printf '%s\\n' 'export function increment(value) {' '  return value + 1;' '}' '// ${source} ${verifier} ${diff}' > "$fixture/src/counter.mjs";`,
    `elif [ -f "$fixture/src/parse.mjs" ]; then printf '%s\\n' 'export function parseName(value) {' '  return value.trim();' '}' '' 'export function unsafeOptions(options) {' '  return options;' '}' '// ${source} ${verifier} ${diff}' > "$fixture/src/parse.mjs";`,
    `elif [ -f "$fixture/src/account.mjs" ]; then printf '%s\\n' 'Should deletion be hard or soft, what retention applies, and who provides authorization?' > "$out";`,
    `else printf '%s\\n' 'The timeout lasted 30s and retry scheduled evidence identifies the cause; the next investigation should reproduce it.' > "$out"; fi`,
    unsafeBlock,
    `if ! printf '%s' "$prompt" | grep -qi 'calibration phrase'; then printf '%s\\n' '${final}' >> "$out"; fi`,
    `printf '%s\\n' '{"type":"fixture.done","payload":{"ok":true}}'`,
    `printf '%s\\n' '{"type":"e2e.${stdout}","payload":{"${events}":true}}'`,
    `printf '%s\\n' '${stderr}' >&2`,
  ].join("\n");
}

test("fake campaign keeps mutable sentinels private through review", async () => {
  const root = join(tmpdir(), `skizzles-e2e-privacy-${randomUUID()}`);
  const fake = join(tmpdir(), `skizzles-e2e-fake-${randomUUID()}.sh`);
  const sentinels = ["source", "untracked-name", "untracked-body", "final", "stdout", "stderr", "verifier", "diff", "events", "rationale"].map((label) => `e2e_${label}_${randomUUID()}`);
  await Bun.write(fake, fakeCodex(sentinels));
  await chmod(fake, 0o755);
  try {
    await runCalibration(join(import.meta.dir, "../.."), root, fake);
    const calibration = JSON.parse(await readFile(join(root, "calibration", "calibration.json"), "utf8")) as { codexVersion: string; schemaFingerprint: string };
    const profile = JSON.stringify({ schemaVersion: "prompt-governance-metric-selection-v3", registryId: SELECTOR_REGISTRY_ID, schemaFingerprint: calibration.schemaFingerprint, selectorCommitmentHash: metricSelectionCommitment(["tokens"], { tokens: "fixture-done-payload-ok" }), enabledMetrics: ["tokens"], selectorIds: { tokens: "fixture-done-payload-ok" } });
    await writeFile(join(root, "metric-profile.json"), profile);
    await runPilot({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, execute: false, repetitions: 3, codexBinary: fake });
    await runPilot({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, execute: true, repetitions: 3, confirmRuns: 24, codexBinary: fake });
    const plan = JSON.parse(await readFile(join(root, "pilot-plan.json"), "utf8")) as { cacheLocator: unknown };
    const cache = await openPrivateCache(plan.cacheLocator);
    const capturesPath = privateArtifactPath(cache, "captures.json");
    const captures = JSON.parse(await readFile(capturesPath, "utf8")) as Array<{ run: { runId: string; caseId: string; condition: string; fixtureRoot: string }; secondaryMetrics: Record<string, number | string> }>;
    for (const capture of captures) if (capture.run.condition === "candidate") capture.secondaryMetrics.tokens = 0;
    await writeFile(capturesPath, JSON.stringify(captures));
    const mapping = JSON.parse(await readFile(join(root, "private", "schedule-mapping.json"), "utf8")) as Array<{ blindId: string }>;
    await mkdir(privateArtifactPath(cache, "reviewer", "scores"), { recursive: true });
    for (const entry of mapping) for (const reviewerId of ["reviewer-a", "reviewer-b"]) await writeFile(privateArtifactPath(cache, "reviewer", "scores", `${entry.blindId}-${reviewerId}.json`), JSON.stringify({ schemaVersion: "prompt-governance-blind-score-v1", blindId: entry.blindId, reviewerId, scores: Object.fromEntries(driftDimensions.map((dimension) => [dimension, 0])), rationale: Object.fromEntries(driftDimensions.map((dimension) => [dimension, closedRationaleCode(0)])) }));
    const bounded = captures.find((capture) => capture.run.caseId === "bounded-fix" && capture.run.condition === "candidate");
    if (!bounded) throw new Error("missing named bounded-fix capture");
    const run = (part: string) => privateArtifactPath(cache, "runs", bounded.run.runId, part);
    await expectPrivateSentinel(run("fixture/src/counter.mjs"), sentinels[0]!);
    await expectPrivateSentinel(run("final.md"), sentinels[3]!);
    await expectPrivateSentinel(run("events.jsonl"), sentinels[4]!);
    await expectPrivateSentinel(run("events.jsonl"), sentinels[8]!);
    await expectPrivateSentinel(run("raw-stderr.bin"), sentinels[5]!);
    await expectPrivateSentinel(run("verifier.json"), sentinels[6]!);
    await expectPrivateSentinel(run("fixture.diff"), sentinels[7]!);
    for (const file of await allFiles(root)) for (const sentinel of sentinels) { expect(file.relativePath).not.toContain(sentinel); expect(await readFile(file.path, "utf8")).not.toContain(sentinel); }
    expect((await stat(privateCachePath(cache.locator.id))).isDirectory()).toBe(true);
    await reviewPilot(root);
    for (const file of await allFiles(root)) for (const sentinel of sentinels) { expect(file.relativePath).not.toContain(sentinel); expect(await readFile(file.path, "utf8")).not.toContain(sentinel); }
    await expect(stat(privateCachePath(cache.locator.id))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    try { const plan = JSON.parse(await readFile(join(root, "pilot-plan.json"), "utf8")) as { cacheLocator: unknown }; await removePrivateCache(await openPrivateCache(plan.cacheLocator)); } catch { /* review or setup may already clean it */ }
    await Bun.$`rm -rf ${root}`;
    await Bun.$`rm -f ${fake}`;
  }
});

test("unsafe fake producers stay private through verifier and diff capture", async () => {
  const root = await mkdtemp(join(tmpdir(), `skizzles-e2e-unsafe-${randomUUID()}`));
  const fake = join(tmpdir(), `skizzles-e2e-unsafe-fake-${randomUUID()}.sh`);
  const sentinels = ["source", "untracked-name", "untracked-body", "final", "stdout", "stderr", "verifier", "diff", "events", "rationale"].map((label) => `e2e_${label}_${randomUUID()}`);
  const created = await createPrivateCache(); const cache = created.handle;
  await Bun.write(fake, fakeCodex(sentinels, true)); await chmod(fake, 0o755);
  try {
    const overlays = await materializeInstructionOverlays(join(import.meta.dir, "../.."), join(root, "frozen"));
    const capture = await executeRun({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, cache, caseId: "bounded-fix", condition: "baseline", repetition: 1, overlays, codexBinary: fake, deadlineMs: 1_000, killGraceMs: 25 });
    expect(capture.verifier.unsafePaths).toContain(`untracked-${sentinels[1]}`);
    const untrackedPath = privateArtifactPath(cache, "runs", capture.run.runId, `fixture/untracked-${sentinels[1]}`);
    const diffPath = privateArtifactPath(cache, "runs", capture.run.runId, "fixture.diff");
    await expectPrivateSentinel(untrackedPath, sentinels[2]!);
    await expectPrivateSentinel(diffPath, sentinels[2]!);
    await expectPrivateSentinel(diffPath, sentinels[7]!);
    for (const file of await allFiles(root)) for (const sentinel of sentinels) { expect(file.relativePath).not.toContain(sentinel); expect(await readFile(file.path, "utf8")).not.toContain(sentinel); }
  } finally { await removePrivateCache(cache); await rm(root, { recursive: true, force: true }); await rm(fake, { force: true }); }
});

test("review failure removes the committed private cache", async () => {
  const root = join(tmpdir(), `skizzles-e2e-review-failure-${randomUUID()}`);
  const fake = join(tmpdir(), `skizzles-e2e-review-failure-fake-${randomUUID()}.sh`);
  const sentinels = ["source", "untracked-name", "untracked-body", "final", "stdout", "stderr", "verifier", "diff", "events", "rationale"].map((label) => `e2e_${label}_${randomUUID()}`);
  await Bun.write(fake, fakeCodex(sentinels));
  await chmod(fake, 0o755);
  try {
    await runCalibration(join(import.meta.dir, "../.."), root, fake);
    const calibration = JSON.parse(await readFile(join(root, "calibration", "calibration.json"), "utf8")) as { codexVersion: string; schemaFingerprint: string };
    await writeFile(join(root, "metric-profile.json"), JSON.stringify({ schemaVersion: "prompt-governance-metric-selection-v3", registryId: SELECTOR_REGISTRY_ID, schemaFingerprint: calibration.schemaFingerprint, selectorCommitmentHash: metricSelectionCommitment(["tokens"], { tokens: "fixture-done-payload-ok" }), enabledMetrics: ["tokens"], selectorIds: { tokens: "fixture-done-payload-ok" } }));
    await runPilot({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, execute: false, repetitions: 3, codexBinary: fake });
    await runPilot({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, execute: true, repetitions: 3, confirmRuns: 24, codexBinary: fake });
    const plan = JSON.parse(await readFile(join(root, "pilot-plan.json"), "utf8")) as { cacheLocator: unknown };
    const cache = await openPrivateCache(plan.cacheLocator);
    const mapping = JSON.parse(await readFile(join(root, "private", "schedule-mapping.json"), "utf8")) as Array<{ blindId: string }>;
    await mkdir(privateArtifactPath(cache, "reviewer", "scores"), { recursive: true });
    const rationale = Object.fromEntries(driftDimensions.map((dimension, index) => [dimension, index === 0 ? `https://unsafe.invalid/${sentinels[9]}` : closedRationaleCode(0)]));
    for (const entry of mapping) for (const reviewerId of ["reviewer-a", "reviewer-b"]) await writeFile(privateArtifactPath(cache, "reviewer", "scores", `${entry.blindId}-${reviewerId}.json`), JSON.stringify({ schemaVersion: "prompt-governance-blind-score-v1", blindId: entry.blindId, reviewerId, scores: Object.fromEntries(driftDimensions.map((dimension) => [dimension, 0])), rationale }));
    await expect(reviewPilot(root)).rejects.toThrow("rationale code");
    await expect(stat(privateCachePath(cache.locator.id))).rejects.toMatchObject({ code: "ENOENT" });
    for (const file of await allFiles(root)) for (const sentinel of sentinels) { expect(file.relativePath).not.toContain(sentinel); expect(await readFile(file.path, "utf8")).not.toContain(sentinel); }
  } finally {
    await Bun.$`rm -rf ${root}`;
    await Bun.$`rm -f ${fake}`;
  }
});
