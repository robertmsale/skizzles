import type { RpcNotification, RpcRequest } from "../protocol.ts";

export type ProjectDto = {
  cwd: string;
  cloneUrl: string;
  createdAt: number;
  updatedAt: number;
};

export type ThreadItemDto = Record<string, unknown> & { id?: string; type?: string };
export type TurnDto = Record<string, unknown> & { id: string; items?: ThreadItemDto[] };
export type ThreadDto = Record<string, unknown> & {
  id: string;
  cwd: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number;
  status?: { type?: string };
  turns?: TurnDto[];
};

export type ThreadView = ThreadDto & {
  lifecycle: "live" | "snapshot" | "archived";
};

export type MachineDto = {
  machineId: string;
  projectCwd: string;
  containerId: string;
  state: "active" | "orphaned" | "removed";
  dockerStatus: string | null;
};

export type ServerRequestDto = RpcRequest;
export type EventRecordDto = { cursor: number; event: RpcNotification };
export type EventPageDto = {
  data: EventRecordDto[];
  nextCursor: number;
  oldestCursor: number;
  streamId: string;
  gap: false;
  restarted: false;
};

export type TimelineEntry = {
  key: string;
  role: "user" | "assistant" | "tool";
  label: string;
  text: string;
  status?: string;
  raw?: ThreadItemDto;
};
