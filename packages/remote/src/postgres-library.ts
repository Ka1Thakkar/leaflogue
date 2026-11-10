import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type {
  AnnotationDeletionReceipt,
  Book,
  BookId,
  BookArchiveChange,
  BookReadingStatusChange,
  Collection,
  CollectionId,
  CreateBook,
  CreateCollection,
  CreateTag,
  CreateThread,
  DeleteHighlight,
  DeleteNote,
  DeleteThread,
  DailySelection,
  DailySelectionId,
  EnsureDailySelection,
  DeleteCollection,
  DeleteTag,
  HighlightMutationResult,
  HighlightId,
  MergeBooks,
  MergeBooksReceipt,
  NewHighlight,
  NewNote,
  SyncChange,
  SyncCursor,
  SyncedChange,
  SyncedDailySelection,
  SyncedChangeOutcome,
  Note,
  NoteId,
  OnlineLibraryMutations,
  OnlineDailySelectionMutations,
  OnlineOrganizationMutations,
  OnlineThreadMutations,
  OrganizationMembershipReceipt,
  ReadingStatus,
  ReadingStatusEvent,
  ReadingStatusEventId,
  SetBookArchived,
  SetBookCompletionDate,
  SetBookReadingStatus,
  SetBookCollectionMembership,
  SetBookTagMembership,
  SetHighlightTagMembership,
  SetHighlightThreadMembership,
  SyncEntityType,
  Tag,
  TagId,
  Thread,
  ThreadId,
  ThreadMembershipReceipt,
  UpdateBookMetadata,
  UpdateCollection,
  UpdateHighlight,
  UpdateNote,
  UpdateTag,
  UpdateThread,
} from "@leaflogue/contracts";
import { WEB_DEVICE_ID, MAX_NOTE_BYTES, MAX_NOTES_PER_HIGHLIGHT, MAX_SYNC_CHANGE_PAGE, dailySelectionWins, MAX_STATUS_EVENTS_PER_BOOK, MAX_SYNC_ORGANIZATION_MEMBERSHIPS, MAX_SYNCED_STATUS_EVENTS_PER_BOOK, MAX_THREADS_PER_HIGHLIGHT, normalizeOrganizationName } from "@leaflogue/contracts";
import { chooseDailyHighlightId, normalizeBookMetadata, normalizeIsbn13, resolveLocalDay, validateCompletionDate } from "@leaflogue/domain";
import type { PostgresClient } from "./postgres";
import type { SyncPullPage } from "./sync";

interface HighlightRow extends Record<string, unknown> {
  id: string;
  book_id: string;
  text: string;
  source_location: string | null;
  source_created_at_ms: number | string | null;
  created_at_ms: number | string;
  updated_at_ms: number | string;
  revision: number | string;
  highlight_count?: number | string;
}

interface NoteRow extends Record<string, unknown> {
  id: string;
  book_id: string;
  highlight_id: string | null;
  markdown: string;
  origin: "reader" | "import" | "ai";
  created_at_ms: number | string;
  updated_at_ms: number | string;
  revision: number | string;
}

interface BookRow extends Record<string, unknown> {
  id: string;
  title: string;
  authors: unknown;
  metadata: unknown;
  status: "unread" | "reading" | "finished" | "paused";
  archived: boolean;
  completed_on?: string | null;
  created_at_ms: number | string;
  updated_at_ms: number | string;
  revision: number | string;
}

interface CollectionRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  book_count: number | string;
  created_at_ms: number | string;
  updated_at_ms: number | string;
  revision: number | string;
}

interface TagRow extends Record<string, unknown> {
  id: string;
  name: string;
  color: string | null;
  book_count: number | string;
  highlight_count: number | string;
  created_at_ms: number | string;
  updated_at_ms: number | string;
  revision: number | string;
}

interface ThreadRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  passage_count: number | string;
  created_at_ms: number | string;
  updated_at_ms: number | string;
  revision: number | string;
}

interface DailySelectionRow extends Record<string, unknown> {
  id: string;
  local_day: string;
  timezone: string;
  highlight_id: string | null;
  candidate_digest: string;
  recent_highlight_ids: unknown;
  selected_at_ms: number | string;
  updated_at_ms: number | string;
  revision: number | string;
}

interface SyncedAnnotationState extends Record<string, unknown> {
  body: string | null;
  book_id: string | null;
  deleted_at: unknown;
  device_id: string | null;
  device_revision: number | string | null;
  operation: "upsert" | "tombstone" | null;
}

interface SyncChangeRow extends Record<string, unknown> {
  sequence: number | string;
  entity_type: SyncEntityType;
  entity_id: string;
  revision: number | string;
  changed_at_ms: number | string;
  checkpoint: string;
}

/** Current row (if any), device claim (if any), and absent-row tombstone (if any) for one changed entity. */
interface SyncedStateRow extends Record<string, unknown> {
  entity_id: string;
  id: string | null;
  deleted: boolean | null;
  archived?: boolean | null;
  book_id?: string | null;
  device_id: string | null;
  device_revision: number | string | null;
  operation: "upsert" | "tombstone" | null;
  tombstone_book_id: string | null;
  collection_ids?: unknown;
  tag_ids?: unknown;
  thread_ids?: unknown;
  status_events?: unknown;
}

/** PostgreSQL keeps its whole change history, so its cursor generation never advances. */
export const POSTGRES_SYNC_GENERATION = 1;

function syncedStateQuery(entityType: "book" | "highlight" | "note" | "collection" | "tag" | "thread", table: string, columns: string): string {
  return `
    SELECT ids.id::text AS entity_id, entity.id::text AS id, entity.deleted_at IS NOT NULL AS deleted, ${columns},
      floor(extract(epoch FROM entity.created_at) * 1000)::bigint AS created_at_ms,
      floor(extract(epoch FROM entity.updated_at) * 1000)::bigint AS updated_at_ms, entity.revision,
      writers.device_id::text AS device_id, writers.device_revision, writers.operation,
      tombstones.book_id::text AS tombstone_book_id
    FROM unnest($2::uuid[]) AS ids(id)
    LEFT JOIN leaflogue.${table} AS entity ON entity.library_id = $1 AND entity.id = ids.id
    LEFT JOIN leaflogue.synced_writers AS writers
      ON writers.library_id = $1 AND writers.entity_type = '${entityType}' AND writers.entity_id = ids.id
    LEFT JOIN leaflogue.sync_tombstones AS tombstones
      ON tombstones.library_id = $1 AND tombstones.entity_type = '${entityType}' AND tombstones.entity_id = ids.id
  `;
}

const SYNCED_STATE_QUERIES = {
  book: syncedStateQuery("book", "books", `entity.title, entity.authors, entity.metadata, entity.status, entity.archived,
      entity.completed_on::text AS completed_on,
      (SELECT coalesce(jsonb_agg(links.collection_id ORDER BY links.collection_id), '[]'::jsonb)
       FROM leaflogue.collection_books AS links
       WHERE links.library_id = $1 AND links.book_id = entity.id) AS collection_ids,
      (SELECT coalesce(jsonb_agg(links.tag_id ORDER BY links.tag_id), '[]'::jsonb)
       FROM leaflogue.book_tags AS links
       WHERE links.library_id = $1 AND links.book_id = entity.id) AS tag_ids,
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', events.id, 'bookId', events.book_id, 'status', events.status, 'source', events.source,
          'changedAt', floor(extract(epoch FROM events.changed_at) * 1000)::bigint,
          'completedOn', events.completed_on::text, 'bookRevision', events.book_revision
        ) ORDER BY events.changed_at, events.sequence), '[]'::jsonb)
       FROM leaflogue.reading_status_events AS events
       WHERE events.library_id = $1 AND events.book_id = entity.id) AS status_events,
      (SELECT count(*) FROM leaflogue.highlights AS highlights
       WHERE highlights.library_id = $1 AND highlights.book_id = entity.id
         AND highlights.archived = false AND highlights.deleted_at IS NULL) AS highlight_count`),
  highlight: syncedStateQuery("highlight", "highlights", `entity.book_id::text AS book_id, entity.text, entity.source_location,
      floor(extract(epoch FROM entity.source_created_at) * 1000)::bigint AS source_created_at_ms, entity.archived,
      (SELECT coalesce(jsonb_agg(links.tag_id ORDER BY links.tag_id), '[]'::jsonb)
       FROM leaflogue.highlight_tags AS links
       WHERE links.library_id = $1 AND links.highlight_id = entity.id) AS tag_ids,
      (SELECT coalesce(jsonb_agg(links.thread_id ORDER BY links.thread_id), '[]'::jsonb)
       FROM leaflogue.thread_highlights AS links
       WHERE links.library_id = $1 AND links.highlight_id = entity.id) AS thread_ids`),
  note: syncedStateQuery("note", "notes", `entity.book_id::text AS book_id, entity.highlight_id::text AS highlight_id,
      entity.markdown, entity.origin`),
  collection: syncedStateQuery("collection", "collections", `entity.name, entity.description,
      (SELECT count(*) FROM leaflogue.collection_books AS links
       WHERE links.library_id = $1 AND links.collection_id = entity.id) AS book_count`),
  tag: syncedStateQuery("tag", "tags", `entity.name, entity.color,
      (SELECT count(*) FROM leaflogue.book_tags AS links
       WHERE links.library_id = $1 AND links.tag_id = entity.id) AS book_count,
      (SELECT count(*) FROM leaflogue.highlight_tags AS links
       WHERE links.library_id = $1 AND links.tag_id = entity.id) AS highlight_count`),
  thread: syncedStateQuery("thread", "threads", `entity.name, entity.description,
      (SELECT count(*) FROM leaflogue.thread_highlights AS links
       WHERE links.library_id = $1 AND links.thread_id = entity.id) AS passage_count`),
  "daily-selection": `
    SELECT ids.id::text AS entity_id, entity.id::text AS id, false AS deleted,
      entity.local_day::text AS local_day, entity.timezone, entity.highlight_id::text AS highlight_id,
      entity.candidate_digest, entity.recent_highlight_ids,
      floor(extract(epoch FROM entity.selected_at) * 1000)::bigint AS selected_at_ms,
      floor(extract(epoch FROM entity.created_at) * 1000)::bigint AS created_at_ms,
      floor(extract(epoch FROM entity.updated_at) * 1000)::bigint AS updated_at_ms, entity.revision,
      writers.device_id::text AS device_id, writers.device_revision, writers.operation,
      tombstones.book_id::text AS tombstone_book_id
    FROM unnest($2::uuid[]) AS ids(id)
    LEFT JOIN leaflogue.daily_selections AS entity ON entity.library_id = $1 AND entity.id = ids.id
    LEFT JOIN leaflogue.synced_writers AS writers
      ON writers.library_id = $1 AND writers.entity_type = 'daily-selection' AND writers.entity_id = ids.id
    LEFT JOIN leaflogue.sync_tombstones AS tombstones
      ON tombstones.library_id = $1 AND tombstones.entity_type = 'daily-selection' AND tombstones.entity_id = ids.id
  `,
} as const;

/** Where each synced entity lives, for claiming web-client writes. */
const WEB_CLAIM_TABLES: Readonly<Record<SyncEntityType, string>> = {
  book: "books",
  highlight: "highlights",
  note: "notes",
  collection: "collections",
  tag: "tags",
  thread: "threads",
  "daily-selection": "daily_selections",
};

const clientTransactionTails = new WeakMap<PostgresClient, Promise<void>>();
const MAX_PENDING_SYNC_CONFLICTS_PER_ENTITY = 20;
const MAX_SYNC_HIGHLIGHT_CONFLICT_BYTES = 400_000;

/** Details a web client may set when it creates a book, such as from a catalog lookup. */
export interface PostgresBookDetails {
  readonly description?: string;
  readonly publisher?: string;
  readonly series?: string;
  readonly seriesNumber?: string;
  readonly language?: string;
  readonly coverUrl?: string;
}

/**
 * What a server may add when it creates a passage. A web client chooses the
 * IDs, as on Convex; only server code (an import) sets the note's origin or the
 * source's own timestamp.
 */
export interface PostgresHighlightCreation {
  readonly id?: HighlightId;
  readonly noteId?: NoteId;
  readonly noteOrigin?: "reader" | "import";
  readonly sourceCreatedAt?: number;
}

export type PostgresNewNote = Omit<NewNote, "origin"> & {
  readonly id?: NoteId;
  readonly origin?: "reader" | "ai" | "import";
};

export class PostgresLibraryMutations implements OnlineLibraryMutations, OnlineOrganizationMutations, OnlineThreadMutations, OnlineDailySelectionMutations {
  readonly #client: PostgresClient;
  readonly #libraryId: string;
  readonly #scope = new AsyncLocalStorage<true>();

  constructor(client: PostgresClient, libraryId: string) {
    this.#client = client;
    this.#libraryId = libraryId;
  }

  /**
   * Replay one change another device made. Unlike the interactive mutations
   * this carries no `expectedRevision`: the sending device's revision counts
   * only its own edits, so it cannot be checked against the provider's. Order
   * is decided by (revision, device) instead, which every replica evaluates the
   * same way and therefore converges on without a shared clock. See ADR 0005.
   */
  async applySyncedChange(change: SyncedChange): Promise<SyncedChangeOutcome> {
    if (!isUuid(change.deviceId) || !Number.isSafeInteger(change.deviceRevision) || change.deviceRevision < 1) {
      throw new Error("Synced change revision is invalid");
    }
    const entityId = syncedEntityId(change);
    if (!isUuid(entityId)) throw new Error("Synced change entity is invalid");
    const incomingBody = syncedBody(change);
    return this.#transaction(async () => {
      const current = change.entityType === "highlight" || change.entityType === "note" ? (await this.#client.query<SyncedAnnotationState>(`
        SELECT entity.body, entity.book_id, entity.deleted_at,
          writers.device_id, writers.device_revision, writers.operation
        FROM (SELECT 1) AS seed
        LEFT JOIN LATERAL (
          SELECT ${change.entityType === "highlight" ? "text" : "markdown"} AS body, book_id, deleted_at
          FROM leaflogue.${change.entityType === "highlight" ? "highlights" : "notes"}
          WHERE library_id = $1 AND id = $2
        ) AS entity ON true
        LEFT JOIN leaflogue.synced_writers AS writers
          ON writers.library_id = $1 AND writers.entity_type = $3 AND writers.entity_id = $2
      `, [this.#libraryId, entityId, change.entityType])).rows[0] : undefined;
      // Claiming the entity and writing it share one transaction, so a change
      // that loses the claim never touches the row.
      const claim = await this.#client.query(`
        INSERT INTO leaflogue.synced_writers
          (library_id, entity_type, entity_id, device_id, device_revision, operation)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (library_id, entity_type, entity_id) DO UPDATE
          SET device_id = excluded.device_id,
              device_revision = excluded.device_revision,
              operation = excluded.operation,
              applied_at = now()
          WHERE (excluded.operation = 'tombstone' AND leaflogue.synced_writers.operation = 'upsert')
             OR (excluded.operation = leaflogue.synced_writers.operation
                 AND (excluded.device_revision, excluded.device_id)
                   > (leaflogue.synced_writers.device_revision, leaflogue.synced_writers.device_id))
        RETURNING device_id
      `, [this.#libraryId, change.entityType, entityId, change.deviceId, change.deviceRevision, change.operation]);
      if (!claim.rows[0]) {
        if (change.entityType === "book" && change.operation === "upsert") await this.#mergeSupersededStatusEvents(change);
        if ((change.entityType === "highlight" || change.entityType === "note") && incomingBody && incomingBody !== current?.body &&
            !causallySuperseded(change.deviceId, change.deviceRevision, current?.device_id, current?.device_revision)) {
          await this.#preserveSyncConflict(change, incomingBody, current?.body ?? undefined, {
            deviceId: change.deviceId, deviceRevision: change.deviceRevision, operation: change.operation,
          }, current?.operation ?? "tombstone");
        }
        return "superseded";
      }

      if ((change.entityType === "highlight" || change.entityType === "note") && current?.body &&
          (current.deleted_at === null || current.deleted_at === undefined) && current.body !== incomingBody &&
          !causallySuperseded(current.device_id, current.device_revision, change.deviceId, change.deviceRevision)) {
        await this.#preserveSyncConflict(change, current.body, incomingBody, {
          ...(current.device_id ? { deviceId: current.device_id } : {}),
          ...(current.device_revision !== null ? { deviceRevision: Number(current.device_revision) } : {}),
          operation: current.operation ?? "upsert",
        }, change.operation);
      }

      if (change.entityType === "highlight") return this.#applySyncedHighlight(change, current?.book_id ?? undefined);
      if (change.entityType === "note") return this.#applySyncedNote(change, current?.book_id ?? undefined);
      if (change.entityType === "collection") return this.#applySyncedCollection(change);
      if (change.entityType === "tag") return this.#applySyncedTag(change);
      if (change.entityType === "thread") return this.#applySyncedThread(change);
      if (change.entityType === "daily-selection") return this.#applySyncedDailySelection(change);

      if (change.operation === "tombstone") {
        const removed = await this.#client.query<{ revision: number }>(`
          UPDATE leaflogue.books SET deleted_at = now(), revision = revision + 1, updated_at = now()
          WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL
          RETURNING revision
        `, [this.#libraryId, entityId]);
        await this.#client.query("DELETE FROM leaflogue.collection_books WHERE library_id = $1 AND book_id = $2", [this.#libraryId, entityId]);
        await this.#client.query("DELETE FROM leaflogue.book_tags WHERE library_id = $1 AND book_id = $2", [this.#libraryId, entityId]);
        const revision = await this.#recordSyncedTombstone("book", entityId, entityId, removed.rows[0]?.revision);
        await this.#recordChange("book", entityId, revision);
        return "applied";
      }

      const collectionIds = await this.#activeSyncedContainers("collection", requireSyncIds(change.collectionIds, "Book collection membership"));
      const tagIds = await this.#activeSyncedContainers("tag", requireSyncIds(change.tagIds, "Book tag membership"));
      const { title, authors, ...details } = normalizeBookMetadata(change.book);
      const completedOn = change.book.status === "finished"
        ? validateCompletionDate(change.book.completedOn)
        : undefined;
      const written = await this.#client.query<{ revision: number }>(`
        INSERT INTO leaflogue.books
          (library_id, id, title, authors, metadata, status, archived, completed_on, revision, created_at, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, 1, now(), now())
        ON CONFLICT (library_id, id) DO UPDATE
          SET title = excluded.title, authors = excluded.authors, metadata = excluded.metadata,
              status = excluded.status, archived = excluded.archived,
              completed_on = excluded.completed_on, deleted_at = NULL,
              revision = leaflogue.books.revision + 1, updated_at = now()
        RETURNING revision
      `, [
        this.#libraryId, entityId, title, JSON.stringify(authors), JSON.stringify(details),
        change.book.status, change.book.archived, completedOn ?? null,
      ]);
      const revision = written.rows[0]?.revision;
      if (revision === undefined) throw new Error("Synced book could not be written");
      await this.#client.query("DELETE FROM leaflogue.collection_books WHERE library_id = $1 AND book_id = $2", [this.#libraryId, entityId]);
      await this.#client.query("DELETE FROM leaflogue.book_tags WHERE library_id = $1 AND book_id = $2", [this.#libraryId, entityId]);
      if (collectionIds.length > 0) await this.#client.query(`
        INSERT INTO leaflogue.collection_books (library_id, collection_id, book_id)
        SELECT $1, unnest($2::uuid[]), $3
      `, [this.#libraryId, collectionIds, entityId]);
      if (tagIds.length > 0) await this.#client.query(`
        INSERT INTO leaflogue.book_tags (library_id, tag_id, book_id)
        SELECT $1, unnest($2::uuid[]), $3
      `, [this.#libraryId, tagIds, entityId]);
      await this.#mergeStatusEvents(entityId, change.statusEvents, true);
      await this.#clearSyncedTombstone("book", entityId);
      await this.#recordChange("book", entityId, Number(revision));
      return "applied";
    });
  }

  /**
   * Read one bounded page of the library's change feed, with the current state
   * and device claim behind each change (the reverse of the outbox: a change
   * says an entity moved on, and the payload is where it is now).
   *
   * The page is read under the library's advisory lock. Every writer records
   * its `sync_changes` row inside a transaction holding that lock, so no lower
   * sequence can still be uncommitted when a higher one is visible; without it
   * the cursor could step past a change that commits a moment later.
   *
   * `sync_changes` is never compacted yet, so the generation is fixed at 1.
   * Every cursor also names the provider-issued token at its exact history
   * position, detecting a restored history even after its sequence catches up.
   */
  async readSyncedChangePage(cursor: SyncCursor, limit: number = MAX_SYNC_CHANGE_PAGE): Promise<SyncPullPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYNC_CHANGE_PAGE) throw new Error("Sync page limit is invalid");
    if (!Number.isSafeInteger(cursor.generation) || cursor.generation < 1 ||
        !Number.isSafeInteger(cursor.afterSequence) || cursor.afterSequence < 0) {
      throw new Error("Sync cursor is invalid");
    }
    return this.#transaction(async () => {
      const origin = await this.#syncOrigin();
      if (!(await this.#recognizesSyncCursor(cursor, origin))) {
        return {
          page: { changes: [], nextCursor: { generation: POSTGRES_SYNC_GENERATION, afterSequence: 0, checkpoint: origin }, isDone: false, resetRequired: true },
          changes: [],
        };
      }
      const rows = (await this.#client.query<SyncChangeRow>(`
        SELECT sequence, entity_type, entity_id::text AS entity_id, revision,
          floor(extract(epoch FROM changed_at) * 1000)::bigint AS changed_at_ms,
          change_token::text AS checkpoint
        FROM leaflogue.sync_changes
        WHERE library_id = $1 AND sequence > $2
        ORDER BY sequence LIMIT $3
      `, [this.#libraryId, cursor.afterSequence, limit + 1])).rows;
      const changes: SyncChange[] = rows.slice(0, limit).map((row) => ({
        sequence: Number(row.sequence),
        entityType: row.entity_type,
        entityId: row.entity_id,
        revision: Number(row.revision),
        changedAt: Number(row.changed_at_ms),
        checkpoint: row.checkpoint,
      }));
      const states = new Map<string, SyncedChange | undefined>();
      for (const entityType of ["book", "highlight", "note", "collection", "tag", "thread", "daily-selection"] as const) {
        const ids = [...new Set(changes.filter((change) => change.entityType === entityType).map(({ entityId }) => entityId))];
        if (ids.length === 0) continue;
        const result = await this.#client.query<SyncedStateRow>(SYNCED_STATE_QUERIES[entityType], [this.#libraryId, ids]);
        for (const row of result.rows) states.set(`${entityType}:${row.entity_id}`, syncedChangeFromState(entityType, row));
      }
      return {
        page: {
          changes,
          nextCursor: {
            generation: POSTGRES_SYNC_GENERATION,
            afterSequence: changes.at(-1)?.sequence ?? cursor.afterSequence,
            checkpoint: changes.at(-1)?.checkpoint ?? cursor.checkpoint,
          },
          isDone: rows.length <= limit,
          resetRequired: false,
        },
        changes: changes.map(({ entityType, entityId }) => states.get(`${entityType}:${entityId}`)),
      };
    });
  }

  async syncOrigin(): Promise<SyncCursor> {
    return { generation: POSTGRES_SYNC_GENERATION, afterSequence: 0, checkpoint: await this.#syncOrigin() };
  }

  async recognizesSyncCursor(cursor: SyncCursor): Promise<boolean> {
    return this.#recognizesSyncCursor(cursor, await this.#syncOrigin());
  }

  async #recognizesSyncCursor(cursor: SyncCursor, origin: string): Promise<boolean> {
    if (cursor.generation !== POSTGRES_SYNC_GENERATION || !cursor.checkpoint) return false;
    if (cursor.afterSequence === 0) return cursor.checkpoint === origin;
    const position = (await this.#client.query<{ checkpoint: string }>(`
      SELECT change_token::text AS checkpoint FROM leaflogue.sync_changes
      WHERE library_id = $1 AND sequence = $2
    `, [this.#libraryId, cursor.afterSequence])).rows[0]?.checkpoint;
    return cursor.checkpoint === position;
  }

  async #syncOrigin(): Promise<string> {
    const result = await this.#client.query<{ checkpoint: string }>(`
      INSERT INTO leaflogue.library_sync_state (library_id) VALUES ($1)
      ON CONFLICT (library_id) DO UPDATE SET library_id = excluded.library_id
      RETURNING instance_id::text AS checkpoint
    `, [this.#libraryId]);
    const checkpoint = result.rows[0]?.checkpoint;
    if (!checkpoint) throw new Error("PostgreSQL sync history is unavailable");
    return checkpoint;
  }

  async #applySyncedHighlight(
    change: Extract<SyncedChange, { entityType: "highlight" }>,
    currentBookId: string | undefined,
  ): Promise<SyncedChangeOutcome> {
    const entityId = syncedEntityId(change);
    const bookId = change.operation === "upsert" ? change.highlight.bookId : change.bookId;
    let revision: number | undefined;
    if (change.operation === "tombstone") {
      const removed = await this.#client.query<{ revision: number; book_id: string }>(`
        UPDATE leaflogue.highlights SET deleted_at = now(), revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING revision, book_id
      `, [this.#libraryId, entityId]);
      currentBookId = removed.rows[0]?.book_id ?? currentBookId;
      await this.#client.query(
        "DELETE FROM leaflogue.highlight_tags WHERE library_id = $1 AND highlight_id = $2",
        [this.#libraryId, entityId],
      );
      await this.#client.query(
        "DELETE FROM leaflogue.thread_highlights WHERE library_id = $1 AND highlight_id = $2",
        [this.#libraryId, entityId],
      );
      revision = await this.#recordSyncedTombstone("highlight", entityId, currentBookId ?? bookId, removed.rows[0]?.revision);
    } else {
      const tagIds = await this.#activeSyncedContainers("tag", requireSyncIds(change.tagIds, "Passage tag membership"));
      const threadIds = await this.#activeSyncedContainers("thread",
        requireSyncIds(change.threadIds, "Passage thread membership", MAX_THREADS_PER_HIGHLIGHT));
      const text = requiredText(change.highlight.text, "Highlight", 100_000);
      const location = optionalText(change.highlight.sourceLocation, 2_000);
      const written = await this.#client.query<{ revision: number }>(`
        INSERT INTO leaflogue.highlights
          (library_id, id, book_id, text, source_location, source_created_at, archived, revision, created_at, updated_at)
        SELECT $1, $2, books.id, $4, $5, to_timestamp($6::double precision / 1000.0), false, 1,
          to_timestamp($7::double precision / 1000.0), now()
        FROM leaflogue.books WHERE library_id = $1 AND id = $3 AND deleted_at IS NULL
        ON CONFLICT (library_id, id) DO UPDATE SET
          book_id = excluded.book_id, text = excluded.text, source_location = excluded.source_location,
          source_created_at = excluded.source_created_at, archived = false, deleted_at = NULL,
          revision = leaflogue.highlights.revision + 1, updated_at = now()
        RETURNING revision
      `, [this.#libraryId, entityId, bookId, text, location ?? null,
        validEpoch(change.highlight.sourceCreatedAt, true), validEpoch(change.highlight.createdAt)]);
      revision = written.rows[0]?.revision;
      if (revision === undefined) throw new Error("Synced highlight's book no longer exists");
      await this.#client.query(
        "DELETE FROM leaflogue.highlight_tags WHERE library_id = $1 AND highlight_id = $2",
        [this.#libraryId, entityId],
      );
      if (tagIds.length > 0) await this.#client.query(`
        INSERT INTO leaflogue.highlight_tags (library_id, tag_id, highlight_id)
        SELECT $1, unnest($2::uuid[]), $3
      `, [this.#libraryId, tagIds, entityId]);
      // Surviving memberships keep their original added time.
      await this.#client.query(`
        DELETE FROM leaflogue.thread_highlights
        WHERE library_id = $1 AND highlight_id = $2 AND NOT (thread_id = ANY($3::uuid[]))
      `, [this.#libraryId, entityId, threadIds]);
      if (threadIds.length > 0) await this.#client.query(`
        INSERT INTO leaflogue.thread_highlights (library_id, thread_id, highlight_id)
        SELECT $1, unnest($2::uuid[]), $3
        ON CONFLICT (library_id, thread_id, highlight_id) DO NOTHING
      `, [this.#libraryId, threadIds, entityId]);
      await this.#clearSyncedTombstone("highlight", entityId);
    }
    if (revision !== undefined) await this.#recordChange("highlight", entityId, Number(revision));
    await this.#touchSyncedBooks(change.operation === "upsert" ? currentBookId : undefined, currentBookId ?? bookId);
    return "applied";
  }

  async #applySyncedNote(
    change: Extract<SyncedChange, { entityType: "note" }>,
    currentBookId: string | undefined,
  ): Promise<SyncedChangeOutcome> {
    const entityId = syncedEntityId(change);
    const bookId = change.operation === "upsert" ? change.note.bookId : change.bookId;
    let revision: number | undefined;
    if (change.operation === "tombstone") {
      const removed = await this.#client.query<{ revision: number; book_id: string }>(`
        UPDATE leaflogue.notes SET deleted_at = now(), revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING revision, book_id
      `, [this.#libraryId, entityId]);
      currentBookId = removed.rows[0]?.book_id ?? currentBookId;
      revision = await this.#recordSyncedTombstone("note", entityId, currentBookId ?? bookId, removed.rows[0]?.revision);
    } else {
      const markdown = requiredNote(change.note.markdown);
      if (!["reader", "import", "ai"].includes(change.note.origin)) throw new Error("Synced note origin is invalid");
      const written = await this.#client.query<{ revision: number }>(`
        INSERT INTO leaflogue.notes
          (library_id, id, book_id, highlight_id, markdown, origin, revision, created_at, updated_at)
        SELECT $1, $2, books.id, highlights.id, $5, $6, 1,
          to_timestamp($7::double precision / 1000.0), now()
        FROM leaflogue.books
        LEFT JOIN leaflogue.highlights ON highlights.library_id = books.library_id
          AND highlights.id = $4 AND highlights.book_id = books.id AND highlights.deleted_at IS NULL
        WHERE books.library_id = $1 AND books.id = $3 AND books.deleted_at IS NULL
          AND ($4::uuid IS NULL OR highlights.id IS NOT NULL)
          AND ($4::uuid IS NULL OR EXISTS (
            SELECT 1 FROM leaflogue.notes AS existing
            WHERE existing.library_id = $1 AND existing.id = $2 AND existing.deleted_at IS NULL
              AND existing.highlight_id IS NOT DISTINCT FROM $4
          ) OR (
            SELECT COUNT(*) FROM leaflogue.notes AS active_notes
            WHERE active_notes.library_id = $1 AND active_notes.highlight_id = $4 AND active_notes.deleted_at IS NULL
          ) < ${MAX_NOTES_PER_HIGHLIGHT})
        ON CONFLICT (library_id, id) DO UPDATE SET
          book_id = excluded.book_id, highlight_id = excluded.highlight_id, markdown = excluded.markdown,
          origin = excluded.origin, deleted_at = NULL,
          revision = leaflogue.notes.revision + 1, updated_at = now()
        RETURNING revision
      `, [this.#libraryId, entityId, bookId, change.note.highlightId ?? null, markdown,
        change.note.origin, validEpoch(change.note.createdAt)]);
      revision = written.rows[0]?.revision;
      if (revision === undefined) throw new Error("Synced note's book or highlight no longer exists");
      await this.#clearSyncedTombstone("note", entityId);
    }
    if (revision !== undefined) await this.#recordChange("note", entityId, Number(revision));
    await this.#touchSyncedBooks(change.operation === "upsert" ? currentBookId : undefined, currentBookId ?? bookId);
    return "applied";
  }

  async #applySyncedCollection(
    change: Extract<SyncedChange, { entityType: "collection" }>,
  ): Promise<SyncedChangeOutcome> {
    const entityId = syncedEntityId(change);
    if (change.operation === "tombstone") {
      const removed = await this.#client.query<{ revision: number | string }>(`
        UPDATE leaflogue.collections SET deleted_at = now(), revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING revision
      `, [this.#libraryId, entityId]);
      await this.#client.query(
        "DELETE FROM leaflogue.collection_books WHERE library_id = $1 AND collection_id = $2",
        [this.#libraryId, entityId],
      );
      const revision = await this.#recordSyncedTombstone(
        "collection", entityId, entityId, removed.rows[0] === undefined ? undefined : Number(removed.rows[0].revision),
      );
      await this.#recordChange("collection", entityId, revision);
      return "applied";
    }
    const name = requiredText(change.collection.name, "Collection", 120);
    const description = optionalText(change.collection.description, 2_000);
    const written = await this.#client.query<{ revision: number | string }>(`
      INSERT INTO leaflogue.collections
        (library_id, id, name, normalized_name, description, revision, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 1, to_timestamp($6::double precision / 1000.0), now())
      ON CONFLICT (library_id, id) DO UPDATE SET
        name = excluded.name, normalized_name = excluded.normalized_name, description = excluded.description,
        deleted_at = NULL, revision = leaflogue.collections.revision + 1, updated_at = now()
      RETURNING revision
    `, [this.#libraryId, entityId, name, normalizeOrganizationName(name), description ?? null,
      validEpoch(change.collection.createdAt)]);
    const revision = Number(written.rows[0]?.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Synced collection could not be written");
    await this.#clearSyncedTombstone("collection", entityId);
    await this.#recordChange("collection", entityId, revision);
    return "applied";
  }

  async #applySyncedTag(change: Extract<SyncedChange, { entityType: "tag" }>): Promise<SyncedChangeOutcome> {
    const entityId = syncedEntityId(change);
    if (change.operation === "tombstone") {
      const removed = await this.#client.query<{ revision: number | string }>(`
        UPDATE leaflogue.tags SET deleted_at = now(), revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING revision
      `, [this.#libraryId, entityId]);
      await this.#client.query("DELETE FROM leaflogue.book_tags WHERE library_id = $1 AND tag_id = $2", [this.#libraryId, entityId]);
      await this.#client.query("DELETE FROM leaflogue.highlight_tags WHERE library_id = $1 AND tag_id = $2", [this.#libraryId, entityId]);
      const revision = await this.#recordSyncedTombstone(
        "tag", entityId, entityId, removed.rows[0] === undefined ? undefined : Number(removed.rows[0].revision),
      );
      await this.#recordChange("tag", entityId, revision);
      return "applied";
    }
    const name = requiredText(change.tag.name, "Tag", 80);
    const color = optionalText(change.tag.color, 32);
    const written = await this.#client.query<{ revision: number | string }>(`
      INSERT INTO leaflogue.tags
        (library_id, id, name, normalized_name, color, revision, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 1, to_timestamp($6::double precision / 1000.0), now())
      ON CONFLICT (library_id, id) DO UPDATE SET
        name = excluded.name, normalized_name = excluded.normalized_name, color = excluded.color,
        deleted_at = NULL, revision = leaflogue.tags.revision + 1, updated_at = now()
      RETURNING revision
    `, [this.#libraryId, entityId, name, normalizeOrganizationName(name), color ?? null,
      validEpoch(change.tag.createdAt)]);
    const revision = Number(written.rows[0]?.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Synced tag could not be written");
    await this.#clearSyncedTombstone("tag", entityId);
    await this.#recordChange("tag", entityId, revision);
    return "applied";
  }

  /**
   * A losing book change still contributes its history, since events are a
   * grow-only set. When that adds anything, the book is re-announced at its
   * unchanged revision so other devices pull the merged history too.
   */
  async #mergeSupersededStatusEvents(change: Extract<SyncedChange, { entityType: "book"; operation: "upsert" }>): Promise<void> {
    if (!change.statusEvents?.length) return;
    const book = await this.#client.query<{ revision: number | string }>(
      "SELECT revision FROM leaflogue.books WHERE library_id = $1 AND id = $2",
      [this.#libraryId, change.book.id],
    );
    if (!book.rows[0]) return;
    if (await this.#mergeStatusEvents(change.book.id, change.statusEvents, false)) {
      await this.#recordChange("book", change.book.id, Number(book.rows[0].revision));
    }
  }

  /** Insert unknown events; a winning snapshot may also move an event onto this book. Returns whether anything changed. */
  async #mergeStatusEvents(bookId: string, events: readonly ReadingStatusEvent[] | undefined, allowMove: boolean): Promise<boolean> {
    if (!events?.length) return false;
    const valid = requireStatusEvents(events, bookId);
    const inserted = await this.#client.query(`
      INSERT INTO leaflogue.reading_status_events
        (library_id, id, book_id, status, source, changed_at, completed_on, book_revision)
      SELECT $1, event.id, $2, event.status, event.source, to_timestamp(event.changed_at / 1000.0),
        event.completed_on, event.book_revision
      FROM jsonb_to_recordset($3::jsonb) AS event(id uuid, status text, source text, changed_at double precision,
        completed_on date, book_revision bigint)
      ORDER BY event.changed_at
      ON CONFLICT (library_id, id) DO NOTHING
      RETURNING id
    `, [this.#libraryId, bookId, JSON.stringify(valid.map((event) => ({
      id: event.id, status: event.status, source: event.source, changed_at: event.changedAt,
      completed_on: event.completedOn ?? null, book_revision: event.bookRevision,
    })))]);
    let changed = inserted.rows.length > 0;
    if (allowMove) {
      const moved = await this.#client.query(`
        UPDATE leaflogue.reading_status_events SET book_id = $2
        WHERE library_id = $1 AND id = ANY($3::uuid[]) AND book_id <> $2
        RETURNING id
      `, [this.#libraryId, bookId, valid.map(({ id }) => id)]);
      changed ||= moved.rows.length > 0;
    }
    return changed;
  }

  /**
   * One pick per (day, time zone). When two devices picked offline, the
   * earlier pick (then the lower ID) keeps the slot and the other is retired:
   * its row goes, a tombstone records it, and its writer claim becomes a
   * tombstone so pulls express the retirement.
   */
  async #applySyncedDailySelection(change: Extract<SyncedChange, { entityType: "daily-selection" }>): Promise<SyncedChangeOutcome> {
    const entityId = syncedEntityId(change);
    const retire = async (id: string): Promise<void> => {
      const removed = await this.#client.query<{ revision: number | string }>(
        "DELETE FROM leaflogue.daily_selections WHERE library_id = $1 AND id = $2 RETURNING revision",
        [this.#libraryId, id],
      );
      const revision = await this.#recordSyncedTombstone("daily-selection", id, id,
        removed.rows[0] === undefined ? undefined : Number(removed.rows[0].revision) + 1);
      await this.#client.query(`
        UPDATE leaflogue.synced_writers SET operation = 'tombstone', applied_at = now()
        WHERE library_id = $1 AND entity_type = 'daily-selection' AND entity_id = $2
      `, [this.#libraryId, id]);
      await this.#recordChange("daily-selection", id, revision);
    };
    if (change.operation === "tombstone") {
      await retire(entityId);
      return "applied";
    }
    const pick = requireSyncedDailySelection(change.dailySelection);
    const occupant = await this.#client.query<{ id: string; created_at_ms: number | string }>(`
      SELECT id::text AS id, floor(extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms
      FROM leaflogue.daily_selections
      WHERE library_id = $1 AND local_day = $2::date AND timezone = $3 AND id <> $4
    `, [this.#libraryId, pick.localDay, pick.timezone, entityId]);
    const other = occupant.rows[0];
    if (other) {
      if (!dailySelectionWins({ id: entityId, createdAt: pick.createdAt }, { id: other.id, createdAt: Number(other.created_at_ms) })) {
        await retire(entityId);
        return "applied";
      }
      await retire(other.id);
    }
    const written = await this.#client.query<{ revision: number | string }>(`
      INSERT INTO leaflogue.daily_selections
        (library_id, id, local_day, timezone, highlight_id, candidate_digest, recent_highlight_ids,
         selected_at, updated_at, revision, created_at)
      SELECT $1, $2, $3::date, $4,
        (SELECT id FROM leaflogue.highlights WHERE library_id = $1 AND id = $5::uuid), $6, $7::jsonb,
        to_timestamp($8::double precision / 1000.0), now(), 1, to_timestamp($9::double precision / 1000.0)
      ON CONFLICT (library_id, local_day, timezone) DO UPDATE SET
        highlight_id = excluded.highlight_id, candidate_digest = excluded.candidate_digest,
        recent_highlight_ids = excluded.recent_highlight_ids, selected_at = excluded.selected_at,
        updated_at = now(), revision = leaflogue.daily_selections.revision + 1
      WHERE leaflogue.daily_selections.id = excluded.id
      RETURNING revision
    `, [this.#libraryId, entityId, pick.localDay, pick.timezone, pick.highlightId ?? null, pick.candidateDigest,
      JSON.stringify(pick.recentHighlightIds), pick.selectedAt, pick.createdAt]);
    const revision = Number(written.rows[0]?.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Synced daily selection could not be written");
    await this.#clearSyncedTombstone("daily-selection", entityId);
    await this.#recordChange("daily-selection", entityId, revision);
    return "applied";
  }

  async #requireStatusHistoryCapacity(bookIds: readonly string[], adding: number): Promise<void> {
    const count = await this.#client.query<{ count: number | string }>(`
      SELECT count(*) AS count FROM leaflogue.reading_status_events
      WHERE library_id = $1 AND book_id = ANY($2::uuid[])
    `, [this.#libraryId, bookIds]);
    if (Number(count.rows[0]?.count ?? 0) + adding > MAX_STATUS_EVENTS_PER_BOOK) {
      throw new Error(`A book can keep at most ${MAX_STATUS_EVENTS_PER_BOOK} reading-status changes`);
    }
  }

  async #applySyncedThread(change: Extract<SyncedChange, { entityType: "thread" }>): Promise<SyncedChangeOutcome> {
    const entityId = syncedEntityId(change);
    if (change.operation === "tombstone") {
      const removed = await this.#client.query<{ revision: number | string }>(`
        UPDATE leaflogue.threads SET deleted_at = now(), revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING revision
      `, [this.#libraryId, entityId]);
      // A thread never owns its passages: only memberships go.
      await this.#client.query("DELETE FROM leaflogue.thread_highlights WHERE library_id = $1 AND thread_id = $2", [this.#libraryId, entityId]);
      const revision = await this.#recordSyncedTombstone(
        "thread", entityId, entityId, removed.rows[0] === undefined ? undefined : Number(removed.rows[0].revision),
      );
      await this.#recordChange("thread", entityId, revision);
      return "applied";
    }
    const name = organizationName(change.thread.name, "Thread", 120);
    const description = organizationOptionalText(change.thread.description, "Thread description", 1_000);
    const written = await this.#client.query<{ revision: number | string }>(`
      INSERT INTO leaflogue.threads
        (library_id, id, name, normalized_name, description, revision, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 1, to_timestamp($6::double precision / 1000.0), now())
      ON CONFLICT (library_id, id) DO UPDATE SET
        name = excluded.name, normalized_name = excluded.normalized_name, description = excluded.description,
        deleted_at = NULL, revision = leaflogue.threads.revision + 1, updated_at = now()
      RETURNING revision
    `, [this.#libraryId, entityId, name, normalizeOrganizationName(name), description ?? null,
      validEpoch(change.thread.createdAt)]);
    const revision = Number(written.rows[0]?.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Synced thread could not be written");
    await this.#clearSyncedTombstone("thread", entityId);
    await this.#recordChange("thread", entityId, revision);
    return "applied";
  }

  async #activeSyncedContainers(entityType: "collection" | "tag" | "thread", ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const result = await this.#client.query<{ id: string; active: boolean; tombstoned: boolean }>(`
      SELECT requested.id::text AS id, container.id IS NOT NULL AS active, tombstone.entity_id IS NOT NULL AS tombstoned
      FROM unnest($2::uuid[]) AS requested(id)
      LEFT JOIN leaflogue.${entityType === "collection" ? "collections" : entityType === "tag" ? "tags" : "threads"} AS container
        ON container.library_id = $1 AND container.id = requested.id AND container.deleted_at IS NULL
      LEFT JOIN leaflogue.sync_tombstones AS tombstone
        ON tombstone.library_id = $1 AND tombstone.entity_type = $3 AND tombstone.entity_id = requested.id
    `, [this.#libraryId, ids, entityType]);
    if (result.rows.length !== ids.length || result.rows.some((row) => !row.active && !row.tombstoned)) {
      throw new Error("Synced organization container no longer exists");
    }
    return result.rows.filter(({ active }) => active).map(({ id }) => id);
  }

  async #preserveSyncConflict(
    change: Extract<SyncedChange, { entityType: "highlight" | "note" }>,
    losingBody: string,
    winningBody: string | undefined,
    loser: { readonly deviceId?: string; readonly deviceRevision?: number; readonly operation: "upsert" | "tombstone" },
    winningOperation: "upsert" | "tombstone",
  ): Promise<void> {
    const entityId = syncedEntityId(change);
    const bookId = change.operation === "upsert"
      ? change.entityType === "highlight" ? change.highlight.bookId : change.note.bookId
      : change.bookId;
    const fingerprint = createHash("sha256").update(JSON.stringify([
      change.entityType, entityId, losingBody, loser.deviceId ?? null, loser.deviceRevision ?? null, loser.operation,
    ])).digest("hex");
    const maximumBytes = change.entityType === "note" ? MAX_NOTE_BYTES : MAX_SYNC_HIGHLIGHT_CONFLICT_BYTES;
    if (new TextEncoder().encode(losingBody).byteLength > maximumBytes) {
      throw new Error("A losing synced body exceeds the reviewable conflict limit");
    }
    const capacity = await this.#client.query<{ duplicate: boolean; pending_count: number | string }>(`
      SELECT EXISTS(
        SELECT 1 FROM leaflogue.sync_conflicts WHERE library_id = $1 AND fingerprint = $2
      ) AS duplicate, COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
      FROM leaflogue.sync_conflicts
      WHERE library_id = $1 AND entity_type = $3 AND entity_id = $4
    `, [this.#libraryId, fingerprint, change.entityType, entityId]);
    if (capacity.rows[0]?.duplicate === true) return;
    if (Number(capacity.rows[0]?.pending_count ?? 0) >= MAX_PENDING_SYNC_CONFLICTS_PER_ENTITY) {
      throw new Error("This synced item has too many pending conflicts to preserve another body");
    }
    await this.#client.query(`
      INSERT INTO leaflogue.sync_conflicts
        (library_id, id, entity_type, entity_id, book_id, losing_body, winning_body,
         losing_device_id, losing_device_revision, losing_operation, winning_operation, fingerprint)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (library_id, fingerprint) DO NOTHING
    `, [this.#libraryId, randomUUID(), change.entityType, entityId, bookId, losingBody,
      winningBody ?? null, loser.deviceId ?? null, loser.deviceRevision ?? null,
      loser.operation, winningOperation, fingerprint]);
  }

  async #recordSyncedTombstone(
    entityType: "book" | "highlight" | "note" | "collection" | "tag" | "thread" | "daily-selection",
    entityId: string,
    bookId: string,
    rowRevision: number | undefined,
  ): Promise<number> {
    const result = await this.#client.query<{ revision: number | string }>(`
      INSERT INTO leaflogue.sync_tombstones
        (library_id, entity_type, entity_id, book_id, revision)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (library_id, entity_type, entity_id) DO UPDATE SET
        book_id = excluded.book_id,
        revision = GREATEST(leaflogue.sync_tombstones.revision + 1, excluded.revision),
        deleted_at = now()
      RETURNING revision
    `, [this.#libraryId, entityType, entityId, bookId, rowRevision ?? 1]);
    const revision = Number(result.rows[0]?.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Synced tombstone could not be written");
    return revision;
  }

  async #clearSyncedTombstone(entityType: "book" | "highlight" | "note" | "collection" | "tag" | "thread" | "daily-selection", entityId: string): Promise<void> {
    await this.#client.query(`
      DELETE FROM leaflogue.sync_tombstones
      WHERE library_id = $1 AND entity_type = $2 AND entity_id = $3
    `, [this.#libraryId, entityType, entityId]);
  }

  async #touchSyncedBooks(currentBookId: string | undefined, incomingBookId: string): Promise<void> {
    for (const bookId of new Set([currentBookId, incomingBookId].filter((id): id is string => id !== undefined))) {
      const result = await this.#client.query<{ revision: number | string }>(`
        UPDATE leaflogue.books SET revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING revision
      `, [this.#libraryId, bookId]);
      const revision = result.rows[0]?.revision;
      if (revision !== undefined) await this.#recordChange("book", bookId, Number(revision));
    }
  }

  async createBook(input: CreateBook & PostgresBookDetails): Promise<Book> {
    const id = requiredId(input.id);
    const title = requiredText(input.title, "Book title", Number.MAX_SAFE_INTEGER);
    const authors = (input.authors ?? []).map((author) => author.trim()).filter(Boolean);
    const isbn13 = input.isbn13 === undefined ? undefined : normalizeIsbn13(input.isbn13);
    if (input.isbn13 !== undefined && !isbn13) throw new Error("ISBN-13 is invalid");
    const { description, publisher, series, seriesNumber, language, coverUrl } = input;
    const hasDetails = [description, publisher, series, seriesNumber, language, coverUrl].some((value) => value !== undefined);
    let details: Record<string, string> = isbn13 ? { isbn13 } : {};
    if (hasDetails) {
      const normalized = normalizeBookMetadata({
        title, authors, ...(isbn13 ? { isbn13 } : {}), description, publisher, series, seriesNumber, language, coverUrl,
      });
      details = Object.fromEntries(Object.entries(normalized).filter((entry): entry is [string, string] =>
        entry[0] !== "title" && entry[0] !== "authors" && typeof entry[1] === "string"));
    }
    return this.#transaction(async () => {
      const result = await this.#client.query<BookRow>(`
        INSERT INTO leaflogue.books
          (library_id, id, title, authors, metadata, status, archived, revision, created_at, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'unread', false, 1, now(), now())
        ON CONFLICT (library_id, id) DO NOTHING
        RETURNING id, title, authors, metadata, status, archived,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
      `, [this.#libraryId, id, title, JSON.stringify(authors), JSON.stringify(details)]);
      const row = result.rows[0];
      if (!row) {
        const existing = await this.#client.query<BookRow>(`
          SELECT books.id, title, authors, metadata, status, archived,
            extract(epoch FROM created_at) * 1000 AS created_at_ms,
            extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision,
            (SELECT count(*) FROM leaflogue.highlights
             WHERE library_id = books.library_id AND book_id = books.id
               AND archived = false AND deleted_at IS NULL) AS highlight_count
          FROM leaflogue.books AS books WHERE library_id = $1 AND id = $2
        `, [this.#libraryId, id]);
        const replay = existing.rows[0];
        if (!replay) throw new Error("Book could not be created");
        const book = mapBook(replay);
        if (!sameCreateBook(book, { id: id as BookId, title, authors, ...(isbn13 ? { isbn13 } : {}) })) {
          throw new Error("Entity ID already exists with different book data");
        }
        return book;
      }
      await this.#recordWebChange("book", id, 1);
      return mapBook(row);
    });
  }

  async updateBookMetadata(input: UpdateBookMetadata): Promise<Book> {
    requireRevision(input.expectedRevision, "Book");
    const metadata = normalizeBookMetadata(input);
    const { title, authors, ...details } = metadata;
    return this.#transaction(async () => {
      if (metadata.isbn13) {
        const holder = await this.#client.query(`
          SELECT id FROM leaflogue.books
          WHERE library_id = $1 AND id != $2 AND deleted_at IS NULL AND metadata->>'isbn13' = $3
        `, [this.#libraryId, input.id, metadata.isbn13]);
        if (holder.rows[0]) throw new Error("Another book already has that ISBN-13");
      }
      const result = await this.#client.query<BookRow>(`
        UPDATE leaflogue.books
        SET title = $4, authors = $5::jsonb, metadata = $6::jsonb, revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND revision = $3 AND archived = false AND deleted_at IS NULL
        RETURNING id, title, authors, metadata, status, archived, completed_on,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision,
          (SELECT count(*) FROM leaflogue.highlights
           WHERE library_id = $1 AND book_id = $2 AND archived = false AND deleted_at IS NULL) AS highlight_count
      `, [this.#libraryId, input.id, input.expectedRevision, title, JSON.stringify(authors), JSON.stringify(details)]);
      const row = result.rows[0];
      if (!row) throw new Error("Book changed elsewhere or no longer exists");
      await this.#recordWebChange("book", input.id, Number(row.revision));
      return mapBook(row);
    });
  }

  async createHighlight(input: NewHighlight & PostgresHighlightCreation): Promise<HighlightMutationResult> {
    const id = input.id === undefined ? randomUUID() : requiredEntityId(input.id, "Highlight");
    const text = requiredText(input.text, "Highlight", 100_000);
    const location = optionalText(input.sourceLocation, 2_000);
    const noteMarkdown = input.noteMarkdown === undefined ? undefined : requiredNote(input.noteMarkdown);
    const sourceCreatedAt = input.sourceCreatedAt === undefined ? null : requiredTimestamp(input.sourceCreatedAt);
    return this.#transaction(async () => {
      const result = await this.#client.query<HighlightRow>(`
        INSERT INTO leaflogue.highlights
          (library_id, id, book_id, text, source_location, source_created_at, revision, created_at, updated_at)
        SELECT $1, $2, id, $4, $5, to_timestamp($6::double precision / 1000), 1, now(), now()
        FROM leaflogue.books
        WHERE library_id = $1 AND id = $3 AND archived = false AND deleted_at IS NULL
        ON CONFLICT (library_id, id) DO NOTHING
        RETURNING id, book_id, text, source_location,
          extract(epoch FROM source_created_at) * 1000 AS source_created_at_ms,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
      `, [this.#libraryId, id, input.bookId, text, location ?? null, sourceCreatedAt]);
      const row = result.rows[0];
      if (!row) throw new Error(input.id === undefined ? "Book no longer exists" : "Book no longer exists or the highlight ID is taken");
      let noteId: string | undefined;
      if (noteMarkdown) {
        noteId = input.noteId === undefined ? randomUUID() : requiredEntityId(input.noteId, "Note");
        await this.#client.query(`
          INSERT INTO leaflogue.notes
            (library_id, id, book_id, highlight_id, markdown, origin, revision, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, 1, now(), now())
        `, [this.#libraryId, noteId, input.bookId, id, noteMarkdown, input.noteOrigin ?? "reader"]);
      }
      const bookRevision = await this.#touchBook(input.bookId);
      await this.#recordWebChange("book", input.bookId, bookRevision);
      await this.#recordWebChange("highlight", row.id, 1);
      if (noteId) await this.#recordWebChange("note", noteId, 1);
      return mapHighlight(row);
    });
  }

  async updateHighlight(input: UpdateHighlight): Promise<HighlightMutationResult> {
    const text = requiredText(input.text, "Highlight", 100_000);
    const location = optionalText(input.sourceLocation, 2_000);
    requireRevision(input.expectedRevision, "Highlight");
    return this.#transaction(async () => {
      const result = await this.#client.query<HighlightRow>(`
        UPDATE leaflogue.highlights
        SET text = $4, source_location = $5, revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND book_id = $3 AND revision = $6
          AND archived = false AND deleted_at IS NULL
        RETURNING id, book_id, text, source_location,
          extract(epoch FROM source_created_at) * 1000 AS source_created_at_ms,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
      `, [this.#libraryId, input.id, input.bookId, text, location ?? null, input.expectedRevision]);
      const row = result.rows[0];
      if (!row) throw new Error("Highlight changed elsewhere or no longer exists");
      const bookRevision = await this.#touchBook(input.bookId);
      await this.#recordWebChange("book", input.bookId, bookRevision);
      await this.#recordWebChange("highlight", input.id, Number(row.revision));
      return mapHighlight(row);
    });
  }

  async createNote(input: PostgresNewNote): Promise<Note> {
    const id = input.id === undefined ? randomUUID() : requiredEntityId(input.id, "Note");
    const markdown = requiredNote(input.markdown);
    return this.#transaction(async () => {
      if (input.highlightId) {
        const existing = await this.#client.query<{ count: number | string }>(`
          SELECT COUNT(*) AS count FROM leaflogue.notes
          WHERE library_id = $1 AND highlight_id = $2 AND deleted_at IS NULL
        `, [this.#libraryId, input.highlightId]);
        if (Number(existing.rows[0]?.count ?? 0) >= MAX_NOTES_PER_HIGHLIGHT) {
          throw new Error(`A passage can have at most ${MAX_NOTES_PER_HIGHLIGHT} active notes`);
        }
      }
      const result = await this.#client.query<NoteRow>(`
        INSERT INTO leaflogue.notes
          (library_id, id, book_id, highlight_id, markdown, origin, revision, created_at, updated_at)
        SELECT $1, $2, books.id, highlights.id, $5, $6, 1, now(), now()
        FROM leaflogue.books
        LEFT JOIN leaflogue.highlights ON highlights.library_id = books.library_id
          AND highlights.id = $4 AND highlights.book_id = books.id
          AND highlights.archived = false AND highlights.deleted_at IS NULL
        WHERE books.library_id = $1 AND books.id = $3
          AND books.archived = false AND books.deleted_at IS NULL
          AND ($4::uuid IS NULL OR highlights.id IS NOT NULL)
        RETURNING id, book_id, highlight_id, markdown, origin,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
      `, [this.#libraryId, id, input.bookId, input.highlightId ?? null, markdown, input.origin ?? "reader"]);
      const row = result.rows[0];
      if (!row) throw new Error("Book or highlight no longer exists");
      const bookRevision = await this.#touchBook(input.bookId);
      await this.#recordWebChange("book", input.bookId, bookRevision);
      await this.#recordWebChange("note", row.id, 1);
      return mapNote(row);
    });
  }

  async updateNote(input: UpdateNote): Promise<Note> {
    const markdown = requiredNote(input.markdown);
    requireRevision(input.expectedRevision, "Note");
    return this.#transaction(async () => {
      const result = await this.#client.query<NoteRow>(`
        UPDATE leaflogue.notes
        SET markdown = $4, origin = 'reader', revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND book_id = $3 AND revision = $5 AND deleted_at IS NULL
        RETURNING id, book_id, highlight_id, markdown, origin,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
      `, [this.#libraryId, input.id, input.bookId, markdown, input.expectedRevision]);
      const row = result.rows[0];
      if (!row) throw new Error("Note changed elsewhere or no longer exists");
      const bookRevision = await this.#touchBook(input.bookId);
      await this.#recordWebChange("book", input.bookId, bookRevision);
      await this.#recordWebChange("note", input.id, Number(row.revision));
      return mapNote(row);
    });
  }

  async deleteHighlight(input: DeleteHighlight): Promise<AnnotationDeletionReceipt> {
    requireRevision(input.expectedRevision, "Highlight");
    return this.#transaction(async () => {
      const result = await this.#client.query<{ revision: number | string }>(`
        UPDATE leaflogue.highlights
        SET deleted_at = now(), revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND book_id = $3 AND revision = $4
          AND archived = false AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM leaflogue.books WHERE library_id = $1 AND id = $3
            AND archived = false AND deleted_at IS NULL)
        RETURNING revision
      `, [this.#libraryId, input.id, input.bookId, input.expectedRevision]);
      const row = result.rows[0];
      if (!row) throw new Error("Highlight changed elsewhere or no longer exists");
      const revision = Number(row.revision);
      const notes = await this.#client.query<{ id: string; revision: number | string }>(`
        UPDATE leaflogue.notes SET deleted_at = now(), revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND highlight_id = $2 AND deleted_at IS NULL
        RETURNING id, revision
      `, [this.#libraryId, input.id]);
      // Memberships go with the passage, and every container whose contents
      // changed advances, exactly as an explicit removal would.
      const threads = await this.#client.query<{ thread_id: string }>(`
        DELETE FROM leaflogue.thread_highlights WHERE library_id = $1 AND highlight_id = $2 RETURNING thread_id
      `, [this.#libraryId, input.id]);
      const tags = await this.#client.query<{ tag_id: string }>(`
        DELETE FROM leaflogue.highlight_tags WHERE library_id = $1 AND highlight_id = $2 RETURNING tag_id
      `, [this.#libraryId, input.id]);
      const bookRevision = await this.#touchBook(input.bookId);
      await this.#recordWebChange("book", input.bookId, bookRevision);
      await this.#recordWebChange("highlight", input.id, revision);
      for (const note of notes.rows) await this.#recordWebChange("note", note.id, Number(note.revision));
      for (const [table, entityType, ids] of [
        ["threads", "thread", threads.rows.map(({ thread_id: id }) => id)],
        ["tags", "tag", tags.rows.map(({ tag_id: id }) => id)],
      ] as const) {
        if (ids.length === 0) continue;
        const revised = await this.#client.query<{ id: string; revision: number | string }>(`
          UPDATE leaflogue.${table} SET revision = revision + 1, updated_at = now()
          WHERE library_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL
          RETURNING id, revision
        `, [this.#libraryId, ids]);
        for (const row of revised.rows) await this.#recordWebChange(entityType, row.id, Number(row.revision));
      }
      return { bookId: input.bookId, bookRevision, revision, notesDeleted: notes.rows.length, complete: true };
    });
  }

  async deleteNote(input: DeleteNote): Promise<AnnotationDeletionReceipt> {
    requireRevision(input.expectedRevision, "Note");
    return this.#transaction(async () => {
      const result = await this.#client.query<{ revision: number | string }>(`
        UPDATE leaflogue.notes SET deleted_at = now(), revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND book_id = $3 AND revision = $4 AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM leaflogue.books WHERE library_id = $1 AND id = $3
            AND archived = false AND deleted_at IS NULL)
        RETURNING revision
      `, [this.#libraryId, input.id, input.bookId, input.expectedRevision]);
      const row = result.rows[0];
      if (!row) throw new Error("Note changed elsewhere or no longer exists");
      const bookRevision = await this.#touchBook(input.bookId);
      await this.#recordWebChange("book", input.bookId, bookRevision);
      await this.#recordWebChange("note", input.id, Number(row.revision));
      return { bookId: input.bookId, bookRevision, revision: Number(row.revision), notesDeleted: 1, complete: true };
    });
  }

  async setBookArchived(input: SetBookArchived): Promise<BookArchiveChange> {
    requireRevision(input.expectedRevision, "Book");
    return this.#transaction(async () => {
      const result = await this.#client.query<Record<string, unknown>>(`
        UPDATE leaflogue.books
        SET archived = $3, revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND revision = $4 AND archived != $3 AND deleted_at IS NULL
        RETURNING id, archived, revision, extract(epoch FROM updated_at) * 1000 AS updated_at_ms
      `, [this.#libraryId, input.id, input.archived, input.expectedRevision]);
      const row = result.rows[0];
      if (!row) throw new Error("Book changed elsewhere or is already in that shelf");
      const revision = Number(row.revision);
      await this.#recordWebChange("book", input.id, revision);
      return {
        bookId: String(row.id) as BookId,
        archived: row.archived === true,
        revision,
        updatedAt: Number(row.updated_at_ms),
      };
    });
  }

  async setBookReadingStatus(input: SetBookReadingStatus): Promise<BookReadingStatusChange> {
    requireRevision(input.expectedRevision, "Book");
    if (!isReadingStatus(input.status)) throw new Error("Reading status is invalid");
    return this.#transaction(async () => {
      const currentResult = await this.#client.query<BookRow>(`
        SELECT books.id, title, authors, metadata, status, completed_on, archived,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision,
          (SELECT count(*) FROM leaflogue.highlights
           WHERE library_id = books.library_id AND book_id = books.id
             AND archived = false AND deleted_at IS NULL) AS highlight_count
        FROM leaflogue.books AS books
        WHERE library_id = $1 AND id = $2 AND revision = $3
          AND archived = false AND deleted_at IS NULL
      `, [this.#libraryId, input.id, input.expectedRevision]);
      const current = currentResult.rows[0];
      if (!current) throw new Error("Book changed elsewhere or no longer exists");
      if (current.status === input.status) return { changed: false, book: mapBook(current) };

      const changedAt = Date.now();
      const completedOn = input.status === "finished"
        ? new Date(changedAt).toISOString().slice(0, 10)
        : undefined;
      const result = await this.#client.query<BookRow>(`
        UPDATE leaflogue.books
        SET status = $3, completed_on = $4, revision = revision + 1,
          updated_at = to_timestamp($5::double precision / 1000.0)
        WHERE library_id = $1 AND id = $2 AND revision = $6
          AND archived = false AND deleted_at IS NULL
        RETURNING id, title, authors, metadata, status, completed_on, archived,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision,
          0 AS highlight_count
      `, [this.#libraryId, input.id, input.status, completedOn ?? null, changedAt, input.expectedRevision]);
      const row = result.rows[0];
      if (!row) throw new Error("Book changed elsewhere or no longer exists");
      const revision = Number(row.revision);
      const eventId = randomUUID();
      await this.#requireStatusHistoryCapacity([input.id], 1);
      await this.#client.query(`
        INSERT INTO leaflogue.reading_status_events
          (library_id, id, book_id, status, source, changed_at, completed_on, book_revision)
        VALUES ($1, $2, $3, $4, 'reader', to_timestamp($5::double precision / 1000.0), $6, $7)
      `, [this.#libraryId, eventId, input.id, input.status, changedAt, completedOn ?? null, revision]);
      await this.#recordWebChange("book", input.id, revision);
      return {
        changed: true,
        book: { ...mapBook(row), highlightCount: Number(current.highlight_count ?? 0) },
        event: {
          id: eventId as ReadingStatusEventId,
          bookId: input.id,
          status: input.status,
          source: "reader",
          changedAt,
          ...(completedOn ? { completedOn } : {}),
          bookRevision: revision,
        },
      };
    });
  }

  async setBookCompletionDate(input: SetBookCompletionDate): Promise<Book> {
    requireRevision(input.expectedRevision, "Book");
    const completedOn = validateCompletionDate(input.completedOn);
    return this.#transaction(async () => {
      const result = await this.#client.query<BookRow>(`
        UPDATE leaflogue.books
        SET completed_on = $3, revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND revision = $4
          AND status = 'finished' AND archived = false AND deleted_at IS NULL
          AND completed_on IS DISTINCT FROM $3
        RETURNING id, title, authors, metadata, status, completed_on, archived,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision,
          (SELECT count(*) FROM leaflogue.highlights
           WHERE library_id = books.library_id AND book_id = books.id
             AND archived = false AND deleted_at IS NULL) AS highlight_count
      `, [this.#libraryId, input.id, completedOn ?? null, input.expectedRevision]);
      const row = result.rows[0];
      if (!row) {
        const current = await this.#client.query<BookRow>(`
          SELECT id, title, authors, metadata, status, completed_on, archived,
            extract(epoch FROM created_at) * 1000 AS created_at_ms,
            extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision,
            (SELECT count(*) FROM leaflogue.highlights
             WHERE library_id = books.library_id AND book_id = books.id
               AND archived = false AND deleted_at IS NULL) AS highlight_count
          FROM leaflogue.books AS books
          WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL
        `, [this.#libraryId, input.id]);
        const existing = current.rows[0];
        if (!existing || existing.archived || Number(existing.revision) !== input.expectedRevision) {
          throw new Error("Book changed elsewhere or no longer exists");
        }
        if (existing.status !== "finished") throw new Error("Set the book to Finished before adding a completion date");
        if ((existing.completed_on ?? undefined) === completedOn) return mapBook(existing);
        throw new Error("Book changed elsewhere or no longer exists");
      }
      await this.#recordWebChange("book", input.id, Number(row.revision));
      return mapBook(row);
    });
  }

  async createCollection(input: CreateCollection): Promise<Collection> {
    const id = requiredId(input.id);
    const name = organizationName(input.name, "Collection", 120);
    const description = organizationOptionalText(input.description, "Collection description", 2_000);
    return this.#transaction(async () => {
      const result = await this.#client.query<CollectionRow>(`
        INSERT INTO leaflogue.collections
          (library_id, id, name, normalized_name, description, revision, created_at, updated_at)
        SELECT $1, $2, $3, $4, $5, 1, now(), now()
        WHERE NOT EXISTS (
          SELECT 1 FROM leaflogue.collections
          WHERE library_id = $1 AND normalized_name = $4 AND deleted_at IS NULL
        )
        ON CONFLICT (library_id, id) DO NOTHING
        RETURNING id, name, description, 0 AS book_count,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
      `, [this.#libraryId, id, name, normalizeOrganizationName(name), description ?? null]);
      const collection = result.rows[0] ? mapCollection(result.rows[0]) : await this.#getCollection(id as CollectionId);
      if (!collection || collection.name !== name || collection.description !== description) {
        throw new Error("Entity ID already exists with different collection data");
      }
      if (result.rows[0]) await this.#recordWebChange("collection", id, collection.revision);
      return collection;
    });
  }

  async updateCollection(input: UpdateCollection): Promise<Collection> {
    requireRevision(input.expectedRevision, "Collection");
    const name = organizationName(input.name, "Collection", 120);
    const description = organizationOptionalText(input.description, "Collection description", 2_000);
    return this.#transaction(async () => {
      const result = await this.#client.query(`
        UPDATE leaflogue.collections
        SET name = $3, normalized_name = $4, description = $5, revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND revision = $6 AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM leaflogue.collections AS duplicate
            WHERE duplicate.library_id = $1 AND duplicate.normalized_name = $4
              AND duplicate.id <> $2 AND duplicate.deleted_at IS NULL
          )
        RETURNING id, revision
      `, [this.#libraryId, input.id, name, normalizeOrganizationName(name), description ?? null, input.expectedRevision]);
      if (!result.rows[0]) throw new Error("Collection changed elsewhere or no longer exists");
      await this.#recordWebChange("collection", input.id, Number(result.rows[0].revision));
      return (await this.#getCollection(input.id))!;
    });
  }

  async deleteCollection(input: DeleteCollection): Promise<void> {
    requireRevision(input.expectedRevision, "Collection");
    await this.#transaction(async () => {
      const deleted = await this.#client.query(`
        UPDATE leaflogue.collections SET deleted_at = now(), updated_at = now(), revision = revision + 1
        WHERE library_id = $1 AND id = $2 AND revision = $3 AND deleted_at IS NULL RETURNING id, revision
      `, [this.#libraryId, input.id, input.expectedRevision]);
      if (!deleted.rows[0]) throw new Error("Collection changed elsewhere or no longer exists");
      await this.#recordWebChange("collection", input.id, Number(deleted.rows[0].revision));
      await this.#touchOrganizationBooks(`SELECT book_id FROM leaflogue.collection_books WHERE library_id = $1 AND collection_id = $2`, input.id);
      await this.#client.query("DELETE FROM leaflogue.collection_books WHERE library_id = $1 AND collection_id = $2", [this.#libraryId, input.id]);
    });
  }

  async createTag(input: CreateTag): Promise<Tag> {
    const id = requiredId(input.id);
    const name = organizationName(input.name, "Tag", 80);
    const color = organizationOptionalText(input.color, "Tag color", 32);
    return this.#transaction(async () => {
      const result = await this.#client.query<TagRow>(`
        INSERT INTO leaflogue.tags
          (library_id, id, name, normalized_name, color, revision, created_at, updated_at)
        SELECT $1, $2, $3, $4, $5, 1, now(), now()
        WHERE NOT EXISTS (
          SELECT 1 FROM leaflogue.tags
          WHERE library_id = $1 AND normalized_name = $4 AND deleted_at IS NULL
        )
        ON CONFLICT (library_id, id) DO NOTHING
        RETURNING id, name, color, 0 AS book_count, 0 AS highlight_count,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
      `, [this.#libraryId, id, name, normalizeOrganizationName(name), color ?? null]);
      const tag = result.rows[0] ? mapTag(result.rows[0]) : await this.#getTag(id as TagId);
      if (!tag || tag.name !== name || tag.color !== color) throw new Error("Entity ID already exists with different tag data");
      if (result.rows[0]) await this.#recordWebChange("tag", id, tag.revision);
      return tag;
    });
  }

  async updateTag(input: UpdateTag): Promise<Tag> {
    requireRevision(input.expectedRevision, "Tag");
    const name = organizationName(input.name, "Tag", 80);
    const color = organizationOptionalText(input.color, "Tag color", 32);
    return this.#transaction(async () => {
      const result = await this.#client.query(`
        UPDATE leaflogue.tags
        SET name = $3, normalized_name = $4, color = $5, revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND revision = $6 AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM leaflogue.tags AS duplicate
            WHERE duplicate.library_id = $1 AND duplicate.normalized_name = $4
              AND duplicate.id <> $2 AND duplicate.deleted_at IS NULL
          )
        RETURNING id, revision
      `, [this.#libraryId, input.id, name, normalizeOrganizationName(name), color ?? null, input.expectedRevision]);
      if (!result.rows[0]) throw new Error("Tag changed elsewhere or no longer exists");
      await this.#recordWebChange("tag", input.id, Number(result.rows[0].revision));
      return (await this.#getTag(input.id))!;
    });
  }

  async deleteTag(input: DeleteTag): Promise<void> {
    requireRevision(input.expectedRevision, "Tag");
    await this.#transaction(async () => {
      const deleted = await this.#client.query(`
        UPDATE leaflogue.tags SET deleted_at = now(), updated_at = now(), revision = revision + 1
        WHERE library_id = $1 AND id = $2 AND revision = $3 AND deleted_at IS NULL RETURNING id, revision
      `, [this.#libraryId, input.id, input.expectedRevision]);
      if (!deleted.rows[0]) throw new Error("Tag changed elsewhere or no longer exists");
      await this.#recordWebChange("tag", input.id, Number(deleted.rows[0].revision));
      await this.#touchOrganizationBooks(`
        SELECT book_id FROM leaflogue.book_tags WHERE library_id = $1 AND tag_id = $2
        UNION SELECT highlights.book_id FROM leaflogue.highlight_tags
          JOIN leaflogue.highlights ON highlights.library_id = highlight_tags.library_id AND highlights.id = highlight_tags.highlight_id
          WHERE highlight_tags.library_id = $1 AND highlight_tags.tag_id = $2
      `, input.id);
      const highlights = await this.#client.query<{ highlight_id: string }>(`
        SELECT highlight_id FROM leaflogue.highlight_tags
        WHERE library_id = $1 AND tag_id = $2
      `, [this.#libraryId, input.id]);
      for (const row of highlights.rows) {
        const revised = await this.#client.query<{ revision: number | string }>(`
          UPDATE leaflogue.highlights SET revision = revision + 1, updated_at = now()
          WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING revision
        `, [this.#libraryId, row.highlight_id]);
        if (revised.rows[0]) await this.#recordWebChange("highlight", row.highlight_id, Number(revised.rows[0].revision));
      }
      await this.#client.query("DELETE FROM leaflogue.book_tags WHERE library_id = $1 AND tag_id = $2", [this.#libraryId, input.id]);
      await this.#client.query("DELETE FROM leaflogue.highlight_tags WHERE library_id = $1 AND tag_id = $2", [this.#libraryId, input.id]);
    });
  }

  async setBookCollectionMembership(input: SetBookCollectionMembership): Promise<OrganizationMembershipReceipt> {
    return this.#setMembership("collection", input.bookId, input.collectionId, input.included);
  }

  async setBookTagMembership(input: SetBookTagMembership): Promise<OrganizationMembershipReceipt> {
    return this.#setMembership("book-tag", input.bookId, input.tagId, input.included);
  }

  async setHighlightTagMembership(input: SetHighlightTagMembership): Promise<OrganizationMembershipReceipt> {
    return this.#setMembership("highlight-tag", input.bookId, input.tagId, input.included, input.highlightId);
  }

  async createThread(input: CreateThread): Promise<Thread> {
    const id = requiredId(input.id);
    const name = organizationName(input.name, "Thread", 120);
    const description = organizationOptionalText(input.description, "Thread description", 1_000);
    return this.#transaction(async () => {
      const existing = await this.#getThread(id as ThreadId);
      if (existing) {
        if (existing.name !== name || existing.description !== description) {
          throw new Error("Entity ID already exists with different thread data");
        }
        return existing;
      }
      const count = await this.#client.query<{ count: number | string }>(`
        SELECT count(*) AS count FROM leaflogue.threads
        WHERE library_id = $1 AND deleted_at IS NULL
      `, [this.#libraryId]);
      if (Number(count.rows[0]?.count ?? 0) >= 100) throw new Error("At most 100 threads are allowed");
      const result = await this.#client.query<ThreadRow>(`
        INSERT INTO leaflogue.threads
          (library_id, id, name, normalized_name, description, revision, created_at, updated_at)
        SELECT $1, $2, $3, $4, $5, 1, now(), now()
        WHERE NOT EXISTS (
          SELECT 1 FROM leaflogue.threads
          WHERE library_id = $1 AND normalized_name = $4 AND deleted_at IS NULL
        )
        ON CONFLICT (library_id, id) DO NOTHING
        RETURNING id, name, description, 0 AS passage_count,
          extract(epoch FROM created_at) * 1000 AS created_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
      `, [this.#libraryId, id, name, normalizeOrganizationName(name), description ?? null]);
      const thread = result.rows[0] ? mapThread(result.rows[0]) : undefined;
      if (!thread) throw new Error("Thread name is already in use");
      await this.#recordWebChange("thread", id, thread.revision);
      return thread;
    });
  }

  async updateThread(input: UpdateThread): Promise<Thread> {
    requireRevision(input.expectedRevision, "Thread");
    const name = organizationName(input.name, "Thread", 120);
    const description = organizationOptionalText(input.description, "Thread description", 1_000);
    return this.#transaction(async () => {
      const result = await this.#client.query<{ revision: number | string }>(`
        UPDATE leaflogue.threads
        SET name = $3, normalized_name = $4, description = $5,
          revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND revision = $6 AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM leaflogue.threads AS duplicate
            WHERE duplicate.library_id = $1 AND duplicate.normalized_name = $4
              AND duplicate.id <> $2 AND duplicate.deleted_at IS NULL
          )
        RETURNING revision
      `, [this.#libraryId, input.id, name, normalizeOrganizationName(name), description ?? null, input.expectedRevision]);
      const row = result.rows[0];
      if (!row) throw new Error("Thread changed elsewhere or no longer exists");
      await this.#recordWebChange("thread", input.id, Number(row.revision));
      return (await this.#getThread(input.id))!;
    });
  }

  async deleteThread(input: DeleteThread): Promise<void> {
    requireRevision(input.expectedRevision, "Thread");
    await this.#transaction(async () => {
      const result = await this.#client.query<{ revision: number | string }>(`
        UPDATE leaflogue.threads
        SET deleted_at = now(), revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND revision = $3 AND deleted_at IS NULL
        RETURNING revision
      `, [this.#libraryId, input.id, input.expectedRevision]);
      const row = result.rows[0];
      if (!row) throw new Error("Thread changed elsewhere or no longer exists");
      await this.#client.query(
        "DELETE FROM leaflogue.thread_highlights WHERE library_id = $1 AND thread_id = $2",
        [this.#libraryId, input.id],
      );
      await this.#recordWebChange("thread", input.id, Number(row.revision));
    });
  }

  async setHighlightThreadMembership(input: SetHighlightThreadMembership): Promise<ThreadMembershipReceipt> {
    requireRevision(input.expectedHighlightRevision, "Highlight");
    const requested = [...new Set(input.threadIds.map(requiredId))];
    if (requested.length > 20) throw new Error("A passage can belong to at most 20 threads");
    return this.#transaction(async () => {
      const highlightResult = await this.#client.query<{ revision: number | string }>(`
        SELECT highlights.revision FROM leaflogue.highlights
        JOIN leaflogue.books ON books.library_id = highlights.library_id AND books.id = highlights.book_id
        WHERE highlights.library_id = $1 AND highlights.id = $2 AND highlights.book_id = $3
          AND highlights.revision = $4 AND highlights.archived = false AND highlights.deleted_at IS NULL
          AND books.archived = false AND books.deleted_at IS NULL
      `, [this.#libraryId, input.highlightId, input.bookId, input.expectedHighlightRevision]);
      if (!highlightResult.rows[0]) throw new Error("Highlight changed elsewhere or no longer exists");
      const validThreads = requested.length === 0 ? { rows: [] } : await this.#client.query<{ id: string }>(`
        SELECT id FROM leaflogue.threads
        WHERE library_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL
      `, [this.#libraryId, requested]);
      if (validThreads.rows.length !== requested.length) throw new Error("Thread no longer exists");
      const existingResult = await this.#client.query<{ thread_id: string }>(`
        SELECT thread_id FROM leaflogue.thread_highlights
        WHERE library_id = $1 AND highlight_id = $2
        ORDER BY thread_id LIMIT 21
      `, [this.#libraryId, input.highlightId]);
      if (existingResult.rows.length > 20) throw new Error("Highlight belongs to too many threads");
      const wanted = new Set(requested);
      const existing = new Set(existingResult.rows.map((row) => row.thread_id));
      const removed = [...existing].filter((id) => !wanted.has(id));
      const added = requested.filter((id) => !existing.has(id));
      for (const threadId of added) {
        const count = await this.#client.query<{ count: number | string }>(`
          SELECT count(*) AS count FROM leaflogue.thread_highlights
          WHERE library_id = $1 AND thread_id = $2
        `, [this.#libraryId, threadId]);
        if (Number(count.rows[0]?.count ?? 0) >= 500) throw new Error("A thread can contain at most 500 passages");
      }
      const changed = removed.length > 0 || added.length > 0;
      let highlightRevision = input.expectedHighlightRevision;
      if (changed) {
        if (removed.length > 0) await this.#client.query(`
          DELETE FROM leaflogue.thread_highlights
          WHERE library_id = $1 AND highlight_id = $2 AND thread_id = ANY($3::uuid[])
        `, [this.#libraryId, input.highlightId, removed]);
        for (const threadId of added) {
          await this.#client.query(`
            INSERT INTO leaflogue.thread_highlights (library_id, thread_id, highlight_id)
            VALUES ($1, $2, $3)
          `, [this.#libraryId, threadId, input.highlightId]);
        }
        for (const threadId of new Set([...removed, ...added])) {
          const revised = await this.#client.query<{ revision: number | string }>(`
            UPDATE leaflogue.threads SET revision = revision + 1, updated_at = now()
            WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING revision
          `, [this.#libraryId, threadId]);
          if (!revised.rows[0]) throw new Error("Thread no longer exists");
          await this.#recordWebChange("thread", threadId, Number(revised.rows[0].revision));
        }
        const highlight = await this.#client.query<{ revision: number | string }>(`
          UPDATE leaflogue.highlights SET revision = revision + 1, updated_at = now()
          WHERE library_id = $1 AND id = $2 AND book_id = $3 AND revision = $4
            AND archived = false AND deleted_at IS NULL RETURNING revision
        `, [this.#libraryId, input.highlightId, input.bookId, input.expectedHighlightRevision]);
        if (!highlight.rows[0]) throw new Error("Highlight changed elsewhere or no longer exists");
        highlightRevision = Number(highlight.rows[0].revision);
        await this.#recordWebChange("highlight", input.highlightId, highlightRevision);
      }
      const memberships = await this.#client.query<{ id: string }>(`
        SELECT threads.id FROM leaflogue.thread_highlights
        JOIN leaflogue.threads ON threads.library_id = thread_highlights.library_id
          AND threads.id = thread_highlights.thread_id
        WHERE thread_highlights.library_id = $1 AND thread_highlights.highlight_id = $2
          AND threads.deleted_at IS NULL
        ORDER BY threads.normalized_name, threads.id LIMIT 21
      `, [this.#libraryId, input.highlightId]);
      if (memberships.rows.length > 20) throw new Error("Highlight belongs to too many threads");
      return {
        changed,
        bookId: input.bookId,
        highlightId: input.highlightId,
        highlightRevision,
        threadIds: memberships.rows.map((row) => row.id as ThreadId),
      };
    });
  }

  async ensureDailySelection(input: EnsureDailySelection): Promise<DailySelection> {
    const requestedId = requiredId(input.id);
    const now = Date.now();
    const { localDay, timezone } = resolveLocalDay(input.timezone, now);
    return this.#transaction(async () => {
      const candidateResult = await this.#client.query<{ id: string; book_id: string }>(`
        SELECT highlights.id, highlights.book_id
        FROM leaflogue.highlights
        JOIN leaflogue.books ON books.library_id = highlights.library_id AND books.id = highlights.book_id
        WHERE highlights.library_id = $1 AND highlights.archived = false AND highlights.deleted_at IS NULL
          AND length(trim(highlights.text)) > 0
          AND books.archived = false AND books.deleted_at IS NULL
        ORDER BY highlights.book_id, highlights.id LIMIT 10001
      `, [this.#libraryId]);
      if (candidateResult.rows.length > 10_000 ||
          new Set(candidateResult.rows.map((row) => row.book_id)).size > 500) {
        throw new Error("Library is too large for daily selection");
      }
      const candidates = candidateResult.rows.map((row) => ({
        id: row.id as HighlightId,
        bookId: row.book_id as BookId,
      }));
      const candidateDigest = createHash("sha256")
        .update(JSON.stringify(candidates.map(({ id, bookId }) => [id, bookId])))
        .digest("hex");
      const existingResult = await this.#client.query<DailySelectionRow>(`
        SELECT id, local_day::text, timezone, highlight_id, candidate_digest, recent_highlight_ids,
          extract(epoch FROM selected_at) * 1000 AS selected_at_ms,
          extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
        FROM leaflogue.daily_selections
        WHERE library_id = $1 AND local_day = $2::date AND timezone = $3
        FOR UPDATE
      `, [this.#libraryId, localDay, timezone]);
      const existing = existingResult.rows[0] ? mapDailySelection(existingResult.rows[0]) : undefined;
      const currentIsEligible = existing?.highlightId !== undefined &&
        candidates.some((candidate) => candidate.id === existing.highlightId);
      const hasAlternative = existing?.highlightId !== undefined &&
        candidates.some((candidate) => candidate.id !== existing.highlightId);
      const emptySelectionIsCurrent = existing !== undefined && existing.highlightId === undefined &&
        candidates.length === 0 && existing.candidateDigest === candidateDigest;
      if (existing && (emptySelectionIsCurrent || (currentIsEligible && (!input.another || !hasAlternative)))) return existing;

      let previous = existing;
      if (!previous) {
        const previousResult = await this.#client.query<DailySelectionRow>(`
          SELECT id, local_day::text, timezone, highlight_id, candidate_digest, recent_highlight_ids,
            extract(epoch FROM selected_at) * 1000 AS selected_at_ms,
            extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
          FROM leaflogue.daily_selections
          WHERE library_id = $1 AND timezone = $2
          ORDER BY local_day DESC LIMIT 1
        `, [this.#libraryId, timezone]);
        previous = previousResult.rows[0] ? mapDailySelection(previousResult.rows[0]) : undefined;
      }
      const recent = previous?.recentHighlightIds ?? [];
      const revision = (existing?.revision ?? 0) + 1;
      const selectedId = chooseDailyHighlightId(candidates, recent, existing?.highlightId, {
        localDay,
        timezone,
        candidateDigest,
        revision,
      });
      const nextRecent = selectedId
        ? [...recent.filter((id) => id !== selectedId), selectedId].slice(-7)
        : recent.slice(-7);
      let result: { readonly rows: readonly DailySelectionRow[] };
      if (existing) {
        result = await this.#client.query<DailySelectionRow>(`
          UPDATE leaflogue.daily_selections
          SET highlight_id = $4, candidate_digest = $5, recent_highlight_ids = $6::jsonb,
            selected_at = to_timestamp($7::double precision / 1000.0),
            updated_at = to_timestamp($7::double precision / 1000.0), revision = revision + 1
          WHERE library_id = $1 AND local_day = $2::date AND timezone = $3 AND revision = $8
          RETURNING id, local_day::text, timezone, highlight_id, candidate_digest, recent_highlight_ids,
            extract(epoch FROM selected_at) * 1000 AS selected_at_ms,
            extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
        `, [this.#libraryId, localDay, timezone, selectedId ?? null, candidateDigest, JSON.stringify(nextRecent), now, existing.revision]);
      } else {
        result = await this.#client.query<DailySelectionRow>(`
          INSERT INTO leaflogue.daily_selections
            (library_id, id, local_day, timezone, highlight_id, candidate_digest,
             recent_highlight_ids, selected_at, updated_at, revision, created_at)
          VALUES ($1, $2, $3::date, $4, $5, $6, $7::jsonb,
            to_timestamp($8::double precision / 1000.0), to_timestamp($8::double precision / 1000.0), 1,
            to_timestamp($8::double precision / 1000.0))
          RETURNING id, local_day::text, timezone, highlight_id, candidate_digest, recent_highlight_ids,
            extract(epoch FROM selected_at) * 1000 AS selected_at_ms,
            extract(epoch FROM updated_at) * 1000 AS updated_at_ms, revision
        `, [this.#libraryId, requestedId, localDay, timezone, selectedId ?? null, candidateDigest, JSON.stringify(nextRecent), now]);
      }
      const row = result.rows[0];
      if (!row) throw new Error("Daily selection changed elsewhere");
      const selection = mapDailySelection(row);
      await this.#recordWebChange("daily-selection", selection.id, selection.revision);
      return selection;
    });
  }

  async mergeBooks(input: MergeBooks): Promise<MergeBooksReceipt> {
    if (input.sourceBookId === input.targetBookId) throw new Error("Choose two different books");
    requireRevision(input.expectedSourceRevision, "Source book");
    requireRevision(input.expectedTargetRevision, "Target book");
    return this.#transaction(async () => {
      for (const [table, containerColumn, label] of [
        ["collection_books", "collection_id", "collections"],
        ["book_tags", "tag_id", "tags"],
      ] as const) {
        const union = await this.#client.query<{ merged_membership_count: number | string }>(`
          SELECT count(DISTINCT ${containerColumn}) AS merged_membership_count
          FROM leaflogue.${table}
          WHERE library_id = $1 AND book_id IN ($2, $3)
        `, [this.#libraryId, input.sourceBookId, input.targetBookId]);
        if (Number(union.rows[0]?.merged_membership_count ?? 0) > MAX_SYNC_ORGANIZATION_MEMBERSHIPS) {
          throw new Error(`A merged book can belong to at most ${MAX_SYNC_ORGANIZATION_MEMBERSHIPS} ${label}`);
        }
      }
      const targetResult = await this.#client.query<Record<string, unknown>>(`
        UPDATE leaflogue.books SET revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND revision = $3 AND archived = false AND deleted_at IS NULL
        RETURNING status, completed_on, revision
      `, [this.#libraryId, input.targetBookId, input.expectedTargetRevision]);
      const target = targetResult.rows[0];
      if (!target) throw new Error("Target book changed or no longer exists");

      const sourceResult = await this.#client.query<Record<string, unknown>>(`
        UPDATE leaflogue.books SET archived = true, revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND revision = $3 AND archived = false AND deleted_at IS NULL
        RETURNING revision
      `, [this.#libraryId, input.sourceBookId, input.expectedSourceRevision]);
      const source = sourceResult.rows[0];
      if (!source) throw new Error("Source book changed or no longer exists");

      const affectedCollections = await this.#client.query<{ id: string }>(
        "SELECT collection_id AS id FROM leaflogue.collection_books WHERE library_id = $1 AND book_id = $2",
        [this.#libraryId, input.sourceBookId],
      );
      const affectedTags = await this.#client.query<{ id: string }>(
        "SELECT tag_id AS id FROM leaflogue.book_tags WHERE library_id = $1 AND book_id = $2",
        [this.#libraryId, input.sourceBookId],
      );

      const highlightResult = await this.#client.query<{ id: string; revision: number | string }>(`
        UPDATE leaflogue.highlights
        SET book_id = $3, revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND book_id = $2
        RETURNING id, revision
      `, [this.#libraryId, input.sourceBookId, input.targetBookId]);
      const noteResult = await this.#client.query<{ id: string; revision: number | string }>(`
        UPDATE leaflogue.notes
        SET book_id = $3, revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND book_id = $2
        RETURNING id, revision
      `, [this.#libraryId, input.sourceBookId, input.targetBookId]);

      await this.#requireStatusHistoryCapacity([input.sourceBookId, input.targetBookId], 1);
      await this.#client.query(`
        UPDATE leaflogue.reading_status_events SET book_id = $3
        WHERE library_id = $1 AND book_id = $2
      `, [this.#libraryId, input.sourceBookId, input.targetBookId]);
      await this.#client.query(`
        INSERT INTO leaflogue.reading_status_events
          (library_id, id, book_id, status, source, changed_at, completed_on, book_revision)
        SELECT $1, $4, $3, $5, 'merge', now(), $6, $7
        WHERE EXISTS (
          SELECT 1 FROM leaflogue.reading_status_events
          WHERE library_id = $1 AND book_id = $3
        )
      `, [
        this.#libraryId,
        input.sourceBookId,
        input.targetBookId,
        randomUUID(),
        target.status,
        target.completed_on ?? null,
        Number(target.revision),
      ]);

      await this.#client.query(`
        INSERT INTO leaflogue.collection_books (library_id, collection_id, book_id, created_at)
        SELECT library_id, collection_id, $3, created_at FROM leaflogue.collection_books
        WHERE library_id = $1 AND book_id = $2 ON CONFLICT DO NOTHING
      `, [this.#libraryId, input.sourceBookId, input.targetBookId]);
      await this.#client.query("DELETE FROM leaflogue.collection_books WHERE library_id = $1 AND book_id = $2", [this.#libraryId, input.sourceBookId]);
      await this.#client.query(`
        INSERT INTO leaflogue.book_tags (library_id, tag_id, book_id, created_at)
        SELECT library_id, tag_id, $3, created_at FROM leaflogue.book_tags
        WHERE library_id = $1 AND book_id = $2 ON CONFLICT DO NOTHING
      `, [this.#libraryId, input.sourceBookId, input.targetBookId]);
      await this.#client.query("DELETE FROM leaflogue.book_tags WHERE library_id = $1 AND book_id = $2", [this.#libraryId, input.sourceBookId]);
      for (const { id } of affectedCollections.rows) {
        const revised = await this.#client.query<{ revision: number | string }>("UPDATE leaflogue.collections SET revision = revision + 1, updated_at = now() WHERE library_id = $1 AND id = $2 RETURNING revision", [this.#libraryId, id]);
        if (revised.rows[0]) await this.#recordWebChange("collection", id, Number(revised.rows[0].revision));
      }
      for (const { id } of affectedTags.rows) {
        const revised = await this.#client.query<{ revision: number | string }>("UPDATE leaflogue.tags SET revision = revision + 1, updated_at = now() WHERE library_id = $1 AND id = $2 RETURNING revision", [this.#libraryId, id]);
        if (revised.rows[0]) await this.#recordWebChange("tag", id, Number(revised.rows[0].revision));
      }

      await this.#recordWebChange("book", input.targetBookId, Number(target.revision));
      await this.#recordWebChange("book", input.sourceBookId, Number(source.revision));
      for (const row of highlightResult.rows) await this.#recordWebChange("highlight", row.id, Number(row.revision));
      for (const row of noteResult.rows) await this.#recordWebChange("note", row.id, Number(row.revision));
      return {
        sourceBookId: input.sourceBookId,
        targetBookId: input.targetBookId,
        highlightsMoved: highlightResult.rows.length,
        notesMoved: noteResult.rows.length,
        sourceRevision: Number(source.revision),
        targetRevision: Number(target.revision),
      };
    });
  }

  async #getCollection(id: CollectionId): Promise<Collection | undefined> {
    const result = await this.#client.query<CollectionRow>(`
      SELECT collections.id, collections.name, collections.description,
        (SELECT count(*) FROM leaflogue.collection_books WHERE library_id = collections.library_id AND collection_id = collections.id) AS book_count,
        extract(epoch FROM collections.created_at) * 1000 AS created_at_ms,
        extract(epoch FROM collections.updated_at) * 1000 AS updated_at_ms, collections.revision
      FROM leaflogue.collections AS collections
      WHERE collections.library_id = $1 AND collections.id = $2 AND collections.deleted_at IS NULL
    `, [this.#libraryId, id]);
    return result.rows[0] ? mapCollection(result.rows[0]) : undefined;
  }

  async #getTag(id: TagId): Promise<Tag | undefined> {
    const result = await this.#client.query<TagRow>(`
      SELECT tags.id, tags.name, tags.color,
        (SELECT count(*) FROM leaflogue.book_tags WHERE library_id = tags.library_id AND tag_id = tags.id) AS book_count,
        (SELECT count(*) FROM leaflogue.highlight_tags WHERE library_id = tags.library_id AND tag_id = tags.id) AS highlight_count,
        extract(epoch FROM tags.created_at) * 1000 AS created_at_ms,
        extract(epoch FROM tags.updated_at) * 1000 AS updated_at_ms, tags.revision
      FROM leaflogue.tags AS tags
      WHERE tags.library_id = $1 AND tags.id = $2 AND tags.deleted_at IS NULL
    `, [this.#libraryId, id]);
    return result.rows[0] ? mapTag(result.rows[0]) : undefined;
  }

  async #getThread(id: ThreadId): Promise<Thread | undefined> {
    const result = await this.#client.query<ThreadRow>(`
      SELECT threads.id, threads.name, threads.description,
        (SELECT count(*) FROM leaflogue.thread_highlights
         JOIN leaflogue.highlights ON highlights.library_id = thread_highlights.library_id
           AND highlights.id = thread_highlights.highlight_id
         JOIN leaflogue.books ON books.library_id = highlights.library_id AND books.id = highlights.book_id
         WHERE thread_highlights.library_id = threads.library_id AND thread_highlights.thread_id = threads.id
           AND highlights.archived = false AND highlights.deleted_at IS NULL
           AND books.archived = false AND books.deleted_at IS NULL) AS passage_count,
        extract(epoch FROM threads.created_at) * 1000 AS created_at_ms,
        extract(epoch FROM threads.updated_at) * 1000 AS updated_at_ms, threads.revision
      FROM leaflogue.threads AS threads
      WHERE threads.library_id = $1 AND threads.id = $2 AND threads.deleted_at IS NULL
    `, [this.#libraryId, id]);
    return result.rows[0] ? mapThread(result.rows[0]) : undefined;
  }

  async #setMembership(
    kind: "collection" | "book-tag" | "highlight-tag",
    bookId: BookId,
    containerId: CollectionId | TagId,
    included: boolean,
    highlightId?: HighlightId,
  ): Promise<OrganizationMembershipReceipt> {
    return this.#transaction(async () => {
      const bookResult = await this.#client.query<{ revision: number | string }>(`
        SELECT revision FROM leaflogue.books
        WHERE library_id = $1 AND id = $2 AND archived = false AND deleted_at IS NULL
      `, [this.#libraryId, bookId]);
      const book = bookResult.rows[0];
      if (!book) throw new Error("Book no longer exists");
      if (kind === "highlight-tag") {
        const highlight = await this.#client.query(`
          SELECT id FROM leaflogue.highlights
          WHERE library_id = $1 AND id = $2 AND book_id = $3 AND archived = false AND deleted_at IS NULL
        `, [this.#libraryId, highlightId, bookId]);
        if (!highlight.rows[0]) throw new Error("Highlight no longer exists");
      }
      const table = kind === "collection" ? "collections" : "tags";
      const container = await this.#client.query<{ revision: number | string }>(`
        SELECT revision FROM leaflogue.${table}
        WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL
      `, [this.#libraryId, containerId]);
      if (!container.rows[0]) throw new Error(`${kind === "collection" ? "Collection" : "Tag"} no longer exists`);
      if (included) await this.#requireMembershipCapacity(kind, bookId, containerId, highlightId);

      let membership: { readonly rows: readonly Record<string, unknown>[] };
      if (kind === "collection") {
        membership = included
          ? await this.#client.query(`INSERT INTO leaflogue.collection_books (library_id, collection_id, book_id)
              VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING book_id`, [this.#libraryId, containerId, bookId])
          : await this.#client.query("DELETE FROM leaflogue.collection_books WHERE library_id = $1 AND collection_id = $2 AND book_id = $3 RETURNING book_id", [this.#libraryId, containerId, bookId]);
      } else if (kind === "book-tag") {
        membership = included
          ? await this.#client.query(`INSERT INTO leaflogue.book_tags (library_id, tag_id, book_id)
              VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING book_id`, [this.#libraryId, containerId, bookId])
          : await this.#client.query("DELETE FROM leaflogue.book_tags WHERE library_id = $1 AND tag_id = $2 AND book_id = $3 RETURNING book_id", [this.#libraryId, containerId, bookId]);
      } else {
        membership = included
          ? await this.#client.query(`INSERT INTO leaflogue.highlight_tags (library_id, tag_id, highlight_id)
              VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING highlight_id`, [this.#libraryId, containerId, highlightId])
          : await this.#client.query("DELETE FROM leaflogue.highlight_tags WHERE library_id = $1 AND tag_id = $2 AND highlight_id = $3 RETURNING highlight_id", [this.#libraryId, containerId, highlightId]);
      }
      const changed = membership.rows.length === 1;
      let bookRevision = Number(book.revision);
      let containerRevision = Number(container.rows[0].revision);
      if (changed) {
        const revisedContainer = await this.#client.query<{ revision: number | string }>(`
          UPDATE leaflogue.${table} SET revision = revision + 1, updated_at = now()
          WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING revision
        `, [this.#libraryId, containerId]);
        if (!revisedContainer.rows[0]) throw new Error(`${kind === "collection" ? "Collection" : "Tag"} no longer exists`);
        containerRevision = Number(revisedContainer.rows[0].revision);
        if (kind === "highlight-tag" && highlightId) {
          const revisedHighlight = await this.#client.query<{ revision: number | string }>(`
            UPDATE leaflogue.highlights SET revision = revision + 1, updated_at = now()
            WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING revision
          `, [this.#libraryId, highlightId]);
          if (!revisedHighlight.rows[0]) throw new Error("Highlight no longer exists");
          await this.#recordWebChange("highlight", highlightId, Number(revisedHighlight.rows[0].revision));
        }
        bookRevision = await this.#touchBook(bookId);
        await this.#recordWebChange("book", bookId, bookRevision);
        await this.#recordWebChange(kind === "collection" ? "collection" : "tag", containerId, containerRevision);
      }
      return { changed, included, bookId, bookRevision, containerId, containerRevision, ...(highlightId ? { highlightId } : {}) };
    });
  }

  async #requireMembershipCapacity(
    kind: "collection" | "book-tag" | "highlight-tag",
    bookId: BookId,
    containerId: CollectionId | TagId,
    highlightId?: HighlightId,
  ): Promise<void> {
    const table = kind === "collection" ? "collection_books" : kind === "book-tag" ? "book_tags" : "highlight_tags";
    const ownerColumn = kind === "highlight-tag" ? "highlight_id" : "book_id";
    const containerColumn = kind === "collection" ? "collection_id" : "tag_id";
    const ownerId = kind === "highlight-tag" ? highlightId : bookId;
    const state = await this.#client.query<{ membership_count: number | string; included: boolean }>(`
      SELECT count(*) AS membership_count,
        coalesce(bool_or(${containerColumn} = $3), false) AS included
      FROM leaflogue.${table}
      WHERE library_id = $1 AND ${ownerColumn} = $2
    `, [this.#libraryId, ownerId, containerId]);
    const current = state.rows[0];
    if (!current?.included && Number(current?.membership_count ?? 0) >= MAX_SYNC_ORGANIZATION_MEMBERSHIPS) {
      throw new Error(`An item can belong to at most ${MAX_SYNC_ORGANIZATION_MEMBERSHIPS} ${kind === "collection" ? "collections" : "tags"}`);
    }
  }

  async #touchOrganizationBooks(selection: string, containerId: string): Promise<void> {
    const selected = await this.#client.query<{ book_id: string }>(selection, [this.#libraryId, containerId]);
    for (const row of selected.rows) {
      const updated = await this.#client.query<{ revision: number | string }>(`
        UPDATE leaflogue.books SET revision = revision + 1, updated_at = now()
        WHERE library_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING revision
      `, [this.#libraryId, row.book_id]);
      if (updated.rows[0]) await this.#recordWebChange("book", row.book_id, Number(updated.rows[0].revision));
    }
  }

  /**
   * Run several mutations as one transaction under the library's lock, as a
   * Convex mutation does. Calls made inside join it instead of starting their
   * own, so either all of them land or none do.
   */
  transaction<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#transaction(operation);
  }

  async #transaction<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.#scope.getStore()) return operation();
    const release = await acquireClientTransaction(this.#client);
    let began = false;
    try {
      await this.#client.query("BEGIN");
      began = true;
      await this.#client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [this.#libraryId]);
      const result = await this.#scope.run(true, operation);
      await this.#client.query("COMMIT");
      return result;
    } catch (error) {
      if (began) await this.#client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      release();
    }
  }

  async #touchBook(bookId: BookId): Promise<number> {
    const result = await this.#client.query<{ revision: number | string }>(`
      UPDATE leaflogue.books SET revision = revision + 1, updated_at = now()
      WHERE library_id = $1 AND id = $2 AND archived = false AND deleted_at IS NULL
      RETURNING revision
    `, [this.#libraryId, bookId]);
    const row = result.rows[0];
    if (!row) throw new Error("Book no longer exists");
    return Number(row.revision);
  }

  /**
   * A web-client write: recorded like any change, and claimed under the web
   * device ID at the entity's revision (as desktops claim), so desktops pull
   * it. Without a claim, pull cannot attribute the row and stops before it.
   */
  async #recordWebChange(entityType: SyncEntityType, entityId: string, revision: number): Promise<void> {
    const table = WEB_CLAIM_TABLES[entityType];
    // One statement: the change, then the claim at the entity's current revision.
    await this.#client.query(`
      WITH change AS (
        INSERT INTO leaflogue.sync_changes (library_id, entity_type, entity_id, revision)
        VALUES ($1, $2, $3, $4)
      ), entity AS (
        SELECT revision, ${table === "daily_selections" ? "false" : "deleted_at IS NOT NULL"} AS deleted
        FROM leaflogue.${table} WHERE library_id = $1 AND id = $3
      )
      INSERT INTO leaflogue.synced_writers
        (library_id, entity_type, entity_id, device_id, device_revision, operation)
      SELECT $1, $2, $3, $5, entity.revision, CASE WHEN entity.deleted THEN 'tombstone' ELSE 'upsert' END
      FROM entity
      ON CONFLICT (library_id, entity_type, entity_id) DO UPDATE
        SET device_id = excluded.device_id, device_revision = excluded.device_revision,
            operation = excluded.operation, applied_at = now()
    `, [this.#libraryId, entityType, entityId, revision, WEB_DEVICE_ID]);
  }

  async #recordChange(entityType: SyncEntityType, entityId: string, revision: number): Promise<void> {
    await this.#client.query(`
      INSERT INTO leaflogue.sync_changes (library_id, entity_type, entity_id, revision)
      VALUES ($1, $2, $3, $4)
    `, [this.#libraryId, entityType, entityId, revision]);
  }

}

async function acquireClientTransaction(client: PostgresClient): Promise<() => void> {
  const previous = clientTransactionTails.get(client) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const tail = previous.then(() => gate);
  clientTransactionTails.set(client, tail);
  await previous;
  return () => {
    releaseGate();
    if (clientTransactionTails.get(client) === tail) clientTransactionTails.delete(client);
  };
}

function mapHighlight(row: HighlightRow): HighlightMutationResult {
  return {
    id: row.id as HighlightId,
    bookId: row.book_id as BookId,
    text: row.text,
    ...(row.source_location ? { sourceLocation: row.source_location } : {}),
    ...(row.source_created_at_ms !== null ? { sourceCreatedAt: Number(row.source_created_at_ms) } : {}),
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
    revision: Number(row.revision),
  };
}

function mapCollection(row: CollectionRow): Collection {
  return {
    id: row.id as CollectionId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    bookCount: Number(row.book_count),
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
    revision: Number(row.revision),
  };
}

function mapTag(row: TagRow): Tag {
  return {
    id: row.id as TagId,
    name: row.name,
    ...(row.color ? { color: row.color } : {}),
    bookCount: Number(row.book_count),
    highlightCount: Number(row.highlight_count),
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
    revision: Number(row.revision),
  };
}

function mapThread(row: ThreadRow): Thread {
  return {
    id: row.id as ThreadId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    passageCount: Number(row.passage_count),
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
    revision: Number(row.revision),
  };
}

function mapDailySelection(row: DailySelectionRow): DailySelection {
  const recentHighlightIds = parseStringArray(row.recent_highlight_ids, "Stored daily selection history is invalid");
  if (recentHighlightIds.length > 7 || recentHighlightIds.some((id) => !isUuid(id)) || !isUuid(row.id)) {
    throw new Error("Stored daily selection is invalid");
  }
  return {
    id: row.id as DailySelectionId,
    localDay: row.local_day,
    timezone: row.timezone,
    ...(row.highlight_id ? { highlightId: row.highlight_id as HighlightId } : {}),
    candidateDigest: row.candidate_digest,
    recentHighlightIds: recentHighlightIds as HighlightId[],
    selectedAt: Number(row.selected_at_ms),
    updatedAt: Number(row.updated_at_ms),
    revision: Number(row.revision),
  };
}

function mapBook(row: BookRow): Book {
  const authors = parseStringArray(row.authors, "Stored book authors are invalid");
  const metadata = parseObject(row.metadata, "Stored book metadata is invalid");
  const text = (key: string) => typeof metadata[key] === "string" && metadata[key] ? { [key]: metadata[key] as string } : {};
  return {
    id: row.id as BookId,
    title: row.title,
    authors,
    ...text("description"),
    ...text("publisher"),
    ...text("series"),
    ...text("seriesNumber"),
    ...text("language"),
    ...text("isbn13"),
    ...text("coverUrl"),
    status: row.status,
    ...(row.completed_on ? { completedOn: row.completed_on } : {}),
    archived: row.archived,
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
    revision: Number(row.revision),
    highlightCount: Number(row.highlight_count ?? 0),
  };
}

function mapNote(row: NoteRow): Note {
  return {
    id: row.id as NoteId,
    bookId: row.book_id as BookId,
    ...(row.highlight_id ? { highlightId: row.highlight_id as HighlightId } : {}),
    markdown: row.markdown,
    origin: row.origin,
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
    revision: Number(row.revision),
  };
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} text is required`);
  if (normalized.length > maximum) throw new Error(`${label} text is too long`);
  return normalized;
}

function requiredNote(value: string): string {
  const markdown = requiredText(value, "Note", 100_000);
  if (new TextEncoder().encode(markdown).byteLength > MAX_NOTE_BYTES) throw new Error("Note text is too long");
  return markdown;
}

function optionalText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error("Location is too long");
  return normalized || undefined;
}

function organizationName(value: string, label: string, maximum: number): string {
  const name = value.trim().replace(/\s+/gu, " ");
  if (!name) throw new Error(`${label} name is required`);
  if (name.length > maximum || normalizeOrganizationName(name).length > maximum) {
    throw new Error(`${label} name is too long`);
  }
  return name;
}

function organizationOptionalText(value: string | undefined, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${label} is too long`);
  return text || undefined;
}

function requiredId(value: string): string {
  if (!isUuid(value)) {
    throw new Error("Book ID is invalid");
  }
  return value;
}

function requiredEntityId(value: string, label: string): string {
  if (typeof value !== "string" || !isUuid(value)) throw new Error(`${label} ID is invalid`);
  return value;
}

function requiredTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new Error("Source timestamp is invalid");
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function parseStringArray(value: unknown, message: string): readonly string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error(message);
  return parsed;
}

function parseObject(value: unknown, message: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(message);
  return parsed as Record<string, unknown>;
}

function sameCreateBook(
  book: Book,
  input: Pick<CreateBook, "id" | "title" | "authors" | "isbn13">,
): boolean {
  const authors = input.authors ?? [];
  return book.id === input.id && book.title === input.title &&
    book.isbn13 === input.isbn13 && book.authors.length === authors.length &&
    book.authors.every((author, index) => author === authors[index]);
}

function requireRevision(revision: number, label: string): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error(`${label} revision is invalid`);
}

function isReadingStatus(value: unknown): value is ReadingStatus {
  return value === "unread" || value === "reading" || value === "finished" || value === "paused";
}

function syncedEntityId(change: SyncedChange): string {
  if (change.operation === "tombstone") return change.entityId;
  if (change.entityType === "book") return change.book.id;
  if (change.entityType === "highlight") return change.highlight.id;
  if (change.entityType === "note") return change.note.id;
  if (change.entityType === "collection") return change.collection.id;
  if (change.entityType === "tag") return change.tag.id;
  if (change.entityType === "thread") return change.thread.id;
  return change.dailySelection.id;
}

function syncedBody(change: SyncedChange): string | undefined {
  if (change.operation === "tombstone" || (change.entityType !== "highlight" && change.entityType !== "note")) return undefined;
  return change.entityType === "highlight"
    ? requiredText(change.highlight.text, "Highlight", 100_000)
    : requiredNote(change.note.markdown);
}

/**
 * Express a changed entity as the claim that owns it. Replay is ordered by that
 * claim, so a row without one — or whose deletion state disagrees with it — was
 * written by an interactive mutation and cannot be attributed. Such a change is
 * left unexpressed and the pull stops before it rather than inventing a device.
 */
function syncedChangeFromState(
  entityType: "book" | "highlight" | "note" | "collection" | "tag" | "thread" | "daily-selection",
  row: SyncedStateRow,
): SyncedChange | undefined {
  const deviceRevision = Number(row.device_revision);
  if (!row.device_id || !row.operation || !Number.isSafeInteger(deviceRevision) || deviceRevision < 1) return undefined;
  const claim = { deviceId: row.device_id, deviceRevision };
  const deleted = row.id === null || row.deleted === true;
  if (deleted !== (row.operation === "tombstone")) return undefined;
  if (deleted) {
    if (entityType === "book") return { entityType, operation: "tombstone", ...claim, entityId: row.entity_id as BookId };
    if (entityType === "collection") {
      return { entityType, operation: "tombstone", ...claim, entityId: row.entity_id as CollectionId };
    }
    if (entityType === "tag") return { entityType, operation: "tombstone", ...claim, entityId: row.entity_id as TagId };
    if (entityType === "thread") return { entityType, operation: "tombstone", ...claim, entityId: row.entity_id as ThreadId };
    if (entityType === "daily-selection") {
      return { entityType, operation: "tombstone", ...claim, entityId: row.entity_id as DailySelectionId };
    }
    const bookId = (row.book_id ?? row.tombstone_book_id) as BookId | null;
    if (!bookId) return undefined;
    return entityType === "highlight"
      ? { entityType, operation: "tombstone", ...claim, entityId: row.entity_id as HighlightId, bookId }
      : { entityType, operation: "tombstone", ...claim, entityId: row.entity_id as NoteId, bookId };
  }
  if (entityType === "book") return {
    entityType, operation: "upsert", ...claim, book: mapBook(row as unknown as BookRow),
    collectionIds: requireSyncIds(row.collection_ids, "Book collection membership") as CollectionId[],
    tagIds: requireSyncIds(row.tag_ids, "Book tag membership") as TagId[],
    statusEvents: requireStatusEvents(parseStatusEvents(row.status_events), row.entity_id),
  };
  if (entityType === "highlight") {
    // Replay always writes live passages; an archived one came from elsewhere.
    if (row.archived === true) return undefined;
    return { entityType, operation: "upsert", ...claim, highlight: mapHighlight(row as unknown as HighlightRow),
      tagIds: requireSyncIds(row.tag_ids, "Passage tag membership") as TagId[],
      threadIds: requireSyncIds(row.thread_ids, "Passage thread membership", MAX_THREADS_PER_HIGHLIGHT) as ThreadId[] };
  }
  if (entityType === "note") return { entityType, operation: "upsert", ...claim, note: mapNote(row as unknown as NoteRow) };
  if (entityType === "collection") return {
    entityType, operation: "upsert", ...claim,
    collection: mapCollection(row as unknown as CollectionRow),
  };
  if (entityType === "thread") return {
    entityType, operation: "upsert", ...claim,
    thread: mapThread(row as unknown as ThreadRow),
  };
  if (entityType === "daily-selection") return {
    entityType, operation: "upsert", ...claim,
    dailySelection: { ...mapDailySelection(row as unknown as DailySelectionRow), createdAt: Number(row.created_at_ms) },
  };
  return {
    entityType, operation: "upsert", ...claim,
    tag: mapTag(row as unknown as TagRow),
  };
}

function requireSyncedDailySelection(pick: SyncedDailySelection): SyncedDailySelection {
  if (!isUuid(pick.id) || !/^\d{4}-\d{2}-\d{2}$/u.test(pick.localDay) || typeof pick.timezone !== "string" ||
      pick.timezone.trim().length < 1 || pick.timezone.length > 100 ||
      (pick.highlightId !== undefined && !isUuid(pick.highlightId)) || !/^[0-9a-f]{64}$/u.test(pick.candidateDigest) ||
      !Array.isArray(pick.recentHighlightIds) || pick.recentHighlightIds.length > 7 || !pick.recentHighlightIds.every(isUuid) ||
      !Number.isSafeInteger(pick.selectedAt) || pick.selectedAt < 0 || !Number.isSafeInteger(pick.createdAt) || pick.createdAt < 0) {
    throw new Error("Synced daily selection is invalid");
  }
  return pick;
}

function parseStatusEvents(value: unknown): ReadingStatusEvent[] {
  if (value === undefined || value === null) return [];
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new Error("Book reading history is invalid");
  return parsed.map((event: Record<string, unknown>) => ({
    id: event.id as ReadingStatusEventId,
    bookId: event.bookId as BookId,
    status: event.status as ReadingStatusEvent["status"],
    source: event.source as ReadingStatusEvent["source"],
    changedAt: Number(event.changedAt),
    ...(typeof event.completedOn === "string" ? { completedOn: event.completedOn } : {}),
    bookRevision: Number(event.bookRevision),
  }));
}

function requireStatusEvents(events: readonly ReadingStatusEvent[], bookId: string): ReadingStatusEvent[] {
  // `Array.isArray` would widen this readonly array to any[]; callers pass arrays.
  if (events.length > MAX_SYNCED_STATUS_EVENTS_PER_BOOK ||
      new Set(events.map(({ id }) => id)).size !== events.length ||
      !events.every((event) => isUuid(event.id) && event.bookId === bookId &&
        ["unread", "reading", "finished", "paused"].includes(event.status) &&
        ["reader", "merge", "kindle", "kobo", "portable"].includes(event.source) &&
        Number.isSafeInteger(event.changedAt) && event.changedAt >= 0 &&
        Number.isSafeInteger(event.bookRevision) && event.bookRevision > 0 &&
        (event.completedOn === undefined || validateCompletionDate(event.completedOn) === event.completedOn))) {
    throw new Error("Book reading history is invalid");
  }
  return [...events];
}

function requireSyncIds(value: unknown, label: string, maximum = MAX_SYNC_ORGANIZATION_MEMBERSHIPS): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.length > maximum ||
      new Set(parsed).size !== parsed.length ||
      !parsed.every((id) => typeof id === "string" && isUuid(id))) {
    throw new Error(`${label} is invalid`);
  }
  return parsed as string[];
}

function validEpoch(value: number | undefined, optional = false): number | null {
  if (value === undefined) {
    if (optional) return null;
    throw new Error("Synced timestamp is invalid");
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Synced timestamp is invalid");
  return value;
}

function causallySuperseded(
  loserDeviceId: string | null | undefined,
  loserRevision: number | string | null | undefined,
  winnerDeviceId: string | null | undefined,
  winnerRevision: number | string | null | undefined,
): boolean {
  if (!loserDeviceId || loserDeviceId !== winnerDeviceId || loserRevision === null || loserRevision === undefined ||
      winnerRevision === null || winnerRevision === undefined) return false;
  return Number(loserRevision) <= Number(winnerRevision);
}
