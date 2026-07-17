export const PUBLIC_JSON_BYTE_BUDGET = 16 * 1024;

/** Serialize a public command response, clipping only explicitly bounded transcripts. */
export function serializePublicJson(value: unknown): string {
  let candidate = value;
  let encoded = `${JSON.stringify(candidate)}\n`;
  if (Buffer.byteLength(encoded) > PUBLIC_JSON_BYTE_BUDGET && isRecord(value) && isRecord(value.transcript) &&
      typeof value.transcript.text === "string") {
    const characters = Array.from(value.transcript.text);
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const start = Math.floor((low + high) / 2);
      const text = characters.slice(start).join("");
      const transcript = { ...value.transcript, text, bytes: Buffer.byteLength(text),
        lines: text ? text.split("\n").length : 0, truncated: true };
      const attempt = `${JSON.stringify({ ...value, transcript })}\n`;
      if (Buffer.byteLength(attempt) <= PUBLIC_JSON_BYTE_BUDGET) high = start;
      else low = start + 1;
    }
    const text = characters.slice(low).join("");
    candidate = { ...value, transcript: { ...value.transcript, text, bytes: Buffer.byteLength(text),
      lines: text ? text.split("\n").length : 0, truncated: true } };
    encoded = `${JSON.stringify(candidate)}\n`;
  }
  if (Buffer.byteLength(encoded) > PUBLIC_JSON_BYTE_BUDGET) {
    throw new Error("public response exceeds the 16 KiB output budget");
  }
  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
