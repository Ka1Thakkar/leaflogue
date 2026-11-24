import type { EpubDocument, Highlight as SavedHighlight } from "@leaflogue/contracts";

/** The reading document, or an inert copy of the whole book (template contents) used for matching. */
export type ReaderRoot = Document | DocumentFragment;
const ownerOf = (root: ReaderRoot) => root.nodeType === 9 ? root as Document : root.ownerDocument!;
export function normalizedQuote(value: string) { return value.replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/\s+/gu, " ").trim(); }

export function textPoint(doc: Document, element: Element, offset: number): [Node, number] | undefined {
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (offset <= length) return [node, offset];
    offset -= length;
  }
  return undefined;
}
/** Chapter-scoped paragraph coordinates, as saved in `epub:<edition>:chapter:paragraph:start:endParagraph:end`. */
export interface ReaderLocation { readonly chapter: number; readonly paragraph: number; readonly start: number; readonly endParagraph: number; readonly end: number }
export function parseReaderLocation(location: string | undefined, edition?: string): ReaderLocation | undefined {
  if (!location || !/^(?:epub|article):/u.test(location)) return undefined;
  const [, hash, ...values] = location.split(":");
  const numbers = values.map(Number);
  if (numbers.length !== 5 || !numbers.every((value) => Number.isSafeInteger(value) && value >= 0) || (edition !== undefined && hash !== edition)) return undefined;
  const [chapter, paragraph, start, endParagraph, end] = numbers as [number, number, number, number, number];
  return { chapter, paragraph, start, endParagraph, end };
}
/** A location as a live range in whichever document currently holds its chapter. */
export function readerLocationRange(doc: ReaderRoot, location: ReaderLocation): Range | undefined {
  return rangeAt(doc, location.chapter, location.paragraph, location.start, location.endParagraph, location.end);
}
function rangeAt(root: ReaderRoot, chapter: number, paragraph: number, start: number, endParagraph: number, end: number) {
  const first = root.querySelector(`[data-chapter="${chapter}"][data-paragraph="${paragraph}"]`);
  const last = root.querySelector(`[data-chapter="${chapter}"][data-paragraph="${endParagraph}"]`);
  if (!first || !last || start < 0 || end < 0) return undefined;
  const doc = ownerOf(root);
  const a = textPoint(doc, first, start); const b = textPoint(doc, last, end);
  if (!a || !b) return undefined;
  const range = doc.createRange(); range.setStart(...a); range.setEnd(...b);
  return range.collapsed ? undefined : range;
}

interface IndexedChapter {
  blocks: { element: HTMLElement; start: number; length: number }[];
  normalized: string;
  offsets: Int32Array;
}
const editionIndexes = new WeakMap<ReaderRoot, { hash: string; first: Element | null; chapters: IndexedChapter[] }>();
function editionIndex(doc: ReaderRoot, book: EpubDocument) {
  const first = doc.querySelector("[data-chapter][data-paragraph]");
  const cached = editionIndexes.get(doc);
  if (cached?.hash === book.sha256 && cached.first === first) return cached.chapters;
  const chapters = book.chapters.map((_, chapter) => {
    let raw = "";
    const blocks = Array.from(doc.querySelectorAll<HTMLElement>(`[data-chapter="${chapter}"][data-paragraph]`)).map((element) => {
      const start = raw.length; raw += `${element.textContent ?? ""}\n\n`;
      return { element, start, length: element.textContent?.length ?? 0 };
    });
    let normalized = ""; const offsets = new Int32Array(raw.length); let length = 0;
    for (let index = 0; index < raw.length; index++) {
      let char = raw[index]!;
      if (/\s/u.test(char)) { if (!normalized || normalized.endsWith(" ")) continue; char = " "; }
      else char = char.replace(/[‘’]/u, "'").replace(/[“”]/u, '"');
      normalized += char; offsets[length++] = index;
    }
    return { blocks, normalized, offsets: offsets.subarray(0, length) };
  });
  if (first) editionIndexes.set(doc, { hash: book.sha256, first, chapters });
  return chapters;
}

/** Explicit edition anchors first; imported quotes are placed only when unique. */
export function matchReaderHighlight(doc: ReaderRoot, book: EpubDocument, highlight: SavedHighlight): Range | undefined {
  const location = matchReaderLocation(doc, book, highlight);
  return location && readerLocationRange(doc, location);
}
/** Where a saved highlight sits in this edition, independent of which chapters are on screen. */
export function matchReaderLocation(doc: ReaderRoot, book: EpubDocument, highlight: SavedHighlight): ReaderLocation | undefined {
  const quote = normalizedQuote(highlight.text);
  if (!quote) return undefined;
  if (/^(?:epub|article):/u.test(highlight.sourceLocation ?? "")) {
    const [, hash] = highlight.sourceLocation!.split(":");
    const location = parseReaderLocation(highlight.sourceLocation);
    if (!location) return undefined;
    if (hash === book.sha256) {
      const range = readerLocationRange(doc, location);
      return range && normalizedQuote(range.toString()) === quote ? location : undefined;
    }
    // A deliberately attached replacement file may locate the unchanged quote,
    // but never inherits coordinates from a different edition or format.
  }
  const candidates = readerHighlightCandidates(doc, book, highlight.text, 2);
  return candidates.length === 1 ? parseReaderLocation(candidates[0]!.location) : undefined;
}
export interface ReaderHighlightCandidate { range: Range; chapter: number; location: string; excerpt: string }
/** Explicit review may find an imported quote in several places or a new edition. */
export function readerHighlightCandidates(doc: ReaderRoot, book: EpubDocument, text: string, limit = 100): ReaderHighlightCandidate[] {
  const quote = normalizedQuote(text);
  if (!quote) return [];
  const found: ReaderHighlightCandidate[] = [];
  const chapters = editionIndex(doc, book);
  for (let chapter = 0; chapter < chapters.length; chapter++) {
    const { blocks, normalized, offsets } = chapters[chapter]!;
    let cursor = 0;
    while (cursor < normalized.length) {
      const start = normalized.indexOf(quote, cursor); if (start < 0) break;
      const rawStart = offsets[start]!; const rawEnd = offsets[start + quote.length - 1]! + 1;
      const first = blocks.find((block) => rawStart >= block.start && rawStart < block.start + block.length);
      const last = blocks.find((block) => rawEnd > block.start && rawEnd <= block.start + block.length);
      if (first && last) {
        const paragraph = Number(first.element.dataset.paragraph); const endParagraph = Number(last.element.dataset.paragraph);
        const startOffset = rawStart - first.start; const endOffset = rawEnd - last.start;
        const range = rangeAt(doc, chapter, paragraph, startOffset, endParagraph, endOffset);
        if (range) found.push({ range, chapter, location: `${book.format === "article" ? "article" : "epub"}:${book.sha256}:${chapter}:${paragraph}:${startOffset}:${endParagraph}:${endOffset}`, excerpt: first.element.textContent?.slice(Math.max(0, startOffset - 60), startOffset + 180) ?? "" });
        if (found.length >= limit) return found;
      }
      cursor = start + 1;
    }
  }
  return found;
}

export function readerSelection(doc: Document, book: EpubDocument) {
  const selection = doc.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0).cloneRange(); const text = range.toString().trim();
  if (!text || text.length > 100_000) return undefined;
  const blocks = Array.from(doc.querySelectorAll<HTMLElement>("[data-paragraph]"));
  const selected = blocks.filter((node) => range.intersectsNode(node));
  const first = selected[0]; const last = selected.at(-1);
  if (!first || !last || first.dataset.chapter !== last.dataset.chapter) return undefined;
  const offset = (element: Element, node: Node, position: number, fallback: number) => {
    if (!element.contains(node)) return fallback;
    const before = doc.createRange(); before.selectNodeContents(element); before.setEnd(node, position); return before.toString().length;
  };
  const start = offset(first, range.startContainer, range.startOffset, 0);
  const end = offset(last, range.endContainer, range.endOffset, last.textContent?.length ?? 0);
  return { text, range, sourceLocation: `${book.format === "article" ? "article" : "epub"}:${book.sha256}:${first.dataset.chapter}:${first.dataset.paragraph}:${start}:${last.dataset.paragraph}:${end}` };
}
