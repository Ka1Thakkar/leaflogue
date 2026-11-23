import type { EpubDocument, LeaflogueBridge } from "@leaflogue/contracts";

/** Development-only, inert fixture; no filesystem access or production bridge. */
export function previewReader(): NonNullable<LeaflogueBridge["epub"]> {
  const paragraphs = Array.from({ length: 100 }, (_, i) => `Paragraph ${i}. ` + "We read deliberately, and keep the words that matter. ".repeat(20));
  const book: EpubDocument = { sha256: "a".repeat(64), position: { chapter: 0, paragraph: 0 }, chapters: [{ id: "chapter.xhtml", title: "A quiet beginning", text: paragraphs.join("\n\n"), paragraphs,
    html: '<h1 style="text-align:center">A quiet beginning</h1><p style="text-align:center">A centered dedication</p>' + paragraphs.map((text, i) => `<p data-paragraph="${i}">${text}<strong> Important.</strong><em> Gently.</em></p>`).join("") }] };
  let position = book.position;
  let bookmarks: EpubDocument["bookmarks"] = [];
  let anchors: Record<string, string> = {};
  return {
    open: async () => ({ ...book, position, bookmarks, localAnchors: anchors }), attach: async () => book,
    readPdf: async () => new Uint8Array(),
    savePosition: async (_id, _hash, chapter, paragraph, offset) => { position = { chapter, paragraph, ...(offset ? { offset } : {}) }; },
    saveBookmarks: async (_id, _hash, next) => { bookmarks = next; return next; },
    saveAnchor: async (_id, _hash, id, location) => { anchors = { ...anchors }; if (location === null) delete anchors[id]; else anchors[id] = location; return anchors; },
  };
}
