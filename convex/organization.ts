import type { DataModelFromSchemaDefinition, DocumentByName, GenericMutationCtx, MutationBuilder } from "convex/server";
import { internalMutationGeneric } from "convex/server";
import { normalizeOrganizationName } from "@leaflogue/contracts";
import {
  collectionValidator,
  createCollectionArgs,
  createTagArgs,
  deleteCollectionArgs,
  deleteTagArgs,
  membershipValidator,
  setBookCollectionMembershipArgs,
  setBookTagMembershipArgs,
  setHighlightTagMembershipArgs,
  tagValidator,
  updateCollectionArgs,
  updateTagArgs,
} from "./organizationContracts";
import schema from "./schema";
import { claimWebWrites } from "./webWrites";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationContext = GenericMutationCtx<DataModel>;
type Library = DocumentByName<DataModel, "libraries">;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
const MAX_ATOMIC_COLLECTION_MEMBERSHIPS = 200;
// A highlight link costs up to seven document operations when its passage,
// book, link, and change-feed owners are all distinct. Keep the worst case
// below the repository's 750-operation mutation budget.
const MAX_ATOMIC_TAG_MEMBERSHIPS = 100;

export const createCollection = internalMutation({
  args: createCollectionArgs,
  returns: collectionValidator,
  handler: async (ctx, args) => {
    const id = requiredId(args.id);
    const name = organizationName(args.name, "Collection", 120);
    const normalizedName = normalizeOrganizationName(name);
    const description = optionalText(args.description, "Collection description", 2_000);
    const library = await requireLibrary(ctx, args.libraryId);
    const existing = await findCollection(ctx, args.libraryId, id);
    if (existing) {
      if (existing.deletedAt !== undefined) throw new Error("Entity ID already exists");
      const result = mapCollection(existing);
      if (result.name !== name || result.description !== description) throw new Error("Entity ID already exists with different collection data");
      return result;
    }
    await requireAvailableCollectionName(ctx, args.libraryId, normalizedName);
    const now = Date.now();
    await ctx.db.insert("collections", {
      libraryId: args.libraryId, id, name, normalizedName, ...(description ? { description } : {}),
      bookCount: 0, revision: 1, createdAt: now, updatedAt: now,
    });
    await recordChanges(ctx, library, [{ entityType: "collection", id, revision: 1 }], now);
    return { id, name, ...(description ? { description } : {}), bookCount: 0, revision: 1, createdAt: now, updatedAt: now };
  },
});

export const updateCollection = internalMutation({
  args: updateCollectionArgs,
  returns: collectionValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Collection");
    const name = organizationName(args.name, "Collection", 120);
    const normalizedName = normalizeOrganizationName(name);
    const description = optionalText(args.description, "Collection description", 2_000);
    const [library, collection] = await Promise.all([requireLibrary(ctx, args.libraryId), findCollection(ctx, args.libraryId, args.id)]);
    if (!collection || collection.deletedAt !== undefined || collection.revision !== args.expectedRevision) throw new Error("Collection changed elsewhere or no longer exists");
    await requireAvailableCollectionName(ctx, args.libraryId, normalizedName, collection._id);
    const now = Date.now();
    await ctx.db.patch(collection._id, { name, normalizedName, description, revision: args.expectedRevision + 1, updatedAt: now });
    await recordChanges(ctx, library, [{ entityType: "collection", id: collection.id, revision: args.expectedRevision + 1 }], now);
    return mapCollection({ ...collection, name, normalizedName, description, revision: args.expectedRevision + 1, updatedAt: now });
  },
});

export const deleteCollection = internalMutation({
  args: deleteCollectionArgs,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Collection");
    const [library, collection] = await Promise.all([requireLibrary(ctx, args.libraryId), findCollection(ctx, args.libraryId, args.id)]);
    if (!collection || collection.deletedAt !== undefined || collection.revision !== args.expectedRevision) throw new Error("Collection changed elsewhere or no longer exists");
    const memberships = await ctx.db.query("collectionBooks").withIndex("by_library_and_collection", (q) => q.eq("libraryId", args.libraryId).eq("collectionId", args.id)).take(MAX_ATOMIC_COLLECTION_MEMBERSHIPS + 1);
    requireBounded(memberships.length, MAX_ATOMIC_COLLECTION_MEMBERSHIPS);
    const now = Date.now();
    const changes: BookChange[] = [];
    for (const membership of memberships) {
      const book = await findBook(ctx, args.libraryId, membership.bookId);
      if (book && book.deletedAt === undefined) {
        const revision = book.revision + 1;
        await ctx.db.patch(book._id, { revision, updatedAt: now });
        changes.push({ id: book.id, revision });
      }
      await ctx.db.delete(membership._id);
    }
    await ctx.db.patch(collection._id, { deletedAt: now, bookCount: 0, revision: collection.revision + 1, updatedAt: now });
    await recordChanges(ctx, library, [
      ...changes.map((change) => ({ entityType: "book" as const, ...change })),
      { entityType: "collection", id: collection.id, revision: collection.revision + 1 },
    ], now);
    return null;
  },
});

export const createTag = internalMutation({
  args: createTagArgs,
  returns: tagValidator,
  handler: async (ctx, args) => {
    const id = requiredId(args.id);
    const name = organizationName(args.name, "Tag", 80);
    const normalizedName = normalizeOrganizationName(name);
    const color = optionalText(args.color, "Tag color", 32);
    const library = await requireLibrary(ctx, args.libraryId);
    const existing = await findTag(ctx, args.libraryId, id);
    if (existing) {
      if (existing.deletedAt !== undefined) throw new Error("Entity ID already exists");
      const result = mapTag(existing);
      if (result.name !== name || result.color !== color) throw new Error("Entity ID already exists with different tag data");
      return result;
    }
    await requireAvailableTagName(ctx, args.libraryId, normalizedName);
    const now = Date.now();
    await ctx.db.insert("tags", { libraryId: args.libraryId, id, name, normalizedName, ...(color ? { color } : {}), bookCount: 0, highlightCount: 0, revision: 1, createdAt: now, updatedAt: now });
    await recordChanges(ctx, library, [{ entityType: "tag", id, revision: 1 }], now);
    return { id, name, ...(color ? { color } : {}), bookCount: 0, highlightCount: 0, revision: 1, createdAt: now, updatedAt: now };
  },
});

export const updateTag = internalMutation({
  args: updateTagArgs,
  returns: tagValidator,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Tag");
    const name = organizationName(args.name, "Tag", 80);
    const normalizedName = normalizeOrganizationName(name);
    const color = optionalText(args.color, "Tag color", 32);
    const [library, tag] = await Promise.all([requireLibrary(ctx, args.libraryId), findTag(ctx, args.libraryId, args.id)]);
    if (!tag || tag.deletedAt !== undefined || tag.revision !== args.expectedRevision) throw new Error("Tag changed elsewhere or no longer exists");
    await requireAvailableTagName(ctx, args.libraryId, normalizedName, tag._id);
    const now = Date.now();
    await ctx.db.patch(tag._id, { name, normalizedName, color, revision: tag.revision + 1, updatedAt: now });
    await recordChanges(ctx, library, [{ entityType: "tag", id: tag.id, revision: tag.revision + 1 }], now);
    return mapTag({ ...tag, name, normalizedName, color, revision: tag.revision + 1, updatedAt: now });
  },
});

export const deleteTag = internalMutation({
  args: deleteTagArgs,
  handler: async (ctx, args) => {
    requireRevision(args.expectedRevision, "Tag");
    await requireHighlightProjectionReady(ctx, args.libraryId);
    const [library, tag] = await Promise.all([requireLibrary(ctx, args.libraryId), findTag(ctx, args.libraryId, args.id)]);
    if (!tag || tag.deletedAt !== undefined || tag.revision !== args.expectedRevision) throw new Error("Tag changed elsewhere or no longer exists");
    const [bookLinks, highlightLinks] = await Promise.all([
      ctx.db.query("bookTags").withIndex("by_library_and_tag", (q) => q.eq("libraryId", args.libraryId).eq("tagId", args.id)).take(MAX_ATOMIC_TAG_MEMBERSHIPS + 1),
      ctx.db.query("highlightTags").withIndex("by_library_and_tag", (q) => q.eq("libraryId", args.libraryId).eq("tagId", args.id)).take(MAX_ATOMIC_TAG_MEMBERSHIPS + 1),
    ]);
    requireBounded(bookLinks.length + highlightLinks.length, MAX_ATOMIC_TAG_MEMBERSHIPS);
    if (highlightLinks.some((link) => link.bookId === undefined)) {
      throw new Error("Run the highlight-tag book migration before changing this tag");
    }
    const bookIds = new Set(bookLinks.map((link) => link.bookId));
    for (const link of highlightLinks) bookIds.add(link.bookId!);
    const now = Date.now();
    const changes: BookChange[] = [];
    const highlightChanges: BookChange[] = [];
    for (const bookId of bookIds) {
      const book = await findBook(ctx, args.libraryId, bookId);
      if (book && book.deletedAt === undefined) {
        const revision = book.revision + 1;
        await ctx.db.patch(book._id, { revision, updatedAt: now });
        changes.push({ id: book.id, revision });
      }
    }
    for (const link of highlightLinks) {
      const highlight = await findHighlight(ctx, args.libraryId, link.highlightId);
      if (highlight && highlight.deletedAt === undefined) {
        const revision = highlight.revision + 1;
        await ctx.db.patch(highlight._id, { revision, updatedAt: now });
        highlightChanges.push({ id: highlight.id, revision });
      }
    }
    for (const link of [...bookLinks, ...highlightLinks]) await ctx.db.delete(link._id);
    await ctx.db.patch(tag._id, { deletedAt: now, bookCount: 0, highlightCount: 0, revision: tag.revision + 1, updatedAt: now });
    await recordChanges(ctx, library, [
      ...changes.map((change) => ({ entityType: "book" as const, ...change })),
      ...highlightChanges.map((change) => ({ entityType: "highlight" as const, ...change })),
      { entityType: "tag", id: tag.id, revision: tag.revision + 1 },
    ], now);
    return null;
  },
});

export const setBookCollectionMembership = internalMutation({
  args: setBookCollectionMembershipArgs,
  returns: membershipValidator,
  handler: (ctx, args) => setMembership(ctx, args.libraryId, args.bookId, "collection", args.collectionId, args.included),
});
export const setBookTagMembership = internalMutation({
  args: setBookTagMembershipArgs,
  returns: membershipValidator,
  handler: (ctx, args) => setMembership(ctx, args.libraryId, args.bookId, "book-tag", args.tagId, args.included),
});
export const setHighlightTagMembership = internalMutation({
  args: setHighlightTagMembershipArgs,
  returns: membershipValidator,
  handler: (ctx, args) => setMembership(ctx, args.libraryId, args.bookId, "highlight-tag", args.tagId, args.included, args.highlightId),
});

async function setMembership(ctx: MutationContext, libraryId: string, bookId: string, kind: "collection" | "book-tag" | "highlight-tag", containerId: string, included: boolean, highlightId?: string) {
  if (kind === "highlight-tag") await requireHighlightProjectionReady(ctx, libraryId);
  const [library, book] = await Promise.all([requireLibrary(ctx, libraryId), findBook(ctx, libraryId, bookId)]);
  if (!book || book.archived || book.deletedAt !== undefined) throw new Error("Book no longer exists");
  const collection = kind === "collection" ? await findCollection(ctx, libraryId, containerId) : null;
  const tag = kind === "collection" ? null : await findTag(ctx, libraryId, containerId);
  const container = collection ?? tag;
  if (!container || container.deletedAt !== undefined) throw new Error(`${kind === "collection" ? "Collection" : "Tag"} no longer exists`);
  const highlight = kind === "highlight-tag" ? await findHighlight(ctx, libraryId, highlightId!) : null;
  if (kind === "highlight-tag") {
    if (!highlight || highlight.bookId !== bookId || highlight.archived || highlight.deletedAt !== undefined) throw new Error("Highlight no longer exists");
  }
  const existing = kind === "collection"
    ? await ctx.db.query("collectionBooks").withIndex("by_library_collection_and_book", (q) => q.eq("libraryId", libraryId).eq("collectionId", containerId).eq("bookId", bookId)).unique()
    : kind === "book-tag"
      ? await ctx.db.query("bookTags").withIndex("by_library_tag_and_book", (q) => q.eq("libraryId", libraryId).eq("tagId", containerId).eq("bookId", bookId)).unique()
      : await ctx.db.query("highlightTags").withIndex("by_library_tag_and_highlight", (q) => q.eq("libraryId", libraryId).eq("tagId", containerId).eq("highlightId", highlightId!)).unique();
  const changed = included ? !existing : Boolean(existing);
  if (!changed) return receipt(false, included, book, container, containerId, highlightId);
  const now = Date.now();
  if (existing) await ctx.db.delete(existing._id);
  else if (kind === "collection") await ctx.db.insert("collectionBooks", { libraryId, collectionId: containerId, bookId, createdAt: now });
  else if (kind === "book-tag") await ctx.db.insert("bookTags", { libraryId, tagId: containerId, bookId, createdAt: now });
  else await ctx.db.insert("highlightTags", { libraryId, tagId: containerId, bookId, highlightId: highlightId!, createdAt: now });
  const bookRevision = book.revision + 1;
  const containerRevision = container.revision + 1;
  await ctx.db.patch(book._id, { revision: bookRevision, updatedAt: now });
  const highlightRevision = highlight ? highlight.revision + 1 : undefined;
  if (highlight && highlightRevision !== undefined) {
    await ctx.db.patch(highlight._id, { revision: highlightRevision, updatedAt: now });
  }
  if (collection) await ctx.db.patch(collection._id, { bookCount: collection.bookCount + (included ? 1 : -1), revision: containerRevision, updatedAt: now });
  if (tag) await ctx.db.patch(tag._id, {
    ...(kind === "book-tag" ? { bookCount: tag.bookCount + (included ? 1 : -1) } : { highlightCount: tag.highlightCount + (included ? 1 : -1) }),
    revision: containerRevision, updatedAt: now,
  });
  await recordChanges(ctx, library, [
    { entityType: "book", id: book.id, revision: bookRevision },
    ...(highlight && highlightRevision !== undefined
      ? [{ entityType: "highlight" as const, id: highlight.id, revision: highlightRevision }]
      : []),
    { entityType: collection ? "collection" : "tag", id: containerId, revision: containerRevision },
  ], now);
  return { changed: true, included, bookId, bookRevision, containerId, containerRevision, ...(highlightId ? { highlightId } : {}) };
}

async function requireHighlightProjectionReady(ctx: MutationContext, libraryId: string): Promise<void> {
  const pending = await ctx.db.query("highlightProjectionBlocks")
    .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", libraryId)).first();
  if (pending) throw new Error("Repair the highlight membership projection before changing tags");
}

function receipt(changed: boolean, included: boolean, book: DocumentByName<DataModel, "books">, container: DocumentByName<DataModel, "collections"> | DocumentByName<DataModel, "tags">, containerId: string, highlightId?: string) {
  return { changed, included, bookId: book.id, bookRevision: book.revision, containerId, containerRevision: container.revision, ...(highlightId ? { highlightId } : {}) };
}
type BookChange = { readonly id: string; readonly revision: number };
type OrganizationChange = BookChange & { readonly entityType: "book" | "highlight" | "collection" | "tag" };
async function recordChanges(ctx: MutationContext, library: Library, changes: readonly OrganizationChange[], now: number): Promise<void> {
  let sequence = library.nextChangeSequence;
  for (const change of changes) await ctx.db.insert("syncChanges", { libraryId: library.externalId, sequence: ++sequence, entityType: change.entityType, entityId: change.id, revision: change.revision, changedAt: now });
  if (changes.length) await ctx.db.patch(library._id, { nextChangeSequence: sequence, updatedAt: now });
  await claimWebWrites(ctx, library.externalId, changes.map(({ entityType, id }) => ({ entityType, entityId: id })), now);
}
function requireLibrary(ctx: MutationContext, libraryId: string) { return ctx.db.query("libraries").withIndex("by_external_id", (q) => q.eq("externalId", libraryId)).unique().then((value) => { if (!value) throw new Error("Library no longer exists"); return value; }); }
function findBook(ctx: MutationContext, libraryId: string, id: string) { return ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique(); }
function findHighlight(ctx: MutationContext, libraryId: string, id: string) { return ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique(); }
function findCollection(ctx: MutationContext, libraryId: string, id: string) { return ctx.db.query("collections").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique(); }
function findTag(ctx: MutationContext, libraryId: string, id: string) { return ctx.db.query("tags").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", id)).unique(); }
// Replay can legitimately keep two same-name IDs created concurrently on different devices.
async function requireAvailableCollectionName(ctx: MutationContext, libraryId: string, normalizedName: string, except?: string) { const found = await ctx.db.query("collections").withIndex("by_library_normalized_name_and_deleted", (q) => q.eq("libraryId", libraryId).eq("normalizedName", normalizedName).eq("deletedAt", undefined)).take(2); if (found.some(({ _id }) => _id !== except)) throw new Error("Collection name is already in use"); }
// Replay can legitimately keep two same-name IDs created concurrently on different devices.
async function requireAvailableTagName(ctx: MutationContext, libraryId: string, normalizedName: string, except?: string) { const found = await ctx.db.query("tags").withIndex("by_library_normalized_name_and_deleted", (q) => q.eq("libraryId", libraryId).eq("normalizedName", normalizedName).eq("deletedAt", undefined)).take(2); if (found.some(({ _id }) => _id !== except)) throw new Error("Tag name is already in use"); }
function mapCollection(value: DocumentByName<DataModel, "collections">) { return { id: value.id, name: value.name, ...(value.description ? { description: value.description } : {}), bookCount: value.bookCount, createdAt: value.createdAt, updatedAt: value.updatedAt, revision: value.revision }; }
function mapTag(value: DocumentByName<DataModel, "tags">) { return { id: value.id, name: value.name, ...(value.color ? { color: value.color } : {}), bookCount: value.bookCount, highlightCount: value.highlightCount, createdAt: value.createdAt, updatedAt: value.updatedAt, revision: value.revision }; }
function requiredId(value: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new Error("Entity ID is invalid"); return value; }
function organizationName(value: string, label: string, maximum: number) { const name = value.trim().replace(/\s+/gu, " "); if (!name) throw new Error(`${label} name is required`); if (name.length > maximum || normalizeOrganizationName(name).length > maximum) throw new Error(`${label} name is too long`); return name; }
function optionalText(value: string | undefined, label: string, maximum: number) { if (value === undefined) return undefined; const text = value.trim(); if (text.length > maximum) throw new Error(`${label} is too long`); return text || undefined; }
function requireRevision(value: number, label: string) { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} revision is invalid`); }
function requireBounded(length: number, maximum: number) { if (length > maximum) throw new Error("Organization change exceeds the safe Convex transaction limit"); }
