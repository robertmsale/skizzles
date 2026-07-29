/** The first Codex CLI release that supports the configured Skizzles workflow. */
export const MINIMUM_CODEX_VERSION = "0.146.0-alpha.3";

const VERSION_PROBE_TIMEOUT_MS = 2_000;
const PROBE_CLEANUP_TIMEOUT_MS = 500;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const OWNED_PROCESS_GROUP_PLATFORMS = new Set([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
]);

export interface CodexVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

export interface ProbeResult {
  version: CodexVersion;
  stdout: string;
  stderr: string;
}

interface BoundedOutput {
  text: string;
  truncated: boolean;
}

const VERSION_TOKEN = /(?:^|[^0-9A-Za-z])((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?![0-9A-Za-z.-])/g;

function parseIdentifierList(value: string | undefined): string[] {
  return value ? value.split(".") : [];
}

/** Parse a full semver token embedded in normal `codex --version` output. */
export function parseCodexVersion(output: string): CodexVersion | undefined {
  VERSION_TOKEN.lastIndex = 0;
  const match = VERSION_TOKEN.exec(output);
  if (!match?.[1]) return undefined;
  const token = match[1];
  const plusIndex = token.indexOf("+");
  const coreAndPrerelease = plusIndex >= 0 ? token.slice(0, plusIndex) : token;
  const build = plusIndex >= 0 ? token.slice(plusIndex + 1) : undefined;
  const hyphenIndex = coreAndPrerelease.indexOf("-");
  const core = hyphenIndex >= 0 ? coreAndPrerelease.slice(0, hyphenIndex) : coreAndPrerelease;
  const prerelease = hyphenIndex >= 0 ? coreAndPrerelease.slice(hyphenIndex + 1) : undefined;
  const components = core.split(".");
  const major = Number(components[0]);
  const minor = Number(components[1]);
  const patch = Number(components[2]);
  const prereleaseIdentifiers = parseIdentifierList(prerelease);
  if (prereleaseIdentifiers.some((identifier) => identifier.length === 0)) return undefined;
  if (prereleaseIdentifiers.some((identifier) => /^0[0-9]+$/.test(identifier))) return undefined;
  const buildIdentifiers = parseIdentifierList(build);
  if (buildIdentifiers.some((identifier) => identifier.length === 0)) return undefined;
  return { major, minor, patch, prerelease: prereleaseIdentifiers, build: buildIdentifiers };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compare two semver values. Build metadata is intentionally ignored. */
export function compareCodexVersions(left: CodexVersion, right: CodexVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const result = compareIdentifier(leftIdentifier, rightIdentifier);
    if (result !== 0) return result;
  }
  return 0;
}

const minimumVersion = parseCodexVersion(MINIMUM_CODEX_VERSION)!;

/** Whether this host can isolate and terminate the version probe's process group. */
export function supportsOwnedProbeProcessGroup(platform: string = process.platform): boolean {
  return OWNED_PROCESS_GROUP_PLATFORMS.has(platform);
}

export function isSupportedCodexVersion(version: CodexVersion): boolean {
  return compareCodexVersions(version, minimumVersion) >= 0;
}

function formatCodexVersion(version: CodexVersion): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  const prerelease = version.prerelease.length > 0 ? `-${version.prerelease.join(".")}` : "";
  const build = version.build.length > 0 ? `+${version.build.join(".")}` : "";
  return `${core}${prerelease}${build}`;
}

async function readBounded(
  stream: globalThis.ReadableStream<Uint8Array>,
  cancellation?: AbortSignal,
): Promise<BoundedOutput> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  cancellation?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const bytesBefore = bytes;
      if (bytes < MAX_PROBE_OUTPUT_BYTES) {
        const remaining = MAX_PROBE_OUTPUT_BYTES - bytes;
        chunks.push(value.byteLength <= remaining ? value : value.slice(0, remaining));
        bytes += Math.min(value.byteLength, remaining);
      }
      if (bytesBefore + value.byteLength > MAX_PROBE_OUTPUT_BYTES) {
        truncated = true;
      }
    }
  } finally {
    cancellation?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return { text, truncated };
}

function missingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function signalProbeTree(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
  signal: "SIGKILL",
  ownsProcessGroup: boolean,
): void {
  if (ownsProcessGroup) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (missingProcess(error)) return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between observation and delivery.
  }
}

async function settleProbeCleanup(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
  output: Promise<[BoundedOutput, BoundedOutput]>,
  cancellation: AbortController,
): Promise<void> {
  cancellation.abort();
  await Promise.race([
    Promise.allSettled([child.exited, output]),
    Bun.sleep(PROBE_CLEANUP_TIMEOUT_MS),
  ]);
}

async function settleProbeOutput(
  output: Promise<[BoundedOutput, BoundedOutput]>,
  cancellation: AbortController,
): Promise<[BoundedOutput, BoundedOutput] | undefined> {
  const result = await Promise.race([
    output,
    Bun.sleep(PROBE_CLEANUP_TIMEOUT_MS).then(() => undefined),
  ]);
  if (result !== undefined) return result;
  cancellation.abort();
  void output.catch(() => undefined);
  return undefined;
}

/** Probe one selected binary before any app-server or configuration side effect. */
export async function probeCodexVersion(codexBinary: string): Promise<ProbeResult> {
  const ownsProcessGroup = supportsOwnedProbeProcessGroup();
  if (!ownsProcessGroup) {
    throw new Error(
      "Codex compatibility configuration requires a POSIX host with owned process-group support; " +
      "transfer-only installation remains available independently",
    );
  }
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([codexBinary, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env },
      detached: true,
    });
  } catch {
    throw new Error(
      "unable to run the selected Codex binary for compatibility check; " +
      `upgrade to Codex CLI ${MINIMUM_CODEX_VERSION} or newer before running configure`,
    );
  }

  const cancellation = new AbortController();
  const output = Promise.all([
    readBounded(child.stdout, cancellation.signal),
    readBounded(child.stderr, cancellation.signal),
  ]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutReached = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), VERSION_PROBE_TIMEOUT_MS);
  });
  const result = await Promise.race([
    child.exited,
    timeoutReached,
  ]);
  if (timeout) clearTimeout(timeout);
  if (result === "timeout") {
    signalProbeTree(child, "SIGKILL", ownsProcessGroup);
    await settleProbeCleanup(child, output, cancellation);
    throw new Error(
      `Codex binary compatibility check timed out after ${VERSION_PROBE_TIMEOUT_MS}ms; ` +
      `upgrade to Codex CLI ${MINIMUM_CODEX_VERSION} or newer before running configure`,
    );
  }
  // A successful leader can still leave an untrusted descendant holding the
  // pipes open. The detached process group is owned by this probe, so close it
  // before waiting on bounded output drains.
  signalProbeTree(child, "SIGKILL", ownsProcessGroup);
  const settledOutput = await settleProbeOutput(output, cancellation);
  if (!settledOutput) {
    throw new Error(
      `Codex binary compatibility check did not close its output within ${PROBE_CLEANUP_TIMEOUT_MS}ms; ` +
      `upgrade to Codex CLI ${MINIMUM_CODEX_VERSION} or newer before running configure`,
    );
  }
  const [stdout, stderr] = settledOutput;
  if (stdout.truncated || stderr.truncated) {
    throw new Error(
      `Codex binary compatibility check produced too much output; ` +
      `upgrade to Codex CLI ${MINIMUM_CODEX_VERSION} or newer before running configure`,
    );
  }
  if (result !== 0) {
    throw new Error(
      `unable to verify Codex binary compatibility (exit ${result}); ` +
      `upgrade to Codex CLI ${MINIMUM_CODEX_VERSION} or newer before running configure`,
    );
  }
  const version = parseCodexVersion(stdout.text) ?? parseCodexVersion(stderr.text);
  if (!version) {
    throw new Error(
      `unable to verify Codex binary compatibility: --version did not report a full semantic version; ` +
      `upgrade to Codex CLI ${MINIMUM_CODEX_VERSION} or newer before running configure`,
    );
  }
  return { version, stdout: stdout.text, stderr: stderr.text };
}

export async function assertSupportedCodexBinary(codexBinary: string): Promise<CodexVersion> {
  const { version } = await probeCodexVersion(codexBinary);
  if (isSupportedCodexVersion(version)) return version;
  const rendered = formatCodexVersion(version);
  if (version.major === 0 && version.minor === 145 && version.patch === 0 && version.prerelease.length === 0) {
    throw new Error(
      "Codex CLI 0.145.0 is not supported for Skizzles orchestration: it is a known broken, " +
      "token-wasting host. Upgrade to Codex CLI 0.146.0-alpha.3 or newer before running configure.",
    );
  }
  throw new Error(
    `Codex CLI ${rendered} is not supported for Skizzles orchestration; ` +
    `upgrade to Codex CLI ${MINIMUM_CODEX_VERSION} or newer before running configure.`,
  );
}
