import type { LabConfig } from "../compose/config";
import type { ComposeInspectionFinding } from "../compose/definition";

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
  /** Last successful authenticated Container Lab operation. Legacy manifests may omit it. */
  lastActivityAt?: string;
  endpoints: Endpoint[];
  findings: ComposeInspectionFinding[];
  secretEnvironment: string[];
  managedImage?: string;
  error?: string;
  runtime?: PersistedLabRuntime;
};

export type OwnerManifest = {
  version: 1;
  owner: string;
  ownerKey: string;
  createdAt: string;
};
