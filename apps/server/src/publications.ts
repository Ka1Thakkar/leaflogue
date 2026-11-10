import {
  buildPublicationSnapshot,
  isPublicationId,
  isReporterKey,
  newPublicationId,
  PUBLICATION_LIMITS,
  validReportDetails,
} from "@leaflogue/domain";
import type { PostgresClient } from "@leaflogue/remote";
import { isUuid, livePassage, type RequestContext } from "./context";
import { ServerError } from "./errors";

/**
 * Public links, as on Convex (`publicationRuntime:*`). Publishing freezes a
 * copy of the passage and the chosen notes; nothing else becomes reachable.
 * A link is hidden while its passage has changed or gone, until it is
 * published again, and the owner can withdraw it at any time.
 */

const failure = (message: string) => new ServerError("LEAFLOGUE_PUBLICATION_INVALID", message);

interface PublicationRow extends Record<string, unknown> {
  public_id: string;
  library_id: string;
  highlight_id: string;
  book_id: string;
  highlight_revision: number;
  note_ids: unknown;
  passage: string;
  book_title: string;
  authors: unknown;
  notes: unknown;
  active: boolean;
  published_at_ms: string | number;
  updated_at_ms: string | number;
}

const COLUMNS = `public_id, library_id::text AS library_id, highlight_id::text AS highlight_id, book_id::text AS book_id,
  highlight_revision, note_ids, passage, book_title, authors, notes, active,
  floor(extract(epoch FROM published_at) * 1000)::bigint AS published_at_ms,
  floor(extract(epoch FROM updated_at) * 1000)::bigint AS updated_at_ms`;

const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

async function needsReview(client: PostgresClient, row: PublicationRow): Promise<boolean> {
  const passage = await livePassage(client, row.library_id, row.highlight_id);
  return !passage || passage.revision !== Number(row.highlight_revision);
}

export async function settings(context: RequestContext, libraryId: string, highlightId: string) {
  if (!isUuid(highlightId)) return null;
  const result = await context.client.query<PublicationRow>(
    `SELECT ${COLUMNS} FROM leaflogue_web.publications WHERE library_id = $1 AND highlight_id = $2`,
    [libraryId, highlightId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { publicId: row.public_id, active: row.active, noteIds: json<string[]>(row.note_ids), needsReview: await needsReview(context.client, row) };
}

export async function publish(context: RequestContext, libraryId: string, args: { highlightId: string; noteIds: string[]; rightsConfirmed: boolean }) {
  const { client } = context;
  if (!args.rightsConfirmed) throw failure("Confirm that you are allowed to share this passage");
  if (new Set(args.noteIds).size !== args.noteIds.length) throw failure("Choose each note once");
  const highlight = await livePassage(client, libraryId, args.highlightId);
  if (!highlight) throw failure("That passage no longer exists");
  const notes = [];
  for (const noteId of args.noteIds.slice(0, PUBLICATION_LIMITS.notes + 1)) {
    const note = isUuid(noteId)
      ? (await client.query<{ markdown: string; origin: "reader" | "import" | "ai" }>(
          "SELECT markdown, origin FROM leaflogue.notes WHERE library_id = $1 AND id = $2 AND highlight_id = $3 AND deleted_at IS NULL",
          [libraryId, noteId, highlight.id],
        )).rows[0]
      : undefined;
    if (!note) throw failure("A chosen note is not on this passage");
    notes.push(note);
  }
  let snapshot;
  try {
    snapshot = buildPublicationSnapshot({ passage: highlight.text, bookTitle: highlight.bookTitle, authors: highlight.authors, notes });
  } catch (error) {
    throw failure(error instanceof Error ? error.message : "This passage cannot be shared");
  }
  const fields = [
    highlight.bookId, highlight.revision, JSON.stringify(args.noteIds), snapshot.passage, snapshot.bookTitle,
    JSON.stringify(snapshot.authors), JSON.stringify(snapshot.notes),
  ];
  const updated = await client.query<{ public_id: string }>(`
    UPDATE leaflogue_web.publications
    SET book_id = $3, highlight_revision = $4, note_ids = $5::jsonb, passage = $6, book_title = $7,
        authors = $8::jsonb, notes = $9::jsonb, active = true, updated_at = now()
    WHERE library_id = $1 AND highlight_id = $2
    RETURNING public_id
  `, [libraryId, highlight.id, ...fields]);
  if (updated.rows[0]) return { publicId: updated.rows[0].public_id };
  const count = await client.query<{ count: string | number }>(
    "SELECT count(*) AS count FROM leaflogue_web.publications WHERE library_id = $1",
    [libraryId],
  );
  if (Number(count.rows[0]?.count ?? 0) >= PUBLICATION_LIMITS.publications) {
    throw failure(`A library can hold at most ${PUBLICATION_LIMITS.publications} links`);
  }
  const publicId = newPublicationId();
  await client.query(`
    INSERT INTO leaflogue_web.publications
      (public_id, library_id, highlight_id, book_id, highlight_revision, note_ids, passage, book_title, authors, notes, active, published_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, true, now(), now())
  `, [publicId, libraryId, highlight.id, ...fields]);
  return { publicId };
}

export async function withdraw(context: RequestContext, libraryId: string, publicId: string): Promise<null> {
  const result = await context.client.query(
    "UPDATE leaflogue_web.publications SET active = false, updated_at = now() WHERE library_id = $1 AND public_id = $2 RETURNING public_id",
    [libraryId, publicId],
  );
  if (!result.rows[0]) throw failure("That link no longer exists");
  return null;
}

/** The library's live links, newest first. The cursor is the last link's public ID. */
export async function listMine(context: RequestContext, libraryId: string, paginationOpts: { numItems: number; cursor: string | null }) {
  const limit = paginationOpts.numItems;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ServerError("LEAFLOGUE_REQUEST_INVALID", "Page size must be between 1 and 100");
  const after = paginationOpts.cursor || null;
  if (after !== null && !isPublicationId(after)) throw new ServerError("LEAFLOGUE_REQUEST_INVALID", "Pagination cursor is invalid");
  const result = await context.client.query<PublicationRow>(`
    SELECT ${COLUMNS} FROM leaflogue_web.publications AS publications
    WHERE library_id = $1 AND active = true AND ($2::text IS NULL OR (published_at, public_id) < (
      SELECT published_at, public_id FROM leaflogue_web.publications WHERE public_id = $2 AND library_id = $1))
    ORDER BY published_at DESC, public_id DESC LIMIT $3
  `, [libraryId, after, limit + 1]);
  const rows = result.rows.slice(0, limit);
  const page = [];
  for (const row of rows) {
    page.push({
      publicId: row.public_id,
      highlightId: row.highlight_id,
      bookId: row.book_id,
      bookTitle: row.book_title,
      authors: json<string[]>(row.authors),
      passage: row.passage,
      notes: json<unknown[]>(row.notes).length,
      needsReview: await needsReview(context.client, row),
      publishedAt: Number(row.published_at_ms),
      updatedAt: Number(row.updated_at_ms),
    });
  }
  return { page, isDone: result.rows.length <= limit, continueCursor: rows.at(-1)?.public_id ?? after ?? "" };
}

/** What anyone with the link sees. No sign-in; nothing beyond the frozen copy. */
export async function get(context: RequestContext, publicId: string) {
  if (!isPublicationId(publicId)) return null;
  const result = await context.client.query<PublicationRow>(`SELECT ${COLUMNS} FROM leaflogue_web.publications WHERE public_id = $1`, [publicId]);
  const row = result.rows[0];
  if (!row || !row.active || await needsReview(context.client, row)) return null;
  return {
    publicId: row.public_id,
    passage: row.passage,
    bookTitle: row.book_title,
    authors: json<string[]>(row.authors),
    notes: json<{ markdown: string; ai: boolean }[]>(row.notes),
    publishedAt: Number(row.published_at_ms),
  };
}

/** An anonymous report, limited per reporter per day and per link. */
export async function report(context: RequestContext, args: {
  publicId: string;
  reporterKey: string;
  reason: "copyright" | "harassment" | "personal_information" | "other";
  details?: string;
}): Promise<null> {
  const { client } = context;
  if (!isReporterKey(args.reporterKey)) throw failure("This report could not be sent");
  let details: string | undefined;
  try {
    details = validReportDetails(args.details);
  } catch (error) {
    throw failure(error instanceof Error ? error.message : "Report details are not valid");
  }
  const publication = isPublicationId(args.publicId)
    ? (await client.query<{ library_id: string; active: boolean }>(
        "SELECT library_id::text AS library_id, active FROM leaflogue_web.publications WHERE public_id = $1",
        [args.publicId],
      )).rows[0]
    : undefined;
  if (!publication || !publication.active) throw failure("That link no longer exists");
  const day = new Date().toISOString().slice(0, 10);
  const today = await client.query<{ count: string | number }>(
    "SELECT count(*) AS count FROM leaflogue_web.publication_reports WHERE reporter_key = $1 AND day = $2",
    [args.reporterKey, day],
  );
  if (Number(today.rows[0]?.count ?? 0) >= PUBLICATION_LIMITS.reportsPerReporterPerDay) throw failure("You have sent the most reports allowed today");
  const existing = await client.query<{ count: string | number }>(
    "SELECT count(*) AS count FROM leaflogue_web.publication_reports WHERE public_id = $1",
    [args.publicId],
  );
  if (Number(existing.rows[0]?.count ?? 0) >= PUBLICATION_LIMITS.reportsPerPublication) throw failure("This link is already under review");
  await client.query(`
    INSERT INTO leaflogue_web.publication_reports (public_id, library_id, reporter_key, day, reason, details, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'open')
  `, [args.publicId, publication.library_id, args.reporterKey, day, args.reason, details ?? null]);
  return null;
}
