import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateCache, privateArtifactPath, privateCachePath, removePrivateCache } from "./cache";
import { projectCaptureEvidence } from "./evidence";
import type { CaptureResult } from "./types";

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path)) {
      const full = join(path, entry);
      if ((await stat(full)).isDirectory()) await visit(full);
      else result.push(full);
    }
  }
  await visit(root);
  return result;
}

function captureForSentinel(cacheRoot: string, sentinel: string): CaptureResult {
  return {
    schemaVersion: "prompt-governance-capture-v2",
    run: {
      schemaVersion: "prompt-governance-run-v2",
      runId: "opaque",
      caseId: "bounded-fix",
      condition: "candidate",
      repetition: 1,
      fixtureRoot: join(cacheRoot, "fixture"),
      artifactRoot: join(cacheRoot, "run"),
      overlays: [],
      fileAllowlist: [],
      expectedNoWrite: false,
      codexVersion: "fixture",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      command: [sentinel],
      measurementScope: {
        schemaVersion: "prompt-governance-measurement-scope-v1",
        authMode: "caller-managed-CODEX_HOME",
        userConfigLoaded: true,
        userProjectRulesIgnored: true,
        taskScope: "root-instruction-only",
        subagents: "disabled-not-observed",
        fixedFlags: [],
        configControls: [],
        codexHomePresent: false,
        homePresent: false,
        tmpdirPresent: false,
        codexBinary: "opaque",
        codexVersion: "fixture",
        ambientManagedPolicy: "unknown",
      },
      baselineHead: "head",
      fixtureBaselineTreeHash: "tree",
      oracleVerifierHash: "oracle",
      headMoved: false,
      outputTruncated: false,
      timedOut: false,
      drainTimedOut: false,
      stdoutBytes: 4,
      stderrBytes: 4,
      stdoutStoredBytes: 4,
      stderrStoredBytes: 4,
      finalAnswerBytes: 4,
      finalAnswerStoredBytes: 4,
      finalAnswerTruncated: false,
      diffBytes: 4,
      diffStoredBytes: 4,
      diffTruncated: false,
      authorityViolations: [],
      infrastructureFailure: false,
      verificationSkipped: false,
      snapshotSourcePreHash: "",
      snapshotSourcePostHash: "",
      snapshotCopyHash: "",
      snapshotVerificationPostHash: "",
      snapshotStable: true,
      processGroupTeardown: "best-effort",
      deadlineMs: 1,
      killGraceMs: 1,
      environmentKeys: [],
      networkPolicy: "fixture",
      approvalPolicy: "fixture",
      startedAt: "now",
      finishedAt: "now",
      exitCode: 0,
    },
    commandText: sentinel,
    codexVersion: "fixture",
    startedAt: "now",
    finishedAt: "now",
    exitCode: 0,
    taskPrompt: sentinel,
    finalAnswer: sentinel,
    rawEventsPath: join(cacheRoot, "events"),
    finalAnswerPath: join(cacheRoot, "final"),
    diffPath: join(cacheRoot, "diff"),
    verifierPath: join(cacheRoot, "verifier"),
    fileAllowlist: [],
    verifier: {
      passed: true,
      exitCode: 0,
      stdout: sentinel,
      stderr: sentinel,
      changedPaths: [sentinel],
      unsafePaths: [sentinel],
      expectedNoWrite: false,
      baselineTreeHash: "tree",
      finalTreeHash: "tree",
      baselineHead: "head",
      finalHead: "head",
      headMoved: false,
      oracleVerifierHash: "oracle",
    },
    observedJsonlSchema: {
      schemaVersion: "observed-jsonl-v1",
      lineCount: 1,
      validJsonLines: 1,
      invalidJsonLines: 0,
      eventTypes: [sentinel],
      topLevelKeys: [],
      payloadKeys: [],
      observedPaths: [],
      eventPathPairs: [],
      schemaFingerprint: "schema",
    },
    secondaryMetrics: {
      toolLoops: 1,
      tokens: 1,
      subagents: "unavailable",
      rework: "unavailable",
      unnecessaryClarification: "unavailable",
    },
    observedMetricPaths: { tokens: [sentinel], subagents: [], rework: [], toolLoops: [], unnecessaryClarification: [] },
    outputTruncated: false,
    timedOut: false,
    drainTimedOut: false,
    stdoutBytes: 4,
    stderrBytes: 4,
    stdoutStoredBytes: 4,
    stderrStoredBytes: 4,
    finalAnswerBytes: 4,
    finalAnswerStoredBytes: 4,
    finalAnswerTruncated: false,
    diffBytes: 4,
    diffStoredBytes: 4,
    diffTruncated: false,
    authorityViolations: [],
    infrastructureFailure: false,
    verificationSkipped: false,
    snapshotStable: true,
  };
}

test("public projections exclude mutable pilot material and private caches are disposable", async () => {
  const root = join(tmpdir(), `skizzles-public-projection-${randomUUID()}`);
  const created = await createPrivateCache(); const cache = created.handle; const cacheRoot = privateCachePath(created.locator.id);
  const sentinel = `UNIQUE_MODEL_SENTINEL_${randomUUID()}`;
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "pilot-result.json"), JSON.stringify(projectCaptureEvidence(captureForSentinel(cacheRoot, sentinel))));
    for (const name of ["source-${sentinel}.mjs", "final.md", "stdout.log", "stderr.log", "verifier.json", "review-rationale.json"]) await writeFile(privateArtifactPath(cache, name), sentinel);
    for (const path of await files(root)) expect(await readFile(path, "utf8")).not.toContain(sentinel);
    expect(cacheRoot.startsWith(`${root}/`)).toBe(false);
  } finally {
    await removePrivateCache(cache);
  }
  await expect(stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
