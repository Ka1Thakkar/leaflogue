import { v } from "convex/values";
const readingStatus = v.union(
  v.literal("unread"),
  v.literal("reading"),
  v.literal("finished"),
  v.literal("paused"),
);

export const createBookArgs = {
  libraryId: v.string(),
  id: v.string(),
  title: v.string(),
  authors: v.optional(v.array(v.string())),
  isbn13: v.optional(v.string()),
  // Optional details, for a book added from a catalog lookup in one step.
  description: v.optional(v.string()),
  publisher: v.optional(v.string()),
  series: v.optional(v.string()),
  seriesNumber: v.optional(v.string()),
  language: v.optional(v.string()),
  coverUrl: v.optional(v.string()),
};

export const updateBookMetadataArgs = {
  libraryId: v.string(),
  id: v.string(),
  expectedRevision: v.number(),
  title: v.string(),
  authors: v.array(v.string()),
  description: v.optional(v.string()),
  publisher: v.optional(v.string()),
  series: v.optional(v.string()),
  seriesNumber: v.optional(v.string()),
  language: v.optional(v.string()),
  isbn13: v.optional(v.string()),
  coverUrl: v.optional(v.string()),
};

export const createHighlightArgs = {
  libraryId: v.string(),
  id: v.string(),
  bookId: v.string(),
  text: v.string(),
  sourceLocation: v.optional(v.string()),
  noteId: v.optional(v.string()),
  noteMarkdown: v.optional(v.string()),
};

/**
 * What server code (an import) may also set. The public runtime functions keep
 * the narrower contracts above, so a client cannot label a note "import".
 */
export const internalCreateHighlightArgs = {
  ...createHighlightArgs,
  noteOrigin: v.optional(v.union(v.literal("reader"), v.literal("import"))),
  sourceCreatedAt: v.optional(v.number()),
};

export const updateHighlightArgs = {
  libraryId: v.string(),
  id: v.string(),
  bookId: v.string(),
  text: v.string(),
  sourceLocation: v.optional(v.string()),
  expectedRevision: v.number(),
};

export const createNoteArgs = {
  libraryId: v.string(),
  id: v.string(),
  bookId: v.string(),
  highlightId: v.optional(v.string()),
  markdown: v.string(),
  origin: v.optional(v.union(v.literal("reader"), v.literal("ai"))),
};

export const internalCreateNoteArgs = {
  ...createNoteArgs,
  origin: v.optional(v.union(v.literal("reader"), v.literal("ai"), v.literal("import"))),
};

export const updateNoteArgs = {
  libraryId: v.string(),
  id: v.string(),
  bookId: v.string(),
  markdown: v.string(),
  expectedRevision: v.number(),
};

export const deleteAnnotationArgs = {
  libraryId: v.string(),
  id: v.string(),
  bookId: v.string(),
  expectedRevision: v.number(),
};

export const setBookArchivedArgs = {
  libraryId: v.string(),
  id: v.string(),
  archived: v.boolean(),
  expectedRevision: v.number(),
};

export const setBookReadingStatusArgs = {
  libraryId: v.string(),
  id: v.string(),
  status: v.union(v.literal("unread"), v.literal("reading"), v.literal("finished"), v.literal("paused")),
  expectedRevision: v.number(),
};

export const setBookCompletionDateArgs = {
  libraryId: v.string(),
  id: v.string(),
  completedOn: v.optional(v.string()),
  expectedRevision: v.number(),
};

export const mergeBooksArgs = {
  libraryId: v.string(),
  sourceBookId: v.string(),
  targetBookId: v.string(),
  expectedSourceRevision: v.number(),
  expectedTargetRevision: v.number(),
};

export const syncedBookValidator = v.object({
  id: v.string(), title: v.string(), authors: v.array(v.string()),
  description: v.optional(v.string()), publisher: v.optional(v.string()),
  series: v.optional(v.string()), seriesNumber: v.optional(v.string()),
  language: v.optional(v.string()), isbn13: v.optional(v.string()),
  coverUrl: v.optional(v.string()), status: readingStatus,
  completedOn: v.optional(v.string()), archived: v.boolean(),
  createdAt: v.number(), updatedAt: v.number(), revision: v.number(),
  highlightCount: v.number(),
});

export const syncedHighlightValidator = v.object({
  id: v.string(), bookId: v.string(), text: v.string(),
  sourceLocation: v.optional(v.string()), sourceCreatedAt: v.optional(v.number()),
  createdAt: v.number(), updatedAt: v.number(), revision: v.number(),
});

export const syncedNoteValidator = v.object({
  id: v.string(), bookId: v.string(), highlightId: v.optional(v.string()),
  markdown: v.string(), origin: v.union(v.literal("reader"), v.literal("import"), v.literal("ai")),
  createdAt: v.number(), updatedAt: v.number(), revision: v.number(),
});

export const syncedCollectionValidator = v.object({
  id: v.string(), name: v.string(), description: v.optional(v.string()), bookCount: v.number(),
  createdAt: v.number(), updatedAt: v.number(), revision: v.number(),
});

export const syncedTagValidator = v.object({
  id: v.string(), name: v.string(), color: v.optional(v.string()), bookCount: v.number(),
  highlightCount: v.number(), createdAt: v.number(), updatedAt: v.number(), revision: v.number(),
});

export const syncedStatusEventValidator = v.object({
  id: v.string(), bookId: v.string(),
  status: v.union(v.literal("unread"), v.literal("reading"), v.literal("finished"), v.literal("paused")),
  source: v.union(v.literal("reader"), v.literal("merge"), v.literal("kindle"), v.literal("kobo"), v.literal("portable")),
  changedAt: v.number(), completedOn: v.optional(v.string()), bookRevision: v.number(),
});

export const syncedDailySelectionValidator = v.object({
  id: v.string(), localDay: v.string(), timezone: v.string(), highlightId: v.optional(v.string()),
  candidateDigest: v.string(), recentHighlightIds: v.array(v.string()),
  selectedAt: v.number(), updatedAt: v.number(), revision: v.number(), createdAt: v.number(),
});

export const syncedThreadValidator = v.object({
  id: v.string(), name: v.string(), description: v.optional(v.string()), passageCount: v.number(),
  createdAt: v.number(), updatedAt: v.number(), revision: v.number(),
});

/** The canonical `SyncedChange`: books and passages carry their complete
 * organization membership sets, and containers replay as their own entities. */
export const syncedChangeValidator = v.union(
  v.object({ entityType: v.literal("book"), operation: v.literal("upsert"), deviceId: v.string(), deviceRevision: v.number(), book: syncedBookValidator, collectionIds: v.array(v.string()), tagIds: v.array(v.string()), statusEvents: v.optional(v.array(syncedStatusEventValidator)) }),
  v.object({ entityType: v.literal("book"), operation: v.literal("tombstone"), deviceId: v.string(), deviceRevision: v.number(), entityId: v.string() }),
  v.object({ entityType: v.literal("highlight"), operation: v.literal("upsert"), deviceId: v.string(), deviceRevision: v.number(), highlight: syncedHighlightValidator, tagIds: v.array(v.string()), threadIds: v.array(v.string()) }),
  v.object({ entityType: v.literal("highlight"), operation: v.literal("tombstone"), deviceId: v.string(), deviceRevision: v.number(), entityId: v.string(), bookId: v.string() }),
  v.object({ entityType: v.literal("note"), operation: v.literal("upsert"), deviceId: v.string(), deviceRevision: v.number(), note: syncedNoteValidator }),
  v.object({ entityType: v.literal("note"), operation: v.literal("tombstone"), deviceId: v.string(), deviceRevision: v.number(), entityId: v.string(), bookId: v.string() }),
  v.object({ entityType: v.literal("collection"), operation: v.literal("upsert"), deviceId: v.string(), deviceRevision: v.number(), collection: syncedCollectionValidator }),
  v.object({ entityType: v.literal("collection"), operation: v.literal("tombstone"), deviceId: v.string(), deviceRevision: v.number(), entityId: v.string() }),
  v.object({ entityType: v.literal("tag"), operation: v.literal("upsert"), deviceId: v.string(), deviceRevision: v.number(), tag: syncedTagValidator }),
  v.object({ entityType: v.literal("tag"), operation: v.literal("tombstone"), deviceId: v.string(), deviceRevision: v.number(), entityId: v.string() }),
  v.object({ entityType: v.literal("thread"), operation: v.literal("upsert"), deviceId: v.string(), deviceRevision: v.number(), thread: syncedThreadValidator }),
  v.object({ entityType: v.literal("thread"), operation: v.literal("tombstone"), deviceId: v.string(), deviceRevision: v.number(), entityId: v.string() }),
  v.object({ entityType: v.literal("daily-selection"), operation: v.literal("upsert"), deviceId: v.string(), deviceRevision: v.number(), dailySelection: syncedDailySelectionValidator }),
  v.object({ entityType: v.literal("daily-selection"), operation: v.literal("tombstone"), deviceId: v.string(), deviceRevision: v.number(), entityId: v.string() }),
);

export const applySyncedChangeArgs = {
  libraryId: v.string(),
  change: syncedChangeValidator,
};

export const syncedChangeOutcomeValidator = v.union(v.literal("applied"), v.literal("superseded"));

export const noteValidator = v.object({
  id: v.string(),
  bookId: v.string(),
  highlightId: v.optional(v.string()),
  markdown: v.string(),
  origin: v.union(v.literal("reader"), v.literal("import"), v.literal("ai")),
  createdAt: v.number(),
  updatedAt: v.number(),
  revision: v.number(),
});

export const bookValidator = v.object({
  id: v.string(),
  title: v.string(),
  authors: v.array(v.string()),
  description: v.optional(v.string()),
  publisher: v.optional(v.string()),
  series: v.optional(v.string()),
  seriesNumber: v.optional(v.string()),
  language: v.optional(v.string()),
  isbn13: v.optional(v.string()),
  coverUrl: v.optional(v.string()),
  status: v.union(v.literal("unread"), v.literal("reading"), v.literal("finished"), v.literal("paused")),
  completedOn: v.optional(v.string()),
  archived: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
  revision: v.number(),
  highlightCount: v.number(),
});

export const readingStatusEventValidator = v.object({
  id: v.string(),
  bookId: v.string(),
  status: v.union(v.literal("unread"), v.literal("reading"), v.literal("finished"), v.literal("paused")),
  source: v.union(
    v.literal("reader"),
    v.literal("merge"),
    v.literal("kindle"),
    v.literal("kobo"),
    v.literal("portable"),
  ),
  changedAt: v.number(),
  completedOn: v.optional(v.string()),
  bookRevision: v.number(),
});

export const readingStatusChangeValidator = v.object({
  changed: v.boolean(),
  book: bookValidator,
  event: v.optional(readingStatusEventValidator),
});

export const highlightValidator = v.object({
  id: v.string(),
  bookId: v.string(),
  text: v.string(),
  sourceLocation: v.optional(v.string()),
  sourceCreatedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
  revision: v.number(),
});

export const annotationDeletionValidator = v.object({
  bookId: v.string(),
  bookRevision: v.number(),
  revision: v.number(),
  notesDeleted: v.number(),
  complete: v.boolean(),
});

export const archiveValidator = v.object({
  bookId: v.string(),
  archived: v.boolean(),
  revision: v.number(),
  updatedAt: v.number(),
});

export const mergeValidator = v.object({
  sourceBookId: v.string(),
  targetBookId: v.string(),
  highlightsMoved: v.number(),
  notesMoved: v.number(),
  sourceRevision: v.number(),
  targetRevision: v.number(),
});

export type CreateHighlightArgs = {
  readonly libraryId: string;
  readonly id: string;
  readonly bookId: string;
  readonly text: string;
  readonly sourceLocation?: string;
};

export type CreateBookArgs = {
  readonly libraryId: string;
  readonly id: string;
  readonly title: string;
  readonly authors?: readonly string[];
  readonly isbn13?: string;
};

export type UpdateBookMetadataArgs = {
  readonly libraryId: string;
  readonly id: string;
  readonly expectedRevision: number;
  readonly title: string;
  readonly authors: readonly string[];
  readonly description?: string;
  readonly publisher?: string;
  readonly series?: string;
  readonly seriesNumber?: string;
  readonly language?: string;
  readonly isbn13?: string;
  readonly coverUrl?: string;
};

export interface BookResult {
  readonly id: string;
  readonly title: string;
  readonly authors: string[];
  readonly description?: string;
  readonly publisher?: string;
  readonly series?: string;
  readonly seriesNumber?: string;
  readonly language?: string;
  readonly isbn13?: string;
  readonly coverUrl?: string;
  readonly status: "unread" | "reading" | "finished" | "paused";
  readonly completedOn?: string;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
  readonly highlightCount: number;
}

export type UpdateHighlightArgs = CreateHighlightArgs & { readonly expectedRevision: number };

export type CreateNoteArgs = {
  readonly libraryId: string;
  readonly id: string;
  readonly bookId: string;
  readonly highlightId?: string;
  readonly markdown: string;
};

export type UpdateNoteArgs = {
  readonly libraryId: string;
  readonly id: string;
  readonly bookId: string;
  readonly markdown: string;
  readonly expectedRevision: number;
};

export type DeleteAnnotationArgs = {
  readonly libraryId: string;
  readonly id: string;
  readonly bookId: string;
  readonly expectedRevision: number;
};

export interface AnnotationDeletionResult {
  readonly bookId: string;
  readonly bookRevision: number;
  readonly revision: number;
  readonly notesDeleted: number;
  /** False while a passage that predates the active-note bound still has notes
   *  to drain; the caller repeats the deletion with the returned revision. */
  readonly complete: boolean;
}

export type SetBookArchivedArgs = {
  readonly libraryId: string;
  readonly id: string;
  readonly archived: boolean;
  readonly expectedRevision: number;
};

export type SetBookReadingStatusArgs = {
  readonly libraryId: string;
  readonly id: string;
  readonly status: "unread" | "reading" | "finished" | "paused";
  readonly expectedRevision: number;
};

export type SetBookCompletionDateArgs = {
  readonly libraryId: string;
  readonly id: string;
  readonly completedOn?: string;
  readonly expectedRevision: number;
};

export interface ReadingStatusEventResult {
  readonly id: string;
  readonly bookId: string;
  readonly status: "unread" | "reading" | "finished" | "paused";
  readonly source: "reader" | "merge" | "kindle" | "kobo" | "portable";
  readonly changedAt: number;
  readonly completedOn?: string;
  readonly bookRevision: number;
}

export interface ReadingStatusChangeResult {
  readonly changed: boolean;
  readonly book: BookResult;
  readonly event?: ReadingStatusEventResult;
}

export type MergeBooksArgs = {
  readonly libraryId: string;
  readonly sourceBookId: string;
  readonly targetBookId: string;
  readonly expectedSourceRevision: number;
  readonly expectedTargetRevision: number;
};

export interface HighlightResult {
  readonly id: string;
  readonly bookId: string;
  readonly text: string;
  readonly sourceLocation?: string;
  readonly sourceCreatedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface NoteResult {
  readonly id: string;
  readonly bookId: string;
  readonly highlightId?: string;
  readonly markdown: string;
  readonly origin: "reader" | "import" | "ai";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface ArchiveResult {
  readonly bookId: string;
  readonly archived: boolean;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface MergeResult {
  readonly sourceBookId: string;
  readonly targetBookId: string;
  readonly highlightsMoved: number;
  readonly notesMoved: number;
  readonly sourceRevision: number;
  readonly targetRevision: number;
}

export type ApplySyncedChangeArgs = {
  readonly libraryId: string;
  readonly change: Record<string, unknown>;
};
