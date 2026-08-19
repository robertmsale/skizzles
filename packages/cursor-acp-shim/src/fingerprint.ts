const MAX_DEATH_TEXT_CHARS = 1_500;

const CURSOR_ADAPTER_PREFIX = /^(?:error:\s+)/i;
const CONNECT_ERROR = /\bconnecterror\b/i;
const GRPC_TRANSPORT = /\[(?:unavailable|aborted|internal|unknown|cancelled)\]/i;
const HTTP2_CANCEL = /http\/2[^\n]{0,120}\bcancel\b|\bnghttp2_cancel\b|\berr_http2_(?:stream_cancel|invalid_stream|session_error)\b/i;
const STREAM_RESET = /\b(?:stream (?:was )?reset|rst_stream|http\/2:\s*stream half-closed)\b/i;
const NODE_TRANSPORT = /\b(?:econnreset|enotfound|econnrefused|eai_again|und_err_socket|und_err_closed|und_err_destroyed)\b/i;
const SERVER_COPY = /something went wrong communicating with the server/i;
const SHORT_SERVER_COPY = /^something went wrong(?: communicating with the server)?\.?\s*(?:please try again\.?)?$/i;
const STREAM_DROPPED = /stream ended without turnended|connection likely dropped mid-stream/i;
const AUTH_OR_PLAN = /\[unauthenticated\]|please sign in to continue|upgrade your plan to continue|add a payment method to continue/i;
const DEBUGGING_APP = /\b(?:in the app you are debugging|handler returned|status(?: code)?\s*[1-5]\d\d)\b/i;

export function isSpuriousNetworkDeath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_DEATH_TEXT_CHARS) return false;
  if (AUTH_OR_PLAN.test(trimmed)) return false;
  if (DEBUGGING_APP.test(trimmed)) return false;
  if (trimmed.includes("```") && trimmed.length > 200) return false;

  const adapterPrefixed = CURSOR_ADAPTER_PREFIX.test(trimmed);
  const transport = CONNECT_ERROR.test(trimmed)
    || GRPC_TRANSPORT.test(trimmed)
    || HTTP2_CANCEL.test(trimmed)
    || STREAM_RESET.test(trimmed)
    || NODE_TRANSPORT.test(trimmed)
    || SERVER_COPY.test(trimmed)
    || STREAM_DROPPED.test(trimmed);

  if (adapterPrefixed) return transport;
  if (SHORT_SERVER_COPY.test(trimmed)) return true;
  if (STREAM_DROPPED.test(trimmed)) return true;
  if (CONNECT_ERROR.test(trimmed) && (GRPC_TRANSPORT.test(trimmed) || NODE_TRANSPORT.test(trimmed) || HTTP2_CANCEL.test(trimmed) || STREAM_RESET.test(trimmed))) {
    return true;
  }
  if ((HTTP2_CANCEL.test(trimmed) || STREAM_RESET.test(trimmed)) && trimmed.length < 400 && /^(?:error:|connecterror:|http\/2|stream )/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function extractAssistantText(message: unknown): string {
  const record = asRecord(message);
  if (!record) return "";
  const params = asRecord(record.params);
  const update = asRecord(params?.update) ?? asRecord(record.update);
  if (!update) return "";
  const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return "";
  return contentText(update.content);
}

export function sessionUpdateKind(message: unknown): string | undefined {
  const record = asRecord(message);
  const params = asRecord(record?.params);
  const update = asRecord(params?.update) ?? asRecord(record?.update);
  return typeof update?.sessionUpdate === "string" ? update.sessionUpdate : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  const record = asRecord(content);
  if (!record) {
    if (Array.isArray(content)) return content.map(contentText).join("");
    return "";
  }
  if (typeof record.text === "string") return record.text;
  if (record.content !== undefined) return contentText(record.content);
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
