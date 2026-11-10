import { createHash, randomUUID } from "node:crypto";
import type { BookId, HighlightId, NoteId } from "@leaflogue/contracts";
import { canonicalImportJson } from "@leaflogue/domain";
import { PostgresLibraryMutations, type PostgresClient } from "@leaflogue/remote";
import type { RequestContext } from "./context";
import { ServerError } from "./errors";

/**
 * Import in a web client, as on Convex (`importRuntime:*`). The browser
 * parses the reader's file with the desktop's importers and sends the result
 * in batches: books first, then annotations. Each batch is one transaction
 * and safe to send again, so an interrupted import resumes where it stopped.
 *
 * The rules match the desktop's: a record unchanged at the source is
 * skipped; one the reader deleted stays deleted; one the reader edited
 * becomes a conflict to review; anything else is updated in place. Writes go
 * through the library mutations, so desktops pull them.
 */

export const IMPORT_BATCH_LIMIT = 100;
const MAX_SOURCES = 50;
const MAX_TEXT_CHARACTERS = 100_000;
const MAX_NOTE_BYTES = 24 * 1024;
const MAX_LOCATION_CHARACTERS = 2_000;

export const IMPORT_PROVIDERS = ["kindle", "kobo", "koreader", "pocketbook", "tolino", "boox", "portable"] as const;

export interface ImportBook {
  readonly providerRecordId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly isbn13?: string;
  readonly description?: string;
  readonly publisher?: string;
  readonly series?: string;
  readonly seriesNumber?: string;
  readonly language?: string;
  readonly status?: "unread" | "reading" | "finished";
}

export interface ImportAnnotation {
  readonly providerRecordId: string;
  readonly bookProviderRecordId: string;
  readonly text?: string;
  readonly note?: string;
  readonly location?: string;
  readonly createdAt?: number;
}

interface AnnotationLink extends Record<string, unknown> {
  book_id: string;
  highlight_id: string | null;
  highlight_revision: number | null;
  attached_note_id: string | null;
  attached_note_revision: number | null;
  note_id: string | null;
  note_revision: number | null;
  fingerprint: string;
  incoming: string;
}

interface Current {
  readonly highlight?: { id: string; bookId: string; revision: number; deleted: boolean };
  readonly attached?: { id: string; bookId: string; revision: number; deleted: boolean; markdown: string };
  readonly note?: { id: string; bookId: string; revision: number; deleted: boolean; markdown: string };
}

const failure = (message: string) => new ServerError("LEAFLOGUE_IMPORT_INVALID", message);

/** SHA-256 of the record's canonical JSON, as on Convex. */
function fingerprint(kind: "book" | "annotation", value: object): string {
  return createHash("sha256").update(canonicalImportJson(kind, value)).digest("hex");
}
const annotationJson = (annotation: ImportAnnotation) => canonicalImportJson("annotation", annotation);

function storable(annotation: ImportAnnotation): boolean {
  const text = annotation.text?.trim();
  const note = annotation.note?.trim();
  if (!text && !note) return false;
  if (text && text.length > MAX_TEXT_CHARACTERS) return false;
  if (note && new TextEncoder().encode(note).byteLength > MAX_NOTE_BYTES) return false;
  return !annotation.location || annotation.location.length <= MAX_LOCATION_CHARACTERS;
}

async function requireSource(client: PostgresClient, libraryId: string, sourceId: string): Promise<void> {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const source = UUID.test(sourceId)
    ? (await client.query("SELECT 1 FROM leaflogue_web.import_sources WHERE library_id = $1 AND id = $2", [libraryId, sourceId])).rows[0]
    : undefined;
  if (!source) throw failure("That import source no longer exists");
}

export async function listSources(context: RequestContext, libraryId: string) {
  const sources = await context.client.query<{ id: string; provider: string; name: string; updated_at_ms: string | number }>(`
    SELECT id::text AS id, provider, name, floor(extract(epoch FROM updated_at) * 1000)::bigint AS updated_at_ms
    FROM leaflogue_web.import_sources WHERE library_id = $1 ORDER BY updated_at DESC LIMIT $2
  `, [libraryId, MAX_SOURCES]);
  return sources.rows.map((row) => ({ id: row.id, provider: row.provider, name: row.name, updatedAt: Number(row.updated_at_ms) }));
}

export async function createSource(context: RequestContext, libraryId: string, args: { provider: string; name: string }) {
  const name = args.name.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 200) throw failure("Give the source a name of up to 200 characters");
  const mutations = new PostgresLibraryMutations(context.client, libraryId);
  return mutations.transaction(async () => {
    const existing = await context.client.query<{ count: string | number }>(
      "SELECT count(*) AS count FROM leaflogue_web.import_sources WHERE library_id = $1",
      [libraryId],
    );
    if (Number(existing.rows[0]?.count ?? 0) >= MAX_SOURCES) throw failure(`A library can have at most ${MAX_SOURCES} import sources`);
    const sourceId = randomUUID();
    await context.client.query(
      "INSERT INTO leaflogue_web.import_sources (library_id, id, provider, name) VALUES ($1, $2, $3, $4)",
      [libraryId, sourceId, args.provider, name],
    );
    return { sourceId };
  });
}

/** One batch of books. A book seen before from this source is reused and keeps the reader's metadata. */
export async function importBooks(context: RequestContext, libraryId: string, args: { sourceId: string; books: ImportBook[] }) {
  if (args.books.length > IMPORT_BATCH_LIMIT) throw failure(`Send at most ${IMPORT_BATCH_LIMIT} books at a time`);
  const { client } = context;
  const mutations = new PostgresLibraryMutations(client, libraryId);
  return mutations.transaction(async () => {
    await requireSource(client, libraryId, args.sourceId);
    const receipt = { booksCreated: 0, booksReused: 0 };
    for (const incoming of args.books) {
      const recordFingerprint = fingerprint("book", incoming);
      const linked = (await client.query<{ book_id: string; live: boolean }>(`
        SELECT links.book_id::text AS book_id, books.id IS NOT NULL AS live
        FROM leaflogue_web.import_source_books AS links
        LEFT JOIN leaflogue.books AS books ON books.library_id = links.library_id AND books.id = links.book_id AND books.deleted_at IS NULL
        WHERE links.library_id = $1 AND links.source_id = $2 AND links.provider_record_id = $3
      `, [libraryId, args.sourceId, incoming.providerRecordId])).rows[0];
      if (linked?.live) {
        await client.query(`
          UPDATE leaflogue_web.import_source_books SET fingerprint = $4, updated_at = now()
          WHERE library_id = $1 AND source_id = $2 AND provider_record_id = $3
        `, [libraryId, args.sourceId, incoming.providerRecordId, recordFingerprint]);
        receipt.booksReused += 1;
        continue;
      }
      const bookId = randomUUID() as BookId;
      await mutations.createBook({
        id: bookId,
        title: incoming.title.trim() || "Untitled book",
        authors: incoming.authors,
        ...(incoming.isbn13 ? { isbn13: incoming.isbn13 } : {}),
        ...(incoming.description ? { description: incoming.description } : {}),
        ...(incoming.publisher ? { publisher: incoming.publisher } : {}),
        ...(incoming.series ? { series: incoming.series } : {}),
        ...(incoming.seriesNumber ? { seriesNumber: incoming.seriesNumber } : {}),
        ...(incoming.language ? { language: incoming.language } : {}),
      });
      if (incoming.status && incoming.status !== "unread") {
        await mutations.setBookReadingStatus({ id: bookId, status: incoming.status, expectedRevision: 1 });
      }
      await client.query(`
        INSERT INTO leaflogue_web.import_source_books (library_id, source_id, provider_record_id, book_id, fingerprint)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (library_id, source_id, provider_record_id) DO UPDATE
          SET book_id = excluded.book_id, fingerprint = excluded.fingerprint, updated_at = now()
      `, [libraryId, args.sourceId, incoming.providerRecordId, bookId, recordFingerprint]);
      receipt.booksCreated += 1;
    }
    await client.query("UPDATE leaflogue_web.import_sources SET updated_at = now() WHERE library_id = $1 AND id = $2", [libraryId, args.sourceId]);
    return receipt;
  });
}

async function current(client: PostgresClient, libraryId: string, link: Pick<AnnotationLink, "highlight_id" | "attached_note_id" | "note_id">): Promise<Current> {
  const highlight = link.highlight_id
    ? (await client.query<{ id: string; book_id: string; revision: string | number; deleted: boolean }>(
        "SELECT id::text AS id, book_id::text AS book_id, revision, deleted_at IS NOT NULL AS deleted FROM leaflogue.highlights WHERE library_id = $1 AND id = $2",
        [libraryId, link.highlight_id],
      )).rows[0]
    : undefined;
  const note = async (id: string | null) => id
    ? (await client.query<{ id: string; book_id: string; revision: string | number; deleted: boolean; markdown: string }>(
        "SELECT id::text AS id, book_id::text AS book_id, revision, deleted_at IS NOT NULL AS deleted, markdown FROM leaflogue.notes WHERE library_id = $1 AND id = $2",
        [libraryId, id],
      )).rows[0]
    : undefined;
  const shape = <Row extends { book_id: string; revision: string | number }>(row: Row | undefined) =>
    row ? { ...row, bookId: row.book_id, revision: Number(row.revision) } : undefined;
  const attached = shape(await note(link.attached_note_id));
  const standalone = shape(await note(link.note_id));
  return {
    ...(highlight ? { highlight: shape(highlight)! } : {}),
    ...(attached ? { attached } : {}),
    ...(standalone ? { note: standalone } : {}),
  };
}

/** Apply a source's version over records the reader has not changed (or chose to replace). */
async function applyIncoming(mutations: PostgresLibraryMutations, state: Current, incoming: ImportAnnotation) {
  const result: { highlight_revision?: number; attached_note_id?: string; attached_note_revision?: number; note_revision?: number } = {};
  const { highlight, attached, note } = state;
  if (highlight && incoming.text?.trim()) {
    const updated = await mutations.updateHighlight({
      id: highlight.id as HighlightId, bookId: highlight.bookId as BookId, text: incoming.text,
      ...(incoming.location ? { sourceLocation: incoming.location } : {}),
      expectedRevision: highlight.revision,
    });
    result.highlight_revision = updated.revision;
    const body = incoming.note?.trim();
    if (body && attached && !attached.deleted) {
      if (attached.markdown !== body) {
        result.attached_note_revision = (await mutations.updateNote({
          id: attached.id as NoteId, bookId: attached.bookId as BookId, markdown: body, expectedRevision: attached.revision,
        })).revision;
      }
    } else if (body && !attached) {
      const created = await mutations.createNote({ bookId: highlight.bookId as BookId, highlightId: highlight.id as HighlightId, markdown: body, origin: "import" });
      result.attached_note_id = created.id;
      result.attached_note_revision = created.revision;
    }
  } else if (note && incoming.note?.trim() && note.markdown !== incoming.note.trim()) {
    result.note_revision = (await mutations.updateNote({
      id: note.id as NoteId, bookId: note.bookId as BookId, markdown: incoming.note.trim(), expectedRevision: note.revision,
    })).revision;
  }
  return result;
}

async function updateLink(client: PostgresClient, libraryId: string, sourceId: string, providerRecordId: string, fields: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(fields);
  await client.query(`
    UPDATE leaflogue_web.import_source_annotations
    SET ${columns.map((column, index) => `${column} = $${index + 4}`).join(", ")}, updated_at = now()
    WHERE library_id = $1 AND source_id = $2 AND provider_record_id = $3
  `, [libraryId, sourceId, providerRecordId, ...Object.values(fields)]);
}

/** One batch of annotations, after their books. */
export async function importAnnotations(context: RequestContext, libraryId: string, args: { sourceId: string; annotations: ImportAnnotation[] }) {
  if (args.annotations.length > IMPORT_BATCH_LIMIT) throw failure(`Send at most ${IMPORT_BATCH_LIMIT} annotations at a time`);
  const { client } = context;
  const { sourceId } = args;
  const mutations = new PostgresLibraryMutations(client, libraryId);
  return mutations.transaction(async () => {
    await requireSource(client, libraryId, sourceId);
    const receipt = { highlightsCreated: 0, notesCreated: 0, annotationsUpdated: 0, conflictsCreated: 0, unchanged: 0, skipped: 0 };
    for (const incoming of args.annotations) {
      const bookLink = (await client.query<{ book_id: string }>(
        "SELECT book_id::text AS book_id FROM leaflogue_web.import_source_books WHERE library_id = $1 AND source_id = $2 AND provider_record_id = $3",
        [libraryId, sourceId, incoming.bookProviderRecordId],
      )).rows[0];
      if (!bookLink) throw failure("Send an annotation's book before the annotation");
      if (!storable(incoming)) {
        receipt.skipped += 1;
        continue;
      }
      const recordFingerprint = fingerprint("annotation", incoming);
      const incomingJson = annotationJson(incoming);
      const link = (await client.query<AnnotationLink>(`
        SELECT book_id::text AS book_id, highlight_id::text AS highlight_id, highlight_revision,
          attached_note_id::text AS attached_note_id, attached_note_revision, note_id::text AS note_id, note_revision,
          fingerprint, incoming
        FROM leaflogue_web.import_source_annotations WHERE library_id = $1 AND source_id = $2 AND provider_record_id = $3
      `, [libraryId, sourceId, incoming.providerRecordId])).rows[0];

      if (!link) {
        const bookId = bookLink.book_id as BookId;
        let ids: { highlight_id?: string; highlight_revision?: number; attached_note_id?: string; attached_note_revision?: number; note_id?: string; note_revision?: number };
        if (incoming.text?.trim()) {
          const noteBody = incoming.note?.trim();
          const noteId = noteBody ? randomUUID() as NoteId : undefined;
          const created = await mutations.createHighlight({
            id: randomUUID() as HighlightId, bookId, text: incoming.text,
            ...(incoming.location ? { sourceLocation: incoming.location } : {}),
            ...(incoming.createdAt !== undefined ? { sourceCreatedAt: incoming.createdAt } : {}),
            ...(noteBody && noteId ? { noteId, noteMarkdown: noteBody, noteOrigin: "import" as const } : {}),
          });
          ids = { highlight_id: created.id, highlight_revision: created.revision, ...(noteId ? { attached_note_id: noteId, attached_note_revision: 1 } : {}) };
          receipt.highlightsCreated += 1;
        } else {
          const created = await mutations.createNote({ bookId, markdown: incoming.note!.trim(), origin: "import" });
          ids = { note_id: created.id, note_revision: created.revision };
          receipt.notesCreated += 1;
        }
        await client.query(`
          INSERT INTO leaflogue_web.import_source_annotations
            (library_id, source_id, provider_record_id, book_id, highlight_id, highlight_revision,
             attached_note_id, attached_note_revision, note_id, note_revision, fingerprint, incoming)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          libraryId, sourceId, incoming.providerRecordId, bookId, ids.highlight_id ?? null, ids.highlight_revision ?? null,
          ids.attached_note_id ?? null, ids.attached_note_revision ?? null, ids.note_id ?? null, ids.note_revision ?? null,
          recordFingerprint, incomingJson,
        ]);
        continue;
      }

      if (link.fingerprint === recordFingerprint) {
        // Seen again: the record's "last imported" day moves on.
        await client.query(`
          UPDATE leaflogue_web.import_source_annotations SET updated_at = now()
          WHERE library_id = $1 AND source_id = $2 AND provider_record_id = $3
        `, [libraryId, sourceId, incoming.providerRecordId]);
        receipt.unchanged += 1;
        continue;
      }
      const state = await current(client, libraryId, link);
      const target = link.highlight_id ? state.highlight : state.note;
      if (!target || target.deleted) {
        // The reader deleted it: a changed source neither restores it nor raises a conflict.
        await updateLink(client, libraryId, sourceId, incoming.providerRecordId, { fingerprint: recordFingerprint, incoming: incomingJson });
        receipt.unchanged += 1;
        continue;
      }
      const edited = link.highlight_id
        ? state.highlight!.revision !== link.highlight_revision ||
          (state.attached !== undefined && !state.attached.deleted && state.attached.revision !== link.attached_note_revision)
        : state.note!.revision !== link.note_revision;
      if (edited) {
        const open = await client.query(`
          UPDATE leaflogue_web.import_conflicts SET incoming = $4, incoming_fingerprint = $5, updated_at = now()
          WHERE library_id = $1 AND source_id = $2 AND provider_record_id = $3 AND status = 'pending'
          RETURNING id
        `, [libraryId, sourceId, incoming.providerRecordId, incomingJson, recordFingerprint]);
        if (!open.rows[0]) {
          await client.query(`
            INSERT INTO leaflogue_web.import_conflicts
              (library_id, id, source_id, provider_record_id, book_id, previous, incoming, incoming_fingerprint, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
          `, [libraryId, randomUUID(), sourceId, incoming.providerRecordId, link.book_id, link.incoming, incomingJson, recordFingerprint]);
          receipt.conflictsCreated += 1;
        }
        continue;
      }
      const revisions = await applyIncoming(mutations, state, incoming);
      await updateLink(client, libraryId, sourceId, incoming.providerRecordId, { ...revisions, fingerprint: recordFingerprint, incoming: incomingJson });
      receipt.annotationsUpdated += 1;
    }
    await client.query("UPDATE leaflogue_web.import_sources SET updated_at = now() WHERE library_id = $1 AND id = $2", [libraryId, sourceId]);
    return receipt;
  });
}

export async function listConflicts(context: RequestContext, libraryId: string) {
  const conflicts = await context.client.query<{
    id: string; source_id: string; source_name: string | null; book_id: string; previous: string; incoming: string; created_at_ms: string | number;
  }>(`
    SELECT conflicts.id::text AS id, conflicts.source_id::text AS source_id, sources.name AS source_name,
      conflicts.book_id::text AS book_id, conflicts.previous, conflicts.incoming,
      floor(extract(epoch FROM conflicts.created_at) * 1000)::bigint AS created_at_ms
    FROM leaflogue_web.import_conflicts AS conflicts
    LEFT JOIN leaflogue_web.import_sources AS sources ON sources.library_id = conflicts.library_id AND sources.id = conflicts.source_id
    WHERE conflicts.library_id = $1 AND conflicts.status = 'pending'
    ORDER BY conflicts.created_at LIMIT 200
  `, [libraryId]);
  return conflicts.rows.map((row) => ({
    id: row.id, sourceId: row.source_id, sourceName: row.source_name ?? "Removed source", bookId: row.book_id,
    previous: row.previous, incoming: row.incoming, createdAt: Number(row.created_at_ms),
  }));
}

/** Keep the reader's version, or take the source's. Either way the next import starts from here. */
export async function resolveConflict(context: RequestContext, libraryId: string, args: { conflictId: string; resolution: "keep-local" | "accept-incoming" }): Promise<null> {
  const { client } = context;
  const mutations = new PostgresLibraryMutations(client, libraryId);
  return mutations.transaction(async () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    const conflict = UUID.test(args.conflictId)
      ? (await client.query<{ source_id: string; provider_record_id: string; incoming: string; incoming_fingerprint: string }>(`
          SELECT source_id::text AS source_id, provider_record_id, incoming, incoming_fingerprint
          FROM leaflogue_web.import_conflicts WHERE library_id = $1 AND id = $2 AND status = 'pending' FOR UPDATE
        `, [libraryId, args.conflictId])).rows[0]
      : undefined;
    if (!conflict) throw failure("That conflict has already been resolved");
    const link = (await client.query<AnnotationLink>(`
      SELECT highlight_id::text AS highlight_id, attached_note_id::text AS attached_note_id, note_id::text AS note_id
      FROM leaflogue_web.import_source_annotations WHERE library_id = $1 AND source_id = $2 AND provider_record_id = $3
    `, [libraryId, conflict.source_id, conflict.provider_record_id])).rows[0];
    if (link) {
      const state = await current(client, libraryId, link);
      let revisions: Record<string, unknown> = {
        ...(state.highlight ? { highlight_revision: state.highlight.revision } : {}),
        ...(state.attached ? { attached_note_revision: state.attached.revision } : {}),
        ...(state.note ? { note_revision: state.note.revision } : {}),
      };
      if (args.resolution === "accept-incoming") {
        revisions = { ...revisions, ...(await applyIncoming(mutations, state, JSON.parse(conflict.incoming) as ImportAnnotation)) };
      }
      await updateLink(client, libraryId, conflict.source_id, conflict.provider_record_id, {
        ...revisions, fingerprint: conflict.incoming_fingerprint, incoming: conflict.incoming,
      });
    }
    await client.query(
      "UPDATE leaflogue_web.import_conflicts SET status = $3, updated_at = now() WHERE library_id = $1 AND id = $2",
      [libraryId, args.conflictId, args.resolution === "keep-local" ? "kept" : "accepted"],
    );
    return null;
  });
}

async function importedLink(client: PostgresClient, libraryId: string, highlightId: string) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (!UUID.test(highlightId)) return undefined;
  return (await client.query<AnnotationLink & { source_id: string; provider_record_id: string }>(`
    SELECT source_id::text AS source_id, provider_record_id, book_id::text AS book_id, highlight_id::text AS highlight_id,
      highlight_revision, attached_note_id::text AS attached_note_id, attached_note_revision,
      note_id::text AS note_id, note_revision, fingerprint, incoming
    FROM leaflogue_web.import_source_annotations WHERE library_id = $1 AND highlight_id = $2 LIMIT 1
  `, [libraryId, highlightId])).rows[0];
}

/**
 * What an imported passage looked like when it was last imported, and whether
 * the reader has changed it since. Null for a passage typed in by hand or
 * imported on a desktop, whose import history stays on that desktop.
 */
export async function importedVersion(context: RequestContext, libraryId: string, highlightId: string) {
  const link = await importedLink(context.client, libraryId, highlightId);
  if (!link) return null;
  const incoming = JSON.parse(link.incoming) as ImportAnnotation;
  if (!incoming.text?.trim()) return null;
  const state = await current(context.client, libraryId, link);
  if (!state.highlight || state.highlight.deleted) return null;
  const edited = state.highlight.revision !== Number(link.highlight_revision) ||
    (state.attached !== undefined && !state.attached.deleted && state.attached.revision !== Number(link.attached_note_revision));
  return {
    text: incoming.text,
    ...(incoming.note?.trim() ? { note: incoming.note.trim() } : {}),
    ...(incoming.location ? { location: incoming.location } : {}),
    edited,
  };
}

/** Put an imported passage (and its imported note) back as the last import wrote it. */
export async function resetToImported(context: RequestContext, libraryId: string, highlightId: string): Promise<null> {
  const { client } = context;
  const mutations = new PostgresLibraryMutations(client, libraryId);
  return mutations.transaction(async () => {
    const link = await importedLink(client, libraryId, highlightId);
    if (!link) throw failure("This passage has no imported version to go back to");
    const incoming = JSON.parse(link.incoming) as ImportAnnotation;
    const state = await current(client, libraryId, link);
    if (!state.highlight || state.highlight.deleted || !incoming.text?.trim()) throw failure("That passage no longer exists");
    const revisions = await applyIncoming(mutations, state, incoming);
    if (Object.keys(revisions).length) await updateLink(client, libraryId, link.source_id, link.provider_record_id, revisions);
    return null;
  });
}
