/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { readerTextRange, searchReader } from "./reader-search";
const book = { format: "epub" as const, sha256: "edition", position: { chapter: 0, paragraph: 0 }, chapters: [{ id: "a", title: "One", text: "A [word] and WORD.\n\nword again" }, { id: "b", title: "Two", text: "Last word" }] };
describe("reader search", () => {
  it("finds literal matches across chapters with exact offsets and bounded results", () => {
    expect(searchReader(book, "word").map(({ chapter, paragraph, offset }) => [chapter, paragraph, offset])).toEqual([[0, 0, 3], [0, 0, 13], [0, 1, 0], [1, 0, 5]]);
    expect(searchReader(book, "[word]")).toHaveLength(1);
    expect(searchReader(book, "  ")).toEqual([]);
    expect(searchReader(book, "missing")).toEqual([]);
    expect(searchReader(book, "word", 2)).toHaveLength(2);
  });
  it("resolves offsets across publisher emphasis", () => {
    document.body.innerHTML = '<p data-chapter="0" data-paragraph="0">Before <em>nested</em> text after</p>';
    expect(readerTextRange(document, { chapter: 0, paragraph: 0, offset: 7 }, 11)?.toString()).toBe("nested text");
    expect(readerTextRange(document, { chapter: 9, paragraph: 0 })).toBeUndefined();
  });
});
