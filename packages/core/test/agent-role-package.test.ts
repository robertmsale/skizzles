import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentRolePackagingError,
  buildAgentRoles,
  checkAgentRoles,
  renderAgentRoles,
} from "../src/agent-role-package";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("capability-bearing agent role generation", () => {
  test("renders exactly the fixed role matrix without capability variants", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const files = await renderAgentRoles(repoRoot);
    const manifest = JSON.parse(files.get("manifest.json")!) as {
      routes: Record<string, string>;
      nativeRoleAliases: Record<string, string>;
      agents: Array<{ agentType: string; behavior: string; model: string; reasoningEffort: string }>;
    };

    expect(manifest.routes).toEqual({});
    expect(manifest.nativeRoleAliases).toEqual({ explorer: "triage" });
    expect(manifest.agents.map(({ agentType, model, reasoningEffort }) => ({ agentType, model, reasoningEffort }))).toEqual([
      { agentType: "default", model: "gpt-5.6-luna", reasoningEffort: "max" },
      { agentType: "triage", model: "gpt-5.6-terra", reasoningEffort: "medium" },
      { agentType: "worker", model: "gpt-5.6-luna", reasoningEffort: "max" },
      { agentType: "designer", model: "gpt-5.6-luna", reasoningEffort: "max" },
      { agentType: "qa", model: "gpt-5.6-luna", reasoningEffort: "max" },
      { agentType: "review", model: "gpt-5.6-sol", reasoningEffort: "high" },
      { agentType: "deployment", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    ]);
    expect([...files.keys()].sort()).toEqual([
      "default.toml", "deployment.toml", "designer.toml", "manifest.json",
      "qa.toml", "review.toml", "triage.toml", "worker.toml",
    ]);
    expect(files.get("worker.toml")).toContain('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "max"');
  });

  test("rejects native aliases that target an unknown generated role", async () => {
    const sourceRoot = resolve(import.meta.dir, "../../..");
    const root = await mkdtemp(join(tmpdir(), "skizzles-agent-roles-"));
    roots.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    const spec = JSON.parse(await Bun.file(join(sourceRoot, "assets", "agent-role-spec.json")).text());
    spec.nativeRoleAliases.explorer = "missing";
    await writeFile(join(root, "assets", "agent-role-spec.json"), `${JSON.stringify(spec)}\n`);
    await cp(join(sourceRoot, "assets", "agent-role-templates"), join(root, "assets", "agent-role-templates"), { recursive: true });

    expect(renderAgentRoles(root)).rejects.toThrow("targets unknown generated agent type missing");
  });

  test("rejects native aliases that collide with generated roles", async () => {
    const sourceRoot = resolve(import.meta.dir, "../../..");
    const root = await mkdtemp(join(tmpdir(), "skizzles-agent-roles-"));
    roots.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    const spec = JSON.parse(await Bun.file(join(sourceRoot, "assets", "agent-role-spec.json")).text());
    spec.nativeRoleAliases.triage = "triage";
    await writeFile(join(root, "assets", "agent-role-spec.json"), `${JSON.stringify(spec)}\n`);
    await cp(join(sourceRoot, "assets", "agent-role-templates"), join(root, "assets", "agent-role-templates"), { recursive: true });

    expect(renderAgentRoles(root)).rejects.toThrow("collides with generated agent type");
  });

  test("renders differentiating duties within the role-overlay budget", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const files = await renderAgentRoles(repoRoot);

    expect(files.get("worker.toml")).toContain("Workers are leaves");
    expect(files.get("worker.toml")).toContain("unverified claim");
    expect(files.get("triage.toml")).toContain("product source and durable project configuration read-only");
    expect(files.get("triage.toml")).toContain("causal chain");
    expect(files.get("review.toml")).toContain("Independently and adversarially");
    expect(files.get("review.toml")).toContain("The root retains final acceptance");
    expect(files.get("qa.toml")).toContain("Do not silently implement fixes");
    expect(files.get("designer.toml")).toContain("visual proof");
    expect(files.get("deployment.toml")).toContain("explicit authorization");

    for (const role of ["default", "triage", "worker", "designer", "qa", "review", "deployment"]) {
      const config = Bun.TOML.parse(files.get(`${role}.toml`)!) as { developer_instructions?: unknown };
      expect(typeof config.developer_instructions).toBe("string");
      const words = (config.developer_instructions as string).match(/\S+/g) ?? [];
      expect(words.length).toBeLessThanOrEqual(role === "deployment" ? 250 : 200);
    }
  });

  test("build and check reject generated drift", async () => {
    const sourceRoot = resolve(import.meta.dir, "../../..");
    const root = await mkdtemp(join(tmpdir(), "skizzles-agent-roles-"));
    roots.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await cp(join(sourceRoot, "assets", "agent-role-spec.json"), join(root, "assets", "agent-role-spec.json"));
    await cp(join(sourceRoot, "assets", "agent-role-templates"), join(root, "assets", "agent-role-templates"), { recursive: true });

    await buildAgentRoles(root);
    await checkAgentRoles(root);
    await writeFile(join(root, "assets", "agents", "worker.toml"), "drift\n");
    expect(checkAgentRoles(root)).rejects.toThrow("changed worker.toml");
  });

  test("templates cannot smuggle an independent capability", async () => {
    const sourceRoot = resolve(import.meta.dir, "../../..");
    const root = await mkdtemp(join(tmpdir(), "skizzles-agent-roles-"));
    roots.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await cp(join(sourceRoot, "assets", "agent-role-spec.json"), join(root, "assets", "agent-role-spec.json"));
    await cp(join(sourceRoot, "assets", "agent-role-templates"), join(root, "assets", "agent-role-templates"), { recursive: true });
    await writeFile(join(root, "assets", "agent-role-templates", "worker.toml"), 'model = "wrong"\n');

    expect(renderAgentRoles(root)).rejects.toBeInstanceOf(AgentRolePackagingError);
  });

  test("rejects role identifiers before constructing asset paths", async () => {
    const sourceRoot = resolve(import.meta.dir, "../../..");
    const root = await mkdtemp(join(tmpdir(), "skizzles-agent-roles-"));
    roots.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    const spec = JSON.parse(await Bun.file(join(sourceRoot, "assets", "agent-role-spec.json")).text());
    spec.roles[0].behavior = "../outside";
    await writeFile(join(root, "assets", "agent-role-spec.json"), `${JSON.stringify(spec)}\n`);
    await cp(join(sourceRoot, "assets", "agent-role-templates"), join(root, "assets", "agent-role-templates"), { recursive: true });

    expect(renderAgentRoles(root)).rejects.toThrow("Invalid role behavior ../outside");
  });

  test("parses templates before rejecting quoted capability keys", async () => {
    const sourceRoot = resolve(import.meta.dir, "../../..");
    const root = await mkdtemp(join(tmpdir(), "skizzles-agent-roles-"));
    roots.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await cp(join(sourceRoot, "assets", "agent-role-spec.json"), join(root, "assets", "agent-role-spec.json"));
    await cp(join(sourceRoot, "assets", "agent-role-templates"), join(root, "assets", "agent-role-templates"), { recursive: true });
    await writeFile(join(root, "assets", "agent-role-templates", "worker.toml"), '\n  "model" = "wrong"\n');

    expect(renderAgentRoles(root)).rejects.toThrow("must not select capability");
  });
});
