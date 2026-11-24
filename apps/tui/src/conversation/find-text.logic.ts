import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

export function conversationFindChunks(
  segments: readonly string[],
  query: string,
  activeOccurrence?: number,
) {
  const chunks: Array<{ text: string; match: boolean; active: boolean }> = [];
  let occurrence = 0;
  for (const [index, text] of segments.entries()) {
    if (index > 0) chunks.push({ text: "\n", match: false, active: false });
    let cursor = 0;
    for (const start of findThreadSearchOccurrences(text, query)) {
      if (start > cursor)
        chunks.push({ text: text.slice(cursor, start), match: false, active: false });
      chunks.push({
        text: text.slice(start, start + query.length),
        match: true,
        active: occurrence === activeOccurrence,
      });
      occurrence += 1;
      cursor = start + query.length;
    }
    if (cursor < text.length)
      chunks.push({ text: text.slice(cursor), match: false, active: false });
  }
  return chunks;
}
