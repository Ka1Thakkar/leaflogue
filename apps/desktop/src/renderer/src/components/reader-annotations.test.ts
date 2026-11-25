/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import type { ReaderDocument, Highlight } from "@leaflogue/contracts";
import { matchReaderHighlight, matchReaderLocation, readerHighlightCandidates, readerLocationRange } from "./reader-annotations";
const book: ReaderDocument = { format: "epub", sha256: "edition-a", chapters: [{ id: "one", title: "One", text: "A quiet beginning." }], position: { chapter: 0, paragraph: 0 } };
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
  it("matches unique text in a deliberately attached replacement without reusing its old coordinates", () => {
    const doc = documentWith('<p data-chapter="0" data-paragraph="0">A quiet beginning.</p>');
    const saved = highlight("quiet", "epub:previous-pdf:7:99:50:99:55");
    expect(matchReaderHighlight(doc, book, saved)?.toString()).toBe("quiet");
    expect(saved.sourceLocation).toBe("epub:previous-pdf:7:99:50:99:55");
  });
  it("matches whitespace and typographic quote variations without guessing", () => {
    const doc = documentWith('<p data-chapter="0" data-paragraph="0">He said “read   quietly”.</p>');
    expect(matchReaderHighlight(doc, book, highlight('"read quietly"'))?.toString()).toBe("“read   quietly”");
  });
  it("places a highlight in an inert copy of the book and finds the same text once its chapter is on the page", () => {
    const two: ReaderDocument = { ...book, chapters: [...book.chapters, { id: "two", title: "Two", text: "" }] };
    const template = document.createElement("template");
    template.innerHTML = '<p data-chapter="0" data-paragraph="0">quiet</p><p data-chapter="1" data-paragraph="0">A <em>loud</em> ending.</p>';
    const location = matchReaderLocation(template.content, two, highlight("loud ending"));
    expect(location).toEqual({ chapter: 1, paragraph: 0, start: 2, endParagraph: 0, end: 13 });
    // Only chapter 1 is on the page.
    const doc = documentWith('<p data-chapter="1" data-paragraph="0">A <em>loud</em> ending.</p>');
    expect(readerLocationRange(doc, location!)?.toString()).toBe("loud ending");
    expect(readerLocationRange(doc, { chapter: 0, paragraph: 0, start: 0, endParagraph: 0, end: 5 })).toBeUndefined();
  });
});

it("reuses reader matching for versioned article anchors without changing EPUB anchors", () => {
  const article: ReaderDocument = { ...book, format: "article" };
  const doc = documentWith('<p data-chapter="0" data-paragraph="0">A quiet beginning.</p>');
  const candidate = readerHighlightCandidates(doc, article, "quiet")[0]!;
  expect(candidate.location).toBe("article:edition-a:0:0:2:0:7");
  expect(matchReaderHighlight(doc, article, highlight("quiet", candidate.location))?.toString()).toBe("quiet");
});
