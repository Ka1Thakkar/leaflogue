import type { ImportAnnotation, ImportBook, ImportPreview, ImportWarning } from "@leaflogue/contracts";
import { assertUniqueImportIds, BOOK_METADATA_LIMITS, normalizeBookText } from "@leaflogue/domain";
import {
  clip,
  containsUnsupportedControlCharacter,
  ExtractionBudget,
  localDateTime,
  MAX_ANNOTATION_TEXT,
  MAX_ANNOTATIONS,
  MAX_LOCATION,
  MAX_TEXT_FILE_BYTES,
  sha256Hex,
  skippedWarning,
  splitAuthors,
} from "./common";

/**
 * Onyx Boox's NeoReader exports one book's highlights as a text file. Recent
 * firmware writes
 *
 *     Reading Notes | <<Title>>Author
 *     Chapter name
 *     2024-10-27 07:56  |  Page No.: 14
 *     "The highlighted passage"
 *     【Annotation】The reader's note
 *     -------------------
 *
 * (sometimes with blank lines between every line), and older firmware
 *
 *     BOOX Reading Notes | <<Title - Author (146)>>
 *     Author
 *     Chapter name
 *     Time：2021-08-17 22:48
 *     【Original Text】The passage
 *     【Annotations】The note
 *     【Page Number】442
 *     -------------------
 *
 * A chapter line carries over to the entries after it until the next one.
 * Anything that does not fit is skipped and counted.
 */

const HEADER = /^\s*(?:[^|<]*\|\s*)?<<(.+?)>>(.*)$/u;
const SEPARATOR = /^\s*-{5,}\s*$/u;
const TIME_LINE = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*\|\s*(?:[^\d\n]*?)(\d{1,6})?\s*$/u;
const LEGACY_TIME = /^Time[：:]\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/u;
const NOTE_LABEL = /^【(?:Note|Notes|Annotation|Annotations)】\s?/u;
const LEGACY_FIELD = /^【(Original Text|Annotations?|Notes?|Page Number)】\s?(.*)$/u;
/** Some firmware appends the book's UUID to the title: "Title__33d2f489-…". */
const TITLE_UUID = /_{1,2}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_ENTRIES = 50_000;

interface Entry {
  readonly text?: string;
  readonly note?: string;
  readonly chapter?: string;
  readonly page?: string;
  readonly createdAt?: number;
}

export function looksLikeBooxExport(source: string): boolean {
  const firstLine = source.slice(0, 4_096).replace(/^\uFEFF/u, "").split(/\r?\n/u)[0] ?? "";
  return /reading notes/iu.test(firstLine) && HEADER.test(firstLine);
}

export async function parseBooxExport(source: string): Promise<ImportPreview> {
  if (new TextEncoder().encode(source).byteLength > MAX_TEXT_FILE_BYTES) throw new Error("Boox export exceeds the 16 MiB limit");
  if (containsUnsupportedControlCharacter(source)) throw new Error("Boox export contains unsupported control characters");
  const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u).map((line) => line.trim());
  const header = HEADER.exec(lines[0] ?? "");
  if (!header) throw new Error("Not a Boox highlights export");
  const legacy = lines.some((line) => line.startsWith("【Original Text】"));

  // Older firmware puts the author alone on the second line.
  const headerAuthor = header[2]!.trim() || (legacy ? lines.slice(1).find(Boolean) ?? "" : "");
  const title = clip(header[1]!.trim().replace(TITLE_UUID, ""), BOOK_METADATA_LIMITS.title) || "Untitled book";
  const authors = splitAuthors(headerAuthor, BOOK_METADATA_LIMITS.authors, BOOK_METADATA_LIMITS.author);
  const bookId = `boox-book:${await sha256Hex(JSON.stringify([normalizeBookText(title), authors.map(normalizeBookText)]))}`;
  const book: ImportBook = { providerRecordId: bookId, title, authors };

  const blocks: string[][] = [[]];
  for (const line of lines.slice(legacy && !header[2]!.trim() ? 2 : 1)) {
    if (SEPARATOR.test(line)) blocks.push([]);
    else if (line) blocks.at(-1)!.push(line);
  }
  const filled = blocks.filter((block) => block.length > 0);
  if (filled.length > MAX_ENTRIES) throw new Error("Boox export exceeds 50,000 entries");

  const entries: Entry[] = [];
  let malformed = 0;
  let chapter: string | undefined;
  for (const block of filled) {
    const parsed = legacy ? legacyEntry(block, chapter) : currentEntry(block, chapter);
    if (!parsed) {
      malformed += 1;
      continue;
    }
    chapter = parsed.chapter;
    entries.push(parsed);
  }

  const budget = new ExtractionBudget("Boox");
  budget.add(book);
  const annotations: ImportAnnotation[] = [];
  const occurrence = new Map<string, number>();
  for (const entry of entries) {
    const location = clip(entry.chapter && entry.page ? `${entry.chapter} · page ${entry.page}` : entry.page ? `Page ${entry.page}` : entry.chapter, MAX_LOCATION);
    const fingerprint = await sha256Hex(JSON.stringify([bookId, entry.page ?? "", entry.text ?? entry.note ?? ""]));
    const ordinal = (occurrence.get(fingerprint) ?? 0) + 1;
    occurrence.set(fingerprint, ordinal);
    const annotation: ImportAnnotation = {
      providerRecordId: `boox:${fingerprint}:${ordinal}`,
      bookProviderRecordId: bookId,
      ...(entry.text ? { text: entry.text } : {}),
      ...(entry.note ? { note: entry.note } : {}),
      ...(location ? { location } : {}),
      ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
    };
    budget.add(annotation);
    annotations.push(annotation);
    if (annotations.length > MAX_ANNOTATIONS) throw new Error("Boox import exceeds 100,000 highlights");
  }
  if (annotations.length === 0) throw new Error("No Boox highlights or notes were found");

  const warnings: ImportWarning[] = skippedWarning(malformed, "entry Leaflogue could not read", "entries Leaflogue could not read");
  const document = { formatVersion: 1 as const, books: [book], annotations };
  assertUniqueImportIds(document);
  return { document, warnings };
}

function currentEntry(block: readonly string[], previousChapter: string | undefined): Entry | undefined {
  const timeIndex = block.findIndex((line) => TIME_LINE.test(line));
  if (timeIndex === -1) return undefined;
  const time = TIME_LINE.exec(block[timeIndex]!)!;
  const chapter = block.slice(0, timeIndex).join(" ").trim() || previousChapter;
  const body = block.slice(timeIndex + 1);
  const noteStart = body.findIndex((line) => NOTE_LABEL.test(line));
  const passage = noteStart === -1 ? body : body.slice(0, noteStart);
  const noteLines = noteStart === -1 ? [] : [body[noteStart]!.replace(NOTE_LABEL, ""), ...body.slice(noteStart + 1)];
  return finish({
    text: unquote(passage.join("\n")),
    note: noteLines.join("\n").trim() || undefined,
    chapter,
    page: time[7],
    createdAt: localDateTime(Number(time[1]), Number(time[2]), Number(time[3]), Number(time[4]), Number(time[5]), Number(time[6] ?? 0)),
  });
}

function legacyEntry(block: readonly string[], previousChapter: string | undefined): Entry | undefined {
  const timeIndex = block.findIndex((line) => LEGACY_TIME.test(line));
  if (timeIndex === -1) return undefined;
  const time = LEGACY_TIME.exec(block[timeIndex]!)!;
  const fields = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of block.slice(timeIndex + 1)) {
    const field = LEGACY_FIELD.exec(line);
    if (field) {
      current = field[1]!.startsWith("Annotation") || field[1]!.startsWith("Note") ? "note" : field[1]!;
      fields.set(current, [field[2]!]);
    } else if (current) {
      fields.get(current)!.push(line);
    }
  }
  const page = fields.get("Page Number")?.join(" ").trim();
  return finish({
    text: fields.get("Original Text")?.join("\n").trim() || undefined,
    note: fields.get("note")?.join("\n").trim() || undefined,
    chapter: block.slice(0, timeIndex).join(" ").trim() || previousChapter,
    page: page && /^\d{1,6}$/u.test(page) ? page : undefined,
    createdAt: localDateTime(Number(time[1]), Number(time[2]), Number(time[3]), Number(time[4]), Number(time[5]), Number(time[6] ?? 0)),
  });
}

function finish(entry: { text?: string; note?: string; chapter?: string; page?: string; createdAt?: number }): Entry | undefined {
  const text = clip(entry.text, MAX_ANNOTATION_TEXT);
  const note = clip(entry.note, MAX_ANNOTATION_TEXT);
  if (!text && !note) return undefined;
  return {
    ...(text ? { text } : {}),
    ...(note ? { note } : {}),
    ...(entry.chapter ? { chapter: entry.chapter } : {}),
    ...(entry.page ? { page: entry.page } : {}),
    ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
  };
}

/** NeoReader wraps passages in quotation marks; quotes inside stay. */
function unquote(value: string): string | undefined {
  const text = value.trim();
  const match = /^["“]([\s\S]*)["”]$/u.exec(text);
  return (match ? match[1]! : text).trim() || undefined;
}

/**
 * Several exports at once (a Boox's notes folder): one book per file, merged
 * by identity, so exporting a book again adds only its new passages.
 */
export async function parseBooxExports(sources: readonly string[]): Promise<ImportPreview> {
  const books = new Map<string, ImportBook>();
  const annotations = new Map<string, ImportAnnotation>();
  const warnings: ImportWarning[] = [];
  let unreadable = 0;
  for (const source of sources) {
    let preview: ImportPreview;
    try {
      preview = await parseBooxExport(source);
    } catch {
      unreadable += 1;
      continue;
    }
    for (const book of preview.document.books) if (!books.has(book.providerRecordId)) books.set(book.providerRecordId, book);
    for (const annotation of preview.document.annotations) if (!annotations.has(annotation.providerRecordId)) annotations.set(annotation.providerRecordId, annotation);
    warnings.push(...preview.warnings);
    if (annotations.size > MAX_ANNOTATIONS) throw new Error("Boox import exceeds 100,000 highlights");
  }
  if (annotations.size === 0) throw new Error("No Boox highlights or notes were found");
  const merged = skippedWarning(warnings.reduce((sum, { message }) => sum + Number(/^Skipped (\d+)/u.exec(message)?.[1] ?? 0), 0), "entry Leaflogue could not read", "entries Leaflogue could not read");
  const document = { formatVersion: 1 as const, books: [...books.values()], annotations: [...annotations.values()] };
  assertUniqueImportIds(document);
  return { document, warnings: [...merged, ...skippedWarning(unreadable, "export Leaflogue could not read", "exports Leaflogue could not read")] };
}
