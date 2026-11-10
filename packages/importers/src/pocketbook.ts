import type { ImportAnnotation, ImportBook, ImportPreview, ImportWarning } from "@leaflogue/contracts";
import { assertUniqueImportIds, BOOK_METADATA_LIMITS, normalizeBookText, normalizeIsbn13 } from "@leaflogue/domain";
import type { ReadonlyDatabase } from "./kobo";
import {
  clip,
  ExtractionBudget,
  MAX_ANNOTATION_TEXT,
  MAX_ANNOTATIONS,
  MAX_LOCATION,
  nonEmpty,
  plausibleTime,
  sha256Hex,
  skippedWarning,
  splitAuthors,
} from "./common";

/**
 * PocketBook (and Vivlio, which runs the same software) keeps its library in
 * SQLite `system/config/books.db`. Each highlight or note is a row in `Items`
 * (`TypeID` 4) whose parent is the book, directly or through `Files`; its
 * parts are rows in `Tags`. Tag IDs are looked up by name in `TagNames`
 * (`bm.quotation`, `bm.note`) and otherwise default to the IDs PocketBook
 * uses: 102 type, 104 passage, 105 note. Values are JSON on recent firmware
 * (`{"text": …}`, sometimes `{"context": …}` for notes) and plain text on
 * older firmware; both are read. Hidden or deleted items (`State` other than
 * 0), bookmarks, and pencil drawings are skipped.
 *
 * Like the Kobo importer, only stored tables are read: views and virtual
 * tables are refused, and every query selects named columns. Row IDs are not
 * used as identities: they differ between devices and after a re-index, so
 * books are identified by title, authors, and ISBN, and highlights by the
 * device's UUID or, failing that, their book, position, and text.
 */

const REQUIRED_TABLES = ["Books", "Items", "Tags", "TagNames"] as const;
const MAX_ROWS = 500_000;
const MAX_FILES = 200_000;
/** A single tag value larger than this is skipped unread; all values together are capped too. */
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_VALUE_TOTAL = 64 * 1024 * 1024;

function isStoredTable(database: ReadonlyDatabase, table: string): boolean {
  const entry = database.prepare("SELECT type, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE").get(table);
  return entry?.type === "table" && !/^\s*CREATE\s+VIRTUAL\b/iu.test(String(entry.sql ?? ""));
}

export function isPocketBookDatabase(database: ReadonlyDatabase): boolean {
  return REQUIRED_TABLES.every((table) => {
    const entry = database.prepare("SELECT type FROM sqlite_master WHERE name = ? COLLATE NOCASE").get(table);
    return entry?.type === "table";
  });
}

export async function extractPocketBookDatabase(database: ReadonlyDatabase, now = Date.now()): Promise<ImportPreview> {
  for (const table of REQUIRED_TABLES) {
    if (!isStoredTable(database, table)) throw new Error(`Not a supported PocketBook database: ${table} is not a table`);
  }
  const has = (table: string, column: string) =>
    database.prepare(`PRAGMA table_info("${table}")`).all().some((row) => String(row.name).toLocaleLowerCase("en") === column.toLocaleLowerCase("en"));
  for (const [table, column] of [["Books", "OID"], ["Items", "OID"], ["Items", "ParentID"], ["Tags", "ItemID"], ["Tags", "TagID"], ["Tags", "Val"], ["TagNames", "OID"], ["TagNames", "TagName"]] as const) {
    if (!has(table, column)) throw new Error(`Not a supported PocketBook database: ${table}.${column} is missing`);
  }
  const optional = (table: string, column: string, alias = column) => (has(table, column) ? `"${table}"."${column}"` : "NULL") + ` AS "${alias}"`;

  const tagIds = new Map<string, number>();
  for (const row of database.prepare(`SELECT "OID" AS id, "TagName" AS name FROM "TagNames"`).all()) {
    if (typeof row.name === "string" && (typeof row.id === "number" || typeof row.id === "bigint")) tagIds.set(row.name, Number(row.id));
  }
  const quotation = tagIds.get("bm.quotation") ?? 104;
  const note = tagIds.get("bm.note") ?? 105;
  const type = tagIds.get("bm.type") ?? 102;
  // Some firmware hangs annotations off the book's file rather than the book.
  const bookOfFile = new Map<string, string>();
  if (isStoredTable(database, "Files") && has("Files", "OID") && has("Files", "BookID")) {
    for (const row of database.prepare(`SELECT "OID" AS id, "BookID" AS bookId FROM "Files" LIMIT ${MAX_FILES + 1}`).iterate()) {
      if (bookOfFile.size >= MAX_FILES) throw new Error("PocketBook database exceeds the file limit");
      const file = idText(row.id);
      const book = idText(row.bookId);
      if (file && book) bookOfFile.set(file, book);
    }
  }
  const bookExists = database.prepare(`SELECT 1 AS found FROM "Books" WHERE "OID" = ? LIMIT 1`);
  const resolveBook = (parent: string) => (bookExists.get(Number(parent)) ? parent : bookOfFile.get(parent) ?? parent);

  // One row per item part; items group them back together.
  const parts = database.prepare(`
    SELECT "Items"."OID" AS itemId, "Items"."ParentID" AS bookId, ${optional("Items", "State", "state")},
           ${optional("Items", "TimeAlt", "itemTime")}, ${optional("Items", "HashUUID", "uuid")},
           "Tags"."TagID" AS tagId, length(CAST("Tags"."Val" AS BLOB)) AS valueBytes,
           CASE WHEN length(CAST("Tags"."Val" AS BLOB)) <= ${MAX_VALUE_BYTES} THEN "Tags"."Val" END AS value,
           ${optional("Tags", "TimeEdt", "tagTime")}
    FROM "Tags" JOIN "Items" ON "Items"."OID" = "Tags"."ItemID"
    WHERE "Tags"."TagID" IN (?, ?, ?)${has("Items", "TypeID") ? ` AND "Items"."TypeID" = 4` : ""}
    ORDER BY "Items"."ParentID", "Items"."OID"
  `);
  interface Item { bookId: string; uuid?: string; deleted: boolean; time?: number; text?: string; note?: string; position?: string; kind?: string }
  const items = new Map<string, Item>();
  const seenParts = new Set<string>();
  let rows = 0;
  let valueBytes = 0;
  for (const row of parts.iterate(quotation, note, type)) {
    if (++rows > MAX_ROWS) throw new Error("PocketBook database exceeds the row limit");
    // Duplicate item IDs could repeat one large value many times; every value counts.
    valueBytes += numeric(row.valueBytes) ?? 0;
    if (valueBytes > MAX_VALUE_TOTAL) throw new Error("PocketBook highlights exceed the 64 MiB limit");
    const itemId = idText(row.itemId);
    const parent = idText(row.bookId);
    if (!itemId || !parent) continue;
    const part = `${itemId}:${String(row.tagId)}`;
    if (seenParts.has(part)) continue;
    seenParts.add(part);
    const bookId = resolveBook(parent);
    const item = items.get(itemId) ?? { bookId, deleted: false };
    items.set(itemId, item);
    const uuid = nonEmpty(row.uuid);
    if (uuid) item.uuid = uuid;
    const state = numeric(row.state);
    if (state !== undefined && state !== 0) item.deleted = true;
    const time = seconds(row.tagTime) ?? seconds(row.itemTime);
    if (time !== undefined) item.time = Math.min(item.time ?? time, time);
    const tag = numeric(row.tagId);
    const { text, position } = tagValue(row.value);
    if (tag === quotation) {
      item.text = text;
      item.position = position;
    } else if (tag === note) {
      item.note = text;
    } else if (tag === type) {
      item.kind = text?.toLocaleLowerCase("en");
    }
  }

  const bookRows = database.prepare(`
    SELECT "OID" AS id, ${optional("Books", "Title", "title")}, ${optional("Books", "Authors", "authors")},
           ${optional("Books", "Isbn", "isbn")}, ${optional("Books", "Publisher", "publisher")},
           ${optional("Books", "Series", "series")}, ${optional("Books", "Lang", "language")}
    FROM "Books" WHERE "OID" = ? LIMIT 1
  `);
  const budget = new ExtractionBudget("PocketBook");
  const books = new Map<string, ImportBook>();
  const bookIdOf = new Map<string, string>();
  const annotations: ImportAnnotation[] = [];
  const occurrence = new Map<string, number>();
  const annotationIds = new Set<string>();
  const skipped = { deleted: 0, bookmarks: 0, empty: 0 };
  for (const item of items.values()) {
    if (item.deleted) {
      skipped.deleted += 1;
      continue;
    }
    if (item.kind === "bookmark" || item.kind === "draws") {
      skipped.bookmarks += 1;
      continue;
    }
    const text = clip(nonEmpty(item.text), MAX_ANNOTATION_TEXT);
    const noteText = clip(nonEmpty(item.note), MAX_ANNOTATION_TEXT);
    if (!text && !noteText) {
      skipped.empty += 1;
      continue;
    }
    let bookId = bookIdOf.get(item.bookId);
    if (!bookId) {
      const row = bookRows.get(Number(item.bookId));
      const isbn13 = normalizeIsbn13(nonEmpty(row?.isbn));
      const publisher = clip(nonEmpty(row?.publisher), BOOK_METADATA_LIMITS.publisher);
      const series = clip(nonEmpty(row?.series), BOOK_METADATA_LIMITS.series);
      const language = clip(nonEmpty(row?.language), BOOK_METADATA_LIMITS.language);
      const title = clip(nonEmpty(row?.title), BOOK_METADATA_LIMITS.title) ?? "Untitled book";
      const authors = splitAuthors(nonEmpty(row?.authors), BOOK_METADATA_LIMITS.authors, BOOK_METADATA_LIMITS.author);
      bookId = `pocketbook-book:${await sha256Hex(JSON.stringify([normalizeBookText(title), authors.map(normalizeBookText), isbn13 ?? ""]))}`;
      bookIdOf.set(item.bookId, bookId);
      if (!books.has(bookId)) {
        const book: ImportBook = {
          providerRecordId: bookId,
          title,
          authors,
          ...(isbn13 ? { isbn13 } : {}),
          ...(publisher ? { publisher } : {}),
          ...(series ? { series } : {}),
          ...(language ? { language } : {}),
        };
        budget.add(book);
        books.set(bookId, book);
      }
    }
    const createdAt = plausibleTime(item.time, now);
    const location = clip(item.position, MAX_LOCATION);
    let providerRecordId: string;
    if (item.uuid && /^[0-9A-Za-z-]{1,64}$/u.test(item.uuid)) {
      providerRecordId = `pocketbook:${item.uuid}`;
    } else {
      const fingerprint = await sha256Hex(JSON.stringify([bookId, item.position ?? "", text ?? noteText ?? ""]));
      const ordinal = (occurrence.get(fingerprint) ?? 0) + 1;
      occurrence.set(fingerprint, ordinal);
      providerRecordId = `pocketbook:${fingerprint}:${ordinal}`;
    }
    if (annotationIds.has(providerRecordId)) continue;
    annotationIds.add(providerRecordId);
    const annotation: ImportAnnotation = {
      providerRecordId,
      bookProviderRecordId: bookId,
      ...(text ? { text } : {}),
      ...(noteText ? { note: noteText } : {}),
      ...(location ? { location } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
    budget.add(annotation);
    annotations.push(annotation);
    if (annotations.length > MAX_ANNOTATIONS) throw new Error("PocketBook import exceeds 100,000 highlights");
  }
  if (annotations.length === 0) throw new Error("No PocketBook highlights or notes were found");

  const warnings: ImportWarning[] = [
    ...skippedWarning(skipped.deleted, "deleted highlight"),
    ...skippedWarning(skipped.bookmarks, "bookmark or pencil drawing", "bookmarks and pencil drawings"),
    ...skippedWarning(skipped.empty, "empty highlight"),
  ];
  const document = { formatVersion: 1 as const, books: [...books.values()], annotations };
  assertUniqueImportIds(document);
  return { document, warnings };
}

/** A tag value: JSON `{"text", "begin"}` on recent firmware, plain text before. */
function tagValue(value: unknown): { text?: string; position?: string } {
  const raw = typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;
  if (raw === undefined) return {};
  if (raw.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const fields = parsed as Record<string, unknown>;
        const text = typeof fields.text === "string" ? fields.text : typeof fields.context === "string" ? fields.context : undefined;
        const position = typeof fields.begin === "string" ? pageFrom(fields.begin) : undefined;
        return { ...(text !== undefined ? { text } : {}), ...(position ? { position } : {}) };
      }
    } catch {
      // Not JSON after all: fall through to the plain text.
    }
  }
  return { text: raw };
}

/** "pbr:/word?page=12&offs=40" → "Page 12"; an EPUB CFI or anything else is kept as written. */
function pageFrom(position: string): string | undefined {
  const page = /[?&]page=(\d{1,6})\b/u.exec(position)?.[1];
  return page ? `Page ${Number(page)}` : nonEmpty(position);
}

function idText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint" && Number.isSafeInteger(Number(value))) return Number(value);
  return undefined;
}

/** PocketBook stores Unix seconds. */
function seconds(value: unknown): number | undefined {
  const parsed = numeric(value);
  return parsed !== undefined && parsed > 0 ? parsed * 1000 : undefined;
}
