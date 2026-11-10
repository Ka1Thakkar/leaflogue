import { AI_PROVIDER_IDS } from "@leaflogue/ai";
import { PUBLICATION_REPORT_REASONS } from "@leaflogue/domain";
import { PostgresLibraryMutations } from "@leaflogue/remote";
import * as ai from "./ai";
import * as browse from "./browse";
import * as catalog from "./catalog";
import * as dashboards from "./dashboards";
import { requireUser, type RequestContext } from "./context";
import { ServerError } from "./errors";
import * as imports from "./imports";
import { myLibraries, requireLibraryAccess } from "./libraries";
import * as publications from "./publications";
import * as reading from "./reading";
import { array, boolean, literal, nullable, number, object, optional, paginationOpts, string, type Check } from "./validate";

/**
 * The API, under the same names and argument shapes as the Convex backend's
 * public functions, so one web client works against either. Every function
 * names its access: "public" needs no sign-in, "signed-in" needs a session,
 * and "read"/"write" also need that access to the `libraryId` it is given.
 */

type Access = "public" | "signed-in" | "read" | "write";

interface ServerFunction {
  readonly access: Access;
  readonly args: Check<Record<string, unknown>>;
  readonly handler: (context: RequestContext, args: never) => Promise<unknown>;
}

function define<Args extends Record<string, unknown>>(
  access: Access,
  args: Check<Args>,
  handler: (context: RequestContext, args: Args) => Promise<unknown>,
): ServerFunction {
  return { access, args, handler: handler as ServerFunction["handler"] };
}

const id = string(64);
const text = string(200_000);
const libraryId = id;
const optionalText = optional(text);

/** Library mutations take the Convex arguments minus `libraryId`. */
function mutation<Args extends { readonly libraryId: string }>(
  args: Check<Args>,
  run: (mutations: PostgresLibraryMutations, input: Omit<Args, "libraryId">) => Promise<unknown>,
): ServerFunction {
  return define("write", args, async (context, { libraryId: library, ...input }) => {
    const result = await run(new PostgresLibraryMutations(context.client, library), input);
    return result ?? null;
  });
}

const bookDetails = {
  description: optionalText,
  publisher: optionalText,
  series: optionalText,
  seriesNumber: optionalText,
  language: optionalText,
  coverUrl: optionalText,
};
const organization = { libraryId, id, name: text, description: optionalText };
const tag = { libraryId, id, name: text, color: optionalText };

export const FUNCTIONS: Readonly<Record<string, ServerFunction>> = {
  "access:myLibraries": define("signed-in", object({}), async (context) => myLibraries(context.client, requireUser(context).userId)),

  "reading:listBooks": define("read", object({ libraryId, includeArchived: optional(boolean), paginationOpts }),
    async (context, args) => reading.listBooks(context.client, args.libraryId, args)),
  "reading:listHighlights": define("read", object({ libraryId, bookId: id, paginationOpts }),
    async (context, args) => reading.listHighlights(context.client, args.libraryId, args)),
  "reading:listNotes": define("read", object({ libraryId, bookId: id, paginationOpts }),
    async (context, args) => reading.listNotes(context.client, args.libraryId, args)),
  "reading:listChanges": define("read", object({ libraryId, cursor: object({ generation: number, afterSequence: number }), limit: number }),
    async (context, args) => reading.listChanges(context.client, args.libraryId, args)),

  "browse:books": define("read", object({ libraryId }), async (context, args) => browse.books(context.client, args.libraryId)),
  "browse:book": define("read", object({ libraryId, bookId: id }), async (context, args) => browse.book(context.client, args.libraryId, args.bookId)),
  "browse:highlights": define("read", object({
    libraryId,
    bookId: optional(id),
    search: optional(string(1_000)),
    tagId: optional(id),
    notes: optional(literal("with", "without")),
    source: optional(literal("typed", "imported")),
    date: optional(string(10)),
    dateKind: optional(literal("added", "imported")),
    sort: optional(literal("newest", "oldest", "updated", "relevance")),
    paginationOpts,
  }), async (context, { libraryId: library, ...args }) => browse.highlights(context.client, library, args)),
  "browse:highlight": define("read", object({ libraryId, highlightId: id }), async (context, args) => browse.highlight(context.client, args.libraryId, args.highlightId)),
  "browse:highlightMemberships": define("read", object({ libraryId, highlightId: id }),
    async (context, args) => browse.highlightMemberships(context.client, args.libraryId, args.highlightId)),
  "browse:collections": define("read", object({ libraryId }), async (context, args) => browse.collections(context.client, args.libraryId)),
  "browse:tags": define("read", object({ libraryId }), async (context, args) => browse.tags(context.client, args.libraryId)),
  "browse:threads": define("read", object({ libraryId }), async (context, args) => browse.threads(context.client, args.libraryId)),
  "browse:thread": define("read", object({ libraryId, threadId: id }), async (context, args) => browse.thread(context.client, args.libraryId, args.threadId)),
  "browse:readingHistory": define("read", object({ libraryId, bookId: id }), async (context, args) => browse.readingHistory(context.client, args.libraryId, args.bookId)),
  "browse:exportPage": define("read", object({ libraryId, table: literal(...browse.EXPORT_TABLES), paginationOpts }),
    async (context, { libraryId: library, ...args }) => browse.exportPage(context.client, library, args)),

  "runtime:createBook": mutation(object({ libraryId, id, title: text, authors: optional(array(text, 50)), isbn13: optionalText, ...bookDetails }),
    (mutations, input) => mutations.createBook(input as never)),
  "runtime:updateBookMetadata": mutation(object({ libraryId, id, expectedRevision: number, title: text, authors: array(text, 50), isbn13: optionalText, ...bookDetails }),
    (mutations, input) => mutations.updateBookMetadata(input as never)),
  "runtime:createHighlight": mutation(object({ libraryId, id, bookId: id, text, sourceLocation: optionalText, noteId: optional(id), noteMarkdown: optionalText }),
    (mutations, input) => mutations.createHighlight(input as never)),
  "runtime:updateHighlight": mutation(object({ libraryId, id, bookId: id, text, sourceLocation: optionalText, expectedRevision: number }),
    (mutations, input) => mutations.updateHighlight(input as never)),
  "runtime:deleteHighlight": mutation(object({ libraryId, id, bookId: id, expectedRevision: number }),
    (mutations, input) => mutations.deleteHighlight(input as never)),
  "runtime:createNote": mutation(object({ libraryId, id, bookId: id, highlightId: optional(id), markdown: text, origin: optional(literal("reader", "ai")) }),
    (mutations, input) => mutations.createNote(input as never)),
  "runtime:updateNote": mutation(object({ libraryId, id, bookId: id, markdown: text, expectedRevision: number }),
    (mutations, input) => mutations.updateNote(input as never)),
  "runtime:deleteNote": mutation(object({ libraryId, id, bookId: id, expectedRevision: number }),
    (mutations, input) => mutations.deleteNote(input as never)),
  "runtime:setBookArchived": mutation(object({ libraryId, id, archived: boolean, expectedRevision: number }),
    (mutations, input) => mutations.setBookArchived(input as never)),
  "runtime:setBookReadingStatus": mutation(object({ libraryId, id, status: literal("unread", "reading", "finished", "paused"), expectedRevision: number }),
    (mutations, input) => mutations.setBookReadingStatus(input as never)),
  "runtime:setBookCompletionDate": mutation(object({ libraryId, id, completedOn: optional(string(10)), expectedRevision: number }),
    (mutations, input) => mutations.setBookCompletionDate(input as never)),
  "runtime:mergeBooks": mutation(object({ libraryId, sourceBookId: id, targetBookId: id, expectedSourceRevision: number, expectedTargetRevision: number }),
    (mutations, input) => mutations.mergeBooks(input as never)),

  "organizationRuntime:createCollection": mutation(object(organization), (mutations, input) => mutations.createCollection(input as never)),
  "organizationRuntime:updateCollection": mutation(object({ ...organization, expectedRevision: number }), (mutations, input) => mutations.updateCollection(input as never)),
  "organizationRuntime:deleteCollection": mutation(object({ libraryId, id, expectedRevision: number }), (mutations, input) => mutations.deleteCollection(input as never)),
  "organizationRuntime:createTag": mutation(object(tag), (mutations, input) => mutations.createTag(input as never)),
  "organizationRuntime:updateTag": mutation(object({ ...tag, expectedRevision: number }), (mutations, input) => mutations.updateTag(input as never)),
  "organizationRuntime:deleteTag": mutation(object({ libraryId, id, expectedRevision: number }), (mutations, input) => mutations.deleteTag(input as never)),
  "organizationRuntime:setBookCollectionMembership": mutation(object({ libraryId, bookId: id, collectionId: id, included: boolean }),
    (mutations, input) => mutations.setBookCollectionMembership(input as never)),
  "organizationRuntime:setBookTagMembership": mutation(object({ libraryId, bookId: id, tagId: id, included: boolean }),
    (mutations, input) => mutations.setBookTagMembership(input as never)),
  "organizationRuntime:setHighlightTagMembership": mutation(object({ libraryId, bookId: id, tagId: id, included: boolean, highlightId: id }),
    (mutations, input) => mutations.setHighlightTagMembership(input as never)),

  "threadRuntime:createThread": mutation(object(organization), (mutations, input) => mutations.createThread(input as never)),
  "threadRuntime:updateThread": mutation(object({ ...organization, expectedRevision: number }), (mutations, input) => mutations.updateThread(input as never)),
  "threadRuntime:deleteThread": mutation(object({ libraryId, id, expectedRevision: number }), (mutations, input) => mutations.deleteThread(input as never)),
  "threadRuntime:setHighlightThreadMembership": mutation(
    object({ libraryId, bookId: id, highlightId: id, threadIds: array(id, 100), expectedHighlightRevision: number }),
    (mutations, input) => mutations.setHighlightThreadMembership(input as never),
  ),

  "dailyRuntime:ensureDailySelection": mutation(object({ libraryId, id, timezone: string(100), another: optional(boolean) }),
    (mutations, input) => mutations.ensureDailySelection(input as never)),

  // A reader's own arrangement of a page: anyone who can read the library may keep one.
  "dashboardRuntime:layouts": define("read", object({ libraryId }), async (context, args) => dashboards.layouts(context, args.libraryId)),
  "dashboardRuntime:saveLayout": define("read", object({
    libraryId,
    dashboard: literal("library", "statistics"),
    layout: nullable(array(object({ widget: string(100), width: optional(string(20)), tall: optional(boolean) }), 100)),
  }), async (context, args) => dashboards.saveLayout(context, args.libraryId, args.dashboard, args.layout)),

  "aiRuntime:settings": define("read", object({ libraryId }), async (context, args) => ai.settings(context, args.libraryId)),
  "aiRuntime:setSettings": define("write", object({ libraryId, provider: literal(...AI_PROVIDER_IDS), model: string(200) }),
    async (context, { libraryId: library, ...args }) => ai.setSettings(context, library, args)),
  "aiRuntime:companion": define("read", object({
    libraryId,
    highlightId: id,
    secondaryHighlightId: optional(id),
    prompt: text,
    history: array(object({ role: literal("reader", "companion"), text }), 100),
  }), async (context, { libraryId: library, ...args }) => ai.companion(context, library, args)),

  "catalogRuntime:search": define("read", object({ libraryId, query: string(1_000) }), async (context, args) => catalog.search(context, args.query)),

  "publicationRuntime:settings": define("read", object({ libraryId, highlightId: id }),
    async (context, args) => publications.settings(context, args.libraryId, args.highlightId)),
  "publicationRuntime:publish": define("write", object({ libraryId, highlightId: id, noteIds: array(id, 100), rightsConfirmed: boolean }),
    async (context, { libraryId: library, ...args }) => publications.publish(context, library, args)),
  "publicationRuntime:withdraw": define("write", object({ libraryId, publicId: string(64) }),
    async (context, args) => publications.withdraw(context, args.libraryId, args.publicId)),
  "publicationRuntime:listMine": define("read", object({ libraryId, paginationOpts }),
    async (context, args) => publications.listMine(context, args.libraryId, args.paginationOpts)),
  "publicationRuntime:get": define("public", object({ publicId: string(64) }), async (context, args) => publications.get(context, args.publicId)),
  "publicationRuntime:report": define("public", object({
    publicId: string(64),
    reporterKey: string(200),
    reason: literal(...PUBLICATION_REPORT_REASONS),
    details: optional(string(10_000)),
  }), async (context, args) => publications.report(context, args)),

  "importRuntime:listSources": define("read", object({ libraryId }), async (context, args) => imports.listSources(context, args.libraryId)),
  "importRuntime:createSource": define("write", object({ libraryId, provider: literal(...imports.IMPORT_PROVIDERS), name: string(1_000) }),
    async (context, { libraryId: library, ...args }) => imports.createSource(context, library, args)),
  "importRuntime:importBooks": define("write", object({
    libraryId,
    sourceId: id,
    books: array(object({
      providerRecordId: string(1_000),
      title: text,
      authors: array(text, 50),
      isbn13: optionalText,
      description: optionalText,
      publisher: optionalText,
      series: optionalText,
      seriesNumber: optionalText,
      language: optionalText,
      status: optional(literal("unread", "reading", "finished")),
    }), imports.IMPORT_BATCH_LIMIT + 1),
  }), async (context, { libraryId: library, ...args }) => imports.importBooks(context, library, args)),
  "importRuntime:importAnnotations": define("write", object({
    libraryId,
    sourceId: id,
    annotations: array(object({
      providerRecordId: string(1_000),
      bookProviderRecordId: string(1_000),
      text: optionalText,
      note: optionalText,
      location: optionalText,
      createdAt: optional(number),
    }), imports.IMPORT_BATCH_LIMIT + 1),
  }), async (context, { libraryId: library, ...args }) => imports.importAnnotations(context, library, args)),
  "importRuntime:listConflicts": define("read", object({ libraryId }), async (context, args) => imports.listConflicts(context, args.libraryId)),
  "importRuntime:importedVersion": define("read", object({ libraryId, highlightId: id }),
    async (context, args) => imports.importedVersion(context, args.libraryId, args.highlightId)),
  "importRuntime:resetToImported": define("write", object({ libraryId, highlightId: id }),
    async (context, args) => imports.resetToImported(context, args.libraryId, args.highlightId)),
  "importRuntime:resolveConflict": define("write", object({ libraryId, conflictId: id, resolution: literal("keep-local", "accept-incoming") }),
    async (context, { libraryId: library, ...args }) => imports.resolveConflict(context, library, args)),
};

/** Check access and arguments, then run one function. */
export async function callFunction(context: RequestContext, name: string, rawArgs: unknown): Promise<unknown> {
  const target = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
  if (!target) throw new ServerError("LEAFLOGUE_FUNCTION_UNKNOWN", `There is no function named ${name.slice(0, 100)}`, 404);
  const args = target.args(rawArgs ?? {}, "args");
  if (target.access !== "public") {
    const user = requireUser(context);
    if (target.access === "read" || target.access === "write") {
      await requireLibraryAccess(context.client, user.userId, args.libraryId as string, target.access);
    }
  }
  return target.handler(context, args as never);
}
