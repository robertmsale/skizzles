export type MarkdownBlock =
  | { type: "text"; text: string }
  | { type: "code"; text: string; language?: string };

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const opening = text.indexOf("```", cursor);
    if (opening === -1) {
      blocks.push({ type: "text", text: text.slice(cursor) });
      break;
    }
    const openingLineEnd = text.indexOf("\n", opening + 3);
    const closing = openingLineEnd === -1 ? -1 : text.indexOf("```", openingLineEnd + 1);
    if (openingLineEnd === -1 || closing === -1) {
      blocks.push({ type: "text", text: text.slice(cursor) });
      break;
    }
    if (opening > cursor) blocks.push({ type: "text", text: text.slice(cursor, opening) });
    const language = text.slice(opening + 3, openingLineEnd).trim();
    blocks.push({
      type: "code",
      text: text.slice(openingLineEnd + 1, closing),
      ...(language ? { language } : {}),
    });
    cursor = closing + 3;
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}
