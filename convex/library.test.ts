// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { normalizeBookMetadata as sharedNormalizeBookMetadata } from "@leaflogue/domain";
import { MAX_NOTE_BYTES, MAX_NOTES_PER_HIGHLIGHT } from "@leaflogue/contracts";
import type { BookResult } from "./libraryContracts";
import { normalizeBookMetadata } from "./library";
import schema from "./schema";
import { convexModules } from "./test.setup";

const LIBRARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_LIBRARY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SOURCE_BOOK = "11111111-1111-4111-8111-111111111111";
const TARGET_BOOK = "22222222-2222-4222-8222-222222222222";
const HIGHLIGHT = "33333333-3333-4333-8333-333333333333";
const NOTE = "44444444-4444-4444-8444-444444444444";

interface HighlightResult {
  id: string;
  bookId: string;
  text: string;
  sourceLocation?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

interface NoteResult {
  id: string;
  bookId: string;
  highlightId?: string;
  markdown: string;
  origin: "reader" | "import" | "ai";
  createdAt: number;
  updatedAt: number;
  revision: number;
}

const functions = {
  createBook: makeFunctionReference<"mutation", { libraryId: string; id: string; title: string; authors?: string[]; isbn13?: string }, { id: string; title: string; authors: string[]; isbn13?: string; revision: number; highlightCount: number }>("library:createBook"),
  createHighlight: makeFunctionReference<"mutation", { libraryId: string; id: string; bookId: string; text: string; sourceLocation?: string; noteId?: string; noteMarkdown?: string }, HighlightResult>("library:createHighlight"),
  updateHighlight: makeFunctionReference<"mutation", { libraryId: string; id: string; bookId: string; text: string; sourceLocation?: string; expectedRevision: number }, HighlightResult>("library:updateHighlight"),
  createNote: makeFunctionReference<"mutation", { libraryId: string; id: string; bookId: string; highlightId?: string; markdown: string; origin?: "reader" | "ai" }, NoteResult>("library:createNote"),
  updateNote: makeFunctionReference<"mutation", { libraryId: string; id: string; bookId: string; markdown: string; expectedRevision: number }, NoteResult>("library:updateNote"),
  setBookArchived: makeFunctionReference<"mutation", { libraryId: string; id: string; archived: boolean; expectedRevision: number }, { bookId: string; archived: boolean; revision: number; updatedAt: number }>("library:setBookArchived"),
  setBookCompletionDate: makeFunctionReference<"mutation", { libraryId: string; id: string; completedOn?: string; expectedRevision: number }, BookResult>("library:setBookCompletionDate"),
  setBookReadingStatus: makeFunctionReference<"mutation", { libraryId: string; id: string; status: "unread" | "reading" | "finished" | "paused"; expectedRevision: number }, { changed: boolean; book: { id: string; status: string; completedOn?: string; revision: number }; event?: { id: string; bookId: string; status: string; source: string; changedAt: number; completedOn?: string; bookRevision: number } }>("library:setBookReadingStatus"),
  updateBookMetadata: makeFunctionReference<"mutation", { libraryId: string; id: string; expectedRevision: number; title: string; authors: string[]; description?: string; publisher?: string; series?: string; seriesNumber?: string; language?: string; isbn13?: string; coverUrl?: string }, Record<string, unknown>>("library:updateBookMetadata"),
  deleteHighlight: makeFunctionReference<"mutation", { libraryId: string; id: string; bookId: string; expectedRevision: number }, { bookId: string; bookRevision: number; revision: number; notesDeleted: number; complete: boolean }>("library:deleteHighlight"),
  deleteNote: makeFunctionReference<"mutation", { libraryId: string; id: string; bookId: string; expectedRevision: number }, { bookId: string; bookRevision: number; revision: number; notesDeleted: number }>("library:deleteNote"),
  mergeBooks: makeFunctionReference<"mutation", { libraryId: string; sourceBookId: string; targetBookId: string; expectedSourceRevision: number; expectedTargetRevision: number }, { sourceBookId: string; targetBookId: string; highlightsMoved: number; notesMoved: number; sourceRevision: number; targetRevision: number }>("library:mergeBooks"),
};

describe("Convex online mutation parity", () => {
  it("creates a client-identified book and ordered sync change", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    const createdBookId = "55555555-5555-4555-8555-555555555555";
    await expect(t.mutation(functions.createBook, {
      libraryId: LIBRARY,
      id: createdBookId,
      title: " Piranesi ",
      authors: [" Susanna Clarke "],
      isbn13: "978-1-63557-563-7",
    })).resolves.toMatchObject({
      id: createdBookId,
      title: "Piranesi",
      authors: ["Susanna Clarke"],
      isbn13: "9781635575637",
      revision: 1,
      highlightCount: 0,
    });
    await expect(t.mutation(functions.createBook, {
      libraryId: LIBRARY,
      id: createdBookId,
      title: " Piranesi ",
      authors: [" Susanna Clarke "],
      isbn13: "9781635575637",
    })).resolves.toMatchObject({ id: createdBookId, revision: 1 });
    await expect(t.mutation(functions.createBook, {
      libraryId: LIBRARY, id: createdBookId, title: "Conflicting reuse",
    })).rejects.toThrow(/different book data/);
    const changes = await t.run((ctx) => ctx.db.query("syncChanges")
      .withIndex("by_library_and_sequence", (q) => q.eq("libraryId", LIBRARY)).collect());
    expect(changes).toEqual([expect.objectContaining({ sequence: 1, entityType: "book", entityId: createdBookId, revision: 1 })]);
    await expect(t.mutation(functions.createBook, {
      libraryId: LIBRARY, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase(), title: "Case collision",
    })).rejects.toThrow(/ID is invalid/);
  });

  it("continues to update legacy mixed-case Convex entities while requiring canonical new IDs", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    const legacyBookId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const legacyHighlightId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("books", {
        libraryId: LIBRARY, id: legacyBookId, title: "Legacy", authors: [], status: "unread", archived: false,
        highlightCount: 1, noteCount: 0, readingDataBytes: recordBytes("Old"), revision: 1, createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("highlights", {
        libraryId: LIBRARY, id: legacyHighlightId, bookId: legacyBookId, text: "Old", archived: false, revision: 1, createdAt: now, updatedAt: now,
      });
    });
    await expect(t.mutation(functions.updateHighlight, {
      libraryId: LIBRARY, id: legacyHighlightId, bookId: legacyBookId, text: "Revised", expectedRevision: 1,
    })).resolves.toMatchObject({ id: legacyHighlightId, text: "Revised", revision: 2 });
  });

  it("replaces book metadata revision-safely and rejects a duplicate ISBN-13", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await expect(t.mutation(functions.updateBookMetadata, {
      libraryId: LIBRARY, id: SOURCE_BOOK, expectedRevision: 1, title: "  Piranesi ", authors: [" Susanna  Clarke "],
      description: "A house of tides.", publisher: "Bloomsbury", isbn13: "978-1-63557-563-7", coverUrl: "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg",
    })).resolves.toMatchObject({ id: SOURCE_BOOK, title: "Piranesi", authors: ["Susanna Clarke"], description: "A house of tides.", publisher: "Bloomsbury", isbn13: "9781635575637", coverUrl: "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg", revision: 2 });
    await expect(t.mutation(functions.updateBookMetadata, { libraryId: LIBRARY, id: SOURCE_BOOK, expectedRevision: 1, title: "Stale", authors: [] }))
      .rejects.toThrow(/changed elsewhere/);
    await expect(t.mutation(functions.updateBookMetadata, { libraryId: LIBRARY, id: TARGET_BOOK, expectedRevision: 1, title: "Other", authors: [], isbn13: "9781635575637" }))
      .rejects.toThrow(/Another book already has that ISBN-13/);
    const cleared = await t.mutation(functions.updateBookMetadata, { libraryId: LIBRARY, id: SOURCE_BOOK, expectedRevision: 2, title: "Piranesi", authors: [] });
    expect(cleared).not.toHaveProperty("description");
    expect(cleared).not.toHaveProperty("isbn13");
    expect(cleared).not.toHaveProperty("coverUrl");
    const changes = await t.run((ctx) => ctx.db.query("syncChanges").withIndex("by_library_and_sequence", (q) => q.eq("libraryId", LIBRARY)).collect());
    expect(changes.map(({ entityType, revision }) => [entityType, revision])).toEqual([["book", 2], ["book", 3]]);
  });

  it("ignores retained ISBN tombstones before bounding live collision checks", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    const isbn13 = "9780306406157";
    const liveId = await t.run(async (ctx) => {
      const row = { libraryId: LIBRARY, title: "Retained copy", authors: [], status: "unread" as const, archived: false, highlightCount: 0, noteCount: 0, readingDataBytes: 0, revision: 1, createdAt: 1, updatedAt: 1, isbn13 };
      await ctx.db.insert("books", { ...row, id: "70000000-0000-4000-8000-000000000001", deletedAt: 2 });
      await ctx.db.insert("books", { ...row, id: "70000000-0000-4000-8000-000000000002", deletedAt: 2 });
      return ctx.db.insert("books", { ...row, id: "70000000-0000-4000-8000-000000000003", title: "Live owner" });
    });
    const input = { libraryId: LIBRARY, id: SOURCE_BOOK, expectedRevision: 1, title: "Surviving book", authors: [], isbn13 };
    await expect(t.mutation(functions.updateBookMetadata, input)).rejects.toThrow(/Another book already has that ISBN-13/u);
    await t.run((ctx) => ctx.db.patch(liveId, { deletedAt: 3 }));
    await expect(t.mutation(functions.updateBookMetadata, input)).resolves.toMatchObject({ isbn13, revision: 2 });
    await expect(t.mutation(functions.updateBookMetadata, { ...input, title: "Edited after cleanup", expectedRevision: 2 })).resolves.toMatchObject({ title: "Edited after cleanup", isbn13, revision: 3 });
    const removed = await t.run((ctx) => ctx.db.query("books").withIndex("by_library_and_isbn13", (q) => q.eq("libraryId", LIBRARY).eq("isbn13", isbn13)).collect());
    expect(removed.filter((book) => book.deletedAt !== undefined)).toHaveLength(3);
  });

  it("normalizes metadata exactly like the shared domain rule", () => {
    for (const input of [
      { title: "  Jonathan   Strange ", authors: [" A ", "", "A", "B"], description: "  One.\n\nTwo.  ", publisher: " ", series: " S  1 ", isbn13: "978-1-63557-563-7" },
      { title: "Book", authors: [], language: " en ", seriesNumber: "  2 " },
    ]) {
      expect(normalizeBookMetadata(input)).toEqual(sharedNormalizeBookMetadata(input));
    }
    for (const input of [{ title: " ", authors: [] }, { title: "Book", authors: [], isbn13: "123" }, { title: "x".repeat(1_001), authors: [] }]) {
      expect(() => normalizeBookMetadata(input)).toThrow();
      expect(() => sharedNormalizeBookMetadata(input)).toThrow();
    }
  });

  it("tombstones a highlight with its notes, memberships, counters, and ordered changes", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    const standaloneNote = "66666666-6666-4666-8666-666666666666";
    const thread = "77777777-7777-4777-8777-777777777777";
    const tag = "88888888-8888-4888-8888-888888888888";
    await t.mutation(functions.createHighlight, { libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "Passage", sourceLocation: "10" });
    await t.mutation(functions.createNote, { libraryId: LIBRARY, id: NOTE, bookId: SOURCE_BOOK, highlightId: HIGHLIGHT, markdown: "Attached" });
    await t.mutation(functions.createNote, { libraryId: LIBRARY, id: standaloneNote, bookId: SOURCE_BOOK, markdown: "Standalone" });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("threads", { libraryId: LIBRARY, id: thread, name: "Tides", normalizedName: "tides", passageCount: 1, revision: 2, createdAt: now, updatedAt: now });
      await ctx.db.insert("threadHighlights", { libraryId: LIBRARY, threadId: thread, highlightId: HIGHLIGHT, addedAt: now });
      await ctx.db.insert("tags", { libraryId: LIBRARY, id: tag, name: "Sea", normalizedName: "sea", bookCount: 0, highlightCount: 1, revision: 3, createdAt: now, updatedAt: now });
      await ctx.db.insert("highlightTags", { libraryId: LIBRARY, tagId: tag, bookId: SOURCE_BOOK, highlightId: HIGHLIGHT, createdAt: now });
    });

    await expect(t.mutation(functions.deleteHighlight, { libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, expectedRevision: 2 }))
      .rejects.toThrow(/changed elsewhere/);
    const receipt = await t.mutation(functions.deleteHighlight, { libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, expectedRevision: 1 });
    expect(receipt).toEqual({ bookId: SOURCE_BOOK, bookRevision: 5, revision: 2, notesDeleted: 1, complete: true });

    const state = await t.run(async (ctx) => ({
      book: await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", SOURCE_BOOK)).unique(),
      highlight: await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", HIGHLIGHT)).unique(),
      notes: await ctx.db.query("notes").withIndex("by_library_and_book", (q) => q.eq("libraryId", LIBRARY).eq("bookId", SOURCE_BOOK)).collect(),
      thread: await ctx.db.query("threads").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", thread)).unique(),
      tag: await ctx.db.query("tags").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", tag)).unique(),
      memberships: [
        ...await ctx.db.query("threadHighlights").withIndex("by_library_and_highlight", (q) => q.eq("libraryId", LIBRARY).eq("highlightId", HIGHLIGHT)).collect(),
        ...await ctx.db.query("highlightTags").withIndex("by_library_and_highlight", (q) => q.eq("libraryId", LIBRARY).eq("highlightId", HIGHLIGHT)).collect(),
        ...await ctx.db.query("dailyCandidates").withIndex("by_library_and_highlight", (q) => q.eq("libraryId", LIBRARY).eq("highlightId", HIGHLIGHT)).collect(),
      ],
      changes: await ctx.db.query("syncChanges").withIndex("by_library_and_sequence", (q) => q.eq("libraryId", LIBRARY)).collect(),
    }));
    expect(state.book).toMatchObject({ highlightCount: 0, noteCount: 1, readingDataBytes: recordBytes("Standalone"), revision: 5 });
    expect(state.highlight).toMatchObject({ revision: 2, deletedAt: expect.any(Number) });
    expect(state.notes.map(({ id, deletedAt, revision }) => ({ id, deleted: deletedAt !== undefined, revision })))
      .toEqual(expect.arrayContaining([{ id: NOTE, deleted: true, revision: 2 }, { id: standaloneNote, deleted: false, revision: 1 }]));
    expect(state.thread).toMatchObject({ passageCount: 0, revision: 3 });
    expect(state.tag).toMatchObject({ highlightCount: 0, revision: 4 });
    expect(state.memberships).toEqual([]);
    expect(state.changes.slice(-5).map(({ entityType, entityId, revision }) => [entityType, entityId, revision])).toEqual([
      ["book", SOURCE_BOOK, 5],
      ["highlight", HIGHLIGHT, 2],
      ["note", NOTE, 2],
      ["thread", thread, 3],
      ["tag", tag, 4],
    ]);

    await expect(t.mutation(functions.deleteHighlight, { libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, expectedRevision: 2 }))
      .rejects.toThrow(/no longer exists/);
    await expect(t.mutation(functions.deleteNote, { libraryId: LIBRARY, id: standaloneNote, bookId: SOURCE_BOOK, expectedRevision: 1 }))
      .resolves.toEqual({ bookId: SOURCE_BOOK, bookRevision: 6, revision: 2, notesDeleted: 1, complete: true });
    await expect(t.mutation(functions.deleteNote, { libraryId: LIBRARY, id: standaloneNote, bookId: SOURCE_BOOK, expectedRevision: 2 }))
      .rejects.toThrow(/no longer exists/);
  });

  it("bounds legacy note reads before a passage deletion", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await t.mutation(functions.createHighlight, { libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "Passage" });
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 201; index += 1) {
        await ctx.db.insert("notes", {
          libraryId: LIBRARY,
          id: index === 0 ? NOTE : `legacy-active-note-${index}`,
          bookId: SOURCE_BOOK,
          highlightId: HIGHLIGHT,
          markdown: "Legacy active",
          origin: "reader",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
      const book = await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", SOURCE_BOOK)).unique();
      if (!book) throw new Error("Missing seeded book");
      await ctx.db.patch(book._id, { noteCount: 201, readingDataBytes: recordBytes("Passage") + 201 * recordBytes("Legacy active") });
    });

    // The passage leaves the reader's view on the first call, and the caller
    // repeats the deletion until the receipt says it finished. SQLite and
    // PostgreSQL do the same work in one transaction; the end state matches.
    let receipt = await t.mutation(functions.deleteHighlight, {
      libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, expectedRevision: 1,
    });
    expect(receipt).toMatchObject({ notesDeleted: 4, complete: false });

    let calls = 1;
    while (!receipt.complete) {
      receipt = await t.mutation(functions.deleteHighlight, {
        libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, expectedRevision: receipt.revision,
      });
      calls += 1;
      expect(calls).toBeLessThan(60);
    }
    expect(calls).toBe(51);

    const state = await t.run(async (ctx) => ({
      activeNotes: (await ctx.db.query("notes").withIndex("by_library_highlight_and_deleted", (q) => q.eq("libraryId", LIBRARY).eq("highlightId", HIGHLIGHT).eq("deletedAt", undefined)).collect()).length,
      book: await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", SOURCE_BOOK)).unique(),
      highlight: await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", HIGHLIGHT)).unique(),
    }));
    expect(state.activeNotes).toBe(0);
    expect(state.highlight?.deletedAt).toBeGreaterThan(0);
    // The passage is counted off the book exactly once, not once per batch.
    expect(state.book?.highlightCount).toBe(0);
    expect(state.book?.noteCount).toBe(0);
    expect(state.book?.readingDataBytes).toBe(0);
  });

  it("deletes the worst valid attached-note payload within the shared bounds", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await t.mutation(functions.createHighlight, { libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "Passage" });
    const markdown = "n".repeat(MAX_NOTE_BYTES);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < MAX_NOTES_PER_HIGHLIGHT; index += 1) {
        await ctx.db.insert("notes", {
          libraryId: LIBRARY, id: `max-note-${index}`, bookId: SOURCE_BOOK, highlightId: HIGHLIGHT,
          markdown, origin: "reader", revision: 1, createdAt: now, updatedAt: now,
        });
      }
      const book = await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", SOURCE_BOOK)).unique();
      if (!book) throw new Error("Missing seeded book");
      await ctx.db.patch(book._id, { noteCount: MAX_NOTES_PER_HIGHLIGHT, readingDataBytes: recordBytes("Passage") + MAX_NOTES_PER_HIGHLIGHT * recordBytes(markdown) });
    });

    let receipt = await t.mutation(functions.deleteHighlight, {
      libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, expectedRevision: 1,
    });
    let deleted = receipt.notesDeleted;
    while (!receipt.complete) {
      receipt = await t.mutation(functions.deleteHighlight, {
        libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, expectedRevision: receipt.revision,
      });
      deleted += receipt.notesDeleted;
    }
    expect(deleted).toBe(MAX_NOTES_PER_HIGHLIGHT);
  });

  it("stores a kept explanation as an AI note, as the local library does", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await t.mutation(functions.createHighlight, { libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "Passage" });
    await expect(t.mutation(functions.createNote, {
      libraryId: LIBRARY, id: NOTE, bookId: SOURCE_BOOK, highlightId: HIGHLIGHT, markdown: " An explanation. ", origin: "ai",
    })).resolves.toMatchObject({ id: NOTE, markdown: "An explanation.", origin: "ai", revision: 1 });
    const stored = await t.run((ctx) => ctx.db.query("notes")
      .withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", NOTE)).unique());
    expect(stored?.origin).toBe("ai");
  });

  it("rejects note bodies beyond the shared UTF-8 byte bound", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await expect(t.mutation(functions.createNote, {
      libraryId: LIBRARY, id: NOTE, bookId: SOURCE_BOOK, markdown: "é".repeat(MAX_NOTE_BYTES / 2 + 1),
    })).rejects.toThrow(/too long/);
  });

  it("rejects an attached note beyond the shared active-note bound", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await t.mutation(functions.createHighlight, { libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "Passage" });
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 200; index += 1) {
        await ctx.db.insert("notes", {
          libraryId: LIBRARY,
          id: `active-note-${index}`,
          bookId: SOURCE_BOOK,
          highlightId: HIGHLIGHT,
          markdown: "Active",
          origin: "reader",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    await expect(t.mutation(functions.createNote, {
      libraryId: LIBRARY, id: NOTE, bookId: SOURCE_BOOK, highlightId: HIGHLIGHT, markdown: "One too many",
    })).rejects.toThrow(/at most 200 active notes/);
  });

  it("creates and revision-checks highlights and notes with ordered changes", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);

    const highlight = await t.mutation(functions.createHighlight, {
      libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "  A passage.  ", sourceLocation: " 10 ",
      noteId: NOTE, noteMarkdown: "  Created atomically.  ",
    });
    expect(highlight).toMatchObject({ id: HIGHLIGHT, text: "A passage.", sourceLocation: "10", revision: 1 });
    const atomicNote = await t.run(async (ctx) => ctx.db.query("notes").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", NOTE)).unique());
    expect(atomicNote).toMatchObject({ highlightId: HIGHLIGHT, markdown: "Created atomically.", origin: "reader" });
    await expect(t.mutation(functions.createHighlight, {
      libraryId: LIBRARY, id: ` ${HIGHLIGHT} `, bookId: SOURCE_BOOK, text: "Duplicate",
    })).rejects.toThrow(/ID is invalid/);

    const updatedHighlight = await t.mutation(functions.updateHighlight, {
      libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "Changed passage.", expectedRevision: 1,
    });
    expect(updatedHighlight).toMatchObject({ text: "Changed passage.", revision: 2 });
    await expect(t.mutation(functions.updateHighlight, {
      libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "Stale edit", expectedRevision: 1,
    })).rejects.toThrow(/changed elsewhere/);

    const additionalNoteId = "55555555-5555-4555-8555-555555555555";
    const note = await t.mutation(functions.createNote, {
      libraryId: LIBRARY, id: additionalNoteId, bookId: SOURCE_BOOK, highlightId: HIGHLIGHT, markdown: "  First note.  ",
    });
    expect(note).toMatchObject({ id: additionalNoteId, highlightId: HIGHLIGHT, markdown: "First note.", revision: 1, origin: "reader" });

    const updatedNote = await t.mutation(functions.updateNote, {
      libraryId: LIBRARY, id: additionalNoteId, bookId: SOURCE_BOOK, markdown: "Changed note.", expectedRevision: 1,
    });
    expect(updatedNote).toMatchObject({ markdown: "Changed note.", revision: 2, origin: "reader" });

    const highlightAfterNote = await t.mutation(functions.updateHighlight, {
      libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "Changed again.", expectedRevision: 2,
    });
    expect(highlightAfterNote).toMatchObject({ text: "Changed again.", revision: 3 });
    expect(highlightAfterNote).not.toHaveProperty("notes");

    const state = await t.run(async (ctx) => ({
      library: await ctx.db.query("libraries").first(),
      changes: await ctx.db.query("syncChanges").withIndex("by_library_and_sequence", (q) => q.eq("libraryId", LIBRARY)).collect(),
    }));
    expect(state.library?.nextChangeSequence).toBe(11);
    expect(state.changes.map((change) => change.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const sourceBook = await t.run((ctx) => ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", SOURCE_BOOK)).unique());
    expect(sourceBook).toMatchObject({ highlightCount: 1, noteCount: 2 });
    expect(sourceBook?.readingDataBytes).toBe(recordBytes("Changed again.") + recordBytes("Created atomically.") + recordBytes("Changed note."));
  });

  it("records revision-safe reading transitions and revision-neutral replays", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);

    const reading = await t.mutation(functions.setBookReadingStatus, {
      libraryId: LIBRARY, id: SOURCE_BOOK, status: "reading", expectedRevision: 1,
    });
    expect(reading).toMatchObject({
      changed: true,
      book: { id: SOURCE_BOOK, status: "reading", revision: 2 },
      event: { bookId: SOURCE_BOOK, status: "reading", source: "reader", bookRevision: 2 },
    });
    await expect(t.mutation(functions.setBookReadingStatus, {
      libraryId: LIBRARY, id: SOURCE_BOOK, status: "reading", expectedRevision: 2,
    })).resolves.toMatchObject({ changed: false, book: { status: "reading", revision: 2 } });
    await expect(t.mutation(functions.setBookReadingStatus, {
      libraryId: LIBRARY, id: SOURCE_BOOK, status: "paused", expectedRevision: 1,
    })).rejects.toThrow(/changed elsewhere/);

    const finished = await t.mutation(functions.setBookReadingStatus, {
      libraryId: LIBRARY, id: SOURCE_BOOK, status: "finished", expectedRevision: 2,
    });
    expect(finished).toMatchObject({
      changed: true,
      book: { status: "finished", completedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u), revision: 3 },
      event: { status: "finished", completedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u), bookRevision: 3 },
    });
    await expect(t.mutation(functions.setBookCompletionDate, {
      libraryId: LIBRARY, id: SOURCE_BOOK, completedOn: "2024-02-29", expectedRevision: 3,
    })).resolves.toMatchObject({ status: "finished", completedOn: "2024-02-29", revision: 4 });
    const state = await t.run(async (ctx) => ({
      events: await ctx.db.query("readingStatusEvents")
        .withIndex("by_library_and_book_and_sequence", (q) => q.eq("libraryId", LIBRARY).eq("bookId", SOURCE_BOOK))
        .collect(),
      changes: await ctx.db.query("syncChanges")
        .withIndex("by_library_and_sequence", (q) => q.eq("libraryId", LIBRARY))
        .collect(),
    }));
    expect(state.events.map(({ sequence, status }) => ({ sequence, status })))
      .toEqual([{ sequence: 1, status: "reading" }, { sequence: 2, status: "finished" }]);
    expect(state.changes.map(({ sequence, entityType, revision }) => ({ sequence, entityType, revision })))
      .toEqual([
        { sequence: 1, entityType: "book", revision: 2 },
        { sequence: 2, entityType: "book", revision: 3 },
        { sequence: 3, entityType: "book", revision: 4 },
      ]);
  });

  it("archives and atomically merges books with their reading data", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await t.mutation(functions.createHighlight, { libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "Passage" });
    await t.mutation(functions.createNote, { libraryId: LIBRARY, id: NOTE, bookId: SOURCE_BOOK, highlightId: HIGHLIGHT, markdown: "Note" });
    await t.mutation(functions.setBookReadingStatus, {
      libraryId: LIBRARY, id: SOURCE_BOOK, status: "reading", expectedRevision: 3,
    });

    const archive = await t.mutation(functions.setBookArchived, {
      libraryId: LIBRARY, id: TARGET_BOOK, archived: true, expectedRevision: 1,
    });
    expect(archive).toMatchObject({ bookId: TARGET_BOOK, archived: true, revision: 2 });
    await t.mutation(functions.setBookArchived, {
      libraryId: LIBRARY, id: TARGET_BOOK, archived: false, expectedRevision: 2,
    });

    const beforeMerge = await t.run(async (ctx) => ({
      source: await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", SOURCE_BOOK)).unique(),
      target: await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", TARGET_BOOK)).unique(),
    }));

    const receipt = await t.mutation(functions.mergeBooks, {
      libraryId: LIBRARY, sourceBookId: SOURCE_BOOK, targetBookId: TARGET_BOOK,
      expectedSourceRevision: 4, expectedTargetRevision: 3,
    });
    expect(receipt).toMatchObject({ highlightsMoved: 1, notesMoved: 1, sourceRevision: 5, targetRevision: 4 });

    const state = await t.run(async (ctx) => ({
      source: await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", SOURCE_BOOK)).unique(),
      highlight: await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", HIGHLIGHT)).unique(),
      note: await ctx.db.query("notes").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", NOTE)).unique(),
      dailyCandidate: await ctx.db.query("dailyCandidates")
        .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", LIBRARY).eq("highlightId", HIGHLIGHT))
        .unique(),
      targetStatusEvents: await ctx.db.query("readingStatusEvents")
        .withIndex("by_library_and_book_and_sequence", (q) => q.eq("libraryId", LIBRARY).eq("bookId", TARGET_BOOK))
        .collect(),
      sourceStatusEvents: await ctx.db.query("readingStatusEvents")
        .withIndex("by_library_and_book_and_sequence", (q) => q.eq("libraryId", LIBRARY).eq("bookId", SOURCE_BOOK))
        .collect(),
    }));
    expect(state.source?.archived).toBe(true);
    expect(state.source).toMatchObject({ highlightCount: 0, noteCount: 0, readingDataBytes: 0 });
    expect(state.highlight).toMatchObject({ bookId: TARGET_BOOK, revision: 2 });
    expect(state.dailyCandidate).toMatchObject({ bookId: TARGET_BOOK, bookActive: true });
    expect(state.note).toMatchObject({ bookId: TARGET_BOOK, revision: 2 });
    expect(state.targetStatusEvents).toEqual([
      expect.objectContaining({ bookId: TARGET_BOOK, status: "reading", source: "reader", bookRevision: 4 }),
      expect.objectContaining({ bookId: TARGET_BOOK, status: "unread", source: "merge", bookRevision: 4 }),
    ]);
    expect(state.sourceStatusEvents).toEqual([]);
    const target = await t.run((ctx) => ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", TARGET_BOOK)).unique());
    expect(target).toMatchObject({ highlightCount: 1, noteCount: 1 });
    expect(target?.readingDataBytes).toBe(
      (beforeMerge.source?.readingDataBytes ?? 0) + (beforeMerge.target?.readingDataBytes ?? 0),
    );
  });

  it("isolates matching entity IDs across libraries", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await seedLibrary(t, OTHER_LIBRARY);

    await t.mutation(functions.createHighlight, {
      libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "First library only",
    });

    const otherState = await t.run(async (ctx) => ({
      book: await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", OTHER_LIBRARY).eq("id", SOURCE_BOOK)).unique(),
      highlights: await ctx.db.query("highlights").withIndex("by_library_and_book", (q) => q.eq("libraryId", OTHER_LIBRARY).eq("bookId", SOURCE_BOOK)).collect(),
    }));
    expect(otherState.book?.revision).toBe(1);
    expect(otherState.highlights).toEqual([]);
  });

  it("rejects oversized merges before loading or changing reading documents", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await t.run(async (ctx) => {
      const source = await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", SOURCE_BOOK)).unique();
      if (!source) throw new Error("Missing seeded source book");
      await ctx.db.patch(source._id, { readingDataBytes: 8 * 1024 * 1024 + 1 });
    });

    await expect(t.mutation(functions.mergeBooks, {
      libraryId: LIBRARY, sourceBookId: SOURCE_BOOK, targetBookId: TARGET_BOOK,
      expectedSourceRevision: 1, expectedTargetRevision: 1,
    })).rejects.toThrow(/safe Convex transaction limit/);
    const books = await t.run((ctx) => ctx.db.query("books").collect());
    expect(books).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: SOURCE_BOOK, archived: false, revision: 1 }),
      expect.objectContaining({ id: TARGET_BOOK, archived: false, revision: 1 }),
    ]));
  });

  it("rejects oversized status-history merges without moving any event", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await t.run(async (ctx) => {
      for (let sequence = 1; sequence <= 201; sequence += 1) {
        await ctx.db.insert("readingStatusEvents", {
          libraryId: LIBRARY,
          id: `legacy-event-${sequence}`,
          bookId: SOURCE_BOOK,
          sequence,
          status: "reading",
          source: "reader",
          changedAt: sequence,
          bookRevision: 1,
        });
      }
    });

    await expect(t.mutation(functions.mergeBooks, {
      libraryId: LIBRARY, sourceBookId: SOURCE_BOOK, targetBookId: TARGET_BOOK,
      expectedSourceRevision: 1, expectedTargetRevision: 1,
    })).rejects.toThrow(/status-history limit/);
    const state = await t.run(async (ctx) => ({
      source: await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", SOURCE_BOOK)).unique(),
      target: await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", TARGET_BOOK)).unique(),
      library: await ctx.db.query("libraries").withIndex("by_external_id", (q) => q.eq("externalId", LIBRARY)).unique(),
      changes: await ctx.db.query("syncChanges").withIndex("by_library_and_sequence", (q) => q.eq("libraryId", LIBRARY)).collect(),
      sourceEvents: await ctx.db.query("readingStatusEvents")
        .withIndex("by_library_and_book_and_sequence", (q) => q.eq("libraryId", LIBRARY).eq("bookId", SOURCE_BOOK))
        .collect(),
      targetEvents: await ctx.db.query("readingStatusEvents")
        .withIndex("by_library_and_book_and_sequence", (q) => q.eq("libraryId", LIBRARY).eq("bookId", TARGET_BOOK))
        .collect(),
    }));
    expect(state.source).toMatchObject({ archived: false, revision: 1 });
    expect(state.target).toMatchObject({ archived: false, revision: 1 });
    expect(state.library?.nextChangeSequence).toBe(0);
    expect(state.changes).toEqual([]);
    expect(state.sourceEvents).toHaveLength(201);
    expect(state.targetEvents).toEqual([]);
  });

  it("accepts a status-history merge at the documented boundary", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await t.run(async (ctx) => {
      const library = await ctx.db.query("libraries")
        .withIndex("by_external_id", (q) => q.eq("externalId", LIBRARY))
        .unique();
      if (!library) throw new Error("Missing seeded library");
      await ctx.db.patch(library._id, { nextChangeSequence: 200 });
      for (let sequence = 1; sequence <= 200; sequence += 1) {
        await ctx.db.insert("readingStatusEvents", {
          libraryId: LIBRARY,
          id: `boundary-event-${sequence}`,
          bookId: SOURCE_BOOK,
          sequence,
          status: "reading",
          source: "reader",
          changedAt: sequence,
          bookRevision: 1,
        });
      }
    });

    await expect(t.mutation(functions.mergeBooks, {
      libraryId: LIBRARY, sourceBookId: SOURCE_BOOK, targetBookId: TARGET_BOOK,
      expectedSourceRevision: 1, expectedTargetRevision: 1,
    })).resolves.toMatchObject({ sourceRevision: 2, targetRevision: 2 });
    const state = await t.run(async (ctx) => ({
      sourceEvents: await ctx.db.query("readingStatusEvents")
        .withIndex("by_library_and_book_and_sequence", (q) => q.eq("libraryId", LIBRARY).eq("bookId", SOURCE_BOOK))
        .collect(),
      targetEvents: await ctx.db.query("readingStatusEvents")
        .withIndex("by_library_and_book_and_sequence", (q) => q.eq("libraryId", LIBRARY).eq("bookId", TARGET_BOOK))
        .collect(),
    }));
    expect(state.sourceEvents).toEqual([]);
    expect(state.targetEvents).toHaveLength(201);
    expect(state.targetEvents.at(-1)).toMatchObject({
      sequence: 201,
      status: "unread",
      source: "merge",
      bookRevision: 2,
    });
  });
});

async function seedLibrary(t: ReturnType<typeof convexTest>, libraryId = LIBRARY): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("libraries", { externalId: libraryId, nextChangeSequence: 0, createdAt: now, updatedAt: now });
    for (const [id, title] of [[SOURCE_BOOK, "Source"], [TARGET_BOOK, "Target"]] as const) {
      await ctx.db.insert("books", {
        libraryId, id, title, authors: [], status: "unread", archived: false,
        highlightCount: 0, noteCount: 0, readingDataBytes: 0,
        revision: 1, createdAt: now, updatedAt: now,
      });
    }
  });
}

function recordBytes(...values: string[]): number {
  return 512 + values.reduce((total, value) => total + new TextEncoder().encode(value).byteLength, 0);
}
