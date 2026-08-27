export type RpcId = string | number;

export type RpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type RpcRequest = {
  method: string;
  id: RpcId;
  params?: unknown;
};

export type RpcNotification = {
  method: string;
  params?: unknown;
  emittedAtMs?: number;
};

export type RpcOutcome = { result: unknown } | { error: RpcError };
export type RpcResponse = ({ id: RpcId } & RpcOutcome);
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export function isRequest(message: RpcMessage): message is RpcRequest {
  return "method" in message && "id" in message;
}

export function isNotification(message: RpcMessage): message is RpcNotification {
  return "method" in message && !("id" in message);
}

export function isResponse(message: RpcMessage): message is RpcResponse {
  return "id" in message && !("method" in message) && ("result" in message || "error" in message);
}

export function parseRpcMessage(value: unknown): RpcMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("app-server frame is not a JSON object");
  }
  const message = value as Record<string, unknown>;
  if (typeof message.method === "string") {
    if ("id" in message && !isRpcId(message.id)) throw new Error("app-server request id must be a string or number");
    return message as RpcRequest | RpcNotification;
  }
  if (!isRpcId(message.id) || (!("result" in message) && !("error" in message))) {
    throw new Error("app-server frame is not a request, notification, or response");
  }
  return message as RpcResponse;
}

export function errorOutcome(code: number, message: string, data?: unknown): { error: RpcError } {
  return data === undefined ? { error: { code, message } } : { error: { code, message, data } };
}

export function response(id: RpcId, outcome: RpcOutcome): RpcResponse {
  return { id, ...outcome };
}

export function idKey(id: RpcId): string {
  return `${typeof id}:${id}`;
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
