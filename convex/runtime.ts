import type {
  DataModelFromSchemaDefinition,
  FunctionReference,
  MutationBuilder,
} from "convex/server";
import { makeFunctionReference, mutationGeneric } from "convex/server";
import { requireLibraryAccess } from "./accessControl";
import {
  annotationDeletionValidator,
  type AnnotationDeletionResult,
  deleteAnnotationArgs,
  type DeleteAnnotationArgs,
  archiveValidator,
  bookValidator,
  createBookArgs,
  type BookResult,
  type CreateBookArgs,
  createHighlightArgs,
  type CreateHighlightArgs,
  createNoteArgs,
  type CreateNoteArgs,
  highlightValidator,
  mergeBooksArgs,
  type MergeBooksArgs,
  mergeValidator,
  noteValidator,
  readingStatusChangeValidator,
  setBookArchivedArgs,
  setBookCompletionDateArgs,
  setBookReadingStatusArgs,
  type SetBookArchivedArgs,
  type SetBookCompletionDateArgs,
  type SetBookReadingStatusArgs,
  updateBookMetadataArgs,
  type UpdateBookMetadataArgs,
  updateHighlightArgs,
  type UpdateHighlightArgs,
  updateNoteArgs,
  type UpdateNoteArgs,
  type ArchiveResult,
  type HighlightResult,
  type MergeResult,
  type NoteResult,
  type ReadingStatusChangeResult,
} from "./libraryContracts";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

const internal = {
  createBook: internalMutationReference<CreateBookArgs, BookResult>("library:createBook"),
  updateBookMetadata: internalMutationReference<UpdateBookMetadataArgs, BookResult>("library:updateBookMetadata"),
  createHighlight: internalMutationReference<CreateHighlightArgs, HighlightResult>("library:createHighlight"),
  updateHighlight: internalMutationReference<UpdateHighlightArgs, HighlightResult>("library:updateHighlight"),
  createNote: internalMutationReference<CreateNoteArgs, NoteResult>("library:createNote"),
  updateNote: internalMutationReference<UpdateNoteArgs, NoteResult>("library:updateNote"),
  deleteHighlight: internalMutationReference<DeleteAnnotationArgs, AnnotationDeletionResult>("library:deleteHighlight"),
  deleteNote: internalMutationReference<DeleteAnnotationArgs, AnnotationDeletionResult>("library:deleteNote"),
  setBookArchived: internalMutationReference<SetBookArchivedArgs, ArchiveResult>("library:setBookArchived"),
  setBookCompletionDate: internalMutationReference<SetBookCompletionDateArgs, BookResult>("library:setBookCompletionDate"),
  setBookReadingStatus: internalMutationReference<SetBookReadingStatusArgs, ReadingStatusChangeResult>("library:setBookReadingStatus"),
  mergeBooks: internalMutationReference<MergeBooksArgs, MergeResult>("library:mergeBooks"),
};

export const createBook = mutation({
  args: createBookArgs,
  returns: bookValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.createBook, args);
  },
});

export const updateBookMetadata = mutation({
  args: updateBookMetadataArgs,
  returns: bookValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.updateBookMetadata, args);
  },
});

export const createHighlight = mutation({
  args: createHighlightArgs,
  returns: highlightValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.createHighlight, args);
  },
});

export const deleteHighlight = mutation({
  args: deleteAnnotationArgs,
  returns: annotationDeletionValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.deleteHighlight, args);
  },
});

export const deleteNote = mutation({
  args: deleteAnnotationArgs,
  returns: annotationDeletionValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.deleteNote, args);
  },
});

export const updateHighlight = mutation({
  args: updateHighlightArgs,
  returns: highlightValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.updateHighlight, args);
  },
});

export const createNote = mutation({
  args: createNoteArgs,
  returns: noteValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.createNote, args);
  },
});

export const updateNote = mutation({
  args: updateNoteArgs,
  returns: noteValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.updateNote, args);
  },
});

export const setBookArchived = mutation({
  args: setBookArchivedArgs,
  returns: archiveValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.setBookArchived, args);
  },
});

export const setBookReadingStatus = mutation({
  args: setBookReadingStatusArgs,
  returns: readingStatusChangeValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.setBookReadingStatus, args);
  },
});

export const setBookCompletionDate = mutation({
  args: setBookCompletionDateArgs,
  returns: bookValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.setBookCompletionDate, args);
  },
});

export const mergeBooks = mutation({
  args: mergeBooksArgs,
  returns: mergeValidator,
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    return ctx.runMutation(internal.mergeBooks, args);
  },
});

function internalMutationReference<Args extends Record<string, unknown>, Result>(
  name: string,
): FunctionReference<"mutation", "internal", Args, Result> {
  return makeFunctionReference<"mutation", Args, Result>(name) as unknown as FunctionReference<"mutation", "internal", Args, Result>;
}
