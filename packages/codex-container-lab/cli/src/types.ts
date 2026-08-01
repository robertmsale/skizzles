import type { LabConfig } from "./config";
import type { ComposeInspectionFinding } from "./compose";

export type LabState = "provisioning" | "ready" | "failed" | "destroying";

export type Endpoint = {
  name: string;
  service: string;
  target: number;
  url: string;
};

export type PersistedLabRuntime = {
  config: LabConfig;
  composeArgs: string[];
  baseFile?: string;
  overrideFile: string;
  findings: ComposeInspectionFinding[];
};

/**
 * A bounded, structured snapshot captured while a lab is provisioning.
 *
 * This deliberately contains no Docker ids, Compose project names, owner
 * material, or filesystem paths.  The optional evidence descriptor refers to
 * an owner-scoped diagnostic through the service API; it is never a path.
 */
export type ProvisioningFailureDiagnostic = {
  phase: "compose-up";
  capturedAt: string;
  services: Array<{
    service: string;
    state: string;
    health?: string;
    exitCode?: number;
  }>;
  serviceCount: number;
  evidence?: {
    kind: "compose-up";
    available: boolean;
    bytes: number;
    lines: number;
    truncated: boolean;
  };
};

export type LabMetadata = {
  version: 1;
  id: string;
  name: string;
  owner: string;
  ownerKey: string;
  repoHash: string;
  composeProject: string;
  state: LabState;
  sourceRoot: string;
  runtimeRoot: string;
  workspace: string;
  manifestPath: string;
  commandService: string;
  modeKind?: LabConfig["mode"]["kind"];
  createdAt: string;
  updatedAt: string;
  endpoints: Endpoint[];
  findings: ComposeInspectionFinding[];
  secretEnvironment: string[];
  managedImage?: string;
  error?: string;
  provisioningFailure?: ProvisioningFailureDiagnostic;
  runtime?: PersistedLabRuntime;
};

export type OwnerManifest = {
  version: 1;
  owner: string;
  ownerKey: string;
  createdAt: string;
};
