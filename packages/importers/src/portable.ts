import type { ImportAnnotation, ImportBook, ImportDocument, ImportPreview } from "@leaflogue/contracts";
import { assertUniqueImportIds, normalizeIsbn13 } from "@leaflogue/domain";

const MAX_PORTABLE_BYTES = 16 * 1024 * 1024;
const MAX_BOOKS = 20_000;
const MAX_ANNOTATIONS = 500_000;

export function parsePortableJson(source: string): ImportPreview {
  if (new TextEncoder().encode(source).byteLength > MAX_PORTABLE_BYTES) {
    throw new Error("Portable import exceeds the 16 MiB limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Portable import is not valid JSON");
  }

  const root = record(parsed, "Portable import");
  if (root.formatVersion !== 1) throw new Error("Unsupported portable format version");
  if (!Array.isArray(root.books) || root.books.length > MAX_BOOKS) {
    throw new Error(`Portable import must contain at most ${MAX_BOOKS} books`);
  }
  if (!Array.isArray(root.annotations) || root.annotations.length > MAX_ANNOTATIONS) {
    throw new Error(`Portable import must contain at most ${MAX_ANNOTATIONS} annotations`);
  }

  const document: ImportDocument = {
    formatVersion: 1,
    books: root.books.map(parseBook),
    annotations: root.annotations.map(parseAnnotation),
  };
  assertUniqueImportIds(document);
  return { document, warnings: [] };
}

function parseBook(value: unknown, index: number): ImportBook {
  const item = record(value, `Book ${index + 1}`);
  const isbn = optionalString(item.isbn13, `Book ${index + 1} ISBN`);
  return {
    providerRecordId: requiredString(item.id, `Book ${index + 1} ID`, 500),
    title: requiredString(item.title, `Book ${index + 1} title`, 1_000),
    authors: stringArray(item.authors, `Book ${index + 1} authors`, 30, 300),
    ...(isbn ? { isbn13: requireValidIsbn(isbn, index) } : {}),
    ...optionalBookFields(item, index),
  };
}

function optionalBookFields(item: Record<string, unknown>, index: number): Partial<ImportBook> {
  const fields = {
    description: optionalString(item.description, `Book ${index + 1} description`, 50_000),
    publisher: optionalString(item.publisher, `Book ${index + 1} publisher`, 1_000),
    series: optionalString(item.series, `Book ${index + 1} series`, 1_000),
    seriesNumber: optionalString(item.seriesNumber, `Book ${index + 1} series number`, 100),
    language: optionalString(item.language, `Book ${index + 1} language`, 100),
  };
  const status = item.status;
  if (status !== undefined && status !== "unread" && status !== "reading" && status !== "finished") {
    throw new Error(`Book ${index + 1} status is invalid`);
  }
  return {
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields.publisher ? { publisher: fields.publisher } : {}),
    ...(fields.series ? { series: fields.series } : {}),
    ...(fields.seriesNumber ? { seriesNumber: fields.seriesNumber } : {}),
    ...(fields.language ? { language: fields.language } : {}),
    ...(status ? { status } : {}),
  };
}

function parseAnnotation(value: unknown, index: number): ImportAnnotation {
  const item = record(value, `Annotation ${index + 1}`);
  const text = optionalString(item.text, `Annotation ${index + 1} text`, 200_000);
  const note = optionalString(item.note, `Annotation ${index + 1} note`, 200_000);
  if (!text?.trim() && !note?.trim()) throw new Error(`Annotation ${index + 1} is empty`);

  const location = optionalString(item.location, `Annotation ${index + 1} location`, 1_000);
  const createdAt = optionalNumber(item.createdAt, `Annotation ${index + 1} createdAt`);
  return {
    providerRecordId: requiredString(item.id, `Annotation ${index + 1} ID`, 500),
    bookProviderRecordId: requiredString(item.bookId, `Annotation ${index + 1} book ID`, 500),
    ...(text ? { text } : {}),
    ...(note ? { note } : {}),
    ...(location ? { location } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, limit: number): string {
  const parsed = optionalString(value, label, limit);
  if (!parsed?.trim()) throw new Error(`${label} is required`);
  return parsed;
}

function optionalString(value: unknown, label: string, limit = Number.MAX_SAFE_INTEGER): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > limit) throw new Error(`${label} is invalid`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function stringArray(value: unknown, label: string, countLimit: number, textLimit: number): string[] {
  if (!Array.isArray(value) || value.length > countLimit) throw new Error(`${label} is invalid`);
  return value.map((item, index) => requiredString(item, `${label} item ${index + 1}`, textLimit));
}

function requireValidIsbn(value: string, index: number): string {
  const normalized = normalizeIsbn13(value);
  if (!normalized) throw new Error(`Book ${index + 1} ISBN-13 is invalid`);
  return normalized;
}
