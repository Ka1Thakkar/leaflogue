import {
  buildPublicationSnapshot,
  isPublicationId,
  isReporterKey,
  newPublicationId,
  PUBLICATION_LIMITS,
  validReportDetails,
} from "@leaflogue/domain";
import type { DataModelFromSchemaDefinition, DocumentByName, GenericQueryCtx, MutationBuilder, QueryBuilder } from "convex/server";
import { mutationGeneric, paginationOptsValidator, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { requireLibraryAccess } from "./accessControl";
import schema from "./schema";

/**
 * Public links for web clients. Publishing freezes a copy of the passage and
 * the chosen notes; nothing else in the library becomes reachable. A link is
 * hidden again (not deleted) when the passage changes, until it is published
 * again, and the owner can withdraw it at any time.
 */

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
type Publication = DocumentByName<DataModel, "publications">;

function failure(message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "LEAFLOGUE_PUBLICATION_INVALID", message });
}

async function findHighlight(ctx: Pick<GenericQueryCtx<DataModel>, "db">, libraryId: string, id: string) {
  return ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique();
}

/** Whether the passage has changed or gone since it was published. */
async function needsReview(ctx: Pick<GenericQueryCtx<DataModel>, "db">, publication: Publication): Promise<boolean> {
  const highlight = await findHighlight(ctx, publication.libraryId, publication.highlightId);
  return !highlight || highlight.deletedAt !== undefined || highlight.archived || highlight.revision !== publication.highlightRevision;
}

/** The link for one passage, if it has one. */
export const settings = query({
  args: { libraryId: v.string(), highlightId: v.string() },
  returns: v.union(v.null(), v.object({ publicId: v.string(), active: v.boolean(), noteIds: v.array(v.string()), needsReview: v.boolean() })),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const publication = await ctx.db.query("publications")
      .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", args.highlightId)).unique();
    if (!publication) return null;
    return { publicId: publication.publicId, active: publication.active, noteIds: publication.noteIds, needsReview: await needsReview(ctx, publication) };
  },
});

export const publish = mutation({
  args: { libraryId: v.string(), highlightId: v.string(), noteIds: v.array(v.string()), rightsConfirmed: v.boolean() },
  returns: v.object({ publicId: v.string() }),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    if (!args.rightsConfirmed) throw failure("Confirm that you are allowed to share this passage");
    if (new Set(args.noteIds).size !== args.noteIds.length) throw failure("Choose each note once");
    const highlight = await findHighlight(ctx, args.libraryId, args.highlightId);
    if (!highlight || highlight.deletedAt !== undefined || highlight.archived) throw failure("That passage no longer exists");
    const book = await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", highlight.bookId)).unique();
    if (!book || book.deletedAt !== undefined) throw failure("That passage's book no longer exists");
    const notes = [];
    for (const noteId of args.noteIds.slice(0, PUBLICATION_LIMITS.notes + 1)) {
      const note = await ctx.db.query("notes").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", noteId)).unique();
      if (!note || note.deletedAt !== undefined || note.highlightId !== highlight.id) throw failure("A chosen note is not on this passage");
      notes.push({ markdown: note.markdown, origin: note.origin });
    }
    let snapshot;
    try {
      snapshot = buildPublicationSnapshot({ passage: highlight.text, bookTitle: book.title, authors: book.authors, notes });
    } catch (error) {
      throw failure(error instanceof Error ? error.message : "This passage cannot be shared");
    }
    const existing = await ctx.db.query("publications")
      .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", highlight.id)).unique();
    const now = Date.now();
    const fields = {
      bookId: book.id,
      highlightRevision: highlight.revision,
      noteIds: [...args.noteIds],
      passage: snapshot.passage,
      bookTitle: snapshot.bookTitle,
      authors: [...snapshot.authors],
      notes: snapshot.notes.map((note) => ({ ...note })),
      active: true,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return { publicId: existing.publicId };
    }
    const count = await ctx.db.query("publications")
      .withIndex("by_library_active_published", (q) => q.eq("libraryId", args.libraryId)).take(PUBLICATION_LIMITS.publications);
    if (count.length >= PUBLICATION_LIMITS.publications) throw failure(`A library can hold at most ${PUBLICATION_LIMITS.publications} links`);
    const publicId = newPublicationId();
    await ctx.db.insert("publications", { libraryId: args.libraryId, publicId, highlightId: highlight.id, publishedAt: now, ...fields });
    return { publicId };
  },
});

export const withdraw = mutation({
  args: { libraryId: v.string(), publicId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    const publication = await ctx.db.query("publications").withIndex("by_public_id", (q) => q.eq("publicId", args.publicId)).unique();
    if (!publication || publication.libraryId !== args.libraryId) throw failure("That link no longer exists");
    await ctx.db.patch(publication._id, { active: false, updatedAt: Date.now() });
    return null;
  },
});

/** The library's live links, newest first, each flagged if its passage has changed. */
export const listMine = query({
  args: { libraryId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const result = await ctx.db.query("publications")
      .withIndex("by_library_active_published", (q) => q.eq("libraryId", args.libraryId).eq("active", true))
      .order("desc")
      .paginate(args.paginationOpts);
    const page = [];
    for (const publication of result.page) {
      page.push({
        publicId: publication.publicId,
        highlightId: publication.highlightId,
        bookId: publication.bookId,
        bookTitle: publication.bookTitle,
        authors: publication.authors,
        passage: publication.passage,
        notes: publication.notes.length,
        needsReview: await needsReview(ctx, publication),
        publishedAt: publication.publishedAt,
        updatedAt: publication.updatedAt,
      });
    }
    return { ...result, page };
  },
});

/** What anyone with the link sees. No sign-in; nothing beyond the frozen copy. */
export const get = query({
  args: { publicId: v.string() },
  returns: v.union(v.null(), v.object({
    publicId: v.string(),
    passage: v.string(),
    bookTitle: v.string(),
    authors: v.array(v.string()),
    notes: v.array(v.object({ markdown: v.string(), ai: v.boolean() })),
    publishedAt: v.number(),
  })),
  handler: async (ctx, args) => {
    if (!isPublicationId(args.publicId)) return null;
    const publication = await ctx.db.query("publications").withIndex("by_public_id", (q) => q.eq("publicId", args.publicId)).unique();
    if (!publication || !publication.active || await needsReview(ctx, publication)) return null;
    return {
      publicId: publication.publicId,
      passage: publication.passage,
      bookTitle: publication.bookTitle,
      authors: publication.authors,
      notes: publication.notes,
      publishedAt: publication.publishedAt,
    };
  },
});

/** An anonymous report, limited per reporter per day and per link. */
export const report = mutation({
  args: {
    publicId: v.string(),
    reporterKey: v.string(),
    reason: v.union(v.literal("copyright"), v.literal("harassment"), v.literal("personal_information"), v.literal("other")),
    details: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!isReporterKey(args.reporterKey)) throw failure("This report could not be sent");
    let details: string | undefined;
    try {
      details = validReportDetails(args.details);
    } catch (error) {
      throw failure(error instanceof Error ? error.message : "Report details are not valid");
    }
    const publication = isPublicationId(args.publicId)
      ? await ctx.db.query("publications").withIndex("by_public_id", (q) => q.eq("publicId", args.publicId)).unique()
      : null;
    if (!publication || !publication.active) throw failure("That link no longer exists");
    const day = new Date().toISOString().slice(0, 10);
    const today = await ctx.db.query("publicationReports")
      .withIndex("by_reporter_and_day", (q) => q.eq("reporterKey", args.reporterKey).eq("day", day))
      .take(PUBLICATION_LIMITS.reportsPerReporterPerDay);
    if (today.length >= PUBLICATION_LIMITS.reportsPerReporterPerDay) throw failure("You have sent the most reports allowed today");
    const existing = await ctx.db.query("publicationReports")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.publicId))
      .take(PUBLICATION_LIMITS.reportsPerPublication);
    if (existing.length >= PUBLICATION_LIMITS.reportsPerPublication) throw failure("This link is already under review");
    await ctx.db.insert("publicationReports", {
      publicId: args.publicId,
      libraryId: publication.libraryId,
      reporterKey: args.reporterKey,
      day,
      reason: args.reason,
      ...(details ? { details } : {}),
      status: "open",
      createdAt: Date.now(),
    });
    return null;
  },
});
