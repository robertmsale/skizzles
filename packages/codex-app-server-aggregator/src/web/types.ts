import type { RpcNotification, RpcRequest } from "../protocol.ts";

export type {
  AppThreadDto,
  LiveSseEventDto,
  ServerRequestStreamDto,
  SnapshotSseEventDto,
  SseStreamEventDto,
  TimelineAvailableDto,
  TimelineHistoryPageDto as SseTimelineHistoryPageDto,
  TimelineEntryDto as SseTimelineEntryDto,
  TimelinePageDto as SseTimelinePageDto,
  TimelineStreamEntryDto,
} from "../sse.ts";

export type ProjectDto = {
  cwd: string;
  cloneUrl: string | null;
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
  kind: "host" | "container";
  projectCwd: string | null;
  containerId: string | null;
  state: "active" | "orphaned" | "removed";
  dockerStatus: string | null;
  threadIds: string[];
  threads: Array<{
    threadId: string;
    projectCwd: string;
    executionMode: "host" | "container";
  }>;
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

export type ThreadPageDto = {
  data: ThreadDto[];
  nextCursor: string | null;
  backwardsCursor?: string | null;
};

export type LoadedThreadPageDto = {
  data: string[];
  nextCursor: string | null;
};

export type TimelineEntry = {
  key: string;
  role: "user" | "assistant" | "tool";
  label: string;
  text: string;
  status?: string;
  raw?: ThreadItemDto;
};
