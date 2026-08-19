import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childArgsFromArgv, resolveCursorAgent } from "../src/resolve-agent.ts";

describe("cursor-agent resolution", () => {
  test("keeps T3's trailing acp argv and defaults to acp", () => {
    expect(childArgsFromArgv(["acp"])).toEqual(["acp"]);
    expect(childArgsFromArgv(["acp", "--workspace", "/tmp/work"])).toEqual(["acp", "--workspace", "/tmp/work"]);
    expect(childArgsFromArgv(["cursor-agent", "acp"])).toEqual(["acp"]);
    expect(childArgsFromArgv([])).toEqual(["acp"]);
  });

  test("prefers T3_CURSOR_ACP_BIN and refuses a PATH loop back to the shim", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-acp-shim-"));
    try {
      const real = join(root, "cursor-agent");
      const shim = join(root, "t3-cursor-acp");
      await writeFile(real, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await chmod(real, 0o755);
      await writeFile(shim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await chmod(shim, 0o755);
      expect(resolveCursorAgent({ env: { T3_CURSOR_ACP_BIN: real }, argv0: shim })).toBe(await realpath(real));
      expect(() => resolveCursorAgent({ env: { T3_CURSOR_ACP_BIN: shim }, argv0: shim })).toThrow("resolves to the shim");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses the versioned cursor-agent install and skips the shim path entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-acp-shim-"));
    try {
      const versions = join(root, ".local/share/cursor-agent/versions/2026.08.11-e8db854");
      await mkdir(versions, { recursive: true });
      const real = join(versions, "cursor-agent");
      await writeFile(real, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await chmod(real, 0o755);
      const bin = join(root, "bin");
      await mkdir(bin, { recursive: true });
      const shim = join(bin, "cursor-agent");
      await symlink(join(root, "t3-cursor-acp"), shim);
      await writeFile(join(root, "t3-cursor-acp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const resolved = resolveCursorAgent({
        env: { HOME: root, PATH: bin },
        home: root,
        argv0: join(root, "t3-cursor-acp"),
      });
      expect(resolved).toBe(await realpath(real));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
