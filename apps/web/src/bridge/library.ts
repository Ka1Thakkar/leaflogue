import type {
  AnnotationDeletionReceipt,
  Book,
  BookArchiveChange,
  BookId,
  BookReadingStatusChange,
  HighlightId,
  HighlightMutationResult,
  LeaflogueBridge,
  LibraryExportDocument,
  MergeBooksReceipt,
  Note,
  NoteId,
  ReadingStatusEvent,
} from "@leaflogue/contracts";
import { findLibraryDuplicates, libraryStatistics } from "@leaflogue/domain";
import { BackendError } from "../transport/transport";
import { allPages, newId, type LibraryClient, type Page } from "./client";
import { HighlightPages } from "./highlights";
import { assembleContents, librarySnapshot } from "./snapshot";
import { passageHighlight, passageNotes, toBook, toHighlight, type WireBook, type WireHighlightRow, type WireNoteRow, type WirePassage, type WireShelfBook } from "./wire";

type Library = LeaflogueBridge["library"];

const READING_PAGE = 100;
const HISTORY_LIMIT = 100;

interface ImportedVersion {
  readonly text: string;
  readonly note?: string;
  readonly location?: string;
  readonly edited: boolean;
}

interface HistoryEntry {
  readonly id: ReadingStatusEvent["id"];
  readonly status: ReadingStatusEvent["status"];
  readonly source: ReadingStatusEvent["source"];
  readonly changedAt: number;
  readonly completedOn?: string;
}

const gone = () => new BackendError("That passage is no longer in your library.", "LEAFLOGUE_NOT_FOUND");

export function createLibrary(client: LibraryClient): { readonly library: Library; readonly statistics: LeaflogueBridge["statistics"] } {
  const highlightPages = new HighlightPages(client);
  const passage = (highlightId: HighlightId) => client.query<WirePassage | null>("browse:highlight", { highlightId });
  const readingPages = <Row>(name: string, args: Record<string, unknown>) =>
    allPages((cursor) => client.query<Page<Row>>(name, { ...args, paginationOpts: { numItems: READING_PAGE, cursor } }));

  // Duplicates and statistics read the whole library; callers that ask at
  // the same moment share one read.
  let reading: Promise<LibraryExportDocument> | undefined;
  const snapshot = () => {
    reading ??= librarySnapshot(client).finally(() => { reading = undefined; });
    return reading;
  };

  const library: Library = {
    async listBooks(options) {
      if (!options?.includeArchived) return (await client.query<WireShelfBook[]>("browse:books")).map((book) => toBook(book));
      const books = await readingPages<WireBook>("reading:listBooks", { includeArchived: true });
      return books.filter((book) => book.deletedAt === undefined).map((book) => toBook(book));
    },

    async findDuplicates() {
      return findLibraryDuplicates(await snapshot());
    },

    createBook: (input) => client.mutation<Book>("runtime:createBook", { id: newId<BookId>(), ...input }),
    updateBookMetadata: (input) => client.mutation<Book>("runtime:updateBookMetadata", { ...input }),
    // Import sources live with the desktop that imported them.
    getMetadataSource: async () => undefined,

    async getBookContents(id) {
      // `reading:*` rather than `browse:highlights`, which leaves out an archived book's passages.
      const [book, highlights, notes] = await Promise.all([
        client.query<WireShelfBook | null>("browse:book", { bookId: id }),
        readingPages<WireHighlightRow>("reading:listHighlights", { bookId: id }),
        readingPages<WireNoteRow>("reading:listNotes", { bookId: id }),
      ]);
      return book ? assembleContents(book, highlights, notes) : undefined;
    },

    listHighlights: (query) => highlightPages.list(query),

    async createHighlight(input) {
      const id = newId<HighlightId>();
      const noteMarkdown = input.noteMarkdown?.trim();
      const noteId = noteMarkdown ? newId<NoteId>() : undefined;
      const result = await client.mutation<HighlightMutationResult>("runtime:createHighlight", {
        id,
        bookId: input.bookId,
        text: input.text,
        ...(input.sourceLocation !== undefined ? { sourceLocation: input.sourceLocation } : {}),
        ...(noteMarkdown && noteId ? { noteId, noteMarkdown } : {}),
      });
      const note: Note | undefined = noteMarkdown && noteId ? {
        id: noteId,
        bookId: result.bookId,
        highlightId: result.id,
        markdown: noteMarkdown,
        origin: "reader",
        createdAt: result.createdAt,
        updatedAt: result.createdAt,
        revision: 1,
      } : undefined;
      return toHighlight(result, note ? [note] : []);
    },

    async updateHighlight(input) {
      const result = await client.mutation<HighlightMutationResult>("runtime:updateHighlight", { ...input });
      const current = await passage(result.id);
      return toHighlight(result, current ? passageNotes(current) : []);
    },

    createNote: (input) => client.mutation<Note>("runtime:createNote", { id: newId<NoteId>(), ...input }),
    updateNote: (input) => client.mutation<Note>("runtime:updateNote", { ...input }),
    deleteHighlight: (input) => client.mutation<AnnotationDeletionReceipt>("runtime:deleteHighlight", { ...input }),
    deleteNote: (input) => client.mutation<AnnotationDeletionReceipt>("runtime:deleteNote", { ...input }),

    async getHighlightSource(_bookId, highlightId) {
      const version = await client.query<ImportedVersion | null>("importRuntime:importedVersion", { highlightId });
      if (!version) return undefined;
      return {
        sourceName: "your last import",
        text: version.text,
        ...(version.location ? { location: version.location } : {}),
        ...(version.note ? { note: version.note } : {}),
        differs: version.edited,
        // The backend resets by passage alone; the revision check below guards it.
        resetToken: highlightId,
      };
    },

    async resetHighlightToSource(input) {
      const before = await passage(input.id);
      if (!before || before.bookId !== input.bookId) throw gone();
      if (before.revision !== input.expectedRevision) {
        throw new BackendError("This passage changed elsewhere. Reopen it and try again.", "LEAFLOGUE_CONFLICT");
      }
      await client.mutation<null>("importRuntime:resetToImported", { highlightId: input.id });
      const after = await passage(input.id);
      if (!after) throw gone();
      return passageHighlight(after);
    },

    setBookArchived: (input) => client.mutation<BookArchiveChange>("runtime:setBookArchived", { ...input }),

    async listReadingStatusHistory(id) {
      const entries = await client.query<HistoryEntry[]>("browse:readingHistory", { bookId: id });
      return {
        events: entries.map((entry) => ({
          id: entry.id,
          bookId: id,
          status: entry.status,
          source: entry.source,
          changedAt: entry.changedAt,
          ...(entry.completedOn ? { completedOn: entry.completedOn } : {}),
          // Not part of the history the backend returns; nothing shown depends on it.
          bookRevision: 0,
        })),
        hasMore: entries.length >= HISTORY_LIMIT,
      };
    },

    setBookReadingStatus: (input) => client.mutation<BookReadingStatusChange>("runtime:setBookReadingStatus", { ...input }),
    setBookCompletionDate: (input) => client.mutation<Book>("runtime:setBookCompletionDate", { ...input }),
    mergeBooks: (input) => client.mutation<MergeBooksReceipt>("runtime:mergeBooks", { ...input }),
  };
  return { library, statistics: { get: async () => libraryStatistics(await snapshot()) } };
}
