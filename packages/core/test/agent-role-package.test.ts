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
  test("renders the preferred routing pairs and gradual Worker ladder", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const files = await renderAgentRoles(repoRoot);
    const manifest = JSON.parse(files.get("manifest.json")!) as {
      routes: Record<string, string>;
      agents: Array<{ agentType: string; behavior: string; capability: string }>;
    };

    expect(manifest.routes).toEqual({
      mechanical: "luna_medium",
      scoped: "luna_high",
      broad: "terra_medium",
      standard: "terra_medium",
      complex: "sol_medium",
      specialized: "sol_high",
      critical: "sol_xhigh",
    });
    expect(manifest.agents.filter(({ behavior }) => behavior === "worker").map(({ capability }) => capability)).toEqual([
      "luna_medium", "luna_high", "luna_xhigh", "luna_max",
      "terra_medium", "terra_high", "terra_xhigh", "terra_max",
      "sol_medium", "sol_high", "sol_xhigh", "sol_max",
    ]);
    expect(files.get("worker.toml")).toContain('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "high"');
    expect(files.get("review_sol_xhigh.toml")).toContain('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "xhigh"');
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
