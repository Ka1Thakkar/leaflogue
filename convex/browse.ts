import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  GenericDatabaseReader,
  PaginationOptions,
  QueryBuilder,
} from "convex/server";
import { paginationOptsValidator, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { requireLibraryAccess } from "./accessControl";
import schema from "./schema";

/**
 * Reads for a web client browsing a library: the whole shelf with its
 * collections and tags, passages across books with search and filters,
 * threads, reading history, and raw pages for statistics and export. Deleted
 * things are left out (export pages include them, marked).
 */

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type Reader = { readonly db: GenericDatabaseReader<DataModel> };
type Book = DocumentByName<DataModel, "books">;
type Highlight = DocumentByName<DataModel, "highlights">;
const query = queryGeneric as QueryBuilder<DataModel, "public">;

const MAX_BOOKS = 2_000;
const MAX_MEMBERSHIPS = 20_000;
const MAX_LIST = 1_000;
const MAX_PAGE_ITEMS = 50;
const MAX_ROWS_SCANNED = 400;
const MAX_NOTES_SHOWN = 50;
const MAX_THREAD_PASSAGES = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

const invalid = (message: string) => new ConvexError({ code: "LEAFLOGUE_REQUEST_INVALID", message });

function tooLarge(what: string): never {
  throw new ConvexError({ code: "LEAFLOGUE_LIBRARY_TOO_LARGE", message: `This library has too many ${what} to show at once` });
}

function mapBook(book: Book, collectionIds: string[], tagIds: string[]) {
  return {
    id: book.id,
    title: book.title,
    authors: book.authors,
    ...(book.description !== undefined ? { description: book.description } : {}),
    ...(book.publisher !== undefined ? { publisher: book.publisher } : {}),
    ...(book.series !== undefined ? { series: book.series } : {}),
    ...(book.seriesNumber !== undefined ? { seriesNumber: book.seriesNumber } : {}),
    ...(book.language !== undefined ? { language: book.language } : {}),
    ...(book.isbn13 !== undefined ? { isbn13: book.isbn13 } : {}),
    ...(book.coverUrl !== undefined ? { coverUrl: book.coverUrl } : {}),
    status: book.status,
    ...(book.completedOn !== undefined ? { completedOn: book.completedOn } : {}),
    archived: book.archived,
    highlightCount: book.highlightCount,
    noteCount: book.noteCount,
    collectionIds,
    tagIds,
    revision: book.revision,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
}

function group(rows: readonly { bookId: string }[], key: (row: never) => string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const list = result.get(row.bookId) ?? [];
    list.push(key(row as never));
    result.set(row.bookId, list);
  }
  return result;
}

/** Every book on the shelf (not archived), with the collections and tags it is in. */
export const books = query({
  args: { libraryId: v.string() },
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const shelf = (await ctx.db.query("books")
      .withIndex("by_library_archived_and_id", (q) => q.eq("libraryId", args.libraryId).eq("archived", false))
      .take(MAX_BOOKS + 1)).filter((book) => book.deletedAt === undefined);
    if (shelf.length > MAX_BOOKS) tooLarge("books");
    const collectionLinks = await ctx.db.query("collectionBooks")
      .withIndex("by_library_and_collection", (q) => q.eq("libraryId", args.libraryId)).take(MAX_MEMBERSHIPS + 1);
    const tagLinks = await ctx.db.query("bookTags")
      .withIndex("by_library_and_tag", (q) => q.eq("libraryId", args.libraryId)).take(MAX_MEMBERSHIPS + 1);
    if (collectionLinks.length > MAX_MEMBERSHIPS || tagLinks.length > MAX_MEMBERSHIPS) tooLarge("collection and tag links");
    const collections = group(collectionLinks, (row: { collectionId: string }) => row.collectionId);
    const tags = group(tagLinks, (row: { tagId: string }) => row.tagId);
    return shelf.map((book) => mapBook(book, collections.get(book.id) ?? [], tags.get(book.id) ?? []));
  },
});

/** One book, archived or not, or null once it is deleted. */
export const book = query({
  args: { libraryId: v.string(), bookId: v.string() },
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const found = await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", args.bookId)).unique();
    if (!found || found.deletedAt !== undefined) return null;
    const collectionIds = (await ctx.db.query("collectionBooks")
      .withIndex("by_library_and_book", (q) => q.eq("libraryId", args.libraryId).eq("bookId", found.id)).take(200)).map((row) => row.collectionId);
    const tagIds = (await ctx.db.query("bookTags")
      .withIndex("by_library_and_book", (q) => q.eq("libraryId", args.libraryId).eq("bookId", found.id)).take(200)).map((row) => row.tagId);
    return mapBook(found, collectionIds, tagIds);
  },
});

async function activeNotes(ctx: Reader, libraryId: string, highlightId: string) {
  const notes = await ctx.db.query("notes")
    .withIndex("by_library_highlight_and_deleted", (q) => q.eq("libraryId", libraryId).eq("highlightId", highlightId).eq("deletedAt", undefined))
    .take(MAX_NOTES_SHOWN);
  return notes
    .map((note) => ({ id: note.id, markdown: note.markdown, origin: note.origin, revision: note.revision, createdAt: note.createdAt, updatedAt: note.updatedAt }))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

async function highlightTagsOf(ctx: Reader, libraryId: string, highlightId: string) {
  const links = await ctx.db.query("highlightTags")
    .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", libraryId).eq("highlightId", highlightId)).take(100);
  const tags = [];
  for (const link of links) {
    const tag = await ctx.db.query("tags").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", link.tagId)).unique();
    if (tag && tag.deletedAt === undefined) tags.push({ id: tag.id, name: tag.name, ...(tag.color !== undefined ? { color: tag.color } : {}) });
  }
  return tags.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A passage as a browsing client shows it: its book, notes, and tags, and
 * whether it came from an import (and, for a web import, whether the reader
 * has edited it since). Null when the passage, or its book, is gone.
 */
async function passageView(ctx: Reader, libraryId: string, highlight: Highlight, books: Map<string, Book | null>) {
  if (highlight.deletedAt !== undefined || highlight.archived) return null;
  let owner = books.get(highlight.bookId);
  if (owner === undefined) {
    owner = await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", highlight.bookId)).unique();
    books.set(highlight.bookId, owner);
  }
  if (!owner || owner.deletedAt !== undefined || owner.archived) return null;
  const notes = await activeNotes(ctx, libraryId, highlight.id);
  const link = await ctx.db.query("importSourceAnnotations")
    .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", libraryId).eq("highlightId", highlight.id)).first();
  let editedSinceImport = false;
  if (link) {
    const attached = link.attachedNoteId ? notes.find((note) => note.id === link.attachedNoteId) : undefined;
    editedSinceImport = highlight.revision !== link.highlightRevision ||
      (attached !== undefined && attached.revision !== link.attachedNoteRevision);
  }
  return {
    id: highlight.id,
    bookId: highlight.bookId,
    bookTitle: owner.title,
    bookAuthors: owner.authors,
    text: highlight.text,
    ...(highlight.sourceLocation !== undefined ? { sourceLocation: highlight.sourceLocation } : {}),
    ...(highlight.sourceCreatedAt !== undefined ? { sourceCreatedAt: highlight.sourceCreatedAt } : {}),
    imported: highlight.sourceCreatedAt !== undefined || link !== null || notes.some((note) => note.origin === "import"),
    importedVersion: link ? { edited: editedSinceImport, lastImportedAt: link.updatedAt } : null,
    notes,
    tags: await highlightTagsOf(ctx, libraryId, highlight.id),
    revision: highlight.revision,
    createdAt: highlight.createdAt,
    updatedAt: highlight.updatedAt,
  };
}

type PassageView = NonNullable<Awaited<ReturnType<typeof passageView>>>;

function dayRange(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) {
    throw invalid("Date must be a valid calendar date");
  }
  return { start, end: start + DAY_MS };
}

function bounded(options: PaginationOptions): PaginationOptions {
  if (!Number.isSafeInteger(options.numItems) || options.numItems < 1 || options.numItems > MAX_PAGE_ITEMS) {
    throw invalid(`Page size must be between 1 and ${MAX_PAGE_ITEMS}`);
  }
  if (options.cursor !== null && options.cursor.length > 4_096) throw invalid("Pagination cursor is too long");
  return { numItems: options.numItems, cursor: options.cursor, maximumRowsRead: MAX_ROWS_SCANNED };
}

/**
 * Passages across the library, or in one book, newest or oldest first, by
 * last edit, or by relevance to a search. Filters: a tag, with or without
 * notes, typed in or imported, and a day (UTC) the passage was added or last
 * imported. A page may hold fewer items than asked while more remain; keep
 * loading until `isDone`.
 */
export const highlights = query({
  args: {
    libraryId: v.string(),
    bookId: v.optional(v.string()),
    search: v.optional(v.string()),
    tagId: v.optional(v.string()),
    notes: v.optional(v.union(v.literal("with"), v.literal("without"))),
    source: v.optional(v.union(v.literal("typed"), v.literal("imported"))),
    date: v.optional(v.string()),
    dateKind: v.optional(v.union(v.literal("added"), v.literal("imported"))),
    sort: v.optional(v.union(v.literal("newest"), v.literal("oldest"), v.literal("updated"), v.literal("relevance"))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const { libraryId, bookId, tagId } = args;
    const pagination = bounded(args.paginationOpts);
    const search = args.search?.normalize("NFKC").trim();
    if (search && new TextEncoder().encode(search).byteLength > 200) throw invalid("Search must be at most 200 bytes");
    const range = args.date ? dayRange(args.date) : undefined;
    const dateKind = args.dateKind ?? "added";
    const sort = args.sort ?? "oldest";
    const descending = sort === "newest" || sort === "updated";

    // Pick the index that narrows the most; check every other filter below.
    let driver: "search" | "tag" | "imported-day" | "highlights" = "highlights";
    let page: { page: (Highlight | null)[]; isDone: boolean; continueCursor: string };
    if (search) {
      driver = "search";
      page = await ctx.db.query("highlights")
        .withSearchIndex("search_text", (q) => {
          const scoped = q.search("text", search).eq("libraryId", libraryId).eq("deletedAt", undefined);
          return bookId ? scoped.eq("bookId", bookId) : scoped;
        })
        .paginate(pagination);
    } else if (tagId) {
      driver = "tag";
      const links = await ctx.db.query("highlightTags")
        .withIndex("by_library_and_tag", (q) => q.eq("libraryId", libraryId).eq("tagId", tagId))
        .order(descending ? "desc" : "asc")
        .paginate(pagination);
      page = { ...links, page: await Promise.all(links.page.map((link) => ctx.db.query("highlights")
        .withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", link.highlightId)).unique())) };
    } else if (range && dateKind === "imported") {
      driver = "imported-day";
      const links = await ctx.db.query("importSourceAnnotations")
        .withIndex("by_library_and_updated", (q) => q.eq("libraryId", libraryId).gte("updatedAt", range.start).lt("updatedAt", range.end))
        .order(descending ? "desc" : "asc")
        .paginate(pagination);
      page = { ...links, page: await Promise.all(links.page.map(async (link) => link.highlightId
        ? ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", link.highlightId!)).unique()
        : null)) };
    } else {
      const field = sort === "updated" && !range ? "updatedAt" : "createdAt";
      const ordered = bookId
        ? ctx.db.query("highlights").withIndex(
            field === "updatedAt" ? "by_library_book_deleted_and_updated" : "by_library_book_deleted_and_created",
            (q) => {
              const scoped = q.eq("libraryId", libraryId).eq("bookId", bookId).eq("deletedAt", undefined);
              return range ? scoped.gte(field, range.start).lt(field, range.end) : scoped;
            })
        : ctx.db.query("highlights").withIndex(
            field === "updatedAt" ? "by_library_deleted_and_updated" : "by_library_deleted_and_created",
            (q) => {
              const scoped = q.eq("libraryId", libraryId).eq("deletedAt", undefined);
              return range ? scoped.gte(field, range.start).lt(field, range.end) : scoped;
            });
      page = await ordered.order(descending ? "desc" : "asc").paginate(pagination);
    }

    const bookCache = new Map<string, Book | null>();
    const items: PassageView[] = [];
    for (const highlight of page.page) {
      if (!highlight) continue;
      if (bookId && highlight.bookId !== bookId) continue;
      if (range && dateKind === "added" && driver !== "highlights" &&
          (highlight.createdAt < range.start || highlight.createdAt >= range.end)) continue;
      if (tagId && driver !== "tag") {
        const tagged = await ctx.db.query("highlightTags")
          .withIndex("by_library_tag_and_highlight", (q) => q.eq("libraryId", libraryId).eq("tagId", tagId).eq("highlightId", highlight.id)).first();
        if (!tagged) continue;
      }
      const view = await passageView(ctx, libraryId, highlight, bookCache);
      if (!view) continue;
      if (range && dateKind === "imported" && driver !== "imported-day" &&
          (!view.importedVersion || view.importedVersion.lastImportedAt < range.start || view.importedVersion.lastImportedAt >= range.end)) continue;
      if (args.notes === "with" && view.notes.length === 0) continue;
      if (args.notes === "without" && view.notes.length > 0) continue;
      if (args.source === "typed" && view.imported) continue;
      if (args.source === "imported" && !view.imported) continue;
      items.push(view);
    }
    return { page: items, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** One passage, or null once it (or its book) is gone. */
export const highlight = query({
  args: { libraryId: v.string(), highlightId: v.string() },
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const found = await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", args.highlightId)).unique();
    return found ? passageView(ctx, args.libraryId, found, new Map()) : null;
  },
});

/** The tags and threads a passage is in. */
export const highlightMemberships = query({
  args: { libraryId: v.string(), highlightId: v.string() },
  returns: v.object({ tagIds: v.array(v.string()), threadIds: v.array(v.string()) }),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const tags = await ctx.db.query("highlightTags")
      .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", args.highlightId)).take(100);
    const threads = await ctx.db.query("threadHighlights")
      .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", args.libraryId).eq("highlightId", args.highlightId)).take(100);
    return { tagIds: tags.map((row) => row.tagId), threadIds: threads.map((row) => row.threadId) };
  },
});

export const collections = query({
  args: { libraryId: v.string() },
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const rows = await ctx.db.query("collections").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId)).take(MAX_LIST + 1);
    if (rows.length > MAX_LIST) tooLarge("collections");
    return rows.filter((row) => row.deletedAt === undefined)
      .map(({ id, name, description, bookCount, revision, updatedAt }) => ({ id, name, ...(description !== undefined ? { description } : {}), bookCount, revision, updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const tags = query({
  args: { libraryId: v.string() },
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const rows = await ctx.db.query("tags").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId)).take(MAX_LIST + 1);
    if (rows.length > MAX_LIST) tooLarge("tags");
    return rows.filter((row) => row.deletedAt === undefined)
      .map(({ id, name, color, bookCount, highlightCount, revision, updatedAt }) => ({ id, name, ...(color !== undefined ? { color } : {}), bookCount, highlightCount, revision, updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Threads, most recently changed first. */
export const threads = query({
  args: { libraryId: v.string() },
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const rows = await ctx.db.query("threads")
      .withIndex("by_library_deleted_and_id", (q) => q.eq("libraryId", args.libraryId).eq("deletedAt", undefined)).take(MAX_LIST + 1);
    if (rows.length > MAX_LIST) tooLarge("threads");
    return rows
      .map(({ id, name, description, passageCount, revision, updatedAt }) => ({ id, name, ...(description !== undefined ? { description } : {}), passageCount, revision, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  },
});

/** A thread with its passages in the order they were added, or null once deleted. */
export const thread = query({
  args: { libraryId: v.string(), threadId: v.string() },
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const found = await ctx.db.query("threads").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", args.threadId)).unique();
    if (!found || found.deletedAt !== undefined) return null;
    const links = await ctx.db.query("threadHighlights")
      .withIndex("by_library_and_thread", (q) => q.eq("libraryId", args.libraryId).eq("threadId", found.id)).take(MAX_THREAD_PASSAGES);
    links.sort((a, b) => a.addedAt - b.addedAt);
    const bookCache = new Map<string, Book | null>();
    const passages = [];
    for (const link of links) {
      const highlight = await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", link.highlightId)).unique();
      const view = highlight ? await passageView(ctx, args.libraryId, highlight, bookCache) : null;
      if (view) passages.push({ ...view, addedAt: link.addedAt });
    }
    return {
      id: found.id,
      name: found.name,
      ...(found.description !== undefined ? { description: found.description } : {}),
      passageCount: found.passageCount,
      revision: found.revision,
      updatedAt: found.updatedAt,
      passages,
    };
  },
});

/** A book's reading-status changes, newest first. */
export const readingHistory = query({
  args: { libraryId: v.string(), bookId: v.string() },
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const events = await ctx.db.query("readingStatusEvents")
      .withIndex("by_library_and_book_and_sequence", (q) => q.eq("libraryId", args.libraryId).eq("bookId", args.bookId))
      .order("desc").take(100);
    return events.map(({ id, status, source, changedAt, completedOn }) => ({ id, status, source, changedAt, ...(completedOn !== undefined ? { completedOn } : {}) }));
  },
});

const EXPORT_TABLES = [
  "books", "highlights", "notes", "collections", "tags", "threads", "collectionBooks", "bookTags",
  "highlightTags", "threadHighlights", "readingStatusEvents", "dailySelections",
] as const;
type ExportTable = typeof EXPORT_TABLES[number];
/** Bookkeeping that only this backend uses; an export leaves it out. */
const INTERNAL_FIELDS = new Set(["_id", "_creationTime", "libraryId", "dailyCandidateReady", "attachmentBoundsReady", "readingDataBytes", "normalizedName"]);

function exportQuery(ctx: Reader, table: ExportTable, libraryId: string) {
  const db = ctx.db;
  switch (table) {
    case "collectionBooks": return db.query(table).withIndex("by_library_and_collection", (q) => q.eq("libraryId", libraryId));
    case "bookTags": return db.query(table).withIndex("by_library_and_tag", (q) => q.eq("libraryId", libraryId));
    case "highlightTags": return db.query(table).withIndex("by_library_and_tag", (q) => q.eq("libraryId", libraryId));
    case "threadHighlights": return db.query(table).withIndex("by_library_and_thread", (q) => q.eq("libraryId", libraryId));
    case "books": return db.query(table).withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId));
    case "highlights": return db.query(table).withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId));
    case "notes": return db.query(table).withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId));
    case "collections": return db.query(table).withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId));
    case "tags": return db.query(table).withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId));
    case "threads": return db.query(table).withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId));
    case "readingStatusEvents": return db.query(table).withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId));
    case "dailySelections": return db.query(table).withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId));
  }
}

/**
 * One page of a table's rows as plain records, deleted ones included (with
 * `deletedAt`), for statistics and export. Page through each table until
 * `isDone`.
 */
export const exportPage = query({
  args: {
    libraryId: v.string(),
    table: v.union(...EXPORT_TABLES.map((table) => v.literal(table))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const { numItems, cursor } = args.paginationOpts;
    if (!Number.isSafeInteger(numItems) || numItems < 1 || numItems > 500) throw invalid("Page size must be between 1 and 500");
    const result = await exportQuery(ctx, args.table, args.libraryId)
      .paginate({ numItems, cursor, maximumBytesRead: 4 * 1024 * 1024 });
    const records = result.page.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !INTERNAL_FIELDS.has(key))));
    return { records, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});
