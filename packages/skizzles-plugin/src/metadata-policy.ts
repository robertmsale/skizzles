import { join } from "node:path";
import {
  validateContainerLabDescriptor,
  validateContainerLabRuntime,
} from "./container-lab.ts";
import { rejectForbiddenDistributableContent } from "./distribution-policy.ts";
import { exists, isObject, readJsonObject } from "./file-tree.ts";
import { PackagingError } from "./packaging-error.ts";
import { PLUGIN_NAME } from "./artifact-layout.ts";

export async function validateGeneratedPlugin(
  repoRoot: string,
  pluginRoot: string,
  marketplacePath: string,
): Promise<void> {
  const manifest = await readJsonObject(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    "plugin manifest",
  );
  const rootPackage = await readJsonObject(
    join(repoRoot, "package.json"),
    "root package.json",
  );

  if (manifest.name !== PLUGIN_NAME) {
    throw new PackagingError(`Plugin manifest name must be ${PLUGIN_NAME}.`);
  }
  if (manifest.version !== rootPackage.version) {
    throw new PackagingError("Plugin manifest and root package versions must match.");
  }
  await validateManifest(manifest, pluginRoot);
  if ("hooks" in manifest) {
    throw new PackagingError(
      "plugin.json intentionally omits `hooks`; keep the canonical default discovery path at hooks/hooks.json.",
    );
  }

  validateMarketplaceEntry(
    await readJsonObject(marketplacePath, "marketplace metadata"),
  );

  const hooksPath = join(pluginRoot, "hooks", "hooks.json");
  if (await exists(hooksPath)) {
    validateHookCommands(
      await readJsonObject(hooksPath, "hooks/hooks.json"),
      "hooks/hooks.json",
    );
  }

  await validateContainerLabRuntime(pluginRoot);
  await validateContainerLabDescriptor(repoRoot, pluginRoot);
  await rejectForbiddenDistributableContent(pluginRoot);
}

async function validateManifest(
  manifest: Record<string, unknown>,
  pluginRoot: string,
): Promise<void> {
  if (
    typeof manifest.version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      manifest.version,
    )
  ) {
    throw new PackagingError("Plugin manifest version must be strict semver.");
  }
  if (typeof manifest.description !== "string" || manifest.description.trim() === "") {
    throw new PackagingError("Plugin manifest requires a description.");
  }
  if (
    !isObject(manifest.author) ||
    typeof manifest.author.name !== "string" ||
    manifest.author.name.trim() === ""
  ) {
    throw new PackagingError("Plugin manifest requires author.name.");
  }
  const interfaceValue = manifest.interface;
  if (!isObject(interfaceValue)) {
    throw new PackagingError("Plugin manifest requires interface metadata.");
  }
  for (
    const field of [
      "displayName",
      "shortDescription",
      "longDescription",
      "developerName",
      "category",
    ] as const
  ) {
    if (typeof interfaceValue[field] !== "string" || interfaceValue[field].trim() === "") {
      throw new PackagingError(`Plugin interface requires ${field}.`);
    }
  }
  if (
    !Array.isArray(interfaceValue.capabilities) ||
    !interfaceValue.capabilities.every((value) => typeof value === "string")
  ) {
    throw new PackagingError(
      "Plugin interface capabilities must be an array of strings.",
    );
  }
  if (
    !Array.isArray(interfaceValue.defaultPrompt) ||
    interfaceValue.defaultPrompt.length > 3 ||
    !interfaceValue.defaultPrompt.every(
      (value) => typeof value === "string" && value.length <= 128,
    )
  ) {
    throw new PackagingError(
      "Plugin interface defaultPrompt must contain at most three strings of 128 characters or fewer.",
    );
  }
  for (const field of ["composerIcon", "logo", "logoDark"] as const) {
    const value = interfaceValue[field];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      !value.startsWith("./") ||
      value.includes("..") ||
      !(await exists(join(pluginRoot, value)))
    ) {
      throw new PackagingError(
        `Plugin interface ${field} must reference an existing bundled file.`,
      );
    }
  }
}

function validateMarketplaceEntry(marketplace: Record<string, unknown>): void {
  const plugins = marketplace.plugins;
  if (!Array.isArray(plugins)) {
    throw new PackagingError("Marketplace metadata must contain a plugins array.");
  }
  const entry = plugins.find(
    (candidate): candidate is Record<string, unknown> =>
      isObject(candidate) && candidate.name === PLUGIN_NAME,
  );
  if (entry === undefined) {
    throw new PackagingError(`Marketplace metadata is missing ${PLUGIN_NAME}.`);
  }
  const source = entry.source;
  if (
    !isObject(source) ||
    source.source !== "local" ||
    source.path !== `./plugins/${PLUGIN_NAME}`
  ) {
    throw new PackagingError("Marketplace source must be local at ./plugins/skizzles.");
  }
  const policy = entry.policy;
  if (
    !isObject(policy) ||
    !["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(
      String(policy.installation),
    ) ||
    !["ON_INSTALL", "ON_USE"].includes(String(policy.authentication)) ||
    typeof entry.category !== "string"
  ) {
    throw new PackagingError(
      "Marketplace entry must include installation, authentication, and category metadata.",
    );
  }
}

function validateHookCommands(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateHookCommands(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (key === "command") {
      const commands = typeof item === "string" ? [item] : Array.isArray(item) ? item : [];
      if (
        commands.length === 0 ||
        !commands.every((command) => typeof command === "string")
      ) {
        throw new PackagingError(
          `${itemPath} must be a command string or array of command strings.`,
        );
      }
      for (const command of commands) {
        if (!command.includes("${PLUGIN_ROOT}")) {
          throw new PackagingError(
            `${itemPath} must resolve bundled commands through \${PLUGIN_ROOT}.`,
          );
        }
      }
    }
    validateHookCommands(item, itemPath);
  }
}
