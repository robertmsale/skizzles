import { redactPublicTextWithMetadata } from "./public-output";
import type { LabMetadata } from "./types";

export type RedactionResult = { text: string; contentRedacted: boolean };

export type ComposeLogRuntime = {
  metadata: Pick<LabMetadata, "owner" | "ownerKey" | "id" | "composeProject" | "sourceRoot" | "manifestPath" | "runtimeRoot" | "workspace">;
  composeArgs: readonly string[];
};

export function redactComposeFailureWithMetadata(
  value: string,
  runtime: ComposeLogRuntime,
  secretValues: readonly string[],
): RedactionResult {
  const redacted = redactComposeTextWithMetadata(value, runtime, secretValues);
  // Apply lifecycle segment bounds only in the caller, where the resulting
  // truncation is reflected in its explicit metadata.
  const publicText = redactPublicTextWithMetadata(
    redacted.text,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    { byteCapture: "tail" },
  );
  return {
    text: publicText.text,
    contentRedacted: redacted.contentRedacted || publicText.contentRedacted,
  };
}

function redactComposeTextWithMetadata(
  value: string,
  runtime: ComposeLogRuntime,
  secretValues: readonly string[],
): RedactionResult {
  let diagnostic = value;
  let contentRedacted = false;
  for (const secret of secretValues) {
    if (!secret) continue;
    const replacement = diagnostic.split(secret).join("[secret-value-redacted]");
    contentRedacted ||= replacement !== diagnostic;
    diagnostic = replacement;
  }
  const metadata = [
    runtime.metadata.owner,
    runtime.metadata.ownerKey,
    runtime.metadata.id,
    runtime.metadata.composeProject,
    runtime.metadata.sourceRoot,
    runtime.metadata.manifestPath,
    runtime.metadata.runtimeRoot,
    runtime.metadata.workspace,
    ...runtime.composeArgs,
  ];
  for (const metadataValue of metadata) {
    if (!metadataValue) continue;
    const replacement = diagnostic.split(metadataValue).join("[redacted]");
    contentRedacted ||= replacement !== diagnostic;
    diagnostic = replacement;
  }
  // Compose may print short container ids that are not covered by the public
  // text redactor's UUID/sha256 rules. They are not useful at this boundary.
  const idsRedacted = diagnostic.replace(/\b[0-9a-f]{12,64}\b/gi, "[redacted]");
  contentRedacted ||= idsRedacted !== diagnostic;
  return { text: idsRedacted, contentRedacted };
}

function redactComposeLogCapture(
  value: string,
  runtime: ComposeLogRuntime,
  secretValues: readonly string[],
): RedactedComposeLogCapture {
  if (secretValues.some((secret) => /[\r\n]/.test(secret))) {
    return { records: [], contentRedacted: true, valid: false };
  }
  const parsed = parseComposeLogRecords(value);
  if (!parsed.valid) {
    return { records: [], contentRedacted: true, valid: false };
  }

  const records: RedactedComposeLogRecord[] = [];
  let contentRedacted = false;
  for (const record of parsed.records) {
    const composeRedacted = redactComposeTextWithMetadata(record.text, runtime, secretValues);
    const publicText = redactPublicTextWithMetadata(
      composeRedacted.text,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    records.push({ timestamp: record.timestamp, text: publicText.text, sequence: record.sequence });
    contentRedacted ||= composeRedacted.contentRedacted || publicText.contentRedacted;
  }
  return { records, contentRedacted, valid: true };
}

type ComposeLogRecord = { timestamp: string; text: string; sequence: number };
type RedactedComposeLogRecord = ComposeLogRecord;
type RedactedComposeLogCapture = { records: RedactedComposeLogRecord[]; contentRedacted: boolean; valid: boolean };

function parseComposeLogRecords(value: string): { records: ComposeLogRecord[]; valid: boolean } {
  if (!value) return { records: [], valid: true };
  // `--timestamps --no-log-prefix` is a supported Compose presentation in
  // which Docker prefixes each daemon log record with a zero-padded,
  // nanosecond RFC3339 timestamp. The timestamp is the only machine-controlled
  // boundary we rely on; container names and service prefixes are payload and
  // are intentionally not parsed. A payload that forges a timestamp-looking
  // line cannot be distinguished from a daemon frame at this text boundary;
  // malformed/unframed streams therefore fail closed, and a path split across
  // genuinely separate daemon records remains impossible to classify safely.
  const frame = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z)(?:[ \t]+(.*))?$/;
  const timestampLike = /^\d{4}-\d{2}-\d{2}T/;
  const records: ComposeLogRecord[] = [];
  let current: ComposeLogRecord | undefined;
  let sequence = 0;
  let cursor = 0;
  while (cursor < value.length) {
    const newline = value.indexOf("\n", cursor);
    const end = newline < 0 ? value.length : newline;
    const line = value.slice(cursor, end).replace(/\r$/, "");
    const match = frame.exec(line);
    if (match) {
      if (Number.isNaN(Date.parse(match[1]!))) return { records: [], valid: false };
      if (current !== undefined) records.push(current);
      current = { timestamp: match[1]!, text: match[2] ?? "", sequence: sequence++ };
    } else if (timestampLike.test(line)) {
      // A timestamp-looking line with malformed precision or timezone is not a
      // safe continuation: discard the entire capture rather than publishing.
      return { records: [], valid: false };
    } else if (current === undefined) {
      return { records: [], valid: false };
    } else {
      // Docker records may contain embedded newlines. Keep continuations in
      // the same record so the conservative path redactor consumes any
      // ambiguous suffix instead of treating it as a fresh public line.
      current.text += `\n${line}`;
    }
    cursor = newline < 0 ? value.length : newline + 1;
  }
  if (current !== undefined) records.push(current);
  return { records, valid: true };
}

function mergeComposeLogRecords(captures: readonly RedactedComposeLogCapture[]): RedactionResult {
  const records = captures.flatMap((capture) => capture.records)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence);
  return {
    text: records.map((record) => record.text).join("\n"),
    contentRedacted: captures.some((capture) => capture.contentRedacted),
  };
}

export type ComposeLogStream = { name: "stdout" | "stderr"; value: string; truncated: boolean };

export function redactComposeLogStreams(
  streams: readonly ComposeLogStream[],
  resultCode: number,
  runtime: ComposeLogRuntime,
  secretValues: readonly string[],
): { redacted: RedactionResult; truncated: boolean } {
  const captures = streams.map((stream): RedactedComposeLogCapture => {
    if (stream.truncated) return { records: [], contentRedacted: true, valid: false };
    if (!stream.value) return { records: [], contentRedacted: false, valid: true };
    return redactComposeLogCapture(stream.value, runtime, secretValues);
  });
  const merged = mergeComposeLogRecords(captures);
  const markers = captures.map((capture, index) => {
    if (capture.valid) return undefined;
    const stream = streams[index]!;
    return `[${stream.name}-${stream.truncated ? "truncated" : "unavailable"}]`;
  }).filter((marker): marker is string => marker !== undefined);
  if (resultCode !== 0) markers.unshift("[compose-command-failed]");
  return {
    redacted: {
      text: [...markers, merged.text].filter((part) => part.length > 0).join("\n"),
      contentRedacted: merged.contentRedacted || markers.length > 0,
    },
    truncated: resultCode !== 0 || streams.some((stream, index) => stream.truncated ||
      (!captures[index]!.valid && stream.value.length > 0)),
  };
}
