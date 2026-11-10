import { normalizeOrganizationName } from "@leaflogue/contracts";
import type { DataModelFromSchemaDefinition, DocumentByName, GenericMutationCtx, MutationBuilder } from "convex/server";
import { internalMutationGeneric } from "convex/server";
import {
  createThreadArgs, deleteThreadArgs, setHighlightThreadMembershipArgs, threadMembershipValidator,
  threadValidator, updateThreadArgs,
} from "./threadContracts";
import schema from "./schema";
import { claimWebWrites } from "./webWrites";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationContext = GenericMutationCtx<DataModel>;
type Library = DocumentByName<DataModel, "libraries">;
type ThreadDocument = DocumentByName<DataModel, "threads">;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
const MAX_THREADS = 100;
const MAX_THREAD_PASSAGES = 500;
const MAX_HIGHLIGHT_THREADS = 20;

export const createThread = internalMutation({
  args: createThreadArgs,
  returns: threadValidator,
  handler: async (ctx, args) => {
    const id = requiredId(args.id);
    const name = threadName(args.name);
    const normalizedName = normalizeOrganizationName(name);
    const description = optionalDescription(args.description);
    const [library, existing] = await Promise.all([requireLibrary(ctx, args.libraryId), findThread(ctx, args.libraryId, id)]);
    if (existing) {
      if (existing.deletedAt !== undefined || existing.name !== name || storedText(existing.description) !== description) {
        throw new Error("Entity ID already exists with different thread data");
      }
      return mapThread(existing);
    }
    await requireAvailableName(ctx, args.libraryId, normalizedName);
    const active = await ctx.db.query("threads")
      .withIndex("by_library_deleted_and_id", (q) => q.eq("libraryId", args.libraryId).eq("deletedAt", undefined))
      .take(MAX_THREADS);
    if (active.length >= MAX_THREADS) throw new Error("At most 100 threads are allowed");
    const now = Date.now();
    await ctx.db.insert("threads", {
      libraryId: args.libraryId, id, name, normalizedName, ...(description ? { description } : {}),
      passageCount: 0, revision: 1, createdAt: now, updatedAt: now,
    });
    await recordChanges(ctx, library, [{ entityType: "thread", entityId: id, revision: 1 }], now);
    return { id, name, ...(description ? { description } : {}), passageCount: 0, revision: 1, createdAt: now, updatedAt: now };
  },
});

export const updateThread = internalMutation({
  args: updateThreadArgs,
  returns: threadValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Thread");
    const name = threadName(args.name);
    const normalizedName = normalizeOrganizationName(name);
    const description = optionalDescription(args.description);
    const [library, thread] = await Promise.all([requireLibrary(ctx, args.libraryId), findThread(ctx, args.libraryId, args.id)]);
    if (!thread || thread.deletedAt !== undefined || thread.revision !== args.expectedRevision) {
      throw new Error("Thread changed elsewhere or no longer exists");
    }
    await requireAvailableName(ctx, args.libraryId, normalizedName, thread._id);
    const now = Date.now();
    const revision = thread.revision + 1;
    await ctx.db.patch(thread._id, { name, normalizedName, description, revision, updatedAt: now });
    await recordChanges(ctx, library, [{ entityType: "thread", entityId: thread.id, revision }], now);
    return mapThread({ ...thread, name, normalizedName, description, revision, updatedAt: now });
  },
});

export const deleteThread = internalMutation({
  args: deleteThreadArgs,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Thread");
    const [library, thread] = await Promise.all([requireLibrary(ctx, args.libraryId), findThread(ctx, args.libraryId, args.id)]);
    if (!thread || thread.deletedAt !== undefined || thread.revision !== args.expectedRevision) {
      throw new Error("Thread changed elsewhere or no longer exists");
    }
    const links = await ctx.db.query("threadHighlights")
      .withIndex("by_library_and_thread", (q) => q.eq("libraryId", args.libraryId).eq("threadId", args.id))
      .take(MAX_THREAD_PASSAGES + 1);
    if (links.length > MAX_THREAD_PASSAGES) throw new Error("Thread contains too many passages");
    for (const link of links) await ctx.db.delete(link._id);
    const now = Date.now();
    const revision = thread.revision + 1;
    await ctx.db.patch(thread._id, { deletedAt: now, passageCount: 0, revision, updatedAt: now });
    await recordChanges(ctx, library, [{ entityType: "thread", entityId: thread.id, revision }], now);
    return null;
  },
});

export const setHighlightThreadMembership = internalMutation({
  args: setHighlightThreadMembershipArgs,
  returns: threadMembershipValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedHighlightRevision, "Highlight");
    const requested = [...new Set(args.threadIds.map(requiredId))];
    if (requested.length > MAX_HIGHLIGHT_THREADS) throw new Error("A passage can belong to at most 20 threads");
    const [library, book, highlight] = await Promise.all([
      requireLibrary(ctx, args.libraryId), findBook(ctx, args.libraryId, args.bookId), findHighlight(ctx, args.libraryId, args.highlightId),
    ]);
    if (!book || book.archived || book.deletedAt !== undefined || !highlight || highlight.bookId !== args.bookId ||
        highlight.archived || highlight.deletedAt !== undefined || highlight.revision !== args.expectedHighlightRevision) {
      throw new Error("Highlight changed elsewhere or no longer exists");
    }
    const requestedThreads = await Promise.all(requested.map((id) => findThread(ctx, args.libraryId, id)));
    if (requestedThreads.some((thread) => !thread || thread.deletedAt !== undefined)) throw new Error("Thread no longer exists");
    const links = await ctx.db.query("threadHighlights")
      .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", args.highlightId))
      .take(MAX_HIGHLIGHT_THREADS + 1);
    if (links.length > MAX_HIGHLIGHT_THREADS) throw new Error("Highlight belongs to too many threads");
    const existing = new Set(links.map((link) => link.threadId));
    const wanted = new Set(requested);
    const removed = links.filter((link) => !wanted.has(link.threadId));
    const added = requestedThreads.filter((thread): thread is ThreadDocument => Boolean(thread && !existing.has(thread.id)));
    for (const thread of added) {
      const passages = await ctx.db.query("threadHighlights")
        .withIndex("by_library_and_thread", (q) => q.eq("libraryId", args.libraryId).eq("threadId", thread.id))
        .take(MAX_THREAD_PASSAGES);
      if (passages.length >= MAX_THREAD_PASSAGES) throw new Error("A thread can contain at most 500 passages");
    }
    const changed = removed.length > 0 || added.length > 0;
    if (!changed) return membershipResult(false, args, highlight.revision, requestedThreads as ThreadDocument[]);

    const now = Date.now();
    for (const link of removed) await ctx.db.delete(link._id);
    for (const thread of added) await ctx.db.insert("threadHighlights", {
      libraryId: args.libraryId, threadId: thread.id, highlightId: args.highlightId, addedAt: now,
    });
    const affectedIds = new Set([...removed.map((link) => link.threadId), ...added.map((thread) => thread.id)]);
    const affected = new Map(requestedThreads.filter(Boolean).map((thread) => [thread!.id, thread!]));
    for (const link of removed) {
      if (!affected.has(link.threadId)) {
        const thread = await findThread(ctx, args.libraryId, link.threadId);
        if (!thread || thread.deletedAt !== undefined) throw new Error("Thread no longer exists");
        affected.set(thread.id, thread);
      }
    }
    const changes: Change[] = [];
    for (const threadId of affectedIds) {
      const thread = affected.get(threadId)!;
      const delta = (added.some((item) => item.id === threadId) ? 1 : 0) - (removed.some((item) => item.threadId === threadId) ? 1 : 0);
      const revision = thread.revision + 1;
      await ctx.db.patch(thread._id, { passageCount: thread.passageCount + delta, revision, updatedAt: now });
      changes.push({ entityType: "thread", entityId: thread.id, revision });
    }
    const highlightRevision = highlight.revision + 1;
    await ctx.db.patch(highlight._id, { revision: highlightRevision, updatedAt: now });
    changes.push({ entityType: "highlight", entityId: highlight.id, revision: highlightRevision });
    await recordChanges(ctx, library, changes, now);
    return membershipResult(true, args, highlightRevision, requestedThreads as ThreadDocument[]);
  },
});

type Change = { readonly entityType: "thread" | "highlight"; readonly entityId: string; readonly revision: number };
async function recordChanges(ctx: MutationContext, library: Library, changes: readonly Change[], now: number): Promise<void> {
  let sequence = library.nextChangeSequence;
  for (const change of changes) await ctx.db.insert("syncChanges", { libraryId: library.externalId, sequence: ++sequence, ...change, changedAt: now });
  if (changes.length) await ctx.db.patch(library._id, { nextChangeSequence: sequence, updatedAt: now });
  await claimWebWrites(ctx, library.externalId, changes, now);
}
function membershipResult(changed: boolean, args: { bookId: string; highlightId: string }, highlightRevision: number, threads: readonly ThreadDocument[]) {
  return { changed, bookId: args.bookId, highlightId: args.highlightId, highlightRevision, threadIds: [...threads].sort((a, b) => a.normalizedName.localeCompare(b.normalizedName) || a.id.localeCompare(b.id)).map((thread) => thread.id) };
}
function requireLibrary(ctx: MutationContext, libraryId: string) { return ctx.db.query("libraries").withIndex("by_external_id", (q) => q.eq("externalId", libraryId)).unique().then((value) => { if (!value) throw new Error("Library no longer exists"); return value; }); }
function findBook(ctx: MutationContext, libraryId: string, id: string) { return ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique(); }
function findHighlight(ctx: MutationContext, libraryId: string, id: string) { return ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique(); }
function findThread(ctx: MutationContext, libraryId: string, id: string) { return ctx.db.query("threads").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique(); }
// Replay can legitimately keep two same-name IDs created concurrently on different devices.
async function requireAvailableName(ctx: MutationContext, libraryId: string, normalizedName: string, except?: string) { const found = await ctx.db.query("threads").withIndex("by_library_normalized_name_and_deleted", (q) => q.eq("libraryId", libraryId).eq("normalizedName", normalizedName).eq("deletedAt", undefined)).take(2); if (found.some(({ _id }) => _id !== except)) throw new Error("Thread name is already in use"); }
function mapThread(value: ThreadDocument) { return { id: value.id, name: value.name, ...(value.description ? { description: value.description } : {}), passageCount: value.passageCount, createdAt: value.createdAt, updatedAt: value.updatedAt, revision: value.revision }; }
function requiredId(value: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new Error("Entity ID is invalid"); return value; }
function threadName(value: string) { const name = value.trim().replace(/\s+/gu, " "); if (!name) throw new Error("Thread name is required"); if (name.length > 120 || normalizeOrganizationName(name).length > 120) throw new Error("Thread name is too long"); return name; }
function optionalDescription(value: string | undefined) { if (value === undefined) return undefined; const text = value.trim(); if (text.length > 1_000) throw new Error("Thread description is too long"); return text || undefined; }
function storedText(value: unknown) { return typeof value === "string" && value.length > 0 ? value : undefined; }
function requireRevision(value: number, label: string) { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} revision is invalid`); }
