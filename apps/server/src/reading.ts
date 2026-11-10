import { POSTGRES_SYNC_GENERATION, type PostgresClient } from "@leaflogue/remote";
import { ServerError } from "./errors";

/**
 * Reads for web clients, in the same shapes as Convex's `reading:*`
 * functions, so one client works against either backend. Pages are ordered
 * by ID and continue from the last ID returned.
 */

const MAX_PAGE_ITEMS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface PageOptions {
  readonly numItems: number;
  readonly cursor: string | null;
  readonly endCursor?: string | null;
}

export interface Page<Item> {
  readonly page: Item[];
  readonly isDone: boolean;
  readonly continueCursor: string;
}

function pageBounds(options: PageOptions): { limit: number; after: string | null } {
  if (!Number.isSafeInteger(options.numItems) || options.numItems < 1 || options.numItems > MAX_PAGE_ITEMS) {
    throw new ServerError("LEAFLOGUE_REQUEST_INVALID", `Page size must be between 1 and ${MAX_PAGE_ITEMS}`);
  }
  if (options.endCursor !== undefined && options.endCursor !== null) {
    throw new ServerError("LEAFLOGUE_REQUEST_INVALID", "Pagination end cursors are not supported by this API");
  }
  if (options.cursor !== null && options.cursor !== "" && !UUID.test(options.cursor)) {
    throw new ServerError("LEAFLOGUE_REQUEST_INVALID", "Pagination cursor is invalid");
  }
  return { limit: options.numItems, after: options.cursor || null };
}

function paged<Row extends { id: string }, Item>(rows: Row[], limit: number, after: string | null, map: (row: Row) => Item): Page<Item> {
  const page = rows.slice(0, limit);
  return { page: page.map(map), isDone: rows.length <= limit, continueCursor: page.at(-1)?.id ?? after ?? "" };
}

const milliseconds = (value: unknown) => Number(value);

function texts(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

interface BookRow extends Record<string, unknown> {
  id: string;
  title: string;
  authors: unknown;
  metadata: unknown;
  status: "unread" | "reading" | "finished" | "paused";
  completed_on: string | null;
  archived: boolean;
  deleted_at_ms: string | number | null;
  highlight_count: string | number;
  note_count: string | number;
  revision: string | number;
  created_at_ms: string | number;
  updated_at_ms: string | number;
}

export function mapBookRow(row: BookRow) {
  const metadata = record(row.metadata);
  const detail = (key: string) => typeof metadata[key] === "string" && metadata[key] ? { [key]: metadata[key] as string } : {};
  return {
    id: row.id,
    title: row.title,
    authors: texts(row.authors),
    ...detail("description"),
    ...detail("publisher"),
    ...detail("series"),
    ...detail("seriesNumber"),
    ...detail("language"),
    ...detail("isbn13"),
    ...detail("coverUrl"),
    status: row.status,
    ...(row.completed_on ? { completedOn: row.completed_on } : {}),
    archived: row.archived,
    ...(row.deleted_at_ms !== null ? { deletedAt: milliseconds(row.deleted_at_ms) } : {}),
    highlightCount: Number(row.highlight_count),
    noteCount: Number(row.note_count),
    revision: Number(row.revision),
    createdAt: milliseconds(row.created_at_ms),
    updatedAt: milliseconds(row.updated_at_ms),
  };
}

export const BOOK_COLUMNS = `
  books.id::text AS id, books.title, books.authors, books.metadata, books.status,
  books.completed_on::text AS completed_on, books.archived,
  floor(extract(epoch FROM books.deleted_at) * 1000)::bigint AS deleted_at_ms,
  (SELECT count(*) FROM leaflogue.highlights AS highlights
   WHERE highlights.library_id = books.library_id AND highlights.book_id = books.id
     AND highlights.archived = false AND highlights.deleted_at IS NULL) AS highlight_count,
  (SELECT count(*) FROM leaflogue.notes AS notes
   WHERE notes.library_id = books.library_id AND notes.book_id = books.id AND notes.deleted_at IS NULL) AS note_count,
  books.revision,
  floor(extract(epoch FROM books.created_at) * 1000)::bigint AS created_at_ms,
  floor(extract(epoch FROM books.updated_at) * 1000)::bigint AS updated_at_ms
`;

export async function listBooks(client: PostgresClient, libraryId: string, args: { includeArchived?: boolean; paginationOpts: PageOptions }) {
  const { limit, after } = pageBounds(args.paginationOpts);
  const rows = await client.query<BookRow>(`
    SELECT ${BOOK_COLUMNS} FROM leaflogue.books AS books
    WHERE books.library_id = $1 AND ($2::uuid IS NULL OR books.id > $2::uuid) AND ($3 OR books.archived = false)
    ORDER BY books.id LIMIT $4
  `, [libraryId, after, args.includeArchived === true, limit + 1]);
  return paged(rows.rows, limit, after, mapBookRow);
}

interface HighlightRow extends Record<string, unknown> {
  id: string;
  book_id: string;
  text: string;
  source_location: string | null;
  source_created_at_ms: string | number | null;
  archived: boolean;
  deleted_at_ms: string | number | null;
  revision: string | number;
  created_at_ms: string | number;
  updated_at_ms: string | number;
}

export async function listHighlights(client: PostgresClient, libraryId: string, args: { bookId: string; paginationOpts: PageOptions }) {
  const { limit, after } = pageBounds(args.paginationOpts);
  if (!UUID.test(args.bookId)) return paged([], limit, after, (row: HighlightRow) => row);
  const rows = await client.query<HighlightRow>(`
    SELECT id::text AS id, book_id::text AS book_id, text, source_location,
      floor(extract(epoch FROM source_created_at) * 1000)::bigint AS source_created_at_ms, archived,
      floor(extract(epoch FROM deleted_at) * 1000)::bigint AS deleted_at_ms, revision,
      floor(extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms,
      floor(extract(epoch FROM updated_at) * 1000)::bigint AS updated_at_ms
    FROM leaflogue.highlights
    WHERE library_id = $1 AND book_id = $2 AND ($3::uuid IS NULL OR id > $3::uuid)
    ORDER BY id LIMIT $4
  `, [libraryId, args.bookId, after, limit + 1]);
  return paged(rows.rows, limit, after, (row) => ({
    id: row.id,
    bookId: row.book_id,
    text: row.text,
    ...(row.source_location !== null ? { sourceLocation: row.source_location } : {}),
    ...(row.source_created_at_ms !== null ? { sourceCreatedAt: milliseconds(row.source_created_at_ms) } : {}),
    archived: row.archived,
    ...(row.deleted_at_ms !== null ? { deletedAt: milliseconds(row.deleted_at_ms) } : {}),
    revision: Number(row.revision),
    createdAt: milliseconds(row.created_at_ms),
    updatedAt: milliseconds(row.updated_at_ms),
  }));
}

interface NoteRow extends Record<string, unknown> {
  id: string;
  book_id: string;
  highlight_id: string | null;
  markdown: string;
  origin: "reader" | "import" | "ai";
  deleted_at_ms: string | number | null;
  revision: string | number;
  created_at_ms: string | number;
  updated_at_ms: string | number;
}

export async function listNotes(client: PostgresClient, libraryId: string, args: { bookId: string; paginationOpts: PageOptions }) {
  const { limit, after } = pageBounds(args.paginationOpts);
  if (!UUID.test(args.bookId)) return paged([], limit, after, (row: NoteRow) => row);
  const rows = await client.query<NoteRow>(`
    SELECT id::text AS id, book_id::text AS book_id, highlight_id::text AS highlight_id, markdown, origin,
      floor(extract(epoch FROM deleted_at) * 1000)::bigint AS deleted_at_ms, revision,
      floor(extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms,
      floor(extract(epoch FROM updated_at) * 1000)::bigint AS updated_at_ms
    FROM leaflogue.notes
    WHERE library_id = $1 AND book_id = $2 AND ($3::uuid IS NULL OR id > $3::uuid)
    ORDER BY id LIMIT $4
  `, [libraryId, args.bookId, after, limit + 1]);
  return paged(rows.rows, limit, after, (row) => ({
    id: row.id,
    bookId: row.book_id,
    ...(row.highlight_id !== null ? { highlightId: row.highlight_id } : {}),
    markdown: row.markdown,
    origin: row.origin,
    ...(row.deleted_at_ms !== null ? { deletedAt: milliseconds(row.deleted_at_ms) } : {}),
    revision: Number(row.revision),
    createdAt: milliseconds(row.created_at_ms),
    updatedAt: milliseconds(row.updated_at_ms),
  }));
}

/** The library's change feed, so a web client can refresh what changed elsewhere. */
export async function listChanges(client: PostgresClient, libraryId: string, args: { cursor: { generation: number; afterSequence: number }; limit: number }) {
  const { cursor, limit } = args;
  if (!Number.isSafeInteger(cursor.afterSequence) || cursor.afterSequence < 0) throw new ServerError("LEAFLOGUE_REQUEST_INVALID", "Change sequence is invalid");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_ITEMS) {
    throw new ServerError("LEAFLOGUE_REQUEST_INVALID", `Page size must be between 1 and ${MAX_PAGE_ITEMS}`);
  }
  const generation = POSTGRES_SYNC_GENERATION;
  const latest = await client.query<{ sequence: string | number | null }>(
    "SELECT max(sequence) AS sequence FROM leaflogue.sync_changes WHERE library_id = $1",
    [libraryId],
  );
  if (cursor.generation !== generation || cursor.afterSequence > Number(latest.rows[0]?.sequence ?? 0)) {
    return { page: [], nextCursor: { generation, afterSequence: 0 }, isDone: false, resetRequired: true };
  }
  const rows = await client.query<{ sequence: string | number; entity_type: string; entity_id: string; revision: string | number; changed_at_ms: string | number }>(`
    SELECT sequence, entity_type, entity_id::text AS entity_id, revision,
      floor(extract(epoch FROM changed_at) * 1000)::bigint AS changed_at_ms
    FROM leaflogue.sync_changes
    WHERE library_id = $1 AND sequence > $2
    ORDER BY sequence LIMIT $3
  `, [libraryId, cursor.afterSequence, limit + 1]);
  const page = rows.rows.slice(0, limit).map((row) => ({
    sequence: Number(row.sequence),
    entityType: row.entity_type,
    entityId: row.entity_id,
    revision: Number(row.revision),
    changedAt: milliseconds(row.changed_at_ms),
  }));
  return {
    page,
    nextCursor: { generation, afterSequence: page.at(-1)?.sequence ?? cursor.afterSequence },
    isDone: rows.rows.length <= limit,
    resetRequired: false,
  };
}
