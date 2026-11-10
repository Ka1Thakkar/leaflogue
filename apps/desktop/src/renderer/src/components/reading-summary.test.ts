import { describe, expect, it } from "vitest";
import type { LibraryStatistics } from "@leaflogue/contracts";
import { readingSummary } from "./reading-summary";

const base: Omit<LibraryStatistics, "days" | "books"> = {
  totals: { books: 2, reading: 1, finished: 1, highlights: 9, notes: 2, threads: 0 },
  finishedByYear: [],
  highlightsByMonth: [],
  hours: [],
  onThisDay: [],
  recent: [],
  inProgress: [],
  topBooks: [],
  topAuthors: [],
  series: [],
  lengths: [0, 0, 0, 0],
  averageLength: 0,
  highlightsWithNotes: 0,
  longestLength: 0,
  coverage: { highlightsDated: 9, booksWithSeries: 0, finishedDated: 0 },
};

describe("reading summary", () => {
  it("finds the longest run of consecutive days, the busiest day, and the span", () => {
    const summary = readingSummary({
      ...base,
      days: [
        { day: "2026-08-30", highlights: 1 },
        { day: "2026-08-31", highlights: 4 },
        { day: "2026-09-01", highlights: 2 },
        { day: "2026-09-05", highlights: 2 },
      ],
      books: [
        { bookId: "a" as never, title: "A", authors: [], status: "finished", highlights: 7, notes: 0, activeDays: 3, averageLength: 120 },
        { bookId: "b" as never, title: "B", authors: [], status: "reading", highlights: 2, notes: 2, activeDays: 1, averageLength: 80 },
      ],
    });
    expect(summary).toMatchObject({ activeDays: 4, spanDays: 7, longestRun: 3, busiest: { day: "2026-08-31", highlights: 4 } });
    expect(summary?.topBook?.title).toBe("A");
    expect(summary?.topNotes?.title).toBe("B");
  });

  it("has nothing to say without passages", () => {
    expect(readingSummary({ ...base, days: [], books: [] })).toBeUndefined();
  });
});
