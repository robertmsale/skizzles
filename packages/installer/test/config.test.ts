import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  configureCodex,
  configReceiptPath,
  desiredConfigEdits,
  unconfigureCodex,
  type ConfigEdit,
  type ConfigRpc,
} from "../src/config";

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

const roots: string[] = [];

function fixture(initial: Value = {}): { codexHome: string; codexBinary: string; rpc: FakeRpc } {
  const codexHome = `${process.env.TMPDIR ?? "/tmp"}/skizzles-config-${crypto.randomUUID()}`;
  roots.push(codexHome);
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), "# preserved by native Codex config editing\n");
  return { codexHome, codexBinary: process.execPath, rpc: new FakeRpc(codexHome, initial) };
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setValue(root: { [key: string]: Value }, keyPath: string, value: Value): void {
  const segments = keyPath.split(".");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (!child || Array.isArray(child) || typeof child !== "object") current[segment] = {};
    current = current[segment] as { [key: string]: Value };
  }
  const final = segments.at(-1)!;
  if (value === null) delete current[final];
  else current[final] = structuredClone(value);
}

class FakeRpc implements ConfigRpc {
  config: { [key: string]: Value };
  version = "sha256:1";
  writes = 0;
  closed = false;
  mutateBeforeWrite = false;

  constructor(private readonly codexHome: string, initial: Value) {
    this.config = structuredClone(initial) as { [key: string]: Value };
  }

  async read() {
    return {
      layers: [{
        name: { type: "user", file: join(this.codexHome, "config.toml"), profile: null },
        version: this.version,
        config: structuredClone(this.config),
      }],
    };
  }

  async batchWrite(params: {
    edits: ConfigEdit[];
    filePath: string;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }) {
    if (this.mutateBeforeWrite) this.version = "sha256:external";
    if (params.expectedVersion !== this.version) throw new Error("configVersionConflict");
    expect(params.reloadUserConfig).toBe(true);
    for (const edit of params.edits) setValue(this.config, edit.keyPath, edit.value);
    this.writes += 1;
    this.version = `sha256:${this.writes + 1}`;
    return { status: "ok", version: this.version, filePath: params.filePath };
  }

  async close() {
    this.closed = true;
  }
}

function factory(rpc: FakeRpc) {
  return async () => rpc;
}

describe("Codex configuration lifecycle", () => {
  test("passive orchestration leaves native MultiAgentV2 defaults untouched", () => {
    expect(desiredConfigEdits("passive")).toEqual([
      { keyPath: "features.hooks", value: true, mergeStrategy: "replace" },
    ]);
  });

  test("Skizzles instructions configure distinct root and default-subagent prompts", () => {
    expect(desiredConfigEdits("passive", {
      sourceRoot: "/skizzles",
      rootInstructions: "/skizzles/assets/root.md",
      subagentInstructions: "/skizzles/assets/subagent.md",
      subagentConfig: "/skizzles/assets/subagent.toml",
    })).toEqual([
      { keyPath: "features.hooks", value: true, mergeStrategy: "replace" },
      { keyPath: "model_instructions_file", value: "/skizzles/assets/root.md", mergeStrategy: "replace" },
      {
        keyPath: "agents.default.description",
        value: "Skizzles execution subagent with a compact developer-focused instruction set.",
        mergeStrategy: "replace",
      },
      { keyPath: "agents.default.config_file", value: "/skizzles/assets/subagent.toml", mergeStrategy: "replace" },
    ]);
  });

  test("aggressive orchestration uses concise Fourth Wall hints", () => {
    const edits = desiredConfigEdits("aggressive");
    expect(edits.map(({ keyPath }) => keyPath)).toEqual([
      "features.hooks",
      "features.multi_agent_v2.enabled",
      "features.multi_agent_v2.max_concurrent_threads_per_session",
      "features.multi_agent_v2.multi_agent_mode_hint_text",
      "features.multi_agent_v2.root_agent_usage_hint_text",
      "features.multi_agent_v2.subagent_usage_hint_text",
    ]);
    const hints = edits.slice(3).map(({ value }) => value as string);
    expect(hints.every((hint) => hint.includes("$fourth-wall"))).toBe(true);
    expect(hints.every((hint) => hint.length < 180)).toBe(true);
  });

  test("configures and restores only receipt-owned keys", async () => {
    const f = fixture({
      model: "personal-model",
      features: { hooks: false, goals: true },
      developer_instructions: "personal guidance",
    });
    await configureCodex({ ...f, orchestration: "aggressive", rpcFactory: factory(f.rpc) });
    expect(f.rpc.config).toMatchObject({
      model: "personal-model",
      developer_instructions: "personal guidance",
      features: { hooks: true, goals: true, multi_agent_v2: { enabled: true } },
    });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(true);

    f.rpc.closed = false;
    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.config).toEqual({
      model: "personal-model",
      features: { hooks: false, goals: true, multi_agent_v2: {} },
      developer_instructions: "personal guidance",
    });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
    expect(f.rpc.closed).toBe(true);
  });

  test("dry run reads and previews without writing a receipt", async () => {
    const f = fixture({ features: { hooks: false } });
    const receipt = await configureCodex({
      ...f,
      orchestration: "passive",
      dryRun: true,
      rpcFactory: factory(f.rpc),
    });
    expect(receipt.values).toEqual([{ keyPath: "features.hooks", beforePresent: true, before: false, after: true }]);
    expect(f.rpc.writes).toBe(0);
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });

  test("configures and restores Skizzles instruction paths without disturbing sibling agent config", async () => {
    const f = fixture({
      model_instructions_file: "/personal/root.md",
      agents: { default: { description: "Personal default", config_file: "/personal/agent.toml", nickname_candidates: ["Ada"] } },
    });
    const sourceRoot = join(f.codexHome, "skizzles");
    mkdirSync(join(sourceRoot, "assets"), { recursive: true });
    for (const file of ["skizzles_instructions.md", "skizzles_subagent_instructions.md", "skizzles_subagent.toml"]) {
      writeFileSync(join(sourceRoot, "assets", file), file);
    }
    const canonicalSourceRoot = realpathSync(sourceRoot);
    await configureCodex({
      ...f,
      orchestration: "passive",
      instructions: "skizzles",
      sourceRoot,
      rpcFactory: factory(f.rpc),
    });
    expect(f.rpc.config).toMatchObject({
      model_instructions_file: join(canonicalSourceRoot, "assets", "skizzles_instructions.md"),
      agents: {
        default: {
          description: "Skizzles execution subagent with a compact developer-focused instruction set.",
          config_file: join(canonicalSourceRoot, "assets", "skizzles_subagent.toml"),
          nickname_candidates: ["Ada"],
        },
      },
    });

    f.rpc.closed = false;
    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.config).toEqual({
      model_instructions_file: "/personal/root.md",
      agents: { default: { description: "Personal default", config_file: "/personal/agent.toml", nickname_candidates: ["Ada"] } },
      features: {},
    });
  });

  test("fails closed when a Skizzles instruction asset is missing", async () => {
    const f = fixture({});
    await expect(configureCodex({
      ...f,
      orchestration: "passive",
      instructions: "skizzles",
      sourceRoot: join(f.codexHome, "missing-skizzles"),
      rpcFactory: factory(f.rpc),
    })).rejects.toThrow("Skizzles rootInstructions asset is missing");
    expect(f.rpc.writes).toBe(0);
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });

  test("fails closed when an owned key drifts", async () => {
    const f = fixture({});
    await configureCodex({ ...f, orchestration: "aggressive", rpcFactory: factory(f.rpc) });
    setValue(f.rpc.config, "features.multi_agent_v2.max_concurrent_threads_per_session", 3);
    await expect(unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) })).rejects.toThrow(
      "refusing to restore drifted config key",
    );
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(true);
  });

  test("removes a pending receipt when Codex rejects a concurrent edit", async () => {
    const f = fixture({});
    f.rpc.mutateBeforeWrite = true;
    await expect(
      configureCodex({ ...f, orchestration: "passive", rpcFactory: factory(f.rpc) }),
    ).rejects.toThrow("configVersionConflict");
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });
});
