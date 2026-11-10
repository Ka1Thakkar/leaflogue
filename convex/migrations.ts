import type { DataModelFromSchemaDefinition, GenericMutationCtx, MutationBuilder } from "convex/server";
import { internalMutationGeneric } from "convex/server";
import { v } from "convex/values";
import { MAX_NOTE_BYTES, MAX_NOTES_PER_HIGHLIGHT } from "@leaflogue/contracts";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationContext = GenericMutationCtx<DataModel>;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
const BACKFILL_BATCH = 50;

/** Drain fail-closed daily projection work left by a large synced book. */
export const repairDailyProjection = internalMutation({
  args: { libraryId: v.string() },
  returns: v.object({ updated: v.number(), isDone: v.boolean(), bookId: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const block = await ctx.db.query("dailyProjectionBlocks")
      .withIndex("by_library", (q) => q.eq("libraryId", args.libraryId)).first();
    if (!block) return { updated: 0, isDone: true };
    const candidates = await ctx.db.query("dailyCandidates")
      .withIndex("by_library_active_book_and_highlight", (q) => q.eq("libraryId", args.libraryId)
        .eq("bookActive", !block.desiredActive).eq("bookId", block.bookId))
      .take(BACKFILL_BATCH + 1);
    const batch = candidates.slice(0, BACKFILL_BATCH);
    for (const candidate of batch) await ctx.db.patch(candidate._id, { bookActive: block.desiredActive });
    const complete = candidates.length <= BACKFILL_BATCH;
    if (complete) {
      await ctx.db.delete(block._id);
      const next = await ctx.db.query("dailyProjectionBlocks")
        .withIndex("by_library", (q) => q.eq("libraryId", args.libraryId)).first();
      return { updated: batch.length, isDone: next === null, bookId: block.bookId };
    }
    return { updated: batch.length, isDone: false, bookId: block.bookId };
  },
});

/** Drain one membership projection row per call after an oversized replay. */
export const repairHighlightProjection = internalMutation({
  args: { libraryId: v.string() },
  returns: v.object({ updated: v.number(), isDone: v.boolean(), highlightId: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const block = await ctx.db.query("highlightProjectionBlocks")
      .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId)).first();
    if (!block) return { updated: 0, isDone: true };
    if (block.operation === "upsert") {
      const source = await ctx.db.query("highlightProjectionSources")
        .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", block.highlightId)).first();
      if (source) {
        if (source.sourceBookId === block.targetBookId) {
          await ctx.db.delete(source._id);
          return { updated: 0, isDone: false, highlightId: block.highlightId };
        }
        const link = await ctx.db.query("highlightTags").withIndex("by_library_highlight_and_book", (q) =>
          q.eq("libraryId", args.libraryId).eq("highlightId", block.highlightId).eq("bookId", source.sourceBookId)).first();
        if (link) {
          await ctx.db.patch(link._id, { bookId: block.targetBookId });
          return { updated: 1, isDone: false, highlightId: block.highlightId };
        }
        await ctx.db.delete(source._id);
        return { updated: 0, isDone: false, highlightId: block.highlightId };
      }
      await ctx.db.delete(block._id);
      return { updated: 0, isDone: !(await nextHighlightProjectionBlock(ctx, args.libraryId)), highlightId: block.highlightId };
    }
    const threadLink = await ctx.db.query("threadHighlights").withIndex("by_library_and_highlight", (q) =>
      q.eq("libraryId", args.libraryId).eq("highlightId", block.highlightId)).first();
    if (threadLink) {
      const thread = await ctx.db.query("threads").withIndex("by_library_and_id", (q) =>
        q.eq("libraryId", args.libraryId).eq("id", threadLink.threadId)).unique();
      await ctx.db.delete(threadLink._id);
      // Counter only: the passage tombstone carries the membership change.
      if (thread && thread.deletedAt === undefined) {
        await ctx.db.patch(thread._id, { passageCount: Math.max(0, thread.passageCount - 1), updatedAt: Date.now() });
      }
      return { updated: 1, isDone: false, highlightId: block.highlightId };
    }
    const tagLink = await ctx.db.query("highlightTags").withIndex("by_library_and_highlight", (q) =>
      q.eq("libraryId", args.libraryId).eq("highlightId", block.highlightId)).first();
    if (tagLink) {
      const tag = await ctx.db.query("tags").withIndex("by_library_and_id", (q) =>
        q.eq("libraryId", args.libraryId).eq("id", tagLink.tagId)).unique();
      await ctx.db.delete(tagLink._id);
      // Counter only: the passage tombstone carries the membership change.
      if (tag && tag.deletedAt === undefined) {
        await ctx.db.patch(tag._id, { highlightCount: Math.max(0, tag.highlightCount - 1), updatedAt: Date.now() });
      }
      return { updated: 1, isDone: false, highlightId: block.highlightId };
    }
    const staleSource = await ctx.db.query("highlightProjectionSources")
      .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", block.highlightId)).first();
    if (staleSource) {
      await ctx.db.delete(staleSource._id);
      return { updated: 0, isDone: false, highlightId: block.highlightId };
    }
    await ctx.db.delete(block._id);
    return { updated: 0, isDone: !(await nextHighlightProjectionBlock(ctx, args.libraryId)), highlightId: block.highlightId };
  },
});

function nextHighlightProjectionBlock(ctx: MutationContext, libraryId: string) {
  return ctx.db.query("highlightProjectionBlocks")
    .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", libraryId)).first();
}

/** Run repeatedly until isDone before deploying a schema that requires highlightTags.bookId. */
export const backfillHighlightTagBookIds = internalMutation({
  args: { libraryId: v.string() },
  returns: v.object({ updated: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const links = await ctx.db.query("highlightTags")
      .withIndex("by_library_and_book", (q) => q.eq("libraryId", args.libraryId).eq("bookId", undefined))
      .take(BACKFILL_BATCH + 1);
    const batch = links.slice(0, BACKFILL_BATCH);
    for (const link of batch) {
      const highlight = await ctx.db.query("highlights")
        .withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", link.highlightId))
        .unique();
      if (!highlight) throw new Error("Legacy highlight-tag membership has no matching highlight");
      await ctx.db.patch(link._id, { bookId: highlight.bookId });
    }
    return { updated: batch.length, isDone: links.length <= BACKFILL_BATCH };
  },
});

/** Run repeatedly until isDone after adding the lightweight daily-candidate projection. */
export const backfillDailyCandidates = internalMutation({
  args: { libraryId: v.string() },
  returns: v.object({ updated: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const highlights = await ctx.db.query("highlights")
      .withIndex("by_library_candidate_ready_and_id", (q) => q.eq("libraryId", args.libraryId).eq("dailyCandidateReady", undefined))
      .take(BACKFILL_BATCH + 1);
    const batch = highlights.slice(0, BACKFILL_BATCH);
    for (const highlight of batch) {
      if (!highlight.archived && highlight.deletedAt === undefined && highlight.text.trim()) {
        const [book, existing] = await Promise.all([
          ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", highlight.bookId)).unique(),
          ctx.db.query("dailyCandidates").withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", highlight.id)).unique(),
        ]);
        if (!book) throw new Error("Highlight has no matching book");
        if (!existing) await ctx.db.insert("dailyCandidates", {
          libraryId: args.libraryId,
          highlightId: highlight.id,
          bookId: highlight.bookId,
          bookActive: !book.archived && book.deletedAt === undefined,
        });
      }
      await ctx.db.patch(highlight._id, { dailyCandidateReady: true });
    }
    return { updated: batch.length, isDone: highlights.length <= BACKFILL_BATCH };
  },
});

/**
 * Run repeatedly until isDone before enabling sync. One legacy document is
 * materialized per call, so a pre-bound oversized body cannot exhaust the
 * transaction read budget. Excess/oversized attached notes become standalone;
 * their complete body remains in the library for explicit reader review.
 */
export const boundLegacyAttachedNotes = internalMutation({
  args: { libraryId: v.string(), confirmDetach: v.optional(v.boolean()) },
  returns: v.object({
    updated: v.number(), detached: v.number(), isDone: v.boolean(), requiresReview: v.boolean(),
    reviewNoteId: v.optional(v.string()),
    reviewReason: v.optional(v.union(v.literal("oversized"), v.literal("too-many"))),
  }),
  handler: async (ctx, args) => {
    const notes = await ctx.db.query("notes")
      .withIndex("by_library_attachment_ready_and_id", (q) => q.eq("libraryId", args.libraryId).eq("attachmentBoundsReady", undefined))
      .take(2);
    const note = notes[0];
    if (!note) return { updated: 0, detached: 0, isDone: true, requiresReview: false };
    let detach = false;
    let reviewReason: "oversized" | "too-many" | undefined;
    if (note.highlightId && note.deletedAt === undefined) {
      const bytes = new TextEncoder().encode(note.markdown).byteLength;
      if (bytes > MAX_NOTE_BYTES) {
        detach = true;
        reviewReason = "oversized";
      }
      else {
        const retained = await ctx.db.query("notes")
          .withIndex("by_library_highlight_and_deleted", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", note.highlightId).eq("deletedAt", undefined))
          .filter((q) => q.eq(q.field("attachmentBoundsReady"), true))
          .take(MAX_NOTES_PER_HIGHLIGHT);
        detach = retained.length >= MAX_NOTES_PER_HIGHLIGHT;
        if (detach) reviewReason = "too-many";
      }
    }
    if (detach && args.confirmDetach !== true) {
      return {
        updated: 0, detached: 0, isDone: false, requiresReview: true,
        reviewNoteId: note.id, reviewReason: reviewReason!,
      };
    }
    await ctx.db.patch(note._id, {
      attachmentBoundsReady: true,
      ...(detach ? { highlightId: undefined } : {}),
    });
    return { updated: 1, detached: detach ? 1 : 0, isDone: notes.length === 1, requiresReview: false };
  },
});
