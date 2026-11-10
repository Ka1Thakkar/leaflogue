import type { ImportAnnotation, ImportBook, ImportPreview, ImportWarning } from "@leaflogue/contracts";
import { assertUniqueImportIds, BOOK_METADATA_LIMITS, normalizeBookText } from "@leaflogue/domain";
import {
  clip,
  containsUnsupportedControlCharacter,
  ExtractionBudget,
  localDateTime,
  MAX_ANNOTATION_TEXT,
  MAX_ANNOTATIONS,
  MAX_TEXT_FILE_BYTES,
  sha256Hex,
  skippedWarning,
} from "./common";

/**
 * Tolino keeps every highlight, note, and bookmark in one `notes.txt` at the
 * device root. Entries are separated by a line of dashes:
 *
 *     Title (Author)
 *     Highlight on page 12: "the passage"
 *     Added on 13.11.2021 | 18:26
 *
 * A note entry puts the note after the label and the passage last. Some
 * firmware separates every line with a blank one; a page can be a range or
 * missing. Labels follow the device language, so entries are recognised by
 * shape ("<label> <page>: …" then a date line) and the label only decides
 * between highlight, note, and bookmark.
 */

// Spaces and tabs only: "\s" would also match line breaks, and with the
// multiline flag a run of blank lines would then take quadratic time.
const SEPARATOR = /^[ \t]*-{5,}[ \t]*$/mu;
const MAX_ENTRIES = 50_000;
/** Labels in Tolino's six languages; a label that is neither a note nor a bookmark is a highlight. */
const NOTE_LABEL = /^(?:note|notiz|nota|notitie)\b/iu;
const BOOKMARK_LABEL = /^(?:bookmark|lesezeichen|segnalibro|signet|bladwijzer|marcapáginas)\b/iu;
/** "<label> <page or range>: rest", or a label run straight into the quote when the page is missing. */
const LABEL_LINE = /^([^\d"“„«:]{1,80}?)(?:\s(\d{1,6}(?:\s*-\s*\d{1,6})?))?\s*(?::\s?|(?=["“„«]))(.*)$/u;
const OPEN_QUOTE = /^["“„«‚]/u;
const CLOSE_QUOTE = /["”“»‘’]$/u;
/** Date lines whose language writes the month first. */
const MONTH_FIRST = /^(?:added on|changed on)\b/iu;

interface Entry {
  readonly title: string;
  readonly authors: string[];
  readonly page?: string;
  readonly text?: string;
  readonly note?: string;
  readonly createdAt?: number;
}

/** Whether a text file looks like Tolino's notes.txt (used before choosing a parser). */
export function looksLikeTolinoNotes(source: string): boolean {
  const head = source.slice(0, 64 * 1024);
  return SEPARATOR.test(head) && head.split(SEPARATOR).some((block) => {
    const lines = contentLines(block);
    return lines.length >= 3 && LABEL_LINE.test(lines[1]!) && isDateLine(lines.at(-1)!);
  });
}

export async function parseTolinoNotes(source: string): Promise<ImportPreview> {
  if (new TextEncoder().encode(source).byteLength > MAX_TEXT_FILE_BYTES) throw new Error("Tolino notes file exceeds the 16 MiB limit");
  // Labels can contain no-break spaces ("auf Seite" with U+00A0).
  const text = source.replace(/^\uFEFF/u, "").replace(/\u00A0/gu, " ");
  if (containsUnsupportedControlCharacter(text)) throw new Error("Tolino notes file contains unsupported control characters");
  const blocks = text.split(SEPARATOR).map((block) => block.trim()).filter(Boolean);
  if (blocks.length > MAX_ENTRIES) throw new Error("Tolino notes file exceeds 50,000 entries");

  const entries: Entry[] = [];
  const skipped = { bookmarks: 0, malformed: 0 };
  for (const block of blocks) {
    const entry = parseBlock(block);
    if (entry === "bookmark") skipped.bookmarks += 1;
    else if (entry) entries.push(entry);
    else skipped.malformed += 1;
  }
  if (entries.length === 0) throw new Error("No Tolino highlights or notes were found");
  if (entries.length > MAX_ANNOTATIONS) throw new Error("Tolino import exceeds 100,000 highlights");

  const budget = new ExtractionBudget("Tolino");
  const books = new Map<string, ImportBook>();
  const annotations: ImportAnnotation[] = [];
  const occurrence = new Map<string, number>();
  for (const entry of entries) {
    const bookKey = JSON.stringify([normalizeBookText(entry.title), entry.authors.map(normalizeBookText)]);
    const bookId = `tolino-book:${await sha256Hex(bookKey)}`;
    if (!books.has(bookId)) {
      const book: ImportBook = { providerRecordId: bookId, title: entry.title, authors: entry.authors };
      budget.add(book);
      books.set(bookId, book);
    }
    // The passage, not the note, identifies an entry, so an edited note updates it.
    const fingerprint = await sha256Hex(JSON.stringify([bookKey, entry.page ?? "", entry.text ?? entry.note ?? ""]));
    const ordinal = (occurrence.get(fingerprint) ?? 0) + 1;
    occurrence.set(fingerprint, ordinal);
    const annotation: ImportAnnotation = {
      providerRecordId: `tolino:${fingerprint}:${ordinal}`,
      bookProviderRecordId: bookId,
      ...(entry.text ? { text: entry.text } : {}),
      ...(entry.note ? { note: entry.note } : {}),
      ...(entry.page ? { location: `Page ${entry.page}` } : {}),
      ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
    };
    budget.add(annotation);
    annotations.push(annotation);
  }

  const warnings: ImportWarning[] = [
    ...skippedWarning(skipped.bookmarks, "bookmark"),
    ...skippedWarning(skipped.malformed, "entry Leaflogue could not read", "entries Leaflogue could not read"),
  ];
  const document = { formatVersion: 1 as const, books: [...books.values()], annotations };
  assertUniqueImportIds(document);
  return { document, warnings };
}

/** The block's non-empty lines, trimmed. */
function contentLines(block: string): string[] {
  return block.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function parseBlock(block: string): Entry | "bookmark" | undefined {
  const rawLines = block.split(/\r?\n/u).map((line) => line.trim());
  const lines = rawLines.filter(Boolean);
  if (lines.length < 3) return undefined;
  const heading = lines[0]!;
  const label = LABEL_LINE.exec(lines[1]!);
  const dateLine = lines.at(-1)!;
  if (!label || !isDateLine(dateLine)) return undefined;
  const [, name, pageText, firstLine] = label as unknown as [string, string, string | undefined, string];
  const labelName = name.trim();
  if (BOOKMARK_LABEL.test(labelName)) return "bookmark";
  const page = pageText?.replace(/\s+/gu, "");
  const { title, authors } = splitHeading(heading);
  const createdAt = parseTolinoDate(dateLine);
  const base = { title, authors, ...(page ? { page } : {}), ...(createdAt !== undefined ? { createdAt } : {}) };
  const body = [firstLine, ...lines.slice(2, -1)].filter(Boolean);

  if (NOTE_LABEL.test(labelName)) {
    // The note comes first and the quoted passage last. When the file has
    // blank lines, the passage is the last paragraph; otherwise it starts at
    // the last line that opens with a quotation mark.
    const paragraphs = paragraphsOf(rawLines.slice(rawLines.indexOf(lines[1]!) + 1, rawLines.lastIndexOf(dateLine)));
    let noteLines: string[];
    let passageLines: string[];
    const lastParagraph = paragraphs.at(-1);
    if (paragraphs.length > 1 && lastParagraph && OPEN_QUOTE.test(lastParagraph[0]!)) {
      passageLines = lastParagraph;
      noteLines = [firstLine, ...paragraphs.slice(0, -1).flat()].filter(Boolean);
    } else {
      let start = -1;
      for (let index = body.length - 1; index >= 0; index -= 1) {
        if (OPEN_QUOTE.test(body[index]!) && (index > 0 || !firstLine)) {
          start = index;
          break;
        }
      }
      passageLines = start === -1 ? [] : body.slice(start);
      noteLines = start === -1 ? body : body.slice(0, start);
    }
    const note = clip(noteLines.join("\n").trim() || undefined, MAX_ANNOTATION_TEXT);
    const text = clip(unquote(passageLines.join("\n")), MAX_ANNOTATION_TEXT);
    if (!note && !text) return undefined;
    return { ...base, ...(text ? { text } : {}), ...(note ? { note } : {}) };
  }
  const text = clip(unquote(body.join("\n")), MAX_ANNOTATION_TEXT);
  return text ? { ...base, text } : undefined;
}

function paragraphsOf(lines: readonly string[]): string[][] {
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (line) paragraphs.at(-1)!.push(line);
    else if (paragraphs.at(-1)!.length) paragraphs.push([]);
  }
  return paragraphs.filter((paragraph) => paragraph.length);
}

/** Strip the outer quotation marks Tolino adds; quotes inside the passage stay. */
function unquote(value: string): string | undefined {
  let text = value.trim();
  if (OPEN_QUOTE.test(text)) text = text.slice(1);
  if (CLOSE_QUOTE.test(text)) text = text.slice(0, -1);
  return text.trim() || undefined;
}

/**
 * "Title (Author)": the last bracketed group is the author, so a title with
 * its own brackets ("Dune (Book 1) (Frank Herbert)") keeps them.
 */
function splitHeading(heading: string): { title: string; authors: string[] } {
  const match = /^(.*\S)\s*\(([^()]*)\)\s*$/u.exec(heading);
  const title = clip((match ? match[1]! : heading).trim(), BOOK_METADATA_LIMITS.title)!;
  const authors = match
    ? match[2]!.split(/\s*[;&]\s*/u).map((author) => author.trim()).filter(Boolean)
      .slice(0, BOOK_METADATA_LIMITS.authors).map((author) => clip(author, BOOK_METADATA_LIMITS.author)!)
    : [];
  return { title: title || heading, authors };
}

const DATE_PATTERN = /(\d{1,4})[./-](\d{1,2})[./-](\d{2,4})\s*\|\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?/u;

function isDateLine(line: string): boolean {
  return DATE_PATTERN.test(line) && line.trim().length < 120;
}

/**
 * Dates follow the device language: "13.11.2021 | 18:26" (day first),
 * "2021-11-13 | 18:26", or "11/13/2021 | 6:26 PM". A slashed date is read
 * only when the day is unambiguous; otherwise the time is left out.
 */
export function parseTolinoDate(line: string): number | undefined {
  const match = DATE_PATTERN.exec(line);
  if (!match) return undefined;
  const [, a, b, c, hourText, minute, second, meridiem] = match as unknown as [string, string, string, string, string, string, string | undefined, string | undefined];
  const separator = line.slice(line.indexOf(a) + a.length, line.indexOf(a) + a.length + 1);
  let year: number, month: number, day: number;
  if (a.length === 4) [year, month, day] = [Number(a), Number(b), Number(c)];
  else if (separator === ".") [day, month, year] = [Number(a), Number(b), Number(c)];
  // English writes 11/13/2021, Dutch 13/11/2021.
  else if (MONTH_FIRST.test(line.trim())) [month, day, year] = [Number(a), Number(b), Number(c)];
  else if (/^(?:toegevoegd op|gewijzigd op)\b/iu.test(line.trim())) [day, month, year] = [Number(a), Number(b), Number(c)];
  else if (Number(a) > 12) [day, month, year] = [Number(a), Number(b), Number(c)];
  else if (Number(b) > 12) [month, day, year] = [Number(a), Number(b), Number(c)];
  else if (Number(a) === Number(b)) [day, month, year] = [Number(a), Number(b), Number(c)];
  else return undefined;
  if (year < 100) year += 2000;
  let hour = Number(hourText);
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (/^p/iu.test(meridiem) ? 12 : 0);
  }
  return localDateTime(year, month, day, hour, Number(minute), Number(second ?? 0));
}
