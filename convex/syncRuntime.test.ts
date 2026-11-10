// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NOTE_BYTES } from "@leaflogue/contracts";
import schema from "./schema";
import { convexModules } from "./test.setup";

const LIBRARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE = "11111111-1111-4111-8111-111111111111";
const OTHER_DEVICE = "22222222-2222-4222-8222-222222222222";
const BOOK = "33333333-3333-4333-8333-333333333333";
const MISSING_BOOK = "44444444-4444-4444-8444-444444444444";
const MISSING_HIGHLIGHT = "55555555-5555-4555-8555-555555555555";
const MISSING_NOTE = "66666666-6666-4666-8666-666666666666";
const KEY = "k".repeat(44);
const ensureLibrary = makeFunctionReference<"mutation", { syncKey: string }, { libraryId: string }>("syncRuntime:ensureLibrary");
const apply = makeFunctionReference<"mutation", {
  libraryId: string;
  syncKey: string;
  deviceId: string;
  change: Record<string, unknown>;
}, "applied" | "superseded">("syncRuntime:pushSyncedChange");
const bootstrapCursor = makeFunctionReference<"query", {
  libraryId: string;
  syncKey: string;
}, { generation: number; afterSequence: number }>("syncRuntime:bootstrapCursor");
const validateCursor = makeFunctionReference<"query", {
  libraryId: string;
  syncKey: string;
  cursor: { generation: number; afterSequence: number };
}, boolean>("syncRuntime:validateCursor");
const pull = makeFunctionReference<"query", {
  libraryId: string;
  syncKey: string;
  cursor: { generation: number; afterSequence: number };
  limit: number;
}, {
  page: {
    changes: Array<{ sequence: number; entityType: string; entityId: string; revision: number; changedAt: number }>;
    nextCursor: { generation: number; afterSequence: number };
    isDone: boolean;
    resetRequired: boolean;
  };
  changes: Array<Record<string, unknown> | null>;
}>("syncRuntime:pull");
const migrate = makeFunctionReference<"mutation", {
  libraryId: string;
  syncKey: string;
  confirmDetachNoteId?: string;
}, {
  status: "complete" | "progress" | "review-required";
  migration?: string;
  updated: number;
  detached: number;
  reviewNoteId?: string;
  reviewReason?: "oversized" | "too-many";
}>("syncRuntime:runMigrationStep");

describe("sync-key-gated Convex sync", () => {
  beforeEach(() => { vi.stubEnv("LEAFLOGUE_SYNC_KEY", KEY); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("refuses every call until the deployment has a sync key, and refuses a wrong key", async () => {
    const t = convexTest(schema, convexModules);
    vi.stubEnv("LEAFLOGUE_SYNC_KEY", "");
    await expect(t.mutation(ensureLibrary, { syncKey: KEY })).rejects.toThrow("LEAFLOGUE_SYNC_KEY_UNCONFIGURED");
    vi.stubEnv("LEAFLOGUE_SYNC_KEY", "too-short");
    await expect(t.mutation(ensureLibrary, { syncKey: "too-short" })).rejects.toThrow("LEAFLOGUE_SYNC_KEY_UNCONFIGURED");
    vi.stubEnv("LEAFLOGUE_SYNC_KEY", KEY);
    await expect(t.mutation(ensureLibrary, { syncKey: "x".repeat(44) })).rejects.toThrow("LEAFLOGUE_SYNC_KEY_INVALID");
    const { libraryId } = await t.mutation(ensureLibrary, { syncKey: KEY });
    const args = { libraryId, syncKey: "x".repeat(44) };
    await expect(t.mutation(apply, { ...args, deviceId: DEVICE, change: bookUpsert(DEVICE, 1) })).rejects.toThrow("LEAFLOGUE_SYNC_KEY_INVALID");
    await expect(t.query(bootstrapCursor, args)).rejects.toThrow("LEAFLOGUE_SYNC_KEY_INVALID");
    await expect(t.query(validateCursor, { ...args, cursor: { generation: 1, afterSequence: 0 } })).rejects.toThrow("LEAFLOGUE_SYNC_KEY_INVALID");
    await expect(t.query(pull, { ...args, cursor: { generation: 1, afterSequence: 0 }, limit: 1 })).rejects.toThrow("LEAFLOGUE_SYNC_KEY_INVALID");
    expect(await t.run((ctx) => ctx.db.query("books").first())).toBeNull();
  });

  it("creates one library on first use and refuses to guess between several", async () => {
    const t = convexTest(schema, convexModules);
    const first = await t.mutation(ensureLibrary, { syncKey: KEY });
    await expect(t.mutation(ensureLibrary, { syncKey: KEY })).resolves.toEqual(first);
    await t.run((ctx) => ctx.db.insert("libraries", { externalId: LIBRARY, nextChangeSequence: 0, createdAt: 1, updatedAt: 1 }));
    await expect(t.mutation(ensureLibrary, { syncKey: KEY })).rejects.toThrow("LEAFLOGUE_LIBRARY_SELECTION_REQUIRED");
  });

  it("runs bounded migrations in order and detaches only the exact confirmed legacy note", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("books", { libraryId: LIBRARY, id: BOOK, title: "Piranesi", authors: [],
        status: "unread", archived: false, highlightCount: 1, noteCount: 1,
        readingDataBytes: 0, revision: 1, createdAt: 1, updatedAt: 1 });
      await ctx.db.insert("highlights", { libraryId: LIBRARY, id: MISSING_HIGHLIGHT, bookId: BOOK,
        text: "Passage", archived: false, revision: 1, createdAt: 1, updatedAt: 1 });
      await ctx.db.insert("tags", { libraryId: LIBRARY, id: MISSING_BOOK, name: "Legacy",
        normalizedName: "legacy", bookCount: 0, highlightCount: 1,
        revision: 1, createdAt: 1, updatedAt: 1 });
      await ctx.db.insert("highlightTags", { libraryId: LIBRARY, tagId: MISSING_BOOK,
        highlightId: MISSING_HIGHLIGHT, createdAt: 1 });
      await ctx.db.insert("notes", { libraryId: LIBRARY, id: MISSING_NOTE, bookId: BOOK,
        highlightId: MISSING_HIGHLIGHT, markdown: "x".repeat(MAX_NOTE_BYTES + 1), origin: "reader",
        revision: 1, createdAt: 1, updatedAt: 1 });
    });
    const session = { libraryId: LIBRARY, syncKey: KEY };
    await expect(t.mutation(apply, { ...session, deviceId: DEVICE, change: bookUpsert(DEVICE, 2) }))
      .rejects.toThrow("LEAFLOGUE_MIGRATION_REQUIRED");
    await expect(t.query(bootstrapCursor, session)).rejects.toThrow("LEAFLOGUE_MIGRATION_REQUIRED");
    await expect(t.query(validateCursor, { ...session, cursor: { generation: 1, afterSequence: 0 } }))
      .rejects.toThrow("LEAFLOGUE_MIGRATION_REQUIRED");
    await expect(t.query(pull, { ...session, cursor: { generation: 1, afterSequence: 0 }, limit: 1 }))
      .rejects.toThrow("LEAFLOGUE_MIGRATION_REQUIRED");
    await expect(t.mutation(migrate, { ...session, syncKey: "x".repeat(44) }))
      .rejects.toThrow("LEAFLOGUE_SYNC_KEY_INVALID");
    await expect(t.mutation(migrate, session)).resolves.toMatchObject({
      status: "progress", migration: "highlight-tag-books", updated: 1,
    });
    await expect(t.mutation(migrate, session)).resolves.toMatchObject({
      status: "progress", migration: "daily-candidates", updated: 1,
    });
    await expect(t.mutation(migrate, session)).resolves.toMatchObject({
      status: "review-required", migration: "attached-notes",
      reviewNoteId: MISSING_NOTE, reviewReason: "oversized",
    });
    await expect(t.mutation(migrate, { ...session, confirmDetachNoteId: "stale-note" })).resolves.toMatchObject({
      status: "review-required", reviewNoteId: MISSING_NOTE,
    });
    await expect(t.mutation(migrate, { ...session, confirmDetachNoteId: MISSING_NOTE })).resolves.toMatchObject({
      status: "progress", migration: "attached-notes", updated: 1, detached: 1,
    });
    await expect(t.mutation(migrate, session)).resolves.toEqual({ status: "complete", updated: 0, detached: 0 });
    await expect(t.query(bootstrapCursor, session)).resolves.toEqual({ generation: 1, afterSequence: 0 });
    const state = await t.run(async (ctx) => ({
      link: await ctx.db.query("highlightTags").first(),
      highlight: await ctx.db.query("highlights").first(),
      candidate: await ctx.db.query("dailyCandidates").first(),
      note: await ctx.db.query("notes").first(),
    }));
    expect(state.link?.bookId).toBe(BOOK);
    expect(state.highlight?.dailyCandidateReady).toBe(true);
    expect(state.candidate).toMatchObject({ highlightId: MISSING_HIGHLIGHT, bookId: BOOK });
    expect(state.note).toMatchObject({ attachmentBoundsReady: true, markdown: "x".repeat(MAX_NOTE_BYTES + 1) });
    expect(state.note?.highlightId).toBeUndefined();
  });

  it("binds each change to the calling device", async () => {
    const t = convexTest(schema, convexModules);
    const { libraryId } = await t.mutation(ensureLibrary, { syncKey: KEY });
    const args = { libraryId, syncKey: KEY };
    await expect(t.mutation(apply, { ...args, deviceId: DEVICE, change: bookUpsert(DEVICE, 1) })).resolves.toBe("applied");
    await expect(t.mutation(apply, { ...args, deviceId: OTHER_DEVICE, change: bookUpsert(DEVICE, 2) })).rejects.toThrow("does not belong");
    await expect(t.mutation(apply, { libraryId: MISSING_BOOK, syncKey: KEY, deviceId: DEVICE, change: bookUpsert(DEVICE, 2) }))
      .rejects.toThrow("Library no longer exists");
  });

  it("validates canonical membership sets before any write", async () => {
    const t = convexTest(schema, convexModules);
    const { libraryId } = await t.mutation(ensureLibrary, { syncKey: KEY });
    const sessionArgs = { libraryId, syncKey: KEY, deviceId: DEVICE };
    const withoutMemberships: Record<string, unknown> = { ...bookUpsert(DEVICE, 1) };
    delete withoutMemberships.collectionIds;
    await expect(t.mutation(apply, { ...sessionArgs, change: withoutMemberships })).rejects.toThrow("Validator error");
    await expect(t.mutation(apply, { ...sessionArgs, change: { ...bookUpsert(DEVICE, 1), tagIds: [MISSING_BOOK, MISSING_BOOK] } }))
      .rejects.toThrow("Book tag membership is invalid");
    await expect(t.mutation(apply, { ...sessionArgs, change: { ...bookUpsert(DEVICE, 1), collectionIds: [MISSING_BOOK] } }))
      .rejects.toThrow("container no longer exists");
    expect(await t.run((ctx) => ctx.db.query("books").first())).toBeNull();
  });

  it("bootstraps, validates, and pulls aligned claimed state", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    const sessionArgs = { libraryId: LIBRARY, syncKey: KEY };
    const origin = await t.query(bootstrapCursor, sessionArgs);
    expect(origin).toEqual({ generation: 1, afterSequence: 0 });
    await t.mutation(apply, { ...sessionArgs, deviceId: DEVICE, change: bookUpsert(DEVICE, 1) });
    await expect(t.query(validateCursor, { ...sessionArgs, cursor: origin })).resolves.toBe(true);
    await expect(t.query(validateCursor, {
      ...sessionArgs, cursor: { generation: 2, afterSequence: 0 },
    })).resolves.toBe(false);
    const result = await t.query(pull, { ...sessionArgs, cursor: origin, limit: 100 });
    expect(result.page).toMatchObject({
      changes: [{ sequence: 1, entityType: "book", entityId: BOOK }],
      nextCursor: { generation: 1, afterSequence: 1 },
      isDone: true,
      resetRequired: false,
    });
    expect(result.changes).toEqual([expect.objectContaining({
      entityType: "book",
      operation: "upsert",
      deviceId: DEVICE,
      deviceRevision: 1,
      collectionIds: [],
      tagIds: [],
      book: expect.objectContaining({ id: BOOK, title: "Piranesi", revision: 1 }),
    })]);
  });

  it("pulls book, passage, and note tombstones even when those entities never existed here", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    const sessionArgs = { libraryId: LIBRARY, syncKey: KEY };
    for (const change of [
      { entityType: "book", operation: "tombstone", deviceId: DEVICE, deviceRevision: 1, entityId: MISSING_BOOK },
      { entityType: "highlight", operation: "tombstone", deviceId: DEVICE, deviceRevision: 1,
        entityId: MISSING_HIGHLIGHT, bookId: MISSING_BOOK },
      { entityType: "note", operation: "tombstone", deviceId: DEVICE, deviceRevision: 1,
        entityId: MISSING_NOTE, bookId: MISSING_BOOK },
    ]) {
      await t.mutation(apply, { ...sessionArgs, deviceId: DEVICE, change });
    }
    const result = await t.query(pull, {
      ...sessionArgs, cursor: { generation: 1, afterSequence: 0 }, limit: 3,
    });
    expect(result.changes).toEqual([
      { entityType: "book", operation: "tombstone", deviceId: DEVICE,
        deviceRevision: 1, entityId: MISSING_BOOK },
      { entityType: "highlight", operation: "tombstone", deviceId: DEVICE,
        deviceRevision: 1, entityId: MISSING_HIGHLIGHT, bookId: MISSING_BOOK },
      { entityType: "note", operation: "tombstone", deviceId: DEVICE,
        deviceRevision: 1, entityId: MISSING_NOTE, bookId: MISSING_BOOK },
    ]);
  });

  it("pushes and pulls collections, tags, and membership-bearing owners in history order", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    const sessionArgs = { libraryId: LIBRARY, syncKey: KEY };
    const collection = { id: MISSING_HIGHLIGHT, name: "Shelf", description: "Kept", bookCount: 0, createdAt: 1, updatedAt: 1, revision: 1 };
    const tag = { id: MISSING_NOTE, name: "Label", bookCount: 0, highlightCount: 0, createdAt: 1, updatedAt: 1, revision: 1 };
    await t.mutation(apply, { ...sessionArgs, deviceId: DEVICE, change: { entityType: "collection", operation: "upsert", deviceId: DEVICE, deviceRevision: 1, collection } });
    await t.mutation(apply, { ...sessionArgs, deviceId: DEVICE, change: { entityType: "tag", operation: "upsert", deviceId: DEVICE, deviceRevision: 1, tag } });
    await t.mutation(apply, { ...sessionArgs, deviceId: DEVICE, change: { ...bookUpsert(DEVICE, 1), collectionIds: [MISSING_HIGHLIGHT], tagIds: [MISSING_NOTE] } });
    await t.mutation(apply, { ...sessionArgs, deviceId: DEVICE, change: { entityType: "tag", operation: "tombstone", deviceId: DEVICE, deviceRevision: 2, entityId: MISSING_NOTE } });
    const result = await t.query(pull, { ...sessionArgs, cursor: { generation: 1, afterSequence: 0 }, limit: 4 });
    expect(result.page.changes.map(({ entityType }) => entityType)).toEqual(["collection", "tag", "book", "tag"]);
    expect(result.changes).toEqual([
      { entityType: "collection", operation: "upsert", deviceId: DEVICE, deviceRevision: 1,
        collection: expect.objectContaining({ id: MISSING_HIGHLIGHT, name: "Shelf", description: "Kept", bookCount: 1, revision: 1 }) },
      { entityType: "tag", operation: "tombstone", deviceId: DEVICE, deviceRevision: 2, entityId: MISSING_NOTE },
      expect.objectContaining({ entityType: "book", collectionIds: [MISSING_HIGHLIGHT], tagIds: [] }),
      { entityType: "tag", operation: "tombstone", deviceId: DEVICE, deviceRevision: 2, entityId: MISSING_NOTE },
    ]);
  });

  it("caps state-bearing pages and refuses to attribute an interactively changed revision", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    const sessionArgs = { libraryId: LIBRARY, syncKey: KEY };
    for (let revision = 1; revision <= 6; revision += 1) {
      await t.mutation(apply, { ...sessionArgs, deviceId: DEVICE, change: bookUpsert(DEVICE, revision) });
    }
    const first = await t.query(pull, {
      ...sessionArgs, cursor: { generation: 1, afterSequence: 0 }, limit: 100,
    });
    expect(first.page.changes).toHaveLength(4);
    expect(first.changes).toHaveLength(4);
    expect(first.page).toMatchObject({ nextCursor: { generation: 1, afterSequence: 4 }, isDone: false });

    await t.run(async (ctx) => {
      const book = await ctx.db.query("books")
        .withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", BOOK)).unique();
      const library = await ctx.db.query("libraries")
        .withIndex("by_external_id", (q) => q.eq("externalId", LIBRARY)).unique();
      if (!book || !library) throw new Error("test setup failed");
      const now = Date.now();
      await ctx.db.patch(book._id, { title: "Interactive edit", revision: book.revision + 1, updatedAt: now });
      await ctx.db.insert("syncChanges", {
        libraryId: LIBRARY, sequence: 7, entityType: "book", entityId: BOOK,
        revision: book.revision + 1, changedAt: now,
      });
      await ctx.db.patch(library._id, { nextChangeSequence: 7, updatedAt: now });
    });
    const last = await t.query(pull, {
      ...sessionArgs, cursor: { generation: 1, afterSequence: 6 }, limit: 1,
    });
    expect(last.page.changes).toHaveLength(1);
    expect(last.changes).toEqual([null]);
  });

  it("requires reset for an invalid cursor", async () => {
    const t = convexTest(schema, convexModules);
    await seedLibrary(t);
    const sessionArgs = { libraryId: LIBRARY, syncKey: KEY };
    await expect(t.query(pull, {
      ...sessionArgs, cursor: { generation: 9, afterSequence: 0 }, limit: 10,
    })).resolves.toEqual({
      page: { changes: [], nextCursor: { generation: 1, afterSequence: 0 }, isDone: false, resetRequired: true },
      changes: [],
    });
  });
});

async function seedLibrary(t: ReturnType<typeof convexTest>): Promise<void> {
  await t.run((ctx) => ctx.db.insert("libraries", { externalId: LIBRARY, nextChangeSequence: 0, createdAt: 1, updatedAt: 1 }));
}

function bookUpsert(deviceId: string, deviceRevision: number) {
  return {
    entityType: "book",
    operation: "upsert",
    deviceId,
    deviceRevision,
    book: {
      id: BOOK,
      title: "Piranesi",
      authors: [],
      status: "unread",
      archived: false,
      createdAt: 1,
      updatedAt: deviceRevision,
      revision: deviceRevision,
      highlightCount: 0,
    },
    collectionIds: [] as string[],
    tagIds: [] as string[],
  };
}
