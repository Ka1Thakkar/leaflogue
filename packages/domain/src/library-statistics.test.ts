import { describe, expect, it } from "vitest";
import type { BookContents, BookId, LibraryExportDocument } from "@leaflogue/contracts";
import { libraryStatistics } from "./library-statistics";

const now = new Date("2026-10-05T12:00:00Z");
let next = 0;
const id = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` as never;

function book(title: string, authors: string[], status: "unread" | "reading" | "finished", options: { completedOn?: string; archived?: boolean; highlightsAt?: number[] } = {}): BookContents {
  const bookId = id() as BookId;
  return {
    book: { id: bookId, title, authors, status, archived: options.archived ?? false, createdAt: 0, updatedAt: 0, revision: 1, highlightCount: options.highlightsAt?.length ?? 0, ...(options.completedOn ? { completedOn: options.completedOn } : {}) },
    highlights: (options.highlightsAt ?? []).map((at) => ({
      id: id(), bookId, text: "x", createdAt: at, updatedAt: at, revision: 1,
      notes: [{ id: id(), bookId, markdown: "n", origin: "reader" as const, createdAt: at, updatedAt: at, revision: 1 }],
    })),
    standaloneNotes: [],
  };
}

const orchard = book("The Glass Orchard", ["Imogen Vale"], "finished", { completedOn: "2024-03-01", highlightsAt: [Date.parse("2026-09-10"), Date.parse("2026-09-20"), Date.parse("2026-01-02")] });
const harbour = book("Harbour of Small Lights", ["Tomas Reyes"], "reading", { highlightsAt: [Date.parse("2026-10-01")] });
const archived = book("Notes on Tidewater", ["Imogen Vale"], "finished", { archived: true, highlightsAt: [Date.parse("2025-08-15")] });
const marked = book("Marked Finished", ["Ada Morrow"], "finished");
const unread = book("Unread", [], "unread");

const document: LibraryExportDocument = {
  format: "leaflogue-library",
  formatVersion: 4,
  exportedAt: now.toISOString(),
  books: [orchard, harbour, archived, marked, unread],
  collections: [],
  tags: [],
  organizations: [],
  readingStatusEvents: [
    { id: id(), bookId: archived.book.id, status: "finished", source: "reader", changedAt: Date.parse("2026-02-01"), bookRevision: 1 },
    { id: id(), bookId: marked.book.id, status: "reading", source: "reader", changedAt: Date.parse("2025-01-01"), bookRevision: 1 },
    { id: id(), bookId: marked.book.id, status: "finished", source: "kobo", changedAt: Date.parse("2025-06-01"), bookRevision: 2 },
  ],
  threads: [{ id: id(), name: "Patience", passageCount: 1, createdAt: 0, updatedAt: 0, revision: 1 }],
  threadHighlightMemberships: [],
  dailySelections: [],
};

describe("library statistics", () => {
  const stats = libraryStatistics(document, now);

  it("counts what is on the shelf now and everything ever written", () => {
    expect(stats.totals).toEqual({ books: 4, reading: 1, finished: 3, highlights: 5, notes: 5, threads: 1 });
  });

  it("counts finished books per year from completion dates or the reader's own finished mark, filling empty years", () => {
    // "Marked Finished" was only marked by a Kobo import, which says when the file was read, not when the book was finished.
    expect(stats.finishedByYear).toEqual([{ year: 2024, books: 1 }, { year: 2025, books: 0 }, { year: 2026, books: 1 }]);
    expect(stats.coverage.finishedDated).toBe(2);
  });

  it("counts highlights over the last twelve months, oldest first", () => {
    expect(stats.highlightsByMonth).toHaveLength(12);
    expect(stats.highlightsByMonth[0]).toEqual({ month: "2025-11", highlights: 0 });
    expect(stats.highlightsByMonth.at(-1)).toEqual({ month: "2026-10", highlights: 1 });
    expect(stats.highlightsByMonth.find(({ month }) => month === "2026-09")).toEqual({ month: "2026-09", highlights: 2 });
  });

  it("ranks the most highlighted books and authors", () => {
    expect(stats.topBooks.map(({ title, highlights }) => [title, highlights])).toEqual([
      ["The Glass Orchard", 3], ["Harbour of Small Lights", 1], ["Notes on Tidewater", 1],
    ]);
    expect(stats.topAuthors).toEqual([{ name: "Imogen Vale", highlights: 4, books: 2 }, { name: "Tomas Reyes", highlights: 1, books: 1 }]);
  });

  it("shows only this year when nothing has been finished", () => {
    const empty = libraryStatistics({ ...document, books: [unread], readingStatusEvents: [] }, now);
    expect(empty.finishedByYear).toEqual([{ year: 2026, books: 0 }]);
    expect(empty.topBooks).toEqual([]);
  });
  it("counts passages per local day, per book, by length, and what data each chart can rely on", () => {
    expect(stats.days.map(({ highlights }) => highlights)).toEqual([1, 1, 1, 1, 1]);
    expect(stats.days.map(({ day }) => day)).toEqual([...stats.days.map(({ day }) => day)].sort());
    expect(stats.books.map(({ title }) => title)).toEqual(["The Glass Orchard", "Harbour of Small Lights"]);
    expect(stats.books[0]).toMatchObject({ highlights: 3, notes: 3, activeDays: 3, status: "finished" });
    expect(stats.lengths).toEqual([5, 0, 0, 0]);
    expect(stats.series).toEqual([]);
    expect(stats.coverage).toEqual({ highlightsDated: 0, booksWithSeries: 0, finishedDated: 2 });
    expect(stats).toMatchObject({ averageLength: 1, longestLength: 1, highlightsWithNotes: 5 });
  });
});

describe("passage statistics", () => {
  const local = (year: number, month: number, date: number, hour: number) => new Date(year, month - 1, date, hour).getTime();
  const today = new Date(2026, 10, 9, 15);
  function shelf(title: string, status: "reading" | "paused" | "finished", passages: { at: number; dated: boolean; text?: string }[], archived = false): BookContents {
    const bookId = id() as BookId;
    return {
      book: { id: bookId, title, authors: ["A"], status, archived, createdAt: 0, updatedAt: 0, revision: 1, highlightCount: passages.length },
      highlights: passages.map(({ at, dated, text }) => ({
        id: id(), bookId, text: text ?? `${title} at ${at}`, createdAt: dated ? local(2026, 11, 1, 9) : at, updatedAt: at, revision: 1, notes: [],
        ...(dated ? { sourceCreatedAt: at } : {}),
      })),
      standaloneNotes: [],
    };
  }
  const reading = shelf("Reading", "reading", [{ at: local(2025, 11, 9, 22), dated: true }, { at: local(2026, 11, 8, 7), dated: true }]);
  const paused = shelf("Paused", "paused", [{ at: local(2024, 11, 9, 22), dated: true, text: `${"word ".repeat(100)}end` }]);
  const added = shelf("Added", "finished", [{ at: local(2023, 11, 9, 10), dated: false }]);
  const gone = shelf("Gone", "reading", [{ at: local(2022, 11, 9, 8), dated: true }], true);
  const stats = libraryStatistics({ ...document, books: [reading, paused, added, gone] }, today);

  it("counts dated passages by local hour, leaving out passages without a highlight time", () => {
    expect(stats.hours).toHaveLength(24);
    expect(stats.hours[22]).toBe(2);
    expect(stats.hours[7]).toBe(1);
    expect(stats.hours[10]).toBe(0);
  });

  it("finds dated passages from today's date in earlier years, newest first, without archived books", () => {
    expect(stats.onThisDay.map(({ title, day }) => [title, day])).toEqual([["Reading", "2025-11-09"], ["Paused", "2024-11-09"]]);
    expect(stats.onThisDay[1]!.text.length).toBeLessThanOrEqual(281);
    expect(stats.onThisDay[1]!.text.endsWith("…")).toBe(true);
  });

  it("lists recently kept passages newest first", () => {
    expect(stats.recent.map(({ title, day }) => [title, day])).toEqual([["Reading", "2026-11-08"], ["Reading", "2025-11-09"], ["Paused", "2024-11-09"], ["Added", "2023-11-09"]]);
  });

  it("lists books being read or set aside with their latest passage", () => {
    expect(stats.inProgress.map(({ title, status, lastDay, highlights }) => ({ title, status, lastDay, highlights }))).toEqual([
      { title: "Reading", status: "reading", lastDay: "2026-11-08", highlights: 2 },
      { title: "Paused", status: "paused", lastDay: "2024-11-09", highlights: 1 },
    ]);
    expect(stats.inProgress[0]!.latest?.day).toBe("2026-11-08");
  });
});
