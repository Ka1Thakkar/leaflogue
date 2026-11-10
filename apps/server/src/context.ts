import type { PostgresClient } from "@leaflogue/remote";
import type { SessionUser } from "./auth";
import type { ServerConfig } from "./config";
import { authRequired } from "./errors";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** What one API call runs with: its own connection and the signed-in reader, if any. */
export interface RequestContext {
  readonly client: PostgresClient;
  readonly config: ServerConfig;
  readonly user: SessionUser | undefined;
  readonly fetch: Fetch;
}

export function requireUser(context: RequestContext): SessionUser {
  if (!context.user) throw authRequired();
  return context.user;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const isUuid = (value: string) => UUID.test(value);

export interface LivePassage {
  readonly id: string;
  readonly bookId: string;
  readonly text: string;
  readonly revision: number;
  readonly bookTitle: string;
  readonly authors: string[];
  readonly details: { series?: string; seriesNumber?: string; publisher?: string; description?: string };
}

/** A passage that still exists, is not archived, and whose book still exists. */
export async function livePassage(client: PostgresClient, libraryId: string, highlightId: string): Promise<LivePassage | undefined> {
  if (!isUuid(highlightId)) return undefined;
  const result = await client.query<{ id: string; book_id: string; text: string; revision: string | number; title: string; authors: unknown; metadata: unknown }>(`
    SELECT highlights.id::text AS id, highlights.book_id::text AS book_id, highlights.text, highlights.revision,
      books.title, books.authors, books.metadata
    FROM leaflogue.highlights AS highlights
    JOIN leaflogue.books AS books ON books.library_id = highlights.library_id AND books.id = highlights.book_id
    WHERE highlights.library_id = $1 AND highlights.id = $2
      AND highlights.deleted_at IS NULL AND highlights.archived = false AND books.deleted_at IS NULL
  `, [libraryId, highlightId]);
  const row = result.rows[0];
  if (!row) return undefined;
  const authors = typeof row.authors === "string" ? JSON.parse(row.authors) as unknown : row.authors;
  return {
    id: row.id,
    bookId: row.book_id,
    text: row.text,
    revision: Number(row.revision),
    bookTitle: row.title,
    authors: Array.isArray(authors) ? authors.filter((author): author is string => typeof author === "string") : [],
    details: bookDetails(row.metadata),
  };
}

function bookDetails(value: unknown): LivePassage["details"] {
  const metadata = (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown> | null;
  const text = (key: string) => typeof metadata?.[key] === "string" && metadata[key] ? { [key]: metadata[key] as string } : {};
  return { ...text("series"), ...text("seriesNumber"), ...text("publisher"), ...text("description") };
}
