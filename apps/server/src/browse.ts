import type { PostgresClient } from "@leaflogue/remote";
import { isUuid } from "./context";
import { ServerError } from "./errors";
import { BOOK_COLUMNS, mapBookRow } from "./reading";

/**
 * Reads for a web client browsing a library, in the same shapes as Convex's
 * `browse:*`. Pages continue from an offset, which the client treats as an
 * opaque cursor.
 */

const MAX_BOOKS = 2_000;
const MAX_PAGE_ITEMS = 50;
const MAX_LIST = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const invalid = (message: string) => new ServerError("LEAFLOGUE_REQUEST_INVALID", message);
const ms = (value: unknown) => value instanceof Date ? value.getTime() : Number(value);
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

function offsetOf(cursor: string | null): number {
  if (cursor === null || cursor === "") return 0;
  if (!/^\d{1,9}$/u.test(cursor)) throw invalid("Pagination cursor is invalid");
  return Number(cursor);
}

function pageSize(numItems: number, maximum: number): number {
  if (!Number.isSafeInteger(numItems) || numItems < 1 || numItems > maximum) throw invalid(`Page size must be between 1 and ${maximum}`);
  return numItems;
}

function dayRange(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) {
    throw invalid("Date must be a valid calendar date");
  }
  return { start, end: start + DAY_MS };
}

function membershipMap(rows: { book_id: string; other: string }[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) result.set(row.book_id, [...(result.get(row.book_id) ?? []), row.other]);
  return result;
}

type BookRow = Parameters<typeof mapBookRow>[0];

export async function books(client: PostgresClient, libraryId: string) {
  const rows = await client.query<BookRow>(`
    SELECT ${BOOK_COLUMNS} FROM leaflogue.books AS books
    WHERE books.library_id = $1 AND books.archived = false AND books.deleted_at IS NULL
    ORDER BY books.id LIMIT $2
  `, [libraryId, MAX_BOOKS + 1]);
  if (rows.rows.length > MAX_BOOKS) throw new ServerError("LEAFLOGUE_LIBRARY_TOO_LARGE", "This library has too many books to show at once", 413);
  const collections = membershipMap((await client.query<{ book_id: string; other: string }>(
    "SELECT book_id::text AS book_id, collection_id::text AS other FROM leaflogue.collection_books WHERE library_id = $1",
    [libraryId],
  )).rows);
  const tags = membershipMap((await client.query<{ book_id: string; other: string }>(
    "SELECT book_id::text AS book_id, tag_id::text AS other FROM leaflogue.book_tags WHERE library_id = $1",
    [libraryId],
  )).rows);
  return rows.rows.map((row) => withMemberships(mapBookRow(row), collections.get(row.id) ?? [], tags.get(row.id) ?? []));
}

/** Shelf books are never deleted, so the read shape drops `deletedAt`. */
function withMemberships(book: ReturnType<typeof mapBookRow>, collectionIds: string[], tagIds: string[]) {
  const shelved: Record<string, unknown> = { ...book, collectionIds, tagIds };
  delete shelved.deletedAt;
  return shelved as Omit<ReturnType<typeof mapBookRow>, "deletedAt"> & { collectionIds: string[]; tagIds: string[] };
}

export async function book(client: PostgresClient, libraryId: string, bookId: string) {
  if (!isUuid(bookId)) return null;
  const row = (await client.query<BookRow>(
    `SELECT ${BOOK_COLUMNS} FROM leaflogue.books AS books WHERE books.library_id = $1 AND books.id = $2 AND books.deleted_at IS NULL`,
    [libraryId, bookId],
  )).rows[0];
  if (!row) return null;
  const collectionIds = (await client.query<{ id: string }>(
    "SELECT collection_id::text AS id FROM leaflogue.collection_books WHERE library_id = $1 AND book_id = $2", [libraryId, bookId],
  )).rows.map((link) => link.id);
  const tagIds = (await client.query<{ id: string }>(
    "SELECT tag_id::text AS id FROM leaflogue.book_tags WHERE library_id = $1 AND book_id = $2", [libraryId, bookId],
  )).rows.map((link) => link.id);
  return withMemberships(mapBookRow(row), collectionIds, tagIds);
}

interface PassageRow extends Record<string, unknown> {
  id: string;
  book_id: string;
  title: string;
  authors: unknown;
  text: string;
  source_location: string | null;
  source_created_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  revision: string | number;
  link_updated_at: Date | string | null;
  link_highlight_revision: string | number | null;
  link_attached_note_id: string | null;
  link_attached_note_revision: string | number | null;
  has_import_note: boolean;
}

/** Live passages on books still on the shelf, with their latest web-import link. */
const PASSAGE_FROM = `
  FROM leaflogue.highlights AS h
  JOIN leaflogue.books AS b ON b.library_id = h.library_id AND b.id = h.book_id AND b.deleted_at IS NULL AND b.archived = false
  LEFT JOIN LATERAL (
    SELECT links.updated_at, links.highlight_revision, links.attached_note_id, links.attached_note_revision
    FROM leaflogue_web.import_source_annotations AS links
    WHERE links.library_id = h.library_id AND links.highlight_id = h.id
    ORDER BY links.updated_at DESC LIMIT 1
  ) AS link ON true
`;
const PASSAGE_COLUMNS = `
  h.id::text AS id, h.book_id::text AS book_id, b.title, b.authors, h.text, h.source_location,
  h.source_created_at, h.created_at, h.updated_at, h.revision,
  link.updated_at AS link_updated_at, link.highlight_revision AS link_highlight_revision,
  link.attached_note_id::text AS link_attached_note_id, link.attached_note_revision AS link_attached_note_revision,
  EXISTS (SELECT 1 FROM leaflogue.notes AS n WHERE n.library_id = h.library_id AND n.highlight_id = h.id
    AND n.deleted_at IS NULL AND n.origin = 'import') AS has_import_note
`;
const IMPORTED = `(h.source_created_at IS NOT NULL OR link.updated_at IS NOT NULL OR EXISTS (
  SELECT 1 FROM leaflogue.notes AS n WHERE n.library_id = h.library_id AND n.highlight_id = h.id AND n.deleted_at IS NULL AND n.origin = 'import'))`;

async function passageViews(client: PostgresClient, libraryId: string, rows: PassageRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const notes = await client.query<{ id: string; highlight_id: string; markdown: string; origin: string; revision: string | number; created_at: Date | string; updated_at: Date | string }>(`
    SELECT id::text AS id, highlight_id::text AS highlight_id, markdown, origin, revision, created_at, updated_at
    FROM leaflogue.notes WHERE library_id = $1 AND highlight_id = ANY($2::uuid[]) AND deleted_at IS NULL
    ORDER BY created_at, id
  `, [libraryId, ids]);
  const tags = await client.query<{ highlight_id: string; id: string; name: string; color: string | null }>(`
    SELECT links.highlight_id::text AS highlight_id, tags.id::text AS id, tags.name, tags.color
    FROM leaflogue.highlight_tags AS links
    JOIN leaflogue.tags AS tags ON tags.library_id = links.library_id AND tags.id = links.tag_id AND tags.deleted_at IS NULL
    WHERE links.library_id = $1 AND links.highlight_id = ANY($2::uuid[])
    ORDER BY tags.name
  `, [libraryId, ids]);
  return rows.map((row) => {
    const own = notes.rows.filter((note) => note.highlight_id === row.id).map((note) => ({
      id: note.id, markdown: note.markdown, origin: note.origin, revision: Number(note.revision), createdAt: ms(note.created_at), updatedAt: ms(note.updated_at),
    }));
    const linked = row.link_updated_at !== null;
    const attached = row.link_attached_note_id ? own.find((note) => note.id === row.link_attached_note_id) : undefined;
    const edited = linked && (Number(row.revision) !== Number(row.link_highlight_revision) ||
      (attached !== undefined && attached.revision !== Number(row.link_attached_note_revision)));
    return {
      id: row.id,
      bookId: row.book_id,
      bookTitle: row.title,
      bookAuthors: json<string[]>(row.authors),
      text: row.text,
      ...(row.source_location !== null ? { sourceLocation: row.source_location } : {}),
      ...(row.source_created_at !== null ? { sourceCreatedAt: ms(row.source_created_at) } : {}),
      imported: row.source_created_at !== null || linked || row.has_import_note,
      importedVersion: linked ? { edited, lastImportedAt: ms(row.link_updated_at) } : null,
      notes: own,
      tags: tags.rows.filter((tag) => tag.highlight_id === row.id).map((tag) => ({ id: tag.id, name: tag.name, ...(tag.color !== null ? { color: tag.color } : {}) })),
      revision: Number(row.revision),
      createdAt: ms(row.created_at),
      updatedAt: ms(row.updated_at),
    };
  });
}

export interface HighlightQuery {
  readonly bookId?: string;
  readonly search?: string;
  readonly tagId?: string;
  readonly notes?: "with" | "without";
  readonly source?: "typed" | "imported";
  readonly date?: string;
  readonly dateKind?: "added" | "imported";
  readonly sort?: "newest" | "oldest" | "updated" | "relevance";
  readonly paginationOpts: { readonly numItems: number; readonly cursor: string | null };
}

export async function highlights(client: PostgresClient, libraryId: string, args: HighlightQuery) {
  const limit = pageSize(args.paginationOpts.numItems, MAX_PAGE_ITEMS);
  const offset = offsetOf(args.paginationOpts.cursor);
  const search = args.search?.normalize("NFKC").trim() || undefined;
  if (search && new TextEncoder().encode(search).byteLength > 200) throw invalid("Search must be at most 200 bytes");
  if ((args.bookId && !isUuid(args.bookId)) || (args.tagId && !isUuid(args.tagId))) {
    return { page: [], isDone: true, continueCursor: String(offset) };
  }
  const range = args.date ? dayRange(args.date) : undefined;
  const values: unknown[] = [libraryId];
  const value = (item: unknown) => `$${values.push(item)}`;
  const where = ["h.library_id = $1", "h.deleted_at IS NULL", "h.archived = false"];
  if (args.bookId) where.push(`h.book_id = ${value(args.bookId)}`);
  let term = "";
  if (search) {
    term = value(search);
    const pattern = value(`%${search.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`);
    where.push(`(to_tsvector('simple', h.text) @@ plainto_tsquery('simple', ${term}) OR h.text ILIKE ${pattern})`);
  }
  if (args.tagId) {
    where.push(`EXISTS (SELECT 1 FROM leaflogue.highlight_tags AS t WHERE t.library_id = h.library_id AND t.highlight_id = h.id AND t.tag_id = ${value(args.tagId)})`);
  }
  if (args.notes) {
    where.push(`${args.notes === "with" ? "" : "NOT "}EXISTS (SELECT 1 FROM leaflogue.notes AS n WHERE n.library_id = h.library_id AND n.highlight_id = h.id AND n.deleted_at IS NULL)`);
  }
  if (args.source) where.push(args.source === "imported" ? IMPORTED : `NOT ${IMPORTED}`);
  if (range) {
    const column = (args.dateKind ?? "added") === "imported" ? "link.updated_at" : "h.created_at";
    where.push(`${column} >= to_timestamp(${value(range.start / 1000)}) AND ${column} < to_timestamp(${value(range.end / 1000)})`);
  }
  const sort = search ? (args.sort ?? "relevance") : args.sort === "relevance" ? "oldest" : (args.sort ?? "oldest");
  const order = sort === "relevance" && search
    ? `ts_rank(to_tsvector('simple', h.text), plainto_tsquery('simple', ${term})) DESC, h.created_at, h.id`
    : sort === "newest" ? "h.created_at DESC, h.id DESC"
      : sort === "updated" ? "h.updated_at DESC, h.id DESC"
        : "h.created_at, h.id";
  const rows = await client.query<PassageRow>(`
    SELECT ${PASSAGE_COLUMNS} ${PASSAGE_FROM}
    WHERE ${where.join(" AND ")}
    ORDER BY ${order}
    LIMIT ${value(limit + 1)} OFFSET ${value(offset)}
  `, values);
  const page = await passageViews(client, libraryId, rows.rows.slice(0, limit));
  return { page, isDone: rows.rows.length <= limit, continueCursor: String(offset + page.length) };
}

export async function highlight(client: PostgresClient, libraryId: string, highlightId: string) {
  if (!isUuid(highlightId)) return null;
  const rows = await client.query<PassageRow>(`
    SELECT ${PASSAGE_COLUMNS} ${PASSAGE_FROM}
    WHERE h.library_id = $1 AND h.id = $2 AND h.deleted_at IS NULL AND h.archived = false
  `, [libraryId, highlightId]);
  return (await passageViews(client, libraryId, rows.rows))[0] ?? null;
}

export async function highlightMemberships(client: PostgresClient, libraryId: string, highlightId: string) {
  if (!isUuid(highlightId)) return { tagIds: [], threadIds: [] };
  const tagIds = (await client.query<{ id: string }>(
    "SELECT tag_id::text AS id FROM leaflogue.highlight_tags WHERE library_id = $1 AND highlight_id = $2", [libraryId, highlightId],
  )).rows.map((row) => row.id);
  const threadIds = (await client.query<{ id: string }>(
    "SELECT thread_id::text AS id FROM leaflogue.thread_highlights WHERE library_id = $1 AND highlight_id = $2", [libraryId, highlightId],
  )).rows.map((row) => row.id);
  return { tagIds, threadIds };
}

export async function collections(client: PostgresClient, libraryId: string) {
  const rows = await client.query<{ id: string; name: string; description: string | null; book_count: string | number; revision: string | number; updated_at: Date | string }>(`
    SELECT c.id::text AS id, c.name, c.description, c.revision, c.updated_at,
      (SELECT count(*) FROM leaflogue.collection_books AS l WHERE l.library_id = c.library_id AND l.collection_id = c.id) AS book_count
    FROM leaflogue.collections AS c WHERE c.library_id = $1 AND c.deleted_at IS NULL ORDER BY c.name LIMIT $2
  `, [libraryId, MAX_LIST]);
  return rows.rows.map((row) => ({
    id: row.id, name: row.name, ...(row.description !== null ? { description: row.description } : {}),
    bookCount: Number(row.book_count), revision: Number(row.revision), updatedAt: ms(row.updated_at),
  }));
}

export async function tags(client: PostgresClient, libraryId: string) {
  const rows = await client.query<{ id: string; name: string; color: string | null; book_count: string | number; highlight_count: string | number; revision: string | number; updated_at: Date | string }>(`
    SELECT t.id::text AS id, t.name, t.color, t.revision, t.updated_at,
      (SELECT count(*) FROM leaflogue.book_tags AS l WHERE l.library_id = t.library_id AND l.tag_id = t.id) AS book_count,
      (SELECT count(*) FROM leaflogue.highlight_tags AS l WHERE l.library_id = t.library_id AND l.tag_id = t.id) AS highlight_count
    FROM leaflogue.tags AS t WHERE t.library_id = $1 AND t.deleted_at IS NULL ORDER BY t.name LIMIT $2
  `, [libraryId, MAX_LIST]);
  return rows.rows.map((row) => ({
    id: row.id, name: row.name, ...(row.color !== null ? { color: row.color } : {}),
    bookCount: Number(row.book_count), highlightCount: Number(row.highlight_count), revision: Number(row.revision), updatedAt: ms(row.updated_at),
  }));
}

export async function threads(client: PostgresClient, libraryId: string) {
  const rows = await client.query<{ id: string; name: string; description: string | null; passage_count: string | number; revision: string | number; updated_at: Date | string }>(`
    SELECT t.id::text AS id, t.name, t.description, t.revision, t.updated_at,
      (SELECT count(*) FROM leaflogue.thread_highlights AS l WHERE l.library_id = t.library_id AND l.thread_id = t.id) AS passage_count
    FROM leaflogue.threads AS t WHERE t.library_id = $1 AND t.deleted_at IS NULL ORDER BY t.updated_at DESC, t.name LIMIT $2
  `, [libraryId, MAX_LIST]);
  return rows.rows.map((row) => ({
    id: row.id, name: row.name, ...(row.description !== null ? { description: row.description } : {}),
    passageCount: Number(row.passage_count), revision: Number(row.revision), updatedAt: ms(row.updated_at),
  }));
}

export async function thread(client: PostgresClient, libraryId: string, threadId: string) {
  if (!isUuid(threadId)) return null;
  const found = (await threads(client, libraryId)).find((entry) => entry.id === threadId);
  if (!found) return null;
  const rows = await client.query<PassageRow & { added_at: Date | string }>(`
    SELECT ${PASSAGE_COLUMNS}, th.added_at ${PASSAGE_FROM}
    JOIN leaflogue.thread_highlights AS th ON th.library_id = h.library_id AND th.highlight_id = h.id AND th.thread_id = $2
    WHERE h.library_id = $1 AND h.deleted_at IS NULL AND h.archived = false
    ORDER BY th.added_at, h.id LIMIT 500
  `, [libraryId, threadId]);
  const views = await passageViews(client, libraryId, rows.rows);
  return { ...found, passages: views.map((view, index) => ({ ...view, addedAt: ms(rows.rows[index]!.added_at) })) };
}

export async function readingHistory(client: PostgresClient, libraryId: string, bookId: string) {
  if (!isUuid(bookId)) return [];
  const rows = await client.query<{ id: string; status: string; source: string; changed_at: Date | string; completed_on: string | null }>(`
    SELECT id::text AS id, status, source, changed_at, completed_on::text AS completed_on
    FROM leaflogue.reading_status_events WHERE library_id = $1 AND book_id = $2
    ORDER BY changed_at DESC, sequence DESC LIMIT 100
  `, [libraryId, bookId]);
  return rows.rows.map((row) => ({ id: row.id, status: row.status, source: row.source, changedAt: ms(row.changed_at), ...(row.completed_on ? { completedOn: row.completed_on } : {}) }));
}

export const EXPORT_TABLES = [
  "books", "highlights", "notes", "collections", "tags", "threads", "collectionBooks", "bookTags",
  "highlightTags", "threadHighlights", "readingStatusEvents", "dailySelections",
] as const;
export type ExportTable = typeof EXPORT_TABLES[number];

const EXPORT_SOURCES: Readonly<Record<ExportTable, { table: string; order: string }>> = {
  books: { table: "books", order: "id" },
  highlights: { table: "highlights", order: "id" },
  notes: { table: "notes", order: "id" },
  collections: { table: "collections", order: "id" },
  tags: { table: "tags", order: "id" },
  threads: { table: "threads", order: "id" },
  collectionBooks: { table: "collection_books", order: "collection_id, book_id" },
  bookTags: { table: "book_tags", order: "tag_id, book_id" },
  highlightTags: { table: "highlight_tags", order: "tag_id, highlight_id" },
  threadHighlights: { table: "thread_highlights", order: "thread_id, highlight_id" },
  readingStatusEvents: { table: "reading_status_events", order: "sequence" },
  dailySelections: { table: "daily_selections", order: "id" },
};
const INTERNAL_COLUMNS = new Set(["library_id", "normalized_name", "sequence"]);
const camel = (name: string) => name.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase());
/** Calendar-date columns; the driver reads them as local midnight, so they are written back as dates. */
const DATE_COLUMNS = new Set(["completed_on", "local_day"]);
const calendarDate = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;

/** Plain records in the same field names as Convex: camelCase, times in milliseconds, nothing null. */
function exportRecord(table: ExportTable, row: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [column, raw] of Object.entries(row)) {
    if (INTERNAL_COLUMNS.has(column) || raw === null || raw === undefined) continue;
    if (table === "books" && column === "metadata") {
      Object.assign(record, json<Record<string, unknown>>(raw));
      continue;
    }
    record[camel(column)] = raw instanceof Date
      ? (DATE_COLUMNS.has(column) ? calendarDate(raw) : raw.getTime())
      : typeof raw === "bigint" ? Number(raw) : raw;
  }
  for (const key of ["revision", "bookRevision"]) if (typeof record[key] === "string") record[key] = Number(record[key]);
  return record;
}

export async function exportPage(client: PostgresClient, libraryId: string, args: { table: ExportTable; paginationOpts: { numItems: number; cursor: string | null } }) {
  const limit = pageSize(args.paginationOpts.numItems, 500);
  const offset = offsetOf(args.paginationOpts.cursor);
  const source = EXPORT_SOURCES[args.table];
  const rows = await client.query<Record<string, unknown>>(
    `SELECT * FROM leaflogue.${source.table} WHERE library_id = $1 ORDER BY ${source.order} LIMIT $2 OFFSET $3`,
    [libraryId, limit + 1, offset],
  );
  const records = rows.rows.slice(0, limit).map((row) => exportRecord(args.table, row));
  return { records, isDone: rows.rows.length <= limit, continueCursor: String(offset + records.length) };
}
