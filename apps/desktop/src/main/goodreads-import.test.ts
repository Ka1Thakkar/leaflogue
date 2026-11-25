import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseGoodreadsCsv } from "@leaflogue/importers";
import { LocalLibrary } from "@leaflogue/storage";

const csv = (review: string) => `Book Id,Title,Author,Exclusive Shelf,My Review\n42,Synthetic review book,Reader,read,${review}\n`;

describe("Goodreads canonical import", () => {
  it("imports a review as a standalone note, replays idempotently and reconciles edited source text", () => {
    const library = new LocalLibrary(":memory:");
    const source = { id: randomUUID(), name: "Goodreads test" };
    const commit = (review: string) => {
      const parsed = parseGoodreadsCsv(csv(review));
      return library.importDocument({ ...parsed, provider: "goodreads", source, fileName: "synthetic.csv" });
    };
    try {
      expect(commit("First review")).toMatchObject({ booksCreated: 1, notesCreated: 1, highlightsCreated: 0 });
      expect(commit("First review")).toMatchObject({ booksCreated: 0, notesCreated: 0, highlightsCreated: 0 });
      expect(commit("Edited review")).toMatchObject({ annotationsUpdated: 1 });
      const book = library.listBooks()[0]!;
      expect(book.status).toBe("finished");
      const contents = library.getBookContents(book.id)!;
      expect(contents.highlights).toEqual([]);
      expect(contents.standaloneNotes).toHaveLength(1);
      const note = contents.standaloneNotes[0]!;
      expect(note.markdown).toBe("Edited review");
      library.updateNote({ id: note.id, bookId: book.id, expectedRevision: note.revision, markdown: "My local correction" });
      expect(commit("Another source edit")).toMatchObject({ conflictsCreated: 1 });
      expect(library.getBookContents(book.id)!.standaloneNotes[0]!.markdown).toBe("My local correction");
    } finally { library.close(); }
  });
});
