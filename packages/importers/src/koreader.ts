import type { ImportAnnotation, ImportBook, ImportPreview, ImportWarning } from "@leaflogue/contracts";
import { assertUniqueImportIds, BOOK_METADATA_LIMITS, normalizeBookText, normalizeIsbn13 } from "@leaflogue/domain";
import {
  clip,
  containsUnsupportedControlCharacter,
  ExtractionBudget,
  localDateTime,
  MAX_ANNOTATION_TEXT,
  MAX_ANNOTATIONS,
  MAX_LOCATION,
  MAX_TEXT_FILE_BYTES,
  nonEmpty,
  sha256Hex,
  skippedWarning,
  splitAuthors,
} from "./common";
import { luaList, luaNumber, luaString, luaTable, parseLuaData, type LuaTable } from "./lua-data";

/**
 * KOReader keeps one `metadata.<ext>.lua` sidecar per book: beside the book in
 * a `.sdr` folder, or under `koreader/docsettings` or `hashdocsettings`. The
 * same reader app runs on Kobo, Kindle, PocketBook, and Boox, so one importer
 * covers its users on all of them.
 *
 * Highlights come from the `annotations` list (KOReader 2024.05 and later) or,
 * in older sidecars, from `highlight` with notes found on the `bookmarks`
 * entry sharing its timestamp. Page bookmarks without text are skipped.
 */

export const MAX_KOREADER_SIDECARS = 5_000;
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;

export interface KOReaderSidecar {
  /** The sidecar's path relative to where the reader chose; used for the fallback title only. */
  readonly path: string;
  readonly source: string;
}

interface Entry {
  readonly text?: string;
  readonly note?: string;
  readonly page?: string;
  readonly position?: string;
  readonly chapter?: string;
  readonly datetime?: string;
}

export async function parseKOReaderSidecars(sidecars: readonly KOReaderSidecar[]): Promise<ImportPreview> {
  if (sidecars.length === 0) throw new Error("No KOReader sidecar files were found");
  if (sidecars.length > MAX_KOREADER_SIDECARS) {
    throw new Error(`KOReader import exceeds ${MAX_KOREADER_SIDECARS.toLocaleString("en-US")} books`);
  }
  const totalBytes = sidecars.reduce((sum, { source }) => sum + new TextEncoder().encode(source).byteLength, 0);
  if (totalBytes > MAX_TEXT_FILE_BYTES * 4) throw new Error("KOReader sidecar files exceed the 64 MiB limit");

  const budget = new ExtractionBudget("KOReader");
  const books = new Map<string, ImportBook>();
  const annotations: ImportAnnotation[] = [];
  const annotationIds = new Set<string>();
  const skipped = { files: 0, bookmarks: 0, empty: 0 };

  for (const sidecar of sidecars) {
    let table: LuaTable;
    try {
      if (new TextEncoder().encode(sidecar.source).byteLength > MAX_SIDECAR_BYTES) throw new Error("too large");
      if (containsUnsupportedControlCharacter(sidecar.source)) throw new Error("control characters");
      table = parseLuaData(sidecar.source);
    } catch {
      skipped.files += 1;
      continue;
    }
    const entries = readEntries(table, skipped);
    const occurrence = new Map<string, number>();
    if (entries.length === 0) continue;

    const book = await readBook(table, sidecar.path);
    if (!books.has(book.providerRecordId)) {
      budget.add(book);
      books.set(book.providerRecordId, book);
    }
    for (const entry of entries) {
      const text = clip(entry.text, MAX_ANNOTATION_TEXT);
      const note = clip(entry.note, MAX_ANNOTATION_TEXT);
      if (!text && !note) {
        skipped.empty += 1;
        continue;
      }
      // The note is left out of the identity so editing it in KOReader updates
      // the same passage instead of adding a second one.
      const fingerprint = await sha256Hex(JSON.stringify([book.providerRecordId, entry.position ?? entry.page ?? "", entry.datetime ?? "", text ?? ""]));
      const ordinal = (occurrence.get(fingerprint) ?? 0) + 1;
      occurrence.set(fingerprint, ordinal);
      const providerRecordId = `koreader:${fingerprint}:${ordinal}`;
      // A second copy of the same sidecar (a `.sdr` and a docsettings copy) adds nothing new.
      if (annotationIds.has(providerRecordId)) continue;
      annotationIds.add(providerRecordId);
      const createdAt = parseKOReaderTime(entry.datetime);
      const location = clip(locationLabel(entry), MAX_LOCATION);
      const annotation: ImportAnnotation = {
        providerRecordId,
        bookProviderRecordId: book.providerRecordId,
        ...(text ? { text } : {}),
        ...(note ? { note } : {}),
        ...(location ? { location } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
      };
      budget.add(annotation);
      annotations.push(annotation);
      if (annotations.length > MAX_ANNOTATIONS) throw new Error("KOReader import exceeds 100,000 highlights");
    }
  }

  if (annotations.length === 0) {
    throw new Error(skipped.files === sidecars.length ? "These are not KOReader sidecar files" : "No KOReader highlights or notes were found");
  }
  const warnings: ImportWarning[] = [
    ...skippedWarning(skipped.files, "unreadable sidecar file"),
    ...skippedWarning(skipped.bookmarks, "page bookmark without text", "page bookmarks without text"),
    ...skippedWarning(skipped.empty, "empty highlight"),
  ];
  const document = { formatVersion: 1 as const, books: [...books.values()], annotations };
  assertUniqueImportIds(document);
  return { document, warnings };
}

function readEntries(table: LuaTable, skipped: { bookmarks: number }): Entry[] {
  const current = luaTable(table, "annotations");
  if (current) {
    return luaList(current).flatMap((value) => {
      if (!(value instanceof Map)) return [];
      const text = nonEmpty(luaString(value, "text"));
      const note = nonEmpty(luaString(value, "note"));
      // An entry with no position and no text is a page bookmark.
      if (!text && !note) {
        skipped.bookmarks += 1;
        return [];
      }
      return [entryFrom(value, text, note)];
    });
  }

  // Older sidecars: passages under `highlight[page][n]`, notes on the bookmark
  // with the same timestamp, where `notes` repeats the passage and `text` is
  // the reader's note (or an automatic "Page n … @ time" label).
  const notesByTime = new Map<string, string>();
  for (const value of luaList(luaTable(table, "bookmarks"))) {
    if (!(value instanceof Map)) continue;
    const datetime = luaString(value, "datetime");
    const text = nonEmpty(luaString(value, "text"));
    if (!datetime || !text || isAutomaticBookmarkLabel(text)) continue;
    if (text === nonEmpty(luaString(value, "notes"))) continue;
    notesByTime.set(datetime, text);
  }
  const entries: Entry[] = [];
  const pages = luaTable(table, "highlight");
  const pageKeys = [...(pages?.keys() ?? [])].sort((a, b) =>
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)),
  );
  for (const page of pageKeys) {
    for (const value of luaList(luaTable(pages, page))) {
      if (!(value instanceof Map)) continue;
      const text = nonEmpty(luaString(value, "text"));
      const datetime = luaString(value, "datetime");
      const note = datetime ? notesByTime.get(datetime) : undefined;
      if (!text && !note) {
        skipped.bookmarks += 1;
        continue;
      }
      entries.push({ ...entryFrom(value, text, note), page: String(page) });
    }
  }
  return entries;
}

function entryFrom(value: LuaTable, text: string | undefined, note: string | undefined): Entry {
  const pageNumber = luaNumber(value, "pageno") ?? luaNumber(value, "page");
  const position = luaString(value, "pos0") ?? luaString(value, "page");
  const chapter = nonEmpty(luaString(value, "chapter"));
  const datetime = luaString(value, "datetime");
  return {
    ...(text ? { text } : {}),
    ...(note ? { note } : {}),
    ...(pageNumber !== undefined && Number.isSafeInteger(pageNumber) && pageNumber >= 0 ? { page: String(pageNumber) } : {}),
    ...(position ? { position } : {}),
    ...(chapter ? { chapter } : {}),
    ...(datetime ? { datetime } : {}),
  };
}

function isAutomaticBookmarkLabel(text: string): boolean {
  return /^Page \S+ [\s\S]* @ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(text);
}

function locationLabel(entry: Entry): string | undefined {
  if (entry.chapter && entry.page) return `${entry.chapter} · page ${entry.page}`;
  if (entry.page) return `Page ${entry.page}`;
  return entry.chapter;
}

/** KOReader writes local times as "YYYY-MM-DD HH:MM:SS". */
export function parseKOReaderTime(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u);
  return match ? localDateTime(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) : undefined;
}

async function readBook(table: LuaTable, path: string): Promise<ImportBook> {
  const properties = luaTable(table, "doc_props");
  const title = clip(nonEmpty(luaString(properties, "title")) ?? titleFromPath(path), BOOK_METADATA_LIMITS.title) ?? "Untitled book";
  const authors = splitAuthors(luaString(properties, "authors"), BOOK_METADATA_LIMITS.authors, BOOK_METADATA_LIMITS.author);
  const checksum = luaString(table, "partial_md5_checksum");
  const providerRecordId = checksum && /^[0-9a-f]{32}$/iu.test(checksum)
    ? `koreader-book:${checksum.toLocaleLowerCase("en")}`
    : `koreader-book:${await sha256Hex(JSON.stringify([normalizeBookText(title), authors.map(normalizeBookText)]))}`;
  const isbn13 = isbnFrom(luaString(properties, "identifiers"));
  const description = clip(nonEmpty(luaString(properties, "description")), BOOK_METADATA_LIMITS.description);
  const series = clip(nonEmpty(luaString(properties, "series")), BOOK_METADATA_LIMITS.series);
  const seriesIndex = luaNumber(properties, "series_index") ?? luaString(properties, "series_index");
  const seriesNumber = clip(seriesIndex === undefined ? undefined : nonEmpty(String(seriesIndex)), BOOK_METADATA_LIMITS.seriesNumber);
  const language = clip(nonEmpty(luaString(properties, "language")), BOOK_METADATA_LIMITS.language);
  const statusText = luaString(luaTable(table, "summary"), "status");
  const status = statusText === "complete" ? "finished" : statusText === "reading" ? "reading" : undefined;
  return {
    providerRecordId,
    title,
    authors,
    ...(isbn13 ? { isbn13 } : {}),
    ...(description ? { description } : {}),
    ...(series ? { series } : {}),
    ...(seriesNumber ? { seriesNumber } : {}),
    ...(language ? { language } : {}),
    ...(status ? { status } : {}),
  };
}

function isbnFrom(identifiers: string | undefined): string | undefined {
  for (const candidate of identifiers?.match(/[0-9][0-9Xx-]{8,16}/gu) ?? []) {
    const isbn = normalizeIsbn13(candidate);
    if (isbn) return isbn;
  }
  return undefined;
}

/** "Books/The Glass Orchard.sdr/metadata.epub.lua" → "The Glass Orchard". */
function titleFromPath(path: string): string | undefined {
  const folder = path.split(/[\\/]/u).at(-2);
  return nonEmpty(folder?.replace(/\.sdr$/iu, ""));
}
