import { stringify as stringifyYaml } from "yaml";
import type { LabConfig } from "./config";

export interface ComposeModel {
  services?: Record<string, Record<string, unknown>>;
  volumes?: Record<string, Record<string, unknown> | null>;
  networks?: Record<string, Record<string, unknown> | null>;
  secrets?: Record<string, unknown>;
  configs?: Record<string, unknown>;
}

export interface LabComposeContext {
  workspaceHostPath: string;
  owner: string;
  ownerKey: string;
  labId: string;
}

const labelPrefix = "io.openai.codex-container-lab";

export function generateBaseCompose(config: LabConfig): string | undefined {
  if (config.mode.kind === "compose") return undefined;
  const service: Record<string, unknown> = {
    working_dir: config.runtime.workspace,
    command: [...config.runtime.shell, "while :; do sleep 2147483647; done"],
  };
  if (config.mode.kind === "image") {
    service.image = config.mode.image;
  } else {
    service.build = {
      context: config.mode.context,
      dockerfile: config.mode.dockerfile,
    };
  }
  return stringifyYaml({ services: { [config.mode.commandService]: service } });
}

export function generateOverrideCompose(config: LabConfig, model: ComposeModel, context: LabComposeContext): string {
  const labels = managementLabels(context);
  const serviceNames = Object.keys(model.services ?? {});
  if (!serviceNames.includes(config.mode.commandService)) {
    throw new Error(`command service is absent from normalized Compose model: ${config.mode.commandService}`);
  }
  for (const port of config.ports) {
    if (!serviceNames.includes(port.service)) {
      throw new Error(`declared port ${port.name} references absent service: ${port.service}`);
    }
    const existing = asArray(model.services?.[port.service]?.ports).some((published) => publishedTarget(published) === port.target);
    if (existing) throw new Error(`declared port ${port.name} overlaps a project publication for ${port.service}:${port.target}`);
  }

  const services = Object.fromEntries(serviceNames.map((name) => {
    const override: Record<string, unknown> = { labels };
    if (name === config.mode.commandService) {
      override.init = true;
      override.working_dir = config.runtime.workspace;
      override.volumes = [
        { type: "bind", source: context.workspaceHostPath, target: config.runtime.workspace },
      ];
      if (config.forwardEnvironment.length > 0) {
        // List form asks Compose to forward only these explicitly declared host names.
        override.environment = config.forwardEnvironment;
      }
      if (config.mode.kind === "dockerfile") {
        override.image = internalImageTag(context.ownerKey, context.labId);
        // Service labels apply to containers; build labels establish ownership on
        // the internally built image itself so cleanup can verify it independently.
        override.build = { labels };
      }
    }
    const servicePorts = config.ports.filter((port) => port.service === name);
    if (servicePorts.length > 0) {
      override.ports = servicePorts.map(({ target }) => `127.0.0.1::${target}`);
    }
    return [name, override];
  }));

  const volumes = labelTopLevelResources(model.volumes, labels);
  const networks = labelTopLevelResources(model.networks, labels);
  return stringifyYaml({
    services,
    ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
    ...(Object.keys(networks).length > 0 ? { networks } : {}),
  });
}

function managementLabels(context: LabComposeContext): Record<string, string> {
  return {
    [`${labelPrefix}.managed`]: "true",
    [`${labelPrefix}.owner`]: context.owner,
    [`${labelPrefix}.lab`]: context.labId,
  };
}

function labelTopLevelResources(
  resources: Record<string, Record<string, unknown> | null> | undefined,
  labels: Record<string, string>,
): Record<string, { labels: Record<string, string> }> {
  return Object.fromEntries(Object.entries(resources ?? {})
    .filter(([, definition]) => !definition?.external)
    .map(([name]) => [name, { labels }]));
}

export interface ComposeCommandOptions {
  projectName: string;
  overrideFile: string;
  baseFile?: string;
}

/** Arguments following the docker executable. File ordering is semantically significant. */
export function composeCommandArgs(config: LabConfig, options: ComposeCommandOptions): string[] {
  const sourceFiles = config.mode.kind === "compose"
    ? config.mode.files
    : options.baseFile ? [options.baseFile] : [];
  if (sourceFiles.length === 0) {
    throw new Error("an internal base Compose file is required for image and dockerfile modes");
  }
  return [
    "compose",
    "--project-directory", config.repoRoot,
    "--project-name", options.projectName,
    ...sourceFiles.flatMap((file) => ["-f", file]),
    "-f", options.overrideFile,
  ];
}

export type PrivilegeSurface =
  | "host-bind"
  | "socket-bind"
  | "privileged"
  | "host-namespace"
  | "device"
  | "capability"
  | "secret"
  | "config"
  | "fixed-port"
  | "non-loopback-port";

export interface ComposeInspectionFinding {
  service?: string;
  surface: PrivilegeSurface;
  detail: string;
}

export function internalImageTag(ownerKey: string, labId: string): string {
  return `codex-container-lab:${ownerKey.slice(0, 24)}-${labId}`;
}

/** Report trusted-project privilege surfaces without returning paths, values, or secret names. */
export function inspectComposeModel(model: ComposeModel): ComposeInspectionFinding[] {
  const findings: ComposeInspectionFinding[] = [];
  for (const [serviceName, service] of Object.entries(model.services ?? {})) {
    if (service.use_api_socket === true) add(findings, serviceName, "socket-bind", "container engine API socket enabled; details redacted");
    if (service.privileged === true) add(findings, serviceName, "privileged", "privileged mode enabled");
    for (const key of ["pid", "ipc", "network_mode", "uts", "userns_mode", "cgroup"] as const) {
      if (service[key] === "host") add(findings, serviceName, "host-namespace", `${key} uses host namespace`);
    }
    const capabilities = asArray(service.cap_add);
    if (capabilities.length > 0) add(findings, serviceName, "capability", `${capabilities.length} added capability(s)`);
    const devices = asArray(service.devices);
    if (devices.length > 0) add(findings, serviceName, "device", `${devices.length} host device mapping(s); paths redacted`);

    for (const volume of asArray(service.volumes)) inspectVolume(findings, serviceName, volume);
    for (const port of asArray(service.ports)) inspectPort(findings, serviceName, port);

    const secrets = asArray(service.secrets);
    if (secrets.length > 0) add(findings, serviceName, "secret", `${secrets.length} secret attachment(s); names redacted`);
    const configs = asArray(service.configs);
    if (configs.length > 0) add(findings, serviceName, "config", `${configs.length} config attachment(s); names redacted`);
    if (isRecord(service.build)) {
      const ssh = service.build.ssh;
      if ((Array.isArray(ssh) && ssh.length > 0) || (isRecord(ssh) && Object.keys(ssh).length > 0) || typeof ssh === "string") {
        add(findings, serviceName, "secret", "build SSH forwarding enabled; identities redacted");
      }
      const buildSecrets = asArray(service.build.secrets);
      if (buildSecrets.length > 0) add(findings, serviceName, "secret", `${buildSecrets.length} build secret attachment(s); names redacted`);
    }
  }
  const topSecrets = Object.keys(model.secrets ?? {}).length;
  if (topSecrets > 0) findings.push({ surface: "secret", detail: `${topSecrets} top-level secret definition(s); names redacted` });
  const topConfigs = Object.keys(model.configs ?? {}).length;
  if (topConfigs > 0) findings.push({ surface: "config", detail: `${topConfigs} top-level config definition(s); names redacted` });
  return findings;
}

function inspectVolume(findings: ComposeInspectionFinding[], service: string, volume: unknown): void {
  let isBind = false;
  let source = "";
  if (typeof volume === "string") {
    source = volume.split(":", 1)[0] ?? "";
    isBind = source.startsWith("/") || source.startsWith(".") || source.startsWith("~");
  } else if (isRecord(volume)) {
    isBind = volume.type === "bind";
    source = typeof volume.source === "string" ? volume.source : "";
  }
  if (!isBind) return;
  add(findings, service, "host-bind", "host bind mount; path redacted");
  if (/(?:^|\/)docker\.sock$|(?:^|\/)podman\.sock$|\.sock$/i.test(source)) {
    add(findings, service, "socket-bind", "host socket bind mount; path redacted");
  }
}

function inspectPort(findings: ComposeInspectionFinding[], service: string, port: unknown): void {
  let hostIp: string | undefined;
  let published: string | undefined;
  if (typeof port === "string") {
    const raw = port.split("/")[0] ?? "";
    const parts = raw.split(":");
    if (parts.length === 3) [hostIp, published] = parts;
    else if (parts.length === 2) published = parts[0];
  } else if (isRecord(port)) {
    hostIp = typeof port.host_ip === "string" ? port.host_ip : undefined;
    published = port.published === undefined ? undefined : String(port.published);
  }
  if (published && published !== "0") add(findings, service, "fixed-port", "fixed host port publication; port redacted");
  if (published !== undefined && hostIp !== "127.0.0.1" && hostIp !== "::1" && hostIp !== "localhost") {
    add(findings, service, "non-loopback-port", "port is published beyond explicit loopback; address redacted");
  }
}

function publishedTarget(port: unknown): number | undefined {
  if (typeof port === "string") {
    const target = (port.split("/")[0] ?? "").split(":").at(-1);
    const parsed = Number(target);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  if (isRecord(port)) {
    const parsed = Number(port.target);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function add(findings: ComposeInspectionFinding[], service: string, surface: PrivilegeSurface, detail: string): void {
  findings.push({ service, surface, detail });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
