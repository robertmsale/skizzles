export type PublicTextCapturePolicy = "head" | "tail";
export type RedactPublicTextOptions = { byteCapture?: PublicTextCapturePolicy };

export function redactPublicText(
  value: string,
  maxBytes = 2_000,
  maxLines = 8,
  options: RedactPublicTextOptions = {},
): string {
  // Redact quoted and token-shaped Windows absolute paths as well as the
  // POSIX form below. Docker can report host paths from either platform;
  // preserving only POSIX redaction would leak drive and UNC paths.
  // Unquoted POSIX paths may contain spaces in any component. Parse them
  // rather than stopping at the first space; punctuation and whitespace
  // before another slash delimit adjacent diagnostics and paths. When prose
  // is otherwise ambiguous, prefer over-redaction to leaking a path suffix.
  const pathsRedacted = redactPosixPaths(
    value
      // Redact image tags before path parsing can treat the preceding colon as
      // a path boundary and leave the tag's private suffix visible.
      .replace(/\bcodex-container-lab:[A-Za-z0-9._-]+\b/g, "[redacted]")
      .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\)(?:\\.|(?!\1)[^\\])*?\1/g, "[path]")
      .replace(/(["'])\/(?:\\.|(?!\1)[^\\\n])*?\1/g, "[path]")
      .replace(/\b[A-Za-z]:[\\/](?:[^\s"'\\]|\\.)+/g, "[path]")
      .replace(/\\\\(?:[^\s"'\\]|\\.)+/g, "[path]"),
  ).replace(/\/(?:[^\s"'\\]|\\.)+/g, "[path]");
  const redacted = pathsRedacted
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[redacted]")
    .replace(/\bcodex-container-lab:[A-Za-z0-9._-]+\b/g, "[redacted]")
    .replace(/\bccl-[a-z0-9][a-z0-9-]*\b/gi, "[redacted]")
    .replace(/io\.openai\.codex-container-lab\.owner=\S+/gi, "io.openai.codex-container-lab.owner=[redacted]")
    .replace(/(?:ownerKey|runtimeRoot|stateRoot|composeArgs|managedImage)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "[redacted]")
    .split("\n").slice(-maxLines).join("\n");
  return truncateUtf8(redacted, maxBytes, options.byteCapture ?? "head");
}

function redactPosixPaths(value: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("/", cursor);
    if (start < 0) {
      output += value.slice(cursor);
      break;
    }
    output += value.slice(cursor, start);
    const end = consumePosixPath(value, start);
    if (end === start + 1) {
      output += "/";
      cursor = end;
      continue;
    }
    output += "[path]";
    cursor = end;
  }
  return output;
}

function consumePosixPath(value: string, start: number): number {
  let cursor = start + 1;
  let hasComponent = false;
  let hasAnyComponent = false;
  while (cursor < value.length) {
    const character = value[cursor]!;
    if (character === "\\" && cursor + 1 < value.length) {
      hasComponent = true;
      hasAnyComponent = true;
      cursor += 2;
      continue;
    }
    if (character === "\n" || character === "\r" || character === '"' || character === "'") break;
    if (character === "/") {
      if (!hasComponent) break;
      hasComponent = false;
      cursor += 1;
      continue;
    }
    if (isPosixPathDelimiter(character)) break;
    if (isWhitespace(character)) {
      const whitespaceStart = cursor;
      while (cursor < value.length && isWhitespace(value[cursor]!)) cursor += 1;
      if (cursor >= value.length || value[cursor] === "/") return whitespaceStart;
      continue;
    }
    hasComponent = true;
    hasAnyComponent = true;
    cursor += 1;
  }
  return hasAnyComponent ? cursor : start + 1;
}

function isPosixPathDelimiter(character: string): boolean {
  return ",;:()[]{}".includes(character);
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t";
}

function truncateUtf8(value: string, maxBytes: number, policy: PublicTextCapturePolicy): string {
  if (policy === "tail") {
    const bytes = Buffer.from(value);
    if (bytes.byteLength <= maxBytes) return value;
    return bytes.subarray(bytes.byteLength - maxBytes).toString("utf8").replace(/^�/, "");
  }
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) return `${output}…`;
    output += character;
    bytes += size;
  }
  return output;
}
