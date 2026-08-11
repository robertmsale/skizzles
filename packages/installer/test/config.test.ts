import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

function writeInstructionFixture(sourceRoot: string, nativeRoleAliases: Record<string, string> = {}): void {
  mkdirSync(join(sourceRoot, "assets", "agents"), { recursive: true });
  for (const file of ["skizzles_instructions.md", "skizzles_subagent_instructions.md"]) {
    writeFileSync(join(sourceRoot, "assets", file), file);
  }
  const agents = [
    { agentType: "default", description: "Fixture default", configFile: "default.toml" },
    { agentType: "worker", description: "Fixture worker", configFile: "worker.toml" },
    { agentType: "explorer", description: "Fixture explorer", configFile: "explorer.toml" },
    { agentType: "review", description: "Fixture review", configFile: "review.toml" },
  ];
  for (const agent of agents) writeFileSync(join(sourceRoot, "assets", "agents", agent.configFile), agent.agentType);
  writeFileSync(join(sourceRoot, "assets", "agents", "manifest.json"), JSON.stringify({ version: 1, nativeRoleAliases, agents }));
}

describe("Codex configuration lifecycle", () => {
  test("passive orchestration leaves native MultiAgentV2 defaults untouched", () => {
    expect(desiredConfigEdits("passive")).toEqual([
      { keyPath: "features.hooks", value: true, mergeStrategy: "replace" },
    ]);
  });

  test("canonical prompts preserve the Codex harness contract", () => {
    const root = readFileSync(resolve(import.meta.dir, "../../../assets/skizzles_instructions.md"), "utf8");
    const subagent = readFileSync(resolve(import.meta.dir, "../../../assets/skizzles_subagent_instructions.md"), "utf8");
    const wordCount = (contents: string) => (contents.match(/\S+/g) ?? []).length;

    expect(wordCount(root)).toBeGreaterThan(700);
    expect(wordCount(root)).toBeLessThanOrEqual(1_200);
    expect(wordCount(subagent)).toBeGreaterThan(300);
    expect(wordCount(subagent)).toBeLessThanOrEqual(700);

    for (const contract of [
      "Own the user's requested outcome",
      "Working relationship and communication",
      "Request classification and execution",
      "If context is compacted",
      "Read applicable `AGENTS.md`",
      "never weaken validation to manufacture a green result",
      "Never overwrite, reset, clean, discard, rewrite history, push, publish, or alter production without exact authority",
      "Assume the workspace may be shared",
      "concise evidence-backed handoff",
    ]) {
      expect(root).toContain(contract);
    }
    for (const contract of [
      "parent agent's bounded task graph",
      "preserve unrelated work",
      "Do not broaden scope or create overlapping ownership",
      "Own the slice through focused implementation",
      "keep validation proportional",
      "Send the parent a concise message when you hit a material blocker",
      "Report changed areas, resulting behavior, validation",
    ]) {
      expect(subagent).toContain(contract);
    }
    for (const obsoleteSkill of ["$fourth-wall", "$completion-contract"]) {
      expect(root).not.toContain(obsoleteSkill);
      expect(subagent).not.toContain(obsoleteSkill);
    }
    for (const roleDetail of ["Luna Max", "Terra Medium", "Sol High"]) {
      expect(root).not.toContain(roleDetail);
      expect(subagent).not.toContain(roleDetail);
    }
  });

  test("canonical execution-safety policy permits only verified user-authorized Git surgery", () => {
    const policy = readFileSync(resolve(import.meta.dir, "../../../assets/auto_review_policy.md"), "utf8");

    expect(policy).toContain("Explicit current-task user authority");
    for (const operation of ["rebase", "cherry-pick", "reset", "exact-path restore", "branch or ref deletion", "force-push"]) {
      expect(policy).toContain(operation);
    }
    for (const boundary of [
      "exact repository and Git common-dir",
      "configured remote and fetch/push URLs",
      "explicit disposition for every local delta",
      "no concurrent writer",
      "source commits or refs are preserved or recoverable",
      "one exact non-default branch",
      "--force-with-lease",
      "verify final refs, status, and relevant remote URLs",
    ]) {
      expect(policy).toContain(boundary);
    }
    expect(policy).toContain("uncommitted merge");
    expect(policy).toContain("exact named-path restore to `HEAD`");
    expect(policy).toContain("not blanket permission for broad refspecs, default or protected branches, globs or unknown paths");
    expect(policy).toContain("Do not require additive patch re-expression solely because the authorized operation changes history");
    for (const allowedShape of [
      "resetting to one verified ref before a rebase",
      "rebasing a detached checkout from a preserved published tip",
      "cherry-picking one exact commit",
      "restoring exact known unrelated paths during an uncommitted merge",
      "deleting one exact integrated or deliberately abandoned branch",
      "force-pushing one exact non-default branch with lease protection",
    ]) {
      expect(policy).toContain(allowedShape);
    }

    expect(policy).toContain("Ensure the exact command remains within ordinary tool approval");
  });

  test("Skizzles instructions configure fixed capability-bearing generated roles", () => {
    const agents = {
      default: { description: "Default Luna", configFile: "/skizzles/assets/agents/default.toml" },
      worker: { description: "Worker Luna xhigh", configFile: "/skizzles/assets/agents/worker.toml" },
      explorer: { description: "Explorer Terra", configFile: "/skizzles/assets/agents/explorer.toml" },
    };
    const edits = desiredConfigEdits("passive", {
      sourceRoot: "/skizzles",
      rootInstructions: "/skizzles/assets/root.md",
      subagentInstructions: "/skizzles/assets/subagent.md",
      agents,
    });

    expect(edits.slice(0, 2)).toEqual([
      { keyPath: "features.hooks", value: true, mergeStrategy: "replace" },
      { keyPath: "model_instructions_file", value: "/skizzles/assets/root.md", mergeStrategy: "replace" },
    ]);
    expect(edits.slice(2)).toEqual([{
      keyPath: "agents",
      value: Object.fromEntries(Object.entries(agents).map(([agentType, agent]) => [agentType, {
        description: agent.description,
        config_file: agent.configFile,
      }])),
      mergeStrategy: "replace",
    }]);
  });

  test("generated roles bind durable capability while templates remain model agnostic", () => {
    const roleRoot = resolve(import.meta.dir, "../../../assets/agents");
    const templateRoot = resolve(import.meta.dir, "../../../assets/agent-role-templates");
    const manifest = JSON.parse(readFileSync(join(roleRoot, "manifest.json"), "utf8")) as {
      agents: Array<{ agentType: string; behavior: string; model: string; reasoningEffort: string; configFile: string }>;
    };
    expect(manifest.agents.map(({ agentType }) => agentType).sort()).toEqual([
      "default", "explorer", "review", "worker",
    ]);
    for (const agent of manifest.agents) {
      const contents = readFileSync(join(roleRoot, agent.configFile), "utf8");
      expect(contents).toContain('model_instructions_file = "../skizzles_subagent_instructions.md"');
      const parsed = Bun.TOML.parse(contents) as { model?: string; model_reasoning_effort?: string; developer_instructions?: string };
      expect(parsed.model).toBe(agent.model);
      expect(parsed.model_reasoning_effort).toBe(agent.reasoningEffort);
      expect(parsed.developer_instructions?.trim().length).toBeGreaterThan(0);
    }
    for (const behavior of ["default", "worker", "explorer", "review"]) {
      const template = readFileSync(join(templateRoot, `${behavior}.toml`), "utf8");
      expect(template).not.toMatch(/^model(?:_reasoning_effort)?\s*=/m);
    }
  });

  test("aggressive orchestration uses concise native role hints", () => {
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
    expect(hints.some((hint) => hint.includes("$fourth-wall"))).toBe(false);
    const rootHintKey = "features.multi_agent_v2.root_agent_usage_hint_text";
    const rootHint = edits.find(({ keyPath }) => keyPath === rootHintKey)?.value as string;
    expect(rootHint.length).toBeLessThan(500);
    expect(rootHint).toContain("Luna Max");
    expect(rootHint).toContain("Terra Medium");
    expect(rootHint).toContain("Sol High");
    expect(rootHint).toContain("one adversarial Review of a frozen coherent candidate");
    const nonRootHints = edits
      .filter(({ keyPath }) => keyPath !== rootHintKey && keyPath.endsWith("_hint_text"))
      .map(({ value }) => value as string);
    expect(nonRootHints.every((hint) => hint.length < 500)).toBe(true);
    expect(nonRootHints.some((hint) => hint.includes("Fan out genuinely independent work"))).toBe(true);
    expect(nonRootHints.some((hint) => hint.includes("Complete the assigned coherent slice"))).toBe(true);
    expect(edits[2]?.value).toBe(14);
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
      agents: {
        default: { description: "Personal default", config_file: "/personal/agent.toml", nickname_candidates: ["Ada"] },
        explorer: { description: "Personal explorer", config_file: "/personal/explorer.toml", nickname_candidates: ["Grace"] },
      },
    });
    const sourceRoot = join(f.codexHome, "skizzles");
    writeInstructionFixture(sourceRoot);
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
          description: "Fixture default",
          config_file: join(canonicalSourceRoot, "assets", "agents", "default.toml"),
          nickname_candidates: ["Ada"],
        },
        explorer: {
          description: "Fixture explorer",
          config_file: join(canonicalSourceRoot, "assets", "agents", "explorer.toml"),
          nickname_candidates: ["Grace"],
        },
        review: { description: "Fixture review", config_file: join(canonicalSourceRoot, "assets", "agents", "review.toml") },
      },
    });

    f.rpc.closed = false;
    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.config).toEqual({
      model_instructions_file: "/personal/root.md",
      agents: {
        default: { description: "Personal default", config_file: "/personal/agent.toml", nickname_candidates: ["Ada"] },
        explorer: { description: "Personal explorer", config_file: "/personal/explorer.toml", nickname_candidates: ["Grace"] },
      },
      features: {},
    });
  });

  test("restores an initially absent agents table without role tombstones", async () => {
    const f = fixture({});
    const sourceRoot = join(f.codexHome, "skizzles");
    writeInstructionFixture(sourceRoot);

    await configureCodex({
      ...f,
      orchestration: "passive",
      instructions: "skizzles",
      sourceRoot,
      rpcFactory: factory(f.rpc),
    });
    expect(f.rpc.config.agents).toBeDefined();

    f.rpc.closed = false;
    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.config).toEqual({ features: {} });
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

  test("fails closed when a native role alias targets a missing generated role", async () => {
    const f = fixture({});
    const sourceRoot = join(f.codexHome, "skizzles");
    writeInstructionFixture(sourceRoot, { investigator: "missing" });

    await expect(configureCodex({
      ...f,
      orchestration: "passive",
      instructions: "skizzles",
      sourceRoot,
      rpcFactory: factory(f.rpc),
    })).rejects.toThrow("invalid native role alias");
    expect(f.rpc.writes).toBe(0);
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });

  test("fails closed when a native role alias collides with a generated role", async () => {
    const f = fixture({});
    const sourceRoot = join(f.codexHome, "skizzles");
    writeInstructionFixture(sourceRoot, { explorer: "worker" });

    await expect(configureCodex({
      ...f,
      orchestration: "passive",
      instructions: "skizzles",
      sourceRoot,
      rpcFactory: factory(f.rpc),
    })).rejects.toThrow("invalid native role alias");
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
