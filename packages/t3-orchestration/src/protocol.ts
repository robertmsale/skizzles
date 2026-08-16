export type ModelSelection = {
  instanceId: string;
  model: string;
  options: Array<{ id: string; value: string | boolean | number }>;
};

export type T3Project = {
  id: string;
  title: string;
  workspaceRoot: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
};

export type T3LatestTurn = {
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
};

export type T3Session = {
  status: string;
  threadId?: string | null;
  activeTurnId?: string | null;
  lastError?: unknown;
  updatedAt?: string;
};

export type T3Thread = {
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: string;
  interactionMode: string;
  worktreePath: string | null;
  branch: string | null;
  latestTurn?: T3LatestTurn | null;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  settledOverride?: "settled" | "active" | null;
  settledAt?: string | null;
  pinnedAt?: string | null;
  pinOrderKey?: string | null;
  deletedAt?: string | null;
  session: T3Session | null;
};

export type T3ThreadShell = T3Thread & {
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
  backgroundLiveness?: "working" | "monitoring" | null;
};

export type T3Message = {
  id: string;
  role: string;
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ThreadPage = {
  beforeCursor: string | null;
  hasMore: boolean;
  snapshotSequence: number;
  threadSequence?: number;
};

export type ThreadSnapshot = {
  snapshotSequence: number;
  thread: T3Thread & { messages: T3Message[] };
  page?: ThreadPage;
};

export type Snapshot = {
  snapshotSequence: number;
  projects: T3Project[];
  threads: T3Thread[];
  updatedAt?: string;
};

export type ShellSnapshot = {
  snapshotSequence: number;
  projects: T3Project[];
  threads: T3ThreadShell[];
  updatedAt: string;
};

export function option(selection: ModelSelection, id: string): unknown {
  return selection.options.find((entry) => entry.id === id)?.value;
}

export function requireSelection(value: unknown, providerDriver?: string): ModelSelection {
  if (!value || typeof value !== "object") throw new Error("Model selection is missing");
  const candidate = value as Partial<ModelSelection>;
  if (typeof candidate.instanceId !== "string" || typeof candidate.model !== "string") {
    throw new Error("Model selection is malformed");
  }
  if (candidate.instanceId.trim() === "" || candidate.model.trim() === "") throw new Error("Model selection has an empty provider or model");
  const driver = providerDriver ?? candidate.instanceId;
  const rawOptions = candidate.options === undefined ? [] : candidate.options;
  if (!Array.isArray(rawOptions)) throw new Error("Model selection is malformed");
  const options = rawOptions.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.trim() === "") throw new Error("Model selection contains a malformed option");
    if (!(typeof entry.value === "string" || typeof entry.value === "boolean" || typeof entry.value === "number")) throw new Error(`Model option '${entry.id}' has an invalid value`);
    return { id: entry.id, value: entry.value };
  });
  if (new Set(options.map((entry) => entry.id)).size !== options.length) throw new Error("Model selection contains duplicate options");
  if (driver === "codex" && !options.some((entry) => entry.id === "reasoningEffort")) {
    throw new Error("Codex reasoning effort is missing");
  }
  return { instanceId: candidate.instanceId, model: candidate.model, options };
}
