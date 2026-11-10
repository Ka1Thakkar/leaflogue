import type { BookId, HighlightId, LibraryDuplicates, LibraryExportDocument } from "@leaflogue/contracts";
import { normalizeBookText } from "./index";

/**
 * Duplicate detection across sources (roadmap: reader features). It only
 * suggests: merging books stays the reader's reviewed choice on the book
 * page, and repeated passages are pointed out, never removed.
 */

const MIN_PASSAGE_KEY = 10;

function authorsOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const names = new Set(left.map(normalizeBookText));
  return right.some((author) => names.has(normalizeBookText(author)));
}

export function findLibraryDuplicates(document: LibraryExportDocument): LibraryDuplicates {
  const byTitle = new Map<string, LibraryExportDocument["books"][number]["book"][]>();
  for (const { book } of document.books) {
    if (book.archived) continue;
    const key = normalizeBookText(book.title);
    if (!key) continue;
    byTitle.set(key, [...(byTitle.get(key) ?? []), book]);
  }
  const books: { bookIds: BookId[]; title: string }[] = [];
  for (const group of byTitle.values()) {
    // Group copies that share an author with the first unclaimed copy.
    const unclaimed = [...group].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    while (unclaimed.length > 1) {
      const [first, ...rest] = unclaimed;
      const copies = [first!, ...rest.filter((book) => authorsOverlap(first!.authors, book.authors))];
      for (const copy of copies) unclaimed.splice(unclaimed.indexOf(copy), 1);
      if (copies.length > 1) books.push({ bookIds: copies.map(({ id }) => id), title: first!.title });
    }
  }

  const passages: { bookId: BookId; highlightIds: HighlightId[] }[] = [];
  for (const { book, highlights } of document.books) {
    const byText = new Map<string, HighlightId[]>();
    for (const highlight of [...highlights].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
      const key = normalizeBookText(highlight.text);
      if (key.length < MIN_PASSAGE_KEY) continue;
      byText.set(key, [...(byText.get(key) ?? []), highlight.id]);
    }
    for (const highlightIds of byText.values()) {
      if (highlightIds.length > 1) passages.push({ bookId: book.id, highlightIds });
    }
  }

  return {
    books: books.sort((a, b) => a.title.localeCompare(b.title)),
    passages,
  };
}
