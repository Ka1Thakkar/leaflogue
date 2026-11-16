/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import type { EpubDocument, Highlight } from "@leaflogue/contracts";
import { matchReaderHighlight, readerHighlightCandidates } from "./reader-annotations";
const book: EpubDocument = { sha256: "edition-a", chapters: [{ id: "one", title: "One", text: "A quiet beginning." }], position: { chapter: 0, paragraph: 0 } };
function highlight(text: string, sourceLocation?: string): Highlight { return { text, ...(sourceLocation ? { sourceLocation } : {}) } as Highlight; }
function documentWith(body: string) { document.body.innerHTML = body; return document; }
describe("reader annotation matching", () => {
  it("finds a unique imported quote across inline markup", () => {
    const doc = documentWith('<p data-chapter="0" data-paragraph="0">A <em>quiet</em> beginning.</p>');
    expect(matchReaderHighlight(doc, book, highlight("quiet"))?.toString()).toBe("quiet");
  });
  it("refuses ambiguous and missing imported quotes", () => {
    const doc = documentWith('<p data-chapter="0" data-paragraph="0">quiet</p><p data-chapter="0" data-paragraph="1">quiet</p>');
    expect(matchReaderHighlight(doc, book, highlight("quiet"))).toBeUndefined();
    expect(matchReaderHighlight(doc, book, highlight("missing"))).toBeUndefined();
  });
  it("offers repeated quotations for explicit review without automatically choosing", () => {
    const doc = documentWith('<p data-chapter="0" data-paragraph="0">He said “quiet”.</p><p data-chapter="0" data-paragraph="1">Again: “quiet”.</p>');
    const candidates = readerHighlightCandidates(doc, book, '"quiet"');
    expect(candidates).toHaveLength(2);
    expect(matchReaderHighlight(doc, book, highlight('"quiet"'))).toBeUndefined();
    expect(candidates[1]!.location).toBe("epub:edition-a:0:1:7:1:14");
    expect(matchReaderHighlight(doc, book, highlight('"quiet"', candidates[1]!.location))?.toString()).toBe("“quiet”");
    expect(readerHighlightCandidates(doc, book, "quiet", 1)).toHaveLength(1);
    expect(readerHighlightCandidates(doc, book, "missing")).toEqual([]);
  });
  it("uses an exact edition anchor even for a repeated quotation", () => {
    const doc = documentWith('<p data-chapter="0" data-paragraph="0">quiet</p><p data-chapter="0" data-paragraph="1">quiet</p>');
    const range = matchReaderHighlight(doc, book, highlight("quiet", "epub:edition-a:0:1:0:1:5"));
    expect(range?.startContainer.parentElement?.dataset.paragraph).toBe("1");
    expect(matchReaderHighlight(doc, book, highlight("quiet", "epub:edition-b:0:1:0:1:5"))).toBeUndefined();
    expect(matchReaderHighlight(doc, book, highlight("quiet", "epub:edition-a:0:9:0:9:5"))).toBeUndefined();
  });
  it("matches whitespace and typographic quote variations without guessing", () => {
    const doc = documentWith('<p data-chapter="0" data-paragraph="0">He said “read   quietly”.</p>');
    expect(matchReaderHighlight(doc, book, highlight('"read quietly"'))?.toString()).toBe("“read   quietly”");
  });
});
