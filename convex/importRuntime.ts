import type { DataModelFromSchemaDefinition, DocumentByName, GenericDatabaseReader, GenericMutationCtx, MutationBuilder, QueryBuilder } from "convex/server";
import { makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { canonicalImportJson } from "@leaflogue/domain";
import { requireLibraryAccess } from "./accessControl";
import schema from "./schema";

/**
 * Import in a web client. The browser parses the reader's file with the same
 * importers as the desktop and sends the result here in batches: books first,
 * then annotations. Each batch is one transaction and is safe to send again,
 * so an interrupted import resumes where it stopped.
 *
 * The rules match the desktop's: a record seen before and unchanged at the
 * source is skipped; one the reader deleted stays deleted; one the reader
 * edited becomes a conflict to review; anything else is updated in place; new
 * records are added. "Edited" means its revision moved since the import last
 * wrote it, whichever device made the edit. Writes go through the same
 * library mutations as any web edit, so desktops pull them.
 */

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationContext = GenericMutationCtx<DataModel>;
const query = queryGeneric as QueryBuilder<DataModel, "public">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;

export const IMPORT_BATCH_LIMIT = 100;
const MAX_SOURCES = 50;
const MAX_TEXT_CHARACTERS = 100_000;
const MAX_NOTE_BYTES = 24 * 1024;
const MAX_LOCATION_CHARACTERS = 2_000;

const providerValidator = v.union(
  v.literal("kindle"), v.literal("kobo"), v.literal("koreader"), v.literal("pocketbook"),
  v.literal("tolino"), v.literal("boox"), v.literal("portable"),
);
const importBookValidator = v.object({
  providerRecordId: v.string(),
  title: v.string(),
  authors: v.array(v.string()),
  isbn13: v.optional(v.string()),
  description: v.optional(v.string()),
  publisher: v.optional(v.string()),
  series: v.optional(v.string()),
  seriesNumber: v.optional(v.string()),
  language: v.optional(v.string()),
  status: v.optional(v.union(v.literal("unread"), v.literal("reading"), v.literal("finished"))),
});
const importAnnotationValidator = v.object({
  providerRecordId: v.string(),
  bookProviderRecordId: v.string(),
  text: v.optional(v.string()),
  note: v.optional(v.string()),
  location: v.optional(v.string()),
  createdAt: v.optional(v.number()),
});
type ImportAnnotation = Infer<typeof importAnnotationValidator>;
type AnnotationLink = DocumentByName<DataModel, "importSourceAnnotations">;

const reference = <Args extends Record<string, unknown>, Result>(name: string) => makeFunctionReference<"mutation", Args, Result>(name);
const library = {
  createBook: reference<Record<string, unknown>, { revision: number }>("library:createBook"),
  setBookReadingStatus: reference<Record<string, unknown>, unknown>("library:setBookReadingStatus"),
  createHighlight: reference<Record<string, unknown>, { revision: number }>("library:createHighlight"),
  updateHighlight: reference<Record<string, unknown>, { revision: number }>("library:updateHighlight"),
  createNote: reference<Record<string, unknown>, { revision: number }>("library:createNote"),
  updateNote: reference<Record<string, unknown>, { revision: number }>("library:updateNote"),
};

function failure(message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "LEAFLOGUE_IMPORT_INVALID", message });
}

/** SHA-256 of the record's canonical JSON. */
async function fingerprint(kind: "book" | "annotation", value: object): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalImportJson(kind, value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireSource(ctx: MutationContext, libraryId: string, sourceId: string) {
  const source = await ctx.db.query("importSources").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", sourceId)).unique();
  if (!source) throw failure("That import source no longer exists");
  return source;
}

/** Whether an annotation can be stored at all; oversized records are skipped and counted. */
function storable(annotation: ImportAnnotation): boolean {
  const text = annotation.text?.trim();
  const note = annotation.note?.trim();
  if (!text && !note) return false;
  if (text && text.length > MAX_TEXT_CHARACTERS) return false;
  if (note && new TextEncoder().encode(note).byteLength > MAX_NOTE_BYTES) return false;
  return !annotation.location || annotation.location.length <= MAX_LOCATION_CHARACTERS;
}

export const listSources = query({
  args: { libraryId: v.string() },
  returns: v.array(v.object({ id: v.string(), provider: v.string(), name: v.string(), updatedAt: v.number() })),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const sources = await ctx.db.query("importSources").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId)).take(MAX_SOURCES);
    return sources.map(({ id, provider, name, updatedAt }) => ({ id, provider, name, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

/** A named source, such as "My Kobo Clara". Importing from the same source again updates rather than duplicates. */
export const createSource = mutation({
  args: { libraryId: v.string(), provider: providerValidator, name: v.string() },
  returns: v.object({ sourceId: v.string() }),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    const name = args.name.normalize("NFC").trim().replace(/\s+/gu, " ");
    if (!name || name.length > 200) throw failure("Give the source a name of up to 200 characters");
    const existing = await ctx.db.query("importSources").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId)).take(MAX_SOURCES);
    if (existing.length >= MAX_SOURCES) throw failure(`A library can have at most ${MAX_SOURCES} import sources`);
    const sourceId = crypto.randomUUID();
    const now = Date.now();
    await ctx.db.insert("importSources", { libraryId: args.libraryId, id: sourceId, provider: args.provider, name, createdAt: now, updatedAt: now });
    return { sourceId };
  },
});

/** One batch of books. A book seen before from this source is reused and keeps the reader's metadata. */
export const importBooks = mutation({
  args: { libraryId: v.string(), sourceId: v.string(), books: v.array(importBookValidator) },
  returns: v.object({ booksCreated: v.number(), booksReused: v.number() }),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    if (args.books.length > IMPORT_BATCH_LIMIT) throw failure(`Send at most ${IMPORT_BATCH_LIMIT} books at a time`);
    const source = await requireSource(ctx, args.libraryId, args.sourceId);
    const now = Date.now();
    const receipt = { booksCreated: 0, booksReused: 0 };
    for (const incoming of args.books) {
      const recordFingerprint = await fingerprint("book", incoming);
      const linked = await ctx.db.query("importSourceBooks").withIndex("by_source_record", (q) => q
        .eq("libraryId", args.libraryId).eq("sourceId", source.id).eq("providerRecordId", incoming.providerRecordId)).unique();
      if (linked) {
        const book = await ctx.db.query("books").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", linked.bookId)).unique();
        if (book && book.deletedAt === undefined) {
          await ctx.db.patch(linked._id, { fingerprint: recordFingerprint, updatedAt: now });
          receipt.booksReused += 1;
          continue;
        }
        await ctx.db.delete(linked._id);
      }
      const bookId = crypto.randomUUID();
      await ctx.runMutation(library.createBook, {
        libraryId: args.libraryId,
        id: bookId,
        title: incoming.title.trim() || "Untitled book",
        authors: incoming.authors,
        ...(incoming.isbn13 ? { isbn13: incoming.isbn13 } : {}),
        ...(incoming.description ? { description: incoming.description } : {}),
        ...(incoming.publisher ? { publisher: incoming.publisher } : {}),
        ...(incoming.series ? { series: incoming.series } : {}),
        ...(incoming.seriesNumber ? { seriesNumber: incoming.seriesNumber } : {}),
        ...(incoming.language ? { language: incoming.language } : {}),
      });
      if (incoming.status && incoming.status !== "unread") {
        await ctx.runMutation(library.setBookReadingStatus, { libraryId: args.libraryId, id: bookId, status: incoming.status, expectedRevision: 1 });
      }
      await ctx.db.insert("importSourceBooks", {
        libraryId: args.libraryId, sourceId: source.id, providerRecordId: incoming.providerRecordId, bookId, fingerprint: recordFingerprint, updatedAt: now,
      });
      receipt.booksCreated += 1;
    }
    await ctx.db.patch(source._id, { updatedAt: now });
    return receipt;
  },
});

async function currentRevisions(ctx: { readonly db: GenericDatabaseReader<DataModel> }, libraryId: string, link: Pick<AnnotationLink, "highlightId" | "attachedNoteId" | "noteId">) {
  const highlight = link.highlightId
    ? await ctx.db.query("highlights").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", link.highlightId!)).unique()
    : null;
  const attached = link.attachedNoteId
    ? await ctx.db.query("notes").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", link.attachedNoteId!)).unique()
    : null;
  const note = link.noteId
    ? await ctx.db.query("notes").withIndex("by_library_and_id", (q) => q.eq("libraryId", libraryId).eq("id", link.noteId!)).unique()
    : null;
  return { highlight, attached, note };
}

/**
 * Apply a source's version over records the reader has not changed (or has
 * chosen to replace). Returns the link's new revisions.
 */
async function applyIncoming(ctx: MutationContext, libraryId: string, link: AnnotationLink, incoming: ImportAnnotation) {
  const { highlight, attached, note } = await currentRevisions(ctx, libraryId, link);
  const result: Partial<Pick<AnnotationLink, "highlightRevision" | "attachedNoteId" | "attachedNoteRevision" | "noteRevision">> = {};
  if (highlight && incoming.text?.trim()) {
    const updated = await ctx.runMutation(library.updateHighlight, {
      libraryId, id: highlight.id, bookId: highlight.bookId, text: incoming.text,
      ...(incoming.location ? { sourceLocation: incoming.location } : {}),
      expectedRevision: highlight.revision,
    });
    result.highlightRevision = updated.revision;
    const body = incoming.note?.trim();
    if (body && attached && attached.deletedAt === undefined) {
      if (attached.markdown !== body) {
        result.attachedNoteRevision = (await ctx.runMutation(library.updateNote, { libraryId, id: attached.id, bookId: attached.bookId, markdown: body, expectedRevision: attached.revision })).revision;
      }
    } else if (body && !attached) {
      const noteId = crypto.randomUUID();
      const created = await ctx.runMutation(library.createNote, { libraryId, id: noteId, bookId: highlight.bookId, highlightId: highlight.id, markdown: body, origin: "import" });
      result.attachedNoteId = noteId;
      result.attachedNoteRevision = created.revision;
    }
  } else if (note && incoming.note?.trim() && note.markdown !== incoming.note.trim()) {
    result.noteRevision = (await ctx.runMutation(library.updateNote, { libraryId, id: note.id, bookId: note.bookId, markdown: incoming.note.trim(), expectedRevision: note.revision })).revision;
  }
  return result;
}

/** One batch of annotations, after their books. */
export const importAnnotations = mutation({
  args: { libraryId: v.string(), sourceId: v.string(), annotations: v.array(importAnnotationValidator) },
  returns: v.object({
    highlightsCreated: v.number(), notesCreated: v.number(), annotationsUpdated: v.number(),
    conflictsCreated: v.number(), unchanged: v.number(), skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    if (args.annotations.length > IMPORT_BATCH_LIMIT) throw failure(`Send at most ${IMPORT_BATCH_LIMIT} annotations at a time`);
    const source = await requireSource(ctx, args.libraryId, args.sourceId);
    const now = Date.now();
    const receipt = { highlightsCreated: 0, notesCreated: 0, annotationsUpdated: 0, conflictsCreated: 0, unchanged: 0, skipped: 0 };
    for (const incoming of args.annotations) {
      const bookLink = await ctx.db.query("importSourceBooks").withIndex("by_source_record", (q) => q
        .eq("libraryId", args.libraryId).eq("sourceId", source.id).eq("providerRecordId", incoming.bookProviderRecordId)).unique();
      if (!bookLink) throw failure("Send an annotation's book before the annotation");
      if (!storable(incoming)) {
        receipt.skipped += 1;
        continue;
      }
      const recordFingerprint = await fingerprint("annotation", incoming);
      const link = await ctx.db.query("importSourceAnnotations").withIndex("by_source_record", (q) => q
        .eq("libraryId", args.libraryId).eq("sourceId", source.id).eq("providerRecordId", incoming.providerRecordId)).unique();

      if (!link) {
        const base = { libraryId: args.libraryId, sourceId: source.id, providerRecordId: incoming.providerRecordId, bookId: bookLink.bookId, fingerprint: recordFingerprint, incoming: canonicalImportJson("annotation", incoming), updatedAt: now };
        if (incoming.text?.trim()) {
          const highlightId = crypto.randomUUID();
          const noteBody = incoming.note?.trim();
          const noteId = noteBody ? crypto.randomUUID() : undefined;
          const created = await ctx.runMutation(library.createHighlight, {
            libraryId: args.libraryId, id: highlightId, bookId: bookLink.bookId, text: incoming.text,
            ...(incoming.location ? { sourceLocation: incoming.location } : {}),
            ...(incoming.createdAt !== undefined ? { sourceCreatedAt: incoming.createdAt } : {}),
            ...(noteBody && noteId ? { noteId, noteMarkdown: noteBody, noteOrigin: "import" } : {}),
          });
          await ctx.db.insert("importSourceAnnotations", {
            ...base, highlightId, highlightRevision: created.revision,
            ...(noteId ? { attachedNoteId: noteId, attachedNoteRevision: 1 } : {}),
          });
          receipt.highlightsCreated += 1;
        } else {
          const noteId = crypto.randomUUID();
          const created = await ctx.runMutation(library.createNote, { libraryId: args.libraryId, id: noteId, bookId: bookLink.bookId, markdown: incoming.note!.trim(), origin: "import" });
          await ctx.db.insert("importSourceAnnotations", { ...base, noteId, noteRevision: created.revision });
          receipt.notesCreated += 1;
        }
        continue;
      }

      if (link.fingerprint === recordFingerprint) {
        // Seen again: the record's "last imported" day moves on.
        await ctx.db.patch(link._id, { updatedAt: now });
        receipt.unchanged += 1;
        continue;
      }
      const { highlight, attached, note } = await currentRevisions(ctx, args.libraryId, link);
      const target = link.highlightId ? highlight : note;
      if (!target || target.deletedAt !== undefined) {
        // The reader deleted it: a changed source neither restores it nor raises a conflict.
        await ctx.db.patch(link._id, { fingerprint: recordFingerprint, incoming: canonicalImportJson("annotation", incoming), updatedAt: now });
        receipt.unchanged += 1;
        continue;
      }
      const edited = link.highlightId
        ? highlight!.revision !== link.highlightRevision || (attached !== null && attached.deletedAt === undefined && attached.revision !== link.attachedNoteRevision)
        : note!.revision !== link.noteRevision;
      if (edited) {
        const pending = await ctx.db.query("importConflicts").withIndex("by_source_record", (q) => q
          .eq("libraryId", args.libraryId).eq("sourceId", source.id).eq("providerRecordId", incoming.providerRecordId)).collect();
        const open = pending.find((conflict) => conflict.status === "pending");
        if (open) {
          await ctx.db.patch(open._id, { incoming: canonicalImportJson("annotation", incoming), incomingFingerprint: recordFingerprint, updatedAt: now });
        } else {
          await ctx.db.insert("importConflicts", {
            libraryId: args.libraryId, id: crypto.randomUUID(), sourceId: source.id, providerRecordId: incoming.providerRecordId,
            bookId: link.bookId, previous: link.incoming, incoming: canonicalImportJson("annotation", incoming), incomingFingerprint: recordFingerprint,
            status: "pending", createdAt: now, updatedAt: now,
          });
          receipt.conflictsCreated += 1;
        }
        continue;
      }
      const revisions = await applyIncoming(ctx, args.libraryId, link, incoming);
      await ctx.db.patch(link._id, { ...revisions, fingerprint: recordFingerprint, incoming: canonicalImportJson("annotation", incoming), updatedAt: now });
      receipt.annotationsUpdated += 1;
    }
    await ctx.db.patch(source._id, { updatedAt: now });
    return receipt;
  },
});

export const listConflicts = query({
  args: { libraryId: v.string() },
  returns: v.array(v.object({
    id: v.string(), sourceId: v.string(), sourceName: v.string(), bookId: v.string(),
    previous: v.string(), incoming: v.string(), createdAt: v.number(),
  })),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const conflicts = await ctx.db.query("importConflicts").withIndex("by_library_and_status", (q) => q.eq("libraryId", args.libraryId).eq("status", "pending")).take(200);
    const names = new Map<string, string>();
    const result = [];
    for (const conflict of conflicts) {
      if (!names.has(conflict.sourceId)) {
        const source = await ctx.db.query("importSources").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", conflict.sourceId)).unique();
        names.set(conflict.sourceId, source?.name ?? "Removed source");
      }
      result.push({
        id: conflict.id, sourceId: conflict.sourceId, sourceName: names.get(conflict.sourceId)!, bookId: conflict.bookId,
        previous: conflict.previous, incoming: conflict.incoming, createdAt: conflict.createdAt,
      });
    }
    return result;
  },
});

/** Keep the reader's version, or take the source's. Either way the next import starts from here. */
export const resolveConflict = mutation({
  args: { libraryId: v.string(), conflictId: v.string(), resolution: v.union(v.literal("keep-local"), v.literal("accept-incoming")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    const conflict = await ctx.db.query("importConflicts").withIndex("by_library_and_id", (q) => q.eq("libraryId", args.libraryId).eq("id", args.conflictId)).unique();
    if (!conflict || conflict.status !== "pending") throw failure("That conflict has already been resolved");
    const link = await ctx.db.query("importSourceAnnotations").withIndex("by_source_record", (q) => q
      .eq("libraryId", args.libraryId).eq("sourceId", conflict.sourceId).eq("providerRecordId", conflict.providerRecordId)).unique();
    const now = Date.now();
    if (link) {
      const incoming = JSON.parse(conflict.incoming) as ImportAnnotation;
      const { highlight, attached, note } = await currentRevisions(ctx, args.libraryId, link);
      let revisions: Partial<AnnotationLink> = {
        ...(highlight ? { highlightRevision: highlight.revision } : {}),
        ...(attached ? { attachedNoteRevision: attached.revision } : {}),
        ...(note ? { noteRevision: note.revision } : {}),
      };
      if (args.resolution === "accept-incoming") revisions = { ...revisions, ...(await applyIncoming(ctx, args.libraryId, link, incoming)) };
      await ctx.db.patch(link._id, { ...revisions, fingerprint: conflict.incomingFingerprint, incoming: conflict.incoming, updatedAt: now });
    }
    await ctx.db.patch(conflict._id, { status: args.resolution === "keep-local" ? "kept" : "accepted", updatedAt: now });
    return null;
  },
});

/** The passage as the last import wrote it, when it came through a web import here. */
async function importedLink(ctx: { readonly db: GenericDatabaseReader<DataModel> }, libraryId: string, highlightId: string) {
  return ctx.db.query("importSourceAnnotations")
    .withIndex("by_library_and_highlight", (q) => q.eq("libraryId", libraryId).eq("highlightId", highlightId)).first();
}

/**
 * What an imported passage looked like when it was last imported, and whether
 * the reader has changed it since. Null for a passage typed in by hand or
 * imported on a desktop, whose import history stays on that desktop.
 */
export const importedVersion = query({
  args: { libraryId: v.string(), highlightId: v.string() },
  returns: v.union(v.null(), v.object({
    text: v.string(), note: v.optional(v.string()), location: v.optional(v.string()), edited: v.boolean(),
  })),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "read");
    const link = await importedLink(ctx, args.libraryId, args.highlightId);
    if (!link) return null;
    const incoming = JSON.parse(link.incoming) as ImportAnnotation;
    if (!incoming.text?.trim()) return null;
    const { highlight, attached } = await currentRevisions(ctx, args.libraryId, link);
    if (!highlight || highlight.deletedAt !== undefined) return null;
    const edited = highlight.revision !== link.highlightRevision ||
      (attached !== null && attached.deletedAt === undefined && attached.revision !== link.attachedNoteRevision);
    return {
      text: incoming.text,
      ...(incoming.note?.trim() ? { note: incoming.note.trim() } : {}),
      ...(incoming.location ? { location: incoming.location } : {}),
      edited,
    };
  },
});

/** Put an imported passage (and its imported note) back as the last import wrote it. */
export const resetToImported = mutation({
  args: { libraryId: v.string(), highlightId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireLibraryAccess(ctx, args.libraryId, "write");
    const link = await importedLink(ctx, args.libraryId, args.highlightId);
    if (!link) throw failure("This passage has no imported version to go back to");
    const incoming = JSON.parse(link.incoming) as ImportAnnotation;
    const { highlight } = await currentRevisions(ctx, args.libraryId, link);
    if (!highlight || highlight.deletedAt !== undefined || !incoming.text?.trim()) throw failure("That passage no longer exists");
    const revisions = await applyIncoming(ctx, args.libraryId, link, incoming);
    await ctx.db.patch(link._id, { ...revisions, updatedAt: Date.now() });
    return null;
  },
});
