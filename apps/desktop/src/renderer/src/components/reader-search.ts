import type { ReaderDocument } from "@leaflogue/contracts";

export interface ReaderMatch { chapter: number; paragraph: number; offset: number; length: number; excerpt: string }
export function searchReader(book: ReaderDocument, query: string, limit = 100): ReaderMatch[] {
  const term = query.trim();
  if (!term) return [];
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
  const results: ReaderMatch[] = [];
  for (const [chapter, item] of book.chapters.entries()) {
    for (const [paragraph, text] of (item.paragraphs ?? item.text.split("\n\n")).entries()) {
      for (const match of text.matchAll(pattern)) {
        const offset = match.index;
        results.push({ chapter, paragraph, offset, length: match[0].length, excerpt: `${offset > 45 ? "…" : ""}${text.slice(Math.max(0, offset - 45), offset + match[0].length + 85)}${offset + match[0].length + 85 < text.length ? "…" : ""}` });
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}
/** Resolve offsets across nested publisher markup without changing it. */
export function readerTextRange(doc: Document, position: ReaderDocument["position"], length = 0): Range | undefined {
  const element = doc.querySelector(`[data-chapter="${position.chapter}"][data-paragraph="${position.paragraph}"]`);
  if (!element) return undefined;
  const walker = doc.createTreeWalker(element, 4);
  const range = doc.createRange();
  let start = position.offset ?? 0; let remaining = length; let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const size = node.textContent?.length ?? 0;
    if (!started) { if (start > size) { start -= size; continue; } range.setStart(node, start); started = true; remaining += start; }
    if (remaining <= size) { range.setEnd(node, remaining); return range; }
    remaining -= size;
  }
  return undefined;
}
