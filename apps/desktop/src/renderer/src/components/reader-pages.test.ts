import { describe, expect, it } from "vitest";
import { chapterPages, createPageEstimate, measureChapter, pagesBefore, resetPageEstimate, totalPages, type PageEstimate } from "./reader-pages";

// A book with uneven chapters: a title page, long chapters and short interludes.
const lengths = [40, 12_000, 30_000, 900, 18_000, 25_000, 2_000, 40_000, 15_000, 300];
// Real pages: about 1,500 characters a page, with some chapters denser than others.
const real = lengths.map((length, index) => Math.max(1, Math.ceil(length / (index % 3 === 0 ? 1_300 : 1_700))));
const guess = 1 / 2_000;

/** Read from `start` to the end of the book one page at a time, as the reader turns pages. */
function readForward(estimate: PageEstimate, start: number) {
  const seen: { page: number; count: number }[] = [];
  for (let chapter = start; chapter < lengths.length; chapter++) {
    measureChapter(estimate, chapter, real[chapter]!, guess);
    for (let local = 0; local < real[chapter]!; local++) seen.push({ page: pagesBefore(estimate, chapter) + local, count: totalPages(estimate) });
  }
  return seen;
}

describe("book-wide pages with one chapter laid out", () => {
  it("counts measured chapters exactly and estimates the rest from their length", () => {
    const estimate = createPageEstimate([3_000, 3_000, 6_000]);
    measureChapter(estimate, 0, 4, guess);
    expect(chapterPages(estimate, 0)).toBe(4);
    // 3.5 full pages per 3,000 characters.
    expect(chapterPages(estimate, 1)).toBe(4);
    expect(chapterPages(estimate, 2)).toBe(7);
    expect(pagesBefore(estimate, 2)).toBe(8);
    expect(totalPages(estimate)).toBe(15);
  });
  it("falls back to the page-shape guess until a chapter longer than one page is measured", () => {
    const estimate = createPageEstimate([50, 20_000]);
    measureChapter(estimate, 0, 1, guess);
    expect(chapterPages(estimate, 1)).toBe(10);
    measureChapter(estimate, 1, 14, guess);
    expect(totalPages(estimate)).toBe(15);
  });
  for (const start of [0, 4, 7]) {
    it(`moves forward exactly one page per turn when reading from chapter ${start + 1}`, () => {
      const seen = readForward(createPageEstimate(lengths), start);
      for (let index = 1; index < seen.length; index++) expect(seen[index]!.page).toBe(seen[index - 1]!.page + 1);
      for (const item of seen) expect(item.page).toBeLessThan(item.count);
      expect(seen.at(-1)!.page + 1).toBe(seen.at(-1)!.count);
    });
  }
  it("settles on the real total once every chapter is measured", () => {
    const estimate = createPageEstimate(lengths);
    readForward(estimate, 0);
    expect(totalPages(estimate)).toBe(real.reduce((sum, value) => sum + value, 0));
  });
  it("keeps estimates behind the reader fixed when opened mid-book", () => {
    const estimate = createPageEstimate(lengths);
    measureChapter(estimate, 5, real[5]!, guess);
    const before = pagesBefore(estimate, 5);
    measureChapter(estimate, 6, real[6]!, guess);
    measureChapter(estimate, 7, real[7]!, guess);
    expect(pagesBefore(estimate, 5)).toBe(before);
  });
  it("forgets measurements when the text or page shape changes", () => {
    const estimate = createPageEstimate(lengths);
    measureChapter(estimate, 1, 9, guess);
    resetPageEstimate(estimate);
    expect(estimate.measured.size).toBe(0);
    expect(estimate.rate).toBeUndefined();
  });
});
