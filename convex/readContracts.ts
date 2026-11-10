import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";

export const readingStatusValidator = v.union(
  v.literal("unread"),
  v.literal("reading"),
  v.literal("finished"),
  v.literal("paused"),
);

export const bookReadValidator = v.object({
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
  status: readingStatusValidator,
  completedOn: v.optional(v.string()),
  archived: v.boolean(),
  deletedAt: v.optional(v.number()),
  highlightCount: v.number(),
  noteCount: v.number(),
  revision: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const highlightReadValidator = v.object({
  id: v.string(),
  bookId: v.string(),
  text: v.string(),
  sourceLocation: v.optional(v.string()),
  sourceCreatedAt: v.optional(v.number()),
  archived: v.boolean(),
  deletedAt: v.optional(v.number()),
  revision: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const noteReadValidator = v.object({
  id: v.string(),
  bookId: v.string(),
  highlightId: v.optional(v.string()),
  markdown: v.string(),
  origin: v.union(v.literal("reader"), v.literal("import"), v.literal("ai")),
  deletedAt: v.optional(v.number()),
  revision: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const syncChangeValidator = v.object({
  sequence: v.number(),
  entityType: v.union(v.literal("book"), v.literal("highlight"), v.literal("note"), v.literal("collection"), v.literal("tag"), v.literal("thread"), v.literal("daily-selection")),
  entityId: v.string(),
  revision: v.number(),
  changedAt: v.number(),
});

export const listBooksArgs = {
  libraryId: v.string(),
  includeArchived: v.optional(v.boolean()),
  paginationOpts: paginationOptsValidator,
};

export const listAnnotationsArgs = {
  libraryId: v.string(),
  bookId: v.string(),
  paginationOpts: paginationOptsValidator,
};

export const listChangesArgs = {
  libraryId: v.string(),
  cursor: v.object({ generation: v.number(), afterSequence: v.number() }),
  limit: v.number(),
};

export const bookPageValidator = paginationResultValidator(bookReadValidator);
export const highlightPageValidator = paginationResultValidator(highlightReadValidator);
export const notePageValidator = paginationResultValidator(noteReadValidator);
export const changePageValidator = v.object({
  page: v.array(syncChangeValidator),
  nextCursor: v.object({ generation: v.number(), afterSequence: v.number() }),
  isDone: v.boolean(),
  resetRequired: v.boolean(),
});
