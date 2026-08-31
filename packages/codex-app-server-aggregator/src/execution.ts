export const EXECUTION_MODES = ["host", "container"] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const DEFAULT_EXECUTION_MODE: ExecutionMode = "container";
export const HOST_MACHINE_ID = "host";

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === "host" || value === "container";
}
