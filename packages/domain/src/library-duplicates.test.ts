import { describe, expect, it } from "vitest";
import type { BookContents, BookId, LibraryExportDocument } from "@leaflogue/contracts";
import { findLibraryDuplicates } from "./library-duplicates";

let next = 0;
const id = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` as never;

function book(title: string, authors: string[], options: { archived?: boolean; passages?: string[]; createdAt?: number } = {}): BookContents {
  const bookId = id() as BookId;
  const createdAt = options.createdAt ?? next;
  return {
    book: { id: bookId, title, authors, status: "reading", archived: options.archived ?? false, createdAt, updatedAt: createdAt, revision: 1, highlightCount: 0 },
    highlights: (options.passages ?? []).map((text, index) => ({ id: id(), bookId, text, createdAt: createdAt + index, updatedAt: createdAt, revision: 1, notes: [] })),
    standaloneNotes: [],
  };
}

function library(books: BookContents[]): LibraryExportDocument {
  return {
    format: "leaflogue-library", formatVersion: 4, exportedAt: "2026-10-05T00:00:00.000Z", books,
    collections: [], tags: [], organizations: [], readingStatusEvents: [], threads: [], threadHighlightMemberships: [], dailySelections: [],
  };
}

describe("duplicate detection", () => {
  it("pairs copies whose titles match once normalised and whose authors overlap", () => {
    const kobo = book("The Glass Orchard", ["Imogen Vale"], { createdAt: 1 });
    const kindle = book("the glass orchard!", ["imogen vale", "A. Translator"], { createdAt: 2 });
    const untitledAuthor = book("THE GLASS ORCHARD", [], { createdAt: 3 });
    const { books } = findLibraryDuplicates(library([kindle, kobo, untitledAuthor]));
    expect(books).toEqual([{ bookIds: [kobo.book.id, kindle.book.id, untitledAuthor.book.id], title: "The Glass Orchard" }]);
  });

  it("keeps different books with the same title apart, and ignores archived copies", () => {
    const one = book("Collected Poems", ["Ada Morrow"]);
    const other = book("Collected Poems", ["Tomas Reyes"]);
    const archived = book("Harbour of Small Lights", ["Tomas Reyes"], { archived: true });
    const active = book("Harbour of Small Lights", ["Tomas Reyes"]);
    expect(findLibraryDuplicates(library([one, other, archived, active])).books).toEqual([]);
  });

  it("finds passages repeated within a book, ignoring case, spacing, and punctuation", () => {
    const orchard = book("The Glass Orchard", ["Imogen Vale"], {
      passages: ["Every pane held a season.", "every  pane held a season", "She pruned the light.", "Short", "short"],
    });
    const { passages } = findLibraryDuplicates(library([orchard]));
    expect(passages).toEqual([{ bookId: orchard.book.id, highlightIds: [orchard.highlights[0]!.id, orchard.highlights[1]!.id] }]);
  });
});
