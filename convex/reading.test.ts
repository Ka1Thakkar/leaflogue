// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import type { Infer } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import {
  bookPageValidator,
  changePageValidator,
  highlightPageValidator,
  notePageValidator,
} from "./readContracts";
import schema from "./schema";
import { convexModules } from "./test.setup";

const LIBRARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_LIBRARY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOOK_ONE = "11111111-1111-4111-8111-111111111111";
const BOOK_TWO = "22222222-2222-4222-8222-222222222222";
const BOOK_THREE = "33333333-3333-4333-8333-333333333333";
const ARCHIVED_BOOK = "44444444-4444-4444-8444-444444444444";
const ALICE = "https://identity.example|alice";
const BOB = "https://identity.example|bob";

interface PaginationInput {
  readonly numItems: number;
  readonly cursor: string | null;
  readonly endCursor?: string | null;
}

const functions = {
  listBooks: makeFunctionReference<"query", {
    libraryId: string;
    includeArchived?: boolean;
    paginationOpts: PaginationInput;
  }, Infer<typeof bookPageValidator>>("reading:listBooks"),
  listHighlights: makeFunctionReference<"query", {
    libraryId: string;
    bookId: string;
    paginationOpts: PaginationInput;
  }, Infer<typeof highlightPageValidator>>("reading:listHighlights"),
  listNotes: makeFunctionReference<"query", {
    libraryId: string;
    bookId: string;
    paginationOpts: PaginationInput;
  }, Infer<typeof notePageValidator>>("reading:listNotes"),
  listChanges: makeFunctionReference<"query", {
    libraryId: string;
    cursor: { generation: number; afterSequence: number };
    limit: number;
  }, Infer<typeof changePageValidator>>("reading:listChanges"),
};

describe("authenticated bounded Convex reads", () => {
  it("denies unauthenticated and cross-library reads while allowing viewer access", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    const args = { libraryId: LIBRARY, paginationOpts: { numItems: 10, cursor: null } };

    await expect(t.query(functions.listBooks, args)).rejects.toThrow(/Authentication is required/);
    await expect(t.withIdentity({ tokenIdentifier: BOB }).query(functions.listBooks, args))
      .rejects.toThrow(/Library access is denied/);
    await expect(t.withIdentity({ tokenIdentifier: ALICE }).query(functions.listBooks, {
      ...args,
      libraryId: OTHER_LIBRARY,
    })).rejects.toThrow(/Library access is denied/);
    await expect(t.withIdentity({ tokenIdentifier: ALICE }).query(functions.listBooks, args))
      .resolves.toMatchObject({ page: expect.arrayContaining([expect.objectContaining({ id: BOOK_ONE })]) });
  });

  it("paginates active and archived books without exposing storage fields", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    const asAlice = t.withIdentity({ tokenIdentifier: ALICE });
    const first = await asAlice.query(functions.listBooks, {
      libraryId: LIBRARY,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page.map(({ id }) => id)).toEqual([BOOK_ONE, BOOK_TWO]);
    expect(first.isDone).toBe(false);
    expect(first.page[0]).not.toHaveProperty("libraryId");
    expect(first.page[0]).not.toHaveProperty("readingDataBytes");
    expect(first.page[0]).not.toHaveProperty("_id");

    const second = await asAlice.query(functions.listBooks, {
      libraryId: LIBRARY,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map(({ id }) => id)).toEqual([BOOK_THREE]);
    expect(second.isDone).toBe(true);

    const withArchived = await asAlice.query(functions.listBooks, {
      libraryId: LIBRARY,
      includeArchived: true,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(withArchived.page.map(({ id }) => id)).toEqual([BOOK_ONE, BOOK_TWO, BOOK_THREE, ARCHIVED_BOOK]);
  });

  it("paginates highlights and notes independently, including tombstone metadata", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    const asAlice = t.withIdentity({ tokenIdentifier: ALICE });
    const highlights = await asAlice.query(functions.listHighlights, {
      libraryId: LIBRARY,
      bookId: BOOK_ONE,
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(highlights.page).toEqual([expect.objectContaining({ id: "highlight-1", archived: false })]);
    expect(highlights.isDone).toBe(false);
    const remainingHighlights = await asAlice.query(functions.listHighlights, {
      libraryId: LIBRARY,
      bookId: BOOK_ONE,
      paginationOpts: { numItems: 10, cursor: highlights.continueCursor },
    });
    expect(remainingHighlights.page).toEqual([expect.objectContaining({ id: "highlight-2", deletedAt: 500 })]);

    const notes = await asAlice.query(functions.listNotes, {
      libraryId: LIBRARY,
      bookId: BOOK_ONE,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(notes.page).toEqual([
      expect.objectContaining({ id: "note-1", highlightId: "highlight-1" }),
      expect.objectContaining({ id: "note-2", deletedAt: 600 }),
    ]);
    expect(notes.page[0]).not.toHaveProperty("libraryId");
    expect(notes.page[0]).not.toHaveProperty("_id");
  });

  it("uses a monotonic sequence cursor for bounded ordered change pages", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    const asAlice = t.withIdentity({ tokenIdentifier: ALICE });
    const first = await asAlice.query(functions.listChanges, {
      libraryId: LIBRARY,
      cursor: { generation: 1, afterSequence: 0 },
      limit: 2,
    });
    expect(first).toMatchObject({ nextCursor: { generation: 1, afterSequence: 2 }, isDone: false, resetRequired: false });
    expect(first.page.map(({ sequence }) => sequence)).toEqual([1, 2]);
    const second = await asAlice.query(functions.listChanges, {
      libraryId: LIBRARY,
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second).toMatchObject({ nextCursor: { generation: 1, afterSequence: 3 }, isDone: true, resetRequired: false });
    expect(second.page.map(({ sequence }) => sequence)).toEqual([3]);

    await expect(asAlice.query(functions.listChanges, {
      libraryId: LIBRARY,
      cursor: { generation: 1, afterSequence: -1 },
      limit: 2,
    })).rejects.toThrow(/Change sequence is invalid/);
    await expect(asAlice.query(functions.listChanges, {
      libraryId: LIBRARY,
      cursor: { generation: 1, afterSequence: 0 },
      limit: 101,
    })).rejects.toThrow(/Page size must be between 1 and 100/);
    await expect(asAlice.query(functions.listBooks, {
      libraryId: LIBRARY,
      paginationOpts: { numItems: 101, cursor: null },
    })).rejects.toThrow(/Page size must be between 1 and 100/);
    await expect(asAlice.query(functions.listBooks, {
      libraryId: LIBRARY,
      paginationOpts: { numItems: 10, cursor: "x".repeat(4_097) },
    })).rejects.toThrow(/Pagination cursor is too long/);
  });

  it("requires a full resync after a reset generation or an ahead cursor", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    const asAlice = t.withIdentity({ tokenIdentifier: ALICE });
    await expect(asAlice.query(functions.listChanges, {
      libraryId: LIBRARY,
      cursor: { generation: 9, afterSequence: 0 },
      limit: 10,
    })).resolves.toEqual({
      page: [],
      nextCursor: { generation: 1, afterSequence: 0 },
      isDone: false,
      resetRequired: true,
    });
    await expect(asAlice.query(functions.listChanges, {
      libraryId: LIBRARY,
      cursor: { generation: 1, afterSequence: 500 },
      limit: 10,
    })).resolves.toEqual({
      page: [],
      nextCursor: { generation: 1, afterSequence: 0 },
      isDone: false,
      resetRequired: true,
    });
  });

  it("rejects reactive end-cursor ranges so item pages remain capped", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    const asAlice = t.withIdentity({ tokenIdentifier: ALICE });
    const first = await asAlice.query(functions.listBooks, {
      libraryId: LIBRARY,
      paginationOpts: { numItems: 1, cursor: null },
    });
    await expect(asAlice.query(functions.listBooks, {
      libraryId: LIBRARY,
      paginationOpts: { numItems: 1, cursor: null, endCursor: first.continueCursor },
    })).rejects.toThrow(/Pagination end cursors are not supported/);
  });

  it("requires a page split before reading more than one MiB", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 12; index += 1) {
        await ctx.db.insert("highlights", {
          libraryId: LIBRARY,
          id: `large-highlight-${String(index).padStart(2, "0")}`,
          bookId: BOOK_TWO,
          text: "x".repeat(100_000),
          archived: false,
          revision: 1,
          createdAt: index,
          updatedAt: index,
        });
      }
    });

    const result = await t.withIdentity({ tokenIdentifier: ALICE }).query(functions.listHighlights, {
      libraryId: LIBRARY,
      bookId: BOOK_TWO,
      paginationOpts: { numItems: 100, cursor: null },
    });
    expect(result.page.length).toBeLessThan(12);
    expect(result.pageStatus).toBe("SplitRequired");
    expect(result.splitCursor).toEqual(expect.any(String));
  });

  it("never reads more than one hundred records for a page", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("highlights", {
          libraryId: LIBRARY,
          id: `bounded-highlight-${String(index).padStart(3, "0")}`,
          bookId: BOOK_THREE,
          text: "Bounded passage",
          archived: false,
          revision: 1,
          createdAt: index,
          updatedAt: index,
        });
      }
    });
    const page = await t.withIdentity({ tokenIdentifier: ALICE }).query(functions.listHighlights, {
      libraryId: LIBRARY,
      bookId: BOOK_THREE,
      paginationOpts: { numItems: 100, cursor: null },
    });
    expect(page.page).toHaveLength(100);
    expect(page.isDone).toBe(false);
  });
});

async function seed(t: ReturnType<typeof convexTest>): Promise<void> {
  await t.run(async (ctx) => {
    const now = 1_000;
    await ctx.db.insert("libraries", { externalId: LIBRARY, nextChangeSequence: 3, syncGeneration: 1, createdAt: now, updatedAt: now });
    await ctx.db.insert("libraries", { externalId: OTHER_LIBRARY, nextChangeSequence: 1, syncGeneration: 1, createdAt: now, updatedAt: now });
    await ctx.db.insert("libraryMembers", {
      libraryId: LIBRARY,
      identityTokenIdentifier: ALICE,
      role: "viewer",
      createdAt: now,
      updatedAt: now,
    });
    for (const [id, title, archived] of [
      [BOOK_THREE, "Third", false],
      [BOOK_ONE, "First", false],
      [ARCHIVED_BOOK, "Archived", true],
      [BOOK_TWO, "Second", false],
    ] as const) {
      await ctx.db.insert("books", {
        libraryId: LIBRARY,
        id,
        title,
        authors: [],
        status: "unread",
        archived,
        highlightCount: id === BOOK_ONE ? 2 : 0,
        noteCount: id === BOOK_ONE ? 2 : 0,
        readingDataBytes: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.insert("books", {
      libraryId: OTHER_LIBRARY,
      id: BOOK_ONE,
      title: "Other library",
      authors: [],
      status: "unread",
      archived: false,
      highlightCount: 0,
      noteCount: 0,
      readingDataBytes: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("highlights", {
      libraryId: LIBRARY,
      id: "highlight-1",
      bookId: BOOK_ONE,
      text: "First passage",
      archived: false,
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
    });
    await ctx.db.insert("highlights", {
      libraryId: LIBRARY,
      id: "highlight-2",
      bookId: BOOK_ONE,
      text: "Removed passage",
      archived: true,
      deletedAt: 500,
      revision: 2,
      createdAt: 200,
      updatedAt: 500,
    });
    await ctx.db.insert("notes", {
      libraryId: LIBRARY,
      id: "note-1",
      bookId: BOOK_ONE,
      highlightId: "highlight-1",
      markdown: "Attached",
      origin: "reader",
      revision: 1,
      createdAt: 300,
      updatedAt: 300,
    });
    await ctx.db.insert("notes", {
      libraryId: LIBRARY,
      id: "note-2",
      bookId: BOOK_ONE,
      markdown: "Removed standalone note",
      origin: "reader",
      deletedAt: 600,
      revision: 2,
      createdAt: 400,
      updatedAt: 600,
    });
    for (const [sequence, entityType, entityId] of [
      [1, "book", BOOK_ONE],
      [2, "highlight", "highlight-1"],
      [3, "note", "note-1"],
    ] as const) {
      await ctx.db.insert("syncChanges", {
        libraryId: LIBRARY,
        sequence,
        entityType,
        entityId,
        revision: 1,
        changedAt: now + sequence,
      });
    }
    await ctx.db.insert("syncChanges", {
      libraryId: OTHER_LIBRARY,
      sequence: 1,
      entityType: "book",
      entityId: BOOK_ONE,
      revision: 1,
      changedAt: now,
    });
  });
}
