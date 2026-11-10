// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { MAX_NOTE_BYTES, MAX_NOTES_PER_HIGHLIGHT } from "@leaflogue/contracts";
import schema from "./schema";
import { convexModules } from "./test.setup";

const LIBRARY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOK = "11111111-1111-4111-8111-111111111111";
const HIGHLIGHT = "33333333-3333-4333-8333-333333333333";
const OTHER_HIGHLIGHT = "44444444-4444-4444-8444-444444444444";
const migrate = makeFunctionReference<"mutation", { libraryId: string; confirmDetach?: boolean }, {
  updated: number; detached: number; isDone: boolean; requiresReview: boolean;
  reviewNoteId?: string; reviewReason?: "oversized" | "too-many";
}>("migrations:boundLegacyAttachedNotes");
const repairDaily = makeFunctionReference<"mutation", { libraryId: string }, {
  updated: number; isDone: boolean; bookId?: string;
}>("migrations:repairDailyProjection");
const repairHighlights = makeFunctionReference<"mutation", { libraryId: string }, {
  updated: number; isDone: boolean; highlightId?: string;
}>("migrations:repairHighlightProjection");

describe("Convex attached-note migration", () => {
  it("resumes while detaching only notes beyond the active attachment bound", async () => {
    const t = convexTest(schema, convexModules);
    await t.run(async (ctx) => {
      for (let index = 0; index <= MAX_NOTES_PER_HIGHLIGHT; index += 1) {
        await ctx.db.insert("notes", {
          libraryId: LIBRARY, id: `legacy-${String(index).padStart(3, "0")}`,
          bookId: BOOK, highlightId: HIGHLIGHT, markdown: `body ${index}`,
          origin: "reader", revision: 1, createdAt: index, updatedAt: index,
        });
      }
    });
    let detached = 0;
    let calls = 0;
    let receipt: { updated: number; detached: number; isDone: boolean; requiresReview: boolean };
    do {
      receipt = await t.mutation(migrate, { libraryId: LIBRARY, confirmDetach: true });
      detached += receipt.detached;
      calls += 1;
    } while (!receipt.isDone);
    expect(calls).toBe(MAX_NOTES_PER_HIGHLIGHT + 1);
    expect(detached).toBe(1);
    const notes = await t.run((ctx) => ctx.db.query("notes").collect());
    expect(notes.filter(({ highlightId }) => highlightId === HIGHLIGHT)).toHaveLength(MAX_NOTES_PER_HIGHLIGHT);
    expect(notes.every(({ attachmentBoundsReady }) => attachmentBoundsReady === true)).toBe(true);
    expect(notes.map(({ markdown }) => markdown)).toHaveLength(MAX_NOTES_PER_HIGHLIGHT + 1);
  });

  it("detaches an oversized legacy note without changing its body", async () => {
    const t = convexTest(schema, convexModules);
    const markdown = "x".repeat(MAX_NOTE_BYTES + 1);
    await t.run((ctx) => ctx.db.insert("notes", {
      libraryId: LIBRARY, id: "oversized", bookId: BOOK, highlightId: HIGHLIGHT,
      markdown, origin: "reader", revision: 1, createdAt: 1, updatedAt: 1,
    }));
    await expect(t.mutation(migrate, { libraryId: LIBRARY })).resolves.toEqual({
      updated: 0, detached: 0, isDone: false, requiresReview: true,
      reviewNoteId: "oversized", reviewReason: "oversized",
    });
    await expect(t.mutation(migrate, { libraryId: LIBRARY, confirmDetach: true }))
      .resolves.toEqual({ updated: 1, detached: 1, isDone: true, requiresReview: false });
    const note = await t.run((ctx) => ctx.db.query("notes").first());
    expect(note).toMatchObject({ markdown, attachmentBoundsReady: true });
    expect(note?.highlightId).toBeUndefined();
  });
});

describe("Convex projection repair completion", () => {
  it("does not report daily repair complete while another book remains", async () => {
    const t = convexTest(schema, convexModules);
    await t.run(async (ctx) => {
      await ctx.db.insert("dailyProjectionBlocks", { libraryId: LIBRARY, bookId: BOOK, desiredActive: false, createdAt: 1 });
      await ctx.db.insert("dailyProjectionBlocks", { libraryId: LIBRARY, bookId: HIGHLIGHT, desiredActive: false, createdAt: 2 });
    });
    await expect(t.mutation(repairDaily, { libraryId: LIBRARY })).resolves.toMatchObject({ isDone: false });
    await expect(t.mutation(repairDaily, { libraryId: LIBRARY })).resolves.toMatchObject({ isDone: true });
  });

  it("does not report membership repair complete while another passage remains", async () => {
    const t = convexTest(schema, convexModules);
    await t.run(async (ctx) => {
      await ctx.db.insert("highlightProjectionBlocks", { libraryId: LIBRARY, highlightId: HIGHLIGHT,
        operation: "upsert", targetBookId: BOOK, createdAt: 1 });
      await ctx.db.insert("highlightProjectionBlocks", { libraryId: LIBRARY, highlightId: OTHER_HIGHLIGHT,
        operation: "upsert", targetBookId: BOOK, createdAt: 2 });
    });
    await expect(t.mutation(repairHighlights, { libraryId: LIBRARY })).resolves.toMatchObject({ isDone: false });
    await expect(t.mutation(repairHighlights, { libraryId: LIBRARY })).resolves.toMatchObject({ isDone: true });
  });
});
