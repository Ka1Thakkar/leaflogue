import { initializePostgres, type PostgresClient } from "@leaflogue/remote";
import type { Database } from "./database";

/**
 * The server's own tables live in a separate `leaflogue_web` schema with its
 * own version. Desktops check `leaflogue.schema_migrations` exactly, so web
 * features never change the version they see: a desktop keeps syncing with a
 * database whatever this server adds. Nothing in here is synced.
 */
export const WEB_SCHEMA_VERSION = 2;

const WEB_SCHEMA_VERSION_1 = `
  CREATE SCHEMA IF NOT EXISTS leaflogue_web;
  CREATE TABLE IF NOT EXISTS leaflogue_web.schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE leaflogue_web.users (
    id uuid PRIMARY KEY,
    issuer text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer, subject)
  );

  CREATE TABLE leaflogue_web.library_members (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES leaflogue_web.users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, user_id)
  );
  CREATE INDEX library_members_by_user ON leaflogue_web.library_members (user_id);

  -- Only hashes of session tokens and sign-in states are stored.
  CREATE TABLE leaflogue_web.sessions (
    token_hash bytea PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES leaflogue_web.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX sessions_by_expiry ON leaflogue_web.sessions (expires_at);

  CREATE TABLE leaflogue_web.sign_in_states (
    state_hash bytea PRIMARY KEY,
    nonce text NOT NULL,
    code_verifier text NOT NULL,
    expires_at timestamptz NOT NULL
  );

  CREATE TABLE leaflogue_web.ai_settings (
    library_id uuid PRIMARY KEY REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    provider text NOT NULL,
    model text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE leaflogue_web.ai_request_windows (
    user_id uuid PRIMARY KEY REFERENCES leaflogue_web.users(id) ON DELETE CASCADE,
    window_started_at timestamptz NOT NULL,
    requests integer NOT NULL CHECK (requests >= 0)
  );

  CREATE TABLE leaflogue_web.publications (
    public_id text PRIMARY KEY,
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    highlight_id uuid NOT NULL,
    book_id uuid NOT NULL,
    highlight_revision integer NOT NULL,
    note_ids jsonb NOT NULL,
    passage text NOT NULL,
    book_title text NOT NULL,
    authors jsonb NOT NULL,
    notes jsonb NOT NULL,
    active boolean NOT NULL,
    published_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (library_id, highlight_id)
  );
  CREATE INDEX publications_by_library_active ON leaflogue_web.publications (library_id, active, published_at DESC);

  CREATE TABLE leaflogue_web.publication_reports (
    id bigserial PRIMARY KEY,
    public_id text NOT NULL,
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    reporter_key text NOT NULL,
    day date NOT NULL,
    reason text NOT NULL CHECK (reason IN ('copyright', 'harassment', 'personal_information', 'other')),
    details text,
    status text NOT NULL CHECK (status IN ('open', 'reviewed')),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX publication_reports_by_public_id ON leaflogue_web.publication_reports (public_id);
  CREATE INDEX publication_reports_by_reporter_day ON leaflogue_web.publication_reports (reporter_key, day);

  CREATE TABLE leaflogue_web.import_sources (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    provider text NOT NULL,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, id)
  );

  CREATE TABLE leaflogue_web.import_source_books (
    library_id uuid NOT NULL,
    source_id uuid NOT NULL,
    provider_record_id text NOT NULL,
    book_id uuid NOT NULL,
    fingerprint text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, source_id, provider_record_id),
    FOREIGN KEY (library_id, source_id) REFERENCES leaflogue_web.import_sources(library_id, id) ON DELETE CASCADE
  );

  CREATE TABLE leaflogue_web.import_source_annotations (
    library_id uuid NOT NULL,
    source_id uuid NOT NULL,
    provider_record_id text NOT NULL,
    book_id uuid NOT NULL,
    highlight_id uuid,
    highlight_revision integer,
    attached_note_id uuid,
    attached_note_revision integer,
    note_id uuid,
    note_revision integer,
    fingerprint text NOT NULL,
    incoming text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, source_id, provider_record_id),
    FOREIGN KEY (library_id, source_id) REFERENCES leaflogue_web.import_sources(library_id, id) ON DELETE CASCADE
  );

  CREATE INDEX import_source_annotations_by_highlight ON leaflogue_web.import_source_annotations (library_id, highlight_id);

  CREATE TABLE leaflogue_web.import_conflicts (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    source_id uuid NOT NULL,
    provider_record_id text NOT NULL,
    book_id uuid NOT NULL,
    previous text NOT NULL,
    incoming text NOT NULL,
    incoming_fingerprint text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'kept', 'accepted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, id)
  );
  CREATE INDEX import_conflicts_by_status ON leaflogue_web.import_conflicts (library_id, status);
  CREATE INDEX import_conflicts_by_record ON leaflogue_web.import_conflicts (library_id, source_id, provider_record_id);
`;

/** Each reader's dashboard layouts in the web app. */
const WEB_SCHEMA_VERSION_2 = `
  CREATE TABLE leaflogue_web.dashboard_layouts (
    library_id uuid NOT NULL REFERENCES leaflogue.libraries(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES leaflogue_web.users(id) ON DELETE CASCADE,
    dashboard text NOT NULL CHECK (dashboard IN ('library', 'statistics')),
    layout jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (library_id, user_id, dashboard)
  );
`;

const WEB_SCHEMA_MIGRATIONS = [{ version: 1, sql: WEB_SCHEMA_VERSION_1 }, { version: 2, sql: WEB_SCHEMA_VERSION_2 }] as const;

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

/**
 * Bring both schemas up to date before serving. The library schema is the
 * desktop's own (`initializePostgres`), so a server upgrade that needs a newer
 * one moves desktops on older builds to "update required", as a newer desktop
 * would.
 */
export async function prepareDatabase(database: Database): Promise<void> {
  await database.withClient(async (client) => {
    const library = await initializePostgres("leaflogue-server", () => client);
    if (!library.initialized) throw new SchemaError(library.problem ?? "The Leaflogue schema could not be prepared");
    await migrateWebSchema(client);
  });
}

async function migrateWebSchema(client: PostgresClient): Promise<void> {
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(1279671368)");
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS leaflogue_web;
      CREATE TABLE IF NOT EXISTS leaflogue_web.schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const installed = await client.query<{ version: number | string | null }>("SELECT max(version) AS version FROM leaflogue_web.schema_migrations", []);
    const current = Number(installed.rows[0]?.version ?? 0);
    if (current > WEB_SCHEMA_VERSION) throw new SchemaError("The web schema is newer than this server. Update the server.");
    for (const migration of WEB_SCHEMA_MIGRATIONS.filter(({ version }) => version > current)) {
      await client.query(migration.sql);
      await client.query("INSERT INTO leaflogue_web.schema_migrations (version) VALUES ($1)", [migration.version]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
