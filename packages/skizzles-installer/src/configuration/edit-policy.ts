import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalExistingPath } from "../managed-filesystem";

export type OrchestrationMode = "aggressive" | "passive";
export type InstructionMode = "native" | "skizzles";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ConfigEdit {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: "replace";
}

export interface InstructionAssets {
  sourceRoot: string;
  rootInstructions: string;
  subagentInstructions: string;
  agents: Record<string, { description: string; configFile: string }>;
}

interface AgentManifest {
  version: 1;
  nativeRoleAliases: Record<string, string>;
  agents: Array<{
    agentType: string;
    description: string;
    configFile: string;
  }>;
}

const aggressiveModeHint =
  "Proactive delegation is active. Follow the Fourth Wall skill advertised in the active inventory when orchestration would improve speed or quality.";
const rootHint =
  "Fourth Wall applies. Read the Fourth Wall skill advertised in the active inventory before your first orchestration action.";
const subagentHint = "Fourth Wall applies. Follow the Fourth Wall skill advertised in the active inventory for this assignment.";

export function resolveInstructionAssets(sourceRootInput: string): InstructionAssets {
  const sourceRoot = canonicalExistingPath(sourceRootInput);
  const rootInstructions = join(sourceRoot, "assets", "skizzles_instructions.md");
  const subagentInstructions = join(sourceRoot, "assets", "skizzles_subagent_instructions.md");
  const manifestPath = join(sourceRoot, "assets", "agents", "manifest.json");
  const requiredAssets: Array<[string, string]> = [
    ["rootInstructions", rootInstructions],
    ["subagentInstructions", subagentInstructions],
    ["agents.manifest", manifestPath],
  ];
  for (const [label, path] of requiredAssets) {
    if (!existsSync(path)) throw new Error(`Skizzles ${label} asset is missing: ${path}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AgentManifest;
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.agents) ||
    manifest.agents.length === 0 ||
    !isRecord(manifest.nativeRoleAliases)
  ) {
    throw new Error(`Skizzles agent manifest is invalid: ${manifestPath}`);
  }

  const agents: InstructionAssets["agents"] = {};
  for (const agent of manifest.agents) {
    if (
      !/^[a-z][a-z0-9_]*$/.test(agent.agentType) ||
      !agent.description?.trim() ||
      !/^[a-z][a-z0-9_]*\.toml$/.test(agent.configFile) ||
      Object.hasOwn(agents, agent.agentType)
    ) {
      throw new Error(`Skizzles agent manifest contains an invalid entry: ${manifestPath}`);
    }
    const configFile = join(sourceRoot, "assets", "agents", agent.configFile);
    if (!existsSync(configFile)) throw new Error(`Skizzles agents.${agent.agentType} asset is missing: ${configFile}`);
    agents[agent.agentType] = { description: agent.description, configFile };
  }

  const generatedAgentTypes = new Set(Object.keys(agents));
  for (const [alias, target] of Object.entries(manifest.nativeRoleAliases)) {
    if (!/^[a-z][a-z0-9_]*$/.test(alias) || !/^[a-z][a-z0-9_]*$/.test(target)) {
      throw new Error(`Skizzles agent manifest contains an invalid native role alias ${alias}: ${manifestPath}`);
    }
    if (generatedAgentTypes.has(alias)) {
      throw new Error(`Skizzles agent manifest contains an invalid native role alias ${alias}; it collides with generated agent type: ${manifestPath}`);
    }
    if (!generatedAgentTypes.has(target)) {
      throw new Error(`Skizzles agent manifest contains an invalid native role alias ${alias}; it targets unknown generated agent type ${target}: ${manifestPath}`);
    }
    const targetAgent = agents[target]!;
    agents[alias] = { description: targetAgent.description, configFile: targetAgent.configFile };
  }
  return { sourceRoot, rootInstructions, subagentInstructions, agents };
}

export function desiredConfigEdits(
  orchestration: OrchestrationMode,
  instructionAssets?: InstructionAssets,
  currentConfig: JsonValue = {},
): ConfigEdit[] {
  const edits: ConfigEdit[] = [
    { keyPath: "features.hooks", value: true, mergeStrategy: "replace" },
  ];
  if (instructionAssets) {
    edits.push({
      keyPath: "model_instructions_file",
      value: instructionAssets.rootInstructions,
      mergeStrategy: "replace",
    });
    const configuredRoles = Object.fromEntries(
      Object.entries(instructionAssets.agents).map(([agentType, agent]) => [agentType, {
        description: agent.description,
        config_file: agent.configFile,
      }]),
    ) as JsonValue;
    const existingAgents = valueAt(currentConfig, "agents");
    if (!existingAgents.present) {
      edits.push({ keyPath: "agents", value: configuredRoles, mergeStrategy: "replace" });
    } else {
      for (const [role, agent] of Object.entries(instructionAssets.agents)) {
        const roleConfig = {
          description: agent.description,
          config_file: agent.configFile,
        };
        if (!valueAt(currentConfig, `agents.${role}`).present) {
          edits.push({ keyPath: `agents.${role}`, value: roleConfig, mergeStrategy: "replace" });
        } else {
          edits.push(
            { keyPath: `agents.${role}.description`, value: agent.description, mergeStrategy: "replace" },
            { keyPath: `agents.${role}.config_file`, value: roleConfig.config_file, mergeStrategy: "replace" },
          );
        }
      }
    }
  }
  if (orchestration === "aggressive") {
    edits.push(
      { keyPath: "features.multi_agent_v2.enabled", value: true, mergeStrategy: "replace" },
      {
        keyPath: "features.multi_agent_v2.max_concurrent_threads_per_session",
        value: 14,
        mergeStrategy: "replace",
      },
      {
        keyPath: "features.multi_agent_v2.multi_agent_mode_hint_text",
        value: aggressiveModeHint,
        mergeStrategy: "replace",
      },
      {
        keyPath: "features.multi_agent_v2.root_agent_usage_hint_text",
        value: rootHint,
        mergeStrategy: "replace",
      },
      {
        keyPath: "features.multi_agent_v2.subagent_usage_hint_text",
        value: subagentHint,
        mergeStrategy: "replace",
      },
    );
  }
  return edits;
}

export function valueAt(root: JsonValue, keyPath: string): { present: boolean; value: JsonValue } {
  let current = root;
  for (const segment of keyPath.split(".")) {
    if (current === null || Array.isArray(current) || typeof current !== "object" || !(segment in current)) {
      return { present: false, value: null };
    }
    current = current[segment]!;
  }
  return { present: true, value: current };
}

export function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
