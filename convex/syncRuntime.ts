import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  FunctionReference,
  GenericQueryCtx,
  MutationBuilder,
  QueryBuilder,
} from "convex/server";
import { makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import type { Infer } from "convex/values";
import { v } from "convex/values";
import { MAX_SYNC_CHANGE_PAGE, MAX_SYNC_ORGANIZATION_MEMBERSHIPS, MAX_SYNCED_STATUS_EVENTS_PER_BOOK, MAX_THREADS_PER_HIGHLIGHT } from "@leaflogue/contracts";
import type { SyncedChangeOutcome } from "@leaflogue/contracts";
import { accessFailure } from "./accessControl";
import { requireSyncKey } from "./syncKey";
import { applySyncedChangeArgs, syncedChangeOutcomeValidator, syncedChangeValidator } from "./libraryContracts";
import { syncChangeValidator } from "./readContracts";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type QueryContext = GenericQueryCtx<DataModel>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const MAX_STATEFUL_PULL_ITEMS = 4;
const cursorValidator = v.object({ generation: v.number(), afterSequence: v.number() });
const pullResultValidator = v.object({
  page: v.object({
    changes: v.array(syncChangeValidator),
    nextCursor: cursorValidator,
    isDone: v.boolean(),
    resetRequired: v.boolean(),
  }),
  changes: v.array(v.union(syncedChangeValidator, v.null())),
});
const migrationNameValidator = v.union(
  v.literal("highlight-tag-books"),
  v.literal("daily-candidates"),
  v.literal("attached-notes"),
  v.literal("daily-projection"),
  v.literal("highlight-projection"),
);
const migrationStepResultValidator = v.union(
  v.object({ status: v.literal("complete"), updated: v.number(), detached: v.number() }),
  v.object({
    status: v.literal("progress"), migration: migrationNameValidator,
    updated: v.number(), detached: v.number(),
  }),
  v.object({
    status: v.literal("review-required"), migration: v.literal("attached-notes"),
    updated: v.number(), detached: v.number(), reviewNoteId: v.string(),
    reviewReason: v.union(v.literal("oversized"), v.literal("too-many")),
  }),
);
type RuntimeSyncedChange = Infer<typeof syncedChangeValidator>;
const applyInternal = makeFunctionReference<"mutation", {
  libraryId: string;
  change: Record<string, unknown>;
}, SyncedChangeOutcome>("library:applySyncedChange") as unknown as FunctionReference<"mutation", "internal", {
  libraryId: string;
  change: Record<string, unknown>;
}, SyncedChangeOutcome>;
const backfillHighlightTagBookIdsInternal = makeFunctionReference<"mutation", { libraryId: string }, {
  updated: number; isDone: boolean;
}>("migrations:backfillHighlightTagBookIds");
const backfillDailyCandidatesInternal = makeFunctionReference<"mutation", { libraryId: string }, {
  updated: number; isDone: boolean;
}>("migrations:backfillDailyCandidates");
const boundLegacyAttachedNotesInternal = makeFunctionReference<"mutation", { libraryId: string; confirmDetach?: boolean }, {
  updated: number; detached: number; isDone: boolean; requiresReview: boolean;
  reviewNoteId?: string; reviewReason?: "oversized" | "too-many";
}>("migrations:boundLegacyAttachedNotes");
const repairDailyProjectionInternal = makeFunctionReference<"mutation", { libraryId: string }, {
  updated: number; isDone: boolean; bookId?: string;
}>("migrations:repairDailyProjection");
const repairHighlightProjectionInternal = makeFunctionReference<"mutation", { libraryId: string }, {
  updated: number; isDone: boolean; highlightId?: string;
}>("migrations:repairHighlightProjection");

/**
 * The one library a key-authorized deployment syncs, created on first use.
 * A deployment holding several libraries needs an explicit selector and is
 * refused, as with PostgreSQL.
 */
export const ensureLibrary = mutation({
  args: { syncKey: v.string() },
  returns: v.object({ libraryId: v.string() }),
  handler: async (ctx, args) => {
    await requireSyncKey(args.syncKey);
    const libraries = await ctx.db.query("libraries").take(2);
    if (libraries.length > 1) {
      throw accessFailure("LEAFLOGUE_LIBRARY_SELECTION_REQUIRED", "This deployment holds more than one library");
    }
    if (libraries[0]) return { libraryId: libraries[0].externalId };
    const libraryId = crypto.randomUUID();
    const now = Date.now();
    await ctx.db.insert("libraries", { externalId: libraryId, nextChangeSequence: 0, createdAt: now, updatedAt: now });
    return { libraryId };
  },
});

/**
 * Apply at most one bounded migration batch before sync. Repeated calls are
 * idempotent and advance through a fixed dependency order. A legacy attached
 * note is detached only when the caller confirms the exact note reported by a
 * previous call; stale or forged confirmation cannot approve another note.
 */
export const runMigrationStep = mutation({
  args: {
    libraryId: v.string(),
    syncKey: v.string(),
    confirmDetachNoteId: v.optional(v.string()),
  },
  returns: migrationStepResultValidator,
  handler: async (ctx, args) => {
    await requireSyncKey(args.syncKey);
    await requireLibrary(ctx, args.libraryId);

    const highlightTags = await ctx.runMutation(backfillHighlightTagBookIdsInternal, { libraryId: args.libraryId });
    if (!highlightTags.isDone || highlightTags.updated > 0) {
      return { status: "progress" as const, migration: "highlight-tag-books" as const,
        updated: highlightTags.updated, detached: 0 };
    }

    const dailyCandidates = await ctx.runMutation(backfillDailyCandidatesInternal, { libraryId: args.libraryId });
    if (!dailyCandidates.isDone || dailyCandidates.updated > 0) {
      return { status: "progress" as const, migration: "daily-candidates" as const,
        updated: dailyCandidates.updated, detached: 0 };
    }

    let notes = await ctx.runMutation(boundLegacyAttachedNotesInternal, { libraryId: args.libraryId });
    if (notes.requiresReview && args.confirmDetachNoteId === notes.reviewNoteId) {
      notes = await ctx.runMutation(boundLegacyAttachedNotesInternal, { libraryId: args.libraryId, confirmDetach: true });
    }
    if (notes.requiresReview) {
      if (!notes.reviewNoteId || !notes.reviewReason) throw new Error("Attached-note migration returned invalid review state");
      return { status: "review-required" as const, migration: "attached-notes" as const,
        updated: notes.updated, detached: notes.detached,
        reviewNoteId: notes.reviewNoteId, reviewReason: notes.reviewReason };
    }
    if (!notes.isDone || notes.updated > 0) {
      return { status: "progress" as const, migration: "attached-notes" as const,
        updated: notes.updated, detached: notes.detached };
    }

    const dailyProjection = await ctx.runMutation(repairDailyProjectionInternal, { libraryId: args.libraryId });
    if (!dailyProjection.isDone || dailyProjection.updated > 0) {
      return { status: "progress" as const, migration: "daily-projection" as const,
        updated: dailyProjection.updated, detached: 0 };
    }

    const highlightProjection = await ctx.runMutation(repairHighlightProjectionInternal, { libraryId: args.libraryId });
    if (!highlightProjection.isDone || highlightProjection.updated > 0) {
      return { status: "progress" as const, migration: "highlight-projection" as const,
        updated: highlightProjection.updated, detached: 0 };
    }
    return { status: "complete" as const, updated: 0, detached: 0 };
  },
});

/** Replay one canonical `SyncedChange` written by the calling device. */
export const pushSyncedChange = mutation({
  args: {
    ...applySyncedChangeArgs,
    syncKey: v.string(),
    deviceId: v.string(),
  },
  returns: syncedChangeOutcomeValidator,
  handler: async (ctx, args) => {
    await requireSyncKey(args.syncKey);
    requireDeviceId(args.deviceId);
    if (args.change.deviceId !== args.deviceId) throw new Error("Synced change does not belong to this device");
    await requireLibrary(ctx, args.libraryId);
    await requireMigrationsComplete(ctx, args.libraryId);
    return ctx.runMutation(applyInternal, { libraryId: args.libraryId, change: args.change });
  },
});

/**
 * Convex retains the complete ordered history. Sequence zero is therefore the
 * only honest bootstrap position; the local ledger replays it before pushing.
 */
export const bootstrapCursor = query({
  args: syncArgs(),
  returns: cursorValidator,
  handler: async (ctx, args) => {
    await requireSyncKey(args.syncKey);
    const library = await requireLibrary(ctx, args.libraryId);
    await requireMigrationsComplete(ctx, args.libraryId);
    return { generation: requireGeneration(library.syncGeneration ?? 1), afterSequence: 0 };
  },
});

export const validateCursor = query({
  args: { ...syncArgs(), cursor: cursorValidator },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireSyncKey(args.syncKey);
    const library = await requireLibrary(ctx, args.libraryId);
    await requireMigrationsComplete(ctx, args.libraryId);
    const cursor = requireCursor(args.cursor);
    return cursor.generation === requireGeneration(library.syncGeneration ?? 1) &&
      cursor.afterSequence <= requireSequence(library.nextChangeSequence);
  },
});

/**
 * Return a bounded history page and the current winning state behind each
 * identity. Four state documents keep the worst valid highlight page below
 * two MiB; callers may request a larger transport page, but this endpoint
 * deliberately advances by no more than this provider-safe slice.
 *
 * `null` is an intentional stop marker. It means the history row was produced
 * interactively, its writer claim no longer owns the current revision, or its
 * entity type is not replayable yet. A client must not advance past it.
 */
export const pull = query({
  args: { ...syncArgs(), cursor: cursorValidator, limit: v.number() },
  returns: pullResultValidator,
  handler: async (ctx, args) => {
    await requireSyncKey(args.syncKey);
    const library = await requireLibrary(ctx, args.libraryId);
    await requireMigrationsComplete(ctx, args.libraryId);
    const cursor = requireCursor(args.cursor);
    const requestedLimit = requireLimit(args.limit);
    const generation = requireGeneration(library.syncGeneration ?? 1);
    const nextChangeSequence = requireSequence(library.nextChangeSequence);
    if (cursor.generation !== generation || cursor.afterSequence > nextChangeSequence) {
      return resetPage(generation);
    }
    const limit = Math.min(requestedLimit, MAX_STATEFUL_PULL_ITEMS);
    const rows = await ctx.db.query("syncChanges")
      .withIndex("by_library_and_sequence", (builder) => builder
        .eq("libraryId", args.libraryId)
        .gt("sequence", cursor.afterSequence))
      .order("asc")
      .take(limit + 1);
    const identities = rows.slice(0, limit).map((row) => ({
      sequence: requireSequence(row.sequence),
      entityType: row.entityType,
      entityId: row.entityId,
      revision: requireSequence(row.revision),
      changedAt: requireSequence(row.changedAt),
    }));
    const changes: Array<RuntimeSyncedChange | null> = [];
    for (const identity of identities) {
      changes.push(await resolveSyncedState(ctx, args.libraryId, identity.entityType, identity.entityId));
    }
    return {
      page: {
        changes: identities,
        nextCursor: { generation, afterSequence: identities.at(-1)?.sequence ?? cursor.afterSequence },
        isDone: rows.length <= limit,
        resetRequired: false,
      },
      changes,
    };
  },
});

function syncArgs() {
  return { libraryId: v.string(), syncKey: v.string() };
}

function requireDeviceId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new Error("Device ID is invalid");
}

async function requireLibrary(ctx: QueryContext, libraryId: string): Promise<DocumentByName<DataModel, "libraries">> {
  const library = await ctx.db.query("libraries")
    .withIndex("by_external_id", (builder) => builder.eq("externalId", libraryId))
    .unique();
  if (!library) throw new Error("Library no longer exists");
  return library;
}

/**
 * Every exchange path enforces the migration barrier, including calls from an
 * older desktop that does not know about `runMigrationStep`. Each indexed
 * lookup reads at most one document, so the check remains bounded regardless
 * of library size.
 */
async function requireMigrationsComplete(ctx: QueryContext, libraryId: string): Promise<void> {
  const pending = await Promise.all([
    ctx.db.query("highlightTags")
      .withIndex("by_library_and_book", (q) => q.eq("libraryId", libraryId).eq("bookId", undefined)).first(),
    ctx.db.query("highlights")
      .withIndex("by_library_candidate_ready_and_id", (q) => q.eq("libraryId", libraryId).eq("dailyCandidateReady", undefined)).first(),
    ctx.db.query("notes")
      .withIndex("by_library_attachment_ready_and_id", (q) => q.eq("libraryId", libraryId).eq("attachmentBoundsReady", undefined)).first(),
    ctx.db.query("dailyProjectionBlocks")
      .withIndex("by_library", (q) => q.eq("libraryId", libraryId)).first(),
    ctx.db.query("highlightProjectionBlocks")
      .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", libraryId)).first(),
  ]);
  if (pending.some((document) => document !== null)) {
    throw accessFailure("LEAFLOGUE_MIGRATION_REQUIRED", "This library must finish its bounded migrations before sync");
  }
}

function requireCursor(cursor: { generation: number; afterSequence: number }) {
  return { generation: requireGeneration(cursor.generation), afterSequence: requireSequence(cursor.afterSequence) };
}

function requireGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Library sync generation is invalid");
  return value;
}

function requireSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Sync sequence is invalid");
  return value;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SYNC_CHANGE_PAGE) {
    throw new Error(`Sync page size must be between 1 and ${MAX_SYNC_CHANGE_PAGE}`);
  }
  return value;
}

function resetPage(generation: number) {
  return {
    page: {
      changes: [],
      nextCursor: { generation, afterSequence: 0 },
      isDone: false,
      resetRequired: true,
    },
    changes: [],
  };
}

async function resolveSyncedState(
  ctx: QueryContext,
  libraryId: string,
  entityType: "book" | "highlight" | "note" | "collection" | "tag" | "thread" | "daily-selection",
  entityId: string,
): Promise<RuntimeSyncedChange | null> {

  const writer = await ctx.db.query("syncedWriters").withIndex("by_library_entity", (builder) => builder
    .eq("libraryId", libraryId).eq("entityType", entityType).eq("entityId", entityId)).unique();
  if (!writer) return null;
  const claim = { deviceId: writer.deviceId, deviceRevision: requirePositiveRevision(writer.deviceRevision) };
  if (entityType === "daily-selection") {
    const current = await ctx.db.query("dailySelections").withIndex("by_library_and_id", (builder) => builder
      .eq("libraryId", libraryId).eq("id", entityId)).unique();
    if (writer.operation === "tombstone") {
      if (!(await claimedTombstone(ctx, libraryId, entityType, entityId, writer.entityRevision, current))) return null;
      return { entityType, operation: "tombstone", ...claim, entityId };
    }
    if (!claimedLiveRow(current, writer.entityRevision)) return null;
    return { entityType, operation: "upsert", ...claim, dailySelection: {
      id: current.id,
      localDay: current.localDay,
      timezone: current.timezone,
      ...(current.highlightId !== undefined ? { highlightId: current.highlightId } : {}),
      candidateDigest: current.candidateDigest,
      recentHighlightIds: current.recentHighlightIds,
      selectedAt: current.selectedAt,
      updatedAt: current.updatedAt,
      revision: current.revision,
      createdAt: current.createdAt ?? current.selectedAt,
    } };
  }  if (entityType === "collection") {
    const current = await ctx.db.query("collections").withIndex("by_library_and_id", (builder) => builder
      .eq("libraryId", libraryId).eq("id", entityId)).unique();
    if (writer.operation === "tombstone") {
      if (!(await claimedTombstone(ctx, libraryId, entityType, entityId, writer.entityRevision, current))) return null;
      return { entityType, operation: "tombstone", ...claim, entityId };
    }
    if (!claimedLiveRow(current, writer.entityRevision)) return null;
    return { entityType, operation: "upsert", ...claim, collection: {
      id: current.id,
      name: current.name,
      ...(current.description !== undefined ? { description: current.description } : {}),
      bookCount: current.bookCount,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      revision: current.revision,
    } };
  }
  if (entityType === "thread") {
    const current = await ctx.db.query("threads").withIndex("by_library_and_id", (builder) => builder
      .eq("libraryId", libraryId).eq("id", entityId)).unique();
    if (writer.operation === "tombstone") {
      if (!(await claimedTombstone(ctx, libraryId, entityType, entityId, writer.entityRevision, current))) return null;
      return { entityType, operation: "tombstone", ...claim, entityId };
    }
    if (!claimedLiveRow(current, writer.entityRevision)) return null;
    return { entityType, operation: "upsert", ...claim, thread: {
      id: current.id,
      name: current.name,
      ...(current.description !== undefined ? { description: current.description } : {}),
      passageCount: current.passageCount,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      revision: current.revision,
    } };
  }
  if (entityType === "tag") {
    const current = await ctx.db.query("tags").withIndex("by_library_and_id", (builder) => builder
      .eq("libraryId", libraryId).eq("id", entityId)).unique();
    if (writer.operation === "tombstone") {
      if (!(await claimedTombstone(ctx, libraryId, entityType, entityId, writer.entityRevision, current))) return null;
      return { entityType, operation: "tombstone", ...claim, entityId };
    }
    if (!claimedLiveRow(current, writer.entityRevision)) return null;
    return { entityType, operation: "upsert", ...claim, tag: {
      id: current.id,
      name: current.name,
      ...(current.color !== undefined ? { color: current.color } : {}),
      bookCount: current.bookCount,
      highlightCount: current.highlightCount,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      revision: current.revision,
    } };
  }
  if (entityType === "book") {
    const current = await ctx.db.query("books").withIndex("by_library_and_id", (builder) => builder
      .eq("libraryId", libraryId).eq("id", entityId)).unique();
    if (writer.operation === "tombstone") {
      if (!(await claimedTombstone(ctx, libraryId, entityType, entityId, writer.entityRevision, current))) return null;
      return { entityType, operation: "tombstone", ...claim, entityId };
    }
    if (!claimedLiveRow(current, writer.entityRevision)) return null;
    const [collectionLinks, tagLinks] = await Promise.all([
      ctx.db.query("collectionBooks").withIndex("by_library_and_book", (builder) => builder.eq("libraryId", libraryId).eq("bookId", entityId)).take(MAX_SYNC_ORGANIZATION_MEMBERSHIPS + 1),
      ctx.db.query("bookTags").withIndex("by_library_and_book", (builder) => builder.eq("libraryId", libraryId).eq("bookId", entityId)).take(MAX_SYNC_ORGANIZATION_MEMBERSHIPS + 1),
    ]);
    const history = await ctx.db.query("readingStatusEvents").withIndex("by_library_and_book_and_sequence", (builder) => builder
      .eq("libraryId", libraryId).eq("bookId", entityId)).take(MAX_SYNCED_STATUS_EVENTS_PER_BOOK + 1);
    if (history.length > MAX_SYNCED_STATUS_EVENTS_PER_BOOK) throw new Error("Synced book reading history exceeds its limit");
    if (collectionLinks.length > MAX_SYNC_ORGANIZATION_MEMBERSHIPS || tagLinks.length > MAX_SYNC_ORGANIZATION_MEMBERSHIPS) {
      throw new Error("Synced book organization exceeds its limit");
    }
    return {
      entityType, operation: "upsert", ...claim,
      book: {
        id: current.id,
        title: current.title,
        authors: current.authors,
        ...(current.description !== undefined ? { description: current.description } : {}),
        ...(current.publisher !== undefined ? { publisher: current.publisher } : {}),
        ...(current.series !== undefined ? { series: current.series } : {}),
        ...(current.seriesNumber !== undefined ? { seriesNumber: current.seriesNumber } : {}),
        ...(current.language !== undefined ? { language: current.language } : {}),
        ...(current.isbn13 !== undefined ? { isbn13: current.isbn13 } : {}),
        ...(current.coverUrl !== undefined ? { coverUrl: current.coverUrl } : {}),
        status: current.status,
        ...(current.completedOn !== undefined ? { completedOn: current.completedOn } : {}),
        archived: current.archived,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        revision: current.revision,
        highlightCount: current.highlightCount,
      },
      collectionIds: collectionLinks.map(({ collectionId }) => collectionId).sort(),
      tagIds: tagLinks.map(({ tagId }) => tagId).sort(),
      statusEvents: history.sort((left, right) => left.changedAt - right.changedAt || left.sequence - right.sequence)
        .map((event) => ({
          id: event.id, bookId: event.bookId, status: event.status, source: event.source, changedAt: event.changedAt,
          ...(event.completedOn !== undefined ? { completedOn: event.completedOn } : {}), bookRevision: event.bookRevision,
        })),
    };
  }
  if (entityType === "highlight") {
    const current = await ctx.db.query("highlights").withIndex("by_library_and_id", (builder) => builder
      .eq("libraryId", libraryId).eq("id", entityId)).unique();
    if (writer.operation === "tombstone") {
      const tombstone = await claimedTombstone(ctx, libraryId, entityType, entityId, writer.entityRevision, current);
      return tombstone
        ? { entityType, operation: "tombstone", ...claim, entityId, bookId: tombstone.bookId }
        : null;
    }
    if (!claimedLiveRow(current, writer.entityRevision)) return null;
    if (current.archived) return null;
    const tagLinks = await ctx.db.query("highlightTags").withIndex("by_library_and_highlight", (builder) => builder
      .eq("libraryId", libraryId).eq("highlightId", entityId)).take(MAX_SYNC_ORGANIZATION_MEMBERSHIPS + 1);
    if (tagLinks.length > MAX_SYNC_ORGANIZATION_MEMBERSHIPS) throw new Error("Synced passage organization exceeds its limit");
    const threadLinks = await ctx.db.query("threadHighlights").withIndex("by_library_and_highlight", (builder) => builder
      .eq("libraryId", libraryId).eq("highlightId", entityId)).take(MAX_THREADS_PER_HIGHLIGHT + 1);
    if (threadLinks.length > MAX_THREADS_PER_HIGHLIGHT) throw new Error("Synced passage belongs to too many threads");
    return {
      entityType, operation: "upsert", ...claim,
      highlight: {
        id: current.id,
        bookId: current.bookId,
        text: current.text,
        ...(current.sourceLocation !== undefined ? { sourceLocation: current.sourceLocation } : {}),
        ...(current.sourceCreatedAt !== undefined ? { sourceCreatedAt: current.sourceCreatedAt } : {}),
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        revision: current.revision,
      },
      tagIds: tagLinks.map(({ tagId }) => tagId).sort(),
      threadIds: threadLinks.map(({ threadId }) => threadId).sort(),
    };
  }
  const current = await ctx.db.query("notes").withIndex("by_library_and_id", (builder) => builder
    .eq("libraryId", libraryId).eq("id", entityId)).unique();
  if (writer.operation === "tombstone") {
    const tombstone = await claimedTombstone(ctx, libraryId, entityType, entityId, writer.entityRevision, current);
    return tombstone
      ? { entityType, operation: "tombstone", ...claim, entityId, bookId: tombstone.bookId }
      : null;
  }
  if (!claimedLiveRow(current, writer.entityRevision)) return null;
  return {
    entityType, operation: "upsert", ...claim,
    note: {
      id: current.id,
      bookId: current.bookId,
      ...(current.highlightId !== undefined ? { highlightId: current.highlightId } : {}),
      markdown: current.markdown,
      origin: current.origin,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      revision: current.revision,
    },
  };
}

function claimedLiveRow(
  current: { deletedAt?: number; revision: number } | null,
  entityRevision: number,
): current is NonNullable<typeof current> {
  return current !== null && current.deletedAt === undefined && Number(current.revision) === Number(entityRevision);
}

async function claimedTombstone(
  ctx: QueryContext,
  libraryId: string,
  entityType: "book" | "highlight" | "note" | "collection" | "tag" | "thread" | "daily-selection",
  entityId: string,
  entityRevision: number,
  current: { deletedAt?: number; revision: number } | null,
): Promise<DocumentByName<DataModel, "syncTombstones"> | null> {
  if (current && (current.deletedAt === undefined || Number(current.revision) !== Number(entityRevision))) return null;
  const tombstone = await ctx.db.query("syncTombstones").withIndex("by_library_entity", (builder) => builder
    .eq("libraryId", libraryId).eq("entityType", entityType).eq("entityId", entityId)).unique();
  return tombstone && Number(tombstone.revision) === Number(entityRevision) ? tombstone : null;
}

function requirePositiveRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Synced writer revision is invalid");
  return value;
}
