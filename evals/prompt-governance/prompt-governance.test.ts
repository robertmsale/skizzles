import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlindReviewBundle } from "./blind";
import { buildEvaluationEnvironment, buildMeasurementScope, executeRun, failureCategory, spawnCodexForCalibration } from "./capture";
import { assertSafeCodexCommand, buildCodexCommand, unsupportedApprovalPlacements } from "./command";
import { getPilotCase, listPilotCases } from "./cases";
import { canonicalFixtureSnapshotHash, createFixture, resetFixture } from "./fixture";
import { classifyAuthoritySignals, inspectJsonlSchema, parseObservedMetrics } from "./events";
import { changedPaths, diff, git } from "./git";
import { materializeInstructionOverlays } from "./overlays";
import { redactSensitiveText, resolveRealPath, sha256 } from "./fs";
import { closedRationaleCode, evaluateDriftGate, validateBlindScore } from "./scoring";
import { reproducibleSecondaryImprovement, runCalibration, schedule, runPilot, validateBlindBundles, validateExportedBlindBundles, validateMetricProfile, validatePrivateReviewArtifacts } from "./runner"; import { createPrivateCache, openPrivateCache, privateCachePath, removePrivateCache } from "./cache"; import { selectorCommitment } from "./evidence";
import { verifyRun } from "./verifier";
import { metricSelectionCommitment, metricSelectorCommitments, SELECTOR_REGISTRY_ID } from "./metric-profile";
import type { BlindScore, CalibrationRecord, CaptureResult } from "./types";
const roots: string[] = []; setDefaultTimeout(30_000);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function tempRoot(prefix: string): Promise<string> { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root; } async function tempCache() { const created = await createPrivateCache(); roots.push(privateCachePath(created.locator.id)); return created.handle; }
const ambientSentinelParts = ["/Users/alice/.codex/config.toml", "https://provider.private/v1", "corp-hook", "private-mcp", "PRIVATE_MODE=ambient-env-value", "sk-live-secret"]; function expectNoAmbientArtifacts(text: string): void { for (const part of ambientSentinelParts) expect(text).not.toContain(part); }
test("materializes frozen overlays with full hashes and opaque paths", async () => {
  const root = await tempRoot("skizzles-prompt-eval-overlay-");
  const pair = await materializeInstructionOverlays(join(import.meta.dir, "../.."), root);
  expect(pair.baseline.sourceRevision).toHaveLength(40);
  expect(pair.candidate.sourceRevision).toContain("+working-tree");
  expect(pair.baseline.sha256).toBe(sha256(await readFile(pair.baseline.materializedPath)));
  expect(pair.candidate.sha256).toBe(sha256(await readFile(pair.candidate.materializedPath)));
  expect(pair.baseline.materializedPath).not.toContain("baseline");
  expect(pair.candidate.materializedPath).not.toContain("candidate");
  expect(pair.baseline.overlayId).not.toBe(pair.candidate.overlayId);
});
test("fixtures are fresh, resettable, and leave the product tree untouched", async () => {
  const root = await tempRoot("skizzles-prompt-eval-fixture-");
  const fixture = await createFixture("bounded-fix", join(root, "fixture"));
  await expect(createFixture("bounded-fix", fixture.root)).rejects.toThrow();
  await writeFile(join(fixture.root, "src/counter.mjs"), "export function increment(value) { return value + 1; }\n");
  await resetFixture(fixture);
  expect(changedPaths(fixture.root)).toEqual([]);
  expect(await readFile(join(fixture.root, "src/counter.mjs"), "utf8")).toContain("return value;\n");
  expect(await readFile(join(import.meta.dir, "../../assets/skizzles_instructions.md"), "utf8")).toContain("You are Codex");
});
test("immutable baseline catches committed forbidden files and moved HEAD", async () => {
  const root = await tempRoot("skizzles-prompt-eval-immutable-");
  const fixture = await createFixture("bounded-fix", join(root, "fixture"));
  const oracle = join(root, "oracle-verify.mjs");
  await writeFile(oracle, fixture.pilotCase.fixtureFiles["verify.mjs"]!);
  await writeFile(join(fixture.root, "src/counter.mjs"), "export function increment(value) { return value + 1; }\n");
  await writeFile(join(fixture.root, "notes.md"), "forbidden\n");
  git(fixture.root, ["add", "."]);
  git(fixture.root, ["commit", "-qm", "model checkpoint"]);
  const result = await verifyRun(fixture.root, fixture.pilotCase, join(root, "missing-final.md"), fixture.baselineSnapshot, fixture.baselineTreeHash, fixture.baselineCommit, oracle);
  expect(result.changedPaths).toEqual(["notes.md", "src/counter.mjs"]);
  expect(result.unsafePaths).toEqual(["notes.md"]);
  expect(result.headMoved).toBe(true);
  expect(result.passed).toBe(false);
  expect(result.oracleVerifierHash).toBe(sha256(await readFile(oracle)));
});
test("Codex command pins the verified isolation profile and rejects bypass flags", async () => {
  const command = buildCodexCommand({ fixtureRoot: "/tmp/fixture", instructionFile: "/tmp/instructions.md", finalMessagePath: "/tmp/final.md" });
  expect(command.slice(1, 4)).toEqual(["--ask-for-approval", "never", "exec"]);
  expect(unsupportedApprovalPlacements).toEqual(["codex exec --ask-for-approval never"]);
  for (const required of ["--strict-config", "--ephemeral", "--ignore-rules", "--json", "workspace-write", "--cd", "-o"]) expect(command).toContain(required);
  for (const config of [
    'model_instructions_file="/tmp/instructions.md"',
    "agents.enabled=false",
    "features.apps=false",
    "features.hooks=false",
    "features.plugins=false",
    "sandbox_workspace_write.network_access=false",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    'web_search="disabled"',
    'shell_environment_policy.inherit="none"',
    'shell_environment_policy.set={HOME="/tmp/fixture"}',
    'shell_environment_policy.include_only=["PATH","TMPDIR"]',
  ]) expect(command).toContain(config);
  expect(command).not.toContain("--ignore-user-config"); expect(() => assertSafeCodexCommand([...command, "--ignore-user-config"])).toThrow("canonical"); expect(() => assertSafeCodexCommand(["codex", "exec", "--ask-for-approval", "never", ...command.slice(4)])).toThrow("top-level --ask-for-approval");
  const scope = JSON.stringify(buildMeasurementScope(command, "fixture", {})); for (const target of ["--ask-for-approval", "never", "exec", "--strict-config", "--ephemeral", "--ignore-rules", "--json", "--sandbox", "workspace-write", "-m", "gpt-5.6-sol", "agents.enabled=false", "features.apps=false", "features.hooks=false", "features.plugins=false", "sandbox_workspace_write.network_access=false", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "sandbox_workspace_write.exclude_slash_tmp=true", 'web_search="disabled"', 'shell_environment_policy.inherit="none"', 'shell_environment_policy.include_only=["PATH","TMPDIR"]']) { const changed = command.map((argument) => argument === target ? `${argument}-changed` : argument); expect(JSON.stringify(buildMeasurementScope(changed, "fixture", {}))).not.toBe(scope); }
  expect(() => assertSafeCodexCommand([...command, "--dangerously-bypass-hook-trust"])).toThrow("dangerous Codex flag");
  const setConfig = command.find((argument) => argument.startsWith("shell_environment_policy.set="))!; const withExtra = command.map((argument) => argument === setConfig ? `${setConfig.slice(0, -1)},CODEX_HOME=\"/ambient/auth\"}` : argument); const withWrongHome = command.map((argument) => argument === setConfig ? setConfig.replace("/tmp/fixture", "/tmp/wrong") : argument); const withWhitespaceExtra = [...command, 'shell_environment_policy.set = {HOME="/tmp/fixture",CODEX_HOME="/ambient/auth"}']; const withDottedExtra = [...command, 'shell_environment_policy.set.CODEX_HOME="/ambient/auth"']; const withQuotedExtra = [...command, '"shell_environment_policy"."set".CODEX_HOME="/ambient/auth"'];
  expect(() => assertSafeCodexCommand(command.filter((argument) => argument !== setConfig))).toThrow("canonical"); expect(() => assertSafeCodexCommand(withExtra)).toThrow("canonical"); expect(() => assertSafeCodexCommand(withWrongHome)).toThrow("canonical"); expect(() => assertSafeCodexCommand(withWhitespaceExtra)).toThrow("canonical"); expect(() => assertSafeCodexCommand(withDottedExtra)).toThrow("canonical"); expect(() => assertSafeCodexCommand(withQuotedExtra)).toThrow("canonical");
  const home = await tempRoot("skizzles-prompt-eval-auth-home-"); await mkdir(join(home, ".codex"));
  expect(buildEvaluationEnvironment({ CODEX_HOME: "/auth/codex", HOME: "/host", PATH: "/bin", TMPDIR: "/tmp" })).toMatchObject({ CODEX_HOME: "/auth/codex", HOME: "/host" }); expect(buildEvaluationEnvironment({ HOME: home, PATH: "/bin", TMPDIR: "/tmp" })).toMatchObject({ CODEX_HOME: join(home, ".codex"), HOME: home }); expect(buildEvaluationEnvironment({ HOME: join(home, "missing"), PATH: "/bin", TMPDIR: "/tmp" })).not.toHaveProperty("CODEX_HOME");
});
test("installed Codex accepts the approval policy only before exec", () => {
  const codex = Bun.which("codex");
  if (!codex) return;
  const supported = Bun.spawnSync([codex, "--ask-for-approval", "never", "exec", "--help"], { stdout: "pipe", stderr: "pipe" });
  expect(supported.exitCode).toBe(0);
  const unsupported = Bun.spawnSync([codex, "exec", "--ask-for-approval", "never", "--help"], { stdout: "pipe", stderr: "pipe" });
  expect(unsupported.exitCode).toBe(2);
});
test("JSONL calibration fingerprints real usage and leaves unsupported metrics unavailable", () => {
  const raw = [
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 6 } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }),
    "not json",
  ].join("\n");
  const schema = inspectJsonlSchema(raw);
  const profile = {
    schemaVersion: "prompt-governance-metric-selection-v3",
    registryId: SELECTOR_REGISTRY_ID,
    schemaFingerprint: schema.schemaFingerprint,
    selectorCommitmentHash: metricSelectionCommitment(["tokens"], { tokens: "turn-completed-token-usage" }),
    enabledMetrics: ["tokens"],
    selectorIds: { tokens: "turn-completed-token-usage" },
  } as const;
  expect(schema.schemaFingerprint).toHaveLength(64);
  expect(parseObservedMetrics(raw, profile)).toMatchObject({ tokens: 22, subagents: "unavailable" });
  expect(Object.keys(schema)).not.toContain("rework"); for (const usage of [{ input_tokens: -1, output_tokens: 2 }, { input_tokens: 1.5, output_tokens: 2 }, { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }]) expect(parseObservedMetrics(JSON.stringify({ type: "turn.completed", usage }), profile).tokens).toBe("unavailable");
});
test("metric profile preflight rejects missing or unobserved selectors", () => {
  const raw = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 5 } });
  const schema = inspectJsonlSchema(raw);
  const calibration = { codexVersion: "fixture", schemaFingerprint: schema.schemaFingerprint, observedJsonlSchema: schema, selectorCommitment: selectorCommitment(schema) } as unknown as CalibrationRecord;
  const valid = { schemaVersion: "prompt-governance-metric-selection-v3", registryId: SELECTOR_REGISTRY_ID, schemaFingerprint: schema.schemaFingerprint, selectorCommitmentHash: metricSelectionCommitment(["tokens"], { tokens: "turn-completed-token-usage" }), enabledMetrics: ["tokens"], selectorIds: { tokens: "turn-completed-token-usage" } };
  expect(() => validateMetricProfile({ ...valid, enabledMetrics: [] } as never, calibration)).toThrow("enabled metrics"); expect(() => validateMetricProfile({ ...valid, legacy: "sentinel" } as never, calibration)).toThrow("unsupported properties"); expect(() => validateMetricProfile({ ...valid, selectorCommitmentHash: "0".repeat(64) } as never, calibration)).toThrow("commitment hash is invalid");
  const [firstCommitment] = metricSelectorCommitments("turn-completed-token-usage");
  expect(() => validateMetricProfile({ ...valid, selectorCommitmentHash: metricSelectionCommitment(["tokens"], { tokens: "turn-completed-token-usage" }) } as never, { ...calibration, selectorCommitment: [firstCommitment] } as never)).toThrow("absent from the reviewed calibration schema"); const relabeled = { ...valid, enabledMetrics: ["rework"], selectorIds: { rework: "turn-completed-token-usage" }, selectorCommitmentHash: metricSelectionCommitment(["rework"], { rework: "turn-completed-token-usage" }) }; expect(() => validateMetricProfile(relabeled as never, calibration)).toThrow("not reviewed for rework");
});
test("authority classifier fails closed on external, host, and credential attempts", () => {
  const signals = classifyAuthoritySignals(JSON.stringify({ type: "command.started", payload: { command: "curl https://example.invalid; cat /home/user/.ssh/id_rsa; read credential" } }));
  expect(signals).toEqual(["credential-access", "external-command", "host-read"]);
  expect(classifyAuthoritySignals(JSON.stringify({ type: "agent_message", payload: { text: "do not access credentials or run git push" } })).length).toBe(0);
  const redacted = redactSensitiveText('{"api_key":"sk-live-secret","password":"hunter2","headers":{"Authorization":"Bearer abc"}}');
  for (const secret of ["sk-live-secret", "hunter2", "Bearer abc"]) expect(redacted).not.toContain(secret);
  const variants = redactSensitiveText('OPENAI_API_KEY="sk-live-secret" GITHUB_TOKEN=gh-live auth_token=auth-live nested={"Authorization":"Bearer nested-live"}');
  for (const secret of ["sk-live-secret", "gh-live", "auth-live", "Bearer nested-live"]) expect(variants).not.toContain(secret);
  const telemetry = redactSensitiveText('{"input_tokens":123,"output_tokens":5,"total_tokens":240}'); const ambient = redactSensitiveText("~/.codex/config.toml PRIVATE_MODE=ambient-env-value"); expect(ambient).not.toContain("~/.codex/config.toml"); expect(ambient).not.toContain("PRIVATE_MODE=ambient-env-value");
  expect(telemetry).toContain('"input_tokens":123'); expect(telemetry).toContain('"total_tokens":240'); expect(redactSensitiveText("input_tokens=123 output_tokens=5 total_tokens=240")).toContain("input_tokens=123"); expect(redactSensitiveText('{"cached_input_tokens":3,"reasoning_output_tokens":4}')).toContain('"cached_input_tokens":3');
});
test("strong bounded oracle rejects a hard-coded two-value implementation", async () => {
  const root = await tempRoot("skizzles-prompt-eval-oracle-");
  const fixture = await createFixture("bounded-fix", join(root, "fixture"));
  const oracle = join(root, "oracle.mjs");
  await writeFile(oracle, fixture.pilotCase.fixtureFiles["verify.mjs"]!);
  const final = join(root, "final.md");
  await writeFile(final, "Implemented the fix.\n");
  await writeFile(join(fixture.root, "src/counter.mjs"), "export function increment(value) { if (value === 2) return 3; return value; }\n");
  const result = await verifyRun(fixture.root, fixture.pilotCase, final, fixture.baselineSnapshot, fixture.baselineTreeHash, fixture.baselineCommit, oracle);
  expect(result.passed).toBe(false);
});
test("capture uses an immutable oracle copy and records bounded runtime metadata", async () => {
  const root = await tempRoot("skizzles-prompt-eval-capture-");
  const overlays = await materializeInstructionOverlays(join(import.meta.dir, "../.."), join(root, "frozen"));
  const capture = await executeRun({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, cache: await tempCache(), caseId: "bounded-fix", condition: "candidate", repetition: 1, overlays, codexBinary: "true", deadlineMs: 100, killGraceMs: 25 });
  expect(capture.run.fixtureBaselineTreeHash).toHaveLength(64);
  expect(capture.run.oracleVerifierHash).toHaveLength(64);
  expect(capture.run.outputTruncated).toBe(false);
  expect(capture.run.artifactRoot).not.toContain("candidate");
  expect(capture.verifier.passed).toBe(false);
  expect(capture.secondaryMetrics.tokens).toBe("unavailable");
});
test("measurement scope disclosure is typed and omits sensitive values", () => {
  const command = buildCodexCommand({ fixtureRoot: "/tmp/fixture", instructionFile: "/tmp/overlay.md", finalMessagePath: "/tmp/final.md" }); const scope = buildMeasurementScope(command, "fixture", { CODEX_HOME: "/secret/config", HOME: "/secret/home", TMPDIR: "/secret/tmp" }); const serialized = JSON.stringify(scope);
  expect(scope.authMode).toBe("caller-managed-CODEX_HOME"); expect(scope.taskScope).toBe("root-instruction-only"); expect(scope.subagents).toBe("disabled-not-observed"); expect(scope.configControls).toContain("features.plugins=false"); expect(serialized).not.toContain("/secret"); expect(serialized).not.toContain("Bearer");
});
test("nonzero Codex exit is infrastructure failure even with a final answer", async () => {
  const root = await tempRoot("skizzles-prompt-eval-exit-");
  const fake = join(root, "fake-exit.sh");
  const sentinel = "/Users/alice/.codex/config.toml|https://provider.private/v1|corp-hook|private-mcp|PRIVATE_MODE=ambient-env-value|OPENAI_API_KEY=sk-live-secret";
  await writeFile(fake, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then printf '%s\\n' '${sentinel}' > "$2"; shift 2; else shift; fi; done\nprintf '%s\\n' '${sentinel}'\nprintf '%s\\n' '${sentinel}' >&2\nexit 1\n`);
  await chmod(fake, 0o755);
  const overlays = await materializeInstructionOverlays(join(import.meta.dir, "../.."), join(root, "frozen"));
  const capture = await executeRun({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, cache: await tempCache(), caseId: "bounded-fix", condition: "baseline", repetition: 1, overlays, codexBinary: fake, codexVersion: "fixture", deadlineMs: 1_000, killGraceMs: 25 });
  expect(capture.exitCode).toBe(1);
  expect(capture.infrastructureFailure).toBe(true);
  const durable = [capture.rawEventsPath, capture.finalAnswerPath, capture.diffPath, capture.verifierPath, join(capture.run.artifactRoot, "stderr.log"), join(capture.run.artifactRoot, "capture.json"), join(capture.run.artifactRoot, "run-manifest.json"), join(capture.run.artifactRoot, "supervised-stdout.bin"), join(capture.run.artifactRoot, "supervised-stderr.bin")];
  for (const path of durable) expectNoAmbientArtifacts(await readFile(path, "utf8"));
});
test("calibration failure artifacts retain only category status", async () => {
  const root = await tempRoot("skizzles-prompt-eval-calibration-failure-"); const fake = join(root, "fake-calibration.sh"); const sentinel = "/Users/alice/.codex/config.toml|https://provider.private/v1|corp-hook|private-mcp|PRIVATE_MODE=ambient-env-value|OPENAI_API_KEY=sk-live-secret";
  await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.146.0-alpha.14'; exit 0; fi\nprintf '%s\\n' '${sentinel}'\nprintf '%s\\n' '${sentinel}' >&2\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then printf '%s\\n' '${sentinel}' > "$2"; shift 2; else shift; fi; done\nexit 1\n`); await chmod(fake, 0o755);
  const calibration = await runCalibration(join(import.meta.dir, "../.."), root, fake); expectNoAmbientArtifacts(await readFile(calibration, "utf8"));
  await expect(readFile(join(root, "calibration", "stderr.log"))).rejects.toMatchObject({ code: "ENOENT" }); await expect(readFile(join(root, "calibration", "final.md"))).rejects.toMatchObject({ code: "ENOENT" });
});
test("passing task artifacts suppress ambient metadata while retaining the verifier and telemetry", async () => {
  const root = await tempRoot("skizzles-prompt-eval-success-"); const fake = join(root, "fake-success.sh"); const sentinel = ambientSentinelParts.join("|");
  await writeFile(fake, `#!/bin/sh\ncwd=/tmp; out=/tmp/final.md\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--cd" ]; then cwd=$2; shift 2; elif [ "$1" = "-o" ]; then out=$2; shift 2; else shift; fi; done\nprintf '%s\\n' 'export function increment(value) { return value + 1; }' > "$cwd/src/counter.mjs"\nprintf '%s\\n' 'Implemented. ${sentinel}' > "$out"\nprintf '%s\\n' '{"type":"turn.completed","payload":{"input_tokens":123,"agent_message":"private-agent-text","ambient":"${sentinel}"}}'\nprintf '%s\\n' '${sentinel}' >&2\nexit 0\n`); await chmod(fake, 0o755);
  const overlays = await materializeInstructionOverlays(join(import.meta.dir, "../.."), join(root, "frozen")); const capture = await executeRun({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, cache: await tempCache(), caseId: "bounded-fix", condition: "baseline", repetition: 1, overlays, codexBinary: fake, codexVersion: "fixture", deadlineMs: 1_000, killGraceMs: 25 });
  expect(capture.verifier.passed).toBe(true); for (const path of [capture.rawEventsPath, capture.finalAnswerPath, capture.diffPath, capture.verifierPath, join(capture.run.artifactRoot, "stderr.log"), join(capture.run.artifactRoot, "capture.json"), join(capture.run.artifactRoot, "run-manifest.json"), join(capture.run.artifactRoot, "supervised-stdout.bin"), join(capture.run.artifactRoot, "supervised-stderr.bin")]) expectNoAmbientArtifacts(await readFile(path, "utf8"));
  const persistedEvents = await readFile(capture.rawEventsPath, "utf8"); expect(persistedEvents).toContain('"input_tokens":123'); expect(persistedEvents).not.toContain("private-agent-text");
});
test("passing calibration artifacts suppress ambient metadata and retain raw-schema telemetry", async () => {
  const root = await tempRoot("skizzles-prompt-eval-calibration-success-"); const fake = join(root, "fake-calibration-success.sh"); const sentinel = ambientSentinelParts.join("|");
  await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.146.0-alpha.14'; exit 0; fi\nprobe=/tmp/probe; out=/tmp/final.md\nwhile [ "$#" -gt 0 ]; do case "$1" in -c) case "$2" in model_instructions_file=*) probe="\${2#model_instructions_file=}"; probe="\${probe#\\\"}"; probe="\${probe%\\\"}";; esac; shift 2;; -o) out=$2; shift 2;; *) shift;; esac; done\nnonce=$(grep -o 'CALIBRATION_[A-Z0-9]*' "$probe" | tail -1)\nprintf '%s\\n' "$nonce" > "$out"\nprintf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3},"payload":{"ambient":"${sentinel}"}}'\nprintf '%s\\n' '${sentinel}' >&2\nexit 0\n`); await chmod(fake, 0o755); const calibration = await runCalibration(join(import.meta.dir, "../.."), root, fake);
  expect((JSON.parse(await readFile(calibration, "utf8")) as CalibrationRecord).passed).toBe(true); expectNoAmbientArtifacts(await readFile(calibration, "utf8"));
  await expect(readFile(join(root, "calibration", "stderr.log"))).rejects.toMatchObject({ code: "ENOENT" }); await expect(readFile(join(root, "calibration", "final.md"))).rejects.toMatchObject({ code: "ENOENT" });
});
test("capture only persists a redacted final answer", async () => {
  const root = await tempRoot("skizzles-prompt-eval-final-redaction-");
  const fake = join(root, "fake-final.sh");
  await writeFile(fake, "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = \"-o\" ]; then printf '%s\\n' 'OPENAI_API_KEY=sk-live-secret Authorization: Bearer bearer-live' > \"$2\"; shift 2; else shift; fi; done\nprintf '%s\\n' 'OPENAI_API_KEY=sk-live-secret Authorization: Bearer bearer-live'\nprintf '%s\\n' '{\"type\":\"fixture.done\",\"payload\":{\"input_tokens\":123}}'\n");
  await chmod(fake, 0o755);
  const overlays = await materializeInstructionOverlays(join(import.meta.dir, "../.."), join(root, "frozen"));
  const capture = await executeRun({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, cache: await tempCache(), caseId: "bounded-fix", condition: "baseline", repetition: 1, overlays, codexBinary: fake, deadlineMs: 1_000, killGraceMs: 25 });
  const durableFinal = await readFile(capture.finalAnswerPath, "utf8");
  expect(capture.commandText).not.toContain(capture.finalAnswerPath);
  expect(durableFinal).not.toContain("sk-live-secret"); expect(durableFinal).not.toContain("bearer-live");
  expect(capture.finalAnswer).not.toContain("sk-live-secret");
  const supervised = await readFile(join(capture.run.artifactRoot, "supervised-stdout.bin"), "utf8"); expect(supervised).not.toContain("sk-live-secret"); expect(supervised).not.toContain("bearer-live");
});
test("ambiguity and diagnosis oracles reject incomplete answers", async () => {
  const root = await tempRoot("skizzles-prompt-eval-oracles-");
  const ambiguity = await createFixture("material-ambiguity", join(root, "ambiguity"));
  const diagnosis = await createFixture("read-only-diagnosis", join(root, "diagnosis"));
  const ambiguityFinal = join(root, "ambiguity.md");
  const diagnosisFinal = join(root, "diagnosis.md");
  await writeFile(ambiguityFinal, "Should we delete the account?\n");
  await writeFile(diagnosisFinal, "The request failed and should be investigated.\n");
  const ambiguityResult = await verifyRun(ambiguity.root, ambiguity.pilotCase, ambiguityFinal, ambiguity.baselineSnapshot, ambiguity.baselineTreeHash, ambiguity.baselineCommit, join(root, "missing-ambiguity.mjs"));
  const diagnosisResult = await verifyRun(diagnosis.root, diagnosis.pilotCase, diagnosisFinal, diagnosis.baselineSnapshot, diagnosis.baselineTreeHash, diagnosis.baselineCommit, join(root, "missing-diagnosis.mjs"));
  expect(ambiguityResult.passed).toBe(false);
  expect(diagnosisResult.passed).toBe(false);
});
test("schedule is opaque and alternates AB, BA, AB", () => {
  const entries = schedule(3);
  expect(entries).toHaveLength(24);
  for (const repetition of [1, 2, 3]) {
    const conditions = entries.filter((entry) => entry.repetition === repetition).map((entry) => entry.condition);
    expect(conditions.slice(0, 2)).toEqual(repetition === 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]);
  }
  expect(entries.every((entry) => !entry.runId.includes("baseline") && !entry.runId.includes("candidate"))).toBe(true);
});
test("paid pilot requires calibration and exact run confirmation", async () => {
  const root = await tempRoot("skizzles-prompt-eval-gate-");
  await expect(runPilot({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, execute: true, repetitions: 3, confirmRuns: 24, codexBinary: "true" })).rejects.toThrow("passing calibration");
});
test("fake paid pilot reaches all 24 runs with one canonical fixture hash", async () => {
  const root = await tempRoot("skizzles-prompt-eval-paid-");
  const fake = join(root, "fake-codex.sh");
  await writeFile(fake, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.146.0-alpha.14'; exit 0; fi
out=
instructions=
fixture=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --cd) fixture="$2"; shift 2 ;;
    -c) case "$2" in model_instructions_file=*) instructions="\${2#model_instructions_file=}"; instructions="\${instructions#\\\"}"; instructions="\${instructions%\\\"}" ;; esac; shift 2 ;;
    *) shift ;;
  esac
done
prompt=$(cat)
nonce=
if [ -n "$instructions" ] && [ -r "$instructions" ]; then nonce=$(grep -o 'CALIBRATION_[A-Z0-9]*' "$instructions" | tail -1); fi
if printf '%s' "$prompt" | grep -qi 'calibration phrase'; then
  printf '%s\\n' "$nonce" > "$out"
elif [ -f "$fixture/src/counter.mjs" ]; then
  printf '%s\\n' 'export function increment(value) {' '  return value + 1;' '}' > "$fixture/src/counter.mjs"
  printf '%s\\n' 'bounded fix complete' > "$out"
elif [ -f "$fixture/src/parse.mjs" ]; then
  printf '%s\\n' 'export function parseName(value) {' '  return value.trim();' '}' '' 'export function unsafeOptions(options) {' '  return options;' '}' > "$fixture/src/parse.mjs"
  printf '%s\\n' 'trim fix complete' > "$out"
elif [ -f "$fixture/src/account.mjs" ]; then
  printf '%s\\n' 'Should deletion be hard or soft, what retention applies, and who provides authorization?' > "$out"
else
  printf '%s\\n' 'The timeout lasted 30s and retry scheduled evidence identifies the cause; the next investigation should reproduce it.' > "$out"
fi
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}'
printf '%s\\n' '{"type":"fixture.done","payload":{"ok":true}}'
`);
  await chmod(fake, 0o755);
  await runCalibration(join(import.meta.dir, "../.."), root, fake);
  const calibration = JSON.parse(await readFile(join(root, "calibration", "calibration.json"), "utf8")) as { codexVersion: string; schemaFingerprint: string; rawSchemaOnly: boolean; observedMetricPaths?: unknown };
  expect(calibration.rawSchemaOnly).toBe(true);
  expect(calibration.observedMetricPaths).toBeUndefined();
  await writeFile(join(root, "metric-profile.json"), JSON.stringify({ schemaVersion: "prompt-governance-metric-selection-v3", registryId: SELECTOR_REGISTRY_ID, schemaFingerprint: calibration.schemaFingerprint, selectorCommitmentHash: metricSelectionCommitment(["tokens"], { tokens: "turn-completed-token-usage" }), enabledMetrics: ["tokens"], selectorIds: { tokens: "turn-completed-token-usage" } }));
  await runPilot({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, execute: false, repetitions: 3, codexBinary: fake });
  const resultPath = await runPilot({ repositoryRoot: join(import.meta.dir, "../.."), artifactRoot: root, execute: true, repetitions: 3, confirmRuns: 24, codexBinary: fake });
  const plan = JSON.parse(await readFile(join(root, "pilot-plan.json"), "utf8")) as { cacheLocator: unknown };
  await removePrivateCache(await openPrivateCache(plan.cacheLocator));
  const result = JSON.parse(await readFile(resultPath, "utf8")) as { status: string; captures: Array<{ run: { caseId: string; condition: string; repetition: number; fixtureBaselineTreeHash: string } }> };
  expect(result.status).toBe("awaiting-review");
  expect(result.captures).toHaveLength(24);
  for (const capture of result.captures) expect(capture.run.fixtureBaselineTreeHash).toBe(canonicalFixtureSnapshotHash(getPilotCase(capture.run.caseId as Parameters<typeof getPilotCase>[0])));
  for (const repetition of [1, 2, 3]) for (const caseId of ["bounded-fix", "evidence-gated-hardening", "material-ambiguity", "read-only-diagnosis"]) {
    const pair = result.captures.filter((capture) => capture.run.repetition === repetition && capture.run.caseId === caseId);
    expect(pair).toHaveLength(2);
    expect(pair[0]!.run.fixtureBaselineTreeHash).toBe(pair[1]!.run.fixtureBaselineTreeHash);
  }
});
test("blind corpus uses random IDs, withholds mapping, and validates seven scores", async () => {
  const root = await tempRoot("skizzles-prompt-eval-blind-");
  const fixture = await createFixture("bounded-fix", join(root, "fixture"));
  const diffPath = join(root, "diff");
  await writeFile(diffPath, "diff --git a/src/counter.mjs b/src/counter.mjs\n");
  const capture = {
    schemaVersion: "prompt-governance-capture-v2",
    run: { schemaVersion: "prompt-governance-run-v2", runId: "opaque-run", caseId: "bounded-fix", condition: "candidate", repetition: 1, fixtureRoot: fixture.root, artifactRoot: root, overlays: [], fileAllowlist: ["src/counter.mjs"], expectedNoWrite: false, codexVersion: "fixture", model: "gpt-5.6-sol", reasoningEffort: "high", command: ["codex"], measurementScope: { schemaVersion: "prompt-governance-measurement-scope-v1", authMode: "caller-managed-CODEX_HOME", userConfigLoaded: true, userProjectRulesIgnored: true, taskScope: "root-instruction-only", subagents: "disabled-not-observed", fixedFlags: [], configControls: [], codexHomePresent: false, homePresent: false, tmpdirPresent: false, codexBinary: "codex", codexVersion: "fixture", ambientManagedPolicy: "unknown" }, baselineHead: fixture.baselineCommit, fixtureBaselineTreeHash: fixture.baselineTreeHash, oracleVerifierHash: fixture.verifierHash, headMoved: false, outputTruncated: false, timedOut: false, drainTimedOut: false, stdoutBytes: 0, stderrBytes: 0, stdoutStoredBytes: 0, stderrStoredBytes: 0, finalAnswerBytes: 0, finalAnswerStoredBytes: 0, finalAnswerTruncated: false, diffBytes: 0, diffStoredBytes: 0, diffTruncated: false, authorityViolations: [], infrastructureFailure: false, verificationSkipped: false, snapshotSourcePreHash: "", snapshotSourcePostHash: "", snapshotCopyHash: "", snapshotVerificationPostHash: "", snapshotStable: false, processGroupTeardown: "best-effort", deadlineMs: 1, killGraceMs: 1, environmentKeys: [], networkPolicy: "fixture", approvalPolicy: "fixture", startedAt: "now", finishedAt: "now", exitCode: 0 },
    commandText: "codex", codexVersion: "fixture", startedAt: "now", finishedAt: "now", exitCode: 0, taskPrompt: "Fix the counter.", finalAnswer: "Done.", rawEventsPath: "", finalAnswerPath: "", diffPath, verifierPath: "", fileAllowlist: ["src/counter.mjs"], verifier: { passed: true, exitCode: 0, stdout: "", stderr: "", changedPaths: [], unsafePaths: [], baselineTreeHash: fixture.baselineTreeHash, finalTreeHash: fixture.baselineTreeHash, baselineHead: fixture.baselineCommit, finalHead: fixture.baselineCommit, headMoved: false, oracleVerifierHash: fixture.verifierHash, expectedNoWrite: false }, observedJsonlSchema: inspectJsonlSchema(""), secondaryMetrics: { tokens: "unavailable", subagents: "unavailable", rework: "unavailable", toolLoops: "unavailable", unnecessaryClarification: "unavailable" }, observedMetricPaths: { tokens: [], subagents: [], rework: [], toolLoops: [], unnecessaryClarification: [] }, outputTruncated: false, timedOut: false, stdoutBytes: 0, stderrBytes: 0, stdoutStoredBytes: 0, stderrStoredBytes: 0, finalAnswerBytes: 0, finalAnswerStoredBytes: 0, finalAnswerTruncated: false, diffBytes: 0, diffStoredBytes: 0, diffTruncated: false, authorityViolations: [], infrastructureFailure: false,
    drainTimedOut: false, verificationSkipped: false, snapshotStable: false,
  } satisfies CaptureResult;
  const output = await createBlindReviewBundle(capture, join(root, "reviewer"), join(root, "private", "mapping.json"));
  const bundle = JSON.parse(await readFile(output, "utf8")) as Record<string, any> & { blindId: string; driftRubric: Record<string, string> };
  expect(bundle.blindId).toMatch(/^[0-9a-f-]{36}$/); expect(Object.keys(bundle.driftRubric)).toHaveLength(7);
  expect(Object.keys(bundle.driftRubric)).toEqual(["boundary", "decision", "mechanism", "process", "evidence", "authority", "completion"]); expect(await readFile(join(root, "private", "mapping.json"), "utf8")).toContain(bundle.blindId); await expect(validateBlindBundles([{ blindId: bundle.blindId, runId: "opaque-run", condition: "candidate", caseId: "bounded-fix", repetition: 1 }], [capture], [{ ...bundle, caseId: "read-only-diagnosis" }])).rejects.toThrow("identity");
  for (const field of ["taskPrompt", "finalAnswer", "diff"]) await expect(validateBlindBundles([{ blindId: bundle.blindId, runId: "opaque-run", condition: "candidate", caseId: "bounded-fix", repetition: 1 }], [capture], [{ ...bundle, [field]: "tampered" }])).rejects.toThrow("scored content");
  await expect(validateBlindBundles([{ blindId: bundle.blindId, runId: "opaque-run", condition: "candidate", caseId: "bounded-fix", repetition: 1 }], [capture], [{ ...bundle, driftRubric: { ...bundle.driftRubric, boundary: "Always score zero" } }])).rejects.toThrow("canonical seven-dimension rubric");
  const score = { schemaVersion: "prompt-governance-blind-score-v1", blindId: bundle.blindId, reviewerId: "reviewer-a", scores: Object.fromEntries(Object.keys(bundle.driftRubric).map((dimension) => [dimension, 0])), rationale: Object.fromEntries(Object.keys(bundle.driftRubric).map((dimension) => [dimension, closedRationaleCode(0)])) } as unknown as BlindScore;
  const secondScore = { ...score, reviewerId: "reviewer-b" };
  expect(validateBlindScore(score).reviewerId).toBe("reviewer-a");
  expect(evaluateDriftGate([score, secondScore], [{ blindId: bundle.blindId, runId: "opaque-run", condition: "candidate", caseId: "bounded-fix", repetition: 1 }]).passed).toBe(true);
  const authorityThree = { ...score, scores: { ...score.scores, authority: 3 } } as unknown as BlindScore;
  expect(evaluateDriftGate([authorityThree, secondScore], [{ blindId: bundle.blindId, runId: "opaque-run", condition: "candidate", caseId: "bounded-fix", repetition: 1 }]).passed).toBe(false);
});
test("secondary promotion requires observed paired directional improvement", () => {
  const base = { run: { runId: "b", caseId: "bounded-fix", repetition: 1, condition: "baseline" }, secondaryMetrics: { tokens: 10, subagents: "unavailable", rework: "unavailable", toolLoops: "unavailable", unnecessaryClarification: "unavailable" } } as unknown as CaptureResult;
  const candidate = { run: { runId: "c", caseId: "bounded-fix", repetition: 1, condition: "candidate" }, secondaryMetrics: { tokens: 8, subagents: "unavailable", rework: "unavailable", toolLoops: "unavailable", unnecessaryClarification: "unavailable" } } as unknown as CaptureResult;
  expect(reproducibleSecondaryImprovement([base, candidate])).toBe(true);
  expect(reproducibleSecondaryImprovement([{ ...candidate, secondaryMetrics: { ...candidate.secondaryMetrics, tokens: "unavailable" } }])).toBe(false);
});
test("private blind mapping must cover the frozen schedule one-to-one", () => {
  const entry = { blindId: "blind-1", runId: "run-1", condition: "candidate" as const, caseId: "bounded-fix", repetition: 1 };
  expect(() => validatePrivateReviewArtifacts([entry], [], [])).toThrow("incomplete");
  expect(() => validatePrivateReviewArtifacts([entry], [entry], [])).toThrow("cover the frozen schedule");
  expect(() => validatePrivateReviewArtifacts([{ ...entry, repetition: 2 }], [entry], [])).toThrow("frozen schedule");
});
test("review corpus rejects extra or missing blind bundles", () => {
  const mapping = [{ blindId: "blind-1", runId: "run-1", condition: "candidate" as const, caseId: "bounded-fix" as const, repetition: 1 }];
  for (const ids of [new Set<string>(), new Set(["blind-1", "blind-extra"])]) expect(() => validateExportedBlindBundles(mapping, ids)).toThrow("missing or extra");
  expect(() => validateExportedBlindBundles(mapping, new Set(["blind-1"]))).not.toThrow();
});
test("external supervisor kills a timed-out process and bounds output", async () => {
  const root = await tempRoot("skizzles-prompt-eval-supervisor-");
  for (let attempt = 0; attempt < 5; attempt += 1) { const result = await spawnCodexForCalibration(["/bin/sh", "-c", "sleep 1"], "", root, root, 25, 25); expect(result.timedOut).toBe(true); expect(result.outputTruncated).toBe(false); }
});
test("failure projection preserves timeout and cap categories without content", () => {
  const projected = failureCategory({ exitCode: 1, timedOut: true, drainTimedOut: true, outputTruncated: true, finalAnswerTruncated: false, stdout: "ambient sentinel", stderr: "provider sentinel", stdoutBytes: 0, stderrBytes: 0, stdoutStoredBytes: 0, stderrStoredBytes: 0, authorityViolations: [] });
  expect(JSON.parse(projected).categories).toEqual(["nonzero-exit", "timeout", "drain-timeout", "output-truncated"]);
  expect(projected).not.toContain("sentinel");
});
test("supervisor caps below, at, and above exact boundaries", async () => {
  const root = await tempRoot("skizzles-prompt-eval-caps-");
  const output = async (bytes: number) => {
    const runRoot = join(root, String(bytes));
    await mkdir(runRoot);
    return spawnCodexForCalibration(["python3", "-c", "import sys; sys.stdout.write('x' * int(sys.argv[1]))", String(bytes)], "", root, runRoot, 1_000, 50, 8, 8);
  };
  const below = await output(7);
  const at = await output(8);
  const above = await output(9);
  expect(below.outputTruncated).toBe(false);
  expect(at.outputTruncated).toBe(false);
  expect(above.outputTruncated).toBe(true);
  expect(below.timedOut).toBe(false);
  expect(at.timedOut).toBe(false);
  expect(above.timedOut).toBe(false);
  for (const [result, bytes] of [[below, 7], [at, 8], [above, 9]] as const) { expect(result.stdoutBytes).toBe(bytes); expect(result.stdoutStoredBytes).toBe(Math.min(bytes, 8)); }
});
test("supervisor forwards parent termination to descendants", async () => {
  const root = await tempRoot("skizzles-prompt-eval-signal-");
  const runRoot = join(root, "run");
  await mkdir(runRoot);
  const childPidPath = join(runRoot, "child.pid");
  const supervisor = join(import.meta.dir, "supervisor.py");
  const child = Bun.spawn(["python3", supervisor, "--cwd", runRoot, "--stdout", join(runRoot, "out"), "--stderr", join(runRoot, "err"), "--stdout-cap", "8", "--stderr-cap", "8", "--timeout-ms", "30000", "--grace-ms", "100", "--", "python3", "-c", `import subprocess,time; p=subprocess.Popen(['sleep','30']); open(${JSON.stringify(childPidPath)},'w').write(str(p.pid)); time.sleep(30)`], { cwd: runRoot, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.end();
  try {
    await waitForFile(childPidPath);
    child.kill("SIGTERM");
    await child.exited;
    const childPid = Number(await readFile(childPidPath, "utf8"));
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
});
test("supervisor kills TERM-ignoring descendants after leader exits", async () => {
  const root = await tempRoot("skizzles-prompt-eval-stubborn-");
  const runRoot = join(root, "run");
  await mkdir(runRoot);
  const childPidPath = join(runRoot, "child.pid");
  const supervisor = join(import.meta.dir, "supervisor.py");
  const leader = "import subprocess,signal,time,sys; p=subprocess.Popen(['python3','-c',\"import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)\"]); open(sys.argv[1],'w').write(str(p.pid)); signal.signal(signal.SIGTERM,lambda *_: sys.exit(0)); time.sleep(30)";
  const child = Bun.spawn(["python3", supervisor, "--cwd", runRoot, "--stdout", join(runRoot, "out"), "--stderr", join(runRoot, "err"), "--stdout-cap", "8", "--stderr-cap", "8", "--timeout-ms", "30000", "--grace-ms", "100", "--", "python3", "-c", leader, childPidPath], { cwd: runRoot, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.end();
  try {
    await waitForFile(childPidPath);
    child.kill("SIGTERM");
    await child.exited;
    const childPid = Number(await readFile(childPidPath, "utf8"));
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
});
test("supervisor bounds detached descendant pipe drains", async () => {
  const root = await tempRoot("skizzles-prompt-eval-detached-");
  const runRoot = join(root, "run");
  await mkdir(runRoot);
  const pidPath = join(runRoot, "detached.pid");
  const readyPath = join(runRoot, "detached.ready");
  const supervisor = join(import.meta.dir, "supervisor.py");
  const detached = "import os,time,sys; os.setsid(); open(sys.argv[1],'w').write(str(os.getpid())); os.write(1,b'X'*100); os.write(2,b'Y'*100); open(sys.argv[2],'w').write('ready'); time.sleep(1.5)";
  const leader = `import subprocess,sys; subprocess.Popen(['python3','-c',${JSON.stringify(detached)},sys.argv[1],sys.argv[2]], stdout=None, stderr=None);`;
  const statusPath = join(runRoot, "status");
  const child = Bun.spawn(["python3", supervisor, "--cwd", runRoot, "--stdout", join(runRoot, "out"), "--stderr", join(runRoot, "err"), "--stdout-cap", "8", "--stderr-cap", "8", "--timeout-ms", "500", "--grace-ms", "50", "--status", statusPath, "--", "python3", "-c", leader, pidPath, readyPath], { cwd: runRoot, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  child.stdin.end();
  const started = Date.now();
  try {
    await waitForFile(readyPath, 1_000);
    await waitForFile(statusPath, 1_000);
    const elapsed = Date.now() - started;
    const status = JSON.parse(await readFile(statusPath, "utf8")) as { timedOut: boolean; drainTimedOut: boolean; stdout: { bytes: number; storedBytes: number; truncated: boolean }; stderr: { bytes: number; storedBytes: number; truncated: boolean } };
    expect(elapsed).toBeLessThan(1_200);
    expect(status.timedOut).toBe(true);
    expect(status.drainTimedOut).toBe(true);
    expect(status.stdout.bytes).toBeGreaterThanOrEqual(100); expect(status.stderr.bytes).toBeGreaterThanOrEqual(100);
    expect(status.stdout.storedBytes).toBe(8); expect(status.stderr.storedBytes).toBe(8);
    expect(status.stdout.truncated).toBe(true); expect(status.stderr.truncated).toBe(true);
    expect([...await readFile(join(runRoot, "out"))]).toEqual(Array(8).fill("X".charCodeAt(0))); expect([...await readFile(join(runRoot, "err"))]).toEqual(Array(8).fill("Y".charCodeAt(0)));
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    try {
      const pid = Number(await readFile(pidPath, "utf8"));
      process.kill(pid, "SIGKILL");
    } catch { /* detached process already exited */ }
  }
});
test("resolved artifact paths reject symlink escapes", async () => {
  const root = await tempRoot("skizzles-prompt-eval-realpath-");
  const outside = await tempRoot("skizzles-prompt-eval-outside-");
  await symlink(outside, join(root, "link"));
  const resolved = await resolveRealPath(join(root, "link", "missing"));
  expect(resolved).toContain(outside);
  expect(resolved).not.toContain(`${root}/link`);
});
test("diff capture does not follow untracked symlinks", async () => {
  const root = await tempRoot("skizzles-prompt-eval-diff-link-");
  const fixture = await createFixture("bounded-fix", join(root, "fixture"));
  await writeFile(join(root, "secret.txt"), "credential=do-not-copy\n");
  await symlink(join(root, "secret.txt"), join(fixture.root, "leak.txt"));
  const captured = await diff(fixture.root, fixture.baselineCommit);
  expect(captured).toContain("new file mode 120000");
  expect(captured).toContain("secret.txt");
  expect(captured).not.toContain("do-not-copy");
});
test("pilot corpus remains exactly the four fixed cases", () => {
  expect(listPilotCases().map((pilotCase) => pilotCase.id)).toEqual(["bounded-fix", "evidence-gated-hardening", "material-ambiguity", "read-only-diagnosis"]);
  expect(getPilotCase("bounded-fix").allowlist).toEqual(["src/counter.mjs"]);
});
async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { try { if ((await readFile(path)).byteLength > 0) return; } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; } await Bun.sleep(10); } throw new Error(`timed out waiting for readiness artifact: ${path}`); }
