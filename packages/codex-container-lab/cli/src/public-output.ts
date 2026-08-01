export type PublicTextCapturePolicy = "head" | "tail";
export type RedactPublicTextOptions = { byteCapture?: PublicTextCapturePolicy };

export function redactPublicText(
  value: string,
  maxBytes = 2_000,
  maxLines = 8,
  options: RedactPublicTextOptions = {},
): string {
  const redacted = value
    // Redact quoted and token-shaped Windows absolute paths as well as the
    // POSIX form below.  Docker can report host paths from either platform;
    // preserving only POSIX redaction would leak drive and UNC paths.
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\)(?:\\.|(?!\1)[^\\])*?\1/g, "[path]")
    .replace(/\b[A-Za-z]:[\\/](?:[^\s"'\\]|\\.)+/g, "[path]")
    .replace(/\\\\(?:[^\s"'\\]|\\.)+/g, "[path]")
    .replace(/\/(?:[^\s"'\\]|\\.)+/g, "[path]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[redacted]")
    .replace(/\bcodex-container-lab:[A-Za-z0-9._-]+\b/g, "[redacted]")
    .replace(/\bccl-[a-z0-9][a-z0-9-]*\b/gi, "[redacted]")
    .replace(/io\.openai\.codex-container-lab\.owner=\S+/gi, "io.openai.codex-container-lab.owner=[redacted]")
    .replace(/(?:ownerKey|runtimeRoot|stateRoot|composeArgs|managedImage)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "[redacted]")
    .split("\n").slice(-maxLines).join("\n");
  return truncateUtf8(redacted, maxBytes, options.byteCapture ?? "head");
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
