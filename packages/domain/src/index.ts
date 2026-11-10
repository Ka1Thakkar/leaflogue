import type { BookId, HighlightId, ImportDocument, UpdateBookMetadata } from "@leaflogue/contracts";

export interface DailyCandidate {
  readonly id: HighlightId;
  readonly bookId: BookId;
}

export interface DailyChoiceSeed {
  readonly localDay: string;
  readonly timezone: string;
  readonly candidateDigest: string;
  readonly revision: number;
}

export function resolveLocalDay(timezone: string, now: number): { readonly localDay: string; readonly timezone: string } {
  const requestedTimezone = timezone.trim();
  if (!requestedTimezone || new TextEncoder().encode(requestedTimezone).length > 100 ||
      !Number.isSafeInteger(now) || now < 0) throw new Error("Timezone is invalid");
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: requestedTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const canonicalTimezone = formatter.resolvedOptions().timeZone;
    const parts = formatter.formatToParts(new Date(now));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (!values.year || !values.month || !values.day) throw new Error("missing calendar fields");
    return { localDay: `${values.year}-${values.month}-${values.day}`, timezone: canonicalTimezone };
  } catch {
    throw new Error("Timezone is invalid");
  }
}

/** Validate a calendar-only date without allowing JavaScript date rollover. */
export function validateCompletionDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("Completion date must be a valid calendar date");
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error("Completion date must be a valid calendar date");
  }
  return value;
}

export function chooseDailyHighlightId(
  candidates: readonly DailyCandidate[],
  recent: readonly HighlightId[],
  current: HighlightId | undefined,
  seed: DailyChoiceSeed,
): HighlightId | undefined {
  if (candidates.length === 0) return undefined;
  const alternatives = candidates.filter((candidate) => candidate.id !== current);
  const base = alternatives.length > 0 ? alternatives : candidates;
  const recentIds = new Set(recent);
  const bookByHighlight = new Map(candidates.map((candidate) => [candidate.id, candidate.bookId]));
  const recentBooks = new Set(recent.map((id) => bookByHighlight.get(id)).filter((id): id is BookId => id !== undefined));
  const freshBooks = base.filter((candidate) => !recentBooks.has(candidate.bookId));
  const freshPassages = base.filter((candidate) => !recentIds.has(candidate.id));
  const eligible = freshBooks.length > 0 ? freshBooks : freshPassages.length > 0 ? freshPassages : base;
  const byBook = new Map<BookId, DailyCandidate[]>();
  for (const candidate of eligible) {
    const group = byBook.get(candidate.bookId) ?? [];
    group.push(candidate);
    byBook.set(candidate.bookId, group);
  }
  const books = [...byBook.keys()].sort();
  const seedText = `${seed.localDay}\0${seed.timezone}\0${seed.candidateDigest}\0${seed.revision}`;
  const bookCandidates = byBook.get(books[stableIndex(`${seedText}\0book`, books.length)]!)!;
  return bookCandidates[stableIndex(`${seedText}\0passage`, bookCandidates.length)]!.id;
}

function stableIndex(seed: string, length: number): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

export function normalizeBookText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeIsbn13(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length !== 13) return undefined;

  const sum = [...digits].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return sum % 10 === 0 ? digits : undefined;
}

export function assertUniqueImportIds(document: ImportDocument): void {
  assertUnique(
    document.books.map((book) => book.providerRecordId),
    "book",
  );
  assertUnique(
    document.annotations.map((annotation) => annotation.providerRecordId),
    "annotation",
  );

  const bookIds = new Set(document.books.map((book) => book.providerRecordId));
  for (const annotation of document.annotations) {
    if (!bookIds.has(annotation.bookProviderRecordId)) {
      throw new Error(
        `Annotation ${JSON.stringify(annotation.providerRecordId)} refers to an unknown book`,
      );
    }
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value.trim()) throw new Error(`Every ${label} requires a non-empty provider ID`);
    if (seen.has(value)) throw new Error(`Duplicate ${label} provider ID: ${JSON.stringify(value)}`);
    seen.add(value);
  }
}

export const BOOK_METADATA_LIMITS = Object.freeze({
  title: 1_000,
  author: 500,
  authors: 50,
  description: 20_000,
  publisher: 500,
  series: 500,
  seriesNumber: 40,
  language: 35,
  coverUrl: 2_048,
});

export interface NormalizedBookMetadata {
  readonly title: string;
  readonly authors: readonly string[];
  readonly description?: string;
  readonly publisher?: string;
  readonly series?: string;
  readonly seriesNumber?: string;
  readonly language?: string;
  readonly isbn13?: string;
  readonly coverUrl?: string;
}

/** Keep what the reader wrote, only trimming and collapsing whitespace. */
function displayText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/** One normalization for every provider, so an edit means the same everywhere. */
export function normalizeBookMetadata(input: Omit<UpdateBookMetadata, "id" | "expectedRevision">): NormalizedBookMetadata {
  const title = displayText(input.title);
  if (!title) throw new Error("Book title is required");
  if (title.length > BOOK_METADATA_LIMITS.title) throw new Error("Book title is too long");
  if (!Array.isArray(input.authors) || input.authors.length > BOOK_METADATA_LIMITS.authors) throw new Error("Book authors are invalid");
  const authors = [...new Set(input.authors.map((author) => {
    if (typeof author !== "string") throw new Error("Book authors are invalid");
    const name = displayText(author);
    if (name.length > BOOK_METADATA_LIMITS.author) throw new Error("Book author is too long");
    return name;
  }).filter(Boolean))];
  const optional = (value: string | undefined, label: string, maximum: number, collapse = true) => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`Book ${label} is invalid`);
    const text = collapse ? displayText(value) : value.normalize("NFC").trim();
    if (text.length > maximum) throw new Error(`Book ${label} is too long`);
    return text || undefined;
  };
  const description = optional(input.description, "description", BOOK_METADATA_LIMITS.description, false);
  const publisher = optional(input.publisher, "publisher", BOOK_METADATA_LIMITS.publisher);
  const series = optional(input.series, "series", BOOK_METADATA_LIMITS.series);
  const seriesNumber = optional(input.seriesNumber, "series number", BOOK_METADATA_LIMITS.seriesNumber);
  const language = optional(input.language, "language", BOOK_METADATA_LIMITS.language);
  let isbn13: string | undefined;
  if (input.isbn13 !== undefined && input.isbn13.trim()) {
    isbn13 = normalizeIsbn13(input.isbn13);
    if (!isbn13) throw new Error("ISBN-13 is invalid");
  }
  let coverUrl: string | undefined;
  if (input.coverUrl !== undefined && input.coverUrl.trim()) {
    const candidate = optional(input.coverUrl, "cover URL", BOOK_METADATA_LIMITS.coverUrl, false);
    try {
      if (!candidate) throw new Error();
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
      coverUrl = parsed.toString();
    } catch {
      throw new Error("Book cover URL must be an HTTPS URL without embedded credentials");
    }
  }
  return {
    title,
    authors,
    ...(description ? { description } : {}),
    ...(publisher ? { publisher } : {}),
    ...(series ? { series } : {}),
    ...(seriesNumber ? { seriesNumber } : {}),
    ...(language ? { language } : {}),
    ...(isbn13 ? { isbn13 } : {}),
    ...(coverUrl ? { coverUrl } : {}),
  };
}
export * from "./publications";

const POSITION_SUFFIX = /(?:^|\s·\s)(\d{1,3})%$/u;

/**
 * How far through its book a passage sits, from 0 to 1, when the importer
 * recorded it as a trailing "· 42%" (Kobo) or a bare "42%". Page and Kindle
 * location numbers are not positions without the book's length, so they
 * return undefined.
 */
export function passagePosition(location: string | undefined): number | undefined {
  const match = location?.match(POSITION_SUFFIX);
  if (!match?.[1]) return undefined;
  const percent = Number(match[1]);
  return percent <= 100 ? percent / 100 : undefined;
}

/** The readable part of a stored location, without any trailing percentage. */
export function passagePlace(location: string | undefined): string | undefined {
  const place = location?.replace(POSITION_SUFFIX, "").trim();
  return place || undefined;
}

const IMPORT_BOOK_KEYS = ["providerRecordId", "title", "authors", "isbn13", "description", "publisher", "series", "seriesNumber", "language", "status"] as const;
const IMPORT_ANNOTATION_KEYS = ["providerRecordId", "bookProviderRecordId", "text", "note", "location", "createdAt"] as const;

/**
 * An import record as JSON in a fixed field order, so a record fingerprints
 * the same whichever way it reached the server (field order is not preserved
 * by every transport). Web imports keep the SHA-256 of this to tell whether a
 * record changed at the source since it was last imported.
 */
export function canonicalImportJson(kind: "book" | "annotation", record: object): string {
  const keys = kind === "book" ? IMPORT_BOOK_KEYS : IMPORT_ANNOTATION_KEYS;
  const source = record as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])));
}
export * from "./widgets";
export * from "./library-statistics";
export * from "./library-duplicates";
export * from "./dashboards";
