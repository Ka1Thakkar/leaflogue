import type { Book, Highlight, LibraryBookStatistics, LibraryExportDocument, LibraryPassageStatistic, LibraryProgressStatistic, LibraryStatistics } from "@leaflogue/contracts";
import { knownFinishedYear } from "./widgets";

/**
 * Reading statistics (roadmap: reader features), computed from the same
 * snapshot the exports use, so nothing new is stored or tracked. Archived
 * books count towards history (finished per year, highlights over time) but
 * not towards what is on the shelf now.
 */

const TOP = 10;
const MONTHS = 12;
/** Passages listed by "on this day" and "recently kept". */
const PASSAGES = 8;
/** Long passages are cut here for the dashboard; the book page has the rest. */
const EXCERPT = 280;

/** The reader's own calendar day, in this computer's time zone. */
function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}


function excerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= EXCERPT) return trimmed;
  const cut = trimmed.slice(0, EXCERPT);
  const space = cut.lastIndexOf(" ");
  return `${(space > EXCERPT * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function passage(book: Book, highlight: Highlight): LibraryPassageStatistic {
  return {
    highlightId: highlight.id,
    bookId: book.id,
    title: book.title,
    text: excerpt(highlight.text),
    day: dayKey(highlight.sourceCreatedAt ?? highlight.createdAt),
  };
}

/** When a passage was kept: highlighted, when the device said so, else added. */
function keptAt(highlight: Highlight): number {
  return highlight.sourceCreatedAt ?? highlight.createdAt;
}

export function libraryStatistics(document: LibraryExportDocument, now = new Date()): LibraryStatistics {
  const books = document.books.map(({ book }) => book);
  const shelf = books.filter((book) => !book.archived);
  const highlights = document.books.flatMap(({ highlights: list }) => list);
  const notes = document.books.reduce((total, { highlights: list, standaloneNotes }) =>
    total + standaloneNotes.length + list.reduce((sum, highlight) => sum + highlight.notes.length, 0), 0);

  const years = new Map<number, number>();
  let finishedDated = 0;
  for (const book of books) {
    if (book.status !== "finished") continue;
    const year = knownFinishedYear(document.readingStatusEvents, book.id, book.completedOn);
    if (year !== undefined && Number.isInteger(year)) {
      years.set(year, (years.get(year) ?? 0) + 1);
      finishedDated += 1;
    }
  }
  const currentYear = now.getUTCFullYear();
  const firstYear = Math.min(currentYear, ...years.keys());
  const finishedByYear = Array.from({ length: currentYear - firstYear + 1 }, (_, index) => {
    const year = firstYear + index;
    return { year, books: years.get(year) ?? 0 };
  });

  const months = new Map<string, number>();
  for (const highlight of highlights) {
    const key = monthKey(highlight.sourceCreatedAt ?? highlight.createdAt);
    months.set(key, (months.get(key) ?? 0) + 1);
  }
  const highlightsByMonth = Array.from({ length: MONTHS }, (_, index) => {
    const month = monthKey(Date.UTC(currentYear, now.getUTCMonth() - (MONTHS - 1 - index), 1));
    return { month, highlights: months.get(month) ?? 0 };
  });

  const topBooks = document.books
    .map(({ book, highlights: list }) => ({ bookId: book.id, title: book.title, highlights: list.length }))
    .filter(({ highlights: count }) => count > 0)
    .sort((a, b) => b.highlights - a.highlights || a.title.localeCompare(b.title))
    .slice(0, TOP);

  const authors = new Map<string, { highlights: number; books: number }>();
  for (const { book, highlights: list } of document.books) {
    for (const author of book.authors) {
      const entry = authors.get(author) ?? { highlights: 0, books: 0 };
      entry.highlights += list.length;
      entry.books += list.length > 0 ? 1 : 0;
      authors.set(author, entry);
    }
  }
  const topAuthors = [...authors]
    .map(([name, entry]) => ({ name, ...entry }))
    .filter(({ highlights: count }) => count > 0)
    .sort((a, b) => b.highlights - a.highlights || a.name.localeCompare(b.name))
    .slice(0, TOP);

  const days = new Map<string, number>();
  const lengths: [number, number, number, number] = [0, 0, 0, 0];
  let highlightsDated = 0;
  let totalLength = 0;
  let longestLength = 0;
  for (const highlight of highlights) {
    totalLength += highlight.text.length;
    longestLength = Math.max(longestLength, highlight.text.length);
    if (highlight.sourceCreatedAt !== undefined) highlightsDated += 1;
    const key = dayKey(highlight.sourceCreatedAt ?? highlight.createdAt);
    days.set(key, (days.get(key) ?? 0) + 1);
    const length = highlight.text.length;
    lengths[length <= 100 ? 0 : length <= 300 ? 1 : length <= 600 ? 2 : 3] += 1;
  }

  const bookStatistics: LibraryBookStatistics[] = [];
  for (const { book, highlights: list, standaloneNotes } of document.books) {
    if (book.archived) continue;
    const bookDays = [...new Set(list.map((highlight) => dayKey(highlight.sourceCreatedAt ?? highlight.createdAt)))].sort();
    const noteCount = standaloneNotes.length + list.reduce((sum, highlight) => sum + highlight.notes.length, 0);
    if (list.length === 0 && noteCount === 0) continue;
    bookStatistics.push({
      bookId: book.id,
      title: book.title,
      authors: book.authors,
      status: book.status,
      ...(book.series?.trim() ? { series: book.series.trim() } : {}),
      highlights: list.length,
      notes: noteCount,
      activeDays: bookDays.length,
      averageLength: list.length ? Math.round(list.reduce((sum, highlight) => sum + highlight.text.length, 0) / list.length) : 0,
      ...(bookDays.length ? { firstDay: bookDays[0], lastDay: bookDays.at(-1) } : {}),
    });
  }
  bookStatistics.sort((a, b) => b.highlights - a.highlights || a.title.localeCompare(b.title));

  const seriesMap = new Map<string, { books: number; finished: number; highlights: number }>();
  for (const { book, highlights: list } of document.books) {
    const name = book.series?.trim();
    if (!name || book.archived) continue;
    const entry = seriesMap.get(name) ?? { books: 0, finished: 0, highlights: 0 };
    entry.books += 1;
    entry.finished += book.status === "finished" ? 1 : 0;
    entry.highlights += list.length;
    seriesMap.set(name, entry);
  }

  const hours = Array.from({ length: 24 }, () => 0);
  const today = { month: now.getMonth(), date: now.getDate(), year: now.getFullYear() };
  const onThisDay: { at: number; passage: LibraryPassageStatistic }[] = [];
  const kept: { at: number; book: Book; highlight: Highlight }[] = [];
  const inProgress: LibraryProgressStatistic[] = [];
  for (const { book, highlights: list } of document.books) {
    if (book.archived) continue;
    let latest: Highlight | undefined;
    for (const highlight of list) {
      const at = keptAt(highlight);
      if (!latest || at > keptAt(latest)) latest = highlight;
      kept.push({ at, book, highlight });
      if (highlight.sourceCreatedAt === undefined) continue;
      const when = new Date(highlight.sourceCreatedAt);
      hours[when.getHours()]! += 1;
      if (when.getMonth() === today.month && when.getDate() === today.date && when.getFullYear() < today.year) {
        onThisDay.push({ at: highlight.sourceCreatedAt, passage: passage(book, highlight) });
      }
    }
    if (book.status === "reading" || book.status === "paused") {
      inProgress.push({
        bookId: book.id,
        title: book.title,
        authors: book.authors,
        status: book.status,
        highlights: list.length,
        ...(latest ? { lastDay: dayKey(keptAt(latest)), latest: passage(book, latest) } : {}),
      });
    }
  }
  const newestFirst = (a: { at: number }, b: { at: number }) => b.at - a.at;
  inProgress.sort((a, b) => (b.lastDay ?? "").localeCompare(a.lastDay ?? "") || a.title.localeCompare(b.title));

  return {
    hours,
    onThisDay: onThisDay.sort(newestFirst).slice(0, PASSAGES).map((entry) => entry.passage),
    recent: kept.sort(newestFirst).slice(0, PASSAGES).map(({ book, highlight }) => passage(book, highlight)),
    inProgress,
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, highlights: count })),
    books: bookStatistics,
    series: [...seriesMap]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => b.highlights - a.highlights || a.name.localeCompare(b.name)),
    lengths,
    averageLength: highlights.length ? Math.round(totalLength / highlights.length) : 0,
    highlightsWithNotes: highlights.filter((highlight) => highlight.notes.length > 0).length,
    longestLength,
    coverage: {
      highlightsDated,
      booksWithSeries: shelf.filter((book) => book.series?.trim()).length,
      finishedDated,
    },
    totals: {
      books: shelf.length,
      reading: shelf.filter((book) => book.status === "reading").length,
      finished: books.filter((book) => book.status === "finished").length,
      highlights: highlights.length,
      notes,
      threads: document.threads.length,
    },
    finishedByYear,
    highlightsByMonth,
    topBooks,
    topAuthors,
  };
}
