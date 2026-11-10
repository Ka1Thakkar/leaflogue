// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { convexModules } from "./test.setup";

const LIBRARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOK = "11111111-1111-4111-8111-111111111111";
const SECOND_BOOK = "22222222-2222-4222-8222-222222222222";
const HIGHLIGHT = "33333333-3333-4333-8333-333333333333";
const SECOND_HIGHLIGHT = "00000000-0000-4000-8000-000000000000";
const THREAD = "55555555-5555-4555-8555-555555555555";
const SECOND_THREAD = "66666666-6666-4666-8666-666666666666";
const SELECTION = "77777777-7777-4777-8777-777777777777";

type ThreadInput = { libraryId: string; id: string; name: string; description?: string };
type MembershipInput = { libraryId: string; bookId: string; highlightId: string; threadIds: string[]; expectedHighlightRevision: number };
type DailyInput = { libraryId: string; id: string; timezone: string; another?: boolean };
const functions = {
  createThread: makeFunctionReference<"mutation", ThreadInput, Record<string, unknown>>("threads:createThread"),
  updateThread: makeFunctionReference<"mutation", ThreadInput & { expectedRevision: number }, Record<string, unknown>>("threads:updateThread"),
  deleteThread: makeFunctionReference<"mutation", { libraryId: string; id: string; expectedRevision: number }, null>("threads:deleteThread"),
  setMembership: makeFunctionReference<"mutation", MembershipInput, Record<string, unknown>>("threads:setHighlightThreadMembership"),
  ensureDaily: makeFunctionReference<"mutation", DailyInput, Record<string, unknown>>("daily:ensureDailySelection"),
  createThreadRuntime: makeFunctionReference<"mutation", ThreadInput, Record<string, unknown>>("threadRuntime:createThread"),
  ensureDailyRuntime: makeFunctionReference<"mutation", DailyInput, Record<string, unknown>>("dailyRuntime:ensureDailySelection"),
  provisionLibrary: makeFunctionReference<"mutation", { libraryId: string; identityTokenIdentifier: string }, Record<string, unknown>>("access:provisionLibrary"),
  backfillDailyCandidates: makeFunctionReference<"mutation", { libraryId: string }, { updated: number; isDone: boolean }>("migrations:backfillDailyCandidates"),
  setBookArchived: makeFunctionReference<"mutation", { libraryId: string; id: string; archived: boolean; expectedRevision: number }, Record<string, unknown>>("library:setBookArchived"),
};

describe("Convex thread parity", () => {
  it("protects public thread mutations with library membership", async () => {
    const t = convexTest(schema, convexModules);
    const identity = "https://identity.example|reader";
    await t.mutation(functions.provisionLibrary, { libraryId: LIBRARY, identityTokenIdentifier: identity });
    const input = { libraryId: LIBRARY, id: THREAD, name: "Private" };
    await expect(t.mutation(functions.createThreadRuntime, input)).rejects.toThrow(/Authentication is required/u);
    await expect(t.withIdentity({ tokenIdentifier: identity }).mutation(functions.createThreadRuntime, input))
      .resolves.toMatchObject({ name: "Private", revision: 1 });
  });

  it("normalizes names, supports idempotent creates, and revision-checks edits", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    const input = { libraryId: LIBRARY, id: THREAD, name: " Belonging   and exile ", description: " Across homes " };
    await expect(t.mutation(functions.createThread, input))
      .resolves.toMatchObject({ name: "Belonging and exile", description: "Across homes", passageCount: 0, revision: 1 });
    await expect(t.mutation(functions.createThread, input)).resolves.toMatchObject({ revision: 1 });
    await expect(t.mutation(functions.createThread, { libraryId: LIBRARY, id: SECOND_THREAD, name: "belonging and exile" }))
      .rejects.toThrow(/already in use/u);
    await expect(t.mutation(functions.updateThread, { ...input, name: "Home", expectedRevision: 1 }))
      .resolves.toMatchObject({ name: "Home", revision: 2 });
    await expect(t.mutation(functions.updateThread, { ...input, name: "Stale", expectedRevision: 1 }))
      .rejects.toThrow(/changed elsewhere/u);
  });

  it("changes passage memberships atomically and advances thread and highlight revisions once", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(functions.createThread, { libraryId: LIBRARY, id: THREAD, name: "Ideas" });
    await t.mutation(functions.createThread, { libraryId: LIBRARY, id: SECOND_THREAD, name: "Questions" });
    const input = { libraryId: LIBRARY, bookId: BOOK, highlightId: HIGHLIGHT, threadIds: [SECOND_THREAD, THREAD, THREAD], expectedHighlightRevision: 1 };
    await expect(t.mutation(functions.setMembership, input)).resolves.toEqual({
      changed: true, bookId: BOOK, highlightId: HIGHLIGHT, highlightRevision: 2, threadIds: [THREAD, SECOND_THREAD],
    });
    await expect(t.mutation(functions.setMembership, { ...input, expectedHighlightRevision: 2 }))
      .resolves.toMatchObject({ changed: false, highlightRevision: 2 });
    const state = await t.run(async (ctx) => ({
      threads: await ctx.db.query("threads").collect(),
      highlight: await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", HIGHLIGHT)).unique(),
      changes: await ctx.db.query("syncChanges").withIndex("by_library_and_sequence", (q) => q.eq("libraryId", LIBRARY)).collect(),
    }));
    expect(state.threads.map(({ passageCount, revision }) => ({ passageCount, revision }))).toEqual([
      { passageCount: 1, revision: 2 }, { passageCount: 1, revision: 2 },
    ]);
    expect(state.highlight?.revision).toBe(2);
    expect(state.changes.slice(-3).map(({ entityType }) => entityType)).toEqual(["thread", "thread", "highlight"]);
  });

  it("tombstones a thread and removes its bounded memberships", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    await t.mutation(functions.createThread, { libraryId: LIBRARY, id: THREAD, name: "Temporary" });
    await t.mutation(functions.setMembership, { libraryId: LIBRARY, bookId: BOOK, highlightId: HIGHLIGHT, threadIds: [THREAD], expectedHighlightRevision: 1 });
    await expect(t.mutation(functions.deleteThread, { libraryId: LIBRARY, id: THREAD, expectedRevision: 2 })).resolves.toBeNull();
    const state = await t.run(async (ctx) => ({
      thread: await ctx.db.query("threads").withIndex("by_library_and_id", (q) => q.eq("libraryId", LIBRARY).eq("id", THREAD)).unique(),
      links: await ctx.db.query("threadHighlights").collect(),
    }));
    expect(state.thread).toMatchObject({ passageCount: 0, revision: 3, deletedAt: expect.any(Number) });
    expect(state.links).toEqual([]);
  });
});

describe("Convex daily-selection parity", () => {
  it("protects public daily mutations with library membership", async () => {
    const t = convexTest(schema, convexModules);
    const identity = "https://identity.example|reader";
    await t.mutation(functions.provisionLibrary, { libraryId: LIBRARY, identityTokenIdentifier: identity });
    const input = { libraryId: LIBRARY, id: SELECTION, timezone: "UTC" };
    await expect(t.mutation(functions.ensureDailyRuntime, input)).rejects.toThrow(/Authentication is required/u);
    const authenticated = t.withIdentity({ tokenIdentifier: identity });
    const first = await authenticated.mutation(functions.ensureDailyRuntime, input);
    expect(first).toMatchObject({ id: SELECTION, timezone: "UTC", revision: 1 });
    await expect(authenticated.mutation(functions.ensureDailyRuntime, { ...input, another: true })).resolves.toEqual(first);
  });

  it("creates, reuses, and rotates canonical daily selections with sync changes", async () => {
    const now = Date.parse("2026-09-23T08:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const t = convexTest(schema, convexModules);
      await seed(t);
      const input = { libraryId: LIBRARY, id: SELECTION, timezone: "Etc/UTC" };
      const first = await t.mutation(functions.ensureDaily, input);
      expect(first).toMatchObject({ id: SELECTION, localDay: "2026-09-23", timezone: "UTC", revision: 1 });
      // The second highlight ID sorts first; this vector proves providers order by book, then passage.
      expect(first.candidateDigest).toBe("0d5c045b03eac506b946568ed7bdd3eb154c8e6aa0270f782197009094c1f18f");
      await expect(t.mutation(functions.ensureDaily, input)).resolves.toEqual(first);
      const rotated = await t.mutation(functions.ensureDaily, { ...input, another: true });
      expect(rotated).toMatchObject({ id: SELECTION, revision: 2 });
      expect(rotated.highlightId).not.toBe(first.highlightId);
      const changes = await t.run((ctx) => ctx.db.query("syncChanges").withIndex("by_library_and_sequence", (q) => q.eq("libraryId", LIBRARY)).collect());
      expect(changes.filter(({ entityType }) => entityType === "daily-selection").map(({ entityId, revision }) => ({ entityId, revision })))
        .toEqual([{ entityId: SELECTION, revision: 1 }, { entityId: SELECTION, revision: 2 }]);
    } finally {
      clock.mockRestore();
    }
  });

  it("backfills and maintains the lightweight candidate projection", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t, false);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 49; index += 1) {
        await ctx.db.insert("highlights", {
          libraryId: LIBRARY, id: `legacy-highlight-${String(index).padStart(2, "0")}`,
          bookId: BOOK, text: `Legacy passage ${index}`, archived: false,
          revision: 1, createdAt: now, updatedAt: now,
        });
      }
    });
    await expect(t.mutation(functions.ensureDaily, { libraryId: LIBRARY, id: SELECTION, timezone: "UTC" }))
      .rejects.toThrow(/daily-candidate migration/u);
    await expect(t.mutation(functions.backfillDailyCandidates, { libraryId: LIBRARY }))
      .resolves.toEqual({ updated: 50, isDone: false });
    await expect(t.mutation(functions.ensureDaily, { libraryId: LIBRARY, id: SELECTION, timezone: "UTC" }))
      .rejects.toThrow(/daily-candidate migration/u);
    await expect(t.mutation(functions.backfillDailyCandidates, { libraryId: LIBRARY }))
      .resolves.toEqual({ updated: 1, isDone: true });
    await expect(t.mutation(functions.ensureDaily, { libraryId: LIBRARY, id: SELECTION, timezone: "UTC" }))
      .resolves.toMatchObject({ id: SELECTION, revision: 1 });
    const candidates = await t.run((ctx) => ctx.db.query("dailyCandidates")
      .withIndex("by_library_active_book_and_highlight", (q) => q.eq("libraryId", LIBRARY).eq("bookActive", true))
      .collect());
    expect(candidates).toHaveLength(51);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ bookId: BOOK, highlightId: HIGHLIGHT }),
      expect.objectContaining({ bookId: SECOND_BOOK, highlightId: SECOND_HIGHLIGHT }),
    ]));
    await t.mutation(functions.setBookArchived, { libraryId: LIBRARY, id: BOOK, archived: true, expectedRevision: 1 });
    const archived = await t.run((ctx) => ctx.db.query("dailyCandidates")
      .withIndex("by_library_active_book_and_highlight", (q) => q.eq("libraryId", LIBRARY).eq("bookActive", true))
      .collect());
    expect(archived.map(({ highlightId }) => highlightId)).toEqual([SECOND_HIGHLIGHT]);
    await t.mutation(functions.setBookArchived, { libraryId: LIBRARY, id: BOOK, archived: false, expectedRevision: 2 });
    const restored = await t.run((ctx) => ctx.db.query("dailyCandidates")
      .withIndex("by_library_active_book_and_highlight", (q) => q.eq("libraryId", LIBRARY).eq("bookActive", true))
      .collect());
    expect(restored).toHaveLength(51);
  });
});

async function seed(t: ReturnType<typeof convexTest>, projectCandidates = true): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("libraries", { externalId: LIBRARY, nextChangeSequence: 0, createdAt: now, updatedAt: now });
    for (const [id, title] of [[BOOK, "First"], [SECOND_BOOK, "Second"]] as const) {
      await ctx.db.insert("books", { libraryId: LIBRARY, id, title, authors: [], status: "unread", archived: false, highlightCount: 1, noteCount: 0, readingDataBytes: 0, revision: 1, createdAt: now, updatedAt: now });
    }
    for (const [id, bookId, text] of [[HIGHLIGHT, BOOK, "Passage"], [SECOND_HIGHLIGHT, SECOND_BOOK, "Another passage"]] as const) {
      await ctx.db.insert("highlights", { libraryId: LIBRARY, id, bookId, text, ...(projectCandidates ? { dailyCandidateReady: true } : {}), archived: false, revision: 1, createdAt: now, updatedAt: now });
      if (projectCandidates) await ctx.db.insert("dailyCandidates", { libraryId: LIBRARY, highlightId: id, bookId, bookActive: true });
    }
  });
}
