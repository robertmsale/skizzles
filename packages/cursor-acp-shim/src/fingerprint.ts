const MAX_DEATH_TEXT_CHARS = 1_500;

const CURSOR_ADAPTER_PREFIX = /^(?:error:\s+)/i;
const CONNECT_ERROR = /^connecterror:/i;
const RETRIABLE_ERROR = /^retriableerror:/i;
const GRPC_TRANSPORT = /\[(?:unavailable|aborted|internal|unknown|cancelled)\]/i;
const HTTP2_CANCEL = /http\/2[^\n]{0,120}\bcancel\b|\bnghttp2_cancel\b|\berr_http2_(?:stream_cancel|invalid_stream|session_error)\b/i;
const STREAM_RESET = /\b(?:stream (?:was )?reset|rst_stream|http\/2:\s*stream half-closed)\b/i;
const NODE_TRANSPORT = /\b(?:econnreset|enotfound|econnrefused|eai_again|und_err_socket|und_err_closed|und_err_destroyed)\b/i;
const SHORT_SERVER_COPY = /^something went wrong(?: communicating with the server)?\.?\s*(?:please try again\.?)?$/i;
const STREAM_DROPPED = /stream ended without turnended|connection likely dropped mid-stream/i;
const AUTH_OR_PLAN = /\[unauthenticated\]|please sign in to continue|upgrade your plan to continue|add a payment method to continue/i;
const DEBUGGING_APP = /\b(?:in the app you are debugging|handler returned|status(?: code)?\s*[1-5]\d\d)\b/i;
const ERROR_DUMP_HEAD = /^(?:(?:connect|retriable)error:|http\/2|stream |something went wrong|\[(?:unavailable|aborted|internal|unknown|cancelled)\])/i;
const DUMP_HEADS = [
  "connecterror:",
  "retriableerror:",
  "http/2",
  "stream ",
  "something went wrong",
  "[unavailable]",
  "[aborted]",
  "[internal]",
  "[unknown]",
  "[cancelled]",
];

type TextRange = {
  start: number;
  value: string;
};

export function isSpuriousNetworkDeath(text: string): boolean {
  if (isWholeMessageDump(text)) return true;
  return trailingDumpRange(text, true) !== undefined;
}

export function stripTrailingTransportDump(text: string): string {
  if (isWholeMessageDump(text)) return "";
  const range = trailingDumpRange(text, true);
  if (!range) return text;
  return text.slice(0, range.start).replace(/\s+$/, "");
}

export function visibleAssistantEnd(text: string): number {
  if (couldBecomeWholeMessageDump(text)) return 0;
  const range = trailingDumpRange(text, false);
  return range ? range.start : text.length;
}

function isWholeMessageDump(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_DEATH_TEXT_CHARS) return false;
  if (trimmed.includes("```")) return false;

  const body = CURSOR_ADAPTER_PREFIX.test(trimmed) ? trimmed.replace(CURSOR_ADAPTER_PREFIX, "").trim() : trimmed;
  // Short ACP last-words dumps headed RetriableError: are Cursor's retriable
  // transport class. Classify by that prefix before body-content exclusions;
  // the remainder is irrelevant.
  if (isErrorDumpShape(body) && RETRIABLE_ERROR.test(body)) return true;

  if (AUTH_OR_PLAN.test(trimmed)) return false;
  if (DEBUGGING_APP.test(trimmed)) return false;
  if (SHORT_SERVER_COPY.test(trimmed)) return true;
  if (!isErrorDumpShape(body)) return false;
  if (STREAM_DROPPED.test(body)) return true;
  return CONNECT_ERROR.test(body)
    || GRPC_TRANSPORT.test(body)
    || HTTP2_CANCEL.test(body)
    || STREAM_RESET.test(body)
    || NODE_TRANSPORT.test(body);
}

function isErrorDumpShape(body: string): boolean {
  const lines = body.split(/\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 8) return false;
  return ERROR_DUMP_HEAD.test(body);
}

export function couldBecomeSpuriousNetworkDeath(text: string): boolean {
  if (couldBecomeWholeMessageDump(text)) return true;
  return trailingDumpRange(text, false) !== undefined;
}

function couldBecomeWholeMessageDump(text: string): boolean {
  if (isWholeMessageDump(text)) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.length > MAX_DEATH_TEXT_CHARS) return false;
  if (trimmed.includes("```")) return false;
  const body = CURSOR_ADAPTER_PREFIX.test(trimmed) ? trimmed.replace(CURSOR_ADAPTER_PREFIX, "").trim() : trimmed;
  if (RETRIABLE_ERROR.test(body)) return isErrorDumpShape(body);
  if (AUTH_OR_PLAN.test(trimmed)) return false;
  if (DEBUGGING_APP.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  if (lower === "error" || "error: ".startsWith(lower)) return true;
  if (lower.startsWith("error:")) {
    const rest = lower.slice("error:".length).replace(/^\s+/, "");
    return rest.length === 0 || matchesDumpHeadProgress(rest);
  }
  return matchesDumpHeadProgress(lower);
}

function trailingDumpRange(text: string, completeOnly: boolean): TextRange | undefined {
  if (text.includes("```")) return undefined;
  const paragraph = lastNonEmptyParagraphRange(text);
  const line = lastNonEmptyLineRange(text);
  for (const fragment of [paragraph, line]) {
    if (!fragment) continue;
    if (text.slice(0, fragment.start).trim().length === 0) continue;
    const match = completeOnly
      ? isWholeMessageDump(fragment.value)
      : couldBecomeWholeMessageDump(fragment.value);
    if (match) return fragment;
  }
  return undefined;
}

function lastNonEmptyLineRange(text: string): TextRange | undefined {
  let end = text.length;
  while (end > 0 && isLineBreakOrSpace(text.charAt(end - 1))) end--;
  if (end === 0) return undefined;
  let start = end;
  while (start > 0 && text.charAt(start - 1) !== "\n") start--;
  return { start, value: text.slice(start, end) };
}

function lastNonEmptyParagraphRange(text: string): TextRange | undefined {
  let end = text.length;
  while (end > 0 && isLineBreakOrSpace(text.charAt(end - 1))) end--;
  if (end === 0) return undefined;
  const before = text.slice(0, end);
  const breaks = before.matchAll(/\n[ \t]*\n/g);
  let start = 0;
  for (const match of breaks) {
    start = (match.index ?? 0) + match[0].length;
  }
  return { start, value: before.slice(start) };
}

function isLineBreakOrSpace(character: string): boolean {
  return character === "\n" || character === "\r" || character === " " || character === "\t";
}

function matchesDumpHeadProgress(text: string): boolean {
  return DUMP_HEADS.some((head) => head.startsWith(text) || text.startsWith(head));
}

export function extractAssistantText(message: unknown): string {
  const record = asRecord(message);
  if (!record) return "";
  const params = asRecord(record.params);
  const update = asRecord(params?.update) ?? asRecord(record.update);
  if (!update) return "";
  if (update.sessionUpdate !== "agent_message_chunk") return "";
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
