import { MAX_NOTE_BYTES } from "@leaflogue/contracts";
import type { ImportAnnotation, ImportBook, ImportPreview, ImportWarning } from "@leaflogue/contracts";
import { assertUniqueImportIds, normalizeIsbn13 } from "@leaflogue/domain";
import { ExtractionBudget } from "./common";
import { readCsv } from "./csv";

const REQUIRED = ["Book Id", "Title", "Author", "Exclusive Shelf", "My Review"] as const;
const STATUSES = { read: "finished", "currently-reading": "reading", "to-read": "unread" } as const;

/** Goodreads CSV -> the existing canonical book/note import pipeline. */
export function parseGoodreadsCsv(source: string): ImportPreview {
  const [head, ...rows] = readCsv(source);
  if (!head) throw new Error("Goodreads CSV is empty");
  const headers = head.map((name) => name.trim());
  if (new Set(headers).size !== headers.length || REQUIRED.some((name) => !headers.includes(name))) {
    throw new Error("Not a supported Goodreads library CSV: required columns are missing or duplicated");
  }
  const books: ImportBook[] = [], annotations: ImportAnnotation[] = [], warnings: ImportWarning[] = [];
  const budget = new ExtractionBudget("Goodreads");
  const omitted = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row.length !== headers.length) throw new Error(`Goodreads CSV row ${index + 2} has the wrong number of columns`);
    const get = (key: string) => row[headers.indexOf(key)]?.trim() ?? "";
    const id = get("Book Id"), title = get("Title"), author = get("Author");
    if (!/^\d{1,30}$/u.test(id) || !title || title.length > 1_000 || author.length > 300) throw new Error(`Goodreads CSV row ${index + 2} has invalid book details`);
    const providerRecordId = `goodreads:${id}`;
    for (const column of ["My Rating", "Private Notes", "Additional Authors", "Bookshelves", "Date Read", "Date Added"]) {
      if (get(column) && get(column) !== "0") omitted.add(column);
    }
    const shelf = get("Exclusive Shelf");
    const status = Object.hasOwn(STATUSES, shelf) ? STATUSES[shelf as keyof typeof STATUSES] : undefined;
    if (shelf && !status) warnings.push({ code: "skipped-records", providerRecordId, message: `Kept the book on row ${index + 2} without mapping its unsupported shelf status.` });
    const rawIsbn = get("ISBN13").replace(/^="([\dXx-]+)"$/u, "$1");
    const isbn13 = rawIsbn ? normalizeIsbn13(rawIsbn) : undefined;
    if (rawIsbn && !isbn13) warnings.push({ code: "skipped-records", providerRecordId, message: `Ignored an invalid ISBN on row ${index + 2}.` });
    const book: ImportBook = { providerRecordId, title, authors: author ? [author] : [], ...(isbn13 ? { isbn13 } : {}), ...(status ? { status } : {}) };
    budget.add(book); books.push(book);
    const note = get("My Review");
    if (note) {
      if (new TextEncoder().encode(note).byteLength > MAX_NOTE_BYTES) throw new Error(`Goodreads review on row ${index + 2} exceeds the 24 KiB note limit`);
      const annotation: ImportAnnotation = { providerRecordId: `${providerRecordId}:review`, bookProviderRecordId: providerRecordId, note };
      budget.add(annotation); annotations.push(annotation);
    }
  }
  if (!books.length) throw new Error("Goodreads CSV contains no books");
  if (omitted.size) warnings.push({ code: "skipped-records", message: `This import keeps titles, primary authors, ISBN13, shelf status and reviews. Not imported: ${[...omitted].join(", ")}.` });
  assertUniqueImportIds({ formatVersion: 1, books, annotations });
  return { document: { formatVersion: 1, books, annotations }, warnings };
}
