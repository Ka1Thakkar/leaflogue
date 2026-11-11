/**
 * Book lookup: Google Books first, Open Library when Google is unavailable or
 * finds nothing. Needs only `fetch`, so the desktop and any server share it.
 * Every field from a provider is bounded and checked, and covers are kept only
 * from the providers' own image hosts, over HTTPS.
 */

import type { CatalogBook, CatalogSearch } from "@leaflogue/contracts";
export type { CatalogBook, CatalogSearch } from "@leaflogue/contracts";

export interface CatalogOptions {
  /** Raises Google Books' anonymous quota; read from the server's environment. */
  readonly googleBooksApiKey?: string;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Waits between retries; tests pass one that does not wait. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class CatalogUnavailableError extends Error {
  constructor() {
    super("Book lookup is unavailable right now. Try again shortly.");
    this.name = "CatalogUnavailableError";
  }
}

const MAX_QUERY_BYTES = 200;
const MAX_RESULTS = 20;
const MAX_RESPONSE_CHARACTERS = 2_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_ATTEMPTS = 3;
const GOOGLE_COVER_HOSTS = new Set(["books.google.com", "books.googleusercontent.com"]);
const GOOGLE_COVER_PARAMETERS = new Set(["id", "img", "jscmd", "printsec", "vid"]);

/** Collapse and bound a reader's search, or refuse it. */
export function normalizeCatalogQuery(query: string): string {
  if (new TextEncoder().encode(query).byteLength > MAX_QUERY_BYTES) throw new Error("Search must be at most 200 bytes");
  const normalized = query.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized) throw new Error("Enter a title, author, or ISBN");
  return normalized;
}

/** A checksum-valid ISBN-13, converting a valid ISBN-10. */
export function catalogIsbn13(value: string | undefined): string | undefined {
  const digits = value?.replace(/[^0-9Xx]/gu, "").toUpperCase();
  if (!digits) return undefined;
  if (digits.length === 13 && /^\d{13}$/u.test(digits)) {
    const sum = [...digits].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0 ? digits : undefined;
  }
  if (digits.length === 10 && /^\d{9}[\dX]$/u.test(digits)) {
    const sum = [...digits].reduce((total, digit, index) => total + (digit === "X" ? 10 : Number(digit)) * (10 - index), 0);
    if (sum % 11 !== 0) return undefined;
    const core = `978${digits.slice(0, 9)}`;
    const check = (10 - ([...core].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0) % 10)) % 10;
    return `${core}${check}`;
  }
  return undefined;
}

export async function searchCatalog(query: string, options: CatalogOptions = {}): Promise<CatalogSearch> {
  const normalized = normalizeCatalogQuery(query);
  try {
    const items = await searchGoogleBooks(normalized, options);
    if (items.length) return { items, source: "google-books" };
  } catch (error) {
    if (!(error instanceof CatalogUnavailableError)) throw error;
  }
  return { items: await searchOpenLibrary(normalized, options), source: "open-library" };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function text(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.normalize("NFC").trim();
  return trimmed && new TextEncoder().encode(trimmed).byteLength <= maxBytes ? trimmed : undefined;
}

function texts(value: unknown, maxItems: number, maxBytes: number): string[] {
  return Array.isArray(value) ? value.slice(0, maxItems).map((item) => text(item, maxBytes)).filter((item): item is string => Boolean(item)) : [];
}

async function requestJson(url: URL, options: CatalogOptions): Promise<unknown> {
  const fetchImplementation = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImplementation(url.toString(), { signal: controller.signal, redirect: "error" });
      // A busy provider is retried with backoff; anything else is final.
      if ((response.status === 429 || response.status >= 500) && attempt < RETRY_ATTEMPTS - 1) {
        await response.body?.cancel();
      } else {
        if (!response.ok) throw new CatalogUnavailableError();
        const raw = await response.text();
        if (raw.length > MAX_RESPONSE_CHARACTERS) throw new CatalogUnavailableError();
        return JSON.parse(raw) as unknown;
      }
    } catch {
      throw new CatalogUnavailableError();
    } finally {
      clearTimeout(timer);
    }
    await sleep(250 * 2 ** attempt);
  }
}

function googleCover(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !GOOGLE_COVER_HOSTS.has(url.hostname)) return undefined;
    url.protocol = "https:";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (!GOOGLE_COVER_PARAMETERS.has(key)) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return undefined;
  }
}

/** One Google Books volume as a catalog book, or nothing if it is unusable. */
export function googleVolume(payload: unknown): CatalogBook | undefined {
  const root = record(payload);
  const info = record(root.volumeInfo);
  const providerId = text(root.id, 128);
  const title = text(info.title, 1_000);
  if (!providerId || !/^[A-Za-z0-9_-]{1,128}$/u.test(providerId) || !title) return undefined;
  let isbn13: string | undefined;
  if (Array.isArray(info.industryIdentifiers)) {
    for (const identifier of info.industryIdentifiers.slice(0, 20)) {
      const entry = record(identifier);
      if (entry.type !== "ISBN_13" && entry.type !== "ISBN_10") continue;
      isbn13 = catalogIsbn13(text(entry.identifier, 32));
      if (isbn13) break;
    }
  }
  const images = record(info.imageLinks);
  const description = text(info.description, 20_000);
  const publisher = text(info.publisher, 500);
  const language = text(info.language, 35);
  const coverUrl = googleCover(text(images.thumbnail ?? images.smallThumbnail, 2_000));
  return {
    provider: "google-books",
    providerId,
    title,
    authors: texts(info.authors, 50, 500),
    ...(isbn13 ? { isbn13 } : {}),
    ...(description ? { description } : {}),
    ...(publisher ? { publisher } : {}),
    ...(language ? { language } : {}),
    ...(coverUrl ? { coverUrl } : {}),
  };
}

async function searchGoogleBooks(query: string, options: CatalogOptions): Promise<CatalogBook[]> {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  const isbn = catalogIsbn13(query);
  url.searchParams.set("q", isbn ? `isbn:${isbn}` : query);
  url.searchParams.set("maxResults", String(MAX_RESULTS));
  if (options.googleBooksApiKey) url.searchParams.set("key", options.googleBooksApiKey);
  const payload = record(await requestJson(url, options));
  if (payload.items !== undefined && !Array.isArray(payload.items)) throw new CatalogUnavailableError();
  const raw = (payload.items ?? []) as unknown[];
  const items = raw.slice(0, MAX_RESULTS).map(googleVolume).filter((item): item is CatalogBook => Boolean(item));
  if (raw.length && !items.length) throw new CatalogUnavailableError();
  return items;
}

/** One Open Library search result as a catalog book, or nothing if it is unusable. */
export function openLibraryDocument(payload: unknown): CatalogBook | undefined {
  const doc = record(payload);
  const key = text(doc.key, 100)?.replace(/^\/(works|books)\//u, "");
  const title = text(doc.title, 1_000);
  if (!key || !/^OL\d+[WM]$/u.test(key) || !title) return undefined;
  const isbn13 = texts(doc.isbn, 50, 32).map(catalogIsbn13).find(Boolean);
  const publisher = texts(doc.publisher, 10, 500)[0];
  const language = texts(doc.language, 5, 35)[0];
  const cover = typeof doc.cover_i === "number" && Number.isSafeInteger(doc.cover_i) && doc.cover_i > 0
    ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
    : undefined;
  return {
    provider: "open-library",
    providerId: key,
    title,
    authors: texts(doc.author_name, 50, 500),
    ...(isbn13 ? { isbn13 } : {}),
    ...(publisher ? { publisher } : {}),
    ...(language ? { language } : {}),
    ...(cover ? { coverUrl: cover } : {}),
  };
}

async function searchOpenLibrary(query: string, options: CatalogOptions): Promise<CatalogBook[]> {
  const url = new URL("https://openlibrary.org/search.json");
  const isbn = catalogIsbn13(query);
  if (isbn) url.searchParams.set("isbn", isbn);
  else url.searchParams.set("q", query);
  url.searchParams.set("fields", "key,title,author_name,isbn,publisher,language,cover_i");
  url.searchParams.set("limit", String(MAX_RESULTS));
  const docs = record(await requestJson(url, options)).docs;
  if (!Array.isArray(docs)) throw new CatalogUnavailableError();
  return docs.slice(0, MAX_RESULTS).map(openLibraryDocument).filter((item): item is CatalogBook => Boolean(item));
}
