import { redactPublicTextWithMetadata } from "./public-output";
import type { LabMetadata } from "./types";

export type RedactionResult = { text: string; contentRedacted: boolean; incomplete?: boolean };

export type ComposeLogRuntime = {
  metadata: Pick<LabMetadata, "owner" | "ownerKey" | "id" | "composeProject" | "sourceRoot" | "manifestPath" | "runtimeRoot" | "workspace">;
  composeArgs: readonly string[];
};

export function redactComposeFailureWithMetadata(
  value: string,
  runtime: ComposeLogRuntime,
  secretValues: readonly string[],
  fragments: readonly string[] = [value],
): RedactionResult {
  const incomplete = secretValues.some((secret) => /[\r\n]/.test(secret)) ||
    secretCrossesFragmentBoundary(fragments, secretValues);
  const redacted = redactComposeTextWithMetadata(value, runtime, secretValues);
  // Apply lifecycle segment bounds only in the caller, where the resulting
  // truncation is reflected in its explicit metadata.
  const publicText = redactPublicTextWithMetadata(
    redacted.text,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    { byteCapture: "tail" },
  );
  const result: RedactionResult = {
    text: incomplete ? "" : publicText.text,
    contentRedacted: incomplete || redacted.contentRedacted || publicText.contentRedacted,
  };
  if (incomplete) result.incomplete = true;
  return result;
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
    return { records: [], rawRecords: [], contentRedacted: true, valid: false };
  }
  const parsed = parseComposeLogRecords(value);
  if (!parsed.valid) {
    return { records: [], rawRecords: [], contentRedacted: true, valid: false };
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
  return { records, rawRecords: parsed.records, contentRedacted, valid: true };
}

type ComposeLogRecord = { timestamp: string; text: string; sequence: number };
type RedactedComposeLogRecord = ComposeLogRecord;
type RedactedComposeLogCapture = {
  records: RedactedComposeLogRecord[];
  rawRecords: ComposeLogRecord[];
  contentRedacted: boolean;
  valid: boolean;
};

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
  // Calendar components are checked below instead of relying on Date.parse,
  // whose normalization accepts impossible days and hour 24.
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
      if (!isCanonicalComposeTimestamp(match[1]!)) return { records: [], valid: false };
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

function isCanonicalComposeTimestamp(timestamp: string): boolean {
  const year = Number(timestamp.slice(0, 4));
  const month = Number(timestamp.slice(5, 7));
  const day = Number(timestamp.slice(8, 10));
  const hour = Number(timestamp.slice(11, 13));
  const minute = Number(timestamp.slice(14, 16));
  const second = Number(timestamp.slice(17, 19));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= daysInMonth!;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Return true when a declared secret occurs only after joining distinct
 * trusted output fragments.  Compose timestamps and diagnostic separators
 * are framing, not payload; omitting them here prevents a secret split at a
 * record, stream, or synthetic marker boundary from publishing reconstructable
 * halves.  A wholly-contained occurrence remains eligible for ordinary
 * replacement by the per-record redactor.
 */
export function secretCrossesFragmentBoundary(
  fragments: readonly string[],
  secretValues: readonly string[],
): boolean {
  const nonEmpty = fragments.filter((fragment) => fragment.length > 0);
  if (nonEmpty.length < 2) return false;
  const joined = nonEmpty.join("");
  return secretValues.some((secret) => {
    if (!secret || /[\r\n]/.test(secret)) return false;
    let start = joined.indexOf(secret);
    while (start >= 0) {
      let offset = 0;
      let firstFragment = -1;
      let lastFragment = -1;
      const end = start + secret.length;
      for (const [index, fragment] of nonEmpty.entries()) {
        const fragmentEnd = offset + fragment.length;
        if (firstFragment < 0 && start < fragmentEnd) firstFragment = index;
        if (end <= fragmentEnd) {
          lastFragment = index;
          break;
        }
        offset = fragmentEnd;
      }
      if (firstFragment >= 0 && lastFragment > firstFragment) return true;
      start = joined.indexOf(secret, start + 1);
    }
    return false;
  });
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
    if (stream.truncated) return { records: [], rawRecords: [], contentRedacted: true, valid: false };
    if (!stream.value) return { records: [], rawRecords: [], contentRedacted: false, valid: true };
    return redactComposeLogCapture(stream.value, runtime, secretValues);
  });
  const rawRecords = captures.flatMap((capture) => capture.rawRecords)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence);
  const unsafeSecret = secretValues.some((secret) => /[\r\n]/.test(secret));
  if (unsafeSecret || secretCrossesFragmentBoundary(rawRecords.map((record) => record.text), secretValues)) {
    return {
      redacted: { text: "", contentRedacted: true, incomplete: true },
      truncated: true,
    };
  }
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
