/**
 * Book-wide page numbers while only one chapter is laid out at a time.
 *
 * Chapters that have been laid out report their real page count. Others are
 * estimated from their length using pages-per-character from measured
 * chapters. The rate is only refined while every chapter before the one being
 * read is measured, so estimates behind the reader never change and reading
 * forward always moves the page number forward by exactly one page.
 */
export interface PageEstimate {
  /** Characters per chapter, from the book's text. */
  readonly lengths: readonly number[];
  /** Real page counts of chapters laid out with the current text settings. */
  readonly measured: Map<number, number>;
  /** Pages per character used for chapters that have not been laid out. */
  rate: number | undefined;
}

export function createPageEstimate(lengths: readonly number[]): PageEstimate {
  return { lengths: lengths.map((length) => Math.max(1, length)), measured: new Map(), rate: undefined };
}

/** Forget every measurement, for example after the text size or window changed. */
export function resetPageEstimate(estimate: PageEstimate) {
  estimate.measured.clear(); estimate.rate = undefined;
}

/**
 * Record a laid-out chapter. `fallbackRate` is a guess from the page geometry,
 * used until a chapter long enough to measure a rate has been laid out.
 */
export function measureChapter(estimate: PageEstimate, chapter: number, pages: number, fallbackRate: number) {
  estimate.measured.set(chapter, Math.max(1, pages));
  let settled = true;
  for (let index = 0; index < chapter; index++) if (!estimate.measured.has(index)) { settled = false; break; }
  if (estimate.rate !== undefined && !settled) return;
  // The last page of a chapter is on average half full; one-page chapters
  // (titles, dedications) say little about how much text fits on a page.
  let pagesSeen = 0; let charactersSeen = 0;
  for (const [index, count] of estimate.measured) if (count >= 2) { pagesSeen += count - 0.5; charactersSeen += estimate.lengths[index] ?? 1; }
  estimate.rate = charactersSeen ? pagesSeen / charactersSeen : estimate.rate ?? fallbackRate;
}

export function chapterPages(estimate: PageEstimate, chapter: number) {
  return estimate.measured.get(chapter) ?? Math.max(1, Math.round((estimate.lengths[chapter] ?? 1) * (estimate.rate ?? 0)));
}
export function pagesBefore(estimate: PageEstimate, chapter: number) {
  let total = 0;
  for (let index = 0; index < chapter; index++) total += chapterPages(estimate, index);
  return total;
}
export function totalPages(estimate: PageEstimate) {
  return pagesBefore(estimate, estimate.lengths.length);
}
