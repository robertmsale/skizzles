import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertSupportedCodexBinary,
  compareCodexVersions,
  isSupportedCodexVersion,
  parseCodexVersion,
  probeCodexVersion,
  supportsOwnedProbeProcessGroup,
} from "../src/configuration/codex-version";
import { configureCodex, configReceiptPath, type ConfigRpc } from "../src/config";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fakeBinary(script: string): string {
  const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-version-${crypto.randomUUID()}`;
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const path = join(root, "codex");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error(`descendant ${pid} survived version probe cleanup`);
}

describe("Codex compatibility", () => {
  test("only declares known POSIX platforms eligible for owned probe groups", () => {
    expect(supportsOwnedProbeProcessGroup("linux")).toBe(true);
    expect(supportsOwnedProbeProcessGroup("darwin")).toBe(true);
    expect(supportsOwnedProbeProcessGroup("win32")).toBe(false);
    expect(supportsOwnedProbeProcessGroup("unknown-platform")).toBe(false);
  });

  test("parses full semver, including prerelease and build metadata", () => {
    const version = parseCodexVersion("codex-cli 0.146.0-alpha.14+local.7\n");
    expect(version).toEqual({
      major: 0,
      minor: 146,
      patch: 0,
      prerelease: ["alpha", "14"],
      build: ["local", "7"],
    });
  });

  test("uses the inclusive alpha.3 floor and semver prerelease ordering", () => {
    const alpha2 = parseCodexVersion("0.146.0-alpha.2")!;
    const alpha3 = parseCodexVersion("0.146.0-alpha.3")!;
    const final = parseCodexVersion("0.146.0")!;
    expect(isSupportedCodexVersion(alpha2)).toBe(false);
    expect(isSupportedCodexVersion(alpha3)).toBe(true);
    expect(isSupportedCodexVersion(final)).toBe(true);
    expect(compareCodexVersions(alpha2, alpha3)).toBeLessThan(0);
    expect(isSupportedCodexVersion(parseCodexVersion("0.147.0")!)).toBe(true);
  });

  test("rejects exact 0.145.0 with the known broken host warning", async () => {
    await expect(assertSupportedCodexBinary(fakeBinary("printf '%s\\n' 'codex-cli 0.145.0'"))).rejects.toThrow(
      "known broken, token-wasting host",
    );
  });

  test("fails closed on malformed and nonzero version probes", async () => {
    await expect(assertSupportedCodexBinary(fakeBinary("printf '%s\\n' 'codex-cli unknown'"))).rejects.toThrow(
      "did not report a full semantic version",
    );
    await expect(assertSupportedCodexBinary(fakeBinary("printf '%s\\n' 'codex-cli 0.146.0' >&2\nexit 7"))).rejects.toThrow(
      "unable to verify Codex binary compatibility (exit 7",
    );
  });

  test("does not expose terminal controls from a failed version probe", async () => {
    const error = await assertSupportedCodexBinary(
      fakeBinary("printf '\\033]0;owned\\007\\033[31m' >&2\nexit 7"),
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect((error as Error).message).toContain("exit 7");
  });

  test.skipIf(process.platform === "win32")("does not expose controls from a synchronous spawn failure", async () => {
    const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-version-spawn-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const binary = join(root, "codex-\u001b]0;owned\u0007");
    writeFileSync(binary, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.146.0'\n");
    chmodSync(binary, 0o644);

    const error = await assertSupportedCodexBinary(binary).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect((error as Error).message).toContain("unable to run the selected Codex binary");
  });

  test("fails closed when version output exceeds the bounded probe size", async () => {
    await expect(assertSupportedCodexBinary(fakeBinary("head -c 70000 /dev/zero"))).rejects.toThrow(
      "produced too much output",
    );
  });

  test("bounds a hung version probe", async () => {
    const started = performance.now();
    await expect(assertSupportedCodexBinary(fakeBinary("sleep 3"))).rejects.toThrow("timed out");
    expect(performance.now() - started).toBeLessThan(2_800);
  });

  test.skipIf(process.platform === "win32")("timeout kills descendants in the owned process group", async () => {
    const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-version-tree-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const marker = join(root, "descendant.pid");
    const descendant = join(root, "descendant.ts");
    writeFileSync(descendant, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
      "setInterval(() => {}, 1_000);",
    ].join("\n"));
    const binary = join(root, "codex");
    writeFileSync(binary, `#!/bin/sh\n"${process.execPath}" "${descendant}" &\nwait\n`);
    chmodSync(binary, 0o755);

    const started = performance.now();
    const completion = assertSupportedCodexBinary(binary);
    let pid: number | undefined;
    const markerDeadline = Date.now() + 1_000;
    while (Date.now() < markerDeadline) {
      try {
        pid = Number.parseInt(readFileSync(marker, "utf8"), 10);
        if (Number.isSafeInteger(pid) && pid > 0) break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await Bun.sleep(10);
    }
    if (!pid) throw new Error("descendant PID was not published");
    await expect(completion).rejects.toThrow("timed out");
    expect(performance.now() - started).toBeLessThan(2_800);
    await expectProcessGone(pid);
  });

  test("probes before creating an RPC or receipt", async () => {
    const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-preflight-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.toml"), "# fixture\n");
    const codexBinary = fakeBinary("printf '%s\\n' 'codex-cli 0.146.0-alpha.2'");
    let rpcCreated = false;
    const rpc: ConfigRpc = {
      read: async () => ({
        layers: [{ name: { type: "user", file: join(root, "config.toml"), profile: null }, version: "1", config: {} }],
      }),
      batchWrite: async () => {
        throw new Error("RPC must not be reached");
      },
      close: async () => undefined,
    };

    await expect(configureCodex({
      codexHome: root,
      codexBinary,
      orchestration: "passive",
      rpcFactory: async () => {
        rpcCreated = true;
        return rpc;
      },
    })).rejects.toThrow("upgrade to Codex CLI 0.146.0-alpha.3 or newer");
    expect(rpcCreated).toBe(false);
    expect(existsSync(configReceiptPath(root))).toBe(false);
  });

  test("probes a passing binary and returns its parsed version", async () => {
    const result = await probeCodexVersion(fakeBinary("printf '%s\\n' 'codex-cli 0.146.0-alpha.3+ci.1'"));
    expect(result.version.prerelease).toEqual(["alpha", "3"]);
    expect(result.version.build).toEqual(["ci", "1"]);
  });
});
