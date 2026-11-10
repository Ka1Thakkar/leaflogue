import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  PaginationOptions,
  QueryBuilder,
} from "convex/server";
import { queryGeneric } from "convex/server";
import { requireLibraryAccess } from "./accessControl";
import {
  bookPageValidator,
  changePageValidator,
  highlightPageValidator,
  listAnnotationsArgs,
  listBooksArgs,
  listChangesArgs,
  notePageValidator,
} from "./readContracts";
import schema from "./schema";

const MAX_PAGE_ITEMS = 100;
const MAX_PAGE_ROWS_READ = 100;
const MAX_PAGE_BYTES_READ = 1024 * 1024;
const MAX_CURSOR_LENGTH = 4_096;

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;

export const listBooks = query({
  args: listBooksArgs,
  returns: bookPageValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const pagination = boundedPagination(args.paginationOpts);
    const page = args.includeArchived === true
      ? await ctx.db.query("books")
          .withIndex("by_library_and_id", (builder) => builder.eq("libraryId", args.libraryId))
          .order("asc")
          .paginate(pagination)
      : await ctx.db.query("books")
          .withIndex("by_library_archived_and_id", (builder) => builder
            .eq("libraryId", args.libraryId)
            .eq("archived", false))
          .order("asc")
          .paginate(pagination);
    return { ...page, page: page.page.map(mapBook) };
  },
});

export const listHighlights = query({
  args: listAnnotationsArgs,
  returns: highlightPageValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const page = await ctx.db.query("highlights")
      .withIndex("by_library_and_book", (builder) => builder
        .eq("libraryId", args.libraryId)
        .eq("bookId", args.bookId))
      .order("asc")
      .paginate(boundedPagination(args.paginationOpts));
    return { ...page, page: page.page.map(mapHighlight) };
  },
});

export const listNotes = query({
  args: listAnnotationsArgs,
  returns: notePageValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const page = await ctx.db.query("notes")
      .withIndex("by_library_and_book", (builder) => builder
        .eq("libraryId", args.libraryId)
        .eq("bookId", args.bookId))
      .order("asc")
      .paginate(boundedPagination(args.paginationOpts));
    return { ...page, page: page.page.map(mapNote) };
  },
});

export const listChanges = query({
  args: listChangesArgs,
  returns: changePageValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const library = await ctx.db.query("libraries")
      .withIndex("by_external_id", (builder) => builder.eq("externalId", args.libraryId))
      .unique();
    if (!library) throw new Error("Library no longer exists");
    const generation = requireGeneration(library.syncGeneration ?? 1);
    const afterSequence = requiredSequence(args.cursor.afterSequence);
    const limit = requiredLimit(args.limit);
    if (args.cursor.generation !== generation || afterSequence > library.nextChangeSequence) {
      return {
        page: [],
        nextCursor: { generation, afterSequence: 0 },
        isDone: false,
        resetRequired: true,
      };
    }
    const rows = await ctx.db.query("syncChanges")
      .withIndex("by_library_and_sequence", (builder) => builder
        .eq("libraryId", args.libraryId)
        .gt("sequence", afterSequence))
      .order("asc")
      .take(limit + 1);
    const isDone = rows.length <= limit;
    const page = rows.slice(0, limit).map((row) => ({
      sequence: row.sequence,
      entityType: row.entityType,
      entityId: row.entityId,
      revision: row.revision,
      changedAt: row.changedAt,
    }));
    return {
      page,
      nextCursor: { generation, afterSequence: page.at(-1)?.sequence ?? afterSequence },
      isDone,
      resetRequired: false,
    };
  },
});

function boundedPagination(options: PaginationOptions): PaginationOptions {
  if (!Number.isSafeInteger(options.numItems) || options.numItems < 1 || options.numItems > MAX_PAGE_ITEMS) {
    throw new Error(`Page size must be between 1 and ${MAX_PAGE_ITEMS}`);
  }
  requireCursor(options.cursor);
  if (options.endCursor !== undefined && options.endCursor !== null) {
    throw new Error("Pagination end cursors are not supported by this API");
  }
  return {
    numItems: options.numItems,
    cursor: options.cursor,
    maximumRowsRead: MAX_PAGE_ROWS_READ,
    maximumBytesRead: MAX_PAGE_BYTES_READ,
  };
}

function requireCursor(cursor: string | null): void {
  if (cursor !== null && cursor.length > MAX_CURSOR_LENGTH) throw new Error("Pagination cursor is too long");
}

function requiredSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Change sequence is invalid");
  return value;
}

function requireGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Library sync generation is invalid");
  return value;
}

function requiredLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_ITEMS) {
    throw new Error(`Page size must be between 1 and ${MAX_PAGE_ITEMS}`);
  }
  return value;
}

function mapBook(book: DocumentByName<DataModel, "books">) {
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
    ...(book.deletedAt !== undefined ? { deletedAt: book.deletedAt } : {}),
    highlightCount: book.highlightCount,
    noteCount: book.noteCount,
    revision: book.revision,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
}

function mapHighlight(highlight: DocumentByName<DataModel, "highlights">) {
  return {
    id: highlight.id,
    bookId: highlight.bookId,
    text: highlight.text,
    ...(highlight.sourceLocation !== undefined ? { sourceLocation: highlight.sourceLocation } : {}),
    ...(highlight.sourceCreatedAt !== undefined ? { sourceCreatedAt: highlight.sourceCreatedAt } : {}),
    archived: highlight.archived,
    ...(highlight.deletedAt !== undefined ? { deletedAt: highlight.deletedAt } : {}),
    revision: highlight.revision,
    createdAt: highlight.createdAt,
    updatedAt: highlight.updatedAt,
  };
}

function mapNote(note: DocumentByName<DataModel, "notes">) {
  return {
    id: note.id,
    bookId: note.bookId,
    ...(note.highlightId !== undefined ? { highlightId: note.highlightId } : {}),
    markdown: note.markdown,
    origin: note.origin,
    ...(note.deletedAt !== undefined ? { deletedAt: note.deletedAt } : {}),
    revision: note.revision,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}
