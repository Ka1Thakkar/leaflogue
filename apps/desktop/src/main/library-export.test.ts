import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BookContents, BookId, ReadingStatusEvent } from "@leaflogue/contracts";
import { assertSafeExportDestination, countLibraryExport, createLibraryExport, writeLibraryExport } from "./library-export";

const firstBook = "5a540f21-7f61-44d7-89a5-f1b4643ce26c" as BookId;
const secondBook = "6b651032-8a72-45e8-9ab6-a2c5754df37d" as BookId;
const timestamp = Date.parse("2026-09-20T10:00:00.000Z");

const contents = new Map<BookId, BookContents>([
  [firstBook, {
    book: { id: firstBook, title: "Piranesi", authors: ["Susanna Clarke"], status: "reading", archived: false, createdAt: timestamp, updatedAt: timestamp, revision: 1, highlightCount: 1 },
    highlights: [{ id: "77a0ecda-8fa0-413c-9738-577e8b2ec5cf" as never, bookId: firstBook, text: "Every room of the House", createdAt: timestamp, updatedAt: timestamp, revision: 1, notes: [{ id: "8ad86070-a9f3-4f58-a760-dcd21b02fc38" as never, bookId: firstBook, highlightId: "77a0ecda-8fa0-413c-9738-577e8b2ec5cf" as never, markdown: "Attached", origin: "reader", createdAt: timestamp, updatedAt: timestamp, revision: 1 }] }],
    standaloneNotes: [{ id: "9bc4a985-51c7-4cc3-8c65-80d6c7e49435" as never, bookId: firstBook, markdown: "Standalone", origin: "reader", createdAt: timestamp, updatedAt: timestamp, revision: 1 }],
  }],
  [secondBook, {
    book: { id: secondBook, title: "Archived", authors: [], status: "finished", completedOn: "2024-02-29", archived: true, createdAt: timestamp, updatedAt: timestamp, revision: 2, highlightCount: 0 },
    highlights: [],
    standaloneNotes: [],
  }],
]);
const collections = [{ id: "30000000-0000-4000-8000-000000000000" as never, name: "Keepers", description: "Books worth returning to", bookCount: 1, createdAt: timestamp, updatedAt: timestamp, revision: 1 }];
const tags = [{ id: "40000000-0000-4000-8000-000000000000" as never, name: "Revisit", color: "ochre", bookCount: 1, highlightCount: 1, createdAt: timestamp, updatedAt: timestamp, revision: 1 }];
const organizations = new Map([...contents.keys()].map((bookId) => [bookId, {
  bookId,
  collectionIds: bookId === firstBook ? [collections[0]!.id] : [],
  tagIds: bookId === firstBook ? [tags[0]!.id] : [],
  highlightTags: bookId === firstBook ? [{ highlightId: contents.get(firstBook)!.highlights[0]!.id, tagIds: [tags[0]!.id] }] : [],
}] as const));
const readingStatusEvents = new Map<BookId, readonly ReadingStatusEvent[]>([
  [firstBook, [{
    id: "50000000-0000-4000-8000-000000000000" as never,
    bookId: firstBook,
    status: "reading",
    source: "reader",
    changedAt: timestamp,
    bookRevision: 1,
  }]],
  [secondBook, [{
    id: "60000000-0000-4000-8000-000000000000" as never,
    bookId: secondBook,
    status: "finished",
    source: "kobo",
    changedAt: timestamp - 1,
    completedOn: "2026-09-20",
    bookRevision: 2,
  }]],
]);
const threads = [{ id: "70000000-0000-4000-8000-000000000000" as never, name: "Labyrinths", passageCount: 1, createdAt: timestamp, updatedAt: timestamp, revision: 1 }];
const threadHighlightMemberships = [{ threadId: threads[0]!.id, highlightId: contents.get(firstBook)!.highlights[0]!.id, addedAt: timestamp }];
const dailySelections = [{ id: "80000000-0000-4000-8000-000000000000" as never, localDay: "2026-09-20", timezone: "UTC", highlightId: contents.get(firstBook)!.highlights[0]!.id, candidateDigest: "a".repeat(64), recentHighlightIds: [contents.get(firstBook)!.highlights[0]!.id], selectedAt: timestamp, updatedAt: timestamp, revision: 1 }];
const organizationRepository = {
  readSnapshot: <T>(read: () => T): T => read(),
  listCollections: () => collections,
  listTags: () => tags,
  getBookOrganization: (id: BookId) => organizations.get(id),
  listReadingStatusHistory: (id: BookId) => readingStatusEvents.get(id) ?? [],
  iterateReadingStatusHistory: (id: BookId) => readingStatusEvents.get(id)?.values() ?? [][Symbol.iterator](),
  listThreads: () => threads,
  listThreadHighlightMemberships: () => threadHighlightMemberships,
  listDailySelections: () => dailySelections,
};

describe("library export", () => {
  it("exports active and archived reading data without configuration state", () => {
    const document = createLibraryExport({
      ...organizationRepository,
      listBooks: () => [...contents.values()].map(({ book }) => book),
      getBookContents: (id) => contents.get(id),
    }, new Date(timestamp));

    expect(document).toMatchObject({
      format: "leaflogue-library",
      formatVersion: 4,
      exportedAt: "2026-09-20T10:00:00.000Z",
      books: [{ book: { title: "Piranesi", archived: false } }, { book: { title: "Archived", completedOn: "2024-02-29", archived: true } }],
      collections: [{ name: "Keepers" }],
      tags: [{ name: "Revisit" }],
      threads: [{ name: "Labyrinths" }],
      threadHighlightMemberships,
      dailySelections,
    });
    expect(document.organizations[0]).toEqual(organizations.get(firstBook));
    expect(document.organizations[1]).toEqual(organizations.get(secondBook));
    expect(document.readingStatusEvents).toEqual([
      ...readingStatusEvents.get(firstBook)!,
      ...readingStatusEvents.get(secondBook)!,
    ]);
    expect(JSON.stringify(document)).not.toMatch(/credential|databaseUrl|deviceId/i);
    expect(countLibraryExport(document)).toEqual({ booksExported: 2, highlightsExported: 1, notesExported: 2 });
  });

  it("fails instead of writing a partial snapshot", () => {
    expect(() => createLibraryExport({
      ...organizationRepository,
      listBooks: () => [{ ...contents.get(firstBook)!.book }],
      getBookContents: () => undefined,
    })).toThrow("Library changed while it was being exported");
  });

  it("atomically replaces the destination with a protected JSON file", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-export-"));
    const path = join(directory, "library.json");
    try {
      writeFileSync(path, "stale", { mode: 0o644 });
      const document = createLibraryExport({
        ...organizationRepository,
        listBooks: () => [...contents.values()].map(({ book }) => book),
        getBookContents: (id) => contents.get(id),
      }, new Date(timestamp));

      const counts = writeLibraryExport(path, {
        ...organizationRepository,
        listBooks: () => [...contents.values()].map(({ book }) => book),
        getBookContents: (id) => contents.get(id),
      }, new Date(timestamp));

      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(document);
      expect(counts).toEqual({ booksExported: 2, highlightsExported: 1, notesExported: 2 });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(directory)).toEqual(["library.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves the destination and removes temporary files when the byte limit is exceeded", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-export-failure-"));
    const path = join(directory, "library.json");
    try {
      writeFileSync(path, "keep me", { mode: 0o600 });
      expect(() => writeLibraryExport(path, {
        ...organizationRepository,
        listBooks: () => [...contents.values()].map(({ book }) => book),
        getBookContents: (id) => contents.get(id),
      }, new Date(timestamp), 32)).toThrow("Library export exceeds");

      expect(readFileSync(path, "utf8")).toBe("keep me");
      expect(readdirSync(directory)).toEqual(["library.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves the destination when status-history collection fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-export-history-failure-"));
    const path = join(directory, "library.json");
    try {
      writeFileSync(path, "keep me", { mode: 0o600 });
      expect(() => writeLibraryExport(path, {
        ...organizationRepository,
        listBooks: () => [...contents.values()].map(({ book }) => book),
        getBookContents: (id) => contents.get(id),
        iterateReadingStatusHistory: () => ({
          [Symbol.iterator]: () => ({
            next: () => {
              throw new Error("status history unavailable");
            },
          }),
        }),
      }, new Date(timestamp))).toThrow("status history unavailable");

      expect(readFileSync(path, "utf8")).toBe("keep me");
      expect(readdirSync(directory)).toEqual(["library.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("streams status history and fails closed if the book changes during export", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-export-race-"));
    const path = join(directory, "library.json");
    let revision = 1;
    let eventsRead = 0;
    try {
      writeFileSync(path, "keep me", { mode: 0o600 });
      expect(() => writeLibraryExport(path, {
        ...organizationRepository,
        listBooks: () => [contents.get(firstBook)!.book],
        getBookContents: () => ({
          ...contents.get(firstBook)!,
          book: { ...contents.get(firstBook)!.book, revision },
        }),
        iterateReadingStatusHistory: function* () {
          eventsRead += 1;
          yield readingStatusEvents.get(firstBook)![0]!;
          revision = 2;
        },
      }, new Date(timestamp))).toThrow("Library changed while it was being exported");

      expect(eventsRead).toBe(1);
      expect(readFileSync(path, "utf8")).toBe("keep me");
      expect(readdirSync(directory)).toEqual(["library.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops pulling status events as soon as the byte limit is exceeded", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-export-streaming-"));
    const path = join(directory, "library.json");
    let eventsRead = 0;
    try {
      expect(() => writeLibraryExport(path, {
        ...organizationRepository,
        listBooks: () => [contents.get(firstBook)!.book],
        getBookContents: () => contents.get(firstBook),
        iterateReadingStatusHistory: function* () {
          while (true) {
            eventsRead += 1;
            yield readingStatusEvents.get(firstBook)![0]!;
          }
        },
      }, new Date(timestamp), 10_000)).toThrow("Library export exceeds");

      expect(eventsRead).toBeGreaterThan(0);
      expect(eventsRead).toBeLessThan(100);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects the live SQLite database and its operational sidecars", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-export-paths-"));
    const realDirectory = join(directory, "real-profile");
    const aliasDirectory = join(directory, "profile-alias");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, aliasDirectory, "dir");
    const livePath = join(aliasDirectory, "library.sqlite");
    writeFileSync(livePath, "sqlite");
    try {
      for (const unsafe of [
        livePath,
        `${livePath}-wal`,
        `${livePath}-shm`,
        join(realDirectory, "library.sqlite"),
        join(realDirectory, "library.sqlite-wal"),
        join(realDirectory, "library.sqlite-shm"),
      ]) {
        expect(() => assertSafeExportDestination(unsafe, livePath)).toThrow("outside Leaflogue's live library");
      }
      expect(() => assertSafeExportDestination(join(realDirectory, "export.json"), livePath)).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
