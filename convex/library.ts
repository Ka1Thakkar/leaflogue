import type { DataModelFromSchemaDefinition, DocumentByName, FunctionReference, GenericMutationCtx, MutationBuilder } from "convex/server";
import { internalMutationGeneric, makeFunctionReference } from "convex/server";
import type { GenericId } from "convex/values";
import { v } from "convex/values";
import { MAX_NOTE_BYTES, MAX_NOTES_PER_HIGHLIGHT, MAX_STATUS_EVENTS_PER_BOOK, MAX_SYNC_ORGANIZATION_MEMBERSHIPS, MAX_SYNCED_STATUS_EVENTS_PER_BOOK, MAX_THREADS_PER_HIGHLIGHT, normalizeOrganizationName } from "@leaflogue/contracts";
import { dailySelectionWins } from "@leaflogue/contracts";
import type { ReadingStatusEvent, SyncedChange, SyncedChangeOutcome } from "@leaflogue/contracts";
import { validateCompletionDate } from "@leaflogue/domain";
import {
  archiveValidator,
  applySyncedChangeArgs,
  bookValidator,
  createBookArgs,
  internalCreateHighlightArgs,
  internalCreateNoteArgs,
  annotationDeletionValidator,
  deleteAnnotationArgs,
  highlightValidator,
  mergeBooksArgs,
  mergeValidator,
  noteValidator,
  readingStatusChangeValidator,
  setBookArchivedArgs,
  setBookCompletionDateArgs,
  setBookReadingStatusArgs,
  syncedChangeOutcomeValidator,
  updateBookMetadataArgs,
  updateHighlightArgs,
  updateNoteArgs,
} from "./libraryContracts";
import { accessFailure } from "./accessControl";
import schema from "./schema";
import { claimWebWrites } from "./webWrites";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationContext = GenericMutationCtx<DataModel>;
type Change = { readonly entityType: "book" | "highlight" | "note" | "collection" | "tag" | "thread" | "daily-selection"; readonly entityId: string; readonly revision: number };
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
const MAX_ATOMIC_MERGE_ITEMS = 400;
const MAX_ATOMIC_MERGE_BYTES = 8 * 1024 * 1024;
const MAX_ATOMIC_ORGANIZATION_MEMBERSHIPS = 400;
const MAX_ATOMIC_STATUS_EVENTS = 200;
/**
 * What one deletion transaction tombstones. Convex queries materialize complete
 * documents before application code can count their bytes. Legacy notes may
 * predate today's 24 KiB body limit, so reading 201 of them first is not a byte
 * bound at all. Four documents plus the one-row look-ahead stays conservative
 * even at Convex's document ceiling; callers drain larger passages by revision.
 */
const NOTE_DELETION_BATCH = 4;
const NOTE_DELETION_BYTE_BUDGET = MAX_NOTES_PER_HIGHLIGHT * MAX_NOTE_BYTES;
const MAX_ATOMIC_DAILY_CANDIDATES = 400;
const MAX_ESTIMATED_MERGE_IO_OPERATIONS = 750;
const MAX_PENDING_SYNC_CONFLICTS_PER_ENTITY = 20;
const MAX_SYNC_HIGHLIGHT_CONFLICT_BYTES = 400_000;
const MAX_THREAD_MEMBERSHIPS_PER_HIGHLIGHT = 20;
type AnnotationChange = Extract<SyncedChange, { entityType: "highlight" | "note" }>;
type ReplayEntityType = SyncedChange["entityType"];
type ReplayDocument = DocumentByName<DataModel, "books"> | DocumentByName<DataModel, "highlights"> |
  DocumentByName<DataModel, "notes"> | DocumentByName<DataModel, "collections"> | DocumentByName<DataModel, "tags"> |
  DocumentByName<DataModel, "threads"> |
  // A retired pick's row is removed rather than marked, so a present pick is never deleted.
  (DocumentByName<DataModel, "dailySelections"> & { readonly deletedAt?: undefined });
/** Links removed inside a container tombstone; the rest drain in scheduled batches. */
const CONTAINER_LINK_DRAIN_BATCH = 200;
const drainSyncedContainerLinksReference = makeFunctionReference<"mutation", {
  libraryId: string; entityType: "collection" | "tag" | "thread"; containerId: string;
}, null>("library:drainSyncedContainerLinks") as unknown as FunctionReference<"mutation", "internal", {
  libraryId: string; entityType: "collection" | "tag" | "thread"; containerId: string;
}, null>;

export const applySyncedChange = internalMutation({
  args: applySyncedChangeArgs,
  returns: syncedChangeOutcomeValidator,
  handler: async (ctx, args): Promise<SyncedChangeOutcome> => {
    const change = args.change as unknown as SyncedChange;
    if (!isCanonicalUuid(change.deviceId) || !Number.isSafeInteger(change.deviceRevision) || change.deviceRevision < 1) {
      throw new Error("Synced change revision is invalid");
    }
    const entityId = syncedEntityId(change);
    if (!isUuid(entityId)) throw new Error("Synced change entity is invalid");
    validateSyncedReferences(change);
    const library = await requireLibrary(ctx, args.libraryId);
    if (isAnnotationChange(change)) await requireAttachmentMigration(ctx, args.libraryId);
    const current: ReplayDocument | null = await findReplayEntity(ctx, args.libraryId, change.entityType, entityId);
    const writer = await ctx.db.query("syncedWriters").withIndex("by_library_entity", (q) =>
      q.eq("libraryId", args.libraryId).eq("entityType", change.entityType).eq("entityId", entityId)).unique();
    const incomingBody = syncedBody(change);
    if (change.operation === "upsert" && current?.deletedAt !== undefined &&
        (!writer || Number(writer.entityRevision) !== Number(current.revision))) {
      if (isAnnotationChange(change) && incomingBody) {
        await preserveSyncConflict(ctx, args.libraryId, change, incomingBody, undefined,
          { deviceId: change.deviceId, deviceRevision: change.deviceRevision, operation: "upsert" }, "tombstone");
      }
      const now = Date.now();
      if (writer) {
        await ctx.db.patch(writer._id, { operation: "tombstone", entityRevision: Number(current.revision), appliedAt: now });
      } else {
        await ctx.db.insert("syncedWriters", { libraryId: args.libraryId, entityType: change.entityType,
          entityId, deviceId: change.deviceId, deviceRevision: change.deviceRevision, operation: "tombstone",
          entityRevision: Number(current.revision), appliedAt: now });
      }
      await mergeSupersededStatusEvents(ctx, library, change);
      return "superseded";
    }
    const writerMatchesEntity = Boolean(writer && current && Number(writer.entityRevision) === Number(current.revision) &&
      ((writer.operation === "upsert" && current.deletedAt === undefined) ||
       (writer.operation === "tombstone" && current.deletedAt !== undefined)));
    if (writer && !incomingWins(change, writer)) {
      if (isAnnotationChange(change) && incomingBody && incomingBody !== annotationBody(change.entityType, current) &&
          !(writerMatchesEntity && causallySuperseded(change.deviceId, change.deviceRevision, writer.deviceId, writer.deviceRevision))) {
        await preserveSyncConflict(ctx, args.libraryId, change, incomingBody,
          current?.deletedAt === undefined ? annotationBody(change.entityType, current) : undefined,
          { deviceId: change.deviceId, deviceRevision: change.deviceRevision, operation: change.operation }, writer.operation);
      }
      await mergeSupersededStatusEvents(ctx, library, change);
      return "superseded";
    }
    const currentBody = isAnnotationChange(change) ? annotationBody(change.entityType, current) : undefined;
    if (isAnnotationChange(change) && currentBody && current?.deletedAt === undefined && currentBody !== incomingBody &&
        !(writerMatchesEntity && causallySuperseded(writer?.deviceId, writer?.deviceRevision, change.deviceId, change.deviceRevision))) {
      await preserveSyncConflict(ctx, args.libraryId, change, currentBody, incomingBody,
        writer
          ? { deviceId: writer.deviceId, deviceRevision: writer.deviceRevision, operation: writer.operation }
          : { operation: "upsert" }, change.operation, annotationBookId(current));
    }
    const now = Date.now();
    if (writer) {
      await ctx.db.patch(writer._id, { deviceId: change.deviceId, deviceRevision: change.deviceRevision,
        operation: change.operation, entityRevision: Number(current?.revision ?? 0), appliedAt: now });
    } else {
      await ctx.db.insert("syncedWriters", { libraryId: args.libraryId, entityType: change.entityType, entityId,
        deviceId: change.deviceId, deviceRevision: change.deviceRevision, operation: change.operation,
        entityRevision: Number(current?.revision ?? 0), appliedAt: now });
    }
    if (change.entityType === "highlight") {
      await applySyncedHighlight(ctx, library, change, current as DocumentByName<DataModel, "highlights"> | null, now);
    } else if (change.entityType === "note") {
      await applySyncedNote(ctx, library, change, current as DocumentByName<DataModel, "notes"> | null, now);
    } else if (change.entityType === "daily-selection") {
      await applySyncedDailySelection(ctx, library, change, current as DocumentByName<DataModel, "dailySelections"> | null, now);
    } else if (change.entityType === "thread") {
      await applySyncedThread(ctx, library, change, current as DocumentByName<DataModel, "threads"> | null, now);
    } else if (change.entityType === "collection" || change.entityType === "tag") {
      await applySyncedContainer(ctx, library, change,
        current as DocumentByName<DataModel, "collections"> | DocumentByName<DataModel, "tags"> | null, now);
    } else {
      await applySyncedBook(ctx, library, change, now);
    }
    await updateSyncedWriterRevision(ctx, args.libraryId, change.entityType, entityId);
    return "applied";
  },
});

/** Finish removing a deleted container's links after its tombstone committed. */
export const drainSyncedContainerLinks = internalMutation({
  args: { libraryId: v.string(), entityType: v.union(v.literal("collection"), v.literal("tag"), v.literal("thread")), containerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await removeContainerLinks(ctx, args.libraryId, args.entityType, args.containerId))) {
      await ctx.scheduler.runAfter(0, drainSyncedContainerLinksReference, args);
    }
    return null;
  },
});

async function applySyncedBook(
  ctx: MutationContext,
  library: DocumentByName<DataModel, "libraries">,
  change: Extract<SyncedChange, { entityType: "book" }>,
  now: number,
): Promise<void> {
  const libraryId = String(library.externalId);
  const entityId = syncedEntityId(change);
  if (change.operation === "tombstone") {
    const book = await findBook(ctx, libraryId, entityId);
    let revision: number | undefined;
    if (book && book.deletedAt === undefined) {
      revision = Number(book.revision) + 1;
      await ctx.db.patch(book._id, { deletedAt: now, revision, updatedAt: now });
    }
    await setBookCandidatesActive(ctx, libraryId, entityId, false);
    await replaceSyncedLinks(ctx, libraryId, "collection", entityId, entityId, [], now);
    await replaceSyncedLinks(ctx, libraryId, "book-tag", entityId, entityId, [], now);
    revision = await recordSyncedTombstone(ctx, libraryId, "book", entityId, entityId, revision, now);
    await recordChanges(ctx, library, [{ entityType: "book", entityId, revision }], now);
    return;
  }
  const collections = await activeSyncedContainers(ctx, libraryId, "collection", change.collectionIds);
  const tags = await activeSyncedContainers(ctx, libraryId, "tag", change.tagIds);
  const metadata = normalizeBookMetadata(change.book);
  const completedOn = change.book.status === "finished" ? validateCompletionDate(change.book.completedOn) : undefined;
  const existing = await findBook(ctx, libraryId, entityId);
  await setBookCandidatesActive(ctx, libraryId, entityId, !change.book.archived);
  let revision = 1;
  if (existing) {
    revision = Number(existing.revision) + 1;
    await ctx.db.patch(existing._id, { ...metadata, status: change.book.status, archived: change.book.archived,
      completedOn, deletedAt: undefined, revision, updatedAt: now });
  } else {
    await ctx.db.insert("books", { libraryId, id: entityId, ...metadata,
      status: change.book.status, archived: change.book.archived, ...(completedOn ? { completedOn } : {}),
      highlightCount: 0, noteCount: 0, readingDataBytes: 0, revision,
      createdAt: validEpoch(change.book.createdAt), updatedAt: now });
  }
  await replaceSyncedLinks(ctx, libraryId, "collection", entityId, entityId, collections, now);
  await replaceSyncedLinks(ctx, libraryId, "book-tag", entityId, entityId, tags, now);
  await mergeStatusEvents(ctx, library, entityId, change.statusEvents, true);
  await clearSyncedTombstone(ctx, libraryId, "book", entityId);
  await recordChanges(ctx, library, [{ entityType: "book", entityId, revision }], now);
}

/**
 * History is a grow-only set: a losing book change still contributes its
 * events, and the book is re-announced at its unchanged revision so every
 * device pulls the merged history. It may not move events, or a stale
 * snapshot of a merged book could pull them back.
 */
async function mergeSupersededStatusEvents(
  ctx: MutationContext,
  library: DocumentByName<DataModel, "libraries">,
  change: SyncedChange,
): Promise<void> {
  if (change.entityType !== "book" || change.operation !== "upsert" || !change.statusEvents?.length) return;
  const book = await findBook(ctx, String(library.externalId), change.book.id);
  if (!book) return;
  if (await mergeStatusEvents(ctx, library, change.book.id, change.statusEvents, false)) {
    await recordChanges(ctx, library, [{ entityType: "book", entityId: change.book.id, revision: Number(book.revision) }], Date.now());
  }
}

/** Insert unknown events; a winning snapshot may also move an event onto this book. Returns whether anything changed. */
async function mergeStatusEvents(
  ctx: MutationContext,
  library: DocumentByName<DataModel, "libraries">,
  bookId: string,
  events: readonly ReadingStatusEvent[] | undefined,
  allowMove: boolean,
): Promise<boolean> {
  if (!events?.length) return false;
  const libraryId = String(library.externalId);
  let changed = false;
  for (const event of events) {
    const existing = await ctx.db.query("readingStatusEvents").withIndex("by_library_and_id", (q) =>
      q.eq("libraryId", libraryId).eq("id", event.id)).unique();
    if (!existing) {
      await ctx.db.insert("readingStatusEvents", { libraryId, id: event.id, bookId,
        sequence: Number(library.nextChangeSequence) + 1, status: event.status, source: event.source,
        changedAt: event.changedAt, ...(event.completedOn ? { completedOn: event.completedOn } : {}), bookRevision: event.bookRevision });
      changed = true;
    } else if (allowMove && existing.bookId !== bookId) {
      await ctx.db.patch(existing._id, { bookId });
      changed = true;
    }
  }
  return changed;
}

/**
 * Collections and tags replay without touching member revisions: every member
 * carries its own complete membership set, so the origin device sends those
 * owners separately and advancing them here would orphan their writer claims.
 */
async function applySyncedContainer(
  ctx: MutationContext,
  library: DocumentByName<DataModel, "libraries">,
  change: Extract<SyncedChange, { entityType: "collection" | "tag" }>,
  current: DocumentByName<DataModel, "collections"> | DocumentByName<DataModel, "tags"> | null,
  now: number,
): Promise<void> {
  const libraryId = String(library.externalId);
  const entityId = syncedEntityId(change);
  if (change.operation === "tombstone") {
    let rowRevision: number | undefined;
    if (current && current.deletedAt === undefined) {
      rowRevision = Number(current.revision) + 1;
      await ctx.db.patch(current._id, { deletedAt: now, bookCount: 0, ...(change.entityType === "tag" ? { highlightCount: 0 } : {}),
        revision: rowRevision, updatedAt: now });
    }
    if (!(await removeContainerLinks(ctx, libraryId, change.entityType, entityId))) {
      await ctx.scheduler.runAfter(0, drainSyncedContainerLinksReference,
        { libraryId, entityType: change.entityType, containerId: entityId });
    }
    const revision = await recordSyncedTombstone(ctx, libraryId, change.entityType, entityId, entityId, rowRevision, now);
    await recordChanges(ctx, library, [{ entityType: change.entityType, entityId, revision }], now);
    return;
  }
  const maximum = change.entityType === "collection" ? 120 : 80;
  const source = change.entityType === "collection" ? change.collection : change.tag;
  const name = organizationName(source.name, change.entityType === "collection" ? "Collection" : "Tag", maximum);
  const normalizedName = normalizeOrganizationName(name);
  const createdAt = validEpoch(source.createdAt);
  const detail = change.entityType === "collection"
    ? { description: optionalText(change.collection.description, 2_000) }
    : { color: optionalText(change.tag.color, 32) };
  let revision = 1;
  if (current) {
    revision = Number(current.revision) + 1;
    await ctx.db.patch(current._id, { name, normalizedName, ...detail, deletedAt: undefined, revision, updatedAt: now });
  } else if (change.entityType === "collection") {
    await ctx.db.insert("collections", { libraryId, id: entityId, name, normalizedName,
      ...(detail.description ? { description: detail.description } : {}), bookCount: 0, revision, createdAt, updatedAt: now });
  } else {
    await ctx.db.insert("tags", { libraryId, id: entityId, name, normalizedName,
      ...(detail.color ? { color: detail.color } : {}), bookCount: 0, highlightCount: 0, revision, createdAt, updatedAt: now });
  }
  await clearSyncedTombstone(ctx, libraryId, change.entityType, entityId);
  await recordChanges(ctx, library, [{ entityType: change.entityType, entityId, revision }], now);
}

/**
 * Threads replay like collections and tags: the passage snapshot owns
 * membership, a tombstone removes only links (never passages), and replay
 * keeps `passageCount` exact without revising anything it does not claim.
 */
async function applySyncedThread(
  ctx: MutationContext,
  library: DocumentByName<DataModel, "libraries">,
  change: Extract<SyncedChange, { entityType: "thread" }>,
  current: DocumentByName<DataModel, "threads"> | null,
  now: number,
): Promise<void> {
  const libraryId = String(library.externalId);
  const entityId = syncedEntityId(change);
  if (change.operation === "tombstone") {
    let rowRevision: number | undefined;
    if (current && current.deletedAt === undefined) {
      rowRevision = Number(current.revision) + 1;
      await ctx.db.patch(current._id, { deletedAt: now, passageCount: 0, revision: rowRevision, updatedAt: now });
    }
    if (!(await removeContainerLinks(ctx, libraryId, "thread", entityId))) {
      await ctx.scheduler.runAfter(0, drainSyncedContainerLinksReference, { libraryId, entityType: "thread", containerId: entityId });
    }
    const revision = await recordSyncedTombstone(ctx, libraryId, "thread", entityId, entityId, rowRevision, now);
    await recordChanges(ctx, library, [{ entityType: "thread", entityId, revision }], now);
    return;
  }
  const name = organizationName(change.thread.name, "Thread", 120);
  const normalizedName = normalizeOrganizationName(name);
  const description = optionalText(change.thread.description, 1_000);
  let revision = 1;
  if (current) {
    revision = Number(current.revision) + 1;
    await ctx.db.patch(current._id, { name, normalizedName, description, deletedAt: undefined, revision, updatedAt: now });
  } else {
    await ctx.db.insert("threads", { libraryId, id: entityId, name, normalizedName, ...(description ? { description } : {}),
      passageCount: 0, revision, createdAt: validEpoch(change.thread.createdAt), updatedAt: now });
  }
  await clearSyncedTombstone(ctx, libraryId, "thread", entityId);
  await recordChanges(ctx, library, [{ entityType: "thread", entityId, revision }], now);
}

/**
 * One pick per (day, time zone). When two devices picked offline, the
 * earlier pick (then the lower ID) keeps the slot and the other is retired:
 * its row goes, a tombstone records it, and its writer claim becomes a
 * tombstone so pulls express the retirement.
 */
async function applySyncedDailySelection(
  ctx: MutationContext,
  library: DocumentByName<DataModel, "libraries">,
  change: Extract<SyncedChange, { entityType: "daily-selection" }>,
  current: DocumentByName<DataModel, "dailySelections"> | null,
  now: number,
): Promise<void> {
  const libraryId = String(library.externalId);
  const entityId = syncedEntityId(change);
  const retire = async (id: string, row: DocumentByName<DataModel, "dailySelections"> | null) => {
    if (row) await ctx.db.delete(row._id);
    const revision = await recordSyncedTombstone(ctx, libraryId, "daily-selection", id, id, row ? Number(row.revision) + 1 : undefined, now);
    const writer = await ctx.db.query("syncedWriters").withIndex("by_library_entity", (q) =>
      q.eq("libraryId", libraryId).eq("entityType", "daily-selection").eq("entityId", id)).unique();
    if (writer) await ctx.db.patch(writer._id, { operation: "tombstone", entityRevision: revision, appliedAt: now });
    await recordChanges(ctx, library, [{ entityType: "daily-selection", entityId: id, revision }], now);
  };
  if (change.operation === "tombstone") return retire(entityId, current);
  const pick = change.dailySelection;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(pick.localDay) || pick.timezone.trim().length < 1 || pick.timezone.length > 100 ||
      (pick.highlightId !== undefined && !isUuid(pick.highlightId)) || !/^[0-9a-f]{64}$/u.test(pick.candidateDigest) ||
      pick.recentHighlightIds.length > 7 || !pick.recentHighlightIds.every(isUuid)) {
    throw new Error("Synced daily selection is invalid");
  }
  const occupant = await ctx.db.query("dailySelections").withIndex("by_library_day_and_timezone", (q) =>
    q.eq("libraryId", libraryId).eq("localDay", pick.localDay).eq("timezone", pick.timezone)).unique();
  if (occupant && occupant.id !== entityId) {
    const occupantKey = { id: occupant.id, createdAt: occupant.createdAt ?? occupant.selectedAt };
    if (!dailySelectionWins({ id: entityId, createdAt: validEpoch(pick.createdAt) }, occupantKey)) return retire(entityId, current);
    await retire(occupant.id, occupant);
  }
  // The pick's passage may not exist here; keep the pick without it.
  const highlight = pick.highlightId ? await findHighlight(ctx, libraryId, pick.highlightId) : null;
  const fields = { ...(highlight ? { highlightId: pick.highlightId } : { highlightId: undefined }), candidateDigest: pick.candidateDigest,
    recentHighlightIds: [...pick.recentHighlightIds], selectedAt: validEpoch(pick.selectedAt), updatedAt: now };
  let revision = 1;
  if (current) {
    revision = Number(current.revision) + 1;
    await ctx.db.patch(current._id, { ...fields, revision });
  } else {
    await ctx.db.insert("dailySelections", { libraryId, id: entityId, localDay: pick.localDay, timezone: pick.timezone,
      ...fields, ...(highlight ? { highlightId: pick.highlightId } : {}), revision, createdAt: validEpoch(pick.createdAt) });
  }
  await clearSyncedTombstone(ctx, libraryId, "daily-selection", entityId);
  await recordChanges(ctx, library, [{ entityType: "daily-selection", entityId, revision }], now);
}

/** Make a passage's thread links exactly the desired active threads, keeping each kept link's added time. */
async function replaceSyncedThreadLinks(
  ctx: MutationContext,
  libraryId: string,
  highlightId: string,
  threadIds: readonly string[],
  now: number,
): Promise<void> {
  const desired = new Map<string, DocumentByName<DataModel, "threads">>();
  for (const id of threadIds) {
    const thread = await findThread(ctx, libraryId, id);
    if (thread && thread.deletedAt === undefined) {
      desired.set(id, thread);
      continue;
    }
    if (thread) continue;
    const tombstone = await ctx.db.query("syncTombstones").withIndex("by_library_entity", (q) =>
      q.eq("libraryId", libraryId).eq("entityType", "thread").eq("entityId", id)).unique();
    if (!tombstone) throw new Error("Synced organization container no longer exists");
  }
  const existing = await ctx.db.query("threadHighlights").withIndex("by_library_and_highlight", (q) =>
    q.eq("libraryId", libraryId).eq("highlightId", highlightId)).take(MAX_THREADS_PER_HIGHLIGHT + 1);
  if (existing.length > MAX_THREADS_PER_HIGHLIGHT) throw new Error("Synced passage belongs to too many threads");
  const present = new Set<string>();
  for (const link of existing) {
    if (desired.has(link.threadId) && !present.has(link.threadId)) {
      present.add(link.threadId);
      continue;
    }
    await ctx.db.delete(link._id);
    if (present.has(link.threadId)) continue;
    const thread = await findThread(ctx, libraryId, link.threadId);
    if (thread && thread.deletedAt === undefined) {
      await ctx.db.patch(thread._id, { passageCount: Math.max(0, Number(thread.passageCount) - 1), updatedAt: now });
    }
  }
  for (const [threadId, thread] of desired) {
    if (present.has(threadId)) continue;
    await ctx.db.insert("threadHighlights", { libraryId, threadId, highlightId, addedAt: now });
    const fresh = await ctx.db.get(thread._id);
    if (fresh) await ctx.db.patch(fresh._id, { passageCount: Number(fresh.passageCount) + 1, updatedAt: now });
  }
}

/** Returns true once no link to the container remains. */
async function removeContainerLinks(
  ctx: MutationContext,
  libraryId: string,
  entityType: "collection" | "tag" | "thread",
  containerId: string,
): Promise<boolean> {
  let budget = CONTAINER_LINK_DRAIN_BATCH;
  const tables = entityType === "collection" ? ["collectionBooks"] as const
    : entityType === "thread" ? ["threadHighlights"] as const : ["bookTags", "highlightTags"] as const;
  for (const table of tables) {
    const links = table === "threadHighlights"
      ? await ctx.db.query("threadHighlights").withIndex("by_library_and_thread", (q) =>
        q.eq("libraryId", libraryId).eq("threadId", containerId)).take(budget + 1)
      : table === "collectionBooks"
      ? await ctx.db.query("collectionBooks").withIndex("by_library_and_collection", (q) =>
        q.eq("libraryId", libraryId).eq("collectionId", containerId)).take(budget + 1)
      : table === "bookTags"
      ? await ctx.db.query("bookTags").withIndex("by_library_and_tag", (q) =>
        q.eq("libraryId", libraryId).eq("tagId", containerId)).take(budget + 1)
      : await ctx.db.query("highlightTags").withIndex("by_library_and_tag", (q) =>
        q.eq("libraryId", libraryId).eq("tagId", containerId)).take(budget + 1);
    const batch = links.slice(0, budget);
    for (const link of batch) await ctx.db.delete(link._id);
    if (links.length > batch.length) return false;
    budget -= batch.length;
  }
  return true;
}

/**
 * Resolve an incoming membership set. A container deleted here (or known only
 * by its tombstone) was removed after the owner was written elsewhere, so the
 * stale link is dropped; an unknown container means the history is out of order.
 */
async function activeSyncedContainers(
  ctx: MutationContext,
  libraryId: string,
  entityType: "collection" | "tag",
  ids: readonly string[],
): Promise<Array<DocumentByName<DataModel, "collections"> | DocumentByName<DataModel, "tags">>> {
  const active: Array<DocumentByName<DataModel, "collections"> | DocumentByName<DataModel, "tags">> = [];
  for (const id of ids) {
    const container = entityType === "collection" ? await findCollection(ctx, libraryId, id) : await findTag(ctx, libraryId, id);
    if (container && container.deletedAt === undefined) {
      active.push(container);
      continue;
    }
    if (container) continue;
    const tombstone = await ctx.db.query("syncTombstones").withIndex("by_library_entity", (q) =>
      q.eq("libraryId", libraryId).eq("entityType", entityType).eq("entityId", id)).unique();
    if (!tombstone) throw new Error("Synced organization container no longer exists");
  }
  return active;
}

/**
 * Make one owner's links exactly the desired active containers. Container
 * counters follow the links, but container revisions do not advance, because
 * the owner snapshot, not the container, is what carries membership.
 * Existing passage links keep their book projection; the caller moves them.
 */
async function replaceSyncedLinks(
  ctx: MutationContext,
  libraryId: string,
  kind: "collection" | "book-tag" | "highlight-tag",
  ownerId: string,
  bookId: string,
  desired: ReadonlyArray<DocumentByName<DataModel, "collections"> | DocumentByName<DataModel, "tags">>,
  now: number,
): Promise<void> {
  const existing: ReadonlyArray<{ readonly _id: GenericId<"collectionBooks" | "bookTags" | "highlightTags">; readonly containerId: string }> = kind === "collection"
    ? (await ctx.db.query("collectionBooks").withIndex("by_library_and_book", (q) =>
      q.eq("libraryId", libraryId).eq("bookId", ownerId)).take(MAX_SYNC_ORGANIZATION_MEMBERSHIPS + 1))
      .map((link) => ({ _id: link._id, containerId: link.collectionId }))
    : kind === "book-tag"
    ? (await ctx.db.query("bookTags").withIndex("by_library_and_book", (q) =>
      q.eq("libraryId", libraryId).eq("bookId", ownerId)).take(MAX_SYNC_ORGANIZATION_MEMBERSHIPS + 1))
      .map((link) => ({ _id: link._id, containerId: link.tagId }))
    : (await ctx.db.query("highlightTags").withIndex("by_library_and_highlight", (q) =>
      q.eq("libraryId", libraryId).eq("highlightId", ownerId)).take(MAX_SYNC_ORGANIZATION_MEMBERSHIPS + 1))
      .map((link) => ({ _id: link._id, containerId: link.tagId }));
  if (existing.length > MAX_SYNC_ORGANIZATION_MEMBERSHIPS) throw new Error("Synced organization exceeds its limit");
  const wanted = new Map(desired.map((container) => [String(container.id), container]));
  const present = new Set<string>();
  for (const link of existing) {
    if (wanted.has(link.containerId) && !present.has(link.containerId)) {
      present.add(link.containerId);
      continue;
    }
    await ctx.db.delete(link._id);
    if (present.has(link.containerId)) continue;
    const container = kind === "collection"
      ? await findCollection(ctx, libraryId, link.containerId)
      : await findTag(ctx, libraryId, link.containerId);
    if (container && container.deletedAt === undefined) await adjustContainerCount(ctx, kind, container, -1, now);
  }
  for (const [containerId, container] of wanted) {
    if (present.has(containerId)) continue;
    if (kind === "collection") await ctx.db.insert("collectionBooks", { libraryId, collectionId: containerId, bookId: ownerId, createdAt: now });
    else if (kind === "book-tag") await ctx.db.insert("bookTags", { libraryId, tagId: containerId, bookId: ownerId, createdAt: now });
    else await ctx.db.insert("highlightTags", { libraryId, tagId: containerId, bookId, highlightId: ownerId, createdAt: now });
    await adjustContainerCount(ctx, kind, container, 1, now);
  }
}

async function adjustContainerCount(
  ctx: MutationContext,
  kind: "collection" | "book-tag" | "highlight-tag",
  container: DocumentByName<DataModel, "collections"> | DocumentByName<DataModel, "tags">,
  delta: number,
  now: number,
): Promise<void> {
  const fresh = await ctx.db.get(container._id);
  if (!fresh || fresh.deletedAt !== undefined) return;
  if (kind === "highlight-tag" && "highlightCount" in fresh) {
    await ctx.db.patch(fresh._id, { highlightCount: Math.max(0, Number(fresh.highlightCount) + delta), updatedAt: now });
  } else {
    await ctx.db.patch(fresh._id, { bookCount: Math.max(0, Number(fresh.bookCount) + delta), updatedAt: now });
  }
}

export const createBook = internalMutation({
  args: createBookArgs,
  returns: bookValidator,
  handler: async (ctx, args) => {
    const id = requiredId(args.id);
    const title = requiredText(args.title, "Book title", Number.MAX_SAFE_INTEGER);
    const authors = (args.authors ?? []).map((author) => author.trim()).filter(Boolean);
    const isbn13 = args.isbn13 === undefined ? undefined : normalizeIsbn13(args.isbn13);
    if (args.isbn13 !== undefined && !isbn13) throw new Error("ISBN-13 is invalid");
    const [library, existing] = await Promise.all([requireLibrary(ctx, args.libraryId), findBook(ctx, args.libraryId, id)]);
    if (existing) {
      const replay = mapBook(existing);
      if (!sameCreateBook(replay, { id, title, authors, ...(isbn13 ? { isbn13 } : {}) })) {
        throw new Error("Entity ID already exists with different book data");
      }
      return replay;
    }
    const now = Date.now();
    // Details from a catalog lookup pass the same checks as a metadata edit.
    const details = [args.description, args.publisher, args.series, args.seriesNumber, args.language, args.coverUrl].some((value) => value !== undefined)
      ? normalizeBookMetadata({ ...args, title, authors })
      : undefined;
    await ctx.db.insert("books", {
      libraryId: args.libraryId,
      id,
      title,
      authors,
      ...(isbn13 ? { isbn13 } : {}),
      ...(details?.description ? { description: details.description } : {}),
      ...(details?.publisher ? { publisher: details.publisher } : {}),
      ...(details?.series ? { series: details.series } : {}),
      ...(details?.seriesNumber ? { seriesNumber: details.seriesNumber } : {}),
      ...(details?.language ? { language: details.language } : {}),
      ...(details?.coverUrl ? { coverUrl: details.coverUrl } : {}),
      status: "unread",
      archived: false,
      highlightCount: 0,
      noteCount: 0,
      readingDataBytes: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await recordWebChanges(ctx, library, [{ entityType: "book", entityId: id, revision: 1 }], now);
    if (details) {
      const created = await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", id)).unique();
      if (!created) throw new Error("Book no longer exists");
      return mapBook(created);
    }
    return { id, title, authors, ...(isbn13 ? { isbn13 } : {}), status: "unread" as const, archived: false, createdAt: now, updatedAt: now, revision: 1, highlightCount: 0 };
  },
});

export const updateBookMetadata = internalMutation({
  args: updateBookMetadataArgs,
  returns: bookValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Book");
    const metadata = normalizeBookMetadata(args);
    const [library, book] = await Promise.all([requireLibrary(ctx, args.libraryId), findBook(ctx, args.libraryId, args.id)]);
    if (!book || book.archived === true || book.deletedAt !== undefined || book.revision !== args.expectedRevision) {
      throw new Error("Book changed elsewhere or no longer exists");
    }
    if (metadata.isbn13) {
      const holders = await ctx.db.query("books").withIndex("by_library_and_isbn13", (q) => q.eq("libraryId", args.libraryId).eq("isbn13", metadata.isbn13)).take(2);
      if (holders.some((holder) => holder.id !== args.id && holder.deletedAt === undefined)) throw new Error("Another book already has that ISBN-13");
    }
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    await ctx.db.patch(book._id, {
      title: metadata.title,
      authors: [...metadata.authors],
      description: metadata.description,
      publisher: metadata.publisher,
      series: metadata.series,
      seriesNumber: metadata.seriesNumber,
      language: metadata.language,
      isbn13: metadata.isbn13,
      coverUrl: metadata.coverUrl,
      revision,
      updatedAt: now,
    });
    await recordWebChanges(ctx, library, [{ entityType: "book", entityId: args.id, revision }], now);
    const updated = await ctx.db.get(book._id);
    if (!updated) throw new Error("Book no longer exists");
    return mapBook(updated);
  },
});

export const createHighlight = internalMutation({
  args: internalCreateHighlightArgs,
  returns: highlightValidator,
  handler: async (ctx, args) => {
    const id = requiredId(args.id);
    const text = requiredText(args.text, "Highlight", 100_000);
    const sourceLocation = optionalText(args.sourceLocation, 2_000);
    const noteMarkdown = args.noteMarkdown === undefined ? undefined : requiredNote(args.noteMarkdown);
    const noteId = args.noteId === undefined ? undefined : requiredId(args.noteId);
    if (Boolean(noteMarkdown) !== Boolean(noteId)) throw new Error("Atomic passage note details are incomplete");
    const [library, book] = await Promise.all([requireLibrary(ctx, args.libraryId), findBook(ctx, args.libraryId, args.bookId)]);
    if (!book || book.archived === true || book.deletedAt !== undefined) throw new Error("Book no longer exists");
    await requireUnusedHighlightId(ctx, args.libraryId, id);
    const now = Date.now();
    await ctx.db.insert("highlights", {
      libraryId: args.libraryId, id, bookId: args.bookId, text,
      ...(sourceLocation ? { sourceLocation } : {}),
      ...(args.sourceCreatedAt !== undefined && Number.isSafeInteger(args.sourceCreatedAt) && args.sourceCreatedAt >= 0 ? { sourceCreatedAt: args.sourceCreatedAt } : {}),
      dailyCandidateReady: true,
      archived: false, revision: 1, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("dailyCandidates", {
      libraryId: args.libraryId, highlightId: id, bookId: args.bookId, bookActive: true,
    });
    if (noteMarkdown && noteId) {
      await requireUnusedNoteId(ctx, args.libraryId, noteId);
      await ctx.db.insert("notes", {
        libraryId: args.libraryId,
        id: noteId,
        bookId: args.bookId,
        highlightId: id,
        markdown: noteMarkdown,
        origin: args.noteOrigin ?? "reader",
        attachmentBoundsReady: true,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    const bookRevision = Number(book.revision) + 1;
    await ctx.db.patch(book._id, {
      highlightCount: book.highlightCount + 1,
      noteCount: book.noteCount + (noteMarkdown ? 1 : 0),
      readingDataBytes: book.readingDataBytes + annotationBytes(text, sourceLocation) + (noteMarkdown ? annotationBytes(noteMarkdown) : 0),
      revision: bookRevision,
      updatedAt: now,
    });
    await recordWebChanges(ctx, library, [
      { entityType: "book", entityId: args.bookId, revision: bookRevision },
      { entityType: "highlight", entityId: id, revision: 1 },
      ...(noteId ? [{ entityType: "note" as const, entityId: noteId, revision: 1 }] : []),
    ], now);
    return { id, bookId: args.bookId, text, ...(sourceLocation ? { sourceLocation } : {}), createdAt: now, updatedAt: now, revision: 1 };
  },
});

export const updateHighlight = internalMutation({
  args: updateHighlightArgs,
  returns: highlightValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Highlight");
    const text = requiredText(args.text, "Highlight", 100_000);
    const sourceLocation = optionalText(args.sourceLocation, 2_000);
    const [library, book, highlight] = await Promise.all([
      requireLibrary(ctx, args.libraryId), findBook(ctx, args.libraryId, args.bookId), findHighlight(ctx, args.libraryId, args.id),
    ]);
    if (!book || book.archived === true || book.deletedAt !== undefined || !highlight || highlight.bookId !== args.bookId || highlight.archived === true || highlight.deletedAt !== undefined || highlight.revision !== args.expectedRevision) {
      throw new Error("Highlight changed elsewhere or no longer exists");
    }
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    const bookRevision = Number(book.revision) + 1;
    await ctx.db.patch(highlight._id, { text, sourceLocation, revision, updatedAt: now });
    await ctx.db.patch(book._id, {
      readingDataBytes: book.readingDataBytes - annotationBytes(String(highlight.text), optionalStoredText(highlight.sourceLocation)) + annotationBytes(text, sourceLocation),
      revision: bookRevision,
      updatedAt: now,
    });
    await recordWebChanges(ctx, library, [
      { entityType: "book", entityId: args.bookId, revision: bookRevision },
      { entityType: "highlight", entityId: args.id, revision },
    ], now);
    return { id: args.id, bookId: args.bookId, text, ...(sourceLocation ? { sourceLocation } : {}), ...(highlight.sourceCreatedAt !== undefined ? { sourceCreatedAt: Number(highlight.sourceCreatedAt) } : {}), createdAt: Number(highlight.createdAt), updatedAt: now, revision };
  },
});

export const createNote = internalMutation({
  args: internalCreateNoteArgs,
  returns: noteValidator,
  handler: async (ctx, args) => {
    const id = requiredId(args.id);
    const markdown = requiredNote(args.markdown);
    const [library, book, highlight] = await Promise.all([
      requireLibrary(ctx, args.libraryId), findBook(ctx, args.libraryId, args.bookId),
      args.highlightId ? findHighlight(ctx, args.libraryId, args.highlightId) : undefined,
    ]);
    if (!book || book.archived === true || book.deletedAt !== undefined || (args.highlightId && (!highlight || highlight.bookId !== args.bookId || highlight.archived === true || highlight.deletedAt !== undefined))) {
      throw new Error("Book or highlight no longer exists");
    }
    if (args.highlightId) {
      const activeNotes = await ctx.db.query("notes")
        .withIndex("by_library_highlight_and_deleted", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", args.highlightId).eq("deletedAt", undefined))
        .take(MAX_NOTES_PER_HIGHLIGHT);
      if (activeNotes.length >= MAX_NOTES_PER_HIGHLIGHT) {
        throw new Error(`A passage can have at most ${MAX_NOTES_PER_HIGHLIGHT} active notes`);
      }
    }
    await requireUnusedNoteId(ctx, args.libraryId, id);
    const now = Date.now();
    const origin = args.origin ?? "reader";
    await ctx.db.insert("notes", { libraryId: args.libraryId, id, bookId: args.bookId, ...(args.highlightId ? { highlightId: args.highlightId } : {}), markdown, origin, attachmentBoundsReady: true, revision: 1, createdAt: now, updatedAt: now });
    const bookRevision = Number(book.revision) + 1;
    await ctx.db.patch(book._id, {
      noteCount: book.noteCount + 1,
      readingDataBytes: book.readingDataBytes + annotationBytes(markdown),
      revision: bookRevision,
      updatedAt: now,
    });
    await recordWebChanges(ctx, library, [
      { entityType: "book", entityId: args.bookId, revision: bookRevision },
      { entityType: "note", entityId: id, revision: 1 },
    ], now);
    return { id, bookId: args.bookId, ...(args.highlightId ? { highlightId: args.highlightId } : {}), markdown, origin, createdAt: now, updatedAt: now, revision: 1 };
  },
});

export const updateNote = internalMutation({
  args: updateNoteArgs,
  returns: noteValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Note");
    const markdown = requiredNote(args.markdown);
    const [library, book, note] = await Promise.all([
      requireLibrary(ctx, args.libraryId), findBook(ctx, args.libraryId, args.bookId), findNote(ctx, args.libraryId, args.id),
    ]);
    if (!book || book.archived === true || book.deletedAt !== undefined || !note || note.bookId !== args.bookId || note.deletedAt !== undefined || note.revision !== args.expectedRevision) {
      throw new Error("Note changed elsewhere or no longer exists");
    }
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    const bookRevision = Number(book.revision) + 1;
    await ctx.db.patch(note._id, { markdown, origin: "reader", revision, updatedAt: now });
    await ctx.db.patch(book._id, {
      readingDataBytes: book.readingDataBytes - annotationBytes(String(note.markdown)) + annotationBytes(markdown),
      revision: bookRevision,
      updatedAt: now,
    });
    await recordWebChanges(ctx, library, [
      { entityType: "book", entityId: args.bookId, revision: bookRevision },
      { entityType: "note", entityId: args.id, revision },
    ], now);
    return { id: args.id, bookId: args.bookId, ...(note.highlightId ? { highlightId: String(note.highlightId) } : {}), markdown, origin: "reader" as const, createdAt: Number(note.createdAt), updatedAt: now, revision };
  },
});

export const deleteHighlight = internalMutation({
  args: deleteAnnotationArgs,
  returns: annotationDeletionValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Highlight");
    const [library, book, highlight] = await Promise.all([
      requireLibrary(ctx, args.libraryId), findBook(ctx, args.libraryId, args.bookId), findHighlight(ctx, args.libraryId, args.id),
    ]);
    if (!book || book.archived === true || book.deletedAt !== undefined || !highlight || highlight.bookId !== args.bookId || highlight.archived === true || highlight.revision !== args.expectedRevision) {
      throw new Error("Highlight changed elsewhere or no longer exists");
    }
    // A passage already tombstoned by an earlier batch is being drained, not
    // deleted twice: its own text was counted once, and the book has already
    // lost it from the passage count.
    const continuing = highlight.deletedAt !== undefined;
    const [notes, threadRows, tagRows, candidates] = await Promise.all([
      ctx.db.query("notes").withIndex("by_library_highlight_and_deleted", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", args.id).eq("deletedAt", undefined)).take(NOTE_DELETION_BATCH + 1),
      ctx.db.query("threadHighlights").withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", args.id)).take(21),
      ctx.db.query("highlightTags").withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", args.id)).take(MAX_ATOMIC_ORGANIZATION_MEMBERSHIPS + 1),
      ctx.db.query("dailyCandidates").withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", args.id)).collect(),
    ]);
    // A passage with nothing left to drain is simply gone. Repeating the
    // deletion then has to be refused as it always was, or a caller that keeps
    // asking would churn a new revision and a new sync change every time.
    if (continuing && notes.length === 0) throw new Error("Highlight changed elsewhere or no longer exists");
    // A passage that predates the bounds is drained a batch at a time rather
    // than refused: it leaves the reader's view on the first call, and the
    // caller repeats the deletion until the receipt is complete. Always take at
    // least one note, so a single oversized legacy note cannot stall the drain.
    const batch: typeof notes = [];
    let batchBytes = 0;
    for (const note of notes.slice(0, NOTE_DELETION_BATCH)) {
      const size = new TextEncoder().encode(String(note.markdown)).byteLength;
      if (batch.length > 0 && batchBytes + size > NOTE_DELETION_BYTE_BUDGET) break;
      batch.push(note);
      batchBytes += size;
    }
    const complete = batch.length === notes.length;
    if (threadRows.length > 20 || tagRows.length > MAX_ATOMIC_ORGANIZATION_MEMBERSHIPS) {
      throw new Error("This passage has too many labels to delete in one step");
    }
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    const changes: Change[] = [];
    let removedBytes = continuing ? 0 : annotationBytes(String(highlight.text), optionalStoredText(highlight.sourceLocation));
    let notesDeleted = 0;
    await ctx.db.patch(highlight._id, { deletedAt: now, revision, updatedAt: now });
    for (const note of batch) {
      const noteRevision = Number(note.revision) + 1;
      await ctx.db.patch(note._id, { deletedAt: now, revision: noteRevision, updatedAt: now });
      removedBytes += annotationBytes(String(note.markdown));
      notesDeleted += 1;
      changes.push({ entityType: "note", entityId: String(note.id), revision: noteRevision });
    }
    // Memberships go with the passage, and every container whose contents
    // changed advances, exactly as an explicit removal would.
    const [threads, tags] = await Promise.all([
      Promise.all(threadRows.map((row) => ctx.db.query("threads").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", row.threadId)).unique())),
      Promise.all(tagRows.map((row) => ctx.db.query("tags").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", row.tagId)).unique())),
    ]);
    for (const [index, row] of threadRows.entries()) {
      await ctx.db.delete(row._id);
      const thread = threads[index];
      if (!thread || thread.deletedAt !== undefined) continue;
      const threadRevision = Number(thread.revision) + 1;
      await ctx.db.patch(thread._id, { passageCount: Math.max(0, thread.passageCount - 1), revision: threadRevision, updatedAt: now });
      changes.push({ entityType: "thread", entityId: String(thread.id), revision: threadRevision });
    }
    for (const [index, row] of tagRows.entries()) {
      await ctx.db.delete(row._id);
      const tag = tags[index];
      if (!tag || tag.deletedAt !== undefined) continue;
      const tagRevision = Number(tag.revision) + 1;
      await ctx.db.patch(tag._id, { highlightCount: Math.max(0, tag.highlightCount - 1), revision: tagRevision, updatedAt: now });
      changes.push({ entityType: "tag", entityId: String(tag.id), revision: tagRevision });
    }
    for (const candidate of candidates) await ctx.db.delete(candidate._id);
    const bookRevision = Number(book.revision) + 1;
    await ctx.db.patch(book._id, {
      highlightCount: continuing ? book.highlightCount : Math.max(0, book.highlightCount - 1),
      noteCount: Math.max(0, book.noteCount - notesDeleted),
      readingDataBytes: Math.max(0, book.readingDataBytes - removedBytes),
      revision: bookRevision,
      updatedAt: now,
    });
    await recordWebChanges(ctx, library, [
      { entityType: "book", entityId: args.bookId, revision: bookRevision },
      { entityType: "highlight", entityId: args.id, revision },
      ...changes,
    ], now);
    return { bookId: args.bookId, bookRevision, revision, notesDeleted, complete };
  },
});

export const deleteNote = internalMutation({
  args: deleteAnnotationArgs,
  returns: annotationDeletionValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Note");
    const [library, book, note] = await Promise.all([
      requireLibrary(ctx, args.libraryId), findBook(ctx, args.libraryId, args.bookId), findNote(ctx, args.libraryId, args.id),
    ]);
    if (!book || book.archived === true || book.deletedAt !== undefined || !note || note.bookId !== args.bookId || note.deletedAt !== undefined || note.revision !== args.expectedRevision) {
      throw new Error("Note changed elsewhere or no longer exists");
    }
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    const bookRevision = Number(book.revision) + 1;
    await ctx.db.patch(note._id, { deletedAt: now, revision, updatedAt: now });
    await ctx.db.patch(book._id, {
      noteCount: Math.max(0, book.noteCount - 1),
      readingDataBytes: Math.max(0, book.readingDataBytes - annotationBytes(String(note.markdown))),
      revision: bookRevision,
      updatedAt: now,
    });
    await recordWebChanges(ctx, library, [
      { entityType: "book", entityId: args.bookId, revision: bookRevision },
      { entityType: "note", entityId: args.id, revision },
    ], now);
    return { bookId: args.bookId, bookRevision, revision, notesDeleted: 1, complete: true };
  },
});

export const setBookArchived = internalMutation({
  args: setBookArchivedArgs,
  returns: archiveValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Book");
    const [library, book, dailyCandidates] = await Promise.all([
      requireLibrary(ctx, args.libraryId),
      findBook(ctx, args.libraryId, args.id),
      ctx.db.query("dailyCandidates")
        .withIndex("by_library_and_book", (q) => q.eq("libraryId", args.libraryId).eq("bookId", args.id))
        .take(MAX_ATOMIC_DAILY_CANDIDATES + 1),
    ]);
    if (!book || book.deletedAt !== undefined || book.revision !== args.expectedRevision || book.archived === args.archived) {
      throw new Error("Book changed elsewhere or is already in that shelf");
    }
    if (dailyCandidates.length > MAX_ATOMIC_DAILY_CANDIDATES) {
      throw new Error("Book contains too many daily candidates for a safe Convex archive change");
    }
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    await ctx.db.patch(book._id, { archived: args.archived, revision, updatedAt: now });
    for (const candidate of dailyCandidates) await ctx.db.patch(candidate._id, { bookActive: !args.archived });
    await recordWebChanges(ctx, library, [{ entityType: "book", entityId: args.id, revision }], now);
    return { bookId: args.id, archived: args.archived, revision, updatedAt: now };
  },
});

export const setBookReadingStatus = internalMutation({
  args: setBookReadingStatusArgs,
  returns: readingStatusChangeValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Book");
    const [library, book] = await Promise.all([
      requireLibrary(ctx, args.libraryId),
      findBook(ctx, args.libraryId, args.id),
    ]);
    if (!book || book.archived === true || book.deletedAt !== undefined || book.revision !== args.expectedRevision) {
      throw new Error("Book changed elsewhere or no longer exists");
    }
    if (book.status === args.status) return { changed: false, book: mapBook(book) };
    const history = await ctx.db.query("readingStatusEvents").withIndex("by_library_and_book_and_sequence", (q) =>
      q.eq("libraryId", args.libraryId).eq("bookId", args.id)).take(MAX_STATUS_EVENTS_PER_BOOK);
    if (history.length >= MAX_STATUS_EVENTS_PER_BOOK) {
      throw new Error(`A book can keep at most ${MAX_STATUS_EVENTS_PER_BOOK} reading-status changes`);
    }

    const changedAt = Date.now();
    const completedOn = args.status === "finished"
      ? new Date(changedAt).toISOString().slice(0, 10)
      : undefined;
    const revision = args.expectedRevision + 1;
    const event = {
      id: crypto.randomUUID(),
      bookId: args.id,
      status: args.status,
      source: "reader" as const,
      changedAt,
      ...(completedOn ? { completedOn } : {}),
      bookRevision: revision,
    };
    await ctx.db.patch(book._id, {
      status: args.status,
      completedOn,
      revision,
      updatedAt: changedAt,
    });
    await ctx.db.insert("readingStatusEvents", {
      libraryId: args.libraryId,
      sequence: Number(library.nextChangeSequence) + 1,
      ...event,
    });
    await recordWebChanges(ctx, library, [{ entityType: "book", entityId: args.id, revision }], changedAt);
    return {
      changed: true,
      book: mapBook({ ...book, status: args.status, completedOn, revision, updatedAt: changedAt }),
      event,
    };
  },
});

export const setBookCompletionDate = internalMutation({
  args: setBookCompletionDateArgs,
  returns: bookValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Book");
    const completedOn = validateCompletionDate(args.completedOn);
    const [library, book] = await Promise.all([
      requireLibrary(ctx, args.libraryId),
      findBook(ctx, args.libraryId, args.id),
    ]);
    if (!book || book.archived === true || book.deletedAt !== undefined || book.revision !== args.expectedRevision) {
      throw new Error("Book changed elsewhere or no longer exists");
    }
    if (book.status !== "finished") throw new Error("Set the book to Finished before adding a completion date");
    if (book.completedOn === completedOn) return mapBook(book);
    const updatedAt = Date.now();
    const revision = args.expectedRevision + 1;
    await ctx.db.patch(book._id, { completedOn, revision, updatedAt });
    await recordWebChanges(ctx, library, [{ entityType: "book", entityId: args.id, revision }], updatedAt);
    return mapBook({ ...book, completedOn, revision, updatedAt });
  },
});

export const mergeBooks = internalMutation({
  args: mergeBooksArgs,
  returns: mergeValidator,
  handler: async (ctx, args) => {
    if (args.sourceBookId === args.targetBookId) throw new Error("Choose two different books");
    requireRevision(args.expectedSourceRevision, "Source book");
    requireRevision(args.expectedTargetRevision, "Target book");
    const pendingProjection = await ctx.db.query("highlightProjectionBlocks")
      .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId)).first();
    if (pendingProjection) throw new Error("Repair the highlight membership projection before merging books");
    const [library, source, target] = await Promise.all([
      requireLibrary(ctx, args.libraryId),
      findBook(ctx, args.libraryId, args.sourceBookId),
      findBook(ctx, args.libraryId, args.targetBookId),
    ]);
    if (!target || target.archived === true || target.deletedAt !== undefined || target.revision !== args.expectedTargetRevision) throw new Error("Target book changed or no longer exists");
    if (!source || source.archived === true || source.deletedAt !== undefined || source.revision !== args.expectedSourceRevision) throw new Error("Source book changed or no longer exists");
    if (source.highlightCount + source.noteCount > MAX_ATOMIC_MERGE_ITEMS || source.readingDataBytes > MAX_ATOMIC_MERGE_BYTES) {
      throw new Error("Book merge exceeds the safe Convex transaction limit");
    }
    const legacyHighlightTag = await ctx.db.query("highlightTags")
      .withIndex("by_library_and_book", (q) => q.eq("libraryId", args.libraryId).eq("bookId", undefined))
      .first();
    if (legacyHighlightTag) throw new Error("Run the highlight-tag book migration before merging books");
    const highlights = await ctx.db.query("highlights").withIndex("by_library_and_book", (q) => q.eq("libraryId", args.libraryId).eq("bookId", args.sourceBookId)).collect();
    const notes = await ctx.db.query("notes").withIndex("by_library_and_book", (q) => q.eq("libraryId", args.libraryId).eq("bookId", args.sourceBookId)).collect();
    const [collectionLinks, tagLinks, highlightTagLinks, statusEvents, targetStatusEvent] = await Promise.all([
      ctx.db.query("collectionBooks").withIndex("by_library_and_book", (q) => q.eq("libraryId", args.libraryId).eq("bookId", args.sourceBookId)).take(MAX_ATOMIC_ORGANIZATION_MEMBERSHIPS + 1),
      ctx.db.query("bookTags").withIndex("by_library_and_book", (q) => q.eq("libraryId", args.libraryId).eq("bookId", args.sourceBookId)).take(MAX_ATOMIC_ORGANIZATION_MEMBERSHIPS + 1),
      ctx.db.query("highlightTags").withIndex("by_library_and_book", (q) => q.eq("libraryId", args.libraryId).eq("bookId", args.sourceBookId)).take(MAX_ATOMIC_ORGANIZATION_MEMBERSHIPS + 1),
      ctx.db.query("readingStatusEvents").withIndex("by_library_and_book_and_sequence", (q) => q.eq("libraryId", args.libraryId).eq("bookId", args.sourceBookId)).take(MAX_ATOMIC_STATUS_EVENTS + 1),
      ctx.db.query("readingStatusEvents").withIndex("by_library_and_book_and_sequence", (q) => q.eq("libraryId", args.libraryId).eq("bookId", args.targetBookId)).first(),
    ]);
    if (collectionLinks.length + tagLinks.length + highlightTagLinks.length > MAX_ATOMIC_ORGANIZATION_MEMBERSHIPS) {
      throw new Error("Book merge exceeds the safe Convex organization limit");
    }
    if (statusEvents.length > MAX_ATOMIC_STATUS_EVENTS) {
      throw new Error("Book merge exceeds the safe Convex status-history limit");
    }
    const targetHistory = await ctx.db.query("readingStatusEvents").withIndex("by_library_and_book_and_sequence", (q) =>
      q.eq("libraryId", args.libraryId).eq("bookId", args.targetBookId)).take(MAX_STATUS_EVENTS_PER_BOOK);
    if (targetHistory.length + statusEvents.length + 1 > MAX_STATUS_EVENTS_PER_BOOK) {
      throw new Error(`A merged book can keep at most ${MAX_STATUS_EVENTS_PER_BOOK} reading-status changes`);
    }
    const estimatedOperations = source.highlightCount * 4 + source.noteCount * 2 +
      (collectionLinks.length + tagLinks.length) * 6 + highlightTagLinks.length + statusEvents.length;
    if (estimatedOperations > MAX_ESTIMATED_MERGE_IO_OPERATIONS) {
      throw new Error("Book merge exceeds the safe Convex operation budget");
    }
    const now = Date.now();
    const sourceRevision = args.expectedSourceRevision + 1;
    const targetRevision = args.expectedTargetRevision + 1;
    await ctx.db.patch(source._id, { archived: true, highlightCount: 0, noteCount: 0, readingDataBytes: 0, revision: sourceRevision, updatedAt: now });
    await ctx.db.patch(target._id, {
      highlightCount: target.highlightCount + source.highlightCount,
      noteCount: target.noteCount + source.noteCount,
      readingDataBytes: target.readingDataBytes + source.readingDataBytes,
      revision: targetRevision,
      updatedAt: now,
    });
    const changes: Change[] = [
      { entityType: "book", entityId: args.targetBookId, revision: targetRevision },
      { entityType: "book", entityId: args.sourceBookId, revision: sourceRevision },
    ];
    for (const highlight of highlights) {
      const revision = Number(highlight.revision) + 1;
      await ctx.db.patch(highlight._id, { bookId: args.targetBookId, revision, updatedAt: now });
      const dailyCandidate = await ctx.db.query("dailyCandidates")
        .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", highlight.id))
        .unique();
      if (dailyCandidate) await ctx.db.patch(dailyCandidate._id, { bookId: args.targetBookId, bookActive: true });
      changes.push({ entityType: "highlight", entityId: String(highlight.id), revision });
    }
    for (const note of notes) {
      const revision = Number(note.revision) + 1;
      await ctx.db.patch(note._id, { bookId: args.targetBookId, revision, updatedAt: now });
      changes.push({ entityType: "note", entityId: String(note.id), revision });
    }
    for (const event of statusEvents) await ctx.db.patch(event._id, { bookId: args.targetBookId });
    if (statusEvents.length > 0 || targetStatusEvent) {
      await ctx.db.insert("readingStatusEvents", {
        libraryId: args.libraryId,
        id: crypto.randomUUID(),
        bookId: args.targetBookId,
        sequence: Number(library.nextChangeSequence) + 1,
        status: target.status,
        source: "merge",
        changedAt: now,
        ...(target.completedOn ? { completedOn: target.completedOn } : {}),
        bookRevision: targetRevision,
      });
    }
    for (const link of collectionLinks) {
      const duplicate = await ctx.db.query("collectionBooks").withIndex("by_library_collection_and_book", (q) => q.eq("libraryId", args.libraryId).eq("collectionId", link.collectionId).eq("bookId", args.targetBookId)).unique();
      if (!duplicate) await ctx.db.insert("collectionBooks", { libraryId: args.libraryId, collectionId: link.collectionId, bookId: args.targetBookId, createdAt: link.createdAt });
      await ctx.db.delete(link._id);
      const collection = await ctx.db.query("collections").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", link.collectionId)).unique();
      if (collection && collection.deletedAt === undefined) {
        const revision = collection.revision + 1;
        await ctx.db.patch(collection._id, { bookCount: collection.bookCount - (duplicate ? 1 : 0), revision, updatedAt: now });
        changes.push({ entityType: "collection", entityId: collection.id, revision });
      }
    }
    for (const link of tagLinks) {
      const duplicate = await ctx.db.query("bookTags").withIndex("by_library_tag_and_book", (q) => q.eq("libraryId", args.libraryId).eq("tagId", link.tagId).eq("bookId", args.targetBookId)).unique();
      if (!duplicate) await ctx.db.insert("bookTags", { libraryId: args.libraryId, tagId: link.tagId, bookId: args.targetBookId, createdAt: link.createdAt });
      await ctx.db.delete(link._id);
      const tag = await ctx.db.query("tags").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", link.tagId)).unique();
      if (tag && tag.deletedAt === undefined) {
        const revision = tag.revision + 1;
        await ctx.db.patch(tag._id, { bookCount: tag.bookCount - (duplicate ? 1 : 0), revision, updatedAt: now });
        changes.push({ entityType: "tag", entityId: tag.id, revision });
      }
    }
    for (const link of highlightTagLinks) await ctx.db.patch(link._id, { bookId: args.targetBookId });
    await recordWebChanges(ctx, library, changes, now);
    return { sourceBookId: args.sourceBookId, targetBookId: args.targetBookId, highlightsMoved: highlights.length, notesMoved: notes.length, sourceRevision, targetRevision };
  },
});

async function applySyncedHighlight(
  ctx: MutationContext,
  library: DocumentByName<DataModel, "libraries">,
  change: Extract<SyncedChange, { entityType: "highlight" }>,
  current: DocumentByName<DataModel, "highlights"> | null,
  now: number,
): Promise<SyncedChangeOutcome> {
  const entityId = syncedEntityId(change);
  const suppliedBookId = change.operation === "upsert" ? change.highlight.bookId : change.bookId;
  const actualBookId = current ? String(current.bookId) : suppliedBookId;
  let revision: number;
  let oldBytes = 0;
  let newBytes = 0;
  const wasActive = Boolean(current && current.deletedAt === undefined);
  if (change.operation === "upsert") {
    const tags = await activeSyncedContainers(ctx, String(library.externalId), "tag", change.tagIds);
    await replaceSyncedLinks(ctx, String(library.externalId), "highlight-tag", entityId, suppliedBookId, tags, now);
    // Contract 23's validator requires threadIds; the shared type allows older providers.
    await replaceSyncedThreadLinks(ctx, String(library.externalId), entityId, change.threadIds ?? [], now);
  }
  const membershipChanges = await reconcileSyncedHighlightMemberships(ctx, String(library.externalId), entityId,
    change.operation, actualBookId, suppliedBookId, now);
  if (change.operation === "tombstone") {
    if (current && wasActive) {
      revision = Number(current.revision) + 1;
      oldBytes = annotationBytes(String(current.text), optionalStoredText(current.sourceLocation));
      await ctx.db.patch(current._id, { deletedAt: now, revision, updatedAt: now });
    }
    const candidates = await ctx.db.query("dailyCandidates").withIndex("by_library_and_highlight", (q) =>
      q.eq("libraryId", String(library.externalId)).eq("highlightId", entityId)).take(2);
    if (candidates.length > 1) throw new Error("Synced highlight has duplicate daily candidates");
    if (candidates[0]) await ctx.db.delete(candidates[0]._id);
    revision = await recordSyncedTombstone(ctx, String(library.externalId), "highlight", entityId, actualBookId,
      current && wasActive ? Number(current.revision) + 1 : undefined, now);
  } else {
    const book = await findBook(ctx, String(library.externalId), suppliedBookId);
    if (!book || book.deletedAt !== undefined) throw new Error("Synced highlight's book no longer exists");
    const text = requiredText(change.highlight.text, "Highlight", 100_000);
    const sourceLocation = optionalText(change.highlight.sourceLocation, 2_000);
    validEpoch(change.highlight.sourceCreatedAt, true);
    const createdAt = validEpoch(change.highlight.createdAt);
    revision = current ? Number(current.revision) + 1 : 1;
    newBytes = annotationBytes(text, sourceLocation);
    if (wasActive) oldBytes = annotationBytes(String(current?.text), optionalStoredText(current?.sourceLocation));
    if (current) {
      await ctx.db.patch(current._id, { bookId: suppliedBookId, text, sourceLocation,
        sourceCreatedAt: change.highlight.sourceCreatedAt, archived: false, deletedAt: undefined, revision, updatedAt: now });
    } else {
      await ctx.db.insert("highlights", { libraryId: String(library.externalId), id: entityId, bookId: suppliedBookId,
        text, ...(sourceLocation ? { sourceLocation } : {}),
        ...(change.highlight.sourceCreatedAt !== undefined ? { sourceCreatedAt: change.highlight.sourceCreatedAt } : {}),
        dailyCandidateReady: true, archived: false, revision, createdAt, updatedAt: now });
    }
    const candidates = await ctx.db.query("dailyCandidates").withIndex("by_library_and_highlight", (q) =>
      q.eq("libraryId", String(library.externalId)).eq("highlightId", entityId)).take(2);
    if (candidates.length > 1) throw new Error("Synced highlight has duplicate daily candidates");
    if (candidates[0]) await ctx.db.patch(candidates[0]._id, { bookId: suppliedBookId, bookActive: !book.archived });
    else await ctx.db.insert("dailyCandidates", { libraryId: String(library.externalId), highlightId: entityId, bookId: suppliedBookId, bookActive: !book.archived });
    await clearSyncedTombstone(ctx, String(library.externalId), "highlight", entityId);
  }
  await adjustSyncedBooks(ctx, String(library.externalId), now, [
    ...(wasActive ? [{ bookId: actualBookId, highlightDelta: -1, noteDelta: 0, byteDelta: -oldBytes }] : []),
    ...(change.operation === "upsert" ? [{ bookId: suppliedBookId, highlightDelta: 1, noteDelta: 0, byteDelta: newBytes }] :
      (!wasActive ? [{ bookId: suppliedBookId, highlightDelta: 0, noteDelta: 0, byteDelta: 0 }] : [])),
  ]);
  await recordChanges(ctx, library, [{ entityType: "highlight", entityId, revision }, ...membershipChanges], now);
  return "applied";
}

async function applySyncedNote(
  ctx: MutationContext,
  library: DocumentByName<DataModel, "libraries">,
  change: Extract<SyncedChange, { entityType: "note" }>,
  current: DocumentByName<DataModel, "notes"> | null,
  now: number,
): Promise<SyncedChangeOutcome> {
  const entityId = syncedEntityId(change);
  const suppliedBookId = change.operation === "upsert" ? change.note.bookId : change.bookId;
  const actualBookId = current ? String(current.bookId) : suppliedBookId;
  const wasActive = Boolean(current && current.deletedAt === undefined);
  let revision: number;
  let oldBytes = 0;
  let newBytes = 0;
  if (change.operation === "tombstone") {
    if (current && wasActive) {
      revision = Number(current.revision) + 1;
      oldBytes = annotationBytes(String(current.markdown));
      await ctx.db.patch(current._id, { deletedAt: now, revision, updatedAt: now });
    }
    revision = await recordSyncedTombstone(ctx, String(library.externalId), "note", entityId, actualBookId,
      current && wasActive ? Number(current.revision) + 1 : undefined, now);
  } else {
    const book = await findBook(ctx, String(library.externalId), suppliedBookId);
    const highlight = change.note.highlightId
      ? await findHighlight(ctx, String(library.externalId), change.note.highlightId) : undefined;
    if (!book || book.deletedAt !== undefined || (change.note.highlightId &&
        (!highlight || highlight.deletedAt !== undefined || highlight.bookId !== suppliedBookId))) {
      throw new Error("Synced note's book or highlight no longer exists");
    }
    if (change.note.highlightId && !(wasActive && current?.highlightId === change.note.highlightId)) {
      const active = await ctx.db.query("notes").withIndex("by_library_highlight_and_deleted", (q) =>
        q.eq("libraryId", String(library.externalId)).eq("highlightId", change.note.highlightId).eq("deletedAt", undefined))
        .take(MAX_NOTES_PER_HIGHLIGHT);
      if (active.length >= MAX_NOTES_PER_HIGHLIGHT) throw new Error(`A passage can have at most ${MAX_NOTES_PER_HIGHLIGHT} active notes`);
    }
    const markdown = requiredNote(change.note.markdown);
    validEpoch(change.note.createdAt);
    revision = current ? Number(current.revision) + 1 : 1;
    newBytes = annotationBytes(markdown);
    if (wasActive) oldBytes = annotationBytes(String(current?.markdown));
    if (current) {
      await ctx.db.patch(current._id, { bookId: suppliedBookId, highlightId: change.note.highlightId,
        markdown, origin: change.note.origin, attachmentBoundsReady: true, deletedAt: undefined, revision, updatedAt: now });
    } else {
      await ctx.db.insert("notes", { libraryId: String(library.externalId), id: entityId, bookId: suppliedBookId,
        ...(change.note.highlightId ? { highlightId: change.note.highlightId } : {}), markdown, origin: change.note.origin,
        attachmentBoundsReady: true, revision, createdAt: validEpoch(change.note.createdAt), updatedAt: now });
    }
    await clearSyncedTombstone(ctx, String(library.externalId), "note", entityId);
  }
  await adjustSyncedBooks(ctx, String(library.externalId), now, [
    ...(wasActive ? [{ bookId: actualBookId, highlightDelta: 0, noteDelta: -1, byteDelta: -oldBytes }] : []),
    ...(change.operation === "upsert" ? [{ bookId: suppliedBookId, highlightDelta: 0, noteDelta: 1, byteDelta: newBytes }] :
      (!wasActive ? [{ bookId: suppliedBookId, highlightDelta: 0, noteDelta: 0, byteDelta: 0 }] : [])),
  ]);
  await recordChanges(ctx, library, [{ entityType: "note", entityId, revision }], now);
  return "applied";
}

/**
 * Keep derived book counters exact without revising the book. The book's own
 * writer claim owns its revision; advancing it here, as the passage or note
 * lands, would leave a book history row no device claims and stop every pull.
 */
async function adjustSyncedBooks(
  ctx: MutationContext,
  libraryId: string,
  now: number,
  deltas: readonly { readonly bookId: string; readonly highlightDelta: number; readonly noteDelta: number; readonly byteDelta: number }[],
): Promise<void> {
  const combined = new Map<string, { highlightDelta: number; noteDelta: number; byteDelta: number }>();
  for (const delta of deltas) {
    const previous = combined.get(delta.bookId) ?? { highlightDelta: 0, noteDelta: 0, byteDelta: 0 };
    combined.set(delta.bookId, { highlightDelta: previous.highlightDelta + delta.highlightDelta,
      noteDelta: previous.noteDelta + delta.noteDelta, byteDelta: previous.byteDelta + delta.byteDelta });
  }
  for (const [bookId, delta] of combined) {
    if (delta.highlightDelta === 0 && delta.noteDelta === 0 && delta.byteDelta === 0) continue;
    const book = await findBook(ctx, libraryId, bookId);
    if (!book || book.deletedAt !== undefined) continue;
    const highlightCount = Number(book.highlightCount) + delta.highlightDelta;
    const noteCount = Number(book.noteCount) + delta.noteDelta;
    const readingDataBytes = Number(book.readingDataBytes) + delta.byteDelta;
    if (highlightCount < 0 || noteCount < 0 || readingDataBytes < 0) throw new Error("Synced book counters are inconsistent");
    await ctx.db.patch(book._id, { highlightCount, noteCount, readingDataBytes, updatedAt: now });
  }
}

async function setBookCandidatesActive(
  ctx: MutationContext,
  libraryId: string,
  bookId: string,
  active: boolean,
): Promise<void> {
  const candidates = await ctx.db.query("dailyCandidates").withIndex("by_library_and_book", (q) =>
    q.eq("libraryId", libraryId).eq("bookId", bookId)).take(MAX_ATOMIC_DAILY_CANDIDATES + 1);
  const blocked = await ctx.db.query("dailyProjectionBlocks").withIndex("by_library_and_book", (q) =>
    q.eq("libraryId", libraryId).eq("bookId", bookId)).unique();
  if (candidates.length > MAX_ATOMIC_DAILY_CANDIDATES) {
    if (blocked) await ctx.db.patch(blocked._id, { desiredActive: active, createdAt: Date.now() });
    else await ctx.db.insert("dailyProjectionBlocks", { libraryId, bookId, desiredActive: active, createdAt: Date.now() });
    return;
  }
  for (const candidate of candidates) await ctx.db.patch(candidate._id, { bookActive: active });
  if (blocked) await ctx.db.delete(blocked._id);
}

async function reconcileSyncedHighlightMemberships(
  ctx: MutationContext,
  libraryId: string,
  highlightId: string,
  operation: "upsert" | "tombstone",
  sourceBookId: string,
  bookId: string,
  now: number,
): Promise<Change[]> {
  const tagRows = await ctx.db.query("highlightTags").withIndex("by_library_and_highlight", (q) =>
    q.eq("libraryId", libraryId).eq("highlightId", highlightId)).take(MAX_ATOMIC_ORGANIZATION_MEMBERSHIPS + 1);
  const tooManyTags = tagRows.length > MAX_ATOMIC_ORGANIZATION_MEMBERSHIPS;
  if (operation === "upsert" && !tooManyTags) {
    for (const row of tagRows) await ctx.db.patch(row._id, { bookId });
    return [];
  }
  const threadRows = await ctx.db.query("threadHighlights").withIndex("by_library_and_highlight", (q) =>
    q.eq("libraryId", libraryId).eq("highlightId", highlightId)).take(MAX_THREAD_MEMBERSHIPS_PER_HIGHLIGHT + 1);
  if (tooManyTags || threadRows.length > MAX_THREAD_MEMBERSHIPS_PER_HIGHLIGHT) {
    await blockHighlightProjection(ctx, libraryId, highlightId, operation, sourceBookId, bookId, now);
    return [];
  }
  const [threads, tags] = await Promise.all([
    Promise.all(threadRows.map((row) => ctx.db.query("threads").withIndex("by_library_and_id", (q) =>
      q.eq("libraryId", libraryId).eq("id", row.threadId)).unique())),
    Promise.all(tagRows.map((row) => ctx.db.query("tags").withIndex("by_library_and_id", (q) =>
      q.eq("libraryId", libraryId).eq("id", row.tagId)).unique())),
  ]);
  // The tombstone itself tells replicas the passage left its threads and tags.
  // Advancing those containers would orphan their writer claims and stop
  // every later pull, so only their counters follow.
  const changes: Change[] = [];
  for (const [index, row] of threadRows.entries()) {
    await ctx.db.delete(row._id);
    const thread = threads[index];
    if (!thread || thread.deletedAt !== undefined) continue;
    await ctx.db.patch(thread._id, { passageCount: Math.max(0, Number(thread.passageCount) - 1), updatedAt: now });
  }
  for (const [index, row] of tagRows.entries()) {
    await ctx.db.delete(row._id);
    const tag = tags[index];
    if (!tag || tag.deletedAt !== undefined) continue;
    await ctx.db.patch(tag._id, { highlightCount: Math.max(0, Number(tag.highlightCount) - 1), updatedAt: now });
  }
  return changes;
}

async function blockHighlightProjection(
  ctx: MutationContext,
  libraryId: string,
  highlightId: string,
  operation: "upsert" | "tombstone",
  sourceBookId: string,
  targetBookId: string,
  now: number,
): Promise<void> {
  const block = await ctx.db.query("highlightProjectionBlocks").withIndex("by_library_and_highlight", (q) =>
    q.eq("libraryId", libraryId).eq("highlightId", highlightId)).unique();
  if (operation === "upsert") {
    for (const source of new Set([sourceBookId, ...(block && block.operation === "upsert" ? [block.targetBookId] : [])])) {
      if (source === targetBookId) continue;
      const existing = await ctx.db.query("highlightProjectionSources").withIndex("by_library_highlight_and_source", (q) =>
        q.eq("libraryId", libraryId).eq("highlightId", highlightId).eq("sourceBookId", source)).unique();
      if (!existing) await ctx.db.insert("highlightProjectionSources", { libraryId, highlightId, sourceBookId: source });
    }
  }
  if (block) await ctx.db.patch(block._id, { operation, targetBookId, createdAt: now });
  else await ctx.db.insert("highlightProjectionBlocks", { libraryId, highlightId, operation, targetBookId, createdAt: now });
}

function syncedEntityId(change: SyncedChange): string {
  if (change.operation === "tombstone") return change.entityId;
  if (change.entityType === "book") return change.book.id;
  if (change.entityType === "highlight") return change.highlight.id;
  if (change.entityType === "note") return change.note.id;
  if (change.entityType === "collection") return change.collection.id;
  if (change.entityType === "tag") return change.tag.id;
  if (change.entityType === "thread") return change.thread.id;
  return change.dailySelection.id;
}

function isAnnotationChange(change: SyncedChange): change is AnnotationChange {
  return change.entityType === "highlight" || change.entityType === "note";
}

function syncedBody(change: SyncedChange): string | undefined {
  if (change.operation === "tombstone" || !isAnnotationChange(change)) return undefined;
  return change.entityType === "highlight"
    ? requiredText(change.highlight.text, "Highlight", 100_000)
    : requiredNote(change.note.markdown);
}

function validateSyncedReferences(change: SyncedChange): void {
  if (change.operation === "upsert" && change.entityType === "book") {
    requireSyncedIds(change.collectionIds, "Book collection membership");
    requireSyncedIds(change.tagIds, "Book tag membership");
    const events = change.statusEvents ?? [];
    if (events.length > MAX_SYNCED_STATUS_EVENTS_PER_BOOK || new Set(events.map(({ id }) => id)).size !== events.length ||
        !events.every((event) => isUuid(event.id) && event.bookId === change.book.id &&
          Number.isSafeInteger(event.changedAt) && event.changedAt >= 0 &&
          Number.isSafeInteger(event.bookRevision) && event.bookRevision > 0 &&
          (event.completedOn === undefined || validateCompletionDate(event.completedOn) === event.completedOn))) {
      throw new Error("Book reading history is invalid");
    }
  }
  if (change.operation === "upsert" && change.entityType === "highlight") {
    requireSyncedIds(change.tagIds, "Passage tag membership");
    requireSyncedIds(change.threadIds ?? [], "Passage thread membership", MAX_THREADS_PER_HIGHLIGHT);
  }
  if (change.entityType === "collection" || change.entityType === "tag" || change.entityType === "thread" ||
      change.entityType === "daily-selection") return;
  const bookId = change.operation === "tombstone"
    ? change.entityType === "book" ? change.entityId : change.bookId
    : change.entityType === "book" ? change.book.id :
      change.entityType === "highlight" ? change.highlight.bookId : change.note.bookId;
  if (!isUuid(bookId)) throw new Error("Synced change parent is invalid");
  if (change.operation === "upsert" && change.entityType === "note" &&
      change.note.highlightId !== undefined && !isUuid(change.note.highlightId)) {
    throw new Error("Synced change parent is invalid");
  }
}

function requireSyncedIds(ids: readonly string[], label: string, maximum = MAX_SYNC_ORGANIZATION_MEMBERSHIPS): void {
  if (ids.length > maximum || new Set(ids).size !== ids.length || !ids.every(isUuid)) {
    throw new Error(`${label} is invalid`);
  }
}

function annotationBody(
  entityType: "highlight" | "note",
  current: ReplayDocument | null | undefined,
): string | undefined {
  if (!current) return undefined;
  return entityType === "highlight" && "text" in current ? String(current.text) :
    entityType === "note" && "markdown" in current ? String(current.markdown) : undefined;
}

function annotationBookId(current: ReplayDocument | null | undefined): string | undefined {
  return current && "bookId" in current ? String(current.bookId) : undefined;
}

function incomingWins(
  incoming: SyncedChange,
  current: DocumentByName<DataModel, "syncedWriters">,
): boolean {
  if (incoming.operation !== current.operation) return incoming.operation === "tombstone";
  return incoming.deviceRevision > Number(current.deviceRevision) ||
    (incoming.deviceRevision === Number(current.deviceRevision) && incoming.deviceId > String(current.deviceId));
}

function causallySuperseded(
  loserDeviceId: string | undefined,
  loserRevision: number | undefined,
  winnerDeviceId: string | undefined,
  winnerRevision: number | undefined,
): boolean {
  return Boolean(loserDeviceId && loserDeviceId === winnerDeviceId && loserRevision !== undefined &&
    winnerRevision !== undefined && loserRevision <= winnerRevision);
}

async function requireAttachmentMigration(ctx: MutationContext, libraryId: string): Promise<void> {
  const legacy = await ctx.db.query("notes").withIndex("by_library_attachment_ready_and_id", (q) =>
    q.eq("libraryId", libraryId).eq("attachmentBoundsReady", undefined)).first();
  if (legacy) throw accessFailure("LEAFLOGUE_MIGRATION_REQUIRED", "Finish the legacy attached-note migration before enabling Convex sync");
}

async function preserveSyncConflict(
  ctx: MutationContext,
  libraryId: string,
  change: AnnotationChange,
  losingBody: string,
  winningBody: string | undefined,
  loser: { readonly deviceId?: string; readonly deviceRevision?: number; readonly operation: "upsert" | "tombstone" },
  winningOperation: "upsert" | "tombstone",
  resolvedBookId?: string,
): Promise<void> {
  const entityId = syncedEntityId(change);
  const bookId = resolvedBookId ?? (change.operation === "upsert"
    ? change.entityType === "highlight" ? change.highlight.bookId : change.note.bookId
    : change.bookId);
  const maximumBytes = change.entityType === "note" ? MAX_NOTE_BYTES : MAX_SYNC_HIGHLIGHT_CONFLICT_BYTES;
  if (new TextEncoder().encode(losingBody).byteLength > maximumBytes) {
    throw new Error("A losing synced body exceeds the reviewable conflict limit");
  }
  if (winningBody !== undefined && new TextEncoder().encode(winningBody).byteLength > maximumBytes) {
    throw new Error("A winning synced body exceeds the reviewable conflict limit");
  }
  const duplicate = await ctx.db.query("syncConflicts").withIndex("by_library_loser", (q) =>
    q.eq("libraryId", libraryId).eq("entityType", change.entityType).eq("entityId", entityId)
      .eq("losingDeviceId", loser.deviceId).eq("losingDeviceRevision", loser.deviceRevision)
      .eq("losingOperation", loser.operation)).first();
  if (duplicate) return;
  const counter = await ctx.db.query("syncConflictCounters").withIndex("by_library_entity", (q) =>
    q.eq("libraryId", libraryId).eq("entityType", change.entityType).eq("entityId", entityId)).unique();
  if (Number(counter?.pendingCount ?? 0) >= MAX_PENDING_SYNC_CONFLICTS_PER_ENTITY) {
    throw new Error("This synced item has too many pending conflicts to preserve another body");
  }
  await ctx.db.insert("syncConflicts", { libraryId, id: crypto.randomUUID(), entityType: change.entityType,
    entityId, bookId, losingBody, ...(winningBody ? { winningBody } : {}),
    ...(loser.deviceId ? { losingDeviceId: loser.deviceId } : {}),
    ...(loser.deviceRevision !== undefined ? { losingDeviceRevision: loser.deviceRevision } : {}),
    losingOperation: loser.operation, winningOperation, status: "pending", createdAt: Date.now() });
  if (counter) await ctx.db.patch(counter._id, { pendingCount: Number(counter.pendingCount) + 1 });
  else await ctx.db.insert("syncConflictCounters", { libraryId, entityType: change.entityType, entityId, pendingCount: 1 });
}

async function updateSyncedWriterRevision(
  ctx: MutationContext,
  libraryId: string,
  entityType: ReplayEntityType,
  entityId: string,
): Promise<void> {
  const writer = await ctx.db.query("syncedWriters").withIndex("by_library_entity", (q) =>
    q.eq("libraryId", libraryId).eq("entityType", entityType).eq("entityId", entityId)).unique();
  if (!writer) throw new Error("Synced writer claim disappeared");
  const entity = await findReplayEntity(ctx, libraryId, entityType, entityId);
  if (entity) {
    await ctx.db.patch(writer._id, { entityRevision: Number(entity.revision) });
    return;
  }
  const tombstone = await ctx.db.query("syncTombstones").withIndex("by_library_entity", (q) =>
    q.eq("libraryId", libraryId).eq("entityType", entityType).eq("entityId", entityId)).unique();
  if (!tombstone) throw new Error("Synced entity revision disappeared");
  await ctx.db.patch(writer._id, { entityRevision: Number(tombstone.revision) });
}

async function recordSyncedTombstone(
  ctx: MutationContext,
  libraryId: string,
  entityType: ReplayEntityType,
  entityId: string,
  bookId: string,
  rowRevision: number | undefined,
  now: number,
): Promise<number> {
  const existing = await ctx.db.query("syncTombstones").withIndex("by_library_entity", (q) =>
    q.eq("libraryId", libraryId).eq("entityType", entityType).eq("entityId", entityId)).unique();
  const revision = existing ? Math.max(Number(existing.revision) + 1, rowRevision ?? 1) : rowRevision ?? 1;
  if (existing) await ctx.db.patch(existing._id, { bookId, revision, deletedAt: now });
  else await ctx.db.insert("syncTombstones", { libraryId, entityType, entityId, bookId, revision, deletedAt: now });
  return revision;
}

async function clearSyncedTombstone(
  ctx: MutationContext,
  libraryId: string,
  entityType: ReplayEntityType,
  entityId: string,
): Promise<void> {
  const existing = await ctx.db.query("syncTombstones").withIndex("by_library_entity", (q) =>
    q.eq("libraryId", libraryId).eq("entityType", entityType).eq("entityId", entityId)).unique();
  if (existing) await ctx.db.delete(existing._id);
}

function validEpoch(value: number | undefined, optional = false): number {
  if (value === undefined) {
    if (optional) return 0;
    throw new Error("Synced timestamp is invalid");
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Synced timestamp is invalid");
  return value;
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function requireLibrary(ctx: MutationContext, libraryId: string): Promise<DocumentByName<DataModel, "libraries">> {
  const library = await ctx.db.query("libraries").withIndex("by_external_id", (q) => q.eq("externalId", libraryId)).unique();
  if (!library) throw new Error("Library no longer exists");
  return library;
}

function findBook(ctx: MutationContext, libraryId: string, id: string): Promise<DocumentByName<DataModel, "books"> | null> {
  return ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique();
}

function findHighlight(ctx: MutationContext, libraryId: string, id: string): Promise<DocumentByName<DataModel, "highlights"> | null> {
  return ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique();
}

function findCollection(ctx: MutationContext, libraryId: string, id: string): Promise<DocumentByName<DataModel, "collections"> | null> {
  return ctx.db.query("collections").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique();
}

function findTag(ctx: MutationContext, libraryId: string, id: string): Promise<DocumentByName<DataModel, "tags"> | null> {
  return ctx.db.query("tags").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique();
}

function findReplayEntity(ctx: MutationContext, libraryId: string, entityType: ReplayEntityType, id: string): Promise<ReplayDocument | null> {
  if (entityType === "book") return findBook(ctx, libraryId, id);
  if (entityType === "highlight") return findHighlight(ctx, libraryId, id);
  if (entityType === "note") return findNote(ctx, libraryId, id);
  if (entityType === "thread") return findThread(ctx, libraryId, id);
  if (entityType === "daily-selection") {
    return ctx.db.query("dailySelections").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique();
  }
  return entityType === "collection" ? findCollection(ctx, libraryId, id) : findTag(ctx, libraryId, id);
}

function findThread(ctx: MutationContext, libraryId: string, id: string): Promise<DocumentByName<DataModel, "threads"> | null> {
  return ctx.db.query("threads").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique();
}

function findNote(ctx: MutationContext, libraryId: string, id: string): Promise<DocumentByName<DataModel, "notes"> | null> {
  return ctx.db.query("notes").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique();
}

async function requireUnusedHighlightId(ctx: MutationContext, libraryId: string, id: string): Promise<void> {
  requiredId(id);
  if (await findHighlight(ctx, libraryId, id)) throw new Error("Entity ID already exists");
}

async function requireUnusedNoteId(ctx: MutationContext, libraryId: string, id: string): Promise<void> {
  requiredId(id);
  if (await findNote(ctx, libraryId, id)) throw new Error("Entity ID already exists");
}

/** A web-client write: recorded like any change, and claimed so desktops pull it. */
async function recordWebChanges(ctx: MutationContext, library: DocumentByName<DataModel, "libraries">, changes: readonly Change[], now: number): Promise<void> {
  await recordChanges(ctx, library, changes, now);
  await claimWebWrites(ctx, String(library.externalId), changes, now);
}

async function recordChanges(ctx: MutationContext, library: DocumentByName<DataModel, "libraries">, changes: readonly Change[], now: number): Promise<void> {
  // Re-read the counter: one mutation may record changes more than once (a
  // daily pick that retires another), and the caller's copy would be stale.
  const fresh = await ctx.db.get(library._id);
  if (!fresh) throw new Error("Library no longer exists");
  let sequence = Number(fresh.nextChangeSequence);
  for (const change of changes) {
    sequence += 1;
    await ctx.db.insert("syncChanges", { libraryId: String(library.externalId), sequence, ...change, changedAt: now });
  }
  await ctx.db.patch(library._id, { nextChangeSequence: sequence, updatedAt: now });
}

function requiredId(value: string): string {
  // Only creation paths call this. Existing v2 Convex records are still looked
  // up verbatim by update/archive/merge paths, so a legacy mixed-case ID remains
  // editable while all newly created IDs are canonical lowercase.
  const normalized = value.trim();
  if (normalized !== value) throw new Error("Entity ID is invalid");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) throw new Error("Entity ID is invalid");
  return normalized;
}

// Mirrors normalizeBookMetadata in @leaflogue/domain; a test keeps them equal.
export function normalizeBookMetadata(input: {
  readonly title: string;
  readonly authors: readonly string[];
  readonly description?: string;
  readonly publisher?: string;
  readonly series?: string;
  readonly seriesNumber?: string;
  readonly language?: string;
  readonly isbn13?: string;
  readonly coverUrl?: string;
}) {
  const display = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ");
  const title = display(input.title);
  if (!title) throw new Error("Book title is required");
  if (title.length > 1_000) throw new Error("Book title is too long");
  if (input.authors.length > 50) throw new Error("Book authors are invalid");
  const authors = [...new Set(input.authors.map((author) => {
    const name = display(author);
    if (name.length > 500) throw new Error("Book author is too long");
    return name;
  }).filter(Boolean))];
  const optional = (value: string | undefined, label: string, maximum: number, collapse = true) => {
    if (value === undefined) return undefined;
    const text = collapse ? display(value) : value.normalize("NFC").trim();
    if (text.length > maximum) throw new Error(`Book ${label} is too long`);
    return text || undefined;
  };
  const description = optional(input.description, "description", 20_000, false);
  const publisher = optional(input.publisher, "publisher", 500);
  const series = optional(input.series, "series", 500);
  const seriesNumber = optional(input.seriesNumber, "series number", 40);
  const language = optional(input.language, "language", 35);
  let isbn13: string | undefined;
  if (input.isbn13 !== undefined && input.isbn13.trim()) {
    isbn13 = normalizeIsbn13(input.isbn13);
    if (!isbn13) throw new Error("ISBN-13 is invalid");
  }
  let coverUrl: string | undefined;
  if (input.coverUrl !== undefined && input.coverUrl.trim()) {
    const candidate = optional(input.coverUrl, "cover URL", 2_048, false);
    try {
      if (!candidate) throw new Error();
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
      coverUrl = parsed.toString();
    } catch {
      throw new Error("Book cover URL must be an HTTPS URL without embedded credentials");
    }
  }
  return {
    title,
    authors,
    ...(description ? { description } : {}),
    ...(publisher ? { publisher } : {}),
    ...(series ? { series } : {}),
    ...(seriesNumber ? { seriesNumber } : {}),
    ...(language ? { language } : {}),
    ...(isbn13 ? { isbn13 } : {}),
    ...(coverUrl ? { coverUrl } : {}),
  };
}

function normalizeIsbn13(value: string): string | undefined {
  const digits = value.replace(/[^0-9]/gu, "");
  if (!/^\d{13}$/u.test(digits)) return undefined;
  const expected = digits.slice(0, 12).split("").reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - expected % 10) % 10 === Number(digits[12]) ? digits : undefined;
}

function mapBook(book: DocumentByName<DataModel, "books">) {
  return {
    id: String(book.id),
    title: String(book.title),
    authors: [...book.authors],
    ...(book.description ? { description: String(book.description) } : {}),
    ...(book.publisher ? { publisher: String(book.publisher) } : {}),
    ...(book.series ? { series: String(book.series) } : {}),
    ...(book.seriesNumber ? { seriesNumber: String(book.seriesNumber) } : {}),
    ...(book.language ? { language: String(book.language) } : {}),
    ...(book.isbn13 ? { isbn13: String(book.isbn13) } : {}),
    ...(book.coverUrl ? { coverUrl: String(book.coverUrl) } : {}),
    status: book.status,
    ...(book.completedOn ? { completedOn: String(book.completedOn) } : {}),
    archived: book.archived,
    createdAt: Number(book.createdAt),
    updatedAt: Number(book.updatedAt),
    revision: Number(book.revision),
    highlightCount: Number(book.highlightCount),
  };
}

function sameCreateBook(
  book: ReturnType<typeof mapBook>,
  input: { readonly id: string; readonly title: string; readonly authors: readonly string[]; readonly isbn13?: string },
): boolean {
  return book.id === input.id && book.title === input.title && book.isbn13 === input.isbn13 &&
    book.authors.length === input.authors.length && book.authors.every((author, index) => author === input.authors[index]);
}

function optionalStoredText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function annotationBytes(...values: Array<string | undefined>): number {
  return 512 + values.reduce((total, value) => total + (value ? new TextEncoder().encode(value).byteLength : 0), 0);
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} text is required`);
  if (normalized.length > maximum) throw new Error(`${label} text is too long`);
  return normalized;
}

/** Matches the interactive organization-name grammar in `organization.ts`. */
function organizationName(value: string, label: string, maximum: number): string {
  const name = value.trim().replace(/\s+/gu, " ");
  if (!name) throw new Error(`${label} name is required`);
  if (name.length > maximum || normalizeOrganizationName(name).length > maximum) throw new Error(`${label} name is too long`);
  return name;
}

function requiredNote(value: string): string {
  const markdown = requiredText(value, "Note", 100_000);
  if (new TextEncoder().encode(markdown).byteLength > MAX_NOTE_BYTES) throw new Error("Note text is too long");
  return markdown;
}

function optionalText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error("Location is too long");
  return normalized || undefined;
}

function requireRevision(revision: number, label: string): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error(`${label} revision is invalid`);
}
