import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type {
  AnnotationDeletionReceipt,
  Book,
  BookArchiveChange,
  BookContents,
  BookId,
  BookMetadataSource,
  BookOrganization,
  BookReadingStatusChange,
  Collection,
  CollectionId,
  DailyHighlight,
  DailyPassage,
  DailySelection,
  DailySelectionId,
  DeleteThread,
  DeleteCollection,
  DeleteHighlight,
  DeleteNote,
  DeleteTag,
  EnsureDailyHighlight,
  HighlightId,
  HighlightPage,
  HighlightQuery,
  HighlightSource,
  ImportBook,
  ImportBookMatch,
  ImportBookSelection,
  ImportDocument,
  ImportAnnotation,
  ImportConflict,
  ImportConflictId,
  ImportProvider,
  ReadingStatusSource,
  ImportReceipt,
  ImportSourceProfile,
  ImportWarning,
  LibraryRepository,
  MergeBooks,
  MergeBooksReceipt,
  NewCollection,
  NewHighlight,
  NewBook,
  NewNote,
  NewTag,
  NewThread,
  Note,
  NoteId,
  ReadingStatus,
  ReadingStatusEvent,
  ReadingStatusEventId,
  ResetHighlightToSource,
  ResolveImportConflict,
  ResolveSyncConflict,
  SyncConflict,
  SyncConflictId,
  SyncConflictPage,
  SetBookArchived,
  SetBookCompletionDate,
  SetBookReadingStatus,
  SetBookCollectionMembership,
  SetBookTagMembership,
  SetHighlightTagMembership,
  SetHighlightThreadMembership,
  ResolvedSyncBatch,
  ResolvedSyncChange,
  SyncCursor,
  SyncedChange,
  SyncedChangeOutcome,
  SyncOutboxEntry,
  Tag,
  TagId,
  Thread,
  ThreadDetails,
  ThreadHighlightMembership,
  ThreadId,
  ThreadMembershipReceipt,
  ThreadPassage,
  UpdateBookMetadata,
  UpdateCollection,
  UpdateHighlight,
  UpdateNote,
  UpdateTag,
  UpdateThread,
} from "@leaflogue/contracts";
import { dailySelectionWins, MAX_HIGHLIGHT_PAGE, MAX_HIGHLIGHT_SEARCH_LENGTH, MAX_NOTE_BYTES, MAX_NOTES_PER_HIGHLIGHT, MAX_SYNC_CHANGE_PAGE, MAX_SYNC_CONFLICT_PAGE, MAX_STATUS_EVENTS_PER_BOOK, MAX_SYNC_ORGANIZATION_MEMBERSHIPS, MAX_SYNCED_STATUS_EVENTS_PER_BOOK, MAX_THREADS_PER_HIGHLIGHT, assertSyncAcknowledgement, normalizeOrganizationName } from "@leaflogue/contracts";
import type { SyncAcknowledgement } from "@leaflogue/contracts";
import { assertUniqueImportIds, chooseDailyHighlightId, normalizeBookText, normalizeBookMetadata, normalizeIsbn13, resolveLocalDay, validateCompletionDate, type NormalizedBookMetadata } from "@leaflogue/domain";
import { applyMigrations, latestSchemaVersion, migrations } from "./migrations";

export { recoverInterruptedFileReplacement, replaceFileWithRollback } from "./file-replacement";

const MAX_THREAD_DETAIL_BYTES = 8 * 1024 * 1024;
const MAX_DAILY_PASSAGE_BYTES = 1024 * 1024;

interface BookRow {
  id: string;
  title: string;
  authors_json: string;
  description: string | null;
  publisher: string | null;
  series: string | null;
  series_number: string | null;
  language: string | null;
  isbn13: string | null;
  cover_url: string | null;
  status: ReadingStatus;
  completed_on: string | null;
  archived: number;
  created_at: number;
  updated_at: number;
  revision: number;
  highlight_count: number;
}

interface HighlightRow {
  id: string;
  book_id: string;
  text: string;
  source_location: string | null;
  source_created_at: number | null;
  created_at: number;
  updated_at: number;
  revision: number;
}

interface ReadingStatusEventRow {
  id: string;
  book_id: string;
  status: ReadingStatus;
  source: ReadingStatusSource;
  changed_at: number;
  completed_on: string | null;
  book_revision: number;
}

interface NoteRow {
  id: string;
  book_id: string;
  highlight_id: string | null;
  markdown: string;
  origin: "reader" | "import" | "ai";
  created_at: number;
  updated_at: number;
  revision: number;
}

interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  book_count: number;
  created_at: number;
  updated_at: number;
  revision: number;
}

interface TagRow {
  id: string;
  name: string;
  color: string | null;
  book_count: number;
  highlight_count: number;
  created_at: number;
  updated_at: number;
  revision: number;
}

interface ThreadRow {
  id: string;
  name: string;
  description: string | null;
  passage_count: number;
  created_at: number;
  updated_at: number;
  revision: number;
}

interface DailySelectionRow {
  id: string;
  local_day: string;
  timezone: string;
  highlight_id: string | null;
  candidate_digest: string;
  recent_highlight_ids_json: string;
  selected_at: number;
  updated_at: number;
  revision: number;
  created_at?: number;
}

interface DailyCandidateRow {
  readonly id: HighlightId;
  readonly bookId: BookId;
}

interface ThreadPassageRow {
  highlight_id: string;
  added_at: number;
  book_id: string;
  text: string;
  source_location: string | null;
  book_title: string;
  authors_json: string;
}

interface ConflictRow {
  id: string;
  source_name: string;
  book_title: string;
  highlight_id: string | null;
  base_json: string;
  local_json: string;
  incoming_json: string;
  created_at: number;
}

interface SyncConflictRow {
  id: string;
  entity_type: "highlight" | "note";
  entity_id: string;
  book_id: string;
  losing_body: string;
  losing_device_id: string | null;
  created_at: number;
}

type StoredImportSourceProfile = ImportSourceProfile & {
  readonly pathHintHash?: string;
};

interface SourceAnnotationLink {
  readonly source_fingerprint: string;
  readonly canonical_json: string;
  readonly highlight_id: string | null;
  readonly note_id: string | null;
  readonly attached_note_id: string | null;
  readonly detached: number;
}

export type LocalSyncCursor = SyncCursor;

/**
 * Local-only synchronization metadata. It deliberately contains no endpoint,
 * credential, or renderer-facing transport state.
 */
export interface LocalSyncState {
  readonly deviceId: string;
  readonly remoteCursor?: LocalSyncCursor;
  readonly snapshotRequired: boolean;
}

export type LocalSyncOutboxEntry = SyncOutboxEntry;

export interface ApplyIncomingSyncChange {
  readonly change: SyncedChange;
  readonly sequence: number;
  readonly expectedCursor: SyncCursor;
  readonly nextCursor: SyncCursor;
}

export class LocalLibrary implements Disposable, LibraryRepository {
  readonly schemaVersion: number;
  readonly #database: DatabaseSync;

  constructor(path: string, options: { readonly readOnly?: boolean } = {}) {
    if (options.readOnly) {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
        throw new Error("Leaflogue library must be a regular file owned by the current user");
      }
      const database = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: true });
      try {
        const version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
        if (version !== latestSchemaVersion) throw new Error("Open this library in the matching Leaflogue desktop app before using MCP");
        database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000");
        this.#database = database;
        this.schemaVersion = version;
      } catch (error) { database.close(); throw error; }
      return;
    }
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path)) {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Leaflogue library must be a regular file");
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
          throw new Error("Leaflogue library must be owned by the current user");
        }
      }
    }
    const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    let schemaVersion: number;
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      if (path !== ":memory:") {
        chmodSync(path, 0o600);
        snapshotBeforeMigration(database, path);
      }
      schemaVersion = applyMigrations(database);
      ensureLocalSyncState(database, deviceIdentityForLibrary(path));
      if (path !== ":memory:") {
        database.exec("PRAGMA journal_mode = WAL");
        for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
          if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
        }
      }
    } catch (error) {
      database.close();
      throw error;
    }
    this.#database = database;
    this.schemaVersion = schemaVersion;
  }

  readSnapshot<T>(read: () => T): T {
    this.#database.exec("BEGIN");
    try {
      const result = read();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getSyncState(): LocalSyncState {
    const row = this.#database.prepare(
      `SELECT device_id, remote_generation, remote_sequence, remote_checkpoint, snapshot_required
       FROM sync_state WHERE singleton = 1`,
    ).get() as {
      device_id: string;
      remote_generation: number | null;
      remote_sequence: number;
      remote_checkpoint: string | null;
      snapshot_required: number;
    } | undefined;
    if (!row) throw new Error("Local synchronization state is unavailable");
    return {
      deviceId: row.device_id,
      ...(row.remote_generation === null
        ? {}
        : { remoteCursor: {
            generation: row.remote_generation,
            afterSequence: row.remote_sequence,
            ...(row.remote_checkpoint ? { checkpoint: row.remote_checkpoint } : {}),
          } }),
      snapshotRequired: row.snapshot_required === 1,
    };
  }

  countPendingSyncChanges(): number {
    return Number((this.#database.prepare("SELECT count(*) AS count FROM sync_outbox WHERE acknowledged_at IS NULL").get() as { count: number }).count);
  }

  listPendingSyncChanges(limit = 100): readonly LocalSyncOutboxEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Sync outbox limit is invalid");
    }
    const rows = this.#database.prepare(
      `SELECT sequence, device_id, entity_type, entity_id, revision, operation, created_at
       FROM sync_outbox WHERE acknowledged_at IS NULL ORDER BY sequence LIMIT ?`,
    ).all(limit) as unknown as OutboxRow[];
    return rows.map(mapOutboxEntry);
  }

  /**
   * Resolve a bounded page of pending outbox entries to the current local state
   * they stand for (ADR 0005: the outbox is a to-do list, not a log). Entries
   * for one entity collapse into one change carrying its latest state, or its
   * tombstone, labelled with the local revision that wrote it.
   *
   * Changes are ordered collections, tags, books, passages, then notes, so each
   * organization membership references an entity the provider already holds.
   * A parent whose current state is a
   * pending local write outside this page is sent ahead with no entries of its
   * own; without that, a passage merged into a newer book would fail at the
   * provider at the front of the queue on every attempt.
   */
  resolvePendingSyncChanges(limit: number = MAX_SYNC_CHANGE_PAGE): ResolvedSyncBatch {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYNC_CHANGE_PAGE) {
      throw new Error("Sync outbox limit is invalid");
    }
    return this.readSnapshot(() => {
      const rows = this.#database.prepare(
        `SELECT sequence, device_id, entity_type, entity_id, revision, operation, created_at
         FROM sync_outbox
         WHERE acknowledged_at IS NULL AND entity_type IN ('book', 'highlight', 'note', 'collection', 'tag', 'thread', 'daily-selection')
         ORDER BY sequence LIMIT ?`,
      ).all(limit + 1) as unknown as OutboxRow[];
      const groups = new Map<string, { type: SyncedEntityType; id: string; first: number; entries: SyncOutboxEntry[] }>();
      for (const entry of rows.slice(0, limit).map(mapOutboxEntry)) {
        const type = entry.entityType as SyncedEntityType;
        const key = `${type}:${entry.entityId}`;
        const group = groups.get(key) ?? { type, id: entry.entityId, first: entry.sequence, entries: [] };
        group.entries.push(entry);
        groups.set(key, group);
      }
      const resolved: Array<ResolvedSyncChange & { readonly rank: number; readonly first: number }> = [];
      const superseded: SyncOutboxEntry[] = [];
      const considered = new Set(groups.keys());
      for (const group of groups.values()) {
        const change = this.#resolveOutgoingChange(group.type, group.id, group.entries);
        if (change) resolved.push({ change, entries: group.entries, rank: SYNCED_ENTITY_RANK[group.type], first: group.first });
        else superseded.push(...group.entries);
      }
      // Walk the growing array so dependencies brought ahead of a member bring
      // their own dependencies too (for example note -> passage -> tag).
      for (let index = 0; index < resolved.length; index += 1) {
        const { change } = resolved[index]!;
        if (change.operation !== "upsert") continue;
        const parents: Array<readonly [SyncedEntityType, string]> = change.entityType === "book"
          ? [...change.collectionIds.map((id) => ["collection", id] as const),
              ...change.tagIds.map((id) => ["tag", id] as const)]
          : change.entityType === "highlight"
            ? [["book", change.highlight.bookId], ...change.tagIds.map((id) => ["tag", id] as const),
                ...(change.threadIds ?? []).map((id) => ["thread", id] as const)]
            : change.entityType === "note"
              ? [["book", change.note.bookId], ...(change.note.highlightId ? [["highlight", change.note.highlightId] as const] : [])]
              : [];
        for (const [type, id] of parents) {
          const key = `${type}:${id}`;
          if (considered.has(key)) continue;
          considered.add(key);
          const first = this.#pendingLocalWrite(type, id);
          const parent = first === undefined ? undefined : this.#resolveOutgoingChange(type, id, []);
          if (parent && first !== undefined) resolved.push({ change: parent, entries: [], rank: SYNCED_ENTITY_RANK[type], first });
        }
      }
      resolved.sort((left, right) => left.rank - right.rank || left.first - right.first);
      return {
        changes: resolved.map(({ change, entries }) => ({ change, entries })),
        superseded: superseded.sort((left, right) => left.sequence - right.sequence),
        hasMore: rows.length > limit,
      };
    });
  }

  /**
   * One entity's current state as this device's claim, or undefined when that
   * state was written by an incoming change instead. Every local revision change
   * appends an outbox row in its own transaction and incoming replay suppresses
   * them, so a row at the current revision is exactly the evidence that this
   * device wrote what is there now.
   */
  #resolveOutgoingChange(
    type: SyncedEntityType,
    id: string,
    entries: readonly SyncOutboxEntry[],
  ): SyncedChange | undefined {
    const query = type === "book" ? `${bookSelect} WHERE books.id = ?`
      : type === "highlight"
        ? `SELECT id, book_id, text, source_location, source_created_at, created_at, updated_at, revision, archived, deleted
           FROM highlights WHERE id = ?`
        : type === "note"
          ? `SELECT id, book_id, highlight_id, markdown, origin, created_at, updated_at, revision, deleted
             FROM notes WHERE id = ?`
          : type === "collection"
            ? `SELECT id, name, description, created_at, updated_at, revision, deleted_at,
                 (SELECT count(*) FROM collection_books WHERE collection_id = collections.id) AS book_count
               FROM collections WHERE id = ?`
            : type === "tag"
              ? `SELECT id, name, color, created_at, updated_at, revision, deleted_at,
                   (SELECT count(*) FROM book_tags WHERE tag_id = tags.id) AS book_count,
                   (SELECT count(*) FROM highlight_tags WHERE tag_id = tags.id) AS highlight_count
                 FROM tags WHERE id = ?`
              : type === "thread"
                ? `SELECT id, name, description, created_at, updated_at, revision, deleted_at,
                     (SELECT count(*) FROM thread_highlights WHERE thread_id = threads.id) AS passage_count
                   FROM threads WHERE id = ?`
                : `SELECT id, local_day, timezone, highlight_id, candidate_digest, recent_highlight_ids_json,
                     selected_at, updated_at, revision, created_at
                   FROM daily_selections WHERE id = ?`;
    const current = this.#database.prepare(query).get(id) as { revision: number } | undefined;
    // A pick retired by a winning same-day pick from another device is gone;
    // its pending writes are superseded, not an error.
    if (!current && type === "daily-selection") return undefined;
    if (!current) throw new Error("A pending sync entry refers to a missing local entity");
    if (entries.some((entry) => entry.revision > current.revision)) {
      throw new Error("A pending sync entry is newer than its local entity");
    }
    const writer = this.#database.prepare(
      `SELECT device_id FROM sync_outbox
       WHERE entity_type = ? AND entity_id = ? AND revision = ?
       ORDER BY sequence DESC LIMIT 1`,
    ).get(type, id, current.revision) as { device_id: string } | undefined;
    if (!writer) return undefined;
    const claim = { deviceId: writer.device_id, deviceRevision: current.revision };
    let change: SyncedChange;
    if (type === "book") {
      const row = current as BookRow & { deleted_at: number | null };
      const organization = row.deleted_at === null ? this.getBookOrganization(row.id as BookId) : undefined;
      const statusEvents = row.deleted_at === null ? this.#database.prepare(
        `SELECT id, book_id, status, source, changed_at, completed_on, book_revision
         FROM reading_status_events WHERE book_id = ? ORDER BY changed_at, sequence LIMIT ?`,
      ).all(row.id, MAX_SYNCED_STATUS_EVENTS_PER_BOOK + 1) as unknown as ReadingStatusEventRow[] : [];
      if (statusEvents.length > MAX_SYNCED_STATUS_EVENTS_PER_BOOK) throw new Error("A book's reading history is too long to synchronize");
      change = row.deleted_at !== null
        ? { entityType: "book", operation: "tombstone", ...claim, entityId: row.id as BookId }
        : { entityType: "book", operation: "upsert", ...claim, book: mapBook(row),
            collectionIds: organization?.collectionIds ?? [], tagIds: organization?.tagIds ?? [],
            statusEvents: statusEvents.map(mapReadingStatusEvent) };
    } else if (type === "highlight") {
      const row = current as HighlightRow & { archived: number; deleted: number };
      // SyncedChange has no archived passage, and replay would unarchive it on
      // every other device. Nothing in this build archives a passage, so this
      // is fail-closed protection for legacy rows rather than a normal path.
      if (row.archived === 1 && row.deleted !== 1) throw new Error("An archived passage cannot be synchronized yet");
      const tagIds = this.#database.prepare(
        "SELECT tag_id FROM highlight_tags WHERE highlight_id = ? ORDER BY tag_id",
      ).all(id) as unknown as Array<{ tag_id: TagId }>;
      const threadIds = this.#database.prepare(
        "SELECT thread_id FROM thread_highlights WHERE highlight_id = ? ORDER BY thread_id",
      ).all(id) as unknown as Array<{ thread_id: ThreadId }>;
      change = row.deleted === 1
        ? { entityType: "highlight", operation: "tombstone", ...claim, entityId: row.id as HighlightId, bookId: row.book_id as BookId }
        : { entityType: "highlight", operation: "upsert", ...claim, highlight: {
          id: row.id as HighlightId,
          bookId: row.book_id as BookId,
          text: row.text,
          ...(row.source_location ? { sourceLocation: row.source_location } : {}),
          ...(row.source_created_at !== null ? { sourceCreatedAt: row.source_created_at } : {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          revision: row.revision,
        }, tagIds: tagIds.map(({ tag_id }) => tag_id), threadIds: threadIds.map(({ thread_id }) => thread_id) };
    } else if (type === "note") {
      const row = current as NoteRow & { deleted: number };
      change = row.deleted === 1
        ? { entityType: "note", operation: "tombstone", ...claim, entityId: row.id as NoteId, bookId: row.book_id as BookId }
        : { entityType: "note", operation: "upsert", ...claim, note: mapNote(row) };
    } else if (type === "collection") {
      const row = current as CollectionRow & { deleted_at: number | null };
      change = row.deleted_at !== null
        ? { entityType: "collection", operation: "tombstone", ...claim, entityId: row.id as CollectionId }
        : { entityType: "collection", operation: "upsert", ...claim, collection: mapCollection(row) };
    } else if (type === "tag") {
      const row = current as TagRow & { deleted_at: number | null };
      change = row.deleted_at !== null
        ? { entityType: "tag", operation: "tombstone", ...claim, entityId: row.id as TagId }
        : { entityType: "tag", operation: "upsert", ...claim, tag: mapTag(row) };
    } else if (type === "thread") {
      const row = current as ThreadRow & { deleted_at: number | null };
      change = row.deleted_at !== null
        ? { entityType: "thread", operation: "tombstone", ...claim, entityId: row.id as ThreadId }
        : { entityType: "thread", operation: "upsert", ...claim, thread: mapThread(row) };
    } else {
      const row = current as DailySelectionRow;
      change = { entityType: "daily-selection", operation: "upsert", ...claim,
        dailySelection: { ...mapDailySelection(row), createdAt: Number(row.created_at ?? row.selected_at) } };
    }
    // Providers validate the same shape; failing here keeps a corrupt local row
    // from leaving the process at all.
    validateIncomingChange(change);
    return change;
  }

  /** Oldest pending sequence, when the entity's current state is a pending local write. */
  #pendingLocalWrite(type: SyncedEntityType, id: string): number | undefined {
    const row = this.#database.prepare(
      `SELECT min(outbox.sequence) AS first,
         max(CASE WHEN outbox.revision = current.revision THEN 1 ELSE 0 END) AS current_is_pending
       FROM sync_outbox AS outbox
       JOIN (SELECT revision FROM ${SYNCED_ENTITY_TABLE[type]} WHERE id = ?) AS current
       WHERE outbox.entity_type = ? AND outbox.entity_id = ? AND outbox.acknowledged_at IS NULL`,
    ).get(id, type, id) as { first: number | null; current_is_pending: number | null } | undefined;
    return row && row.first !== null && row.current_is_pending === 1 ? row.first : undefined;
  }

  acknowledgeSyncChanges(
    submitted: readonly LocalSyncOutboxEntry[],
    acknowledgement: SyncAcknowledgement,
  ): void {
    assertSyncAcknowledgement(submitted, acknowledgement);
    if (acknowledgement.operationIds.length === 0) return;
    const acknowledged = new Set(acknowledgement.operationIds);
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of submitted) {
        const operationId = `${entry.deviceId}:${entry.sequence}`;
        if (!acknowledged.has(operationId)) continue;
        const result = this.#database.prepare(
          `UPDATE sync_outbox SET acknowledged_at = ?
           WHERE sequence = ? AND device_id = ? AND entity_type = ? AND entity_id = ?
             AND revision = ? AND operation = ? AND acknowledged_at IS NULL`,
        ).run(now, entry.sequence, entry.deviceId, entry.entityType, entry.entityId, entry.revision, entry.operation);
        if (Number(result.changes) !== 1) throw new Error("Sync acknowledgement no longer matches local outbox");
      }
      // An acknowledged write is only needed while it is its entity's newest:
      // that row is how incoming replay recognises this device's claim to the
      // current state. Older acknowledged rows are history nothing reads, and
      // AUTOINCREMENT keeps their sequences from ever being reused.
      const compact = this.#database.prepare(
        `DELETE FROM sync_outbox
         WHERE entity_type = ? AND entity_id = ? AND acknowledged_at IS NOT NULL
           AND sequence < (SELECT max(sequence) FROM sync_outbox WHERE entity_type = ? AND entity_id = ?)`,
      );
      const entities = new Set(submitted.filter((entry) => acknowledged.has(`${entry.deviceId}:${entry.sequence}`))
        .map((entry) => JSON.stringify([entry.entityType, entry.entityId])));
      for (const key of entities) {
        const [entityType, entityId] = JSON.parse(key) as [string, string];
        compact.run(entityType, entityId, entityType, entityId);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Restore is a replacement of local history, never an incremental sync event.
   * Keep this separate from future remote-page application so restore cannot
   * inherit an obsolete cursor or resend another installation's outbox entries.
   */
  resetSyncStateAfterRestore(): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database.prepare(
        `UPDATE sync_state
         SET remote_generation = NULL, remote_sequence = 0, remote_checkpoint = NULL, snapshot_required = 1,
             updated_at = ?
         WHERE singleton = 1`,
      ).run(Date.now());
      if (Number(result.changes) !== 1) throw new Error("Local synchronization state is unavailable");
      this.#database.prepare("DELETE FROM sync_outbox").run();
      // Writer claims and absent-row tombstones belong to the old remote sync
      // domain and must not suppress a replacement provider's snapshot. Keep
      // conflicts: their bodies are reader data and remain reviewable even
      // after rebinding.
      this.#database.prepare("DELETE FROM sync_incoming_writers").run();
      this.#database.prepare("DELETE FROM sync_tombstones").run();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Give a library that needs a snapshot its provider cursor, and queue every
   * current entity so the provider can be rebuilt from any surviving replica
   * (ADR 0005).
   * A new library, a restored one, and one whose cursor the provider no longer
   * recognises all start here; afterwards the ordinary push and pull converge,
   * with (revision, device) ordering deciding any entity both sides hold and
   * differing bodies preserved for review rather than lost.
   *
   * A replica may be the only surviving copy after provider loss, so incoming
   * state cannot be omitted. It is replayed as a local snapshot claim; normal
   * deterministic conflict handling still preserves a differing provider body.
   */
  bootstrapSync(cursor: SyncCursor): { readonly enqueued: number } {
    if (!Number.isSafeInteger(cursor.generation) || cursor.generation < 1 ||
        !Number.isSafeInteger(cursor.afterSequence) || cursor.afterSequence < 0) {
      throw new Error("Sync bootstrap cursor is invalid");
    }
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.#database.prepare(
        "SELECT device_id, snapshot_required FROM sync_state WHERE singleton = 1",
      ).get() as { device_id: string; snapshot_required: number } | undefined;
      if (!state) throw new Error("Local synchronization state is unavailable");
      if (state.snapshot_required !== 1) throw new Error("This library already has a sync cursor");
      let enqueued = 0;
      for (const [type, table, deleted] of [
        ["book", "books", "deleted_at IS NOT NULL"],
        // Nothing in this build archives a passage, and sending one would
        // unarchive it elsewhere, so an archived passage is left out.
        ["highlight", "highlights", "deleted = 1"],
        ["note", "notes", "deleted = 1"],
        ["collection", "collections", "deleted_at IS NOT NULL"],
        ["tag", "tags", "deleted_at IS NOT NULL"],
        ["thread", "threads", "deleted_at IS NOT NULL"],
        ["daily-selection", "daily_selections", "0"],
      ] as const) {
        const result = this.#database.prepare(
          `INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
           SELECT ?, ?, entity.id, entity.revision,
                  CASE WHEN ${deleted} THEN 'tombstone' ELSE 'upsert' END, ?
           FROM ${table} AS entity
           WHERE ${type === "highlight" ? "entity.archived = 0 AND " : ""}NOT EXISTS (
               SELECT 1 FROM sync_outbox AS pending
               WHERE pending.entity_type = ? AND pending.entity_id = entity.id
                 AND pending.revision = entity.revision AND pending.acknowledged_at IS NULL
             )
           ORDER BY entity.created_at, entity.id`,
        ).run(state.device_id, type, now, type);
        enqueued += Number(result.changes);
      }
      this.#database.prepare(
        `UPDATE sync_state SET remote_generation = ?, remote_sequence = ?, remote_checkpoint = ?, snapshot_required = 0, updated_at = ?
         WHERE singleton = 1`,
      ).run(cursor.generation, cursor.afterSequence, cursor.checkpoint ?? null, now);
      this.#database.exec("COMMIT");
      return { enqueued };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Forget a cursor the provider no longer recognises, so the next sync pass
   * rebuilds through `bootstrapSync`. Unlike a restore, the library's history
   * is unchanged: pending work stays queued, and incoming claims stay, so state
   * another device wrote is never re-sent as this device's.
   */
  requireSyncSnapshot(): void {
    const result = this.#database.prepare(
      `UPDATE sync_state SET remote_generation = NULL, remote_sequence = 0, remote_checkpoint = NULL, snapshot_required = 1, updated_at = ?
       WHERE singleton = 1`,
    ).run(Date.now());
    if (Number(result.changes) !== 1) throw new Error("Local synchronization state is unavailable");
  }

  /** Apply one provider change and advance its cursor without echoing an outbox row. */
  applyIncomingSyncedChange(input: ApplyIncomingSyncChange): SyncedChangeOutcome {
    validateCursorAdvance(input.expectedCursor, input.nextCursor);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 ||
        input.nextCursor.afterSequence !== input.sequence) {
      throw new Error("Incoming sync change sequence does not match its cursor");
    }
    validateIncomingChange(input.change);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.#database.prepare(
        `SELECT device_id, remote_generation, remote_sequence, remote_checkpoint, snapshot_required
         FROM sync_state WHERE singleton = 1`,
      ).get() as { device_id: string; remote_generation: number | null; remote_sequence: number; remote_checkpoint: string | null; snapshot_required: number } | undefined;
      if (!state || state.snapshot_required === 1 || state.remote_generation !== input.expectedCursor.generation ||
          state.remote_sequence !== input.expectedCursor.afterSequence ||
          (state.remote_checkpoint ?? undefined) !== input.expectedCursor.checkpoint) {
        throw new Error("Incoming sync cursor no longer matches local state");
      }
      const pendingBefore = Number((this.#database.prepare("SELECT count(*) AS count FROM sync_outbox").get() as { count: number }).count);
      // Outbox triggers are deliberately state-gated. Removing this singleton
      // inside the same transaction suppresses echo operations; rollback puts
      // it back if any entity, conflict, or cursor write fails.
      this.#database.prepare("DELETE FROM sync_state WHERE singleton = 1").run();
      const outcome = this.#applyIncomingChange(input.change);
      this.#database.prepare(
        `INSERT INTO sync_state
          (singleton, device_id, remote_generation, remote_sequence, remote_checkpoint, snapshot_required, updated_at)
         VALUES (1, ?, ?, ?, ?, 0, ?)`,
      ).run(state.device_id, input.nextCursor.generation, input.nextCursor.afterSequence, input.nextCursor.checkpoint ?? null, Date.now());
      const pendingAfter = Number((this.#database.prepare("SELECT count(*) AS count FROM sync_outbox").get() as { count: number }).count);
      if (pendingAfter !== pendingBefore) throw new Error("Incoming sync change attempted to append to the outbox");
      this.#database.exec("COMMIT");
      return outcome;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #applyIncomingChange(change: SyncedChange): SyncedChangeOutcome {
    const entityId = syncedEntityId(change);
    const current = this.#incomingEntity(change.entityType, entityId);
    const recordedWriter = this.#database.prepare(
      `SELECT device_id, device_revision, operation, entity_revision
       FROM sync_incoming_writers WHERE entity_type = ? AND entity_id = ?`,
    ).get(change.entityType, entityId) as { device_id: string; device_revision: number; operation: "upsert" | "tombstone"; entity_revision: number } | undefined;
    const incomingBody = syncedBody(change);
    const recordedWriterMatches = Boolean(recordedWriter && current && recordedWriter.entity_revision === current.revision &&
      ((recordedWriter.operation === "upsert" && !current.deleted) || (recordedWriter.operation === "tombstone" && current.deleted)));
    const localWriter = current && !recordedWriterMatches ? this.#database.prepare(
      `SELECT device_id, revision AS device_revision, operation, revision AS entity_revision
       FROM sync_outbox
       WHERE entity_type = ? AND entity_id = ? AND revision = ?
       ORDER BY sequence DESC LIMIT 1`,
    ).get(change.entityType, entityId, current.revision) as
      { device_id: string; device_revision: number; operation: "upsert" | "tombstone"; entity_revision: number } | undefined : undefined;
    // A local interactive write supersedes the last incoming claim. Its outbox
    // row is the durable causal identity that the provider will receive.
    const writer = recordedWriterMatches ? recordedWriter : localWriter;
    const writerMatches = recordedWriterMatches || localWriter !== undefined;
    if (change.operation === "upsert" && current?.deleted && !writerMatches) {
      this.#mergeSupersededStatusEvents(change);
      if ((change.entityType === "highlight" || change.entityType === "note") && incomingBody) {
        this.#preserveIncomingConflict(change, incomingBody, undefined, change.deviceId, change.deviceRevision, "upsert", "tombstone", current.bookId);
      }
      this.#writeIncomingWriter(change, entityId, "tombstone", current.revision);
      return "superseded";
    }
    if (writer && !incomingWriterWins(change, writer)) {
      this.#mergeSupersededStatusEvents(change);
      if ((change.entityType === "highlight" || change.entityType === "note") && incomingBody && incomingBody !== current?.body &&
          !causallySuperseded(change.deviceId, change.deviceRevision, writer.device_id, writer.device_revision) &&
          !causallySuperseded(change.deviceId, change.deviceRevision,
            recordedWriter?.device_id, recordedWriter?.device_revision)) {
        this.#preserveIncomingConflict(change, incomingBody, current?.deleted ? undefined : current?.body,
          change.deviceId, change.deviceRevision, change.operation, writer.operation, current?.bookId);
      }
      return "superseded";
    }
    if ((change.entityType === "highlight" || change.entityType === "note") && current?.body && !current.deleted && current.body !== incomingBody &&
        !(writerMatches && writer?.device_id === change.deviceId && writer.device_revision <= change.deviceRevision)) {
      this.#preserveIncomingConflict(change, current.body, incomingBody, writer?.device_id, writer?.device_revision,
        writer?.operation ?? "upsert", change.operation, current.bookId);
    }
    const now = Date.now();
    let revision: number;
    if (change.entityType === "book") revision = this.#applyIncomingBook(change, current, now);
    else if (change.entityType === "highlight") revision = this.#applyIncomingHighlight(change, current, now);
    else if (change.entityType === "note") revision = this.#applyIncomingNote(change, current, now);
    else if (change.entityType === "collection") revision = this.#applyIncomingCollection(change, current, now);
    else if (change.entityType === "tag") revision = this.#applyIncomingTag(change, current, now);
    else if (change.entityType === "thread") revision = this.#applyIncomingThread(change, current, now);
    else revision = this.#applyIncomingDailySelection(change, current, now);
    this.#writeIncomingWriter(change, entityId, change.operation, revision);
    return "applied";
  }

  #incomingEntity(entityType: SyncedEntityType, entityId: string): { revision: number; deleted: boolean; body?: string; bookId?: string } | undefined {
    if (entityType === "book") {
      const row = this.#database.prepare("SELECT revision, deleted_at FROM books WHERE id = ?").get(entityId) as { revision: number; deleted_at: number | null } | undefined;
      if (row) return { revision: row.revision, deleted: row.deleted_at !== null };
    } else if (entityType === "highlight" || entityType === "note") {
      const row = this.#database.prepare(`SELECT revision, deleted, book_id, ${entityType === "highlight" ? "text" : "markdown"} AS body
        FROM ${entityType === "highlight" ? "highlights" : "notes"} WHERE id = ?`).get(entityId) as
        { revision: number; deleted: number; book_id: string; body: string } | undefined;
      if (row) return { revision: row.revision, deleted: row.deleted === 1, body: row.body, bookId: row.book_id };
    } else if (entityType === "daily-selection") {
      const row = this.#database.prepare("SELECT revision FROM daily_selections WHERE id = ?").get(entityId) as
        { revision: number } | undefined;
      if (row) return { revision: row.revision, deleted: false };
    } else {
      const row = this.#database.prepare(
        `SELECT revision, deleted_at FROM ${SYNCED_ENTITY_TABLE[entityType]} WHERE id = ?`,
      ).get(entityId) as { revision: number; deleted_at: number | null } | undefined;
      if (row) return { revision: row.revision, deleted: row.deleted_at !== null };
    }
    const tombstone = this.#database.prepare(
      "SELECT revision, book_id FROM sync_tombstones WHERE entity_type = ? AND entity_id = ?",
    ).get(entityType, entityId) as { revision: number; book_id: string } | undefined;
    return tombstone ? { revision: tombstone.revision, deleted: true, bookId: tombstone.book_id } : undefined;
  }

  #applyIncomingBook(
    change: Extract<SyncedChange, { entityType: "book" }>,
    current: { revision: number; deleted: boolean } | undefined,
    now: number,
  ): number {
    const entityId = syncedEntityId(change);
    if (change.operation === "tombstone") {
      const revision = current ? current.revision + 1 : this.#nextIncomingTombstoneRevision("book", entityId, 1);
      if (current) this.#database.prepare(
        "UPDATE books SET deleted_at = ?, updated_at = ?, revision = ? WHERE id = ?",
      ).run(now, now, revision, entityId);
      this.#database.prepare("DELETE FROM collection_books WHERE book_id = ?").run(entityId);
      this.#database.prepare("DELETE FROM book_tags WHERE book_id = ?").run(entityId);
      this.#writeIncomingTombstone("book", entityId, entityId, revision, now);
      return revision;
    }
    const collectionIds = activeOrTombstonedContainerIds(this.#database, "collection", change.collectionIds);
    const tagIds = activeOrTombstonedContainerIds(this.#database, "tag", change.tagIds);
    const metadata = normalizeBookMetadata(change.book);
    const completedOn = change.book.status === "finished" ? validateCompletionDate(change.book.completedOn) ?? null : null;
    const revision = current ? current.revision + 1 : 1;
    if (current) {
      this.#database.prepare(
        `UPDATE books SET title = ?, authors_json = ?, description = ?, publisher = ?, series = ?,
           series_number = ?, language = ?, isbn13 = ?, cover_url = ?, status = ?, completed_on = ?,
           archived = ?, deleted_at = NULL, updated_at = ?, revision = ? WHERE id = ?`,
      ).run(metadata.title, JSON.stringify(metadata.authors), metadata.description ?? null, metadata.publisher ?? null,
        metadata.series ?? null, metadata.seriesNumber ?? null, metadata.language ?? null, metadata.isbn13 ?? null,
        metadata.coverUrl ?? null, change.book.status, completedOn, change.book.archived ? 1 : 0, now, revision, entityId);
    } else {
      this.#database.prepare(
        `INSERT INTO books
          (id, title, authors_json, description, publisher, series, series_number, language, isbn13, cover_url,
           status, completed_on, archived, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(entityId, metadata.title, JSON.stringify(metadata.authors), metadata.description ?? null, metadata.publisher ?? null,
        metadata.series ?? null, metadata.seriesNumber ?? null, metadata.language ?? null, metadata.isbn13 ?? null,
        metadata.coverUrl ?? null, change.book.status, completedOn, change.book.archived ? 1 : 0,
        validIncomingEpoch(change.book.createdAt), now, revision);
    }
    this.#database.prepare("DELETE FROM sync_tombstones WHERE entity_type = 'book' AND entity_id = ?").run(entityId);
    this.#database.prepare("DELETE FROM collection_books WHERE book_id = ?").run(entityId);
    this.#database.prepare("DELETE FROM book_tags WHERE book_id = ?").run(entityId);
    const insertCollection = this.#database.prepare(
      "INSERT INTO collection_books (collection_id, book_id, created_at) VALUES (?, ?, ?)",
    );
    for (const collectionId of collectionIds) insertCollection.run(collectionId, entityId, now);
    const insertTag = this.#database.prepare("INSERT INTO book_tags (tag_id, book_id, created_at) VALUES (?, ?, ?)");
    for (const tagId of tagIds) insertTag.run(tagId, entityId, now);
    this.#mergeIncomingStatusEvents(entityId, change.statusEvents, true);
    return revision;
  }

  /**
   * History is a grow-only set: a losing book change still contributes the
   * events it carries, so concurrent status changes on two devices both
   * survive. It may not move an event, because a stale snapshot of a merged
   * book would otherwise pull events back to it.
   */
  #mergeSupersededStatusEvents(change: SyncedChange): void {
    if (change.entityType !== "book" || change.operation !== "upsert" || !change.statusEvents?.length) return;
    if (!this.#database.prepare("SELECT 1 FROM books WHERE id = ?").get(change.book.id)) return;
    this.#mergeIncomingStatusEvents(change.book.id, change.statusEvents, false);
  }

  #mergeIncomingStatusEvents(bookId: string, events: readonly ReadingStatusEvent[] | undefined, allowMove: boolean): void {
    if (!events?.length) return;
    const existing = this.#database.prepare("SELECT book_id FROM reading_status_events WHERE id = ?");
    const insert = this.#database.prepare(
      `INSERT INTO reading_status_events (id, book_id, status, source, changed_at, completed_on, book_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const move = this.#database.prepare("UPDATE reading_status_events SET book_id = ? WHERE id = ?");
    for (const event of events) {
      const row = existing.get(event.id) as { book_id: string } | undefined;
      if (!row) {
        insert.run(event.id, bookId, event.status, event.source, event.changedAt, event.completedOn ?? null, event.bookRevision);
      } else if (allowMove && row.book_id !== bookId) {
        move.run(bookId, event.id);
      }
    }
  }

  #applyIncomingHighlight(
    change: Extract<SyncedChange, { entityType: "highlight" }>,
    current: { revision: number; deleted: boolean; body?: string; bookId?: string } | undefined,
    now: number,
  ): number {
    const entityId = syncedEntityId(change);
    const bookId = change.operation === "upsert" ? change.highlight.bookId : current?.bookId ?? change.bookId;
    if (change.operation === "tombstone") {
      const revision = current ? current.revision + 1 : this.#nextIncomingTombstoneRevision("highlight", entityId, 1);
      if (current) this.#database.prepare(
        "UPDATE highlights SET deleted = 1, deleted_at = ?, updated_at = ?, revision = ? WHERE id = ?",
      ).run(now, now, revision, entityId);
      this.#database.prepare("UPDATE source_annotations SET detached = 1 WHERE highlight_id = ?").run(entityId);
      this.#database.prepare(
        "UPDATE import_conflicts SET status = 'superseded' WHERE highlight_id = ? AND status = 'pending'",
      ).run(entityId);
      // The tombstone itself tells replicas the passage left its threads and
      // tags. Revising those containers here would leave revisions no device
      // claims, so a later stale change could overwrite them unchecked.
      this.#database.prepare("DELETE FROM thread_highlights WHERE highlight_id = ?").run(entityId);
      this.#database.prepare("DELETE FROM highlight_tags WHERE highlight_id = ?").run(entityId);
      this.#writeIncomingTombstone("highlight", entityId, bookId, revision, now);
      return revision;
    }
    requireIncomingParent(this.#database, bookId);
    const tagIds = activeOrTombstonedContainerIds(this.#database, "tag", change.tagIds);
    // Absent membership comes only from an older provider: keep local links.
    const threadIds = change.threadIds === undefined
      ? undefined
      : activeOrTombstonedContainerIds(this.#database, "thread", change.threadIds);
    const text = requiredText(change.highlight.text, "Highlight", 100_000);
    const sourceLocation = optionalText(change.highlight.sourceLocation, 2_000);
    validIncomingEpoch(change.highlight.sourceCreatedAt, true);
    const revision = current ? current.revision + 1 : 1;
    if (current) this.#database.prepare(
      `UPDATE highlights SET book_id = ?, text = ?, source_location = ?, source_created_at = ?, archived = 0,
       deleted = 0, deleted_at = NULL, updated_at = ?, revision = ? WHERE id = ?`,
    ).run(bookId, text, sourceLocation ?? null, change.highlight.sourceCreatedAt ?? null, now, revision, entityId);
    else this.#database.prepare(
      `INSERT INTO highlights
        (id, book_id, text, source_location, source_created_at, archived, deleted, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    ).run(entityId, bookId, text, sourceLocation ?? null, change.highlight.sourceCreatedAt ?? null,
      validIncomingEpoch(change.highlight.createdAt), now, revision);
    this.#database.prepare("UPDATE source_annotations SET detached = 1 WHERE highlight_id = ?").run(entityId);
    this.#database.prepare("DELETE FROM sync_tombstones WHERE entity_type = 'highlight' AND entity_id = ?").run(entityId);
    this.#database.prepare("DELETE FROM highlight_tags WHERE highlight_id = ?").run(entityId);
    const insertTag = this.#database.prepare(
      "INSERT INTO highlight_tags (tag_id, highlight_id, created_at) VALUES (?, ?, ?)",
    );
    for (const tagId of tagIds) insertTag.run(tagId, entityId, now);
    if (threadIds === undefined) return revision;
    // Keep each surviving membership's original added time; only new ones get now.
    const keptThreads = new Map((this.#database.prepare(
      "SELECT thread_id, added_at FROM thread_highlights WHERE highlight_id = ?",
    ).all(entityId) as unknown as Array<{ thread_id: string; added_at: number }>).map((row) => [row.thread_id, row.added_at]));
    this.#database.prepare("DELETE FROM thread_highlights WHERE highlight_id = ?").run(entityId);
    const insertThread = this.#database.prepare(
      "INSERT INTO thread_highlights (thread_id, highlight_id, added_at) VALUES (?, ?, ?)",
    );
    for (const threadId of threadIds) insertThread.run(threadId, entityId, keptThreads.get(threadId) ?? now);
    return revision;
  }

  #applyIncomingNote(
    change: Extract<SyncedChange, { entityType: "note" }>,
    current: { revision: number; deleted: boolean; body?: string; bookId?: string } | undefined,
    now: number,
  ): number {
    const entityId = syncedEntityId(change);
    const bookId = change.operation === "upsert" ? change.note.bookId : current?.bookId ?? change.bookId;
    if (change.operation === "tombstone") {
      const revision = current ? current.revision + 1 : this.#nextIncomingTombstoneRevision("note", entityId, 1);
      const importedAttachment = this.#database.prepare(
        "SELECT highlight_id FROM notes WHERE id = ? AND origin = 'import'",
      ).get(entityId) as { highlight_id: string | null } | undefined;
      if (current) this.#database.prepare(
        "UPDATE notes SET deleted = 1, deleted_at = ?, updated_at = ?, revision = ? WHERE id = ?",
      ).run(now, now, revision, entityId);
      this.#database.prepare("UPDATE source_annotations SET detached = 1 WHERE note_id = ?").run(entityId);
      if (importedAttachment?.highlight_id) {
        this.#database.prepare("UPDATE source_annotations SET detached = 1 WHERE highlight_id = ?")
          .run(importedAttachment.highlight_id);
      }
      this.#database.prepare(
        "UPDATE import_conflicts SET status = 'superseded' WHERE note_id = ? AND status = 'pending'",
      ).run(entityId);
      this.#writeIncomingTombstone("note", entityId, bookId, revision, now);
      return revision;
    }
    requireIncomingParent(this.#database, bookId);
    if (change.note.highlightId) {
      const highlight = this.#database.prepare(
        "SELECT book_id FROM highlights WHERE id = ? AND deleted = 0",
      ).get(change.note.highlightId) as { book_id: string } | undefined;
      if (!highlight || highlight.book_id !== bookId) throw new Error("Incoming note's highlight no longer exists");
      const count = Number((this.#database.prepare(
        "SELECT count(*) AS count FROM notes WHERE highlight_id = ? AND deleted = 0 AND id != ?",
      ).get(change.note.highlightId, entityId) as { count: number }).count);
      if (count >= MAX_NOTES_PER_HIGHLIGHT) throw new Error(`A passage can have at most ${MAX_NOTES_PER_HIGHLIGHT} active notes`);
    }
    const markdown = requiredNote(change.note.markdown);
    const importedAttachment = this.#database.prepare(
      "SELECT highlight_id FROM notes WHERE id = ? AND origin = 'import'",
    ).get(entityId) as { highlight_id: string | null } | undefined;
    const revision = current ? current.revision + 1 : 1;
    if (current) this.#database.prepare(
      `UPDATE notes SET book_id = ?, highlight_id = ?, markdown = ?, origin = ?, deleted = 0,
       deleted_at = NULL, updated_at = ?, revision = ? WHERE id = ?`,
    ).run(bookId, change.note.highlightId ?? null, markdown, change.note.origin, now, revision, entityId);
    else this.#database.prepare(
      `INSERT INTO notes (id, book_id, highlight_id, markdown, origin, deleted, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(entityId, bookId, change.note.highlightId ?? null, markdown, change.note.origin,
      validIncomingEpoch(change.note.createdAt), now, revision);
    this.#database.prepare("UPDATE source_annotations SET detached = 1 WHERE note_id = ?").run(entityId);
    if (importedAttachment?.highlight_id) {
      this.#database.prepare("UPDATE source_annotations SET detached = 1 WHERE highlight_id = ?")
        .run(importedAttachment.highlight_id);
    }
    this.#database.prepare("DELETE FROM sync_tombstones WHERE entity_type = 'note' AND entity_id = ?").run(entityId);
    return revision;
  }

  #applyIncomingCollection(
    change: Extract<SyncedChange, { entityType: "collection" }>,
    current: { revision: number; deleted: boolean } | undefined,
    now: number,
  ): number {
    const entityId = syncedEntityId(change);
    if (change.operation === "tombstone") {
      const revision = current ? current.revision + 1 : this.#nextIncomingTombstoneRevision("collection", entityId, 1);
      if (current) this.#database.prepare(
        "UPDATE collections SET deleted_at = ?, updated_at = ?, revision = ? WHERE id = ?",
      ).run(now, now, revision, entityId);
      this.#database.prepare("DELETE FROM collection_books WHERE collection_id = ?").run(entityId);
      this.#writeIncomingTombstone("collection", entityId, entityId, revision, now);
      return revision;
    }
    const name = organizationName(change.collection.name, "Collection", 120);
    const description = organizationOptionalText(change.collection.description, "Collection description", 2_000);
    const revision = current ? current.revision + 1 : 1;
    if (current) this.#database.prepare(
      `UPDATE collections SET name = ?, normalized_name = ?, description = ?, deleted_at = NULL,
       updated_at = ?, revision = ? WHERE id = ?`,
    ).run(name, normalizeOrganizationName(name), description ?? null, now, revision, entityId);
    else this.#database.prepare(
      `INSERT INTO collections (id, name, normalized_name, description, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(entityId, name, normalizeOrganizationName(name), description ?? null,
      validIncomingEpoch(change.collection.createdAt), now, revision);
    this.#database.prepare("DELETE FROM sync_tombstones WHERE entity_type = 'collection' AND entity_id = ?").run(entityId);
    return revision;
  }

  #applyIncomingTag(
    change: Extract<SyncedChange, { entityType: "tag" }>,
    current: { revision: number; deleted: boolean } | undefined,
    now: number,
  ): number {
    const entityId = syncedEntityId(change);
    if (change.operation === "tombstone") {
      const revision = current ? current.revision + 1 : this.#nextIncomingTombstoneRevision("tag", entityId, 1);
      if (current) this.#database.prepare(
        "UPDATE tags SET deleted_at = ?, updated_at = ?, revision = ? WHERE id = ?",
      ).run(now, now, revision, entityId);
      this.#database.prepare("DELETE FROM book_tags WHERE tag_id = ?").run(entityId);
      this.#database.prepare("DELETE FROM highlight_tags WHERE tag_id = ?").run(entityId);
      this.#writeIncomingTombstone("tag", entityId, entityId, revision, now);
      return revision;
    }
    const name = organizationName(change.tag.name, "Tag", 80);
    const color = organizationOptionalText(change.tag.color, "Tag color", 32);
    const revision = current ? current.revision + 1 : 1;
    if (current) this.#database.prepare(
      `UPDATE tags SET name = ?, normalized_name = ?, color = ?, deleted_at = NULL,
       updated_at = ?, revision = ? WHERE id = ?`,
    ).run(name, normalizeOrganizationName(name), color ?? null, now, revision, entityId);
    else this.#database.prepare(
      `INSERT INTO tags (id, name, normalized_name, color, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(entityId, name, normalizeOrganizationName(name), color ?? null,
      validIncomingEpoch(change.tag.createdAt), now, revision);
    this.#database.prepare("DELETE FROM sync_tombstones WHERE entity_type = 'tag' AND entity_id = ?").run(entityId);
    return revision;
  }

  #applyIncomingThread(
    change: Extract<SyncedChange, { entityType: "thread" }>,
    current: { revision: number; deleted: boolean } | undefined,
    now: number,
  ): number {
    const entityId = syncedEntityId(change);
    if (change.operation === "tombstone") {
      const revision = current ? current.revision + 1 : this.#nextIncomingTombstoneRevision("thread", entityId, 1);
      if (current) this.#database.prepare(
        "UPDATE threads SET deleted_at = ?, updated_at = ?, revision = ? WHERE id = ?",
      ).run(now, now, revision, entityId);
      // A thread never owns its passages: deleting it removes only memberships.
      this.#database.prepare("DELETE FROM thread_highlights WHERE thread_id = ?").run(entityId);
      this.#writeIncomingTombstone("thread", entityId, entityId, revision, now);
      return revision;
    }
    const name = organizationName(change.thread.name, "Thread", 120);
    const description = organizationOptionalText(change.thread.description, "Thread description", 1_000);
    const revision = current ? current.revision + 1 : 1;
    if (current) this.#database.prepare(
      `UPDATE threads SET name = ?, normalized_name = ?, description = ?, deleted_at = NULL,
       updated_at = ?, revision = ? WHERE id = ?`,
    ).run(name, normalizeOrganizationName(name), description ?? null, now, revision, entityId);
    else this.#database.prepare(
      `INSERT INTO threads (id, name, normalized_name, description, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(entityId, name, normalizeOrganizationName(name), description ?? null,
      validIncomingEpoch(change.thread.createdAt), now, revision);
    this.#database.prepare("DELETE FROM sync_tombstones WHERE entity_type = 'thread' AND entity_id = ?").run(entityId);
    return revision;
  }

  /**
   * One pick per (day, time zone). When two devices picked offline, the
   * earlier pick (then the lower ID) keeps the slot everywhere and the other
   * is retired as a tombstone, whichever arrives first.
   */
  #applyIncomingDailySelection(
    change: Extract<SyncedChange, { entityType: "daily-selection" }>,
    current: { revision: number; deleted: boolean } | undefined,
    now: number,
  ): number {
    const entityId = syncedEntityId(change);
    const retire = (id: string, revision: number | undefined): number => {
      this.#database.prepare("DELETE FROM daily_selections WHERE id = ?").run(id);
      const tombstoneRevision = revision ?? this.#nextIncomingTombstoneRevision("daily-selection", id, 1);
      this.#writeIncomingTombstone("daily-selection", id, id, tombstoneRevision, now);
      return tombstoneRevision;
    };
    if (change.operation === "tombstone") return retire(entityId, current && !current.deleted ? current.revision + 1 : undefined);
    const incoming = change.dailySelection;
    const occupant = this.#database.prepare(
      "SELECT id, revision, created_at, selected_at FROM daily_selections WHERE local_day = ? AND timezone = ? AND id != ?",
    ).get(incoming.localDay, incoming.timezone, entityId) as
      { id: string; revision: number; created_at: number; selected_at: number } | undefined;
    if (occupant) {
      const occupantKey = { id: occupant.id, createdAt: Number(occupant.created_at || occupant.selected_at) };
      if (!dailySelectionWins({ id: entityId, createdAt: incoming.createdAt }, occupantKey)) {
        return retire(entityId, current && !current.deleted ? current.revision + 1 : undefined);
      }
      retire(occupant.id, occupant.revision + 1);
    }
    // The pick's passage may not exist here (deleted, or not yet synced); keep the pick without it.
    const highlightId = incoming.highlightId !== undefined &&
      this.#database.prepare("SELECT 1 FROM highlights WHERE id = ?").get(incoming.highlightId) ? incoming.highlightId : null;
    const revision = current && !current.deleted ? current.revision + 1 : 1;
    const values = [highlightId, incoming.candidateDigest, JSON.stringify(incoming.recentHighlightIds),
      validIncomingEpoch(incoming.selectedAt), now] as const;
    if (current && !current.deleted) {
      this.#database.prepare(
        `UPDATE daily_selections SET highlight_id = ?, candidate_digest = ?, recent_highlight_ids_json = ?,
         selected_at = ?, updated_at = ?, revision = ? WHERE id = ? AND local_day = ? AND timezone = ?`,
      ).run(...values, revision, entityId, incoming.localDay, incoming.timezone);
    } else {
      this.#database.prepare(
        `INSERT INTO daily_selections
          (id, local_day, timezone, highlight_id, candidate_digest, recent_highlight_ids_json,
           selected_at, updated_at, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(entityId, incoming.localDay, incoming.timezone, ...values, revision, validIncomingEpoch(incoming.createdAt));
    }
    this.#database.prepare("DELETE FROM sync_tombstones WHERE entity_type = 'daily-selection' AND entity_id = ?").run(entityId);
    return revision;
  }

  #writeIncomingWriter(change: SyncedChange, entityId: string, operation: "upsert" | "tombstone", revision: number): void {
    this.#database.prepare(
      `INSERT INTO sync_incoming_writers
        (entity_type, entity_id, device_id, device_revision, operation, entity_revision, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         device_id = excluded.device_id, device_revision = excluded.device_revision,
         operation = excluded.operation, entity_revision = excluded.entity_revision, applied_at = excluded.applied_at`,
    ).run(change.entityType, entityId, change.deviceId, change.deviceRevision, operation, revision, Date.now());
  }

  #nextIncomingTombstoneRevision(entityType: string, entityId: string, minimum: number): number {
    const row = this.#database.prepare(
      "SELECT revision FROM sync_tombstones WHERE entity_type = ? AND entity_id = ?",
    ).get(entityType, entityId) as { revision: number } | undefined;
    return row ? Math.max(row.revision + 1, minimum) : minimum;
  }

  #writeIncomingTombstone(entityType: string, entityId: string, bookId: string, revision: number, now: number): void {
    this.#database.prepare(
      `INSERT INTO sync_tombstones (entity_type, entity_id, book_id, revision, deleted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         book_id = excluded.book_id, revision = max(sync_tombstones.revision + 1, excluded.revision),
         deleted_at = excluded.deleted_at`,
    ).run(entityType, entityId, bookId, revision, now);
  }

  #preserveIncomingConflict(
    change: Extract<SyncedChange, { entityType: "highlight" | "note" }>,
    losingBody: string,
    winningBody: string | undefined,
    losingDeviceId: string | undefined,
    losingDeviceRevision: number | undefined,
    losingOperation: "upsert" | "tombstone",
    winningOperation: "upsert" | "tombstone",
    resolvedBookId?: string,
  ): void {
    const entityId = syncedEntityId(change);
    const maximum = change.entityType === "note" ? MAX_NOTE_BYTES : 400_000;
    if (Buffer.byteLength(losingBody, "utf8") > maximum ||
        (winningBody !== undefined && Buffer.byteLength(winningBody, "utf8") > maximum)) {
      throw new Error("A synced body exceeds the reviewable conflict limit");
    }
    const identity = fingerprint([change.entityType, entityId, losingBody, losingDeviceId ?? null,
      losingDeviceRevision ?? null, losingOperation]);
    if (this.#database.prepare("SELECT 1 FROM sync_conflicts WHERE fingerprint = ?").get(identity)) return;
    const count = Number((this.#database.prepare(
      "SELECT count(*) AS count FROM sync_conflicts WHERE entity_type = ? AND entity_id = ? AND status = 'pending'",
    ).get(change.entityType, entityId) as { count: number }).count);
    if (count >= 20) throw new Error("This synced item has too many pending conflicts to preserve another body");
    const bookId = resolvedBookId ?? (change.operation === "upsert"
      ? change.entityType === "highlight" ? change.highlight.bookId : change.note.bookId
      : change.bookId);
    this.#database.prepare(
      `INSERT INTO sync_conflicts
        (id, entity_type, entity_id, book_id, losing_body, winning_body, losing_device_id,
         losing_device_revision, losing_operation, winning_operation, fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), change.entityType, entityId, bookId, losingBody, winningBody ?? null,
      losingDeviceId ?? null, losingDeviceRevision ?? null, losingOperation, winningOperation, identity, Date.now());
  }

  createBook(input: NewBook): Book {
    const title = input.title.trim();
    if (!title) throw new Error("Book title is required");
    const authors = (input.authors ?? []).map((author) => author.trim()).filter(Boolean);
    const isbn13 = input.isbn13 === undefined ? undefined : normalizeIsbn13(input.isbn13);
    if (input.isbn13 !== undefined && !isbn13) throw new Error("ISBN-13 is invalid");

    const id = randomUUID() as BookId;
    const now = Date.now();
    this.#database
      .prepare(
        `INSERT INTO books (id, title, authors_json, isbn13, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, title, JSON.stringify(authors), isbn13 ?? null, now, now);
    return this.getBook(id)!;
  }

  updateBookMetadata(input: UpdateBookMetadata): Book {
    requireRevision(input.expectedRevision, "Book");
    const metadata = normalizeBookMetadata(input);
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#database.prepare("SELECT isbn13 FROM books WHERE id=? AND revision=? AND archived=0 AND deleted_at IS NULL").get(input.id, input.expectedRevision) as { isbn13: string | null } | undefined;
      if (!current) throw new Error("Book changed elsewhere or no longer exists");
      // Retained tombstones are sync history, not live ISBN owners.
      if (metadata.isbn13) {
        const holder = this.#database.prepare("SELECT id FROM books WHERE isbn13 = ? AND id != ? AND deleted_at IS NULL").get(metadata.isbn13, input.id);
        if (holder) throw new Error("Another book already has that ISBN-13");
      }
      const result = this.#database.prepare(
        `UPDATE books SET title = ?, authors_json = ?, description = ?, publisher = ?, series = ?,
           series_number = ?, language = ?, isbn13 = ?, cover_url = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND archived = 0 AND deleted_at IS NULL`,
      ).run(
        metadata.title, JSON.stringify(metadata.authors), metadata.description ?? null, metadata.publisher ?? null,
        metadata.series ?? null, metadata.seriesNumber ?? null, metadata.language ?? null, metadata.isbn13 ?? null, metadata.coverUrl ?? null,
        now, input.id, input.expectedRevision,
      );
      if (Number(result.changes) !== 1) throw new Error("Book changed elsewhere or no longer exists");
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.getBook(input.id)!;
  }

  /** The most recently seen import source's values for this book, if any. */
  getMetadataSource(id: BookId): BookMetadataSource | undefined {
    const row = this.#database.prepare(
      `SELECT import_sources.display_name, source_books.canonical_json, source_books.last_seen_at
       FROM source_books JOIN import_sources ON import_sources.id = source_books.source_id
       WHERE source_books.book_id = ?
       ORDER BY source_books.last_seen_at DESC, source_books.source_id
       LIMIT 1`,
    ).get(id) as { display_name: string; canonical_json: string; last_seen_at: number } | undefined;
    if (!row) return undefined;
    const stored = JSON.parse(row.canonical_json) as ImportBook;
    let values: NormalizedBookMetadata;
    try {
      values = normalizeBookMetadata({ ...stored, title: stored.title.trim() || "Untitled book", authors: stored.authors });
    } catch {
      return undefined;
    }
    return { sourceName: row.display_name, lastSeenAt: row.last_seen_at, values };
  }

  getBook(id: BookId): Book | undefined {
    const row = this.#database.prepare(`${bookSelect} WHERE books.id = ? AND books.deleted_at IS NULL`).get(id) as
      | BookRow
      | undefined;
    return row ? mapBook(row) : undefined;
  }

  listBooks(options: { readonly includeArchived?: boolean } = {}): Book[] {
    const rows = this.#database
      .prepare(
        `${bookSelect}
         WHERE books.deleted_at IS NULL AND (? = 1 OR books.archived = 0)
         ORDER BY updated_at DESC, title COLLATE NOCASE`,
      )
      .all(options.includeArchived ? 1 : 0) as unknown as BookRow[];
    return rows.map(mapBook);
  }

  listReadingStatusHistory(id: BookId, options: { readonly limit?: number } = {}): ReadingStatusEvent[] {
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 10_000)) {
      throw new Error("Reading status history limit is invalid");
    }
    const rows = this.#database.prepare(
      `SELECT id, book_id, status, source, changed_at, completed_on, book_revision
       FROM reading_status_events WHERE book_id = ?
       ORDER BY changed_at DESC, sequence DESC
       LIMIT ?`,
    ).all(id, options.limit ?? -1) as unknown as ReadingStatusEventRow[];
    return rows.map(mapReadingStatusEvent);
  }

  *iterateReadingStatusHistory(id: BookId): IterableIterator<ReadingStatusEvent> {
    const rows = this.#database.prepare(
      `SELECT id, book_id, status, source, changed_at, completed_on, book_revision
       FROM reading_status_events WHERE book_id = ?
       ORDER BY changed_at DESC, sequence DESC`,
    ).iterate(id) as Iterable<ReadingStatusEventRow>;
    for (const row of rows) yield mapReadingStatusEvent(row);
  }

  setBookReadingStatus(input: SetBookReadingStatus): BookReadingStatusChange {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("Book revision is invalid");
    }
    if (!["unread", "reading", "finished", "paused"].includes(input.status)) {
      throw new Error("Reading status is invalid");
    }
    const current = this.getBook(input.id);
    if (!current || current.archived || current.revision !== input.expectedRevision) {
      throw new Error("Book changed elsewhere or no longer exists");
    }
    if (current.status === input.status) return { changed: false, book: current };
    const now = Date.now();
    const completedOn = input.status === "finished" ? new Date(now).toISOString().slice(0, 10) : undefined;
    const eventId = randomUUID() as ReadingStatusEventId;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      requireStatusHistoryCapacity(this.#database, [input.id], 1);
      const updated = this.#database.prepare(
        `UPDATE books
         SET status = ?, completed_on = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND archived = 0
         RETURNING revision`,
      ).get(input.status, completedOn ?? null, now, input.id, input.expectedRevision) as
        | { revision: number }
        | undefined;
      if (!updated) throw new Error("Book changed elsewhere or no longer exists");
      this.#database.prepare(
        `INSERT INTO reading_status_events
          (id, book_id, status, source, changed_at, completed_on, book_revision)
         VALUES (?, ?, ?, 'reader', ?, ?, ?)`,
      ).run(eventId, input.id, input.status, now, completedOn ?? null, updated.revision);
      const book = this.getBook(input.id);
      if (!book) throw new Error("Book no longer exists");
      this.#database.exec("COMMIT");
      return {
        changed: true,
        book,
        event: { id: eventId, bookId: input.id, status: input.status, source: "reader", changedAt: now, ...(completedOn ? { completedOn } : {}), bookRevision: updated.revision },
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  setBookCompletionDate(input: SetBookCompletionDate): Book {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("Book revision is invalid");
    }
    const completedOn = validateCompletionDate(input.completedOn);
    const current = this.getBook(input.id);
    if (!current || current.archived || current.revision !== input.expectedRevision) {
      throw new Error("Book changed elsewhere or no longer exists");
    }
    if (current.status !== "finished") throw new Error("Set the book to Finished before adding a completion date");
    if (current.completedOn === completedOn) return current;
    const now = Date.now();
    const result = this.#database.prepare(
      `UPDATE books SET completed_on = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ? AND archived = 0 AND deleted_at IS NULL AND status = 'finished'`,
    ).run(completedOn ?? null, now, input.id, input.expectedRevision);
    if (Number(result.changes) !== 1) throw new Error("Book changed elsewhere or no longer exists");
    return this.getBook(input.id)!;
  }

  listThreads(): Thread[] {
    const rows = this.#database.prepare(
      `SELECT threads.id, threads.name, threads.description,
              threads.created_at, threads.updated_at, threads.revision,
              count(books.id) AS passage_count
       FROM threads
       LEFT JOIN thread_highlights ON thread_highlights.thread_id = threads.id
       LEFT JOIN highlights ON highlights.id = thread_highlights.highlight_id
         AND highlights.archived = 0 AND highlights.deleted = 0
       LEFT JOIN books ON books.id = highlights.book_id
         AND books.archived = 0 AND books.deleted_at IS NULL
       WHERE threads.deleted_at IS NULL
       GROUP BY threads.id
       ORDER BY threads.updated_at DESC, threads.normalized_name, threads.id
       LIMIT 101`,
    ).all() as unknown as ThreadRow[];
    if (rows.length > 100) throw new Error("Too many threads");
    return rows.map(mapThread);
  }

  listThreadHighlightMemberships(): ThreadHighlightMembership[] {
    const rows = this.#database.prepare(
      `SELECT thread_highlights.thread_id, thread_highlights.highlight_id, thread_highlights.added_at
       FROM thread_highlights
       JOIN threads ON threads.id = thread_highlights.thread_id
       JOIN highlights ON highlights.id = thread_highlights.highlight_id
       WHERE threads.deleted_at IS NULL
         AND highlights.archived = 0 AND highlights.deleted = 0
       ORDER BY thread_highlights.thread_id, thread_highlights.added_at, thread_highlights.highlight_id
       LIMIT 50001`,
    ).all() as unknown as Array<{ thread_id: string; highlight_id: string; added_at: number }>;
    if (rows.length > 50_000) throw new Error("Too many thread memberships");
    return rows.map((row) => ({
      threadId: row.thread_id as ThreadId,
      highlightId: row.highlight_id as HighlightId,
      addedAt: row.added_at,
    }));
  }

  getThread(id: ThreadId): ThreadDetails | undefined {
    const thread = this.#findThread(id);
    if (!thread) return undefined;
    const passageStatement = this.#database.prepare(
      `SELECT thread_highlights.highlight_id, thread_highlights.added_at,
              highlights.book_id, highlights.text, highlights.source_location,
              books.title AS book_title, books.authors_json
       FROM thread_highlights
       JOIN highlights ON highlights.id = thread_highlights.highlight_id
       JOIN books ON books.id = highlights.book_id
       WHERE thread_highlights.thread_id = ?
         AND highlights.archived = 0 AND highlights.deleted = 0
         AND books.archived = 0 AND books.deleted_at IS NULL
       ORDER BY thread_highlights.added_at, thread_highlights.highlight_id
       LIMIT 501`,
    );
    const rows: ThreadPassageRow[] = [];
    let payloadBytes = 0;
    for (const row of passageStatement.iterate(id) as Iterable<ThreadPassageRow>) {
      if (rows.length >= 500) throw new Error("Thread contains too many passages");
      payloadBytes += utf8Bytes(row.text, row.book_title, row.authors_json, row.source_location ?? "");
      if (payloadBytes > MAX_THREAD_DETAIL_BYTES) throw new Error("Thread detail is too large");
      rows.push(row);
    }
    const noteStatement = rows.length === 0 ? undefined : this.#database.prepare(
      `SELECT id, book_id, highlight_id, markdown, origin, created_at, updated_at, revision
       FROM notes
       WHERE deleted = 0 AND highlight_id IN (${rows.map(() => "?").join(",")})
       ORDER BY created_at, id
       LIMIT 5001`,
    );
    const notesByHighlight = new Map<string, Note[]>();
    let noteCount = 0;
    const noteRows = noteStatement
      ? noteStatement.iterate(...rows.map((passage) => passage.highlight_id)) as Iterable<NoteRow>
      : [];
    for (const row of noteRows) {
      noteCount += 1;
      if (noteCount > 5_000) throw new Error("Thread contains too many notes");
      payloadBytes += utf8Bytes(row.markdown);
      if (payloadBytes > MAX_THREAD_DETAIL_BYTES) throw new Error("Thread detail is too large");
      const mapped = mapNote(row);
      const attached = notesByHighlight.get(row.highlight_id!) ?? [];
      attached.push(mapped);
      notesByHighlight.set(row.highlight_id!, attached);
    }
    const passages: ThreadPassage[] = rows.map((row) => {
      const authors = parseAuthors(row.authors_json, row.book_id);
      return {
        highlightId: row.highlight_id as HighlightId,
        bookId: row.book_id as BookId,
        bookTitle: row.book_title,
        authors,
        text: row.text,
        ...(row.source_location ? { sourceLocation: row.source_location } : {}),
        notes: notesByHighlight.get(row.highlight_id) ?? [],
        addedAt: row.added_at,
      };
    });
    return { thread: { ...thread, passageCount: passages.length }, passages };
  }

  getHighlightThreadIds(bookId: BookId, highlightId: HighlightId): ThreadId[] {
    this.#requireHighlight(bookId, highlightId);
    const rows = this.#database.prepare(
      `SELECT threads.id FROM thread_highlights
       JOIN threads ON threads.id = thread_highlights.thread_id
       WHERE thread_highlights.highlight_id = ? AND threads.deleted_at IS NULL
       ORDER BY threads.normalized_name, threads.id`,
    ).all(highlightId) as unknown as Array<{ id: string }>;
    if (rows.length > 20) throw new Error("Highlight belongs to too many threads");
    return rows.map((row) => row.id as ThreadId);
  }

  createThread(input: NewThread): Thread {
    const id = randomUUID() as ThreadId;
    const name = organizationName(input.name, "Thread", 120);
    const description = organizationOptionalText(input.description, "Thread description", 1_000);
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const count = this.#database.prepare(
        "SELECT count(*) AS count FROM threads WHERE deleted_at IS NULL",
      ).get() as { count: number };
      if (Number(count.count) >= 100) throw new Error("At most 100 threads are allowed");
      if (this.#database.prepare(
        "SELECT 1 FROM threads WHERE normalized_name = ? AND deleted_at IS NULL",
      ).get(normalizeOrganizationName(name))) throw new Error("Thread name is already in use");
      this.#database.prepare(
        `INSERT INTO threads
          (id, name, normalized_name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, name, normalizeOrganizationName(name), description ?? null, now, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.#requireThread(id);
  }

  updateThread(input: UpdateThread): Thread {
    requireRevision(input.expectedRevision, "Thread");
    const name = organizationName(input.name, "Thread", 120);
    const description = organizationOptionalText(input.description, "Thread description", 1_000);
    const result = this.#database.prepare(
      `UPDATE threads
       SET name = ?, normalized_name = ?, description = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ? AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM threads AS duplicate
           WHERE duplicate.normalized_name = ? AND duplicate.id != ? AND duplicate.deleted_at IS NULL)`,
    ).run(name, normalizeOrganizationName(name), description ?? null, Date.now(), input.id, input.expectedRevision,
      normalizeOrganizationName(name), input.id);
    if (Number(result.changes) !== 1) throw new Error("Thread changed elsewhere or no longer exists");
    return this.#requireThread(input.id);
  }

  deleteThread(input: DeleteThread): void {
    requireRevision(input.expectedRevision, "Thread");
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database.prepare(
        `UPDATE threads SET deleted_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      ).run(now, now, input.id, input.expectedRevision);
      if (Number(result.changes) !== 1) throw new Error("Thread changed elsewhere or no longer exists");
      this.#database.prepare("DELETE FROM thread_highlights WHERE thread_id = ?").run(input.id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  setHighlightThreadMembership(input: SetHighlightThreadMembership): ThreadMembershipReceipt {
    requireRevision(input.expectedHighlightRevision, "Highlight");
    const threadIds = [...new Set(input.threadIds)];
    if (threadIds.length > 20 || threadIds.some((id) => !isUuid(id))) {
      throw new Error("Highlight thread membership is invalid");
    }
    const now = Date.now();
    let changed: boolean;
    let highlightRevision = input.expectedHighlightRevision;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const highlight = this.#database.prepare(
        `SELECT highlights.revision FROM highlights
         JOIN books ON books.id = highlights.book_id
         WHERE highlights.id = ? AND highlights.book_id = ?
           AND highlights.archived = 0 AND highlights.deleted = 0
           AND books.archived = 0 AND books.deleted_at IS NULL`,
      ).get(input.highlightId, input.bookId) as { revision: number } | undefined;
      if (!highlight || highlight.revision !== input.expectedHighlightRevision) {
        throw new Error("Highlight changed elsewhere or no longer exists");
      }
      const wanted = new Set(threadIds);
      for (const threadId of threadIds) this.#requireThread(threadId);
      const existingRows = this.#database.prepare(
        "SELECT thread_id FROM thread_highlights WHERE highlight_id = ?",
      ).all(input.highlightId) as unknown as Array<{ thread_id: string }>;
      if (existingRows.length > 20) throw new Error("Highlight belongs to too many threads");
      const existing = new Set(existingRows.map((row) => row.thread_id as ThreadId));
      const removed = [...existing].filter((id) => !wanted.has(id));
      const added = threadIds.filter((id) => !existing.has(id));
      for (const threadId of added) {
        const count = this.#database.prepare(
          "SELECT count(*) AS count FROM thread_highlights WHERE thread_id = ?",
        ).get(threadId) as { count: number };
        if (Number(count.count) >= 500) throw new Error("A thread can contain at most 500 passages");
      }
      changed = removed.length > 0 || added.length > 0;
      if (changed) {
        for (const threadId of removed) {
          this.#database.prepare(
            "DELETE FROM thread_highlights WHERE thread_id = ? AND highlight_id = ?",
          ).run(threadId, input.highlightId);
        }
        for (const threadId of added) {
          this.#database.prepare(
            "INSERT INTO thread_highlights (thread_id, highlight_id, added_at) VALUES (?, ?, ?)",
          ).run(threadId, input.highlightId, now);
        }
        for (const threadId of new Set([...removed, ...added])) {
          this.#database.prepare(
            "UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL",
          ).run(now, threadId);
        }
        const result = this.#database.prepare(
          `UPDATE highlights SET updated_at = ?, revision = revision + 1
           WHERE id = ? AND book_id = ? AND revision = ? AND archived = 0 AND deleted = 0`,
        ).run(now, input.highlightId, input.bookId, input.expectedHighlightRevision);
        if (Number(result.changes) !== 1) throw new Error("Highlight changed elsewhere or no longer exists");
        highlightRevision += 1;
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return { changed, bookId: input.bookId, highlightId: input.highlightId, highlightRevision, threadIds: this.getHighlightThreadIds(input.bookId, input.highlightId) };
  }

  listDailySelections(): DailySelection[] {
    const rows = this.#database.prepare(
      `SELECT id, local_day, timezone, highlight_id, candidate_digest,
              recent_highlight_ids_json, selected_at, updated_at, revision
       FROM daily_selections
       ORDER BY local_day DESC, timezone
       LIMIT 10001`,
    ).all() as unknown as DailySelectionRow[];
    if (rows.length > 10_000) throw new Error("Too many daily selections");
    return rows.map(mapDailySelection);
  }

  getDailyHighlight(timezone: string): DailyHighlight | undefined {
    const { localDay, timezone: canonicalTimezone } = resolveLocalDay(timezone, Date.now());
    return this.#dailyHighlightFor(localDay, canonicalTimezone);
  }

  ensureDailyHighlight(input: EnsureDailyHighlight): DailyHighlight | undefined {
    const now = Date.now();
    const { localDay, timezone } = resolveLocalDay(input.timezone, now);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const candidates = this.#dailyCandidateRows();
      const candidateDigest = fingerprint(candidates.map(({ id, bookId }) => [id, bookId]));
      const existingRow = this.#database.prepare(
        `SELECT id, local_day, timezone, highlight_id, candidate_digest,
                recent_highlight_ids_json, selected_at, updated_at, revision
         FROM daily_selections WHERE local_day = ? AND timezone = ?`,
      ).get(localDay, timezone) as DailySelectionRow | undefined;
      const existing = existingRow ? mapDailySelection(existingRow) : undefined;
      const currentIsEligible = existing?.highlightId !== undefined &&
        candidates.some((candidate) => candidate.id === existing.highlightId);
      const hasAlternative = existing?.highlightId !== undefined &&
        candidates.some((candidate) => candidate.id !== existing.highlightId);
      const emptySelectionIsCurrent = existing !== undefined && existing.highlightId === undefined &&
        candidates.length === 0 && existing.candidateDigest === candidateDigest;
      if (existing && (emptySelectionIsCurrent || (currentIsEligible && (!input.another || !hasAlternative)))) {
        this.#database.exec("COMMIT");
      } else {
        const previous = existing ?? this.#latestDailySelection(timezone);
        const recent = previous?.recentHighlightIds ?? [];
        const selectedId = chooseDailyHighlightId(candidates, recent, existing?.highlightId, {
          localDay,
          timezone,
          candidateDigest,
          revision: (existing?.revision ?? 0) + 1,
        });
        const nextRecent = selectedId
          ? [...recent.filter((id) => id !== selectedId), selectedId].slice(-7)
          : recent.slice(-7);
        if (existingRow) {
          const result = this.#database.prepare(
            `UPDATE daily_selections
             SET highlight_id = ?, candidate_digest = ?, recent_highlight_ids_json = ?,
                 selected_at = ?, updated_at = ?, revision = revision + 1
             WHERE local_day = ? AND timezone = ? AND revision = ?`,
          ).run(
            selectedId ?? null, candidateDigest, JSON.stringify(nextRecent), now, now,
            localDay, timezone, existingRow.revision,
          );
          if (Number(result.changes) !== 1) throw new Error("Daily selection changed elsewhere");
        } else {
          this.#database.prepare(
            `INSERT INTO daily_selections
              (id, local_day, timezone, highlight_id, candidate_digest,
               recent_highlight_ids_json, selected_at, updated_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(randomUUID(), localDay, timezone, selectedId ?? null, candidateDigest, JSON.stringify(nextRecent), now, now, now);
        }
        this.#database.exec("COMMIT");
      }
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.#dailyHighlightFor(localDay, timezone);
  }

  listCollections(): Collection[] {
    const rows = this.#database.prepare(
      `SELECT collections.id, collections.name, collections.description,
              collections.created_at, collections.updated_at, collections.revision,
              count(collection_books.book_id) AS book_count
       FROM collections
       LEFT JOIN collection_books ON collection_books.collection_id = collections.id
       WHERE collections.deleted_at IS NULL
       GROUP BY collections.id
       ORDER BY collections.normalized_name, collections.id`,
    ).all() as unknown as CollectionRow[];
    return rows.map(mapCollection);
  }

  listTags(): Tag[] {
    const rows = this.#database.prepare(
      `SELECT tags.id, tags.name, tags.color, tags.created_at, tags.updated_at, tags.revision,
              (SELECT count(*) FROM book_tags WHERE book_tags.tag_id = tags.id) AS book_count,
              (SELECT count(*) FROM highlight_tags WHERE highlight_tags.tag_id = tags.id) AS highlight_count
       FROM tags
       WHERE tags.deleted_at IS NULL
       ORDER BY tags.normalized_name, tags.id`,
    ).all() as unknown as TagRow[];
    return rows.map(mapTag);
  }

  getBookOrganization(id: BookId): BookOrganization | undefined {
    if (!this.getBook(id)) return undefined;
    const collectionIds = this.#database.prepare(
      `SELECT collection_books.collection_id AS id
       FROM collection_books JOIN collections ON collections.id = collection_books.collection_id
       WHERE collection_books.book_id = ? AND collections.deleted_at IS NULL
       ORDER BY collections.normalized_name, collections.id`,
    ).all(id) as unknown as Array<{ id: string }>;
    const tagIds = this.#database.prepare(
      `SELECT book_tags.tag_id AS id
       FROM book_tags JOIN tags ON tags.id = book_tags.tag_id
       WHERE book_tags.book_id = ? AND tags.deleted_at IS NULL
       ORDER BY tags.normalized_name, tags.id`,
    ).all(id) as unknown as Array<{ id: string }>;
    const highlightRows = this.#database.prepare(
      `SELECT highlight_tags.highlight_id, highlight_tags.tag_id
       FROM highlight_tags
       JOIN highlights ON highlights.id = highlight_tags.highlight_id
       JOIN tags ON tags.id = highlight_tags.tag_id
       WHERE highlights.book_id = ? AND highlights.archived = 0 AND highlights.deleted = 0
         AND tags.deleted_at IS NULL
       ORDER BY highlight_tags.highlight_id, tags.normalized_name, tags.id`,
    ).all(id) as unknown as Array<{ highlight_id: string; tag_id: string }>;
    const byHighlight = new Map<HighlightId, TagId[]>();
    for (const row of highlightRows) {
      const highlightId = row.highlight_id as HighlightId;
      const tags = byHighlight.get(highlightId) ?? [];
      tags.push(row.tag_id as TagId);
      byHighlight.set(highlightId, tags);
    }
    return {
      bookId: id,
      collectionIds: collectionIds.map((row) => row.id as CollectionId),
      tagIds: tagIds.map((row) => row.id as TagId),
      highlightTags: [...byHighlight].map(([highlightId, tags]) => ({ highlightId, tagIds: tags })),
    };
  }

  createCollection(input: NewCollection): Collection {
    const id = randomUUID() as CollectionId;
    const name = organizationName(input.name, "Collection", 120);
    const description = organizationOptionalText(input.description, "Collection description", 2_000);
    const normalizedName = normalizeOrganizationName(name);
    if (this.#database.prepare(
      "SELECT 1 FROM collections WHERE normalized_name = ? AND deleted_at IS NULL",
    ).get(normalizedName)) throw new Error("Collection name is already in use");
    const now = Date.now();
    this.#database.prepare(
      `INSERT INTO collections
        (id, name, normalized_name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, normalizedName, description ?? null, now, now);
    return this.#requireCollection(id);
  }

  updateCollection(input: UpdateCollection): Collection {
    requireRevision(input.expectedRevision, "Collection");
    const name = organizationName(input.name, "Collection", 120);
    const description = organizationOptionalText(input.description, "Collection description", 2_000);
    const normalizedName = normalizeOrganizationName(name);
    if (this.#database.prepare(
      "SELECT 1 FROM collections WHERE normalized_name = ? AND id != ? AND deleted_at IS NULL",
    ).get(normalizedName, input.id)) throw new Error("Collection name is already in use");
    const result = this.#database.prepare(
      `UPDATE collections
       SET name = ?, normalized_name = ?, description = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
    ).run(name, normalizedName, description ?? null, Date.now(), input.id, input.expectedRevision);
    if (Number(result.changes) !== 1) throw new Error("Collection changed elsewhere or no longer exists");
    return this.#requireCollection(input.id);
  }

  deleteCollection(input: DeleteCollection): void {
    requireRevision(input.expectedRevision, "Collection");
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const affectedBooks = this.#database.prepare(
        "SELECT book_id FROM collection_books WHERE collection_id = ?",
      ).all(input.id) as unknown as Array<{ book_id: string }>;
      const result = this.#database.prepare(
        `UPDATE collections SET deleted_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      ).run(now, now, input.id, input.expectedRevision);
      if (Number(result.changes) !== 1) throw new Error("Collection changed elsewhere or no longer exists");
      this.#database.prepare("DELETE FROM collection_books WHERE collection_id = ?").run(input.id);
      for (const { book_id: bookId } of affectedBooks) this.#touchOrganizationBook(bookId as BookId, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  createTag(input: NewTag): Tag {
    const id = randomUUID() as TagId;
    const name = organizationName(input.name, "Tag", 80);
    const color = organizationOptionalText(input.color, "Tag color", 32);
    const normalizedName = normalizeOrganizationName(name);
    if (this.#database.prepare(
      "SELECT 1 FROM tags WHERE normalized_name = ? AND deleted_at IS NULL",
    ).get(normalizedName)) throw new Error("Tag name is already in use");
    const now = Date.now();
    this.#database.prepare(
      `INSERT INTO tags (id, name, normalized_name, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, normalizedName, color ?? null, now, now);
    return this.#requireTag(id);
  }

  updateTag(input: UpdateTag): Tag {
    requireRevision(input.expectedRevision, "Tag");
    const name = organizationName(input.name, "Tag", 80);
    const color = organizationOptionalText(input.color, "Tag color", 32);
    const normalizedName = normalizeOrganizationName(name);
    if (this.#database.prepare(
      "SELECT 1 FROM tags WHERE normalized_name = ? AND id != ? AND deleted_at IS NULL",
    ).get(normalizedName, input.id)) throw new Error("Tag name is already in use");
    const result = this.#database.prepare(
      `UPDATE tags
       SET name = ?, normalized_name = ?, color = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
    ).run(name, normalizedName, color ?? null, Date.now(), input.id, input.expectedRevision);
    if (Number(result.changes) !== 1) throw new Error("Tag changed elsewhere or no longer exists");
    return this.#requireTag(input.id);
  }

  deleteTag(input: DeleteTag): void {
    requireRevision(input.expectedRevision, "Tag");
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const affectedBooks = this.#database.prepare(
        `SELECT book_id FROM book_tags WHERE tag_id = ?
         UNION
         SELECT highlights.book_id FROM highlight_tags
         JOIN highlights ON highlights.id = highlight_tags.highlight_id
         WHERE highlight_tags.tag_id = ?`,
      ).all(input.id, input.id) as unknown as Array<{ book_id: string }>;
      const affectedHighlights = this.#database.prepare(
        "SELECT highlight_id FROM highlight_tags WHERE tag_id = ?",
      ).all(input.id) as unknown as Array<{ highlight_id: string }>;
      const result = this.#database.prepare(
        `UPDATE tags SET deleted_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      ).run(now, now, input.id, input.expectedRevision);
      if (Number(result.changes) !== 1) throw new Error("Tag changed elsewhere or no longer exists");
      this.#database.prepare("DELETE FROM book_tags WHERE tag_id = ?").run(input.id);
      this.#database.prepare("DELETE FROM highlight_tags WHERE tag_id = ?").run(input.id);
      for (const { highlight_id: highlightId } of affectedHighlights) {
        this.#database.prepare(
          "UPDATE highlights SET updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted = 0",
        ).run(now, highlightId);
      }
      for (const { book_id: bookId } of affectedBooks) this.#touchOrganizationBook(bookId as BookId, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  setBookCollectionMembership(input: SetBookCollectionMembership): BookOrganization {
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireActiveBook(input.bookId);
      this.#requireCollection(input.collectionId);
      if (input.included) this.#requireMembershipCapacity(
        "collection_books", "book_id", input.bookId, "collection_id", input.collectionId, "collections",
      );
      const result = input.included
        ? this.#database.prepare(
          "INSERT OR IGNORE INTO collection_books (collection_id, book_id, created_at) VALUES (?, ?, ?)",
        ).run(input.collectionId, input.bookId, now)
        : this.#database.prepare("DELETE FROM collection_books WHERE collection_id = ? AND book_id = ?")
          .run(input.collectionId, input.bookId);
      if (Number(result.changes) === 1) {
        this.#database.prepare("UPDATE collections SET updated_at = ?, revision = revision + 1 WHERE id = ?")
          .run(now, input.collectionId);
        this.#touchOrganizationBook(input.bookId, now);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.getBookOrganization(input.bookId)!;
  }

  setBookTagMembership(input: SetBookTagMembership): BookOrganization {
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireActiveBook(input.bookId);
      this.#requireTag(input.tagId);
      if (input.included) this.#requireMembershipCapacity(
        "book_tags", "book_id", input.bookId, "tag_id", input.tagId, "tags",
      );
      const result = input.included
        ? this.#database.prepare("INSERT OR IGNORE INTO book_tags (tag_id, book_id, created_at) VALUES (?, ?, ?)")
          .run(input.tagId, input.bookId, now)
        : this.#database.prepare("DELETE FROM book_tags WHERE tag_id = ? AND book_id = ?")
          .run(input.tagId, input.bookId);
      if (Number(result.changes) === 1) {
        this.#database.prepare("UPDATE tags SET updated_at = ?, revision = revision + 1 WHERE id = ?")
          .run(now, input.tagId);
        this.#touchOrganizationBook(input.bookId, now);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.getBookOrganization(input.bookId)!;
  }

  setHighlightTagMembership(input: SetHighlightTagMembership): BookOrganization {
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireActiveBook(input.bookId);
      this.#requireHighlight(input.bookId, input.highlightId);
      this.#requireTag(input.tagId);
      if (input.included) this.#requireMembershipCapacity(
        "highlight_tags", "highlight_id", input.highlightId, "tag_id", input.tagId, "tags",
      );
      const result = input.included
        ? this.#database.prepare("INSERT OR IGNORE INTO highlight_tags (tag_id, highlight_id, created_at) VALUES (?, ?, ?)")
          .run(input.tagId, input.highlightId, now)
        : this.#database.prepare("DELETE FROM highlight_tags WHERE tag_id = ? AND highlight_id = ?")
          .run(input.tagId, input.highlightId);
      if (Number(result.changes) === 1) {
        this.#database.prepare("UPDATE tags SET updated_at = ?, revision = revision + 1 WHERE id = ?")
          .run(now, input.tagId);
        this.#database.prepare(
          "UPDATE highlights SET updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted = 0",
        ).run(now, input.highlightId);
        this.#touchOrganizationBook(input.bookId, now);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.getBookOrganization(input.bookId)!;
  }

  #requireMembershipCapacity(
    table: "collection_books" | "book_tags" | "highlight_tags",
    ownerColumn: "book_id" | "highlight_id",
    ownerId: string,
    containerColumn: "collection_id" | "tag_id",
    containerId: string,
    label: "collections" | "tags",
  ): void {
    const state = this.#database.prepare(
      `SELECT count(*) AS count,
         max(CASE WHEN ${containerColumn} = ? THEN 1 ELSE 0 END) AS included
       FROM ${table} WHERE ${ownerColumn} = ?`,
    ).get(containerId, ownerId) as { count: number; included: number | null };
    if (state.included !== 1 && Number(state.count) >= MAX_SYNC_ORGANIZATION_MEMBERSHIPS) {
      throw new Error(`An item can belong to at most ${MAX_SYNC_ORGANIZATION_MEMBERSHIPS} ${label}`);
    }
  }

  listImportSources(provider: ImportProvider): StoredImportSourceProfile[] {
    const rows = this.#database.prepare(
      `SELECT id, provider, display_name, path_hint_hash, updated_at
       FROM import_sources WHERE provider = ?
       ORDER BY updated_at DESC, display_name COLLATE NOCASE`,
    ).all(provider) as unknown as Array<{
      id: string;
      provider: ImportProvider;
      display_name: string;
      path_hint_hash: string | null;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      name: row.display_name,
      lastImportedAt: row.updated_at,
      ...(row.path_hint_hash ? { pathHintHash: row.path_hint_hash } : {}),
    }));
  }

  listImportConflicts(): ImportConflict[] {
    const rows = this.#database.prepare(
      `SELECT import_conflicts.id, import_sources.display_name AS source_name,
              books.title AS book_title, import_conflicts.highlight_id,
              import_conflicts.base_json, import_conflicts.local_json,
              import_conflicts.incoming_json, import_conflicts.created_at
       FROM import_conflicts
       JOIN import_sources ON import_sources.id = import_conflicts.source_id
       JOIN books ON books.id = import_conflicts.book_id
       WHERE import_conflicts.status = 'pending'
       ORDER BY import_conflicts.created_at DESC, import_conflicts.id`,
    ).all() as unknown as ConflictRow[];
    return rows.map((row) => ({
      id: row.id as ImportConflictId,
      sourceName: row.source_name,
      bookTitle: row.book_title,
      kind: row.highlight_id ? "highlight" : "note",
      base: parseStoredAnnotation(row.base_json),
      local: parseStoredAnnotation(row.local_json),
      incoming: parseStoredAnnotation(row.incoming_json),
      createdAt: row.created_at,
    }));
  }

  resolveImportConflict(input: ResolveImportConflict): boolean {
    if (!isUuid(input.id) || !["keep-local", "use-incoming"].includes(input.resolution)) {
      throw new Error("Import conflict resolution is invalid");
    }
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const conflict = this.#database.prepare(
        `SELECT import_conflicts.source_id, import_conflicts.provider_record_id,
                import_conflicts.book_id, import_conflicts.incoming_json,
                import_conflicts.incoming_fingerprint, import_conflicts.base_json,
                import_conflicts.local_json,
                source_annotations.highlight_id, source_annotations.note_id,
                source_annotations.attached_note_id, source_annotations.source_fingerprint,
                source_annotations.canonical_json, source_annotations.detached
         FROM import_conflicts
         JOIN source_annotations
           ON source_annotations.source_id = import_conflicts.source_id
          AND source_annotations.provider_record_id = import_conflicts.provider_record_id
         WHERE import_conflicts.id = ? AND import_conflicts.status = 'pending'`,
      ).get(input.id) as {
        source_id: string;
        provider_record_id: string;
        book_id: string;
        incoming_json: string;
        incoming_fingerprint: string;
        base_json: string;
        local_json: string;
        highlight_id: string | null;
        note_id: string | null;
        attached_note_id: string | null;
        source_fingerprint: string;
        canonical_json: string;
        detached: number;
      } | undefined;
      if (!conflict) throw new Error("Import conflict changed or no longer exists");
      const incoming = parseStoredAnnotation(conflict.incoming_json);
      const currentLocal = this.#localAnnotationSnapshot(
        conflict.book_id as BookId,
        conflict,
        parseStoredAnnotation(conflict.base_json),
      );
      if (fingerprint(currentLocal) !== fingerprint(parseStoredAnnotation(conflict.local_json))) {
        this.#database.prepare(
          "UPDATE import_conflicts SET status = 'superseded' WHERE id = ? AND status = 'pending'",
        ).run(input.id);
        this.#database.prepare(
          `INSERT INTO import_conflicts
            (id, source_id, provider_record_id, book_id, highlight_id, note_id,
             base_json, local_json, incoming_json, incoming_fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(), conflict.source_id, conflict.provider_record_id, conflict.book_id,
          conflict.highlight_id, conflict.note_id, conflict.base_json, JSON.stringify(currentLocal),
          conflict.incoming_json, conflict.incoming_fingerprint, now,
        );
        this.#database.exec("COMMIT");
        return false;
      }
      let attachedNoteId = conflict.attached_note_id;
      if (input.resolution === "use-incoming") {
        attachedNoteId = this.#applyIncomingConflict(conflict, incoming, now);
        this.#touchBook(conflict.book_id as BookId, now);
      }
      this.#database.prepare(
        `UPDATE source_annotations
         SET source_fingerprint = ?, canonical_json = ?, last_seen_at = ?,
             detached = ?, attached_note_id = ?
         WHERE source_id = ? AND provider_record_id = ?`,
      ).run(
        conflict.incoming_fingerprint,
        conflict.incoming_json,
        now,
        input.resolution === "keep-local" ? 1 : 0,
        attachedNoteId,
        conflict.source_id,
        conflict.provider_record_id,
      );
      this.#database.prepare(
        `UPDATE import_conflicts SET status = 'superseded'
         WHERE source_id = ? AND provider_record_id = ? AND status = 'pending' AND id != ?`,
      ).run(conflict.source_id, conflict.provider_record_id, input.id);
      const resolved = this.#database.prepare(
        `UPDATE import_conflicts
         SET status = 'resolved', resolution = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(input.resolution, now, input.id);
      if (Number(resolved.changes) !== 1) throw new Error("Import conflict changed or no longer exists");
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Pending sync conflicts beside what the library holds now. Each carries the
   * revision it was read at, so a resolution applies only to the state shown.
   */
  listSyncConflicts(limit = MAX_SYNC_CONFLICT_PAGE): SyncConflictPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYNC_CONFLICT_PAGE) {
      throw new Error("Sync conflict page size is invalid");
    }
    const localDeviceId = this.getSyncState().deviceId;
    const rows = this.#database.prepare(
      `SELECT id, entity_type, entity_id, book_id, losing_body, losing_device_id, created_at
       FROM sync_conflicts WHERE status = 'pending'
       ORDER BY created_at DESC, id LIMIT ?`,
    ).all(limit) as unknown as SyncConflictRow[];
    const total = Number((this.#database.prepare(
      "SELECT count(*) AS count FROM sync_conflicts WHERE status = 'pending'",
    ).get() as { count: number }).count);
    return {
      total,
      conflicts: rows.map((row) => {
        const current = this.#syncConflictTarget(row);
        return {
          id: row.id as SyncConflictId,
          kind: row.entity_type,
          bookId: current.bookId as BookId,
          ...(current.bookTitle === undefined ? {} : { bookTitle: current.bookTitle }),
          preservedBody: row.losing_body,
          preservedOnThisDevice: row.losing_device_id === localDeviceId,
          ...(current.body === undefined ? {} : { currentBody: current.body }),
          ...(current.passageText === undefined ? {} : { passageText: current.passageText }),
          restore: current.restore,
          currentRevision: current.revision,
          createdAt: row.created_at,
        };
      }),
    };
  }

  /**
   * Restore a preserved body under a new identity, which syncs like any other
   * local creation, or discard it. The winning item is never overwritten.
   * Either way the stored copy is cleared, but the fingerprint stays so a
   * redelivered change cannot raise the same review again. Returns false when
   * the item changed since it was shown.
   */
  resolveSyncConflict(input: ResolveSyncConflict): boolean {
    if (!isUuid(input.id) || !["restore", "discard"].includes(input.resolution) ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error("Sync conflict resolution is invalid");
    }
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare(
        `SELECT id, entity_type, entity_id, book_id, losing_body, losing_device_id, created_at
         FROM sync_conflicts WHERE id = ? AND status = 'pending'`,
      ).get(input.id) as SyncConflictRow | undefined;
      if (!row) throw new Error("Sync conflict changed or no longer exists");
      const target = this.#syncConflictTarget(row);
      if (target.revision !== input.expectedRevision) {
        this.#database.exec("COMMIT");
        return false;
      }
      if (input.resolution === "restore") {
        if (target.restore === "unavailable") throw new Error("This item's book is not available to restore into");
        const bookId = target.bookId as BookId;
        if (row.entity_type === "highlight") {
          const text = requiredText(row.losing_body, "Highlight", 100_000);
          const previous = this.#database.prepare(
            "SELECT source_location, source_created_at FROM highlights WHERE id = ?",
          ).get(row.entity_id) as { source_location: string | null; source_created_at: number | null } | undefined;
          this.#database.prepare(
            `INSERT INTO highlights (id, book_id, text, source_location, source_created_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(randomUUID(), bookId, text, previous?.source_location ?? null, previous?.source_created_at ?? null, now, now);
        } else {
          const markdown = requiredNote(row.losing_body);
          // Rejoin the note's passage when it still has room; otherwise keep
          // the writing as a note on the book rather than refusing it.
          const passage = this.#database.prepare(
            `SELECT notes.highlight_id AS id FROM notes
             JOIN highlights ON highlights.id = notes.highlight_id
             WHERE notes.id = ? AND highlights.book_id = ? AND highlights.deleted = 0 AND highlights.archived = 0`,
          ).get(row.entity_id, bookId) as { id: string } | undefined;
          const room = passage && Number((this.#database.prepare(
            "SELECT count(*) AS count FROM notes WHERE highlight_id = ? AND deleted = 0",
          ).get(passage.id) as { count: number }).count) < MAX_NOTES_PER_HIGHLIGHT;
          this.#database.prepare(
            `INSERT INTO notes (id, book_id, highlight_id, markdown, origin, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'reader', ?, ?)`,
          ).run(randomUUID(), bookId, room ? passage.id : null, markdown, now, now);
        }
        this.#touchBook(bookId, now);
      }
      const resolved = this.#database.prepare(
        `UPDATE sync_conflicts SET status = 'resolved', losing_body = '', winning_body = NULL
         WHERE id = ? AND status = 'pending'`,
      ).run(input.id);
      if (Number(resolved.changes) !== 1) throw new Error("Sync conflict changed or no longer exists");
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #syncConflictTarget(row: SyncConflictRow): {
    bookId: string;
    bookTitle?: string;
    body?: string;
    passageText?: string;
    restore: SyncConflict["restore"];
    revision: number;
  } {
    const entity = this.#database.prepare(row.entity_type === "highlight"
      ? "SELECT book_id, text AS body, deleted, revision, NULL AS highlight_id FROM highlights WHERE id = ?"
      : "SELECT book_id, markdown AS body, deleted, revision, highlight_id FROM notes WHERE id = ?",
    ).get(row.entity_id) as { book_id: string; body: string; deleted: number; revision: number; highlight_id: string | null } | undefined;
    const tombstone = entity ? undefined : this.#database.prepare(
      "SELECT book_id, revision FROM sync_tombstones WHERE entity_type = ? AND entity_id = ?",
    ).get(row.entity_type, row.entity_id) as { book_id: string; revision: number } | undefined;
    // A merge moves the live row, so its book outranks the one recorded with the conflict.
    const bookId = entity?.book_id ?? tombstone?.book_id ?? row.book_id;
    const book = this.#database.prepare(
      "SELECT title, archived FROM books WHERE id = ? AND deleted_at IS NULL",
    ).get(bookId) as { title: string; archived: number } | undefined;
    const present = entity !== undefined && entity.deleted === 0;
    const passage = entity?.highlight_id ? this.#database.prepare(
      "SELECT text FROM highlights WHERE id = ? AND deleted = 0",
    ).get(entity.highlight_id) as { text: string } | undefined : undefined;
    return {
      bookId,
      ...(book ? { bookTitle: book.title } : {}),
      ...(present ? { body: entity.body } : {}),
      ...(passage ? { passageText: passage.text } : {}),
      restore: !book || book.archived === 1 ? "unavailable" : "copy",
      revision: entity?.revision ?? tombstone?.revision ?? 0,
    };
  }

  /** Bounded note reads for local read-only integrations; never load all book passages. */
  listStandaloneNotes(id: BookId, options: { readonly limit: number; readonly offset: number }): readonly Note[] {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 51 || !Number.isInteger(options.offset) || options.offset < 0 || options.offset > 100000) throw new Error("Note page is invalid");
    return (this.#database.prepare(
      "SELECT id, book_id, highlight_id, markdown, origin, created_at, updated_at, revision FROM notes WHERE book_id = ? AND highlight_id IS NULL AND deleted = 0 ORDER BY created_at, id LIMIT ? OFFSET ?",
    ).all(id, options.limit, options.offset) as unknown as NoteRow[]).map(mapNote);
  }

  getBookContents(id: BookId): BookContents | undefined {
    const book = this.getBook(id);
    if (!book) return undefined;
    const highlightRows = this.#database.prepare(
      `SELECT id, book_id, text, source_location, source_created_at,
              created_at, updated_at, revision
       FROM highlights
       WHERE book_id = ? AND archived = 0 AND deleted = 0
       ORDER BY COALESCE(source_created_at, created_at), created_at, id`,
    ).all(id) as unknown as HighlightRow[];
    const notes = (this.#database.prepare(
      `SELECT id, book_id, highlight_id, markdown, origin, created_at, updated_at, revision
       FROM notes WHERE book_id = ? AND deleted = 0
       ORDER BY created_at, id`,
    ).all(id) as unknown as NoteRow[]).map(mapNote);
    const notesByHighlight = new Map<string, Note[]>();
    const standaloneNotes: Note[] = [];
    for (const note of notes) {
      if (!note.highlightId) {
        standaloneNotes.push(note);
        continue;
      }
      const attached = notesByHighlight.get(note.highlightId) ?? [];
      attached.push(note);
      notesByHighlight.set(note.highlightId, attached);
    }
    return {
      book,
      highlights: highlightRows.map((row) => ({
        id: row.id as HighlightId,
        bookId: row.book_id as BookId,
        text: row.text,
        ...(row.source_location ? { sourceLocation: row.source_location } : {}),
        ...(row.source_created_at !== null ? { sourceCreatedAt: row.source_created_at } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        revision: row.revision,
        notes: notesByHighlight.get(row.id) ?? [],
      })),
      standaloneNotes,
    };
  }

  listHighlights(query: HighlightQuery): HighlightPage {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HIGHLIGHT_PAGE ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new Error("Highlight page is invalid");
    }
    const search = query.search?.trim() ?? "";
    if (search.length > MAX_HIGHLIGHT_SEARCH_LENGTH) throw new Error("Highlight search is invalid");
    if (query.sort !== undefined && !["oldest", "newest", "updated", "relevance"].includes(query.sort)) {
      throw new Error("Highlight sort is invalid");
    }
    if (query.sort === "relevance" && !search) throw new Error("Relevance sorting requires a search");
    if ((query.dateFrom !== undefined && !Number.isSafeInteger(query.dateFrom)) ||
        (query.dateBefore !== undefined && !Number.isSafeInteger(query.dateBefore))) {
      throw new Error("Highlight date filter is invalid");
    }
    const conditions = ["highlights.archived = 0", "highlights.deleted = 0", "books.archived = 0"];
    const parameters: (string | number)[] = [];
    const imported = "EXISTS (SELECT 1 FROM source_annotations WHERE source_annotations.highlight_id = highlights.id)";
    if (query.bookId) {
      conditions.push("highlights.book_id = ?");
      parameters.push(query.bookId);
    }
    let escapedSearch = "";
    if (search) {
      escapedSearch = search.replace(/[\\%_]/gu, (character) => `\\${character}`);
      const pattern = `%${escapedSearch}%`;
      conditions.push(`(highlights.text LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM notes WHERE notes.highlight_id = highlights.id AND notes.deleted = 0
        AND notes.markdown LIKE ? ESCAPE '\\'))`);
      parameters.push(pattern, pattern);
    }
    if (query.source === "imported") conditions.push(imported);
    if (query.source === "manual") conditions.push(`NOT ${imported}`);
    const noted = "EXISTS (SELECT 1 FROM notes WHERE notes.highlight_id = highlights.id AND notes.deleted = 0)";
    if (query.notes === "with") conditions.push(noted);
    if (query.notes === "without") conditions.push(`NOT ${noted}`);
    if (query.tagId) {
      conditions.push("EXISTS (SELECT 1 FROM highlight_tags WHERE highlight_tags.highlight_id = highlights.id AND highlight_tags.tag_id = ?)");
      parameters.push(query.tagId);
    }
    if (query.dateFrom !== undefined || query.dateBefore !== undefined) {
      const from = query.dateFrom ?? Number.MIN_SAFE_INTEGER;
      const before = query.dateBefore ?? Number.MAX_SAFE_INTEGER;
      if (query.dateKind === "imported") {
        conditions.push(`EXISTS (SELECT 1 FROM source_annotations WHERE source_annotations.highlight_id = highlights.id
          AND source_annotations.last_seen_at >= ? AND source_annotations.last_seen_at < ?)`);
      } else {
        conditions.push("COALESCE(highlights.source_created_at, highlights.created_at) >= ? AND COALESCE(highlights.source_created_at, highlights.created_at) < ?");
      }
      parameters.push(from, before);
    }
    const orderParameters: string[] = [];
    const relevanceOrder = `CASE
      WHEN highlights.text = ? COLLATE NOCASE THEN 0
      WHEN highlights.text LIKE ? ESCAPE '\\' THEN 1
      WHEN highlights.text LIKE ? ESCAPE '\\' THEN 2
      WHEN EXISTS (SELECT 1 FROM notes WHERE notes.highlight_id = highlights.id AND notes.deleted = 0 AND notes.markdown = ? COLLATE NOCASE) THEN 3
      WHEN EXISTS (SELECT 1 FROM notes WHERE notes.highlight_id = highlights.id AND notes.deleted = 0 AND notes.markdown LIKE ? ESCAPE '\\') THEN 4
      ELSE 5 END,
      highlights.updated_at DESC, highlights.id DESC`;
    if (query.sort === "relevance") {
      orderParameters.push(search, `${escapedSearch}%`, `%${escapedSearch}%`, search, `${escapedSearch}%`);
    }
    const order = query.sort === "relevance"
      ? relevanceOrder
      : query.sort === "newest"
      ? "COALESCE(highlights.source_created_at, highlights.created_at) DESC, highlights.created_at DESC, highlights.id DESC"
      : query.sort === "updated"
        ? "highlights.updated_at DESC, highlights.id DESC"
        : "COALESCE(highlights.source_created_at, highlights.created_at), highlights.created_at, highlights.id";
    return this.readSnapshot(() => {
      const rows = this.#database.prepare(
        `SELECT highlights.id, highlights.book_id, highlights.text, highlights.source_location,
                highlights.source_created_at, highlights.created_at, highlights.updated_at,
                highlights.revision, books.title AS book_title, books.authors_json,
                ${imported} AS imported
         FROM highlights JOIN books ON books.id = highlights.book_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
      ).all(...parameters, ...orderParameters, limit + 1, offset) as unknown as (HighlightRow & {
        book_title: string;
        authors_json: string;
        imported: number;
      })[];
      const page = rows.slice(0, limit);
      const ids = page.map((row) => row.id);
      const notesByHighlight = new Map<string, Note[]>();
      const tagsByHighlight = new Map<string, TagId[]>();
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(", ");
        const notes = (this.#database.prepare(
          `SELECT id, book_id, highlight_id, markdown, origin, created_at, updated_at, revision
           FROM notes WHERE highlight_id IN (${placeholders}) AND deleted = 0
           ORDER BY created_at, id`,
        ).all(...ids) as unknown as NoteRow[]).map(mapNote);
        for (const note of notes) {
          const attached = notesByHighlight.get(note.highlightId!) ?? [];
          attached.push(note);
          notesByHighlight.set(note.highlightId!, attached);
        }
        const tagRows = this.#database.prepare(
          `SELECT highlight_tags.highlight_id, highlight_tags.tag_id
           FROM highlight_tags JOIN tags ON tags.id = highlight_tags.tag_id
           WHERE highlight_tags.highlight_id IN (${placeholders})
           ORDER BY tags.name COLLATE NOCASE`,
        ).all(...ids) as unknown as { highlight_id: string; tag_id: string }[];
        for (const row of tagRows) {
          const tagIds = tagsByHighlight.get(row.highlight_id) ?? [];
          tagIds.push(row.tag_id as TagId);
          tagsByHighlight.set(row.highlight_id, tagIds);
        }
      }
      return {
        entries: page.map((row) => ({
          id: row.id as HighlightId,
          bookId: row.book_id as BookId,
          text: row.text,
          ...(row.source_location ? { sourceLocation: row.source_location } : {}),
          ...(row.source_created_at !== null ? { sourceCreatedAt: row.source_created_at } : {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          revision: row.revision,
          notes: notesByHighlight.get(row.id) ?? [],
          bookTitle: row.book_title,
          authors: parseAuthors(row.authors_json, row.book_id),
          imported: row.imported === 1,
          tagIds: tagsByHighlight.get(row.id) ?? [],
        })),
        hasMore: rows.length > limit,
      };
    });
  }

  createHighlight(input: NewHighlight): BookContents["highlights"][number] {
    const text = requiredText(input.text, "Highlight", 100_000);
    const sourceLocation = optionalText(input.sourceLocation, 2_000);
    const noteMarkdown = input.noteMarkdown === undefined ? undefined : requiredNote(input.noteMarkdown);
    const id = randomUUID() as HighlightId;
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireActiveBook(input.bookId);
      this.#database.prepare(
        `INSERT INTO highlights
          (id, book_id, text, source_location, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.bookId, text, sourceLocation ?? null, now, now);
      if (noteMarkdown) {
        this.#database.prepare(
          `INSERT INTO notes (id, book_id, highlight_id, markdown, origin, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'reader', ?, ?)`,
        ).run(randomUUID(), input.bookId, id, noteMarkdown, now, now);
      }
      this.#touchBook(input.bookId, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.#requireHighlight(input.bookId, id);
  }

  updateHighlight(input: UpdateHighlight): BookContents["highlights"][number] {
    const text = requiredText(input.text, "Highlight", 100_000);
    const sourceLocation = optionalText(input.sourceLocation, 2_000);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("Highlight revision is invalid");
    }
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database.prepare(
        `UPDATE highlights
         SET text = ?, source_location = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND book_id = ? AND revision = ? AND archived = 0 AND deleted = 0`,
      ).run(text, sourceLocation ?? null, now, input.id, input.bookId, input.expectedRevision);
      if (Number(result.changes) !== 1) throw new Error("Highlight changed elsewhere or no longer exists");
      this.#database.prepare(
        "UPDATE source_annotations SET detached = 1 WHERE highlight_id = ?",
      ).run(input.id);
      this.#touchBook(input.bookId, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.#requireHighlight(input.bookId, input.id);
  }

  createNote(input: NewNote): Note {
    const markdown = requiredNote(input.markdown);
    const id = randomUUID() as NoteId;
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireActiveBook(input.bookId);
      if (input.highlightId) this.#requireHighlight(input.bookId, input.highlightId);
      if (input.highlightId) {
        const count = this.#database.prepare(
          "SELECT COUNT(*) AS count FROM notes WHERE highlight_id = ? AND deleted = 0",
        ).get(input.highlightId) as { count: number };
        if (Number(count.count) >= MAX_NOTES_PER_HIGHLIGHT) {
          throw new Error(`A passage can have at most ${MAX_NOTES_PER_HIGHLIGHT} active notes`);
        }
      }
      this.#database.prepare(
        `INSERT INTO notes
          (id, book_id, highlight_id, markdown, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.bookId, input.highlightId ?? null, markdown, input.origin ?? "reader", now, now);
      this.#touchBook(input.bookId, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.#requireNote(input.bookId, id);
  }

  updateNote(input: UpdateNote): Note {
    const markdown = requiredNote(input.markdown);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("Note revision is invalid");
    }
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const importedAttachment = this.#database.prepare(
        `SELECT highlight_id FROM notes
         WHERE id = ? AND book_id = ? AND revision = ? AND origin = 'import' AND deleted = 0`,
      ).get(input.id, input.bookId, input.expectedRevision) as { highlight_id: string | null } | undefined;
      const result = this.#database.prepare(
        `UPDATE notes
         SET markdown = ?, origin = 'reader', updated_at = ?, revision = revision + 1
         WHERE id = ? AND book_id = ? AND revision = ? AND deleted = 0`,
      ).run(markdown, now, input.id, input.bookId, input.expectedRevision);
      if (Number(result.changes) !== 1) throw new Error("Note changed elsewhere or no longer exists");
      this.#database.prepare("UPDATE source_annotations SET detached = 1 WHERE note_id = ?").run(input.id);
      if (importedAttachment?.highlight_id) {
        this.#database.prepare("UPDATE source_annotations SET detached = 1 WHERE highlight_id = ?")
          .run(importedAttachment.highlight_id);
      }
      this.#touchBook(input.bookId, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.#requireNote(input.bookId, input.id);
  }

  deleteHighlight(input: DeleteHighlight): AnnotationDeletionReceipt {
    requireRevision(input.expectedRevision, "Highlight");
    const now = Date.now();
    let notesDeleted: number;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireActiveBook(input.bookId);
      const result = this.#database.prepare(
        `UPDATE highlights SET deleted = 1, updated_at = ?, revision = revision + 1
         WHERE id = ? AND book_id = ? AND revision = ? AND archived = 0 AND deleted = 0`,
      ).run(now, input.id, input.bookId, input.expectedRevision);
      if (Number(result.changes) !== 1) throw new Error("Highlight changed elsewhere or no longer exists");
      const notes = this.#database.prepare(
        `UPDATE notes SET deleted = 1, updated_at = ?, revision = revision + 1
         WHERE highlight_id = ? AND deleted = 0`,
      ).run(now, input.id);
      notesDeleted = Number(notes.changes);
      // Memberships go with the passage, and every container whose contents
      // changed advances, exactly as an explicit removal would.
      const threads = this.#database.prepare(
        "SELECT thread_id FROM thread_highlights WHERE highlight_id = ?",
      ).all(input.id) as unknown as Array<{ thread_id: string }>;
      this.#database.prepare("DELETE FROM thread_highlights WHERE highlight_id = ?").run(input.id);
      for (const { thread_id: threadId } of threads) {
        this.#database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL")
          .run(now, threadId);
      }
      const tags = this.#database.prepare(
        "SELECT tag_id FROM highlight_tags WHERE highlight_id = ?",
      ).all(input.id) as unknown as Array<{ tag_id: string }>;
      this.#database.prepare("DELETE FROM highlight_tags WHERE highlight_id = ?").run(input.id);
      for (const { tag_id: tagId } of tags) {
        this.#database.prepare("UPDATE tags SET updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL")
          .run(now, tagId);
      }
      // The reader's deletion outranks later imports of the same record, and
      // any review still waiting for it no longer has anything to decide.
      this.#database.prepare("UPDATE source_annotations SET detached = 1 WHERE highlight_id = ?").run(input.id);
      this.#database.prepare(
        "UPDATE import_conflicts SET status = 'superseded' WHERE highlight_id = ? AND status = 'pending'",
      ).run(input.id);
      this.#touchBook(input.bookId, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return {
      bookId: input.bookId,
      bookRevision: this.getBook(input.bookId)!.revision,
      revision: input.expectedRevision + 1,
      notesDeleted,
      complete: true,
    };
  }

  deleteNote(input: DeleteNote): AnnotationDeletionReceipt {
    requireRevision(input.expectedRevision, "Note");
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireActiveBook(input.bookId);
      const note = this.#database.prepare(
        `SELECT highlight_id, origin FROM notes
         WHERE id = ? AND book_id = ? AND revision = ? AND deleted = 0`,
      ).get(input.id, input.bookId, input.expectedRevision) as { highlight_id: string | null; origin: string } | undefined;
      if (!note) throw new Error("Note changed elsewhere or no longer exists");
      this.#database.prepare(
        "UPDATE notes SET deleted = 1, updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(now, input.id);
      this.#database.prepare("UPDATE source_annotations SET detached = 1 WHERE note_id = ?").run(input.id);
      this.#database.prepare(
        "UPDATE import_conflicts SET status = 'superseded' WHERE note_id = ? AND status = 'pending'",
      ).run(input.id);
      // An imported note attached to a passage is re-supplied with that
      // passage; detaching the passage keeps a later import from restoring it.
      if (note.origin === "import" && note.highlight_id) {
        this.#database.prepare("UPDATE source_annotations SET detached = 1 WHERE highlight_id = ?").run(note.highlight_id);
      }
      this.#touchBook(input.bookId, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return { bookId: input.bookId, bookRevision: this.getBook(input.bookId)!.revision, revision: input.expectedRevision + 1, notesDeleted: 1, complete: true };
  }

  getHighlightSource(bookId: BookId, highlightId: HighlightId): HighlightSource | undefined {
    const origin = this.#latestHighlightOrigin(bookId, highlightId);
    if (!origin) return undefined;
    const highlight = this.#requireHighlight(bookId, highlightId);
    const attached = origin.link.attached_note_id
      ? highlight.notes.find(({ id }) => id === origin.link.attached_note_id)?.markdown
      : undefined;
    const sourceNote = importedNoteBody(origin.annotation.note);
    const differs = highlight.text !== origin.annotation.text ||
      (highlight.sourceLocation ?? undefined) !== origin.annotation.location ||
      attached !== sourceNote;
    return {
      sourceName: origin.sourceName,
      text: origin.annotation.text ?? "",
      ...(origin.annotation.location ? { location: origin.annotation.location } : {}),
      ...(sourceNote ? { note: sourceNote } : {}),
      differs,
      resetToken: this.#highlightResetToken(origin),
    };
  }

  /**
   * Replace an edited passage (and its imported note) with the latest imported
   * original, then let future imports update it again. The change is an
   * ordinary revision-checked edit, so it syncs like any other.
   */
  resetHighlightToSource(input: ResetHighlightToSource): BookContents["highlights"][number] {
    requireRevision(input.expectedRevision, "Highlight");
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireActiveBook(input.bookId);
      const origin = this.#latestHighlightOrigin(input.bookId, input.id);
      if (!origin?.annotation.text) throw new Error("This passage has no imported original");
      if (input.resetToken !== this.#highlightResetToken(origin)) {
        throw new Error("The imported original or its attached note changed after it was reviewed");
      }
      const result = this.#database.prepare(
        `UPDATE highlights SET text = ?, source_location = ?, source_created_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND book_id = ? AND revision = ? AND archived = 0 AND deleted = 0`,
      ).run(
        origin.annotation.text, origin.annotation.location ?? null, origin.annotation.createdAt ?? null, now,
        input.id, input.bookId, input.expectedRevision,
      );
      if (Number(result.changes) !== 1) throw new Error("Highlight changed elsewhere or no longer exists");
      const attachedNoteId = this.#reconcileImportedNote(
        input.bookId, input.id, origin.link.attached_note_id, origin.annotation.note, now, { notesCreated: 0 },
      );
      this.#database.prepare(
        `UPDATE source_annotations
         SET detached = 0, attached_note_id = ?, source_fingerprint = ?, canonical_json = ?, last_seen_at = ?
         WHERE source_id = ? AND provider_record_id = ?`,
      ).run(attachedNoteId, fingerprint(origin.annotation), JSON.stringify(origin.annotation), now, origin.sourceId, origin.providerRecordId);
      this.#database.prepare(
        "UPDATE import_conflicts SET status = 'superseded' WHERE highlight_id = ? AND status = 'pending'",
      ).run(input.id);
      this.#touchBook(input.bookId, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.#requireHighlight(input.bookId, input.id);
  }

  #latestHighlightOrigin(bookId: BookId, highlightId: HighlightId) {
    const link = this.#database.prepare(
      `SELECT source_annotations.source_id, source_annotations.provider_record_id,
              source_annotations.source_fingerprint, source_annotations.canonical_json,
              source_annotations.highlight_id, source_annotations.note_id,
              source_annotations.attached_note_id, source_annotations.detached,
              import_sources.display_name
       FROM source_annotations
       JOIN import_sources ON import_sources.id = source_annotations.source_id
       JOIN highlights ON highlights.id = source_annotations.highlight_id
       WHERE source_annotations.highlight_id = ? AND highlights.book_id = ? AND highlights.deleted = 0
       ORDER BY source_annotations.last_seen_at DESC LIMIT 1`,
    ).get(highlightId, bookId) as (SourceAnnotationLink & { source_id: string; provider_record_id: string; display_name: string }) | undefined;
    if (!link) return undefined;
    // A pending review holds the newest version the source sent.
    const pending = this.#database.prepare(
      `SELECT incoming_json FROM import_conflicts
       WHERE source_id = ? AND provider_record_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(link.source_id, link.provider_record_id) as { incoming_json: string } | undefined;
    return {
      link,
      sourceId: link.source_id,
      providerRecordId: link.provider_record_id,
      sourceName: link.display_name,
      annotation: parseStoredAnnotation(pending?.incoming_json ?? link.canonical_json),
    };
  }

  #highlightResetToken(origin: {
    readonly link: SourceAnnotationLink;
    readonly sourceId: string;
    readonly providerRecordId: string;
    readonly annotation: ImportAnnotation;
  }): string {
    const note = origin.link.attached_note_id ? this.#database.prepare(
      "SELECT id, markdown, origin, revision, deleted FROM notes WHERE id = ?",
    ).get(origin.link.attached_note_id) as {
      id: string;
      markdown: string;
      origin: string;
      revision: number;
      deleted: number;
    } | undefined : undefined;
    return fingerprint({
      sourceId: origin.sourceId,
      providerRecordId: origin.providerRecordId,
      annotation: origin.annotation,
      attachedNote: note ?? null,
    });
  }

  setBookArchived(input: SetBookArchived): BookArchiveChange {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("Book revision is invalid");
    }
    const now = Date.now();
    const result = this.#database.prepare(
      `UPDATE books SET archived = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ? AND archived != ?
       RETURNING id, archived, revision, updated_at`,
    ).get(input.archived ? 1 : 0, now, input.id, input.expectedRevision, input.archived ? 1 : 0) as
      | { id: string; archived: number; revision: number; updated_at: number }
      | undefined;
    if (!result) throw new Error("Book changed elsewhere or is already in that shelf");
    return {
      bookId: result.id as BookId,
      archived: result.archived === 1,
      revision: result.revision,
      updatedAt: result.updated_at,
    };
  }

  mergeBooks(input: MergeBooks): MergeBooksReceipt {
    if (input.sourceBookId === input.targetBookId) throw new Error("Choose two different books");
    if (![input.expectedSourceRevision, input.expectedTargetRevision].every((revision) => Number.isSafeInteger(revision) && revision > 0)) {
      throw new Error("Book revision is invalid");
    }
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const [table, containerColumn, label] of [
        ["collection_books", "collection_id", "collections"],
        ["book_tags", "tag_id", "tags"],
      ] as const) {
        const union = this.#database.prepare(
          `SELECT count(DISTINCT ${containerColumn}) AS count FROM ${table} WHERE book_id IN (?, ?)`,
        ).get(input.sourceBookId, input.targetBookId) as { count: number };
        if (Number(union.count) > MAX_SYNC_ORGANIZATION_MEMBERSHIPS) {
          throw new Error(`A merged book can belong to at most ${MAX_SYNC_ORGANIZATION_MEMBERSHIPS} ${label}`);
        }
      }
      const target = this.#database.prepare(
        `UPDATE books SET updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND archived = 0
         RETURNING status, completed_on, revision`,
      ).get(now, input.targetBookId, input.expectedTargetRevision) as
        | { status: ReadingStatus; completed_on: string | null; revision: number }
        | undefined;
      if (!target) throw new Error("Target book changed or no longer exists");

      const source = this.#database.prepare(
        `UPDATE books SET archived = 1, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND archived = 0
         RETURNING revision`,
      ).get(now, input.sourceBookId, input.expectedSourceRevision) as { revision: number } | undefined;
      if (!source) throw new Error("Source book changed or no longer exists");

      const affectedCollections = this.#database.prepare(
        "SELECT collection_id AS id FROM collection_books WHERE book_id = ?",
      ).all(input.sourceBookId) as unknown as Array<{ id: string }>;
      const affectedTags = this.#database.prepare(
        "SELECT tag_id AS id FROM book_tags WHERE book_id = ?",
      ).all(input.sourceBookId) as unknown as Array<{ id: string }>;

      const highlights = this.#database.prepare(
        `UPDATE highlights SET book_id = ?, updated_at = ?, revision = revision + 1
         WHERE book_id = ?`,
      ).run(input.targetBookId, now, input.sourceBookId);
      const notes = this.#database.prepare(
        `UPDATE notes SET book_id = ?, updated_at = ?, revision = revision + 1
         WHERE book_id = ?`,
      ).run(input.targetBookId, now, input.sourceBookId);
      this.#database.prepare("UPDATE source_books SET book_id = ? WHERE book_id = ?")
        .run(input.targetBookId, input.sourceBookId);
      this.#database.prepare("UPDATE import_conflicts SET book_id = ? WHERE book_id = ? AND status = 'pending'")
        .run(input.targetBookId, input.sourceBookId);
      this.#database.prepare("UPDATE sync_conflicts SET book_id = ? WHERE book_id = ? AND status = 'pending'")
        .run(input.targetBookId, input.sourceBookId);
      const statusEvents = this.#database.prepare(
        "SELECT count(*) AS count FROM reading_status_events WHERE book_id IN (?, ?)",
      ).get(input.sourceBookId, input.targetBookId) as { count: number };
      if (Number(statusEvents.count) + 1 > MAX_STATUS_EVENTS_PER_BOOK) {
        throw new Error(`A merged book can keep at most ${MAX_STATUS_EVENTS_PER_BOOK} reading-status changes`);
      }
      this.#database.prepare("UPDATE reading_status_events SET book_id = ? WHERE book_id = ?")
        .run(input.targetBookId, input.sourceBookId);
      if (statusEvents.count > 0) {
        this.#database.prepare(
          `INSERT INTO reading_status_events
            (id, book_id, status, source, changed_at, completed_on, book_revision)
           VALUES (?, ?, ?, 'merge', ?, ?, ?)`,
        ).run(randomUUID(), input.targetBookId, target.status, now, target.completed_on, target.revision);
      }
      this.#database.prepare(
        `INSERT OR IGNORE INTO collection_books (collection_id, book_id, created_at)
         SELECT collection_id, ?, created_at FROM collection_books WHERE book_id = ?`,
      ).run(input.targetBookId, input.sourceBookId);
      this.#database.prepare("DELETE FROM collection_books WHERE book_id = ?").run(input.sourceBookId);
      this.#database.prepare(
        `INSERT OR IGNORE INTO book_tags (tag_id, book_id, created_at)
         SELECT tag_id, ?, created_at FROM book_tags WHERE book_id = ?`,
      ).run(input.targetBookId, input.sourceBookId);
      this.#database.prepare("DELETE FROM book_tags WHERE book_id = ?").run(input.sourceBookId);
      for (const { id } of affectedCollections) {
        this.#database.prepare("UPDATE collections SET updated_at = ?, revision = revision + 1 WHERE id = ?")
          .run(now, id);
      }
      for (const { id } of affectedTags) {
        this.#database.prepare("UPDATE tags SET updated_at = ?, revision = revision + 1 WHERE id = ?")
          .run(now, id);
      }
      this.#database.exec("COMMIT");
      return {
        sourceBookId: input.sourceBookId,
        targetBookId: input.targetBookId,
        highlightsMoved: Number(highlights.changes),
        notesMoved: Number(notes.changes),
        sourceRevision: source.revision,
        targetRevision: target.revision,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Candidate selection is reviewed by the reader; metadata alone never merges books. */
  reviewImportBooks(document: ImportDocument, provider: ImportProvider): ImportBookMatch[] {
    const byTitle = new Map<string, Book[]>();
    const byIsbn = new Map<string, Book[]>();
    const all = new Map<BookId, Book>();
    for (const book of this.listBooks({ includeArchived: true })) {
      all.set(book.id, book);
      const title = normalizeBookText(book.title);
      byTitle.set(title, [...(byTitle.get(title) ?? []), book]);
      if (book.isbn13) byIsbn.set(book.isbn13, [...(byIsbn.get(book.isbn13) ?? []), book]);
    }
    const incomingIds = new Set(document.books.map((book) => book.providerRecordId));
    const sourceLinks = new Map<string, { sourceId: string; bookId: BookId }[]>();
    for (const row of this.#database.prepare("SELECT provider_record_id, source_id, book_id FROM source_books JOIN import_sources ON import_sources.id=source_books.source_id WHERE import_sources.provider=?").iterate(provider) as Iterable<{ provider_record_id: string; source_id: string; book_id: BookId }>) {
      if (!incomingIds.has(row.provider_record_id) || !all.has(row.book_id)) continue;
      sourceLinks.set(row.provider_record_id, [...(sourceLinks.get(row.provider_record_id) ?? []), { sourceId: row.source_id, bookId: row.book_id }]);
    }
    // Metadata can have been edited on the first computer. Build a bounded
    // lookup of the incoming quotation/date keys and scan existing passages once.
    const wanted = new Set<string>();
    const keysByBook = new Map<string, Set<string>>();
    for (const annotation of document.annotations) {
      if (!annotation.text || annotation.createdAt === undefined) continue;
      const key = fingerprint([annotation.text, annotation.createdAt]);
      wanted.add(key);
      const keys = keysByBook.get(annotation.bookProviderRecordId) ?? new Set<string>();
      keys.add(key); keysByBook.set(annotation.bookProviderRecordId, keys);
    }
    const evidence = new Map<string, Set<BookId>>();
    if (all.size && wanted.size) for (const row of this.#database.prepare("SELECT book_id, text, source_created_at FROM highlights WHERE source_created_at IS NOT NULL AND deleted=0").iterate() as Iterable<{ book_id: BookId; text: string; source_created_at: number }>) {
      if (!all.has(row.book_id)) continue;
      const key = fingerprint([row.text, row.source_created_at]);
      if (!wanted.has(key)) continue;
      const ids = evidence.get(key) ?? new Set<BookId>(); ids.add(row.book_id); evidence.set(key, ids);
    }
    return document.books.flatMap((incoming) => {
      const links = sourceLinks.get(incoming.providerRecordId) ?? [];
      const authors = new Set(incoming.authors.map(normalizeBookText));
      const isbn = incoming.isbn13 ? normalizeIsbn13(incoming.isbn13) : undefined;
      const candidates = new Map<BookId, Book>();
      for (const book of [...(isbn ? byIsbn.get(isbn) ?? [] : []), ...(byTitle.get(normalizeBookText(incoming.title)) ?? [])]) {
        if (isbn && book.isbn13 && isbn !== book.isbn13) continue;
        if (!(isbn && isbn === book.isbn13) && (!authors.size || !book.authors.some((author) => authors.has(normalizeBookText(author))))) continue;
        candidates.set(book.id, book);
      }
      const passageMatches = new Set<BookId>();
      for (const key of keysByBook.get(incoming.providerRecordId) ?? []) for (const id of evidence.get(key) ?? []) passageMatches.add(id);
      if (passageMatches.size) {
        candidates.clear();
        for (const id of passageMatches) candidates.set(id, all.get(id)!);
      }
      for (const link of links) candidates.set(link.bookId, all.get(link.bookId)!);
      return candidates.size ? [{ providerRecordId: incoming.providerRecordId, links, candidates: [...candidates.values()].slice(0, 20).map(({ id, title, authors, archived }) => ({ bookId: id, title, authors, archived })) }] : [];
    });
  }

  importDocument(input: {
    readonly document: ImportDocument;
    readonly bookSelections?: readonly ImportBookSelection[];
    readonly fileName: string;
    readonly provider: ImportProvider;
    readonly source: {
      readonly id: string;
      readonly name?: string;
      readonly pathHintHash?: string;
    };
    readonly warnings: readonly ImportWarning[];
  }): ImportReceipt {
    assertUniqueImportIds(input.document);
    const receipt = {
      booksCreated: 0,
      booksReused: 0,
      highlightsCreated: 0,
      annotationsUpdated: 0,
      notesCreated: 0,
      conflictsCreated: 0,
    };
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const sourceId = this.#sourceId(input.provider, input.source, now);
      const localBooks = new Map<string, BookId>();
      const selections = new Map((input.bookSelections ?? []).map((selection) => [selection.providerRecordId, selection.bookId]));
      if (selections.size !== (input.bookSelections?.length ?? 0) || [...selections.keys()].some((id) => !input.document.books.some((book) => book.providerRecordId === id))) throw new Error("Import book selection is invalid.");
      const recoveredBooks = new Set<BookId>();
      const adoptedHighlights = new Set<string>();
      const adoptedNotes = new Set<string>();
      const incomingPassages = new Map<string, number>();
      for (const annotation of input.document.annotations) {
        const key = fingerprint([annotation.bookProviderRecordId, annotation.text, annotation.createdAt]);
        incomingPassages.set(key, (incomingPassages.get(key) ?? 0) + 1);
      }

      for (const incoming of input.document.books) {
        const linked = this.#database
          .prepare("SELECT book_id FROM source_books WHERE source_id = ? AND provider_record_id = ?")
          .get(sourceId, incoming.providerRecordId) as { book_id: string } | undefined;
        let bookId: BookId;
        if (linked) {
          bookId = linked.book_id as BookId;
          receipt.booksReused += 1;
          // The book keeps the reader's metadata; only the remembered source
          // values advance, so a later field reset offers the newest ones.
          this.#database.prepare(
            `UPDATE source_books SET source_fingerprint = ?, canonical_json = ?, last_seen_at = ?
             WHERE source_id = ? AND provider_record_id = ?`,
          ).run(fingerprint(incoming), JSON.stringify(incoming), now, sourceId, incoming.providerRecordId);
        } else {
          const selected = selections.get(incoming.providerRecordId);
          if (selected) {
            if (!isUuid(selected) || !this.#database.prepare("SELECT id FROM books WHERE id=? AND deleted_at IS NULL").get(selected)) throw new Error("The reviewed book is no longer available.");
            bookId = selected;
            recoveredBooks.add(bookId);
            receipt.booksReused += 1;
          } else {
          bookId = randomUUID() as BookId;
          this.#database.prepare(
            `INSERT INTO books
              (id, title, authors_json, description, publisher, series, series_number,
               language, isbn13, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            bookId,
            incoming.title.trim() || "Untitled book",
            JSON.stringify(incoming.authors),
            incoming.description ?? null,
            incoming.publisher ?? null,
            incoming.series ?? null,
            incoming.seriesNumber ?? null,
            incoming.language ?? null,
            incoming.isbn13 ?? null,
            incoming.status ?? "unread",
            now,
            now,
          );
          receipt.booksCreated += 1;
          }
          this.#database.prepare(
            `INSERT INTO source_books
              (source_id, provider_record_id, book_id, source_fingerprint, canonical_json, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            sourceId,
            incoming.providerRecordId,
            bookId,
            fingerprint(incoming),
            JSON.stringify(incoming),
            now,
          );
        }
        localBooks.set(incoming.providerRecordId, bookId);
      }

      for (const incoming of input.document.annotations) {
        const bookId = localBooks.get(incoming.bookProviderRecordId);
        if (!bookId) throw new Error("Import annotation refers to an unavailable book");
        const incomingFingerprint = fingerprint(incoming);
        const linked = this.#database.prepare(
          `SELECT source_fingerprint, canonical_json, highlight_id, note_id, attached_note_id, detached
           FROM source_annotations WHERE source_id = ? AND provider_record_id = ?`,
        ).get(sourceId, incoming.providerRecordId) as SourceAnnotationLink | undefined;

        if (linked) {
          if (linked.source_fingerprint === incomingFingerprint) continue;
          if (this.#linkedAnnotationDeleted(linked)) {
            // The reader deleted this record; a changed source must neither
            // restore it nor raise a conflict about something no longer kept.
            this.#database.prepare(
              "UPDATE source_annotations SET last_seen_at = ? WHERE source_id = ? AND provider_record_id = ?",
            ).run(now, sourceId, incoming.providerRecordId);
            continue;
          }
          if (linked.detached === 1) {
            if (this.#recordImportConflict(sourceId, incoming.providerRecordId, bookId, linked, incoming, incomingFingerprint, now)) {
              receipt.conflictsCreated += 1;
            }
            continue;
          }
          if (incoming.text && linked.highlight_id) {
            const update = this.#database.prepare(
              `UPDATE highlights SET text = ?, source_location = ?, source_created_at = ?,
                 updated_at = ?, revision = revision + 1 WHERE id = ? AND book_id = ?`,
            ).run(
              incoming.text,
              incoming.location ?? null,
              incoming.createdAt ?? null,
              now,
              linked.highlight_id,
              bookId,
            );
            if (Number(update.changes) !== 1) throw new Error("Imported highlight moved or no longer exists");
            const attachedNoteId = this.#reconcileImportedNote(bookId, linked.highlight_id, linked.attached_note_id, incoming.note, now, receipt);
            this.#database.prepare(
              "UPDATE source_annotations SET attached_note_id = ? WHERE source_id = ? AND provider_record_id = ?",
            ).run(attachedNoteId, sourceId, incoming.providerRecordId);
          } else if (!incoming.text && importedNoteBody(incoming.note) && linked.note_id) {
            const update = this.#database.prepare(
              `UPDATE notes SET markdown = ?, updated_at = ?, revision = revision + 1
               WHERE id = ? AND book_id = ? AND highlight_id IS NULL AND origin = 'import'
                 AND deleted = 0 AND markdown != ?`,
            ).run(requiredNote(importedNoteBody(incoming.note)!), now, linked.note_id, bookId, requiredNote(importedNoteBody(incoming.note)!));
            if (Number(update.changes) !== 1 && !this.#importedNoteMatches(linked.note_id, bookId, requiredNote(importedNoteBody(incoming.note)!))) {
              throw new Error("Imported note moved, changed, or no longer exists");
            }
          } else if (!incoming.text && !importedNoteBody(incoming.note) && linked.note_id) {
            // A blank source value means "no incoming note", not permission to
            // destroy the last imported body. Retain it until a non-blank
            // source revision replaces it or the reader explicitly deletes it.
          } else {
            throw new Error("An imported annotation changed between note and highlight form");
          }
          this.#updateSourceAnnotation(sourceId, incoming.providerRecordId, incomingFingerprint, incoming, now);
          receipt.annotationsUpdated += 1;
          continue;
        }

        // A synced book has no local import provenance on a new installation.
        // Adopt a unique quotation/source-date match; keep any local location edit.
        // Repeated passages need a unique exact location as well.
        if (recoveredBooks.has(bookId) && incoming.text && incoming.createdAt !== undefined) {
          type ExistingPassage = { id: string; deleted: number; source_location: string | null };
          const exact = this.#database.prepare(
            "SELECT id, deleted, source_location FROM highlights WHERE book_id=? AND text=? AND source_created_at=? AND source_location IS ? LIMIT 2",
          ).all(bookId, incoming.text, incoming.createdAt, incoming.location ?? null) as ExistingPassage[];
          const fallback = exact.length === 0 && incomingPassages.get(fingerprint([incoming.bookProviderRecordId, incoming.text, incoming.createdAt])) === 1
            ? this.#database.prepare("SELECT id, deleted, source_location FROM highlights WHERE book_id=? AND text=? AND source_created_at=? LIMIT 2").all(bookId, incoming.text, incoming.createdAt) as ExistingPassage[] : [];
          const match = exact.length === 1 ? exact[0] : fallback.length === 1 ? fallback[0] : undefined;
          if (match && !adoptedHighlights.has(match.id)) {
            adoptedHighlights.add(match.id);
            const notes = importedNoteBody(incoming.note) ? this.#database.prepare(
              "SELECT id FROM notes WHERE book_id=? AND highlight_id=? AND markdown=? AND origin='import' AND deleted=0 LIMIT 2",
            ).all(bookId, match.id, importedNoteBody(incoming.note)!) as { id: string }[] : [];
            const attachedNoteId = notes.length === 1 && !adoptedNotes.has(notes[0]!.id) ? notes[0]!.id : match.deleted ? null : this.#reconcileImportedNote(bookId, match.id, null, incoming.note, now, receipt);
            if (attachedNoteId) adoptedNotes.add(attachedNoteId);
            this.#insertSourceAnnotation(sourceId, incoming.providerRecordId, match.id, null, attachedNoteId, incomingFingerprint, incoming, now);
            if (match.source_location !== (incoming.location ?? null)) this.#database.prepare("UPDATE source_annotations SET detached=1 WHERE source_id=? AND provider_record_id=?").run(sourceId, incoming.providerRecordId);
            continue;
          }
        }

        if (recoveredBooks.has(bookId) && !incoming.text && importedNoteBody(incoming.note)) {
          const notes = this.#database.prepare(
            "SELECT id FROM notes WHERE book_id=? AND highlight_id IS NULL AND markdown=? AND origin='import' LIMIT 2",
          ).all(bookId, importedNoteBody(incoming.note)!) as { id: string }[];
          if (notes.length === 1 && !adoptedNotes.has(notes[0]!.id)) {
            adoptedNotes.add(notes[0]!.id);
            this.#insertSourceAnnotation(sourceId, incoming.providerRecordId, null, notes[0]!.id, null, incomingFingerprint, incoming, now);
            continue;
          }
        }

        if (incoming.text) {
          const highlightId = randomUUID();
          this.#database.prepare(
            `INSERT INTO highlights
              (id, book_id, text, source_location, source_created_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            highlightId,
            bookId,
            incoming.text,
            incoming.location ?? null,
            incoming.createdAt ?? null,
            now,
            now,
          );
          const attachedNoteId = this.#reconcileImportedNote(bookId, highlightId, null, incoming.note, now, receipt);
          this.#insertSourceAnnotation(sourceId, incoming.providerRecordId, highlightId, null, attachedNoteId, incomingFingerprint, incoming, now);
          receipt.highlightsCreated += 1;
        } else if (importedNoteBody(incoming.note)) {
          const noteId = randomUUID();
          this.#database.prepare(
            `INSERT INTO notes (id, book_id, highlight_id, markdown, origin, created_at, updated_at)
             VALUES (?, ?, NULL, ?, 'import', ?, ?)`,
          ).run(noteId, bookId, requiredNote(importedNoteBody(incoming.note)!), now, now);
          this.#insertSourceAnnotation(sourceId, incoming.providerRecordId, null, noteId, null, incomingFingerprint, incoming, now);
          receipt.notesCreated += 1;
        }
      }

      this.#database.prepare(
        `INSERT INTO import_runs
          (id, source_id, file_name, provider, format_version, status, books_created,
           books_reused, highlights_created, annotations_updated, notes_created,
           warnings_json, created_at, conflicts_created)
         VALUES (?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(), sourceId, input.fileName, input.provider, input.document.formatVersion,
        receipt.booksCreated, receipt.booksReused, receipt.highlightsCreated,
        receipt.annotationsUpdated, receipt.notesCreated, JSON.stringify(input.warnings), now,
        receipt.conflictsCreated,
      );
      this.#database.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async backupTo(path: string): Promise<void> {
    await backup(this.#database, path);
  }

  #dailyCandidateRows(): DailyCandidateRow[] {
    const rows = this.#database.prepare(
      `SELECT highlights.id, highlights.book_id AS bookId
       FROM highlights
       JOIN books ON books.id = highlights.book_id
       WHERE highlights.archived = 0 AND highlights.deleted = 0
         AND length(trim(highlights.text)) > 0
         AND books.archived = 0 AND books.deleted_at IS NULL
       ORDER BY highlights.book_id, highlights.id
       LIMIT 10001`,
    ).all() as unknown as Array<{ id: string; bookId: string }>;
    if (rows.length > 10_000 || new Set(rows.map((row) => row.bookId)).size > 500) {
      throw new Error("Library is too large for daily selection");
    }
    return rows.map((row) => ({ id: row.id as HighlightId, bookId: row.bookId as BookId }));
  }

  #dailyHighlightFor(localDay: string, timezone: string): DailyHighlight | undefined {
    const row = this.#database.prepare(
      `SELECT id, local_day, timezone, highlight_id, candidate_digest,
              recent_highlight_ids_json, selected_at, updated_at, revision
       FROM daily_selections WHERE local_day = ? AND timezone = ?`,
    ).get(localDay, timezone) as DailySelectionRow | undefined;
    if (!row?.highlight_id) return undefined;
    const passage = this.#dailyPassage(row.highlight_id as HighlightId);
    if (!passage) return undefined;
    const candidates = this.#dailyCandidateRows();
    return {
      selection: mapDailySelection(row),
      passage,
      hasAlternatives: candidates.some((candidate) => candidate.id !== row.highlight_id),
    };
  }

  #latestDailySelection(timezone: string): DailySelection | undefined {
    const row = this.#database.prepare(
      `SELECT id, local_day, timezone, highlight_id, candidate_digest,
              recent_highlight_ids_json, selected_at, updated_at, revision
       FROM daily_selections WHERE timezone = ?
       ORDER BY local_day DESC LIMIT 1`,
    ).get(timezone) as DailySelectionRow | undefined;
    return row ? mapDailySelection(row) : undefined;
  }

  #dailyPassage(highlightId: HighlightId): DailyPassage | undefined {
    const row = this.#database.prepare(
      `SELECT highlights.book_id, highlights.text, highlights.source_location,
              books.title AS book_title, books.authors_json
       FROM highlights
       JOIN books ON books.id = highlights.book_id
       WHERE highlights.id = ? AND highlights.archived = 0 AND highlights.deleted = 0
         AND books.archived = 0 AND books.deleted_at IS NULL`,
    ).get(highlightId) as {
      book_id: string;
      text: string;
      source_location: string | null;
      book_title: string;
      authors_json: string;
    } | undefined;
    if (!row) return undefined;
    let payloadBytes = utf8Bytes(row.text, row.book_title, row.authors_json, row.source_location ?? "");
    if (payloadBytes > MAX_DAILY_PASSAGE_BYTES) throw new Error("Daily passage is too large");
    const noteRows = this.#database.prepare(
      `SELECT id, book_id, highlight_id, markdown, origin, created_at, updated_at, revision
       FROM notes WHERE highlight_id = ? AND deleted = 0
       ORDER BY created_at, id LIMIT 101`,
    ).iterate(highlightId) as Iterable<NoteRow>;
    const notes: Note[] = [];
    for (const noteRow of noteRows) {
      if (notes.length >= 100) throw new Error("Daily passage contains too many notes");
      payloadBytes += utf8Bytes(noteRow.markdown);
      if (payloadBytes > MAX_DAILY_PASSAGE_BYTES) throw new Error("Daily passage is too large");
      notes.push(mapNote(noteRow));
    }
    return {
      highlightId,
      bookId: row.book_id as BookId,
      bookTitle: row.book_title,
      authors: parseAuthors(row.authors_json, row.book_id),
      text: row.text,
      ...(row.source_location ? { sourceLocation: row.source_location } : {}),
      notes,
    };
  }

  #requireActiveBook(id: BookId): void {
    const row = this.#database.prepare("SELECT id FROM books WHERE id = ? AND archived = 0").get(id);
    if (!row) throw new Error("Book no longer exists");
  }

  /** True when a live imported note already holds exactly this body. */
  #importedNoteMatches(noteId: string, bookId: BookId, markdown: string): boolean {
    const row = this.#database.prepare(
      `SELECT 1 AS present FROM notes
       WHERE id = ? AND book_id = ? AND highlight_id IS NULL AND origin = 'import'
         AND deleted = 0 AND markdown = ?`,
    ).get(noteId, bookId, markdown);
    return row !== undefined;
  }

  #linkedAnnotationDeleted(linked: SourceAnnotationLink): boolean {
    const row = linked.highlight_id
      ? this.#database.prepare("SELECT deleted FROM highlights WHERE id = ?").get(linked.highlight_id)
      : linked.note_id
        ? this.#database.prepare("SELECT deleted FROM notes WHERE id = ?").get(linked.note_id)
        : undefined;
    return (row as { deleted: number } | undefined)?.deleted === 1;
  }

  #touchBook(id: BookId, now: number): void {
    const result = this.#database.prepare(
      "UPDATE books SET updated_at = ?, revision = revision + 1 WHERE id = ? AND archived = 0",
    ).run(now, id);
    if (Number(result.changes) !== 1) throw new Error("Book no longer exists");
  }

  #touchOrganizationBook(id: BookId, now: number): void {
    const result = this.#database.prepare(
      "UPDATE books SET updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL",
    ).run(now, id);
    if (Number(result.changes) !== 1) throw new Error("Book no longer exists");
  }

  #requireCollection(id: CollectionId): Collection {
    const row = this.#database.prepare(
      `SELECT collections.id, collections.name, collections.description,
              collections.created_at, collections.updated_at, collections.revision,
              count(collection_books.book_id) AS book_count
       FROM collections
       LEFT JOIN collection_books ON collection_books.collection_id = collections.id
       WHERE collections.id = ? AND collections.deleted_at IS NULL
       GROUP BY collections.id`,
    ).get(id) as CollectionRow | undefined;
    if (!row) throw new Error("Collection no longer exists");
    return mapCollection(row);
  }

  #requireTag(id: TagId): Tag {
    const row = this.#database.prepare(
      `SELECT tags.id, tags.name, tags.color, tags.created_at, tags.updated_at, tags.revision,
              (SELECT count(*) FROM book_tags WHERE book_tags.tag_id = tags.id) AS book_count,
              (SELECT count(*) FROM highlight_tags WHERE highlight_tags.tag_id = tags.id) AS highlight_count
       FROM tags
       WHERE tags.id = ? AND tags.deleted_at IS NULL`,
    ).get(id) as TagRow | undefined;
    if (!row) throw new Error("Tag no longer exists");
    return mapTag(row);
  }

  #findThread(id: ThreadId): Thread | undefined {
    const row = this.#database.prepare(
      `SELECT threads.id, threads.name, threads.description,
              threads.created_at, threads.updated_at, threads.revision,
              count(books.id) AS passage_count
       FROM threads
       LEFT JOIN thread_highlights ON thread_highlights.thread_id = threads.id
       LEFT JOIN highlights ON highlights.id = thread_highlights.highlight_id
         AND highlights.archived = 0 AND highlights.deleted = 0
       LEFT JOIN books ON books.id = highlights.book_id
         AND books.archived = 0 AND books.deleted_at IS NULL
       WHERE threads.id = ? AND threads.deleted_at IS NULL
       GROUP BY threads.id`,
    ).get(id) as ThreadRow | undefined;
    return row ? mapThread(row) : undefined;
  }

  #requireThread(id: ThreadId): Thread {
    const thread = this.#findThread(id);
    if (!thread) throw new Error("Thread no longer exists");
    return thread;
  }

  #requireHighlight(bookId: BookId, highlightId: HighlightId): BookContents["highlights"][number] {
    const highlight = this.getBookContents(bookId)?.highlights.find((candidate) => candidate.id === highlightId);
    if (!highlight) throw new Error("Highlight no longer exists");
    return highlight;
  }

  #requireNote(bookId: BookId, noteId: NoteId): Note {
    const contents = this.getBookContents(bookId);
    const note = contents && [
      ...contents.standaloneNotes,
      ...contents.highlights.flatMap((highlight) => highlight.notes),
    ].find((candidate) => candidate.id === noteId);
    if (!note) throw new Error("Note no longer exists");
    return note;
  }

  #sourceId(
    provider: ImportProvider,
    source: { readonly id: string; readonly name?: string; readonly pathHintHash?: string },
    now: number,
  ): string {
    if (!isUuid(source.id)) throw new Error("Import source identifier is invalid");
    if (source.pathHintHash !== undefined && !/^[0-9a-f]{64}$/.test(source.pathHintHash)) {
      throw new Error("Import source path hint is invalid");
    }
    const existing = this.#database.prepare(
      "SELECT id, provider FROM import_sources WHERE id = ?",
    ).get(source.id) as { id: string; provider: string } | undefined;
    if (existing) {
      if (existing.provider !== provider) throw new Error("Import source belongs to another provider");
      this.#database.prepare(
        "UPDATE import_sources SET path_hint_hash = COALESCE(?, path_hint_hash), updated_at = ? WHERE id = ?",
      ).run(source.pathHintHash ?? null, now, existing.id);
      return existing.id;
    }
    const name = requiredText(source.name ?? "", "Import source name", 200);
    this.#database.prepare(
      `INSERT INTO import_sources
        (id, provider, external_identity, display_name, path_hint_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(source.id, provider, `profile:${source.id}`, name, source.pathHintHash ?? null, now, now);
    return source.id;
  }

  #reconcileImportedNote(
    bookId: BookId,
    highlightId: string,
    attachedNoteId: string | null,
    markdown: string | undefined,
    now: number,
    receipt: { notesCreated: number },
  ): string | null {
    const body = importedNoteBody(markdown);
    const normalizedMarkdown = body === undefined ? undefined : requiredNote(body);
    const existing = attachedNoteId ? this.#database.prepare(
      "SELECT id, markdown, deleted FROM notes WHERE id = ? AND highlight_id = ?",
    ).get(attachedNoteId, highlightId) as { id: string; markdown: string; deleted: number } | undefined : undefined;
    if (!normalizedMarkdown) {
      if (existing) {
        this.#database.prepare(
          "UPDATE notes SET deleted = 1, updated_at = ?, revision = revision + 1 WHERE id = ?",
        ).run(now, existing.id);
      }
      return existing?.id ?? null;
    }
    if (existing) {
      // Re-padding a source note is not a change to the note the reader keeps,
      // so nothing is rewritten and no revision or sync entry is spent on it.
      if (existing.deleted === 0 && existing.markdown === normalizedMarkdown) return existing.id;
      if (existing.deleted === 1) this.#requireImportedNoteCapacity(highlightId);
      this.#database.prepare(
        `UPDATE notes SET markdown = ?, origin = 'import', deleted = 0,
           updated_at = ?, revision = revision + 1 WHERE id = ?`,
      ).run(normalizedMarkdown, now, existing.id);
      return existing.id;
    } else {
      this.#requireImportedNoteCapacity(highlightId);
      const id = randomUUID();
      this.#database.prepare(
        `INSERT INTO notes (id, book_id, highlight_id, markdown, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'import', ?, ?)`,
      ).run(id, bookId, highlightId, normalizedMarkdown, now, now);
      receipt.notesCreated += 1;
      return id;
    }
  }

  #requireImportedNoteCapacity(highlightId: string): void {
    const count = this.#database.prepare(
      "SELECT COUNT(*) AS count FROM notes WHERE highlight_id = ? AND deleted = 0",
    ).get(highlightId) as { count: number };
    if (Number(count.count) >= MAX_NOTES_PER_HIGHLIGHT) {
      throw new Error(`A passage can have at most ${MAX_NOTES_PER_HIGHLIGHT} active notes; delete one before importing its source note`);
    }
  }

  #recordImportConflict(
    sourceId: string,
    providerRecordId: string,
    bookId: BookId,
    linked: SourceAnnotationLink,
    incoming: ImportAnnotation,
    incomingFingerprint: string,
    now: number,
  ): boolean {
    const repeated = this.#database.prepare(
      `SELECT id FROM import_conflicts
       WHERE source_id = ? AND provider_record_id = ?
         AND incoming_fingerprint = ? AND status = 'pending'`,
    ).get(sourceId, providerRecordId, incomingFingerprint);
    this.#database.prepare(
      "UPDATE source_annotations SET last_seen_at = ? WHERE source_id = ? AND provider_record_id = ?",
    ).run(now, sourceId, providerRecordId);
    if (repeated) return false;

    const base = parseStoredAnnotation(linked.canonical_json);
    const local = this.#localAnnotationSnapshot(bookId, linked, base);
    this.#database.prepare(
      `UPDATE import_conflicts SET status = 'superseded'
       WHERE source_id = ? AND provider_record_id = ? AND status = 'pending'`,
    ).run(sourceId, providerRecordId);
    this.#database.prepare(
      `INSERT INTO import_conflicts
        (id, source_id, provider_record_id, book_id, highlight_id, note_id,
         base_json, local_json, incoming_json, incoming_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), sourceId, providerRecordId, bookId, linked.highlight_id, linked.note_id,
      linked.canonical_json, JSON.stringify(local), JSON.stringify(incoming), incomingFingerprint, now,
    );
    return true;
  }

  #localAnnotationSnapshot(
    bookId: BookId,
    linked: SourceAnnotationLink,
    base: ImportAnnotation,
  ): ImportAnnotation {
    if (linked.highlight_id) {
      const highlight = this.#database.prepare(
        `SELECT text, source_location, source_created_at FROM highlights
         WHERE id = ? AND book_id = ? AND deleted = 0`,
      ).get(linked.highlight_id, bookId) as {
        text: string;
        source_location: string | null;
        source_created_at: number | null;
      } | undefined;
      if (!highlight) throw new Error("Imported highlight moved or no longer exists");
      const attached = linked.attached_note_id ? this.#database.prepare(
        "SELECT markdown FROM notes WHERE id = ? AND book_id = ? AND deleted = 0",
      ).get(linked.attached_note_id, bookId) as { markdown: string } | undefined : undefined;
      return {
        providerRecordId: base.providerRecordId,
        bookProviderRecordId: base.bookProviderRecordId,
        text: highlight.text,
        ...(attached ? { note: attached.markdown } : {}),
        ...(highlight.source_location ? { location: highlight.source_location } : {}),
        ...(highlight.source_created_at !== null ? { createdAt: highlight.source_created_at } : {}),
      };
    }
    if (linked.note_id) {
      const note = this.#database.prepare(
        "SELECT markdown FROM notes WHERE id = ? AND book_id = ? AND highlight_id IS NULL AND deleted = 0",
      ).get(linked.note_id, bookId) as { markdown: string } | undefined;
      if (!note) throw new Error("Imported note moved or no longer exists");
      return {
        providerRecordId: base.providerRecordId,
        bookProviderRecordId: base.bookProviderRecordId,
        note: note.markdown,
      };
    }
    throw new Error("Import provenance is invalid");
  }

  #applyIncomingConflict(
    conflict: {
      readonly book_id: string;
      readonly highlight_id: string | null;
      readonly note_id: string | null;
      readonly attached_note_id: string | null;
    },
    incoming: ImportAnnotation,
    now: number,
  ): string | null {
    if (conflict.highlight_id && incoming.text) {
      const updated = this.#database.prepare(
        `UPDATE highlights SET text = ?, source_location = ?, source_created_at = ?,
           updated_at = ?, revision = revision + 1
         WHERE id = ? AND book_id = ? AND deleted = 0`,
      ).run(
        incoming.text,
        incoming.location ?? null,
        incoming.createdAt ?? null,
        now,
        conflict.highlight_id,
        conflict.book_id,
      );
      if (Number(updated.changes) !== 1) throw new Error("Imported highlight moved or no longer exists");
      return this.#reconcileImportedNote(
        conflict.book_id as BookId,
        conflict.highlight_id,
        conflict.attached_note_id,
        incoming.note,
        now,
        { notesCreated: 0 },
      );
    }
    if (conflict.note_id && !incoming.text && importedNoteBody(incoming.note)) {
      const updated = this.#database.prepare(
        `UPDATE notes SET markdown = ?, origin = 'import', updated_at = ?, revision = revision + 1
         WHERE id = ? AND book_id = ? AND highlight_id IS NULL AND deleted = 0`,
      ).run(requiredNote(importedNoteBody(incoming.note)!), now, conflict.note_id, conflict.book_id);
      if (Number(updated.changes) !== 1) throw new Error("Imported note moved or no longer exists");
      return null;
    }
    throw new Error("Imported annotation changed between note and highlight form");
  }

  #updateSourceAnnotation(
    sourceId: string,
    providerRecordId: string,
    sourceFingerprint: string,
    canonical: unknown,
    now: number,
  ): void {
    this.#database.prepare(
      `UPDATE source_annotations SET source_fingerprint = ?, canonical_json = ?, last_seen_at = ?
       WHERE source_id = ? AND provider_record_id = ?`,
    ).run(sourceFingerprint, JSON.stringify(canonical), now, sourceId, providerRecordId);
  }

  #insertSourceAnnotation(
    sourceId: string,
    providerRecordId: string,
    highlightId: string | null,
    noteId: string | null,
    attachedNoteId: string | null,
    sourceFingerprint: string,
    canonical: unknown,
    now: number,
  ): void {
    this.#database.prepare(
      `INSERT INTO source_annotations
        (source_id, provider_record_id, highlight_id, note_id, attached_note_id,
         source_fingerprint, canonical_json, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sourceId, providerRecordId, highlightId, noteId, attachedNoteId, sourceFingerprint, JSON.stringify(canonical), now);
  }

  close(): void {
    this.#database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/** Validates a portable library backup before the desktop replaces live data. */
/** Pre-upgrade copies kept beside a library, newest schema first. */
const RETAINED_UPGRADE_SNAPSHOTS = 2;

/**
 * Migrations only run forward and an older release refuses a newer library, so
 * without this copy the only way back to the previous release would be a
 * backup the reader remembered to make. It is an ordinary restorable backup of
 * the library exactly as that release left it. Failing to write it keeps the
 * library closed and unmigrated rather than upgrading without a way back.
 */
function snapshotBeforeMigration(database: DatabaseSync, path: string): void {
  const current = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (!Number.isSafeInteger(current) || current < 1 || current >= latestSchemaVersion) return;
  const directory = dirname(path);
  const stem = basename(path).replace(/\.sqlite$/u, "");
  const target = join(directory, `${stem}.before-upgrade.schema-${current}.sqlite`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    database.prepare("VACUUM INTO ?").run(temporary);
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error("Leaflogue could not save a copy of the library before upgrading it", { cause: error });
  }
  const prefix = `${stem}.before-upgrade.schema-`;
  const retained = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sqlite"))
    .map((name) => ({ name, schema: Number(name.slice(prefix.length, -".sqlite".length)) }))
    .filter((entry) => Number.isSafeInteger(entry.schema) && entry.schema > 0)
    .sort((first, second) => second.schema - first.schema);
  for (const stale of retained.slice(RETAINED_UPGRADE_SNAPSHOTS)) rmSync(join(directory, stale.name), { force: true });
}

export function validateLibraryBackup(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    const integrity = database.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
    if (!integrity || !Object.values(integrity).includes("ok")) throw new Error("Backup is damaged");
    const metadata = database.prepare("SELECT * FROM pragma_user_version(), pragma_application_id()").get() as
      | { user_version: number; application_id: number }
      | undefined;
    if (!metadata || metadata.user_version < 1 || metadata.user_version > latestSchemaVersion) {
      throw new Error("Backup schema is not supported");
    }
    if (metadata.application_id !== 0 && metadata.application_id !== 1279671367) {
      throw new Error("File is not a Leaflogue backup");
    }
    const required = database.prepare(
      `SELECT count(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name IN ('books', 'highlights', 'notes', 'import_sources')`,
    ).get() as { count: number } | undefined;
    if (required?.count !== 4) throw new Error("Backup is missing required records");
    // A restored file becomes the live library, so it may only contain the
    // schema Leaflogue itself creates at that version. Extra or altered
    // triggers, views, indexes, or tables would otherwise run against every
    // later edit and import, and could push damage out through sync.
    if (schemaFingerprint(database) !== referenceSchemaFingerprint(metadata.user_version)) {
      throw new Error("Backup contains database objects Leaflogue did not create");
    }
  } finally {
    database.close();
  }
}

function schemaFingerprint(database: DatabaseSync): string {
  const rows = database.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  ).all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  return JSON.stringify(rows.map(({ type, name, tbl_name, sql }) => [type, name, tbl_name, sql]));
}

const referenceSchemas = new Map<number, string>();

/** The schema a fresh library has after migrating to `version`. */
function referenceSchemaFingerprint(version: number): string {
  const cached = referenceSchemas.get(version);
  if (cached) return cached;
  const reference = new DatabaseSync(":memory:");
  try {
    applyMigrations(reference, migrations.filter((migration) => migration.version <= version));
    const fingerprint = schemaFingerprint(reference);
    referenceSchemas.set(version, fingerprint);
    return fingerprint;
  } finally {
    reference.close();
  }
}

function mapCollection(row: CollectionRow): Collection {
  return {
    id: row.id as CollectionId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    bookCount: Number(row.book_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function mapTag(row: TagRow): Tag {
  return {
    id: row.id as TagId,
    name: row.name,
    ...(row.color ? { color: row.color } : {}),
    bookCount: Number(row.book_count),
    highlightCount: Number(row.highlight_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function mapThread(row: ThreadRow): Thread {
  return {
    id: row.id as ThreadId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    passageCount: Number(row.passage_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function mapDailySelection(row: DailySelectionRow): DailySelection {
  if (!isUuid(row.id)) throw new Error("Stored daily selection identifier is invalid");
  const recent = JSON.parse(row.recent_highlight_ids_json) as unknown;
  if (!Array.isArray(recent) || recent.length > 7 ||
      !recent.every((id) => typeof id === "string" && isUuid(id))) {
    throw new Error("Stored daily selection history is invalid");
  }
  return {
    id: row.id as DailySelectionId,
    localDay: row.local_day,
    timezone: row.timezone,
    ...(row.highlight_id ? { highlightId: row.highlight_id as HighlightId } : {}),
    candidateDigest: row.candidate_digest,
    recentHighlightIds: recent as HighlightId[],
    selectedAt: row.selected_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function mapReadingStatusEvent(row: ReadingStatusEventRow): ReadingStatusEvent {
  return {
    id: row.id as ReadingStatusEventId,
    bookId: row.book_id as BookId,
    status: row.status,
    source: row.source,
    changedAt: row.changed_at,
    ...(row.completed_on ? { completedOn: row.completed_on } : {}),
    bookRevision: row.book_revision,
  };
}

function mapBook(row: BookRow): Book {
  const authors = parseAuthors(row.authors_json, row.id);
  return {
    id: row.id as BookId,
    title: row.title,
    authors,
    ...(row.description ? { description: row.description } : {}),
    ...(row.publisher ? { publisher: row.publisher } : {}),
    ...(row.series ? { series: row.series } : {}),
    ...(row.series_number ? { seriesNumber: row.series_number } : {}),
    ...(row.language ? { language: row.language } : {}),
    ...(row.isbn13 ? { isbn13: row.isbn13 } : {}),
    ...(row.cover_url ? { coverUrl: row.cover_url } : {}),
    status: row.status,
    ...(row.completed_on ? { completedOn: row.completed_on } : {}),
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    highlightCount: row.highlight_count,
  };
}

function parseAuthors(json: string, bookId: string): string[] {
  const authors = JSON.parse(json) as unknown;
  if (!Array.isArray(authors) || !authors.every((author) => typeof author === "string")) {
    throw new Error(`Book ${bookId} has invalid authors`);
  }
  return authors;
}

interface OutboxRow {
  sequence: number;
  device_id: string;
  entity_type: SyncOutboxEntry["entityType"];
  entity_id: string;
  revision: number;
  operation: SyncOutboxEntry["operation"];
  created_at: number;
}

type SyncedEntityType = SyncedChange["entityType"];
const SYNCED_ENTITY_RANK: Readonly<Record<SyncedEntityType, number>> = {
  collection: 0, tag: 1, thread: 2, book: 3, highlight: 4, note: 5, "daily-selection": 6,
};
const SYNCED_ENTITY_TABLE: Readonly<Record<SyncedEntityType, string>> = {
  book: "books", highlight: "highlights", note: "notes", collection: "collections", tag: "tags", thread: "threads",
  "daily-selection": "daily_selections",
};

function mapOutboxEntry(row: OutboxRow): SyncOutboxEntry {
  return {
    sequence: row.sequence,
    deviceId: row.device_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    revision: row.revision,
    operation: row.operation,
    createdAt: row.created_at,
  };
}

function mapNote(row: NoteRow): Note {
  return {
    id: row.id as NoteId,
    bookId: row.book_id as BookId,
    ...(row.highlight_id ? { highlightId: row.highlight_id as HighlightId } : {}),
    markdown: row.markdown,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

const bookSelect = `SELECT books.*,
  (SELECT count(*) FROM highlights
   WHERE highlights.book_id = books.id AND highlights.deleted = 0 AND highlights.archived = 0)
  AS highlight_count
  FROM books`;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function utf8Bytes(...values: readonly string[]): number {
  return values.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
}

function parseStoredAnnotation(json: string): ImportAnnotation {
  const value = JSON.parse(json) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored import annotation is invalid");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.providerRecordId !== "string" || !input.providerRecordId ||
      typeof input.bookProviderRecordId !== "string" || !input.bookProviderRecordId) {
    throw new Error("Stored import annotation is invalid");
  }
  for (const field of ["text", "note", "location"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      throw new Error("Stored import annotation is invalid");
    }
  }
  if (input.createdAt !== undefined &&
      (typeof input.createdAt !== "number" || !Number.isSafeInteger(input.createdAt))) {
    throw new Error("Stored import annotation is invalid");
  }
  if (!input.text && !input.note) throw new Error("Stored import annotation is invalid");
  return {
    providerRecordId: input.providerRecordId,
    bookProviderRecordId: input.bookProviderRecordId,
    ...(typeof input.text === "string" ? { text: input.text } : {}),
    ...(typeof input.note === "string" ? { note: input.note } : {}),
    ...(typeof input.location === "string" ? { location: input.location } : {}),
    ...(typeof input.createdAt === "number" ? { createdAt: input.createdAt } : {}),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function validateCursorAdvance(expected: SyncCursor, next: SyncCursor): void {
  for (const cursor of [expected, next]) {
    if (!Number.isSafeInteger(cursor.generation) || cursor.generation < 1 ||
        !Number.isSafeInteger(cursor.afterSequence) || cursor.afterSequence < 0) {
      throw new Error("Incoming sync cursor is invalid");
    }
  }
  if (next.generation !== expected.generation || next.afterSequence <= expected.afterSequence) {
    throw new Error("Incoming sync cursor did not advance");
  }
}

function validateIncomingChange(value: unknown): asserts value is SyncedChange {
  if (!isRecord(value) || typeof value.entityType !== "string" ||
      !["book", "highlight", "note", "collection", "tag", "thread", "daily-selection"].includes(value.entityType) ||
      typeof value.operation !== "string" || !["upsert", "tombstone"].includes(value.operation) ||
      typeof value.deviceId !== "string" || !isCanonicalUuid(value.deviceId) ||
      !isPositiveSafeInteger(value.deviceRevision)) {
    throw new Error("Incoming synced change is invalid");
  }
  const change = value as unknown as SyncedChange;
  if (change.operation === "tombstone") {
    if (typeof change.entityId !== "string" || !isUuid(change.entityId) ||
        ((change.entityType === "highlight" || change.entityType === "note") &&
          (typeof change.bookId !== "string" || !isUuid(change.bookId)))) {
      throw new Error("Incoming synced change is invalid");
    }
    return;
  }
  if (change.entityType === "daily-selection") {
    const pick = change.dailySelection as unknown as Record<string, unknown>;
    if (!isRecord(pick) || typeof pick.id !== "string" || !isUuid(pick.id) || !isPositiveSafeInteger(pick.revision) ||
        typeof pick.localDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(pick.localDay) ||
        typeof pick.timezone !== "string" || pick.timezone.trim().length < 1 || pick.timezone.length > 100 ||
        (pick.highlightId !== undefined && (typeof pick.highlightId !== "string" || !isUuid(pick.highlightId))) ||
        typeof pick.candidateDigest !== "string" || !/^[0-9a-f]{64}$/u.test(pick.candidateDigest) ||
        !Array.isArray(pick.recentHighlightIds) || pick.recentHighlightIds.length > 7 ||
        !pick.recentHighlightIds.every((id) => typeof id === "string" && isUuid(id)) ||
        !isEpoch(pick.selectedAt) || !isEpoch(pick.updatedAt) || !isEpoch(pick.createdAt)) {
      throw new Error("Incoming synced change is invalid");
    }
    return;
  }
  const entity = change.entityType === "book" ? change.book :
    change.entityType === "highlight" ? change.highlight :
      change.entityType === "note" ? change.note :
        change.entityType === "collection" ? change.collection :
          change.entityType === "tag" ? change.tag : change.thread;
  if (!isRecord(entity) || typeof entity.id !== "string" || !isUuid(entity.id) ||
      !isPositiveSafeInteger(entity.revision) || !isEpoch(entity.createdAt) || !isEpoch(entity.updatedAt)) {
    throw new Error("Incoming synced change is invalid");
  }
  if (change.entityType === "book") {
    if (typeof change.book.title !== "string" ||
        !Array.isArray(change.book.authors) || !change.book.authors.every((author) => typeof author === "string") ||
        typeof change.book.status !== "string" ||
        !["unread", "reading", "finished", "paused"].includes(change.book.status) ||
        typeof change.book.archived !== "boolean" || !Number.isSafeInteger(change.book.highlightCount) ||
        change.book.highlightCount < 0 ||
        !validSyncIds(change.collectionIds) || !validSyncIds(change.tagIds) ||
        !validStatusEvents(change.statusEvents, change.book.id) ||
        !["description", "publisher", "series", "seriesNumber", "language", "isbn13", "coverUrl", "completedOn"]
          .every((field) => optionalStringField(change.book as unknown as Record<string, unknown>, field))) {
      throw new Error("Incoming synced change is invalid");
    }
    return;
  }
  if (change.entityType === "collection") {
    if (typeof change.collection.name !== "string" ||
        !optionalStringField(change.collection as unknown as Record<string, unknown>, "description")) {
      throw new Error("Incoming synced change is invalid");
    }
    return;
  }
  if (change.entityType === "tag") {
    if (typeof change.tag.name !== "string" ||
        !optionalStringField(change.tag as unknown as Record<string, unknown>, "color")) {
      throw new Error("Incoming synced change is invalid");
    }
    return;
  }
  if (change.entityType === "thread") {
    if (typeof change.thread.name !== "string" ||
        !optionalStringField(change.thread as unknown as Record<string, unknown>, "description")) {
      throw new Error("Incoming synced change is invalid");
    }
    return;
  }
  const annotation = entity as unknown as Record<string, unknown>;
  if (typeof annotation.bookId !== "string" || !isUuid(annotation.bookId)) {
    throw new Error("Incoming synced change is invalid");
  }
  if (change.entityType === "highlight") {
    if (typeof change.highlight.text !== "string" ||
        !optionalStringField(annotation, "sourceLocation") || !optionalEpochField(annotation, "sourceCreatedAt") ||
        !validSyncIds(change.tagIds) || (change.threadIds !== undefined &&
          (!validSyncIds(change.threadIds) || change.threadIds.length > MAX_THREADS_PER_HIGHLIGHT))) {
      throw new Error("Incoming synced change is invalid");
    }
    return;
  }
  if (typeof change.note.markdown !== "string" || typeof change.note.origin !== "string" ||
      !["reader", "import", "ai"].includes(change.note.origin) ||
      !optionalUuidField(annotation, "highlightId")) {
    throw new Error("Incoming synced change is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalStringField(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function optionalEpochField(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || isEpoch(value[key]);
}

function optionalUuidField(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || (typeof value[key] === "string" && isUuid(value[key]));
}

function validStatusEvents(value: readonly ReadingStatusEvent[] | undefined, bookId: string): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= MAX_SYNCED_STATUS_EVENTS_PER_BOOK &&
    new Set(value.map((event) => isRecord(event) ? event.id : undefined)).size === value.length &&
    value.every((event) => isRecord(event) && typeof event.id === "string" && isUuid(event.id) && event.bookId === bookId &&
      (["unread", "reading", "finished", "paused"] as unknown[]).includes(event.status) &&
      (["reader", "merge", "kindle", "kobo", "portable"] as unknown[]).includes(event.source) && isEpoch(event.changedAt) &&
      isPositiveSafeInteger(event.bookRevision) &&
      (event.completedOn === undefined || (typeof event.completedOn === "string" && validateCompletionDate(event.completedOn) === event.completedOn)));
}

function requireStatusHistoryCapacity(database: DatabaseSync, bookIds: readonly string[], adding: number): void {
  const count = Number((database.prepare(
    `SELECT count(*) AS count FROM reading_status_events WHERE book_id IN (${bookIds.map(() => "?").join(", ")})`,
  ).get(...bookIds) as { count: number }).count);
  if (count + adding > MAX_STATUS_EVENTS_PER_BOOK) {
    throw new Error(`A book can keep at most ${MAX_STATUS_EVENTS_PER_BOOK} reading-status changes`);
  }
}

function validSyncIds(value: readonly string[]): boolean {
  return Array.isArray(value) && value.length <= MAX_SYNC_ORGANIZATION_MEMBERSHIPS &&
    new Set(value).size === value.length && value.every(isUuid);
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

function incomingWriterWins(
  change: SyncedChange,
  writer: { readonly device_id: string; readonly device_revision: number; readonly operation: "upsert" | "tombstone" },
): boolean {
  if (change.operation !== writer.operation) return change.operation === "tombstone";
  return change.deviceRevision > writer.device_revision ||
    (change.deviceRevision === writer.device_revision && change.deviceId > writer.device_id);
}

function causallySuperseded(
  losingDeviceId: string | undefined,
  losingDeviceRevision: number | undefined,
  winningDeviceId: string | undefined,
  winningDeviceRevision: number | undefined,
): boolean {
  return losingDeviceId !== undefined && winningDeviceId === losingDeviceId &&
    losingDeviceRevision !== undefined && winningDeviceRevision !== undefined &&
    losingDeviceRevision <= winningDeviceRevision;
}

function validIncomingEpoch(value: number | undefined, optional = false): number {
  if (value === undefined) {
    if (optional) return 0;
    throw new Error("Incoming synced timestamp is invalid");
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Incoming synced timestamp is invalid");
  return value;
}

function requireIncomingParent(database: DatabaseSync, bookId: string): void {
  const book = database.prepare("SELECT 1 FROM books WHERE id = ? AND deleted_at IS NULL").get(bookId);
  if (!book) throw new Error("Incoming synced parent no longer exists");
}

function activeOrTombstonedContainerIds(
  database: DatabaseSync,
  entityType: "collection" | "tag" | "thread",
  ids: readonly string[],
): string[] {
  if (!validSyncIds(ids)) throw new Error("Synced organization membership is invalid");
  const active = database.prepare(
    `SELECT 1 FROM ${SYNCED_ENTITY_TABLE[entityType]} WHERE id = ? AND deleted_at IS NULL`,
  );
  const tombstone = database.prepare(
    "SELECT 1 FROM sync_tombstones WHERE entity_type = ? AND entity_id = ?",
  );
  return ids.filter((id) => {
    if (active.get(id)) return true;
    if (tombstone.get(entityType, id)) return false;
    throw new Error("Synced organization container no longer exists");
  });
}

function ensureLocalSyncState(database: DatabaseSync, deviceId: string): void {
  const existing = database.prepare("SELECT device_id FROM sync_state WHERE singleton = 1").get() as
    | { device_id: string }
    | undefined;
  if (existing?.device_id === deviceId) return;
  const now = Date.now();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(
      "INSERT OR IGNORE INTO sync_devices (id, created_at, updated_at) VALUES (?, ?, ?)",
    ).run(deviceId, now, now);
    if (existing) {
      database.prepare(
        `UPDATE sync_state
         SET device_id = ?, remote_generation = NULL, remote_sequence = 0, remote_checkpoint = NULL,
             snapshot_required = 1, updated_at = ?
         WHERE singleton = 1`,
      ).run(deviceId, now);
      database.prepare("DELETE FROM sync_outbox").run();
      database.prepare("DELETE FROM sync_incoming_writers").run();
      database.prepare("DELETE FROM sync_tombstones").run();
    } else {
      database.prepare(
        "INSERT INTO sync_state (singleton, device_id, updated_at) VALUES (1, ?, ?)",
      ).run(deviceId, now);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function deviceIdentityForLibrary(path: string): string {
  if (path === ":memory:") return randomUUID();
  const identityPath = `${path}.device-id`;
  if (existsSync(identityPath)) {
    const info = lstatSync(identityPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Leaflogue device identity must be a regular file");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("Leaflogue device identity must be owned by the current user");
    }
    chmodSync(identityPath, 0o600);
    const value = readFileSync(identityPath, "utf8").trim();
    if (!isUuid(value)) throw new Error("Leaflogue device identity is invalid");
    return value;
  }
  const deviceId = randomUUID();
  try {
    writeFileSync(identityPath, `${deviceId}\n`, { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
  } catch (error) {
    if (!existsSync(identityPath)) throw error;
    return deviceIdentityForLibrary(path);
  }
  return deviceId;
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} text is required`);
  if (normalized.length > maximum) throw new Error(`${label} text is too long`);
  return normalized;
}

/**
 * What an import stores for a source note. Whitespace-only notes carry nothing,
 * so they read as absent rather than failing the whole import, and comparing a
 * stored note against this — never against the raw source — keeps padding from
 * being reported as a reader's edit.
 */
function importedNoteBody(value: string | undefined): string | undefined {
  const body = value?.trim();
  return body ? body : undefined;
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

function requireRevision(revision: number, label: string): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error(`${label} revision is invalid`);
}

export { applyMigrations, latestSchemaVersion, migrations } from "./migrations";
