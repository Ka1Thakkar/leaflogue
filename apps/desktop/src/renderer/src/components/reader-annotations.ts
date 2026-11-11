import type { EpubDocument, Highlight as SavedHighlight } from "@leaflogue/contracts";

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
function rangeAt(doc: Document, chapter: number, paragraph: number, start: number, endParagraph: number, end: number) {
  const first = doc.querySelector(`[data-chapter="${chapter}"][data-paragraph="${paragraph}"]`);
  const last = doc.querySelector(`[data-chapter="${chapter}"][data-paragraph="${endParagraph}"]`);
  if (!first || !last || start < 0 || end < 0) return undefined;
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
const editionIndexes = new WeakMap<Document, { hash: string; first: Element | null; chapters: IndexedChapter[] }>();
function editionIndex(doc: Document, book: EpubDocument) {
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
export function matchReaderHighlight(doc: Document, book: EpubDocument, highlight: SavedHighlight): Range | undefined {
  const quote = normalizedQuote(highlight.text);
  if (!quote) return undefined;
  if (highlight.sourceLocation?.startsWith("epub:")) {
    const [prefix, hash, ...values] = highlight.sourceLocation.split(":");
    const numbers = values.map(Number);
    if (prefix !== "epub" || hash !== book.sha256 || numbers.length !== 5 || !numbers.every((value) => Number.isSafeInteger(value) && value >= 0)) return undefined;
    const range = rangeAt(doc, numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!, numbers[4]!);
    return range && normalizedQuote(range.toString()) === quote ? range : undefined;
  }
  let found: Range | undefined;
  const chapters = editionIndex(doc, book);
  for (let chapter = 0; chapter < chapters.length; chapter++) {
    const { blocks, normalized, offsets } = chapters[chapter]!;
    let cursor = 0;
    while (cursor < normalized.length) {
      const start = normalized.indexOf(quote, cursor); if (start < 0) break;
      if (found) return undefined;
      const rawStart = offsets[start]!; const rawEnd = offsets[start + quote.length - 1]! + 1;
      const first = blocks.find((block) => rawStart >= block.start && rawStart < block.start + block.length);
      const last = blocks.find((block) => rawEnd > block.start && rawEnd <= block.start + block.length);
      if (first && last) found = rangeAt(doc, chapter, Number(first.element.dataset.paragraph), rawStart - first.start, Number(last.element.dataset.paragraph), rawEnd - last.start);
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
  return { text, range, sourceLocation: `epub:${book.sha256}:${first.dataset.chapter}:${first.dataset.paragraph}:${start}:${last.dataset.paragraph}:${end}` };
}
