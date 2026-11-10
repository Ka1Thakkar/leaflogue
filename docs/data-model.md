# Local data model

Status: proposed SQLite model for the first Electron implementation.

The desktop database is a single-user reading library. It deliberately has no
`owner_id`, auth tables, provider credentials, or public-sharing records. IDs are
application-generated UUID strings so they remain stable across backup, restore,
and later sync. All timestamps are UTC epoch milliseconds; user-entered calendar
dates are ISO `YYYY-MM-DD` strings.

## Core records

### `books`

One row represents the edition in the reader's library. It stores title,
authors JSON, description, publisher, series, series number, language, validated
ISBN-13, HTTPS cover URL, reading status, completion date, archive state, and
created/updated/revision timestamps.

Provider metadata is never allowed to overwrite explicit reader edits. A
`book_field_overrides` table records the fields the reader owns. Works/editions
may be normalized later if sync or edition switching requires it; the local MVP
does not depend on a particular hosted projection hierarchy.

### `highlights`

A highlight belongs to one book and stores effective passage text, optional
source location, visibility, archive/tombstone state, source-created time, local
created/updated time, and revision. Location is optional and appears beneath a
passage when present.

### `notes`

Every note is a first-class row belonging to a book and may optionally belong to
a highlight. This preserves source notes that have no passage without inventing
empty highlights. It stores Markdown source, origin (`reader`, `import`, or
`ai`), deletion state, and revision. AI replies are not saved unless the reader
explicitly adds one as a note.

### Organisation

`tags`, `highlight_tags`, `book_tags`, `collections`, `collection_books`,
`threads`, and `thread_highlights` use UUID foreign keys and unique join indexes.
Deleting a container removes its joins, never the underlying book or highlight.

`reading_status_events` preserves optional history with source (`reader`, an
import provider, or merge consolidation), status, occurrence time, and optional
completion date. A merge appends the surviving projection as the canonical
latest event after consolidating both timelines. The current book status remains
a projection for fast library display.

Thread rows are revisioned containers; `thread_highlights` is a bounded join
whose mutations advance both the thread and highlight revisions atomically. A
thread deletion removes only its joins and tombstones the container—the source
passages and their notes remain in the library.

## Import provenance

```text
import_sources ──< import_runs ──< import_items
      │                               │
      ├──< source_books >──────────── books
      └──< source_annotations >────── highlights or notes
                                      │
                              import_conflicts
```

- `import_sources`: a named, user-selected provider/device profile with a stable
  UUID, such as one Kobo library. A hashed local path may suggest a prior profile,
  but it is never its identity and is never exposed to the renderer.
- `import_runs`: file name, provider, parser/schema version, content digest,
  status, counts, warnings, and timestamps.
- `import_items`: bounded staging rows used only until a reviewed import commits.
- `source_books`: provider book ID, linked local book, canonical raw JSON,
  source fingerprint, and last-seen run.
- `source_annotations`: provider annotation ID, linked local highlight or
  independent note, canonical raw JSON, source fingerprint, last-seen time, and
  a detached flag that prevents a later import from overwriting reader edits.
- `import_conflicts`: immutable base/incoming snapshots and an explicit outcome.

Parsed files first produce an `ImportPreview`. Book candidates are scored using
validated ISBN, normalized title, author overlap, and provider provenance. A
high-confidence match can be preselected, but fuzzy title similarity alone never
commits a merge. The reader may choose any compatible destination or create a
new book. Merge transactions move highlights, notes, tags, collection membership,
threads, source links, status history, and field overrides before archiving the
source book.

An import is idempotent on `(source_id, provider_record_id)`. When a provider has
no stable record ID, the adapter stores a versioned canonical fingerprint and an
occurrence ordinal. A parser-version change creates a duplicate-review candidate
instead of silently treating regenerated identifiers as new highlights.

## Daily selection

`daily_selections` is unique on `(local_day, timezone_policy)` and stores the
chosen highlight ID plus the candidate-set digest used at selection time. It is
created transactionally and reused on every device after sync.

Selection is book-balanced: choose an eligible book uniformly first, then choose
one of that book's eligible highlights, while avoiding a bounded recent-history
window. A book with 500 highlights therefore does not receive 500 times the
chance of a book with one highlight.

The local implementation derives a stable choice from the day, timezone,
candidate digest, and selection revision. “Another passage” advances that
revision, while an unchanged selection is reused throughout the same local day.

## Sync preparation

Every mutable record has a UUID, monotonically increasing revision, updated
timestamp, and tombstone where deletion must propagate. `sync_outbox` stores
committed operation envelopes after local transactions; `sync_state` stores the
server cursor and device identity. These tables can exist before sync is enabled,
but local-only mode performs no network activity.

The shared protocol identifies each outbox operation as `deviceId:sequence`.
Providers acknowledge that identity idempotently, not merely an entity revision.
Remote pages are strictly ordered within a generation; a generation change is a
data-free reset page that requires a full resync before its cursor is retained.
Pages contain at most 100 changes and cannot claim to continue without advancing.
New entity IDs are canonical lowercase; the protocol still accepts legacy
mixed-case entity IDs returned by an upgraded Convex deployment.

A versioned full-sync snapshot groups each book's contents, organisation, and
complete reading-status timeline. It contains no provider credentials, local
paths, or installation identity, so provider adapters can transfer the same
domain payload without leaking trusted-process configuration.

## SQLite operation

- Enable `foreign_keys`, WAL mode, and a bounded busy timeout on every connection.
- Mark Leaflogue backups with a SQLite application ID and retain numbered schema
  versions so restore can reject unrelated, damaged, or newer databases.
- Run numbered migrations in one transaction and back up before irreversible
  migrations.
- Use FTS5 as a derived index for book, passage, and note text; canonical rows
  remain the source of truth and can rebuild the index.
- Store credentials in the protected permission-`0600` application config or
  process environment, never this database or an export.
- Never mutate the selected import file. Parse a read-only copy, validate it,
  stage bounded records, show review, then commit one local transaction.
