import type {
  ImportAnnotation,
  ImportBook,
  ImportDocument,
  ImportPreview,
  ImportWarning,
} from "@leaflogue/contracts";
import { assertUniqueImportIds, BOOK_METADATA_LIMITS, normalizeIsbn13 } from "@leaflogue/domain";

export const MAX_KOBO_FILE_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;
const MAX_ANNOTATION_TEXT = 200_000;
const MAX_LOCATION = 1_000;

interface ReadonlyStatement {
  all(...parameters: readonly unknown[]): readonly Record<string, unknown>[];
  get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
  iterate(...parameters: readonly unknown[]): Iterable<Record<string, unknown>>;
}

export interface ReadonlyDatabase {
  prepare(sql: string): ReadonlyStatement;
}

export function extractKoboDatabase(database: ReadonlyDatabase): ImportPreview {
  // Read only stored rows: a view or virtual table could compute values of any
  // size, loop forever, or reach the FTS shadow-table parser.
  for (const table of ["Bookmark", "content"]) {
    const entry = database.prepare("SELECT type, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE").get(table);
    if (entry?.type !== "table" || /^\s*CREATE\s+VIRTUAL\b/iu.test(String(entry.sql ?? ""))) {
      throw new Error(`Not a supported Kobo database: ${table} is not a table`);
    }
  }
  const bookmarkColumns = availableColumns(
    database,
    "Bookmark",
    ["BookmarkID", "VolumeID"],
    ["Text", "Annotation", "Type", "Hidden", "ContentID", "StartContainerPath", "DateCreated", "ChapterProgress"],
  );
  if (!bookmarkColumns.includes("Text") && !bookmarkColumns.includes("Annotation")) {
    throw new Error("Not a supported Kobo database: bookmark text columns are missing");
  }
  const contentColumns = availableColumns(
    database,
    "content",
    ["ContentID"],
    ["Title", "BookTitle", "Attribution", "ISBN", "Description", "Publisher", "Series", "SeriesNumber", "Language", "ReadStatus"],
  );

  const books: ImportBook[] = [];
  const annotations: ImportAnnotation[] = [];
  const warnings: ImportWarning[] = [];
  const seenBooks = new Set<string>();
  const seenAnnotations = new Set<string>();
  const skipped = { hidden: 0, markup: 0, empty: 0, invalid: 0, missingBook: 0 };
  let scanned = 0;
  let extractedBytes = 0;

  const bookmarks = database.prepare(
    `SELECT ${bookmarkColumns.map(selectColumn).join(", ")} FROM "Bookmark"`,
  );
  const metadata = database.prepare(
    `SELECT ${contentColumns.map(selectColumn).join(", ")} FROM "content" WHERE "ContentID" = ? LIMIT 1`,
  );
  const chapters = chapterReader(database);

  for (const row of bookmarks.iterate()) {
    scanned += 1;
    if (scanned > MAX_RECORDS) throw new Error("Kobo database exceeds the 100,000 bookmark limit");
    if (isHidden(row.Hidden)) {
      skipped.hidden += 1;
      continue;
    }
    const kind = text(row.Type)?.toLocaleLowerCase("en");
    if (kind && kind !== "highlight" && kind !== "note") {
      skipped.markup += 1;
      continue;
    }
    const passage = clip(text(row.Text), MAX_ANNOTATION_TEXT);
    const note = clip(text(row.Annotation), MAX_ANNOTATION_TEXT);
    if (!passage && !note) {
      skipped.empty += 1;
      continue;
    }
    const annotationId = text(row.BookmarkID);
    const bookId = text(row.VolumeID);
    if (!annotationId || !bookId) {
      skipped.invalid += 1;
      continue;
    }
    if (seenAnnotations.has(annotationId)) throw new Error("Kobo database contains duplicate bookmark IDs");
    seenAnnotations.add(annotationId);

    const createdAtText = text(row.DateCreated);
    const parsedAt = createdAtText ? Date.parse(createdAtText) : Number.NaN;
    // Keep only plausible times: not before 1970 and not more than a day ahead.
    const createdAt = parsedAt >= 0 && parsedAt <= Date.now() + 86_400_000 ? parsedAt : Number.NaN;
    const place = chapters?.(bookId, text(row.ContentID), numeric(row.ChapterProgress));
    const location = clip(place ?? text(row.StartContainerPath) ?? text(row.ContentID), MAX_LOCATION);
    const annotation: ImportAnnotation = {
      providerRecordId: annotationId,
      bookProviderRecordId: bookId,
      ...(passage ? { text: passage } : {}),
      ...(note ? { note } : {}),
      ...(location ? { location } : {}),
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
    };
    extractedBytes = accountBytes(extractedBytes, annotation);
    annotations.push(annotation);

    if (!seenBooks.has(bookId)) {
      seenBooks.add(bookId);
      const bookRow = metadata.get(bookId);
      if (!bookRow) skipped.missingBook += 1;
      const statusValue = numeric(bookRow?.ReadStatus);
      const status = statusValue === 0 ? "unread" : statusValue === 1 ? "reading" : statusValue === 2 ? "finished" : undefined;
      const isbn13 = normalizeIsbn13(text(bookRow?.ISBN));
      const book: ImportBook = {
        providerRecordId: bookId,
        title: clip(text(bookRow?.Title) ?? text(bookRow?.BookTitle), BOOK_METADATA_LIMITS.title) ?? "Untitled book",
        authors: (text(bookRow?.Attribution)?.split(/\s*[;&]\s*|\r?\n/).filter(Boolean) ?? [])
          .slice(0, BOOK_METADATA_LIMITS.authors)
          .map((author) => clip(author, BOOK_METADATA_LIMITS.author)!),
        ...(isbn13 ? { isbn13 } : {}),
        ...optionalBookMetadata(bookRow),
        ...(status ? { status } : {}),
      };
      extractedBytes = accountBytes(extractedBytes, book);
      books.push(book);
    }
  }

  addSkippedWarning(warnings, skipped.hidden, "hidden bookmark");
  addSkippedWarning(warnings, skipped.markup, "unsupported markup record");
  addSkippedWarning(warnings, skipped.empty, "empty bookmark");
  addSkippedWarning(warnings, skipped.invalid, "bookmark without source IDs");
  if (skipped.missingBook) {
    warnings.push({
      code: "missing-book",
      message: `Kept annotations for ${skipped.missingBook} book(s) whose metadata was missing.`,
    });
  }

  const document: ImportDocument = { formatVersion: 1, books, annotations };
  assertUniqueImportIds(document);
  return { document, warnings };
}

const MAX_CHAPTERS = 5_000;

/**
 * Kobo stores each chapter file as a content row (type 899) of the book, in
 * reading order by VolumeIndex; kepubs add one row per table-of-contents entry,
 * suffixed "-1", "-2"… A bookmark names its chapter file and how far through it
 * the passage starts. This turns that into "Chapter title · 42%", where the
 * percentage counts each chapter file as an equal share of the book.
 */
function chapterReader(database: ReadonlyDatabase):
  | ((bookId: string, contentId: string | undefined, progress: number | undefined) => string | undefined)
  | undefined {
  const names = new Set(
    database.prepare(`PRAGMA table_info("content")`).all().map((row) => String(row.name).toLocaleLowerCase("en")),
  );
  if (!["contentid", "title", "contenttype", "bookid", "volumeindex"].every((name) => names.has(name))) return undefined;
  const statement = database.prepare(
    `SELECT "ContentID" AS "ContentID", "Title" AS "Title" FROM "content"
     WHERE "BookID" = ? AND "ContentType" = 899 ORDER BY "VolumeIndex" LIMIT ${MAX_CHAPTERS}`,
  );
  const cache = new Map<string, { readonly files: readonly string[]; readonly titles: ReadonlyMap<string, string> }>();
  return (bookId, contentId, progress) => {
    if (!contentId) return undefined;
    let book = cache.get(bookId);
    if (!book) {
      const files: string[] = [];
      const titles = new Map<string, string>();
      for (const row of statement.all(bookId)) {
        const id = text(row.ContentID);
        if (!id) continue;
        const file = id.replace(/-\d+$/u, "");
        if (!titles.has(file)) {
          files.push(file);
          titles.set(file, clip(text(row.Title)?.trim(), 200) ?? "");
        }
      }
      book = { files, titles };
      cache.set(bookId, book);
    }
    const file = book.titles.has(contentId) ? contentId : contentId.replace(/-\d+$/u, "");
    const index = book.files.indexOf(file);
    if (index < 0) return undefined;
    const within = progress !== undefined && progress >= 0 && progress <= 1 ? progress : 0;
    const percent = Math.min(100, Math.max(0, Math.round(((index + within) / book.files.length) * 100)));
    const title = book.titles.get(file);
    return title ? `${title} · ${percent}%` : `${percent}%`;
  };
}

function availableColumns(
  database: ReadonlyDatabase,
  table: "Bookmark" | "content",
  required: readonly string[],
  optional: readonly string[],
): string[] {
  const names = new Set(
    database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name).toLocaleLowerCase("en")),
  );
  for (const name of required) {
    if (!names.has(name.toLocaleLowerCase("en"))) {
      throw new Error(`Not a supported Kobo database: ${table}.${name} is missing`);
    }
  }
  return [...required, ...optional.filter((name) => names.has(name.toLocaleLowerCase("en")))];
}

function selectColumn(name: string): string {
  return `"${name}" AS "${name}"`;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Shorten an over-long field instead of rejecting the whole import. */
function clip(value: string | undefined, max: number): string | undefined {
  return value === undefined || value.length <= max ? value : value.slice(0, max);
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint" && Number.isSafeInteger(Number(value))) return Number(value);
  return undefined;
}

function isHidden(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !["", "0", "false"].includes(value.trim().toLocaleLowerCase("en"));
  return true;
}

function optionalBookMetadata(row: Record<string, unknown> | undefined): Partial<ImportBook> {
  const description = clip(text(row?.Description), BOOK_METADATA_LIMITS.description);
  const publisher = clip(text(row?.Publisher), BOOK_METADATA_LIMITS.publisher);
  const series = clip(text(row?.Series), BOOK_METADATA_LIMITS.series);
  const rawSeriesNumber = row?.SeriesNumber;
  const seriesNumber = clip(rawSeriesNumber === undefined || rawSeriesNumber === null ? undefined : String(rawSeriesNumber), BOOK_METADATA_LIMITS.seriesNumber);
  const language = clip(text(row?.Language), BOOK_METADATA_LIMITS.language);
  return {
    ...(description ? { description } : {}),
    ...(publisher ? { publisher } : {}),
    ...(series ? { series } : {}),
    ...(seriesNumber ? { seriesNumber } : {}),
    ...(language ? { language } : {}),
  };
}

function accountBytes(current: number, value: ImportBook | ImportAnnotation): number {
  const next = current + new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (next > MAX_EXTRACTED_BYTES) throw new Error("Extracted Kobo data exceeds the 64 MiB limit");
  return next;
}

function addSkippedWarning(warnings: ImportWarning[], count: number, label: string): void {
  if (!count) return;
  warnings.push({
    code: "skipped-records",
    message: `Skipped ${count} ${label}${count === 1 ? "" : "s"}.`,
  });
}
