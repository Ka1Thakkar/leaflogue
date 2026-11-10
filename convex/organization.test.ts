// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { convexModules } from "./test.setup";

const LIBRARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOK = "11111111-1111-4111-8111-111111111111";
const SECOND_BOOK = "22222222-2222-4222-8222-222222222222";
const HIGHLIGHT = "33333333-3333-4333-8333-333333333333";
const COLLECTION = "44444444-4444-4444-8444-444444444444";
const TAG = "55555555-5555-4555-8555-555555555555";

const functions = {
  createCollection: makeFunctionReference<"mutation", { libraryId: string; id: string; name: string; description?: string }, Record<string, unknown>>("organization:createCollection"),
  updateCollection: makeFunctionReference<"mutation", { libraryId: string; id: string; name: string; description?: string; expectedRevision: number }, Record<string, unknown>>("organization:updateCollection"),
  deleteCollection: makeFunctionReference<"mutation", { libraryId: string; id: string; expectedRevision: number }, null>("organization:deleteCollection"),
  createTag: makeFunctionReference<"mutation", { libraryId: string; id: string; name: string; color?: string }, Record<string, unknown>>("organization:createTag"),
  deleteTag: makeFunctionReference<"mutation", { libraryId: string; id: string; expectedRevision: number }, null>("organization:deleteTag"),
  setBookCollectionMembership: makeFunctionReference<"mutation", { libraryId: string; bookId: string; collectionId: string; included: boolean }, Record<string, unknown>>("organization:setBookCollectionMembership"),
  setBookTagMembership: makeFunctionReference<"mutation", { libraryId: string; bookId: string; tagId: string; included: boolean }, Record<string, unknown>>("organization:setBookTagMembership"),
  setHighlightTagMembership: makeFunctionReference<"mutation", { libraryId: string; bookId: string; highlightId: string; tagId: string; included: boolean }, Record<string, unknown>>("organization:setHighlightTagMembership"),
  mergeBooks: makeFunctionReference<"mutation", { libraryId: string; sourceBookId: string; targetBookId: string; expectedSourceRevision: number; expectedTargetRevision: number }, Record<string, unknown>>("library:mergeBooks"),
  provisionLibrary: makeFunctionReference<"mutation", { libraryId: string; identityTokenIdentifier: string }, Record<string, unknown>>("access:provisionLibrary"),
  createCollectionRuntime: makeFunctionReference<"mutation", { libraryId: string; id: string; name: string }, Record<string, unknown>>("organizationRuntime:createCollection"),
  backfillHighlightTagBookIds: makeFunctionReference<"mutation", { libraryId: string }, { updated: number; isDone: boolean }>("migrations:backfillHighlightTagBookIds"),
};

describe("Convex organization parity", () => {
  it("protects the public organization runtime with library membership", async () => {
    const t = convexTest(schema, convexModules);
    const identity = "https://identity.example|reader";
    await t.mutation(functions.provisionLibrary, { libraryId: LIBRARY, identityTokenIdentifier: identity });
    const input = { libraryId: LIBRARY, id: COLLECTION, name: "Private" };
    await expect(t.mutation(functions.createCollectionRuntime, input)).rejects.toThrow(/Authentication is required/);
    await expect(t.withIdentity({ tokenIdentifier: identity }).mutation(functions.createCollectionRuntime, input))
      .resolves.toMatchObject({ name: "Private", revision: 1 });
  });

  it("normalizes names, rejects active duplicates, and revision-checks updates", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await expect(t.mutation(functions.createCollection, { libraryId: LIBRARY, id: COLLECTION, name: " ÉTÉ   Reads ", description: " Seasonal " }))
      .resolves.toMatchObject({ name: "ÉTÉ Reads", description: "Seasonal", bookCount: 0, revision: 1 });
    await expect(t.mutation(functions.createCollection, { libraryId: LIBRARY, id: "66666666-6666-4666-8666-666666666666", name: "E\u0301te\u0301 Reads" }))
      .rejects.toThrow(/already in use/);
    await expect(t.mutation(functions.updateCollection, { libraryId: LIBRARY, id: COLLECTION, name: "Summer", expectedRevision: 1 }))
      .resolves.toMatchObject({ name: "Summer", revision: 2 });
    await expect(t.mutation(functions.updateCollection, { libraryId: LIBRARY, id: COLLECTION, name: "Stale", expectedRevision: 1 }))
      .rejects.toThrow(/changed elsewhere/);
  });

  it("applies idempotent book and highlight membership with bounded counters", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(functions.createCollection, { libraryId: LIBRARY, id: COLLECTION, name: "Favourites" });
    await t.mutation(functions.createTag, { libraryId: LIBRARY, id: TAG, name: "Ideas", color: "ochre" });
    await expect(t.mutation(functions.setBookCollectionMembership, { libraryId: LIBRARY, bookId: BOOK, collectionId: COLLECTION, included: true }))
      .resolves.toMatchObject({ changed: true, bookRevision: 2, containerRevision: 2 });
    await expect(t.mutation(functions.setBookCollectionMembership, { libraryId: LIBRARY, bookId: BOOK, collectionId: COLLECTION, included: true }))
      .resolves.toMatchObject({ changed: false, bookRevision: 2, containerRevision: 2 });
    await t.mutation(functions.setBookTagMembership, { libraryId: LIBRARY, bookId: BOOK, tagId: TAG, included: true });
    await t.mutation(functions.setHighlightTagMembership, { libraryId: LIBRARY, bookId: BOOK, highlightId: HIGHLIGHT, tagId: TAG, included: true });
    const state = await t.run(async (ctx) => ({
      collection: await ctx.db.query("collections").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", COLLECTION)).unique(),
      tag: await ctx.db.query("tags").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", TAG)).unique(),
      highlight: await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", HIGHLIGHT)).unique(),
      changes: await ctx.db.query("syncChanges").withIndex("by_library_and_sequence", (q) => q.eq("libraryId", LIBRARY)).collect(),
    }));
    expect(state.collection).toMatchObject({ bookCount: 1, revision: 2 });
    expect(state.tag).toMatchObject({ bookCount: 1, highlightCount: 1, revision: 3 });
    expect(state.highlight).toMatchObject({ revision: 2 });
    expect(state.changes.map(({ entityType }) => entityType)).toEqual([
      "collection", "tag", "book", "collection", "book", "tag", "book", "highlight", "tag",
    ]);
  });

  it("removes memberships and touches every affected book when containers are deleted", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(functions.createCollection, { libraryId: LIBRARY, id: COLLECTION, name: "Delete me" });
    await t.mutation(functions.createTag, { libraryId: LIBRARY, id: TAG, name: "Delete tag" });
    for (const bookId of [BOOK, SECOND_BOOK]) {
      await t.mutation(functions.setBookCollectionMembership, { libraryId: LIBRARY, bookId, collectionId: COLLECTION, included: true });
      await t.mutation(functions.setBookTagMembership, { libraryId: LIBRARY, bookId, tagId: TAG, included: true });
    }
    await t.mutation(functions.setHighlightTagMembership, { libraryId: LIBRARY, bookId: BOOK, highlightId: HIGHLIGHT, tagId: TAG, included: true });
    await t.mutation(functions.deleteTag, { libraryId: LIBRARY, id: TAG, expectedRevision: 4 });
    await t.mutation(functions.deleteCollection, { libraryId: LIBRARY, id: COLLECTION, expectedRevision: 3 });
    const state = await t.run(async (ctx) => ({
      books: await ctx.db.query("books").collect(),
      collectionLinks: await ctx.db.query("collectionBooks").collect(),
      bookTags: await ctx.db.query("bookTags").collect(),
      highlightTags: await ctx.db.query("highlightTags").collect(),
    }));
    expect(state.collectionLinks).toEqual([]);
    expect(state.bookTags).toEqual([]);
    expect(state.highlightTags).toEqual([]);
    expect(state.books.map((book) => book.revision)).toEqual([6, 5]);
  });

  it("deletes exactly the bounded passage-tag batch and atomically rejects one beyond it", async () => {
    for (const count of [100, 101]) {
      const t = convexTest(schema, convexModules);
      await seed(t);
      await t.mutation(functions.createTag, { libraryId: LIBRARY, id: TAG, name: "Bounded" });
      await t.run(async (ctx) => {
        const now = Date.now();
        for (let index = 0; index < count; index += 1) {
          const highlightId = `bounded-highlight-${index}`;
          await ctx.db.insert("highlights", { libraryId: LIBRARY, id: highlightId, bookId: BOOK,
            text: `Passage ${index}`, archived: false, revision: 1, createdAt: now, updatedAt: now });
          await ctx.db.insert("highlightTags", { libraryId: LIBRARY, tagId: TAG, bookId: BOOK,
            highlightId, createdAt: now });
        }
      });

      const deletion = t.mutation(functions.deleteTag, { libraryId: LIBRARY, id: TAG, expectedRevision: 1 });
      if (count === 100) await expect(deletion).resolves.toBeNull();
      else await expect(deletion).rejects.toThrow(/safe Convex transaction limit/i);

      const state = await t.run(async (ctx) => ({
        tag: await ctx.db.query("tags").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", TAG)).unique(),
        links: await ctx.db.query("highlightTags").withIndex("by_library_and_tag", (q) => q.eq("libraryId", LIBRARY).eq("tagId", TAG)).collect(),
        highlights: await ctx.db.query("highlights").withIndex("by_library_and_book", (q) => q.eq("libraryId", LIBRARY).eq("bookId", BOOK)).collect(),
      }));
      expect(state.links).toHaveLength(count === 100 ? 0 : 101);
      expect(state.tag?.deletedAt !== undefined).toBe(count === 100);
      expect(state.highlights.filter(({ id }) => id.startsWith("bounded-highlight-")).every(({ revision }) => revision === (count === 100 ? 2 : 1))).toBe(true);
    }
  });

  it("preserves and deduplicates organization membership during book merges", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(functions.createCollection, { libraryId: LIBRARY, id: COLLECTION, name: "Both" });
    await t.mutation(functions.createTag, { libraryId: LIBRARY, id: TAG, name: "Source" });
    await t.mutation(functions.setBookCollectionMembership, { libraryId: LIBRARY, bookId: BOOK, collectionId: COLLECTION, included: true });
    await t.mutation(functions.setBookCollectionMembership, { libraryId: LIBRARY, bookId: SECOND_BOOK, collectionId: COLLECTION, included: true });
    await t.mutation(functions.setBookTagMembership, { libraryId: LIBRARY, bookId: BOOK, tagId: TAG, included: true });
    await t.mutation(functions.mergeBooks, {
      libraryId: LIBRARY, sourceBookId: BOOK, targetBookId: SECOND_BOOK,
      expectedSourceRevision: 3, expectedTargetRevision: 2,
    });
    const state = await t.run(async (ctx) => ({
      collection: await ctx.db.query("collections").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", COLLECTION)).unique(),
      tag: await ctx.db.query("tags").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", TAG)).unique(),
      collectionLinks: await ctx.db.query("collectionBooks").collect(),
      tagLinks: await ctx.db.query("bookTags").collect(),
      changes: await ctx.db.query("syncChanges").withIndex("by_library_and_sequence", (q) => q.eq("libraryId", LIBRARY)).collect(),
    }));
    expect(state.collection).toMatchObject({ bookCount: 1, revision: 4 });
    expect(state.tag).toMatchObject({ bookCount: 1, revision: 3 });
    expect(state.collectionLinks).toEqual([expect.objectContaining({ bookId: SECOND_BOOK })]);
    expect(state.tagLinks).toEqual([expect.objectContaining({ bookId: SECOND_BOOK })]);
    expect(state.changes.filter(({ entityType }) => entityType === "collection" || entityType === "tag").slice(-2).map(({ entityType, entityId, revision }) => ({ entityType, entityId, revision })))
      .toEqual([
        { entityType: "collection", entityId: COLLECTION, revision: 4 },
        { entityType: "tag", entityId: TAG, revision: 3 },
      ]);
  });

  it("rejects collection deletion before exceeding the conservative operation budget", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(functions.createCollection, { libraryId: LIBRARY, id: COLLECTION, name: "Large" });
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 201; index += 1) {
        const bookId = `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        await ctx.db.insert("books", { libraryId: LIBRARY, id: bookId, title: `Book ${index}`, authors: [], status: "unread", archived: false, highlightCount: 0, noteCount: 0, readingDataBytes: 0, revision: 1, createdAt: now, updatedAt: now });
        await ctx.db.insert("collectionBooks", { libraryId: LIBRARY, collectionId: COLLECTION, bookId, createdAt: now });
      }
      const collection = await ctx.db.query("collections").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", COLLECTION)).unique();
      if (collection) await ctx.db.patch(collection._id, { bookCount: 201 });
    });
    await expect(t.mutation(functions.deleteCollection, { libraryId: LIBRARY, id: COLLECTION, expectedRevision: 1 }))
      .rejects.toThrow(/safe Convex transaction limit/);
    const collection = await t.run((ctx) => ctx.db.query("collections").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", COLLECTION)).unique());
    expect(collection?.deletedAt).toBeUndefined();
  });

  it("rejects merges whose combined reading and organization work exceeds the operation budget", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.run(async (ctx) => {
      const source = await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", BOOK)).unique();
      if (!source) throw new Error("Missing source");
      await ctx.db.patch(source._id, { highlightCount: 300 });
      const now = Date.now();
      for (let index = 0; index < 31; index += 1) {
        const id = `80000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        await ctx.db.insert("collections", { libraryId: LIBRARY, id, name: `Collection ${index}`, normalizedName: `collection ${index}`, bookCount: 1, revision: 1, createdAt: now, updatedAt: now });
        await ctx.db.insert("collectionBooks", { libraryId: LIBRARY, collectionId: id, bookId: BOOK, createdAt: now });
      }
    });
    await expect(t.mutation(functions.mergeBooks, { libraryId: LIBRARY, sourceBookId: BOOK, targetBookId: SECOND_BOOK, expectedSourceRevision: 1, expectedTargetRevision: 1 }))
      .rejects.toThrow(/operation budget/);
  });

  it("fails closed on legacy highlight tags until the bounded backfill completes", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(functions.createTag, { libraryId: LIBRARY, id: TAG, name: "Legacy" });
    await t.run((ctx) => ctx.db.insert("highlightTags", {
      libraryId: LIBRARY, tagId: TAG, highlightId: HIGHLIGHT, createdAt: Date.now(),
    }));
    await expect(t.mutation(functions.deleteTag, { libraryId: LIBRARY, id: TAG, expectedRevision: 1 }))
      .rejects.toThrow(/migration/);
    await expect(t.mutation(functions.backfillHighlightTagBookIds, { libraryId: LIBRARY }))
      .resolves.toEqual({ updated: 1, isDone: true });
    await expect(t.mutation(functions.deleteTag, { libraryId: LIBRARY, id: TAG, expectedRevision: 1 }))
      .resolves.toBeNull();
  });
});

async function seed(t: ReturnType<typeof convexTest>): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("libraries", { externalId: LIBRARY, nextChangeSequence: 0, createdAt: now, updatedAt: now });
    for (const [id, title] of [[BOOK, "First"], [SECOND_BOOK, "Second"]] as const) {
      await ctx.db.insert("books", { libraryId: LIBRARY, id, title, authors: [], status: "unread", archived: false, highlightCount: id === BOOK ? 1 : 0, noteCount: 0, readingDataBytes: 0, revision: 1, createdAt: now, updatedAt: now });
    }
    await ctx.db.insert("highlights", { libraryId: LIBRARY, id: HIGHLIGHT, bookId: BOOK, text: "Passage", archived: false, revision: 1, createdAt: now, updatedAt: now });
  });
}
