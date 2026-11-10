// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { convexModules } from "./test.setup";

const LIBRARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOK_A = "11111111-1111-4111-8111-111111111111";
const BOOK_B = "22222222-2222-4222-8222-222222222222";
const HIGHLIGHT = "33333333-3333-4333-8333-333333333333";
const HIGHLIGHT_2 = "88888888-8888-4888-8888-888888888888";
const NOTE = "44444444-4444-4444-8444-444444444444";
const DEVICE_A = "55555555-5555-4555-8555-555555555555";
const DEVICE_B = "66666666-6666-4666-8666-666666666666";
const DEVICE_C = "77777777-7777-4777-8777-777777777777";

const apply = makeFunctionReference<"mutation", {
  libraryId: string;
  change: Record<string, unknown>;
}, "applied" | "superseded">("library:applySyncedChange");
const updateHighlight = makeFunctionReference<"mutation", {
  libraryId: string; id: string; bookId: string; text: string; expectedRevision: number;
}, Record<string, unknown>>("library:updateHighlight");
const deleteHighlight = makeFunctionReference<"mutation", {
  libraryId: string; id: string; bookId: string; expectedRevision: number;
}, Record<string, unknown>>("library:deleteHighlight");
const mergeBooks = makeFunctionReference<"mutation", {
  libraryId: string; sourceBookId: string; targetBookId: string;
  expectedSourceRevision: number; expectedTargetRevision: number;
}, Record<string, unknown>>("library:mergeBooks");
const ensureDailySelection = makeFunctionReference<"mutation", {
  libraryId: string; id: string; timezone: string; another?: boolean;
}, Record<string, unknown>>("daily:ensureDailySelection");
const repairDailyProjection = makeFunctionReference<"mutation", { libraryId: string }, {
  updated: number; isDone: boolean; bookId?: string;
}>("migrations:repairDailyProjection");
const repairHighlightProjection = makeFunctionReference<"mutation", { libraryId: string }, {
  updated: number; isDone: boolean; highlightId?: string;
}>("migrations:repairHighlightProjection");

describe("Convex synced replay", () => {
  it("orders writers deterministically and keeps tombstones above later upserts", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: bookUpsert(DEVICE_A, 2) })).resolves.toBe("applied");
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: bookUpsert(DEVICE_A, 1) })).resolves.toBe("superseded");
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "book", operation: "tombstone", deviceId: DEVICE_B, deviceRevision: 1, entityId: BOOK_A,
    } })).resolves.toBe("applied");
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: bookUpsert(DEVICE_A, 99) })).resolves.toBe("superseded");
    const state = await t.run(async (ctx) => ({
      book: await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", BOOK_A)).unique(),
      tombstone: await ctx.db.query("syncTombstones").withIndex("by_library_entity", (q) =>
        q.eq("libraryId", LIBRARY).eq("entityType", "book").eq("entityId", BOOK_A)).unique(),
    }));
    expect(state.book?.deletedAt).toEqual(expect.any(Number));
    expect(state.tombstone).toMatchObject({ entityId: BOOK_A, revision: 3 });
  });

  it("moves annotations, fixes both parents, and tombstones the actual parent", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 1, BOOK_A, "First") })).resolves.toBe("applied");
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 2, BOOK_B, "Moved") })).resolves.toBe("applied");
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: noteUpsert(DEVICE_A, 1, BOOK_B, "Attached") })).resolves.toBe("applied");
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "highlight", operation: "tombstone", deviceId: DEVICE_B, deviceRevision: 1,
      entityId: HIGHLIGHT, bookId: BOOK_A,
    } })).resolves.toBe("applied");
    const state = await t.run(async (ctx) => ({
      books: await ctx.db.query("books").collect(),
      highlight: await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", HIGHLIGHT)).unique(),
      tombstone: await ctx.db.query("syncTombstones").withIndex("by_library_entity", (q) =>
        q.eq("libraryId", LIBRARY).eq("entityType", "highlight").eq("entityId", HIGHLIGHT)).unique(),
    }));
    expect(state.books.find(({ id }) => id === BOOK_A)).toMatchObject({ highlightCount: 0 });
    expect(state.books.find(({ id }) => id === BOOK_B)).toMatchObject({ highlightCount: 0, noteCount: 1 });
    expect(state.highlight).toMatchObject({ bookId: BOOK_B, deletedAt: expect.any(Number) });
    expect(state.tombstone).toMatchObject({ bookId: BOOK_B });
  });

  it("preserves cross-device losing bodies but ignores same-device history", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 2, BOOK_A, "Alpha") });
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 1, BOOK_A, "Old alpha") })).resolves.toBe("superseded");
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_B, 1, BOOK_A, "Beta") })).resolves.toBe("superseded");
    const conflicts = await t.run((ctx) => ctx.db.query("syncConflicts").collect());
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ entityId: HIGHLIGHT, losingBody: "Beta", winningBody: "Alpha", status: "pending" });
  });

  it("does not copy a deleted body into a conflict after a synced tombstone wins", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 1, BOOK_A, "Deleted body") });
    await t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "highlight", operation: "tombstone", deviceId: DEVICE_B, deviceRevision: 1,
      entityId: HIGHLIGHT, bookId: BOOK_A,
    } });
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: highlightUpsert(DEVICE_C, 99, BOOK_A, "Losing resurrection") })).resolves.toBe("superseded");
    const conflict = await t.run((ctx) => ctx.db.query("syncConflicts").order("desc").first());
    expect(conflict).toMatchObject({ losingBody: "Losing resurrection", winningOperation: "tombstone" });
    expect(conflict?.winningBody).toBeUndefined();
  });

  it("fails closed until the legacy attachment migration is complete", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.run((ctx) => ctx.db.insert("notes", { libraryId: LIBRARY, id: NOTE, bookId: BOOK_A,
      markdown: "Legacy", origin: "reader", revision: 1, createdAt: 1, updatedAt: 1 }));
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 1, BOOK_A, "Blocked") }))
      .rejects.toThrow(/legacy attached-note migration/);
  });

  it("preserves an interactive edit and refuses to resurrect an interactive deletion", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 1, BOOK_A, "Remote one") });
    await t.mutation(updateHighlight, { libraryId: LIBRARY, id: HIGHLIGHT, bookId: BOOK_A,
      text: "Reader edit", expectedRevision: 1 });
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 2, BOOK_A, "Remote two") }))
      .resolves.toBe("applied");
    let state = await t.run(async (ctx) => ({
      highlight: await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", HIGHLIGHT)).unique(),
      conflicts: await ctx.db.query("syncConflicts").collect(),
    }));
    expect(state.highlight).toMatchObject({ text: "Remote two" });
    expect(state.conflicts).toEqual([expect.objectContaining({ losingBody: "Reader edit", winningBody: "Remote two" })]);
    await t.mutation(deleteHighlight, { libraryId: LIBRARY, id: HIGHLIGHT, bookId: BOOK_A, expectedRevision: 3 });
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 3, BOOK_A, "Must not return") }))
      .resolves.toBe("superseded");
    state = await t.run(async (ctx) => ({
      highlight: await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", HIGHLIGHT)).unique(),
      conflicts: await ctx.db.query("syncConflicts").collect(),
    }));
    expect(state.highlight?.deletedAt).toEqual(expect.any(Number));
    const beforeTombstone = state.conflicts.length;
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "highlight", operation: "tombstone", deviceId: DEVICE_B, deviceRevision: 4,
      entityId: HIGHLIGHT, bookId: BOOK_A,
    } })).resolves.toBe("applied");
    const afterTombstone = await t.run((ctx) => ctx.db.query("syncConflicts").collect());
    expect(afterTombstone).toHaveLength(beforeTombstone);
  });

  it("keeps daily candidates aligned with archived, restored, and deleted books", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 1, BOOK_A, "Candidate") });
    await t.mutation(apply, { libraryId: LIBRARY, change: { ...bookUpsert(DEVICE_A, 1), book: {
      ...(bookUpsert(DEVICE_A, 1).book as Record<string, unknown>), archived: true,
    } } });
    expect((await t.run((ctx) => ctx.db.query("dailyCandidates").withIndex("by_library_and_highlight", (q) =>
      q.eq("libraryId", LIBRARY).eq("highlightId", HIGHLIGHT)).unique()))?.bookActive).toBe(false);
    await t.mutation(apply, { libraryId: LIBRARY, change: bookUpsert(DEVICE_A, 2) });
    expect((await t.run((ctx) => ctx.db.query("dailyCandidates").withIndex("by_library_and_highlight", (q) =>
      q.eq("libraryId", LIBRARY).eq("highlightId", HIGHLIGHT)).unique()))?.bookActive).toBe(true);
    await t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "book", operation: "tombstone", deviceId: DEVICE_B, deviceRevision: 1, entityId: BOOK_A,
    } });
    expect((await t.run((ctx) => ctx.db.query("dailyCandidates").withIndex("by_library_and_highlight", (q) =>
      q.eq("libraryId", LIBRARY).eq("highlightId", HIGHLIGHT)).unique()))?.bookActive).toBe(false);
    await t.mutation(apply, { libraryId: LIBRARY, change: { ...bookUpsertFor(BOOK_B, DEVICE_A, 1), book: {
      ...(bookUpsertFor(BOOK_B, DEVICE_A, 1).book as Record<string, unknown>), archived: true,
    } } });
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsertFor(HIGHLIGHT_2, DEVICE_A, 1, BOOK_B, "Archived parent") });
    const archivedCandidate = await t.run((ctx) => ctx.db.query("dailyCandidates")
      .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", LIBRARY).eq("highlightId", HIGHLIGHT_2)).unique());
    expect(archivedCandidate?.bookActive).toBe(false);
  });

  it("commits a canonical book change while an oversized daily projection fails closed", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.run(async (ctx) => {
      for (let index = 0; index <= 400; index += 1) {
        await ctx.db.insert("dailyCandidates", { libraryId: LIBRARY, bookId: BOOK_A,
          highlightId: `legacy-candidate-${index}`, bookActive: true });
      }
    });
    const archived = { ...bookUpsert(DEVICE_A, 1), book: {
      ...(bookUpsert(DEVICE_A, 1).book as Record<string, unknown>), archived: true,
    } };
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: archived })).resolves.toBe("applied");
    const state = await t.run(async (ctx) => ({
      book: await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", BOOK_A)).unique(),
      block: await ctx.db.query("dailyProjectionBlocks").withIndex("by_library_and_book", (q) =>
        q.eq("libraryId", LIBRARY).eq("bookId", BOOK_A)).unique(),
    }));
    expect(state.book).toMatchObject({ archived: true });
    expect(state.block).toMatchObject({ desiredActive: false });
    await expect(t.mutation(ensureDailySelection, { libraryId: LIBRARY, id: DEVICE_C, timezone: "UTC" }))
      .rejects.toThrow(/Repair the daily-candidate projection/);
    let repair: { updated: number; isDone: boolean; bookId?: string };
    do {
      repair = await t.mutation(repairDailyProjection, { libraryId: LIBRARY });
    } while (!repair.isDone);
    expect(await t.run((ctx) => ctx.db.query("dailyProjectionBlocks").first())).toBeNull();
  });

  it("moves tag projections and removes thread and tag memberships on tombstone", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 1, BOOK_A, "Member") });
    await t.run(async (ctx) => {
      await ctx.db.insert("threads", { libraryId: LIBRARY, id: DEVICE_C, name: "Thread", normalizedName: "thread",
        passageCount: 1, revision: 1, createdAt: 1, updatedAt: 1 });
      await ctx.db.insert("tags", { libraryId: LIBRARY, id: DEVICE_B, name: "Tag", normalizedName: "tag",
        bookCount: 0, highlightCount: 1, revision: 1, createdAt: 1, updatedAt: 1 });
      await ctx.db.insert("threadHighlights", { libraryId: LIBRARY, threadId: DEVICE_C, highlightId: HIGHLIGHT, addedAt: 1 });
      await ctx.db.insert("highlightTags", { libraryId: LIBRARY, tagId: DEVICE_B, bookId: BOOK_A, highlightId: HIGHLIGHT, createdAt: 1 });
    });
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 2, BOOK_B, "Moved", [DEVICE_B]) });
    const link = await t.run((ctx) => ctx.db.query("highlightTags").first());
    expect(link).toMatchObject({ bookId: BOOK_B });
    await t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "highlight", operation: "tombstone", deviceId: DEVICE_B, deviceRevision: 1,
      entityId: HIGHLIGHT, bookId: BOOK_A,
    } });
    const state = await t.run(async (ctx) => ({
      threadLinks: await ctx.db.query("threadHighlights").collect(),
      tagLinks: await ctx.db.query("highlightTags").collect(),
      thread: await ctx.db.query("threads").first(), tag: await ctx.db.query("tags").first(),
    }));
    expect(state.threadLinks).toEqual([]);
    expect(state.tagLinks).toEqual([]);
    expect(state.thread).toMatchObject({ passageCount: 0, revision: 1 });
    expect(state.tag).toMatchObject({ highlightCount: 0, revision: 1 });
    const conflict = await t.run((ctx) => ctx.db.query("syncConflicts").first());
    expect(conflict).toMatchObject({ bookId: BOOK_B, losingBody: "Moved", winningOperation: "tombstone" });
  });

  it("commits a highlight move while an oversized membership projection is repaired in stages", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    const manyTags = Array.from({ length: 401 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 1, BOOK_A, "Many labels") });
    await t.run(async (ctx) => {
      for (const [index, tagId] of manyTags.entries()) {
        await ctx.db.insert("tags", { libraryId: LIBRARY, id: tagId, name: `Tag ${index}`, normalizedName: `tag ${index}`,
          bookCount: 0, highlightCount: 1, revision: 1, createdAt: 1, updatedAt: 1 });
        await ctx.db.insert("highlightTags", { libraryId: LIBRARY, tagId,
          bookId: BOOK_A, highlightId: HIGHLIGHT, createdAt: index });
      }
    });
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: highlightUpsert(DEVICE_A, 2, BOOK_B, "Moved safely", manyTags) })).resolves.toBe("applied");
    expect(await t.run((ctx) => ctx.db.query("highlightProjectionBlocks").first()))
      .toMatchObject({ highlightId: HIGHLIGHT, operation: "upsert", targetBookId: BOOK_B });
    await expect(t.mutation(mergeBooks, { libraryId: LIBRARY, sourceBookId: BOOK_B, targetBookId: BOOK_A,
      expectedSourceRevision: 2, expectedTargetRevision: 3 })).rejects.toThrow(/membership projection/);
    await expect(t.mutation(repairHighlightProjection, { libraryId: LIBRARY }))
      .resolves.toEqual({ updated: 1, isDone: false, highlightId: HIGHLIGHT });
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: highlightUpsert(DEVICE_A, 3, BOOK_A, "Moved back", manyTags) })).resolves.toBe("applied");
    let repair: { updated: number; isDone: boolean; highlightId?: string };
    do {
      repair = await t.mutation(repairHighlightProjection, { libraryId: LIBRARY });
    } while (!repair.isDone);
    const links = await t.run((ctx) => ctx.db.query("highlightTags").collect());
    expect(links).toHaveLength(401);
    expect(links.every(({ bookId }) => bookId === BOOK_A)).toBe(true);
  });

  it("accepts legacy mixed-case entity and parent UUIDs while rejecting malformed parents", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    const upperBook = BOOK_A.toUpperCase();
    const upperHighlight = HIGHLIGHT.toUpperCase();
    const upperNote = NOTE.toUpperCase();
    await t.mutation(apply, { libraryId: LIBRARY, change: bookUpsertFor(upperBook, DEVICE_A, 1) });
    await t.mutation(apply, { libraryId: LIBRARY, change: { ...highlightUpsert(DEVICE_A, 1, upperBook, "Legacy"),
      highlight: { ...(highlightUpsert(DEVICE_A, 1, upperBook, "Legacy").highlight as Record<string, unknown>), id: upperHighlight } } });
    await t.mutation(apply, { libraryId: LIBRARY, change: { ...noteUpsert(DEVICE_A, 1, upperBook, "Legacy note"),
      note: { ...(noteUpsert(DEVICE_A, 1, upperBook, "Legacy note").note as Record<string, unknown>), id: upperNote, highlightId: upperHighlight } } });
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "note", operation: "tombstone", deviceId: DEVICE_B, deviceRevision: 1,
      entityId: upperNote, bookId: upperBook,
    } })).resolves.toBe("applied");
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "highlight", operation: "tombstone", deviceId: DEVICE_B, deviceRevision: 1,
      entityId: upperHighlight, bookId: "not-a-uuid",
    } })).rejects.toThrow(/parent is invalid/);
  });

  it("enforces conflict capacity through a lightweight counter", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 2, BOOK_A, "Winner") });
    await t.run((ctx) => ctx.db.insert("syncConflictCounters", {
      libraryId: LIBRARY, entityType: "highlight", entityId: HIGHLIGHT, pendingCount: 19,
    }));
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: highlightUpsert(DEVICE_B, 1, BOOK_A, "€".repeat(100_000)) })).resolves.toBe("superseded");
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: highlightUpsert(DEVICE_C, 1, BOOK_A, "One too many") })).rejects.toThrow(/too many pending conflicts/);
    const state = await t.run(async (ctx) => ({
      counter: await ctx.db.query("syncConflictCounters").first(),
      highlight: await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", HIGHLIGHT)).unique(),
    }));
    expect(state.counter?.pendingCount).toBe(20);
    expect(state.highlight).toMatchObject({ text: "Winner" });
  });
});

const COLLECTION = "99999999-9999-4999-8999-999999999999";
const COLLECTION_2 = "abababab-abab-4bab-8bab-abababababab";
const TAG = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const createCollection = makeFunctionReference<"mutation", {
  libraryId: string; id: string; name: string; description?: string;
}, Record<string, unknown>>("organization:createCollection");
const updateCollection = makeFunctionReference<"mutation", {
  libraryId: string; id: string; name: string; expectedRevision: number;
}, Record<string, unknown>>("organization:updateCollection");

describe("Convex synced organization replay", () => {
  it("replays containers and complete owner membership sets without advancing containers", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: collectionUpsert(COLLECTION, DEVICE_A, 1, "Favourites") }))
      .resolves.toBe("applied");
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: tagUpsert(TAG, DEVICE_A, 1, "Wonder") }))
      .resolves.toBe("applied");
    await t.mutation(apply, { libraryId: LIBRARY, change: { ...bookUpsert(DEVICE_A, 1), collectionIds: [COLLECTION], tagIds: [TAG] } });
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 1, BOOK_A, "Tagged", [TAG]) });
    let state = await organizationState(t);
    expect(state.collections).toEqual([expect.objectContaining({ id: COLLECTION, name: "Favourites", bookCount: 1, revision: 1 })]);
    expect(state.tags).toEqual([expect.objectContaining({ id: TAG, bookCount: 1, highlightCount: 1, revision: 1 })]);
    expect(state.collectionBooks).toEqual([expect.objectContaining({ collectionId: COLLECTION, bookId: BOOK_A })]);
    expect(state.highlightTags).toEqual([expect.objectContaining({ tagId: TAG, bookId: BOOK_A, highlightId: HIGHLIGHT })]);

    await t.mutation(apply, { libraryId: LIBRARY, change: { ...bookUpsert(DEVICE_A, 2), collectionIds: [], tagIds: [TAG] } });
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 2, BOOK_B, "Moved", [TAG]) });
    state = await organizationState(t);
    expect(state.collections).toEqual([expect.objectContaining({ bookCount: 0, revision: 1 })]);
    expect(state.collectionBooks).toEqual([]);
    expect(state.highlightTags).toEqual([expect.objectContaining({ tagId: TAG, bookId: BOOK_B })]);
    await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 3, BOOK_B, "Untagged") });
    state = await organizationState(t);
    expect(state.tags).toEqual([expect.objectContaining({ bookCount: 1, highlightCount: 0, revision: 1 })]);
    expect(state.highlightTags).toEqual([]);
    const writers = await t.run((ctx) => ctx.db.query("syncedWriters").collect());
    for (const writer of writers.filter(({ entityType }) => entityType === "collection" || entityType === "tag")) {
      expect(writer.entityRevision).toBe(1);
    }
  });

  it("lets a container deletion win and drops stale links from later owner snapshots", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(apply, { libraryId: LIBRARY, change: collectionUpsert(COLLECTION, DEVICE_A, 1, "Shelf") });
    await t.mutation(apply, { libraryId: LIBRARY, change: { ...bookUpsert(DEVICE_A, 1), collectionIds: [COLLECTION] } });
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "collection", operation: "tombstone", deviceId: DEVICE_B, deviceRevision: 1, entityId: COLLECTION,
    } })).resolves.toBe("applied");
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: collectionUpsert(COLLECTION, DEVICE_A, 9, "Renamed") }))
      .resolves.toBe("superseded");
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: { ...bookUpsert(DEVICE_A, 2), collectionIds: [COLLECTION] } })).resolves.toBe("applied");
    const state = await organizationState(t);
    expect(state.collections).toEqual([expect.objectContaining({ name: "Shelf", deletedAt: expect.any(Number), revision: 2 })]);
    expect(state.collectionBooks).toEqual([]);
    expect(state.tombstones).toEqual([expect.objectContaining({ entityType: "collection", entityId: COLLECTION, revision: 2 })]);

    await expect(t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "tag", operation: "tombstone", deviceId: DEVICE_B, deviceRevision: 1, entityId: TAG,
    } })).resolves.toBe("applied");
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: { ...bookUpsert(DEVICE_A, 3), tagIds: [TAG] } })).resolves.toBe("applied");
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: { ...bookUpsert(DEVICE_A, 4), tagIds: [COLLECTION_2] } })).rejects.toThrow("container no longer exists");
  });

  it("keeps concurrent same-name containers distinct while interactive names stay unique", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(apply, { libraryId: LIBRARY, change: collectionUpsert(COLLECTION, DEVICE_A, 1, "To read") });
    await t.mutation(apply, { libraryId: LIBRARY, change: collectionUpsert(COLLECTION_2, DEVICE_B, 1, " to  READ ") });
    const collections = await t.run((ctx) => ctx.db.query("collections").collect());
    expect(collections.map(({ id, normalizedName }) => [id, normalizedName]).sort()).toEqual([
      [COLLECTION, "to read"], [COLLECTION_2, "to read"],
    ].sort());
    await expect(t.mutation(createCollection, { libraryId: LIBRARY, id: BOOK_B.replace(/^2/u, "3"), name: "To Read" }))
      .rejects.toThrow("already in use");
    await expect(t.mutation(updateCollection, { libraryId: LIBRARY, id: COLLECTION, name: "Queue", expectedRevision: 1 }))
      .resolves.toMatchObject({ name: "Queue", revision: 2 });
  });

  it("drains a large container tombstone in scheduled batches", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, convexModules);
      await seed(t);
      await t.mutation(apply, { libraryId: LIBRARY, change: tagUpsert(TAG, DEVICE_A, 1, "Everything") });
      await t.run(async (ctx) => {
        for (let index = 0; index < 450; index += 1) {
          await ctx.db.insert(index % 2 ? "bookTags" : "highlightTags", index % 2
            ? { libraryId: LIBRARY, tagId: TAG, bookId: `book-${index}`, createdAt: index }
            : { libraryId: LIBRARY, tagId: TAG, bookId: BOOK_A, highlightId: `passage-${index}`, createdAt: index } as never);
        }
      });
      await t.mutation(apply, { libraryId: LIBRARY, change: {
        entityType: "tag", operation: "tombstone", deviceId: DEVICE_A, deviceRevision: 2, entityId: TAG,
      } });
      const remaining = await t.run(async (ctx) =>
        (await ctx.db.query("bookTags").collect()).length + (await ctx.db.query("highlightTags").collect()).length);
      expect(remaining).toBe(250);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const state = await organizationState(t);
      expect(state.bookTags).toEqual([]);
      expect(state.highlightTags).toEqual([]);
      expect(state.tags).toEqual([expect.objectContaining({ deletedAt: expect.any(Number), bookCount: 0, highlightCount: 0 })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a deleted book's links and validates membership identities", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(apply, { libraryId: LIBRARY, change: collectionUpsert(COLLECTION, DEVICE_A, 1, "Shelf") });
    await t.mutation(apply, { libraryId: LIBRARY, change: tagUpsert(TAG, DEVICE_A, 1, "Label") });
    await t.mutation(apply, { libraryId: LIBRARY, change: { ...bookUpsert(DEVICE_A, 1), collectionIds: [COLLECTION], tagIds: [TAG] } });
    await t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "book", operation: "tombstone", deviceId: DEVICE_A, deviceRevision: 2, entityId: BOOK_A,
    } });
    const state = await organizationState(t);
    expect(state.collectionBooks).toEqual([]);
    expect(state.bookTags).toEqual([]);
    expect(state.collections).toEqual([expect.objectContaining({ bookCount: 0 })]);
    expect(state.tags).toEqual([expect.objectContaining({ bookCount: 0 })]);
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: { ...bookUpsertFor(BOOK_B, DEVICE_A, 1), collectionIds: ["not-a-uuid"] } })).rejects.toThrow("membership is invalid");
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: collectionUpsert(COLLECTION_2, DEVICE_A, 1, "   ") })).rejects.toThrow("name is required");
  });
});

describe("Convex synced thread replay", () => {
  const THREAD = "efefefef-efef-4fef-8fef-efefefefefef";
  const THREAD_2 = "dededede-dede-4ede-8ede-dededededede";
  const thread = (id: string, deviceId: string, deviceRevision: number, name: string) => ({
    entityType: "thread", operation: "upsert", deviceId, deviceRevision,
    thread: { id, name, description: "Halls", passageCount: 0, createdAt: 1, updatedAt: 2, revision: deviceRevision },
  });
  const passage = (deviceRevision: number, threadIds: string[]) =>
    ({ ...highlightUpsert(DEVICE_A, deviceRevision, BOOK_A, "The House"), threadIds });
  const threadState = (t: ReturnType<typeof convexTest>) => t.run(async (ctx) => ({
    threads: await ctx.db.query("threads").collect(),
    links: await ctx.db.query("threadHighlights").collect(),
    highlights: await ctx.db.query("highlights").collect(),
  }));

  it("replays threads and passage membership without revising threads, and keeps same-name threads distinct", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: thread(THREAD, DEVICE_A, 1, "Architecture") })).resolves.toBe("applied");
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: thread(THREAD_2, DEVICE_B, 1, " architecture ") })).resolves.toBe("applied");
    await t.mutation(apply, { libraryId: LIBRARY, change: passage(1, [THREAD, THREAD_2]) });
    let state = await threadState(t);
    expect(state.threads.map(({ normalizedName, passageCount, revision }) => ({ normalizedName, passageCount, revision })))
      .toEqual([{ normalizedName: "architecture", passageCount: 1, revision: 1 }, { normalizedName: "architecture", passageCount: 1, revision: 1 }]);
    expect(state.links.map(({ threadId }) => threadId).sort()).toEqual([THREAD, THREAD_2].sort());

    await t.mutation(apply, { libraryId: LIBRARY, change: passage(2, [THREAD]) });
    state = await threadState(t);
    expect(state.links.map(({ threadId }) => threadId)).toEqual([THREAD]);
    expect(state.threads.find(({ id }) => id === THREAD_2)).toMatchObject({ passageCount: 0, revision: 1 });
  });

  it("removes only links when a thread is deleted and drops stale links from later snapshots", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(apply, { libraryId: LIBRARY, change: thread(THREAD, DEVICE_A, 1, "Architecture") });
    await t.mutation(apply, { libraryId: LIBRARY, change: passage(1, [THREAD]) });
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: {
      entityType: "thread", operation: "tombstone", deviceId: DEVICE_B, deviceRevision: 1, entityId: THREAD,
    } })).resolves.toBe("applied");
    let state = await threadState(t);
    expect(state.links).toEqual([]);
    expect(state.highlights.map(({ id, deletedAt }) => ({ id, deleted: deletedAt !== undefined }))).toEqual([{ id: HIGHLIGHT, deleted: false }]);
    expect(state.threads).toEqual([expect.objectContaining({ deletedAt: expect.any(Number), passageCount: 0 })]);
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: passage(2, [THREAD]) })).resolves.toBe("applied");
    state = await threadState(t);
    expect(state.links).toEqual([]);
    await expect(t.mutation(apply, { libraryId: LIBRARY, change: passage(3, [THREAD_2]) })).rejects.toThrow("container no longer exists");
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: passage(3, Array.from({ length: 21 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`)) }))
      .rejects.toThrow("thread membership is invalid");
  });
});

describe("Convex synced reading-status history", () => {
  const event = (id: string, bookId: string, status: string, changedAt: number) =>
    ({ id, bookId, status, source: "reader", changedAt, bookRevision: 1 });
  const EVENT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
  const EVENT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";

  it("merges a losing change's history, re-announces the book, and never lets a stale snapshot move events", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(apply, { libraryId: LIBRARY, change: { ...bookUpsert(DEVICE_B, 5), statusEvents: [event(EVENT_A, BOOK_A, "reading", 10)] } });
    const before = await t.run(async (ctx) => (await ctx.db.query("libraries").first())!.nextChangeSequence);
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: { ...bookUpsert(DEVICE_A, 2), statusEvents: [event(EVENT_B, BOOK_A, "paused", 11)] } })).resolves.toBe("superseded");
    const state = await t.run(async (ctx) => ({
      events: await ctx.db.query("readingStatusEvents").collect(),
      book: await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", BOOK_A)).unique(),
      sequence: (await ctx.db.query("libraries").first())!.nextChangeSequence,
    }));
    expect(state.events.map(({ id, bookId }) => ({ id, bookId })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([{ id: EVENT_A, bookId: BOOK_A }, { id: EVENT_B, bookId: BOOK_A }]);
    expect(state.book?.status).toBe("finished");
    expect(state.sequence).toBe(before + 1);

    // A winning snapshot of the merge target moves the event; a stale one of the source cannot move it back.
    await t.mutation(apply, { libraryId: LIBRARY, change: { ...bookUpsertFor(BOOK_B, DEVICE_B, 6), statusEvents: [event(EVENT_A, BOOK_B, "reading", 10)] } });
    await t.mutation(apply, { libraryId: LIBRARY, change: { ...bookUpsert(DEVICE_A, 1), statusEvents: [event(EVENT_A, BOOK_A, "reading", 10)] } });
    const moved = await t.run((ctx) => ctx.db.query("readingStatusEvents").withIndex("by_library_and_id", (q) =>
      q.eq("libraryId", LIBRARY).eq("id", EVENT_A)).unique());
    expect(moved?.bookId).toBe(BOOK_B);
    await expect(t.mutation(apply, { libraryId: LIBRARY,
      change: { ...bookUpsert(DEVICE_A, 9), statusEvents: [event(EVENT_B, BOOK_B, "paused", 11)] } })).rejects.toThrow("reading history is invalid");
  });
});

describe("Convex synced daily picks", () => {
  const EARLY = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
  const LATE = "a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4";
  const pick = (id: string, deviceId: string, createdAt: number) => ({
    entityType: "daily-selection", operation: "upsert", deviceId, deviceRevision: 1,
    dailySelection: { id, localDay: "2026-09-30", timezone: "UTC", highlightId: HIGHLIGHT, candidateDigest: "0".repeat(64),
      recentHighlightIds: [HIGHLIGHT], selectedAt: createdAt, updatedAt: createdAt, revision: 1, createdAt },
  });

  for (const order of [[EARLY, LATE], [LATE, EARLY]]) {
    it(`keeps the earlier same-day pick whichever arrives first (${order[0] === EARLY ? "early" : "late"} first)`, async () => {
      const t = convexTest(schema, convexModules);
      await seed(t);
      await t.mutation(apply, { libraryId: LIBRARY, change: highlightUpsert(DEVICE_A, 1, BOOK_A, "The House") });
      for (const id of order) {
        await t.mutation(apply, { libraryId: LIBRARY, change: pick(id, id === EARLY ? DEVICE_A : DEVICE_B, id === EARLY ? 100 : 200) });
      }
      const state = await t.run(async (ctx) => ({
        picks: await ctx.db.query("dailySelections").collect(),
        tombstone: await ctx.db.query("syncTombstones").withIndex("by_library_entity", (q) =>
          q.eq("libraryId", LIBRARY).eq("entityType", "daily-selection").eq("entityId", LATE)).unique(),
        writer: await ctx.db.query("syncedWriters").withIndex("by_library_entity", (q) =>
          q.eq("libraryId", LIBRARY).eq("entityType", "daily-selection").eq("entityId", LATE)).unique(),
      }));
      expect(state.picks.map(({ id, highlightId }) => ({ id, highlightId }))).toEqual([{ id: EARLY, highlightId: HIGHLIGHT }]);
      expect(state.tombstone).not.toBeNull();
      expect(state.writer?.operation).toBe("tombstone");
      const sequences = await t.run(async (ctx) => (await ctx.db.query("syncChanges").collect()).map(({ sequence }) => sequence));
      expect(new Set(sequences).size).toBe(sequences.length);
      // A later edit of the retired pick stays retired.
      await expect(t.mutation(apply, { libraryId: LIBRARY, change: { ...pick(LATE, DEVICE_B, 200), deviceRevision: 5 } }))
        .resolves.toBe("superseded");
    });
  }
});

async function organizationState(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ({
    collections: await ctx.db.query("collections").collect(),
    tags: await ctx.db.query("tags").collect(),
    collectionBooks: await ctx.db.query("collectionBooks").collect(),
    bookTags: await ctx.db.query("bookTags").collect(),
    highlightTags: await ctx.db.query("highlightTags").collect(),
    tombstones: await ctx.db.query("syncTombstones").collect(),
  }));
}

function collectionUpsert(id: string, deviceId: string, deviceRevision: number, name: string): Record<string, unknown> {
  return { entityType: "collection", operation: "upsert", deviceId, deviceRevision, collection: {
    id, name, bookCount: 0, createdAt: 1, updatedAt: 2, revision: deviceRevision,
  } };
}

function tagUpsert(id: string, deviceId: string, deviceRevision: number, name: string): Record<string, unknown> {
  return { entityType: "tag", operation: "upsert", deviceId, deviceRevision, tag: {
    id, name, color: "#aa3355", bookCount: 0, highlightCount: 0, createdAt: 1, updatedAt: 2, revision: deviceRevision,
  } };
}

async function seed(t: ReturnType<typeof convexTest>): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("libraries", { externalId: LIBRARY, nextChangeSequence: 0, createdAt: now, updatedAt: now });
    for (const [id, title] of [[BOOK_A, "A"], [BOOK_B, "B"]] as const) {
      await ctx.db.insert("books", { libraryId: LIBRARY, id, title, authors: [], status: "unread", archived: false,
        highlightCount: 0, noteCount: 0, readingDataBytes: 0, revision: 1, createdAt: now, updatedAt: now });
    }
  });
}

function bookUpsert(deviceId: string, deviceRevision: number): Record<string, unknown> {
  return bookUpsertFor(BOOK_A, deviceId, deviceRevision);
}

function bookUpsertFor(id: string, deviceId: string, deviceRevision: number): Record<string, unknown> {
  return { entityType: "book", operation: "upsert", deviceId, deviceRevision, book: {
    id, title: "Synced", authors: ["Reader"], status: "finished", completedOn: "2026-09-24",
    archived: false, createdAt: 1, updatedAt: 2, revision: deviceRevision, highlightCount: 0,
  }, collectionIds: [], tagIds: [] };
}

function highlightUpsert(
  deviceId: string, deviceRevision: number, bookId: string, text: string, tagIds: readonly string[] = [],
): Record<string, unknown> {
  return highlightUpsertFor(HIGHLIGHT, deviceId, deviceRevision, bookId, text, tagIds);
}

function highlightUpsertFor(
  id: string, deviceId: string, deviceRevision: number, bookId: string, text: string, tagIds: readonly string[] = [],
): Record<string, unknown> {
  return { entityType: "highlight", operation: "upsert", deviceId, deviceRevision, highlight: {
    id, bookId, text, createdAt: 1, updatedAt: 2, revision: deviceRevision,
  }, tagIds, threadIds: [] };
}

function noteUpsert(deviceId: string, deviceRevision: number, bookId: string, markdown: string): Record<string, unknown> {
  return { entityType: "note", operation: "upsert", deviceId, deviceRevision, note: {
    id: NOTE, bookId, highlightId: HIGHLIGHT, markdown, origin: "reader", createdAt: 1, updatedAt: 2, revision: deviceRevision,
  } };
}
