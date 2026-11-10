import type {
  Book,
  BookId,
  Collection,
  CollectionId,
  Highlight,
  HighlightId,
  HighlightListEntry,
  HighlightMutationResult,
  Note,
  NoteId,
  ReadingStatus,
  Tag,
  TagId,
  Thread,
  ThreadId,
} from "@leaflogue/contracts";

/**
 * What the backend's `browse:*` and `reading:*` functions return (the same on
 * apps/server and Convex), and how each becomes the shape the interface uses.
 */

export interface WireBook {
  readonly id: BookId;
  readonly title: string;
  readonly authors: readonly string[];
  readonly description?: string;
  readonly publisher?: string;
  readonly series?: string;
  readonly seriesNumber?: string;
  readonly language?: string;
  readonly isbn13?: string;
  readonly coverUrl?: string;
  readonly status: ReadingStatus;
  readonly completedOn?: string;
  readonly archived: boolean;
  readonly deletedAt?: number;
  readonly highlightCount?: number;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WireShelfBook extends WireBook {
  readonly collectionIds: readonly CollectionId[];
  readonly tagIds: readonly TagId[];
}

export interface WirePassageNote {
  readonly id: NoteId;
  readonly markdown: string;
  readonly origin: Note["origin"];
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A passage as `browse:highlights`, `browse:highlight`, and `browse:thread` show it. */
export interface WirePassage {
  readonly id: HighlightId;
  readonly bookId: BookId;
  readonly bookTitle: string;
  readonly bookAuthors: readonly string[];
  readonly text: string;
  readonly sourceLocation?: string;
  readonly sourceCreatedAt?: number;
  readonly imported: boolean;
  readonly importedVersion: { readonly edited: boolean; readonly lastImportedAt: number } | null;
  readonly notes: readonly WirePassageNote[];
  readonly tags: readonly { readonly id: TagId; readonly name: string; readonly color?: string }[];
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A raw row from `reading:listHighlights`. */
export interface WireHighlightRow extends HighlightMutationResult {
  readonly archived: boolean;
  readonly deletedAt?: number;
}

/** A raw row from `reading:listNotes`. */
export interface WireNoteRow extends Note {
  readonly deletedAt?: number;
}

export interface WireCollection {
  readonly id: CollectionId;
  readonly name: string;
  readonly description?: string;
  readonly bookCount: number;
  readonly revision: number;
  readonly updatedAt: number;
  readonly createdAt?: number;
}

export interface WireTag {
  readonly id: TagId;
  readonly name: string;
  readonly color?: string;
  readonly bookCount: number;
  readonly highlightCount: number;
  readonly revision: number;
  readonly updatedAt: number;
  readonly createdAt?: number;
}

export interface WireThread {
  readonly id: ThreadId;
  readonly name: string;
  readonly description?: string;
  readonly passageCount: number;
  readonly revision: number;
  readonly updatedAt: number;
  readonly createdAt?: number;
}

export interface WireThreadDetails extends WireThread {
  readonly passages: readonly (WirePassage & { readonly addedAt: number })[];
}

const OPTIONAL_BOOK_FIELDS = ["description", "publisher", "series", "seriesNumber", "language", "isbn13", "coverUrl", "completedOn"] as const;

/** Only the fields a `Book` has: the wire shape also carries counts and memberships. */
export function toBook(book: WireBook, highlightCount = book.highlightCount ?? 0): Book {
  const details: Partial<Record<typeof OPTIONAL_BOOK_FIELDS[number], string>> = {};
  for (const key of OPTIONAL_BOOK_FIELDS) if (book[key] !== undefined) details[key] = book[key];
  return {
    id: book.id,
    title: book.title,
    authors: book.authors,
    ...details,
    status: book.status,
    archived: book.archived,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    revision: book.revision,
    highlightCount,
  };
}

export function toNote(note: WirePassageNote, bookId: BookId, highlightId?: HighlightId): Note {
  return {
    id: note.id,
    bookId,
    ...(highlightId ? { highlightId } : {}),
    markdown: note.markdown,
    origin: note.origin,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    revision: note.revision,
  };
}

export function toHighlight(result: HighlightMutationResult, notes: readonly Note[]): Highlight {
  return {
    id: result.id,
    bookId: result.bookId,
    text: result.text,
    ...(result.sourceLocation !== undefined ? { sourceLocation: result.sourceLocation } : {}),
    ...(result.sourceCreatedAt !== undefined ? { sourceCreatedAt: result.sourceCreatedAt } : {}),
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    revision: result.revision,
    notes,
  };
}

export function passageNotes(passage: WirePassage): Note[] {
  return passage.notes.map((note) => toNote(note, passage.bookId, passage.id));
}

export function passageHighlight(passage: WirePassage): Highlight {
  return toHighlight(passage, passageNotes(passage));
}

export function toHighlightEntry(passage: WirePassage): HighlightListEntry {
  return {
    ...passageHighlight(passage),
    bookTitle: passage.bookTitle,
    authors: passage.bookAuthors,
    imported: passage.imported,
    tagIds: passage.tags.map(({ id }) => id),
  };
}

// The backend does not keep when a collection, tag, or thread was created;
// its last change is the closest it has.

export function toCollection(collection: WireCollection): Collection {
  return {
    id: collection.id,
    name: collection.name,
    ...(collection.description !== undefined ? { description: collection.description } : {}),
    bookCount: collection.bookCount,
    createdAt: collection.createdAt ?? collection.updatedAt,
    updatedAt: collection.updatedAt,
    revision: collection.revision,
  };
}

export function toTag(tag: WireTag): Tag {
  return {
    id: tag.id,
    name: tag.name,
    ...(tag.color !== undefined ? { color: tag.color } : {}),
    bookCount: tag.bookCount,
    highlightCount: tag.highlightCount,
    createdAt: tag.createdAt ?? tag.updatedAt,
    updatedAt: tag.updatedAt,
    revision: tag.revision,
  };
}

export function toThread(thread: WireThread): Thread {
  return {
    id: thread.id,
    name: thread.name,
    ...(thread.description !== undefined ? { description: thread.description } : {}),
    passageCount: thread.passageCount,
    createdAt: thread.createdAt ?? thread.updatedAt,
    updatedAt: thread.updatedAt,
    revision: thread.revision,
  };
}
