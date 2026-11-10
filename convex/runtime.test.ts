// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type {
  ArchiveResult,
  BookResult,
  CreateBookArgs,
  CreateHighlightArgs,
  CreateNoteArgs,
  HighlightResult,
  MergeBooksArgs,
  MergeResult,
  NoteResult,
  ReadingStatusChangeResult,
  SetBookArchivedArgs,
  SetBookCompletionDateArgs,
  SetBookReadingStatusArgs,
  UpdateHighlightArgs,
  UpdateNoteArgs,
} from "./libraryContracts";
import schema from "./schema";
import { convexModules } from "./test.setup";

const LIBRARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_LIBRARY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SOURCE_BOOK = "11111111-1111-4111-8111-111111111111";
const TARGET_BOOK = "22222222-2222-4222-8222-222222222222";
const HIGHLIGHT = "33333333-3333-4333-8333-333333333333";
const NOTE = "44444444-4444-4444-8444-444444444444";
const ALICE = "https://identity.example|alice";
const BOB = "https://identity.example|bob";

const functions = {
  provisionLibrary: makeFunctionReference<"mutation", { libraryId: string; identityTokenIdentifier: string; role?: "owner" | "editor" | "viewer" }, { libraryId: string; role: "owner" | "editor" | "viewer"; libraryCreated: boolean }>("access:provisionLibrary"),
  revokeLibraryAccess: makeFunctionReference<"mutation", { libraryId: string; identityTokenIdentifier: string }, boolean>("access:revokeLibraryAccess"),
  rotateLibrarySyncGeneration: makeFunctionReference<"mutation", { libraryId: string }, number>("access:rotateLibrarySyncGeneration"),
  currentIdentity: makeFunctionReference<"query", Record<string, never>, { tokenIdentifier: string }>("access:currentIdentity"),
  createBook: makeFunctionReference<"mutation", CreateBookArgs, BookResult>("runtime:createBook"),
  createHighlight: makeFunctionReference<"mutation", CreateHighlightArgs, HighlightResult>("runtime:createHighlight"),
  updateHighlight: makeFunctionReference<"mutation", UpdateHighlightArgs, HighlightResult>("runtime:updateHighlight"),
  createNote: makeFunctionReference<"mutation", CreateNoteArgs, NoteResult>("runtime:createNote"),
  updateNote: makeFunctionReference<"mutation", UpdateNoteArgs, NoteResult>("runtime:updateNote"),
  setBookArchived: makeFunctionReference<"mutation", SetBookArchivedArgs, ArchiveResult>("runtime:setBookArchived"),
  setBookCompletionDate: makeFunctionReference<"mutation", SetBookCompletionDateArgs, BookResult>("runtime:setBookCompletionDate"),
  setBookReadingStatus: makeFunctionReference<"mutation", SetBookReadingStatusArgs, ReadingStatusChangeResult>("runtime:setBookReadingStatus"),
  mergeBooks: makeFunctionReference<"mutation", MergeBooksArgs, MergeResult>("runtime:mergeBooks"),
};

describe("authenticated Convex runtime boundary", () => {
  it("provisions membership idempotently and revokes it explicitly", async () => {
    const t = convexTest(schema, convexModules);
    await expect(t.mutation(functions.provisionLibrary, {
      libraryId: LIBRARY,
      identityTokenIdentifier: ALICE,
    })).resolves.toEqual({ libraryId: LIBRARY, role: "owner", libraryCreated: true });
    await expect(t.mutation(functions.provisionLibrary, {
      libraryId: LIBRARY,
      identityTokenIdentifier: ALICE,
      role: "editor",
    })).resolves.toEqual({ libraryId: LIBRARY, role: "editor", libraryCreated: false });

    const state = await t.run(async (ctx) => ({
      libraries: await ctx.db.query("libraries").collect(),
      members: await ctx.db.query("libraryMembers").collect(),
    }));
    expect(state.libraries).toHaveLength(1);
    expect(state.members).toEqual([expect.objectContaining({
      libraryId: LIBRARY,
      identityTokenIdentifier: ALICE,
      role: "editor",
    })]);
    await expect(t.mutation(functions.revokeLibraryAccess, {
      libraryId: LIBRARY,
      identityTokenIdentifier: ALICE,
    })).resolves.toBe(true);
    await expect(t.mutation(functions.revokeLibraryAccess, {
      libraryId: LIBRARY,
      identityTokenIdentifier: ALICE,
    })).resolves.toBe(false);
    await expect(t.mutation(functions.rotateLibrarySyncGeneration, { libraryId: LIBRARY })).resolves.toBe(2);
    await expect(t.mutation(functions.rotateLibrarySyncGeneration, { libraryId: LIBRARY })).resolves.toBe(3);
  });

  it("reveals only the authenticated caller's stable token identifier", async () => {
    const t = convexTest(schema, convexModules);
    await expect(t.query(functions.currentIdentity, {})).rejects.toThrow(/Authentication is required/);
    const asAlice = t.withIdentity({
      issuer: "https://identity.example",
      subject: "alice",
      tokenIdentifier: ALICE,
      email: "alice@example.test",
    });
    await expect(asAlice.query(functions.currentIdentity, {})).resolves.toEqual({ tokenIdentifier: ALICE });
  });

  it("denies unauthenticated, non-member, and read-only mutation attempts", async () => {
    const t = convexTest(schema, convexModules);
    await provisionAndSeed(t, ALICE);
    await t.mutation(functions.provisionLibrary, {
      libraryId: LIBRARY,
      identityTokenIdentifier: BOB,
      role: "viewer",
    });
    const input: CreateHighlightArgs = {
      libraryId: LIBRARY,
      id: HIGHLIGHT,
      bookId: SOURCE_BOOK,
      text: "Private passage",
    };
    await expect(t.mutation(functions.createHighlight, input)).rejects.toThrow(/Authentication is required/);
    await expect(t.withIdentity({ tokenIdentifier: BOB }).mutation(functions.createHighlight, input))
      .rejects.toThrow(/Library access is denied/);
    await expect(t.withIdentity({ tokenIdentifier: "https://identity.example|mallory" }).mutation(functions.createHighlight, input))
      .rejects.toThrow(/Library access is denied/);
    const highlights = await t.run((ctx) => ctx.db.query("highlights").collect());
    expect(highlights).toEqual([]);
  });

  it("authorizes every parity mutation only inside the caller's library", async () => {
    const t = convexTest(schema, convexModules);
    await provisionAndSeed(t, ALICE);
    await provisionAndSeed(t, BOB, OTHER_LIBRARY);
    const asAlice = t.withIdentity({ tokenIdentifier: ALICE });

    await expect(asAlice.mutation(functions.createBook, {
      libraryId: LIBRARY,
      id: "55555555-5555-4555-8555-555555555555",
      title: "Private book",
    })).resolves.toMatchObject({ title: "Private book", revision: 1 });

    await expect(asAlice.mutation(functions.createHighlight, {
      libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: " Passage ", sourceLocation: " 12 ",
    })).resolves.toMatchObject({ id: HIGHLIGHT, text: "Passage", sourceLocation: "12", revision: 1 });
    await expect(asAlice.mutation(functions.updateHighlight, {
      libraryId: LIBRARY, id: HIGHLIGHT, bookId: SOURCE_BOOK, text: "Revised", expectedRevision: 1,
    })).resolves.toMatchObject({ text: "Revised", revision: 2 });
    await expect(asAlice.mutation(functions.createNote, {
      libraryId: LIBRARY, id: NOTE, bookId: SOURCE_BOOK, highlightId: HIGHLIGHT, markdown: " Note ",
    })).resolves.toMatchObject({ id: NOTE, markdown: "Note", revision: 1 });
    await expect(asAlice.mutation(functions.updateNote, {
      libraryId: LIBRARY, id: NOTE, bookId: SOURCE_BOOK, markdown: "Revised note", expectedRevision: 1,
    })).resolves.toMatchObject({ markdown: "Revised note", revision: 2 });
    await expect(asAlice.mutation(functions.setBookArchived, {
      libraryId: LIBRARY, id: TARGET_BOOK, archived: true, expectedRevision: 1,
    })).resolves.toMatchObject({ archived: true, revision: 2 });
    await asAlice.mutation(functions.setBookArchived, {
      libraryId: LIBRARY, id: TARGET_BOOK, archived: false, expectedRevision: 2,
    });
    await expect(asAlice.mutation(functions.setBookReadingStatus, {
      libraryId: LIBRARY, id: SOURCE_BOOK, status: "finished", expectedRevision: 5,
    })).resolves.toMatchObject({ changed: true, book: { status: "finished", revision: 6 } });
    await expect(asAlice.mutation(functions.setBookCompletionDate, {
      libraryId: LIBRARY, id: SOURCE_BOOK, completedOn: "2024-02-29", expectedRevision: 6,
    })).resolves.toMatchObject({ status: "finished", completedOn: "2024-02-29", revision: 7 });
    await expect(asAlice.mutation(functions.mergeBooks, {
      libraryId: LIBRARY,
      sourceBookId: SOURCE_BOOK,
      targetBookId: TARGET_BOOK,
      expectedSourceRevision: 7,
      expectedTargetRevision: 3,
    })).resolves.toMatchObject({ highlightsMoved: 1, notesMoved: 1, sourceRevision: 8, targetRevision: 4 });

    await expect(asAlice.mutation(functions.createHighlight, {
      libraryId: OTHER_LIBRARY,
      id: HIGHLIGHT,
      bookId: SOURCE_BOOK,
      text: "Cross-library write",
    })).rejects.toThrow(/Library access is denied/);

    const otherHighlights = await t.run((ctx) => ctx.db.query("highlights")
      .withIndex("by_library_and_book", (query) => query.eq("libraryId", OTHER_LIBRARY).eq("bookId", SOURCE_BOOK))
      .collect());
    expect(otherHighlights).toEqual([]);
  });
});

async function provisionAndSeed(
  t: ReturnType<typeof convexTest>,
  identityTokenIdentifier: string,
  libraryId = LIBRARY,
): Promise<void> {
  await t.mutation(functions.provisionLibrary, { libraryId, identityTokenIdentifier });
  await t.run(async (ctx) => {
    const now = Date.now();
    for (const [id, title] of [[SOURCE_BOOK, "Source"], [TARGET_BOOK, "Target"]] as const) {
      await ctx.db.insert("books", {
        libraryId, id, title, authors: [], status: "unread", archived: false,
        highlightCount: 0, noteCount: 0, readingDataBytes: 0,
        revision: 1, createdAt: now, updatedAt: now,
      });
    }
  });
}
