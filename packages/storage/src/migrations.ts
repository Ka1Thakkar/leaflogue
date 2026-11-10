import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        authors_json TEXT NOT NULL DEFAULT '[]',
        description TEXT,
        publisher TEXT,
        series TEXT,
        series_number TEXT,
        language TEXT,
        isbn13 TEXT CHECK (isbn13 IS NULL OR length(isbn13) = 13),
        cover_url TEXT,
        status TEXT NOT NULL DEFAULT 'unread'
          CHECK (status IN ('unread', 'reading', 'finished', 'paused')),
        completed_on TEXT,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
      ) STRICT;

      CREATE INDEX books_active_updated ON books(archived, updated_at DESC);
      CREATE UNIQUE INDEX books_isbn13 ON books(isbn13) WHERE isbn13 IS NOT NULL;

      CREATE TABLE highlights (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id),
        text TEXT NOT NULL CHECK (length(trim(text)) > 0),
        source_location TEXT,
        source_created_at INTEGER,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
      ) STRICT;

      CREATE INDEX highlights_book_active ON highlights(book_id, deleted, archived, created_at);

      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        highlight_id TEXT NOT NULL REFERENCES highlights(id),
        markdown TEXT NOT NULL CHECK (length(trim(markdown)) > 0),
        origin TEXT NOT NULL DEFAULT 'reader' CHECK (origin IN ('reader', 'ai')),
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
      ) STRICT;

      CREATE INDEX notes_highlight_active ON notes(highlight_id, deleted, created_at);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE import_sources (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        external_identity TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(provider, external_identity)
      ) STRICT;

      CREATE TABLE source_books (
        source_id TEXT NOT NULL REFERENCES import_sources(id),
        provider_record_id TEXT NOT NULL,
        book_id TEXT NOT NULL REFERENCES books(id),
        source_fingerprint TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(source_id, provider_record_id)
      ) STRICT;

      CREATE TABLE source_annotations (
        source_id TEXT NOT NULL REFERENCES import_sources(id),
        provider_record_id TEXT NOT NULL,
        highlight_id TEXT NOT NULL REFERENCES highlights(id),
        source_fingerprint TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(source_id, provider_record_id)
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE notes RENAME TO notes_v1;
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id),
        highlight_id TEXT REFERENCES highlights(id),
        markdown TEXT NOT NULL CHECK (length(trim(markdown)) > 0),
        origin TEXT NOT NULL DEFAULT 'reader' CHECK (origin IN ('reader', 'import', 'ai')),
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
      ) STRICT;
      INSERT INTO notes
        (id, book_id, highlight_id, markdown, origin, deleted, created_at, updated_at, revision)
      SELECT notes_v1.id, highlights.book_id, notes_v1.highlight_id, notes_v1.markdown,
             notes_v1.origin, notes_v1.deleted, notes_v1.created_at,
             notes_v1.updated_at, notes_v1.revision
      FROM notes_v1 JOIN highlights ON highlights.id = notes_v1.highlight_id;
      DROP TABLE notes_v1;
      CREATE INDEX notes_highlight_active ON notes(highlight_id, deleted, created_at);
      CREATE INDEX notes_book_active ON notes(book_id, deleted, created_at);

      ALTER TABLE source_annotations RENAME TO source_annotations_v1;
      CREATE TABLE source_annotations (
        source_id TEXT NOT NULL REFERENCES import_sources(id),
        provider_record_id TEXT NOT NULL,
        highlight_id TEXT REFERENCES highlights(id),
        note_id TEXT REFERENCES notes(id),
        source_fingerprint TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        CHECK ((highlight_id IS NOT NULL) != (note_id IS NOT NULL)),
        PRIMARY KEY(source_id, provider_record_id)
      ) STRICT;
      INSERT INTO source_annotations
        (source_id, provider_record_id, highlight_id, source_fingerprint, canonical_json, last_seen_at)
      SELECT source_id, provider_record_id, highlight_id, source_fingerprint,
             canonical_json, last_seen_at
      FROM source_annotations_v1;
      DROP TABLE source_annotations_v1;

      CREATE TABLE import_runs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES import_sources(id),
        file_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        format_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('committed', 'failed')),
        books_created INTEGER NOT NULL,
        books_reused INTEGER NOT NULL,
        highlights_created INTEGER NOT NULL,
        annotations_updated INTEGER NOT NULL,
        notes_created INTEGER NOT NULL,
        warnings_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      DROP INDEX books_isbn13;
      CREATE INDEX books_isbn13_lookup ON books(isbn13) WHERE isbn13 IS NOT NULL;
    `,
  },
  {
    version: 3,
    sql: `
      PRAGMA application_id = 1279671367;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE source_annotations
        ADD COLUMN detached INTEGER NOT NULL DEFAULT 0 CHECK (detached IN (0, 1));

      UPDATE source_annotations
      SET detached = 1
      WHERE highlight_id IS NOT NULL AND (
        EXISTS (
          SELECT 1 FROM highlights
          WHERE highlights.id = source_annotations.highlight_id
            AND (
              highlights.text != json_extract(source_annotations.canonical_json, '$.text')
              OR COALESCE(highlights.source_location, '') != COALESCE(json_extract(source_annotations.canonical_json, '$.location'), '')
            )
        )
        OR EXISTS (
          SELECT 1 FROM notes
          WHERE notes.highlight_id = source_annotations.highlight_id
            AND notes.origin = 'reader' AND notes.deleted = 0
        )
      );

      UPDATE source_annotations
      SET detached = 1
      WHERE note_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM notes
        WHERE notes.id = source_annotations.note_id
          AND (
            notes.origin != 'import'
            OR notes.markdown != json_extract(source_annotations.canonical_json, '$.note')
          )
      );
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE import_sources
        ADD COLUMN display_name TEXT NOT NULL DEFAULT 'Imported source'
        CHECK (length(trim(display_name)) BETWEEN 1 AND 200);
      ALTER TABLE import_sources
        ADD COLUMN path_hint_hash TEXT;

      UPDATE import_sources
      SET display_name = (CASE provider
          WHEN 'kobo' THEN 'Kobo library — '
          WHEN 'kindle' THEN 'Kindle clippings — '
          ELSE 'Portable import — '
        END) || substr(id, 1, 8),
        path_hint_hash = CASE
          WHEN length(external_identity) = 64
            AND external_identity NOT GLOB '*[^0-9A-Fa-f]*'
          THEN lower(external_identity)
          ELSE NULL
        END;
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE source_annotations
        ADD COLUMN attached_note_id TEXT REFERENCES notes(id);

      UPDATE source_annotations
      SET attached_note_id = (
        SELECT notes.id FROM notes
        WHERE notes.highlight_id = source_annotations.highlight_id
          AND notes.deleted = 0
          AND (
            notes.origin = 'import'
            OR 1 = (
              SELECT COUNT(*) FROM notes AS active_notes
              WHERE active_notes.highlight_id = source_annotations.highlight_id
                AND active_notes.deleted = 0
            )
          )
        ORDER BY CASE notes.origin WHEN 'import' THEN 0 ELSE 1 END, notes.created_at
        LIMIT 1
      )
      WHERE highlight_id IS NOT NULL
        AND json_type(canonical_json, '$.note') = 'text';

      CREATE TABLE import_conflicts (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES import_sources(id),
        provider_record_id TEXT NOT NULL,
        book_id TEXT NOT NULL REFERENCES books(id),
        highlight_id TEXT REFERENCES highlights(id),
        note_id TEXT REFERENCES notes(id),
        base_json TEXT NOT NULL,
        local_json TEXT NOT NULL,
        incoming_json TEXT NOT NULL,
        incoming_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'resolved', 'superseded')),
        resolution TEXT CHECK (resolution IN ('keep-local', 'use-incoming')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        CHECK ((highlight_id IS NOT NULL) != (note_id IS NOT NULL)),
        CHECK (
          (status = 'resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
          OR (status != 'resolved' AND resolution IS NULL AND resolved_at IS NULL)
        )
      ) STRICT;

      CREATE INDEX import_conflicts_pending
        ON import_conflicts(status, created_at DESC);

      ALTER TABLE import_runs
        ADD COLUMN conflicts_created INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 7,
    sql: `
      -- A device is an installation identity, not an account or credential. It is
      -- created by LocalLibrary after this schema is available and never exposed
      -- to the renderer.
      CREATE TABLE sync_devices (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER
      ) STRICT;

      CREATE TABLE sync_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        device_id TEXT NOT NULL UNIQUE REFERENCES sync_devices(id),
        remote_generation INTEGER,
        remote_sequence INTEGER NOT NULL DEFAULT 0 CHECK (remote_sequence >= 0),
        snapshot_required INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_required IN (0, 1)),
        updated_at INTEGER NOT NULL,
        CHECK (remote_generation IS NULL OR remote_generation >= 1),
        CHECK (remote_generation IS NOT NULL OR remote_sequence = 0)
      ) STRICT;

      CREATE TABLE sync_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL REFERENCES sync_devices(id),
        entity_type TEXT NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note')),
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'tombstone')),
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      ) STRICT;
      CREATE INDEX sync_outbox_pending ON sync_outbox(acknowledged_at, sequence);

      -- Existing libraries need a first full snapshot before a remote can trust
      -- incremental entries. Later writes are appended by these triggers in the
      -- same SQLite transaction as the reading-data mutation.
      ALTER TABLE books ADD COLUMN deleted_at INTEGER;
      ALTER TABLE highlights ADD COLUMN deleted_at INTEGER;
      ALTER TABLE notes ADD COLUMN deleted_at INTEGER;
      UPDATE highlights SET deleted_at = updated_at WHERE deleted = 1;
      UPDATE notes SET deleted_at = updated_at WHERE deleted = 1;

      CREATE TRIGGER sync_outbox_books_insert
      AFTER INSERT ON books
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'book', NEW.id, NEW.revision,
               CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END,
               NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;

      CREATE TRIGGER sync_outbox_books_update
      AFTER UPDATE ON books
      WHEN NEW.revision != OLD.revision
       AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'book', NEW.id, NEW.revision,
               CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END,
               NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;

      CREATE TRIGGER sync_outbox_highlights_insert
      AFTER INSERT ON highlights
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'highlight', NEW.id, NEW.revision,
               CASE WHEN NEW.deleted = 1 OR NEW.deleted_at IS NOT NULL THEN 'tombstone' ELSE 'upsert' END,
               NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;

      CREATE TRIGGER sync_outbox_highlights_update
      AFTER UPDATE ON highlights
      WHEN NEW.revision != OLD.revision
       AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'highlight', NEW.id, NEW.revision,
               CASE WHEN NEW.deleted = 1 THEN 'tombstone' ELSE 'upsert' END,
               NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;

      CREATE TRIGGER sync_outbox_notes_insert
      AFTER INSERT ON notes
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'note', NEW.id, NEW.revision,
               CASE WHEN NEW.deleted = 1 OR NEW.deleted_at IS NOT NULL THEN 'tombstone' ELSE 'upsert' END,
               NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;

      CREATE TRIGGER sync_outbox_notes_update
      AFTER UPDATE ON notes
      WHEN NEW.revision != OLD.revision
       AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'note', NEW.id, NEW.revision,
               CASE WHEN NEW.deleted = 1 THEN 'tombstone' ELSE 'upsert' END,
               NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;

      -- Legacy annotation rows use a deletion flag. Preserve when the deletion
      -- happened without adding a second outbox operation for this metadata-only
      -- update; the revision-changing write above is the canonical operation.
      CREATE TRIGGER sync_tombstone_highlights_timestamp
      AFTER UPDATE OF deleted ON highlights
      WHEN NEW.deleted != OLD.deleted
      BEGIN
        UPDATE highlights
        SET deleted_at = CASE WHEN NEW.deleted = 1 THEN NEW.updated_at ELSE NULL END
        WHERE id = NEW.id;
      END;

      CREATE TRIGGER sync_tombstone_notes_timestamp
      AFTER UPDATE OF deleted ON notes
      WHEN NEW.deleted != OLD.deleted
      BEGIN
        UPDATE notes
        SET deleted_at = CASE WHEN NEW.deleted = 1 THEN NEW.updated_at ELSE NULL END
        WHERE id = NEW.id;
      END;
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 120),
        description TEXT CHECK (description IS NULL OR length(description) <= 2000),
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
      ) STRICT;
      CREATE UNIQUE INDEX collections_active_name
        ON collections(normalized_name) WHERE deleted_at IS NULL;

      CREATE TABLE tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
        normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 80),
        color TEXT CHECK (color IS NULL OR length(color) BETWEEN 1 AND 32),
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
      ) STRICT;
      CREATE UNIQUE INDEX tags_active_name
        ON tags(normalized_name) WHERE deleted_at IS NULL;

      CREATE TABLE collection_books (
        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (collection_id, book_id)
      ) STRICT;
      CREATE INDEX collection_books_by_book ON collection_books(book_id, collection_id);

      CREATE TABLE book_tags (
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tag_id, book_id)
      ) STRICT;
      CREATE INDEX book_tags_by_book ON book_tags(book_id, tag_id);

      CREATE TABLE highlight_tags (
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        highlight_id TEXT NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tag_id, highlight_id)
      ) STRICT;
      CREATE INDEX highlight_tags_by_highlight ON highlight_tags(highlight_id, tag_id);
    `,
  },
  {
    version: 9,
    sql: `
      DROP TRIGGER sync_outbox_books_insert;
      DROP TRIGGER sync_outbox_books_update;
      DROP TRIGGER sync_outbox_highlights_insert;
      DROP TRIGGER sync_outbox_highlights_update;
      DROP TRIGGER sync_outbox_notes_insert;
      DROP TRIGGER sync_outbox_notes_update;
      CREATE TEMP TABLE sync_outbox_v8_sequence (value INTEGER NOT NULL);
      INSERT INTO sync_outbox_v8_sequence
      SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'sync_outbox'), 0);
      DROP INDEX sync_outbox_pending;
      ALTER TABLE sync_outbox RENAME TO sync_outbox_v8;
      CREATE TABLE sync_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL REFERENCES sync_devices(id),
        entity_type TEXT NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag')),
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'tombstone')),
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      ) STRICT;
      INSERT INTO sync_outbox
        (sequence, device_id, entity_type, entity_id, revision, operation, created_at, acknowledged_at)
      SELECT sequence, device_id, entity_type, entity_id, revision, operation, created_at, acknowledged_at
      FROM sync_outbox_v8;
      DROP TABLE sync_outbox_v8;
      DELETE FROM sqlite_sequence WHERE name = 'sync_outbox';
      INSERT INTO sqlite_sequence (name, seq)
      SELECT 'sync_outbox', value FROM sync_outbox_v8_sequence;
      DROP TABLE sync_outbox_v8_sequence;
      CREATE INDEX sync_outbox_pending ON sync_outbox(acknowledged_at, sequence);

      CREATE TRIGGER sync_outbox_books_insert AFTER INSERT ON books
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'book', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_books_update AFTER UPDATE ON books
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'book', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_highlights_insert AFTER INSERT ON highlights
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'highlight', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted = 1 OR NEW.deleted_at IS NOT NULL THEN 'tombstone' ELSE 'upsert' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_highlights_update AFTER UPDATE ON highlights
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'highlight', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted = 1 THEN 'tombstone' ELSE 'upsert' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_notes_insert AFTER INSERT ON notes
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'note', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted = 1 OR NEW.deleted_at IS NOT NULL THEN 'tombstone' ELSE 'upsert' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_notes_update AFTER UPDATE ON notes
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'note', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted = 1 THEN 'tombstone' ELSE 'upsert' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_collections_insert AFTER INSERT ON collections
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'collection', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_collections_update AFTER UPDATE ON collections
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'collection', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_tags_insert AFTER INSERT ON tags
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'tag', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_tags_update AFTER UPDATE ON tags
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'tag', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE reading_status_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('unread', 'reading', 'finished', 'paused')),
        source TEXT NOT NULL CHECK (source IN ('reader', 'merge', 'kindle', 'kobo', 'portable')),
        changed_at INTEGER NOT NULL,
        completed_on TEXT,
        book_revision INTEGER NOT NULL CHECK (book_revision > 0)
      ) STRICT;
      CREATE INDEX reading_status_events_book_changed
        ON reading_status_events(book_id, changed_at DESC, sequence DESC);
    `,
  },
  {
    version: 11,
    sql: `
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 120),
        description TEXT CHECK (description IS NULL OR length(description) <= 1000),
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
      ) STRICT;
      CREATE UNIQUE INDEX threads_active_name
        ON threads(normalized_name) WHERE deleted_at IS NULL;

      CREATE TABLE thread_highlights (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        highlight_id TEXT NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, highlight_id)
      ) STRICT;
      CREATE INDEX thread_highlights_by_highlight
        ON thread_highlights(highlight_id, thread_id);

      CREATE TABLE daily_selections (
        local_day TEXT NOT NULL CHECK (local_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        timezone TEXT NOT NULL CHECK (length(trim(timezone)) BETWEEN 1 AND 100),
        highlight_id TEXT REFERENCES highlights(id) ON DELETE SET NULL,
        candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
        recent_highlight_ids_json TEXT NOT NULL DEFAULT '[]',
        selected_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        PRIMARY KEY (local_day, timezone)
      ) STRICT;
      CREATE INDEX daily_selections_recent
        ON daily_selections(updated_at DESC);
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE daily_selections ADD COLUMN id TEXT;
      UPDATE daily_selections SET id = lower(
        hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
        substr(hex(randomblob(2)), 2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' ||
        hex(randomblob(6))
      );
      CREATE UNIQUE INDEX daily_selections_id ON daily_selections(id);
      CREATE TRIGGER daily_selections_require_id_insert
      BEFORE INSERT ON daily_selections
      WHEN NEW.id IS NULL OR NEW.id NOT GLOB
        '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      BEGIN
        SELECT RAISE(ABORT, 'daily selection id is invalid');
      END;
    `,
  },
  {
    version: 13,
    sql: `
      CREATE TABLE sync_incoming_writers (
        entity_type TEXT NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note')),
        entity_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_revision INTEGER NOT NULL CHECK (device_revision > 0),
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'tombstone')),
        entity_revision INTEGER NOT NULL CHECK (entity_revision >= 0),
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      ) STRICT;

      CREATE TABLE sync_tombstones (
        entity_type TEXT NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note')),
        entity_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      ) STRICT;

      CREATE TABLE sync_conflicts (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('highlight', 'note')),
        entity_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        losing_body TEXT NOT NULL,
        winning_body TEXT,
        losing_device_id TEXT,
        losing_device_revision INTEGER,
        losing_operation TEXT NOT NULL CHECK (losing_operation IN ('upsert', 'tombstone')),
        winning_operation TEXT NOT NULL CHECK (winning_operation IN ('upsert', 'tombstone')),
        fingerprint TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX sync_conflicts_entity_status
        ON sync_conflicts(entity_type, entity_id, status);
    `,
  },
  {
    version: 14,
    sql: `
      -- Outbound resolution and incoming replay both look up one entity's
      -- writes, and acknowledgement compacts by entity.
      CREATE INDEX sync_outbox_entity ON sync_outbox(entity_type, entity_id, sequence);
    `,
  },
  {
    version: 15,
    sql: `
      ALTER TABLE sync_state ADD COLUMN remote_checkpoint TEXT;
      -- Cursors written by older builds cannot prove which provider history
      -- they followed. Force one safe snapshot negotiation after upgrade.
      UPDATE sync_state
      SET remote_generation = NULL, remote_sequence = 0,
          remote_checkpoint = NULL, snapshot_required = 1
      WHERE remote_generation IS NOT NULL;
    `,
  },
  {
    version: 16,
    sql: `
      DROP INDEX collections_active_name;
      CREATE INDEX collections_active_normalized_name
        ON collections(normalized_name) WHERE deleted_at IS NULL;
      DROP INDEX tags_active_name;
      CREATE INDEX tags_active_normalized_name
        ON tags(normalized_name) WHERE deleted_at IS NULL;

      ALTER TABLE sync_incoming_writers RENAME TO sync_incoming_writers_v15;
      CREATE TABLE sync_incoming_writers (
        entity_type TEXT NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag')),
        entity_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_revision INTEGER NOT NULL CHECK (device_revision > 0),
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'tombstone')),
        entity_revision INTEGER NOT NULL CHECK (entity_revision >= 0),
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      ) STRICT;
      INSERT INTO sync_incoming_writers SELECT * FROM sync_incoming_writers_v15;
      DROP TABLE sync_incoming_writers_v15;

      ALTER TABLE sync_tombstones RENAME TO sync_tombstones_v15;
      CREATE TABLE sync_tombstones (
        entity_type TEXT NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag')),
        entity_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      ) STRICT;
      INSERT INTO sync_tombstones SELECT * FROM sync_tombstones_v15;
      DROP TABLE sync_tombstones_v15;
    `,
  },
  {
    version: 17,
    sql: `
      -- Threads join sync as containers, like collections and tags: passages
      -- carry their complete thread membership, and concurrent same-name
      -- threads created on different devices stay distinct.
      -- Daily picks sync too. A pick's first-selection time never changes, so
      -- every node settles a same-day collision the same way.
      ALTER TABLE daily_selections ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      UPDATE daily_selections SET created_at = selected_at;

      DROP INDEX threads_active_name;
      CREATE INDEX threads_active_normalized_name
        ON threads(normalized_name) WHERE deleted_at IS NULL;

      DROP TRIGGER sync_outbox_books_insert;
      DROP TRIGGER sync_outbox_books_update;
      DROP TRIGGER sync_outbox_highlights_insert;
      DROP TRIGGER sync_outbox_highlights_update;
      DROP TRIGGER sync_outbox_notes_insert;
      DROP TRIGGER sync_outbox_notes_update;
      DROP TRIGGER sync_outbox_collections_insert;
      DROP TRIGGER sync_outbox_collections_update;
      DROP TRIGGER sync_outbox_tags_insert;
      DROP TRIGGER sync_outbox_tags_update;
      CREATE TEMP TABLE sync_outbox_v16_sequence (value INTEGER NOT NULL);
      INSERT INTO sync_outbox_v16_sequence
      SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'sync_outbox'), 0);
      DROP INDEX sync_outbox_pending;
      DROP INDEX sync_outbox_entity;
      ALTER TABLE sync_outbox RENAME TO sync_outbox_v16;
      CREATE TABLE sync_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL REFERENCES sync_devices(id),
        entity_type TEXT NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag', 'thread', 'daily-selection')),
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'tombstone')),
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      ) STRICT;
      INSERT INTO sync_outbox
        (sequence, device_id, entity_type, entity_id, revision, operation, created_at, acknowledged_at)
      SELECT sequence, device_id, entity_type, entity_id, revision, operation, created_at, acknowledged_at
      FROM sync_outbox_v16;
      DROP TABLE sync_outbox_v16;
      DELETE FROM sqlite_sequence WHERE name = 'sync_outbox';
      INSERT INTO sqlite_sequence (name, seq)
      SELECT 'sync_outbox', value FROM sync_outbox_v16_sequence;
      DROP TABLE sync_outbox_v16_sequence;
      CREATE INDEX sync_outbox_pending ON sync_outbox(acknowledged_at, sequence);
      CREATE INDEX sync_outbox_entity ON sync_outbox(entity_type, entity_id, sequence);

      CREATE TRIGGER sync_outbox_books_insert AFTER INSERT ON books
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'book', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_books_update AFTER UPDATE ON books
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'book', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_highlights_insert AFTER INSERT ON highlights
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'highlight', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted = 1 OR NEW.deleted_at IS NOT NULL THEN 'tombstone' ELSE 'upsert' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_highlights_update AFTER UPDATE ON highlights
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'highlight', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted = 1 THEN 'tombstone' ELSE 'upsert' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_notes_insert AFTER INSERT ON notes
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'note', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted = 1 OR NEW.deleted_at IS NOT NULL THEN 'tombstone' ELSE 'upsert' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_notes_update AFTER UPDATE ON notes
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'note', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted = 1 THEN 'tombstone' ELSE 'upsert' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_collections_insert AFTER INSERT ON collections
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'collection', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_collections_update AFTER UPDATE ON collections
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'collection', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_tags_insert AFTER INSERT ON tags
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'tag', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_tags_update AFTER UPDATE ON tags
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'tag', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_threads_insert AFTER INSERT ON threads
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'thread', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_threads_update AFTER UPDATE ON threads
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'thread', NEW.id, NEW.revision,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;

      CREATE TRIGGER sync_outbox_daily_selections_insert AFTER INSERT ON daily_selections
      WHEN EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'daily-selection', NEW.id, NEW.revision, 'upsert', NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;
      CREATE TRIGGER sync_outbox_daily_selections_update AFTER UPDATE ON daily_selections
      WHEN NEW.revision != OLD.revision AND EXISTS (SELECT 1 FROM sync_state WHERE singleton = 1)
      BEGIN
        INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
        SELECT device_id, 'daily-selection', NEW.id, NEW.revision, 'upsert', NEW.updated_at
        FROM sync_state WHERE singleton = 1;
      END;

      ALTER TABLE sync_incoming_writers RENAME TO sync_incoming_writers_v16;
      CREATE TABLE sync_incoming_writers (
        entity_type TEXT NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag', 'thread', 'daily-selection')),
        entity_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_revision INTEGER NOT NULL CHECK (device_revision > 0),
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'tombstone')),
        entity_revision INTEGER NOT NULL CHECK (entity_revision >= 0),
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      ) STRICT;
      INSERT INTO sync_incoming_writers SELECT * FROM sync_incoming_writers_v16;
      DROP TABLE sync_incoming_writers_v16;

      ALTER TABLE sync_tombstones RENAME TO sync_tombstones_v16;
      CREATE TABLE sync_tombstones (
        entity_type TEXT NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag', 'thread', 'daily-selection')),
        entity_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      ) STRICT;
      INSERT INTO sync_tombstones SELECT * FROM sync_tombstones_v16;
      DROP TABLE sync_tombstones_v16;

      -- A library that already syncs has never sent its threads or reading
      -- history, and its passage and book snapshots lacked them. Queue each
      -- affected entity once, as this device's claim to its current state.
      INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
      SELECT state.device_id, 'thread', threads.id, threads.revision,
        CASE WHEN threads.deleted_at IS NULL THEN 'upsert' ELSE 'tombstone' END, threads.updated_at
      FROM threads, sync_state AS state
      WHERE state.singleton = 1 AND state.snapshot_required = 0
      ORDER BY threads.created_at, threads.id;
      INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
      SELECT state.device_id, 'highlight', highlights.id, highlights.revision, 'upsert', highlights.updated_at
      FROM highlights, sync_state AS state
      WHERE state.singleton = 1 AND state.snapshot_required = 0
        AND highlights.deleted = 0 AND highlights.archived = 0
        AND EXISTS (SELECT 1 FROM thread_highlights WHERE thread_highlights.highlight_id = highlights.id)
      ORDER BY highlights.created_at, highlights.id;
      INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
      SELECT state.device_id, 'book', books.id, books.revision, 'upsert', books.updated_at
      FROM books, sync_state AS state
      WHERE state.singleton = 1 AND state.snapshot_required = 0 AND books.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM reading_status_events WHERE reading_status_events.book_id = books.id)
      ORDER BY books.created_at, books.id;
      INSERT INTO sync_outbox (device_id, entity_type, entity_id, revision, operation, created_at)
      SELECT state.device_id, 'daily-selection', daily_selections.id, daily_selections.revision, 'upsert',
        daily_selections.updated_at
      FROM daily_selections, sync_state AS state
      WHERE state.singleton = 1 AND state.snapshot_required = 0
      ORDER BY daily_selections.local_day, daily_selections.timezone;
    `,
  },
];

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0;

export function applyMigrations(
  database: DatabaseSync,
  available: readonly Migration[] = migrations,
): number {
  const current = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  const latest = available.reduce((maximum, migration) => Math.max(maximum, migration.version), 0);
  if (!Number.isSafeInteger(current) || current < 0 || current > latest) {
    throw new Error(`Database schema version ${current} is newer than this Leaflogue build supports`);
  }
  const pending = available.filter((migration) => migration.version > current);
  if (pending.length === 0) return current;

  let applied = current;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      if (migration.version !== applied + 1) {
        throw new Error(`Missing database migration ${applied + 1}`);
      }
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      applied = migration.version;
    }
    database.exec("COMMIT");
    return applied;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
