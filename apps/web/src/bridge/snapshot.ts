import type {
  BookContents,
  Highlight,
  LibraryExportDocument,
  Note,
  ReadingStatusEvent,
  Thread,
} from "@leaflogue/contracts";
import { allPages, type LibraryClient } from "./client";
import { toBook, toHighlight, toThread, type WireBook, type WireHighlightRow, type WireNoteRow, type WireThread } from "./wire";

/**
 * The whole library read through `browse:exportPage`, for duplicate
 * suggestions and statistics, which the desktop computes from the same
 * document its export writes. Only what those two read is filled in: books
 * with their passages and notes, reading-status events, and threads.
 * Deleted rows are left out; archived books stay, as on the desktop.
 */

const EXPORT_PAGE = 500;

interface ExportPage<Record> {
  readonly records: readonly Record[];
  readonly isDone: boolean;
  readonly continueCursor: string;
}

type Deletable<T> = T & { readonly deletedAt?: number };

async function exportTable<Record>(client: LibraryClient, table: string): Promise<Record[]> {
  return allPages(async (cursor) => {
    const result = await client.query<ExportPage<Record>>("browse:exportPage", { table, paginationOpts: { numItems: EXPORT_PAGE, cursor } });
    return { page: result.records, isDone: result.isDone, continueCursor: result.continueCursor };
  });
}

function byTime<T extends { readonly createdAt: number; readonly id: string }>(a: T, b: T): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function plainNote(note: WireNoteRow): Note {
  return {
    id: note.id,
    bookId: note.bookId,
    ...(note.highlightId ? { highlightId: note.highlightId } : {}),
    markdown: note.markdown,
    origin: note.origin,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    revision: note.revision,
  };
}

/** Group a book's live passages and notes the way the desktop orders them. */
export function assembleContents(book: WireBook, highlightRows: readonly WireHighlightRow[], noteRows: readonly WireNoteRow[]): BookContents {
  const notes = noteRows.filter((note) => note.deletedAt === undefined).map(plainNote).sort(byTime);
  const byHighlight = new Map<string, Note[]>();
  const standaloneNotes: Note[] = [];
  for (const note of notes) {
    if (note.highlightId) byHighlight.set(note.highlightId, [...(byHighlight.get(note.highlightId) ?? []), note]);
    else standaloneNotes.push(note);
  }
  const highlights: Highlight[] = highlightRows
    .filter((row) => !row.archived && row.deletedAt === undefined)
    .sort((a, b) => (a.sourceCreatedAt ?? a.createdAt) - (b.sourceCreatedAt ?? b.createdAt) || byTime(a, b))
    .map((row) => toHighlight(row, byHighlight.get(row.id) ?? []));
  return { book: toBook(book, highlights.length), highlights, standaloneNotes };
}

export async function librarySnapshot(client: LibraryClient): Promise<LibraryExportDocument> {
  const [books, highlights, notes, events, threads] = await Promise.all([
    exportTable<Deletable<WireBook>>(client, "books"),
    exportTable<WireHighlightRow>(client, "highlights"),
    exportTable<WireNoteRow>(client, "notes"),
    exportTable<Omit<ReadingStatusEvent, "bookRevision"> & { readonly bookRevision?: number }>(client, "readingStatusEvents"),
    exportTable<Deletable<Omit<WireThread, "passageCount">>>(client, "threads"),
  ]);
  const highlightsByBook = Map.groupBy(highlights, (row) => row.bookId);
  const notesByBook = Map.groupBy(notes, (row) => row.bookId);
  return {
    format: "leaflogue-library",
    formatVersion: 4,
    exportedAt: new Date().toISOString(),
    books: books
      .filter((book) => book.deletedAt === undefined)
      .map((book) => assembleContents(book, highlightsByBook.get(book.id) ?? [], notesByBook.get(book.id) ?? [])),
    collections: [],
    tags: [],
    organizations: [],
    readingStatusEvents: events.map((event) => ({ ...event, bookRevision: event.bookRevision ?? 0 })),
    // Statistics count threads; how many passages each holds is not exported.
    threads: threads.filter((thread) => thread.deletedAt === undefined).map((thread): Thread => toThread({ ...thread, passageCount: 0 })),
    threadHighlightMemberships: [],
    dailySelections: [],
  };
}
