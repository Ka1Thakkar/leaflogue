import pg from "pg";

const { Client } = pg;
export const REMOTE_SCHEMA_VERSION = 13;

export interface RemoteSchemaStatus {
  readonly reachable: boolean;
  readonly initialized: boolean;
  readonly schemaVersion?: number;
  readonly problem?: string;
}

export interface PostgresClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: Row[] }>;
  end(): Promise<void>;
}

export type PostgresClientFactory = (connectionString: string) => PostgresClient;

/** Fail closed before any sync provisioning or mutation touches the database. */
export async function assertCurrentPostgresSchema(client: PostgresClient): Promise<void> {
  const relation = await client.query<{ name: string | null }>(
    "SELECT to_regclass('leaflogue.schema_migrations')::text AS name",
  );
  if (!relation.rows[0]?.name) {
    throw Object.assign(new Error("Leaflogue schema is unavailable"), { code: "LEAFLOGUE_SCHEMA_REQUIRED" });
  }
  const installed = await client.query<{ version: number | string | null }>(
    "SELECT max(version) AS version FROM leaflogue.schema_migrations",
  );
  const version = Number(installed.rows[0]?.version ?? 0);
  if (version !== REMOTE_SCHEMA_VERSION) {
    throw Object.assign(new Error("Leaflogue schema version is incompatible"), {
      code: version > REMOTE_SCHEMA_VERSION ? "LEAFLOGUE_SCHEMA_NEWER" : "LEAFLOGUE_SCHEMA_REQUIRED",
    });
  }
}

export async function checkPostgres(
  connectionString: string,
  factory: PostgresClientFactory = createPostgresClient,
): Promise<RemoteSchemaStatus> {
  const client = factory(connectionString);
  try {
    await client.connect();
    const relation = await client.query<{ name: string | null }>(
      "SELECT to_regclass('leaflogue.schema_migrations')::text AS name",
    );
    if (!relation.rows[0]?.name) return { reachable: true, initialized: false };
    const result = await client.query<{ version: number | null }>(
      "SELECT max(version) AS version FROM leaflogue.schema_migrations",
    );
    const version = result.rows[0]?.version;
    const numericVersion = version === null || version === undefined ? undefined : Number(version);
    if (numericVersion !== undefined && numericVersion !== REMOTE_SCHEMA_VERSION) {
      return {
        reachable: true,
        initialized: false,
        schemaVersion: numericVersion,
        problem: numericVersion > REMOTE_SCHEMA_VERSION
          ? "The PostgreSQL schema is newer than this Leaflogue build supports."
          : "The PostgreSQL schema requires an upgrade before it can be used.",
      };
    }
    return {
      reachable: true,
      initialized: numericVersion !== undefined,
      ...(numericVersion !== undefined ? { schemaVersion: numericVersion } : {}),
    };
  } catch (error) {
    return { reachable: false, initialized: false, problem: safeDatabaseProblem(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function initializePostgres(
  connectionString: string,
  factory: PostgresClientFactory = createPostgresClient,
): Promise<RemoteSchemaStatus> {
  const client = factory(connectionString);
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(1279671367)");
    await client.query(SCHEMA_MIGRATION_BOOTSTRAP);
    const installed = await client.query<{ version: number | null }>(
      "SELECT max(version) AS version FROM leaflogue.schema_migrations",
    );
    const currentVersion = Number(installed.rows[0]?.version ?? 0);
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 0 || currentVersion > REMOTE_SCHEMA_VERSION) {
      throw Object.assign(new Error("Unsupported remote schema version"), { code: "LEAFLOGUE_SCHEMA_NEWER" });
    }
    for (const migration of REMOTE_SCHEMA_MIGRATIONS.filter(({ version }) => version > currentVersion)) {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO leaflogue.schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
        [migration.version],
      );
    }
    await client.query("COMMIT");
    return { reachable: true, initialized: true, schemaVersion: REMOTE_SCHEMA_VERSION };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return { reachable: false, initialized: false, problem: safeDatabaseProblem(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function createPostgresClient(connectionString: string): PostgresClient {
  return new Client({
    connectionString,
    application_name: "leaflogue-desktop",
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  }) as unknown as PostgresClient;
}

function safeDatabaseProblem(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (code === "28P01" || code === "28000") return "PostgreSQL rejected the configured credentials.";
  if (code === "42501") return "The configured PostgreSQL role lacks schema permissions.";
  if (code === "3D000") return "The configured PostgreSQL database does not exist.";
  if (code === "LEAFLOGUE_SCHEMA_NEWER") return "The PostgreSQL schema is newer than this Leaflogue build supports.";
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return "Leaflogue could not reach the configured PostgreSQL server.";
  }
  return "Leaflogue could not verify the remote database.";
}

const SCHEMA_VERSION_1 = `
  CREATE SCHEMA IF NOT EXISTS leaflogue;
  CREATE TABLE IF NOT EXISTS leaflogue.schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS leaflogue.libraries (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS leaflogue.devices (
    id uuid PRIMARY KEY,
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS leaflogue.books (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    title text NOT NULL CHECK (length(trim(title)) > 0),
    authors jsonb NOT NULL DEFAULT '[]'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'reading', 'finished', 'paused')),
    archived boolean NOT NULL DEFAULT false,
    deleted_at timestamptz,
    revision bigint NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (library_id, id)
  );
  CREATE TABLE IF NOT EXISTS leaflogue.highlights (
    library_id uuid NOT NULL,
    id uuid NOT NULL,
    book_id uuid NOT NULL,
    text text NOT NULL CHECK (length(trim(text)) > 0),
    source_location text,
    source_created_at timestamptz,
    archived boolean NOT NULL DEFAULT false,
    deleted_at timestamptz,
    revision bigint NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (library_id, id),
    FOREIGN KEY (library_id, book_id) REFERENCES leaflogue.books(library_id, id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS leaflogue.notes (
    library_id uuid NOT NULL,
    id uuid NOT NULL,
    book_id uuid NOT NULL,
    highlight_id uuid,
    markdown text NOT NULL CHECK (length(trim(markdown)) > 0),
    origin text NOT NULL CHECK (origin IN ('reader', 'import', 'ai')),
    deleted_at timestamptz,
    revision bigint NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (library_id, id),
    FOREIGN KEY (library_id, book_id) REFERENCES leaflogue.books(library_id, id) ON DELETE CASCADE,
    FOREIGN KEY (library_id, highlight_id) REFERENCES leaflogue.highlights(library_id, id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS leaflogue.sync_changes (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    entity_type text NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note')),
    entity_id uuid NOT NULL,
    revision bigint NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS books_library_updated ON leaflogue.books(library_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS highlights_library_book ON leaflogue.highlights(library_id, book_id, updated_at);
  CREATE INDEX IF NOT EXISTS notes_library_book ON leaflogue.notes(library_id, book_id, updated_at);
  CREATE INDEX IF NOT EXISTS sync_changes_library_sequence ON leaflogue.sync_changes(library_id, sequence);
`;

const SCHEMA_MIGRATION_BOOTSTRAP = `
  CREATE SCHEMA IF NOT EXISTS leaflogue;
  CREATE TABLE IF NOT EXISTS leaflogue.schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;

const SCHEMA_VERSION_2 = `
  ALTER TABLE leaflogue.books
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE leaflogue.highlights
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE leaflogue.notes
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
`;

const SCHEMA_VERSION_3 = `
  CREATE TABLE IF NOT EXISTS leaflogue.collections (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 120),
    description text CHECK (description IS NULL OR length(description) <= 2000),
    deleted_at timestamptz,
    revision bigint NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (library_id, id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS collections_library_active_name
    ON leaflogue.collections(library_id, normalized_name) WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS leaflogue.tags (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 80),
    color text CHECK (color IS NULL OR length(color) BETWEEN 1 AND 32),
    deleted_at timestamptz,
    revision bigint NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (library_id, id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS tags_library_active_name
    ON leaflogue.tags(library_id, normalized_name) WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS leaflogue.collection_books (
    library_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    book_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, collection_id, book_id),
    FOREIGN KEY (library_id, collection_id) REFERENCES leaflogue.collections(library_id, id) ON DELETE CASCADE,
    FOREIGN KEY (library_id, book_id) REFERENCES leaflogue.books(library_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS collection_books_library_book
    ON leaflogue.collection_books(library_id, book_id, collection_id);

  CREATE TABLE IF NOT EXISTS leaflogue.book_tags (
    library_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    book_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, tag_id, book_id),
    FOREIGN KEY (library_id, tag_id) REFERENCES leaflogue.tags(library_id, id) ON DELETE CASCADE,
    FOREIGN KEY (library_id, book_id) REFERENCES leaflogue.books(library_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS book_tags_library_book
    ON leaflogue.book_tags(library_id, book_id, tag_id);

  CREATE TABLE IF NOT EXISTS leaflogue.highlight_tags (
    library_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    highlight_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, tag_id, highlight_id),
    FOREIGN KEY (library_id, tag_id) REFERENCES leaflogue.tags(library_id, id) ON DELETE CASCADE,
    FOREIGN KEY (library_id, highlight_id) REFERENCES leaflogue.highlights(library_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS highlight_tags_library_highlight
    ON leaflogue.highlight_tags(library_id, highlight_id, tag_id);
`;

const SCHEMA_VERSION_4 = `
  ALTER TABLE leaflogue.sync_changes
    DROP CONSTRAINT IF EXISTS sync_changes_entity_type_check;
  ALTER TABLE leaflogue.sync_changes
    ADD CONSTRAINT sync_changes_entity_type_check
    CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag'));
`;

const SCHEMA_VERSION_5 = `
  ALTER TABLE leaflogue.books
    ADD COLUMN IF NOT EXISTS completed_on date;

  CREATE TABLE IF NOT EXISTS leaflogue.reading_status_events (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    library_id uuid NOT NULL,
    id uuid NOT NULL,
    book_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('unread', 'reading', 'finished', 'paused')),
    source text NOT NULL CHECK (source IN ('reader', 'merge', 'kindle', 'kobo', 'portable')),
    changed_at timestamptz NOT NULL,
    completed_on date,
    book_revision bigint NOT NULL CHECK (book_revision > 0),
    UNIQUE (library_id, id),
    FOREIGN KEY (library_id, book_id) REFERENCES leaflogue.books(library_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS reading_status_events_library_book_changed
    ON leaflogue.reading_status_events(library_id, book_id, changed_at DESC, sequence DESC);
`;

const SCHEMA_VERSION_6 = `
  CREATE TABLE IF NOT EXISTS leaflogue.threads (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 120),
    description text CHECK (description IS NULL OR length(description) <= 1000),
    deleted_at timestamptz,
    revision bigint NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (library_id, id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS threads_library_active_name
    ON leaflogue.threads(library_id, normalized_name) WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS leaflogue.thread_highlights (
    library_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    highlight_id uuid NOT NULL,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, thread_id, highlight_id),
    FOREIGN KEY (library_id, thread_id) REFERENCES leaflogue.threads(library_id, id) ON DELETE CASCADE,
    FOREIGN KEY (library_id, highlight_id) REFERENCES leaflogue.highlights(library_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS thread_highlights_library_highlight
    ON leaflogue.thread_highlights(library_id, highlight_id, thread_id);

  CREATE TABLE IF NOT EXISTS leaflogue.daily_selections (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    local_day date NOT NULL,
    timezone text NOT NULL CHECK (length(trim(timezone)) BETWEEN 1 AND 100),
    highlight_id uuid,
    candidate_digest text NOT NULL CHECK (length(candidate_digest) = 64),
    recent_highlight_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    selected_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    PRIMARY KEY (library_id, local_day, timezone),
    FOREIGN KEY (library_id, highlight_id) REFERENCES leaflogue.highlights(library_id, id) ON DELETE SET NULL (highlight_id),
    CHECK (jsonb_typeof(recent_highlight_ids) = 'array')
  );
  CREATE INDEX IF NOT EXISTS daily_selections_library_updated
    ON leaflogue.daily_selections(library_id, updated_at DESC);

  ALTER TABLE leaflogue.sync_changes
    DROP CONSTRAINT IF EXISTS sync_changes_entity_type_check;
  ALTER TABLE leaflogue.sync_changes
    ADD CONSTRAINT sync_changes_entity_type_check
    CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag', 'thread', 'daily-selection'));
`;

const SCHEMA_VERSION_7 = `
  ALTER TABLE leaflogue.daily_selections ADD COLUMN IF NOT EXISTS id uuid;
  WITH missing AS (
    SELECT library_id, local_day, timezone,
      md5(library_id::text || ':' || local_day::text || ':' || timezone) AS digest
    FROM leaflogue.daily_selections WHERE id IS NULL
  )
  UPDATE leaflogue.daily_selections AS selections
  SET id = (
    substr(missing.digest, 1, 8) || '-' || substr(missing.digest, 9, 4) || '-4' ||
    substr(missing.digest, 14, 3) || '-8' || substr(missing.digest, 18, 3) || '-' ||
    substr(missing.digest, 21, 12)
  )::uuid
  FROM missing
  WHERE selections.library_id = missing.library_id
    AND selections.local_day = missing.local_day
    AND selections.timezone = missing.timezone;
  ALTER TABLE leaflogue.daily_selections ALTER COLUMN id SET NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS daily_selections_library_id
    ON leaflogue.daily_selections(library_id, id);
`;

/**
 * Which device's edit currently owns each synced entity. A synced write is not
 * the interactive, revision-checked kind: it replays another device's history,
 * whose revision counts that device's edits rather than everyone's. Ordering
 * incoming writes by (revision, device) gives every replica the same total
 * order, so they converge on the same winner without a shared clock, and a
 * repeated delivery loses to the row it already wrote.
 */
const SCHEMA_VERSION_8 = `
  CREATE TABLE IF NOT EXISTS leaflogue.synced_writers (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    entity_type text NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note')),
    entity_id uuid NOT NULL,
    device_id uuid NOT NULL,
    device_revision bigint NOT NULL CHECK (device_revision > 0),
    applied_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, entity_type, entity_id)
  );
`;

/** Tombstones outrank upserts for a stable entity id, independent of delivery order. */
const SCHEMA_VERSION_9 = `
  ALTER TABLE leaflogue.synced_writers
    ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'upsert'
      CHECK (operation IN ('upsert', 'tombstone'));
  UPDATE leaflogue.synced_writers AS writers
  SET operation = 'tombstone'
  FROM leaflogue.books
  WHERE writers.library_id = books.library_id
    AND writers.entity_type = 'book'
    AND writers.entity_id = books.id
    AND books.deleted_at IS NOT NULL;
`;

/** Bodies that lose deterministic sync ordering remain available for review. */
const SCHEMA_VERSION_10 = `
  CREATE TABLE IF NOT EXISTS leaflogue.sync_tombstones (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    entity_type text NOT NULL CHECK (entity_type IN ('book', 'highlight', 'note')),
    entity_id uuid NOT NULL,
    book_id uuid,
    revision bigint NOT NULL CHECK (revision > 0),
    deleted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, entity_type, entity_id)
  );
  CREATE TABLE IF NOT EXISTS leaflogue.sync_conflicts (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    entity_type text NOT NULL CHECK (entity_type IN ('highlight', 'note')),
    entity_id uuid NOT NULL,
    book_id uuid NOT NULL,
    losing_body text NOT NULL CHECK (length(losing_body) > 0),
    winning_body text,
    losing_device_id uuid,
    losing_device_revision bigint,
    losing_operation text NOT NULL CHECK (losing_operation IN ('upsert', 'tombstone')),
    winning_operation text NOT NULL CHECK (winning_operation IN ('upsert', 'tombstone')),
    fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'superseded')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, id),
    UNIQUE (library_id, fingerprint)
  );
  CREATE INDEX IF NOT EXISTS sync_conflicts_library_pending
    ON leaflogue.sync_conflicts(library_id, created_at DESC) WHERE status = 'pending';
`;

const SCHEMA_VERSION_11 = `
  CREATE TABLE IF NOT EXISTS leaflogue.library_sync_state (
    library_id uuid PRIMARY KEY REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    instance_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
  );
  INSERT INTO leaflogue.library_sync_state (library_id)
    SELECT id FROM leaflogue.libraries
    ON CONFLICT (library_id) DO NOTHING;
  ALTER TABLE leaflogue.sync_changes
    ADD COLUMN IF NOT EXISTS change_token uuid NOT NULL DEFAULT gen_random_uuid();
`;

const SCHEMA_VERSION_12 = `
  DROP INDEX IF EXISTS leaflogue.collections_library_active_name;
  CREATE INDEX collections_library_active_name
    ON leaflogue.collections(library_id, normalized_name) WHERE deleted_at IS NULL;
  DROP INDEX IF EXISTS leaflogue.tags_library_active_name;
  CREATE INDEX tags_library_active_name
    ON leaflogue.tags(library_id, normalized_name) WHERE deleted_at IS NULL;
  ALTER TABLE leaflogue.synced_writers
    DROP CONSTRAINT IF EXISTS synced_writers_entity_type_check;
  ALTER TABLE leaflogue.synced_writers
    ADD CONSTRAINT synced_writers_entity_type_check
    CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag'));
  ALTER TABLE leaflogue.sync_tombstones
    DROP CONSTRAINT IF EXISTS sync_tombstones_entity_type_check;
  ALTER TABLE leaflogue.sync_tombstones
    ADD CONSTRAINT sync_tombstones_entity_type_check
    CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag'));
`;

const SCHEMA_VERSION_13 = `
  DROP INDEX IF EXISTS leaflogue.threads_library_active_name;
  CREATE INDEX threads_library_active_name
    ON leaflogue.threads(library_id, normalized_name) WHERE deleted_at IS NULL;
  ALTER TABLE leaflogue.synced_writers
    DROP CONSTRAINT IF EXISTS synced_writers_entity_type_check;
  ALTER TABLE leaflogue.synced_writers
    ADD CONSTRAINT synced_writers_entity_type_check
    CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag', 'thread', 'daily-selection'));
  ALTER TABLE leaflogue.sync_tombstones
    DROP CONSTRAINT IF EXISTS sync_tombstones_entity_type_check;
  ALTER TABLE leaflogue.sync_tombstones
    ADD CONSTRAINT sync_tombstones_entity_type_check
    CHECK (entity_type IN ('book', 'highlight', 'note', 'collection', 'tag', 'thread', 'daily-selection'));
  -- A pick's first-selection time never changes, so every node settles a
  -- same-day collision between two devices' picks the same way.
  ALTER TABLE leaflogue.daily_selections ADD COLUMN IF NOT EXISTS created_at timestamptz;
  UPDATE leaflogue.daily_selections SET created_at = selected_at WHERE created_at IS NULL;
  ALTER TABLE leaflogue.daily_selections ALTER COLUMN created_at SET DEFAULT now();
  ALTER TABLE leaflogue.daily_selections ALTER COLUMN created_at SET NOT NULL;
`;

const REMOTE_SCHEMA_MIGRATIONS = [
  { version: 1, sql: SCHEMA_VERSION_1 },
  { version: 2, sql: SCHEMA_VERSION_2 },
  { version: 3, sql: SCHEMA_VERSION_3 },
  { version: 4, sql: SCHEMA_VERSION_4 },
  { version: 5, sql: SCHEMA_VERSION_5 },
  { version: 6, sql: SCHEMA_VERSION_6 },
  { version: 7, sql: SCHEMA_VERSION_7 },
  { version: 8, sql: SCHEMA_VERSION_8 },
  { version: 9, sql: SCHEMA_VERSION_9 },
  { version: 10, sql: SCHEMA_VERSION_10 },
  { version: 11, sql: SCHEMA_VERSION_11 },
  { version: 12, sql: SCHEMA_VERSION_12 },
  { version: 13, sql: SCHEMA_VERSION_13 },
] as const;
