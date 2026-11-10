import { describe, expect, it, vi } from "vitest";
import {
  checkPostgres,
  initializePostgres,
  type PostgresClient,
  type PostgresClientFactory,
} from "./postgres";
import { PostgresLibraryMutations } from "./postgres-library";
import { MAX_NOTE_BYTES, type Book, type BookId, type SyncedChange, WEB_DEVICE_ID } from "@leaflogue/contracts";

class FakeClient implements PostgresClient {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  connected = false;
  ended = false;
  relationName: string | null = null;
  version: number | null = null;
  failure?: { code: string };
  membershipCount = 0;
  membershipIncluded = false;
  mergedMembershipCount = 0;
  readonly returningRows: Array<Record<string, unknown>[]> = [];
  readonly selectedRows: Array<Record<string, unknown>[]> = [];

  async connect(): Promise<void> {
    if (this.failure) throw this.failure;
    this.connected = true;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: Row[] }> {
    this.queries.push({ text, ...(values ? { values } : {}) });
    if (text.includes("to_regclass")) return { rows: [{ name: this.relationName }] as unknown as Row[] };
    if (text.includes("max(version)")) return { rows: [{ version: this.version }] as unknown as Row[] };
    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("AS membership_count")) return { rows: [{
      membership_count: this.membershipCount,
      included: this.membershipIncluded,
    }] as unknown as Row[] };
    if (text.includes("AS merged_membership_count")) return {
      rows: [{ merged_membership_count: this.mergedMembershipCount }] as unknown as Row[],
    };
    if (text.includes("FROM leaflogue.books AS books")) return { rows: (this.selectedRows.shift() ?? []) as Row[] };
    if (/^\s*SELECT/u.test(text)) return { rows: (this.selectedRows.shift() ?? []) as Row[] };
    if (text.includes("RETURNING")) return { rows: (this.returningRows.shift() ?? []) as Row[] };
    return { rows: [] };
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

function factoryFor(client: FakeClient, expectedSecret = "postgres://user:secret@db/leaflogue"): PostgresClientFactory {
  return (connectionString) => {
    expect(connectionString).toBe(expectedSecret);
    return client;
  };
}

describe("PostgreSQL schema setup", () => {
  it("recognizes a reachable database without a Leaflogue schema", async () => {
    const client = new FakeClient();
    await expect(checkPostgres("postgres://user:secret@db/leaflogue", factoryFor(client)))
      .resolves.toEqual({ reachable: true, initialized: false });
    expect(client.connected).toBe(true);
    expect(client.queries).toHaveLength(1);
    expect(client.ended).toBe(true);
  });

  it("reports the installed schema version", async () => {
    const client = new FakeClient();
    client.relationName = "leaflogue.schema_migrations";
    client.version = 1;
    await expect(checkPostgres("postgres://user:secret@db/leaflogue", factoryFor(client)))
      .resolves.toEqual({
        reachable: true,
        initialized: false,
        schemaVersion: 1,
        problem: "The PostgreSQL schema requires an upgrade before it can be used.",
      });
  });

  it("initializes inside an advisory-locked transaction", async () => {
    const client = new FakeClient();
    await expect(initializePostgres("postgres://user:secret@db/leaflogue", factoryFor(client)))
      .resolves.toEqual({ reachable: true, initialized: true, schemaVersion: 13 });
    expect(client.queries.map(({ text }) => text.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(1279671367)",
      "CREATE SCHEMA IF",
      "SELECT max(version) AS",
      "CREATE SCHEMA IF",
      "INSERT INTO leaflogue.schema_migrations",
      "ALTER TABLE leaflogue.books",
      "INSERT INTO leaflogue.schema_migrations",
      "CREATE TABLE IF",
      "INSERT INTO leaflogue.schema_migrations",
      "ALTER TABLE leaflogue.sync_changes",
      "INSERT INTO leaflogue.schema_migrations",
      "ALTER TABLE leaflogue.books",
      "INSERT INTO leaflogue.schema_migrations",
      "CREATE TABLE IF",
      "INSERT INTO leaflogue.schema_migrations",
      "ALTER TABLE leaflogue.daily_selections",
      "INSERT INTO leaflogue.schema_migrations",
      "CREATE TABLE IF",
      "INSERT INTO leaflogue.schema_migrations",
      "ALTER TABLE leaflogue.synced_writers",
      "INSERT INTO leaflogue.schema_migrations",
      "CREATE TABLE IF",
      "INSERT INTO leaflogue.schema_migrations",
      "CREATE TABLE IF",
      "INSERT INTO leaflogue.schema_migrations",
      "DROP INDEX IF",
      "INSERT INTO leaflogue.schema_migrations",
      "DROP INDEX IF",
      "INSERT INTO leaflogue.schema_migrations",
      "COMMIT",
    ]);
    expect(client.queries[4]?.text).toContain("CREATE TABLE IF NOT EXISTS leaflogue.books");
    expect(client.queries[4]?.text).toContain("CREATE TABLE IF NOT EXISTS leaflogue.sync_changes");
    expect(client.queries[6]?.text).toContain("ADD COLUMN IF NOT EXISTS created_at");
    expect(client.queries[8]?.text).toContain("leaflogue.collections");
    expect(client.queries[8]?.text).toContain("leaflogue.highlight_tags");
    expect(client.queries[10]?.text).toContain("'collection', 'tag'");
    expect(client.queries[12]?.text).toContain("leaflogue.reading_status_events");
    expect(client.queries[12]?.text).toContain("ADD COLUMN IF NOT EXISTS completed_on");
    expect(client.queries[14]?.text).toContain("leaflogue.threads");
    expect(client.queries[14]?.text).toContain("leaflogue.thread_highlights");
    expect(client.queries[14]?.text).toContain("leaflogue.daily_selections");
    expect(client.queries[14]?.text).toContain("'thread', 'daily-selection'");
    expect(client.queries[16]?.text).toContain("daily_selections_library_id");
    expect(client.queries[20]?.text).toContain("ADD COLUMN IF NOT EXISTS operation");
    expect(client.queries[22]?.text).toContain("leaflogue.sync_tombstones");
    expect(client.queries[22]?.text).toContain("leaflogue.sync_conflicts");
    expect(client.queries[24]?.text).toContain("leaflogue.library_sync_state");
    expect(client.queries[24]?.text).toContain("change_token");
    expect(client.queries[26]?.text).toContain("'collection', 'tag'");
  });

  it("refuses to initialize over a newer PostgreSQL schema", async () => {
    const client = new FakeClient();
    client.version = 99;
    await expect(initializePostgres("postgres://user:secret@db/leaflogue", factoryFor(client)))
      .resolves.toEqual({
        reachable: false,
        initialized: false,
        problem: "The PostgreSQL schema is newer than this Leaflogue build supports.",
      });
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("returns a redacted authentication failure", async () => {
    const client = new FakeClient();
    client.failure = { code: "28P01" };
    const status = await checkPostgres("postgres://user:secret@db/leaflogue", factoryFor(client));
    expect(status.problem).toBe("PostgreSQL rejected the configured credentials.");
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(client.ended).toBe(true);
  });
});

describe("PostgreSQL organization mutation parity", () => {
  const libraryId = "20000000-0000-4000-8000-000000000000";
  const bookId = "30000000-0000-4000-8000-000000000000" as never;
  const collectionId = "40000000-0000-4000-8000-000000000000" as never;

  it("creates a client-identified collection with the shared normalized name", async () => {
    const client = new FakeClient();
    client.returningRows.push([{
      id: collectionId,
      name: "ÉTÉ Reads",
      description: "Seasonal",
      book_count: 0,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      revision: 1,
    }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.createCollection({
      id: collectionId,
      name: "  ÉTÉ   Reads ",
      description: " Seasonal ",
    })).resolves.toMatchObject({ id: collectionId, name: "ÉTÉ Reads", description: "Seasonal", revision: 1 });
    const insert = client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.collections"));
    expect(insert?.values).toEqual([libraryId, collectionId, "ÉTÉ Reads", "été reads", "Seasonal"]);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("changes membership atomically and leaves idempotent replays revision-neutral", async () => {
    const changedClient = new FakeClient();
    changedClient.selectedRows.push([{ revision: 2 }], [{ revision: 4 }]);
    changedClient.returningRows.push([{ book_id: bookId }], [{ revision: 5 }], [{ revision: 3 }]);
    const changed = new PostgresLibraryMutations(changedClient, libraryId);
    await expect(changed.setBookCollectionMembership({ bookId, collectionId, included: true }))
      .resolves.toEqual({
        changed: true,
        included: true,
        bookId,
        bookRevision: 3,
        containerId: collectionId,
        containerRevision: 5,
      });
    expect(changedClient.queries.some(({ text }) => text.includes("INSERT INTO leaflogue.sync_changes"))).toBe(true);
    expect(changedClient.queries.filter(({ text }) => text.includes("INSERT INTO leaflogue.sync_changes")).map(({ values }) => values?.[1]))
      .toEqual(["book", "collection"]);

    const replayClient = new FakeClient();
    replayClient.selectedRows.push([{ revision: 3 }], [{ revision: 5 }]);
    replayClient.returningRows.push([]);
    const replay = new PostgresLibraryMutations(replayClient, libraryId);
    await expect(replay.setBookCollectionMembership({ bookId, collectionId, included: true }))
      .resolves.toMatchObject({ changed: false, bookRevision: 3, containerRevision: 5 });
    expect(replayClient.queries.some(({ text }) => text.includes("SET revision = revision + 1"))).toBe(false);
  });

  it("refuses a new membership beyond the sync envelope while keeping an existing one idempotent", async () => {
    const capped = new FakeClient();
    capped.membershipCount = 1_000;
    capped.selectedRows.push([{ revision: 3 }], [{ revision: 5 }]);
    const mutations = new PostgresLibraryMutations(capped, libraryId);
    await expect(mutations.setBookCollectionMembership({ bookId, collectionId, included: true }))
      .rejects.toThrow("at most 1000 collections");
    expect(capped.queries.at(-1)?.text).toBe("ROLLBACK");

    const existing = new FakeClient();
    existing.membershipCount = 1_000;
    existing.membershipIncluded = true;
    existing.selectedRows.push([{ revision: 3 }], [{ revision: 5 }]);
    existing.returningRows.push([]);
    await expect(new PostgresLibraryMutations(existing, libraryId)
      .setBookCollectionMembership({ bookId, collectionId, included: true }))
      .resolves.toMatchObject({ changed: false, included: true });
  });

  it("updates collections optimistically and maps their current membership count", async () => {
    const client = new FakeClient();
    client.returningRows.push([{ id: collectionId, revision: 4 }]);
    client.selectedRows.push([{
      id: collectionId,
      name: "Renamed",
      description: null,
      book_count: 2,
      created_at_ms: 1_000,
      updated_at_ms: 2_000,
      revision: 4,
    }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.updateCollection({ id: collectionId, name: " Renamed ", expectedRevision: 3 }))
      .resolves.toMatchObject({ name: "Renamed", bookCount: 2, revision: 4 });
    expect(client.queries.find(({ text }) => text.includes("UPDATE leaflogue.collections"))?.values)
      .toEqual([libraryId, collectionId, "Renamed", "renamed", null, 3]);
  });

  it("supports highlight tags and touches every affected book when deleting a tag", async () => {
    const tagId = "50000000-0000-4000-8000-000000000000" as never;
    const highlightId = "60000000-0000-4000-8000-000000000000" as never;
    const membershipClient = new FakeClient();
    membershipClient.selectedRows.push([{ revision: 2 }], [{ id: highlightId }], [{ revision: 6 }]);
    membershipClient.returningRows.push(
      [{ highlight_id: highlightId }], [{ revision: 7 }], [{ revision: 2 }], [{ revision: 3 }],
    );
    const membership = new PostgresLibraryMutations(membershipClient, libraryId);
    await expect(membership.setHighlightTagMembership({ bookId, highlightId, tagId, included: true }))
      .resolves.toMatchObject({ changed: true, highlightId, containerRevision: 7, bookRevision: 3 });

    const deleteClient = new FakeClient();
    deleteClient.returningRows.push(
      [{ id: tagId, revision: 8 }], [{ revision: 4 }], [{ revision: 8 }], [{ revision: 3 }],
    );
    deleteClient.selectedRows.push(
      [{ book_id: bookId }, { book_id: "70000000-0000-4000-8000-000000000000" }],
      [{ highlight_id: highlightId }],
    );
    const deletion = new PostgresLibraryMutations(deleteClient, libraryId);
    await expect(deletion.deleteTag({ id: tagId, expectedRevision: 7 })).resolves.toBeUndefined();
    expect(deleteClient.queries.filter(({ text }) => text.includes("sync_changes"))).toHaveLength(4);
    expect(deleteClient.queries.filter(({ text }) => text.includes("DELETE FROM leaflogue.")).map(({ text }) => text.trim().split(/\s+/).slice(0, 4).join(" ")))
      .toEqual(["DELETE FROM leaflogue.book_tags WHERE", "DELETE FROM leaflogue.highlight_tags WHERE"]);
  });

  it("uses the same database-level library lock across separate clients", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    first.returningRows.push([{
      id: collectionId, name: "One", description: null, book_count: 0,
      created_at_ms: 1, updated_at_ms: 1, revision: 1,
    }]);
    second.returningRows.push([{
      id: "80000000-0000-4000-8000-000000000000", name: "Two", description: null, book_count: 0,
      created_at_ms: 1, updated_at_ms: 1, revision: 1,
    }]);
    await Promise.all([
      new PostgresLibraryMutations(first, libraryId).createCollection({ id: collectionId, name: "One" }),
      new PostgresLibraryMutations(second, libraryId).createCollection({ id: "80000000-0000-4000-8000-000000000000" as never, name: "Two" }),
    ]);
    for (const client of [first, second]) {
      expect(client.queries[1]).toEqual({
        text: "SELECT pg_advisory_xact_lock(hashtext($1))",
        values: [libraryId],
      });
    }
  });
});

describe("PostgreSQL thread mutation parity", () => {
  const libraryId = "20000000-0000-4000-8000-000000000000";
  const bookId = "30000000-0000-4000-8000-000000000000" as never;
  const highlightId = "40000000-0000-4000-8000-000000000000" as never;
  const threadId = "50000000-0000-4000-8000-000000000000" as never;

  it("creates a client-identified thread and records its change atomically", async () => {
    const client = new FakeClient();
    client.selectedRows.push([], [{ count: 0 }]);
    client.returningRows.push([{
      id: threadId,
      name: "Belonging and exile",
      description: "Across homes",
      passage_count: 0,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      revision: 1,
    }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.createThread({
      id: threadId,
      name: " Belonging   and exile ",
      description: " Across homes ",
    })).resolves.toMatchObject({ id: threadId, name: "Belonging and exile", description: "Across homes", revision: 1 });
    expect(client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.threads"))?.values)
      .toEqual([libraryId, threadId, "Belonging and exile", "belonging and exile", "Across homes"]);
    expect(client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.sync_changes"))?.values?.slice(0, 4))
      .toEqual([libraryId, "thread", threadId, 1]);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("changes passage membership once and advances both revisions", async () => {
    const client = new FakeClient();
    client.selectedRows.push(
      [{ revision: 2 }],
      [{ id: threadId }],
      [],
      [{ count: 0 }],
      [{ id: threadId }],
    );
    client.returningRows.push([{ revision: 2 }], [{ revision: 3 }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.setHighlightThreadMembership({
      bookId,
      highlightId,
      threadIds: [threadId, threadId],
      expectedHighlightRevision: 2,
    })).resolves.toEqual({
      changed: true,
      bookId,
      highlightId,
      highlightRevision: 3,
      threadIds: [threadId],
    });
    expect(client.queries.filter(({ text }) => text.includes("INSERT INTO leaflogue.sync_changes")).map(({ values }) => values?.[1]))
      .toEqual(["thread", "highlight"]);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("rejects stale thread edits and rolls back", async () => {
    const client = new FakeClient();
    client.returningRows.push([]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.updateThread({ id: threadId, name: "Home", expectedRevision: 2 }))
      .rejects.toThrow(/changed elsewhere/u);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });
});

describe("PostgreSQL daily-selection parity", () => {
  const libraryId = "20000000-0000-4000-8000-000000000000";
  const selectionId = "30000000-0000-4000-8000-000000000000" as never;
  const bookId = "40000000-0000-4000-8000-000000000000";
  const highlightId = "50000000-0000-4000-8000-000000000000";

  it("creates a canonical, client-identified daily selection and records its change", async () => {
    const now = Date.parse("2026-09-23T08:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const client = new FakeClient();
    client.selectedRows.push([{ id: highlightId, book_id: bookId }], [], []);
    client.returningRows.push([{
      id: selectionId,
      local_day: "2026-09-23",
      timezone: "UTC",
      highlight_id: highlightId,
      candidate_digest: "a".repeat(64),
      recent_highlight_ids: [highlightId],
      selected_at_ms: now,
      updated_at_ms: now,
      revision: 1,
    }]);
    try {
      const mutations = new PostgresLibraryMutations(client, libraryId);
      await expect(mutations.ensureDailySelection({ id: selectionId, timezone: "Etc/UTC" }))
        .resolves.toMatchObject({
          id: selectionId,
          localDay: "2026-09-23",
          timezone: "UTC",
          highlightId,
          recentHighlightIds: [highlightId],
          revision: 1,
        });
      const insert = client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.daily_selections"));
      expect(insert?.values?.slice(0, 5)).toEqual([libraryId, selectionId, "2026-09-23", "UTC", highlightId]);
      expect(String(insert?.values?.[5])).toMatch(/^[0-9a-f]{64}$/u);
      expect(client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.sync_changes"))?.values?.slice(0, 4))
        .toEqual([libraryId, "daily-selection", selectionId, 1]);
      expect(client.queries.at(-1)?.text).toBe("COMMIT");
    } finally {
      clock.mockRestore();
    }
  });

  it("reuses an eligible same-day selection without advancing its revision", async () => {
    const now = Date.parse("2026-09-23T08:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const row = {
      id: selectionId,
      local_day: "2026-09-23",
      timezone: "UTC",
      highlight_id: highlightId,
      candidate_digest: "a".repeat(64),
      recent_highlight_ids: [highlightId],
      selected_at_ms: now,
      updated_at_ms: now,
      revision: 4,
    };
    const client = new FakeClient();
    client.selectedRows.push([{ id: highlightId, book_id: bookId }], [row]);
    try {
      const mutations = new PostgresLibraryMutations(client, libraryId);
      await expect(mutations.ensureDailySelection({ id: selectionId, timezone: "utc", another: true }))
        .resolves.toMatchObject({ id: selectionId, revision: 4 });
      expect(client.queries.some(({ text }) => text.includes("INSERT INTO leaflogue.sync_changes"))).toBe(false);
      expect(client.queries.at(-1)?.text).toBe("COMMIT");
    } finally {
      clock.mockRestore();
    }
  });
});

describe("PostgreSQL annotation mutation parity", () => {
  const libraryId = "20000000-0000-4000-8000-000000000000";
  const bookId = "30000000-0000-4000-8000-000000000000" as never;

  it("creates a client-identified book and records its first sync change atomically", async () => {
    const client = new FakeClient();
    const createdBookId = "10000000-0000-4000-8000-000000000000" as never;
    client.returningRows.push([{
      id: createdBookId,
      title: "Piranesi",
      authors: ["Susanna Clarke"],
      metadata: { isbn13: "9781635575637" },
      status: "unread",
      archived: false,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      revision: 1,
    }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.createBook({
      id: createdBookId,
      title: " Piranesi ",
      authors: [" Susanna Clarke "],
      isbn13: "978-1-63557-563-7",
    })).resolves.toMatchObject({
      id: createdBookId,
      title: "Piranesi",
      authors: ["Susanna Clarke"],
      isbn13: "9781635575637",
      revision: 1,
      highlightCount: 0,
    });
    expect(client.queries[0]?.text).toBe("BEGIN");
    expect(client.queries.find(({ text }) => text.includes("sync_changes"))?.values?.slice(0, 4))
      .toEqual([libraryId, "book", createdBookId, 1]);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("treats an identical retried create as success without another sync change", async () => {
    const client = new FakeClient();
    const createdBookId = "10000000-0000-4000-8000-000000000000" as never;
    client.returningRows.push([]);
    client.selectedRows.push([{
      id: createdBookId,
      title: "Piranesi",
      authors: ["Susanna Clarke"],
      metadata: { isbn13: "9781635575637" },
      status: "unread",
      archived: false,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      revision: 1,
      highlight_count: 0,
    }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.createBook({
      id: createdBookId, title: "Piranesi", authors: ["Susanna Clarke"], isbn13: "9781635575637",
    })).resolves.toMatchObject({ id: createdBookId, title: "Piranesi" });
    expect(client.queries.filter(({ text }) => text.includes("sync_changes"))).toHaveLength(0);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("creates a highlight and records the same revisioned sync change atomically", async () => {
    const client = new FakeClient();
    client.returningRows.push(
      [{
        id: "40000000-0000-4000-8000-000000000000",
        book_id: bookId,
        text: "A passage",
        source_location: "Page 7",
        source_created_at_ms: null,
        created_at_ms: 1000,
        updated_at_ms: 1000,
        revision: 1,
      }],
      [{ revision: 7 }],
    );
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.createHighlight({ bookId, text: " A passage ", sourceLocation: " Page 7 ", noteMarkdown: " Keep this. " }))
      .resolves.toMatchObject({ text: "A passage", sourceLocation: "Page 7", revision: 1 });
    expect(client.queries[0]?.text).toBe("BEGIN");
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
    const changes = client.queries.filter(({ text }) => text.includes("sync_changes"));
    expect(changes.map(({ values }) => values?.slice(0, 2))).toEqual([
      [libraryId, "book"],
      [libraryId, "highlight"],
      [libraryId, "note"],
    ]);
    expect(client.queries.some(({ text, values }) => text.includes("INSERT INTO leaflogue.notes") && values?.[4] === "Keep this.")).toBe(true);
  });

  it("writes the requested note origin so a kept explanation stays an AI note", async () => {
    const client = new FakeClient();
    const highlightId = "40000000-0000-4000-8000-000000000000" as never;
    client.selectedRows.push([{ count: 0 }]);
    client.returningRows.push([{
      id: "50000000-0000-4000-8000-000000000000",
      book_id: bookId,
      highlight_id: highlightId,
      markdown: "An explanation.",
      origin: "ai",
      created_at_ms: 1000,
      updated_at_ms: 1000,
      revision: 1,
    }], [{ revision: 5 }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.createNote({ bookId, highlightId, markdown: " An explanation. ", origin: "ai" }))
      .resolves.toMatchObject({ origin: "ai", revision: 1 });
    const insert = client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.notes"));
    expect(insert?.values?.[5]).toBe("ai");
    expect(insert?.text).not.toContain("'reader'");
  });

  it("rejects an attached note beyond the shared active-note bound", async () => {
    const client = new FakeClient();
    const highlightId = "40000000-0000-4000-8000-000000000000" as never;
    client.selectedRows.push([{ count: 200 }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.createNote({ bookId, highlightId, markdown: "One too many" }))
      .rejects.toThrow(/at most 200 active notes/);
    expect(client.queries.some(({ text }) => text.includes("INSERT INTO leaflogue.notes"))).toBe(false);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects note bodies beyond the shared UTF-8 byte bound before querying", async () => {
    const client = new FakeClient();
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.createNote({ bookId, markdown: "é".repeat(MAX_NOTE_BYTES / 2 + 1) }))
      .rejects.toThrow(/too long/);
    expect(client.queries).toEqual([]);
  });

  it("replays another device's change without checking it against the provider's revision", async () => {
    const client = new FakeClient();
    client.returningRows.push([{ device_id: "9f3c7a10-0000-4000-8000-000000000000" }], [{ revision: 4 }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.applySyncedChange(syncedUpsert({ deviceRevision: 3 }))).resolves.toBe("applied");

    const claim = client.queries.find(({ text }) => text.includes("synced_writers"));
    // Order is decided by (revision, device), which every replica evaluates the
    // same way, so no provider revision is consulted.
    expect(claim?.text).toContain("(excluded.device_revision, excluded.device_id)");
    expect(claim?.values?.slice(3)).toEqual(["9f3c7a10-0000-4000-8000-000000000000", 3, "upsert"]);
    expect(client.queries.some(({ text }) => text.includes("expectedRevision") || text.includes("AND revision = "))).toBe(false);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("leaves the row untouched when a replayed change loses the entity", async () => {
    const client = new FakeClient();
    // No claim row comes back: a change that already owns the entity won.
    client.returningRows.push([]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.applySyncedChange(syncedUpsert({ deviceRevision: 1 }))).resolves.toBe("superseded");
    expect(client.queries.some(({ text }) => text.includes("INSERT INTO leaflogue.books"))).toBe(false);
    expect(client.queries.some(({ text }) => text.includes("sync_changes"))).toBe(false);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("refuses a synced change whose device revision is not a positive integer", async () => {
    const client = new FakeClient();
    const mutations = new PostgresLibraryMutations(client, libraryId);
    for (const deviceRevision of [0, -1, 1.5, Number.NaN]) {
      await expect(mutations.applySyncedChange(syncedUpsert({ deviceRevision })))
        .rejects.toThrow(/revision is invalid/);
    }
    expect(client.queries).toEqual([]);
  });

  it("replays and clears a book completion date with the synced status", async () => {
    const finishedClient = new FakeClient();
    finishedClient.returningRows.push([{ device_id: "9f3c7a10-0000-4000-8000-000000000000" }], [{ revision: 4 }]);
    const finished = new PostgresLibraryMutations(finishedClient, libraryId);
    await finished.applySyncedChange(syncedUpsert({ deviceRevision: 3, status: "finished", completedOn: "2026-09-24" }));
    const insert = finishedClient.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.books"));
    expect(insert?.values?.slice(-3)).toEqual(["finished", false, "2026-09-24"]);
    expect(insert?.text).toContain("completed_on = excluded.completed_on");

    const readingClient = new FakeClient();
    readingClient.returningRows.push([{ device_id: "9f3c7a10-0000-4000-8000-000000000000" }], [{ revision: 5 }]);
    const reading = new PostgresLibraryMutations(readingClient, libraryId);
    await reading.applySyncedChange(syncedUpsert({ deviceRevision: 4, status: "reading", completedOn: "2026-09-24" }));
    expect(readingClient.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.books"))?.values?.slice(-3))
      .toEqual(["reading", false, null]);
  });

  it("makes a synced tombstone win whether or not a book row exists", async () => {
    const client = new FakeClient();
    client.returningRows.push(
      [{ device_id: "9f3c7a10-0000-4000-8000-000000000000" }],
      [],
      [{ revision: 1 }],
      [],
    );
    const mutations = new PostgresLibraryMutations(client, libraryId);
    const tombstone: SyncedChange = {
      entityType: "book",
      operation: "tombstone",
      entityId: "3f1a0c62-1111-4111-8111-111111111111" as BookId,
      deviceId: "9f3c7a10-0000-4000-8000-000000000000",
      deviceRevision: 4,
    };
    await expect(mutations.applySyncedChange(tombstone)).resolves.toBe("applied");
    await expect(mutations.applySyncedChange(syncedUpsert({ deviceRevision: 99 }))).resolves.toBe("superseded");
    const claims = client.queries.filter(({ text }) => text.includes("synced_writers"));
    expect(claims[0]?.text).toContain("excluded.operation = 'tombstone'");
    expect(claims[0]?.values?.at(-1)).toBe("tombstone");
    expect(client.queries.some(({ text }) => text.includes("INSERT INTO leaflogue.books"))).toBe(false);
  });

  it("replays a highlight and preserves the body it replaces", async () => {
    const client = new FakeClient();
    client.selectedRows.push([{
      body: "Local passage", book_id: bookId, deleted_at: null,
      device_id: "8f3c7a10-0000-4000-8000-000000000000", device_revision: 2, operation: "upsert",
    }]);
    client.returningRows.push(
      [{ device_id: "9f3c7a10-0000-4000-8000-000000000000" }],
      [{ revision: 5 }],
      [{ revision: 8 }],
    );
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.applySyncedChange(syncedHighlight())).resolves.toBe("applied");
    const conflict = client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.sync_conflicts"));
    expect(conflict?.values?.slice(2, 7)).toEqual(["highlight", "40000000-0000-4000-8000-000000000000", bookId, "Local passage", "Incoming passage"]);
    expect(client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.highlights"))?.values?.slice(2, 5))
      .toEqual([bookId, "Incoming passage", "Chapter 1"]);
    expect(client.queries.filter(({ text }) => text.includes("sync_changes")).map(({ values }) => values?.[1]))
      .toEqual(["highlight", "book"]);
  });

  it("preserves a note body that loses to a prior tombstone", async () => {
    const client = new FakeClient();
    client.selectedRows.push([{
      body: null, book_id: null, deleted_at: null,
      device_id: "af3c7a10-0000-4000-8000-000000000000", device_revision: 5, operation: "tombstone",
    }]);
    client.returningRows.push([]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.applySyncedChange(syncedNote())).resolves.toBe("superseded");
    const conflict = client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.sync_conflicts"));
    expect(conflict?.values?.slice(2, 7)).toEqual(["note", "50000000-0000-4000-8000-000000000000", bookId, "Reader thought", null]);
    expect(client.queries.some(({ text }) => text.includes("INSERT INTO leaflogue.notes"))).toBe(false);
  });

  it("replays a standalone note and records its book change", async () => {
    const client = new FakeClient();
    client.selectedRows.push([{
      body: null, book_id: null, deleted_at: null,
      device_id: null, device_revision: null, operation: null,
    }]);
    client.returningRows.push(
      [{ device_id: "9f3c7a10-0000-4000-8000-000000000000" }],
      [{ revision: 1 }],
      [{ revision: 8 }],
    );
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.applySyncedChange(syncedNote())).resolves.toBe("applied");
    const insert = client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.notes"));
    expect(insert?.values?.slice(2, 6)).toEqual([bookId, null, "Reader thought", "reader"]);
    expect(client.queries.filter(({ text }) => text.includes("sync_changes")).map(({ values }) => values?.[1]))
      .toEqual(["note", "book"]);
    expect(insert?.text).toContain("existing.highlight_id IS NOT DISTINCT FROM $4");
    const touch = client.queries.find(({ text }) => text.includes("UPDATE leaflogue.books SET revision"));
    expect(touch?.text).not.toContain("archived = false");
  });

  it("persists an absent note tombstone so another device can learn it", async () => {
    const client = new FakeClient();
    client.selectedRows.push([{
      body: null, book_id: null, deleted_at: null,
      device_id: null, device_revision: null, operation: null,
    }]);
    client.returningRows.push(
      [{ device_id: "9f3c7a10-0000-4000-8000-000000000000" }],
      [],
      [{ revision: 1 }],
      [{ revision: 8 }],
    );
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.applySyncedChange({
      entityType: "note", operation: "tombstone",
      entityId: "50000000-0000-4000-8000-000000000000" as never,
      bookId, deviceId: "9f3c7a10-0000-4000-8000-000000000000", deviceRevision: 4,
    })).resolves.toBe("applied");
    expect(client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.sync_tombstones"))?.values)
      .toEqual([libraryId, "note", "50000000-0000-4000-8000-000000000000", bookId, 1]);
    expect(client.queries.filter(({ text }) => text.includes("sync_changes")).map(({ values }) => values?.[1]))
      .toEqual(["note", "book"]);
  });

  it.each(["highlight", "note"] as const)("deletes a moved %s from its actual parent without a false same-device conflict", async (entityType) => {
    const client = new FakeClient();
    const actualBookId = "31000000-0000-4000-8000-000000000000" as BookId;
    const entityId = entityType === "highlight"
      ? "40000000-0000-4000-8000-000000000000"
      : "50000000-0000-4000-8000-000000000000";
    client.selectedRows.push([{
      body: "Existing body", book_id: actualBookId, deleted_at: null,
      device_id: "9f3c7a10-0000-4000-8000-000000000000", device_revision: 3, operation: "upsert",
    }]);
    client.returningRows.push(
      [{ device_id: "9f3c7a10-0000-4000-8000-000000000000" }],
      [{ revision: 4, book_id: actualBookId }],
      [{ revision: 4 }],
      [{ revision: 9 }],
    );
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.applySyncedChange({
      entityType, operation: "tombstone", entityId: entityId as never, bookId,
      deviceId: "9f3c7a10-0000-4000-8000-000000000000", deviceRevision: 4,
    })).resolves.toBe("applied");
    const deletion = client.queries.find(({ text }) => text.includes(`UPDATE leaflogue.${entityType === "highlight" ? "highlights" : "notes"} SET deleted_at`));
    expect(deletion?.values).toEqual([libraryId, entityId]);
    expect(client.queries.find(({ text }) => text.includes("INSERT INTO leaflogue.sync_tombstones"))?.values?.[3]).toBe(actualBookId);
    expect(client.queries.filter(({ text }) => text.includes("UPDATE leaflogue.books SET revision")).map(({ values }) => values?.[1]))
      .toEqual([actualBookId]);
    expect(client.queries.some(({ text }) => text.includes("INSERT INTO leaflogue.sync_conflicts"))).toBe(false);
  });

  it("does not turn a delayed same-device note upsert into a conflict after deletion", async () => {
    const client = new FakeClient();
    client.selectedRows.push([{
      body: null, book_id: null, deleted_at: null,
      device_id: "9f3c7a10-0000-4000-8000-000000000000", device_revision: 4, operation: "tombstone",
    }]);
    client.returningRows.push([]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.applySyncedChange(syncedNote())).resolves.toBe("superseded");
    expect(client.queries.some(({ text }) => text.includes("sync_conflicts"))).toBe(false);
  });

  it("rolls back rather than duplicating an oversized legacy body into conflict storage", async () => {
    const client = new FakeClient();
    client.selectedRows.push([{
      body: "x".repeat(400_001), book_id: bookId, deleted_at: null,
      device_id: "8f3c7a10-0000-4000-8000-000000000000", device_revision: 2, operation: "upsert",
    }]);
    client.returningRows.push([{ device_id: "9f3c7a10-0000-4000-8000-000000000000" }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.applySyncedChange(syncedHighlight())).rejects.toThrow(/reviewable conflict limit/);
    expect(client.queries.some(({ text }) => text.includes("INSERT INTO leaflogue.highlights"))).toBe(false);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rolls back when an entity already has the bounded number of pending conflicts", async () => {
    const client = new FakeClient();
    client.selectedRows.push([{
      body: "Local passage", book_id: bookId, deleted_at: null,
      device_id: "8f3c7a10-0000-4000-8000-000000000000", device_revision: 2, operation: "upsert",
    }], [{ duplicate: false, pending_count: 20 }]);
    client.returningRows.push([{ device_id: "9f3c7a10-0000-4000-8000-000000000000" }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.applySyncedChange(syncedHighlight())).rejects.toThrow(/too many pending conflicts/);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("replaces book metadata in one revision-checked update and records the book change", async () => {
    const client = new FakeClient();
    client.selectedRows.push([]);
    client.returningRows.push([{
      id: bookId, title: "Piranesi", authors: ["Susanna Clarke"],
      metadata: { description: "A house of tides.", publisher: "Bloomsbury", isbn13: "9781635575637", coverUrl: "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg" },
      status: "reading", archived: false, completed_on: null, created_at_ms: 1, updated_at_ms: 2, revision: 5, highlight_count: 3,
    }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.updateBookMetadata({
      id: bookId, expectedRevision: 4, title: " Piranesi ", authors: ["Susanna Clarke"],
      description: "A house of tides.", publisher: "Bloomsbury", isbn13: "978-1-63557-563-7", coverUrl: "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg",
    })).resolves.toMatchObject({ title: "Piranesi", description: "A house of tides.", publisher: "Bloomsbury", isbn13: "9781635575637", coverUrl: "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg", status: "reading", revision: 5, highlightCount: 3 });
    const update = client.queries.find(({ text }) => text.includes("UPDATE leaflogue.books"));
    expect(update?.values).toEqual([libraryId, bookId, 4, "Piranesi", JSON.stringify(["Susanna Clarke"]), JSON.stringify({ description: "A house of tides.", publisher: "Bloomsbury", isbn13: "9781635575637", coverUrl: "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg" })]);
    expect(client.queries.filter(({ text }) => text.includes("sync_changes")).map(({ values }) => values?.slice(0, 4))).toEqual([[libraryId, "book", bookId, 5]]);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("refuses a duplicate ISBN-13 before changing the book", async () => {
    const client = new FakeClient();
    client.selectedRows.push([{ id: "90000000-0000-4000-8000-000000000000" }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.updateBookMetadata({ id: bookId, expectedRevision: 4, title: "Piranesi", authors: [], isbn13: "9781635575637" }))
      .rejects.toThrow(/Another book already has that ISBN-13/);
    expect(client.queries.some(({ text }) => text.includes("UPDATE leaflogue.books"))).toBe(false);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("tombstones a highlight with its notes, removes memberships, and records every change", async () => {
    const client = new FakeClient();
    const highlightId = "40000000-0000-4000-8000-000000000000" as never;
    const noteId = "50000000-0000-4000-8000-000000000000";
    const threadId = "60000000-0000-4000-8000-000000000000";
    const tagId = "70000000-0000-4000-8000-000000000000";
    client.returningRows.push(
      [{ revision: 4 }],
      [{ id: noteId, revision: 2 }],
      [{ thread_id: threadId }],
      [{ tag_id: tagId }],
      [{ revision: 9 }],
      [{ id: threadId, revision: 3 }],
      [{ id: tagId, revision: 5 }],
    );
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.deleteHighlight({ id: highlightId, bookId, expectedRevision: 3 }))
      .resolves.toEqual({ bookId, bookRevision: 9, revision: 4, notesDeleted: 1, complete: true });
    expect(client.queries[0]?.text).toBe("BEGIN");
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
    expect(client.queries[2]?.text).toContain("SET deleted_at = now()");
    expect(client.queries[2]?.values).toEqual([libraryId, highlightId, bookId, 3]);
    expect(client.queries.filter(({ text }) => text.includes("sync_changes")).map(({ values }) => values?.slice(0, 4))).toEqual([
      [libraryId, "book", bookId, 9],
      [libraryId, "highlight", highlightId, 4],
      [libraryId, "note", noteId, 2],
      [libraryId, "thread", threadId, 3],
      [libraryId, "tag", tagId, 5],
    ]);
  });

  it("rolls back a stale deletion without touching its book or memberships", async () => {
    const client = new FakeClient();
    client.returningRows.push([]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.deleteHighlight({ id: "40000000-0000-4000-8000-000000000000" as never, bookId, expectedRevision: 3 }))
      .rejects.toThrow(/changed elsewhere/);
    expect(client.queries.map(({ text }) => text.trim().split("\n")[0])).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "UPDATE leaflogue.highlights",
      "ROLLBACK",
    ]);
  });

  it("tombstones a single note and records its book and note changes", async () => {
    const client = new FakeClient();
    const noteId = "50000000-0000-4000-8000-000000000000" as never;
    client.returningRows.push([{ revision: 6 }], [{ revision: 11 }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.deleteNote({ id: noteId, bookId, expectedRevision: 5 }))
      .resolves.toEqual({ bookId, bookRevision: 11, revision: 6, notesDeleted: 1, complete: true });
    expect(client.queries.filter(({ text }) => text.includes("sync_changes")).map(({ values }) => values?.slice(0, 4))).toEqual([
      [libraryId, "book", bookId, 11],
      [libraryId, "note", noteId, 6],
    ]);
  });

  it("rolls back a stale online note edit instead of touching its book", async () => {
    const client = new FakeClient();
    client.returningRows.push([]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.updateNote({
      id: "50000000-0000-4000-8000-000000000000" as never,
      bookId,
      markdown: "A newer thought",
      expectedRevision: 3,
    })).rejects.toThrow(/changed elsewhere/);
    expect(client.queries.map(({ text }) => text.trim())).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      expect.stringContaining("UPDATE leaflogue.notes"),
      "ROLLBACK",
    ]);
  });

  it("archives a book and appends its revision to the online change log", async () => {
    const client = new FakeClient();
    client.returningRows.push([{
      id: bookId,
      archived: true,
      revision: 4,
      updated_at_ms: 2_000,
    }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.setBookArchived({ id: bookId, archived: true, expectedRevision: 3 }))
      .resolves.toEqual({ bookId, archived: true, revision: 4, updatedAt: 2_000 });
    const change = client.queries.find(({ text }) => text.includes("sync_changes"));
    // A web write records its change and claims it under the web device, so desktops pull it.
    expect(change?.values).toEqual([libraryId, "book", bookId, 4, WEB_DEVICE_ID]);
    expect(change?.text).toContain("INSERT INTO leaflogue.synced_writers");
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("changes reading status with one immutable event and one book change", async () => {
    const client = new FakeClient();
    client.selectedRows.push([{
      id: bookId,
      title: "Piranesi",
      authors: [],
      metadata: {},
      status: "unread",
      completed_on: null,
      archived: false,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      revision: 2,
      highlight_count: 3,
    }]);
    client.returningRows.push([{
      id: bookId,
      title: "Piranesi",
      authors: [],
      metadata: {},
      status: "finished",
      completed_on: "2026-09-21",
      archived: false,
      created_at_ms: 1_000,
      updated_at_ms: 2_000,
      revision: 3,
      highlight_count: 0,
    }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    const changed = await mutations.setBookReadingStatus({ id: bookId, status: "finished", expectedRevision: 2 });
    expect(changed).toMatchObject({
      changed: true,
      book: { id: bookId, status: "finished", completedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u), revision: 3, highlightCount: 3 },
      event: { bookId, status: "finished", source: "reader", bookRevision: 3 },
    });
    expect(client.queries.filter(({ text }) => text.includes("INSERT INTO leaflogue.reading_status_events"))).toHaveLength(1);
    expect(client.queries.filter(({ text }) => text.includes("sync_changes"))).toHaveLength(1);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("keeps an identical online reading status revision-neutral", async () => {
    const client = new FakeClient();
    client.selectedRows.push([{
      id: bookId,
      title: "Piranesi",
      authors: [],
      metadata: {},
      status: "reading",
      completed_on: null,
      archived: false,
      created_at_ms: 1_000,
      updated_at_ms: 2_000,
      revision: 3,
      highlight_count: 1,
    }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.setBookReadingStatus({ id: bookId, status: "reading", expectedRevision: 3 }))
      .resolves.toMatchObject({ changed: false, book: { status: "reading", revision: 3 } });
    expect(client.queries.some(({ text }) => text.includes("reading_status_events"))).toBe(false);
    expect(client.queries.some(({ text }) => text.includes("sync_changes"))).toBe(false);
  });

  it("revision-safely edits a finished book's completion date", async () => {
    const client = new FakeClient();
    client.returningRows.push([{
      id: bookId,
      title: "Piranesi",
      authors: [],
      metadata: {},
      status: "finished",
      completed_on: "2024-02-29",
      archived: false,
      created_at_ms: 1_000,
      updated_at_ms: 2_000,
      revision: 4,
      highlight_count: 3,
    }]);
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.setBookCompletionDate({ id: bookId, completedOn: "2024-02-29", expectedRevision: 3 }))
      .resolves.toMatchObject({ status: "finished", completedOn: "2024-02-29", revision: 4 });
    expect(client.queries.find(({ text }) => text.includes("SET completed_on"))?.values)
      .toEqual([libraryId, bookId, "2024-02-29", 3]);
    expect(client.queries.filter(({ text }) => text.includes("sync_changes"))).toHaveLength(1);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("merges online reading rows and records every changed entity", async () => {
    const client = new FakeClient();
    const sourceBookId = "60000000-0000-4000-8000-000000000000" as never;
    client.returningRows.push(
      [{ status: "unread", completed_on: null, revision: 2 }],
      [{ revision: 5 }],
      [{ id: "70000000-0000-4000-8000-000000000000", revision: 3 }],
      [{ id: "80000000-0000-4000-8000-000000000000", revision: 4 }],
    );
    client.selectedRows.push(
      [{ id: "90000000-0000-4000-8000-000000000000" }],
      [{ id: "a0000000-0000-4000-8000-000000000000" }],
    );
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await expect(mutations.mergeBooks({
      sourceBookId,
      targetBookId: bookId,
      expectedSourceRevision: 4,
      expectedTargetRevision: 1,
    })).resolves.toEqual({
      sourceBookId,
      targetBookId: bookId,
      highlightsMoved: 1,
      notesMoved: 1,
      sourceRevision: 5,
      targetRevision: 2,
    });
    expect(client.queries.filter(({ text }) => text.includes("sync_changes"))).toHaveLength(4);
    expect(client.queries.some(({ text }) => text.includes("INSERT INTO leaflogue.collection_books"))).toBe(true);
    expect(client.queries.some(({ text }) => text.includes("UPDATE leaflogue.collections SET revision"))).toBe(true);
    expect(client.queries.some(({ text }) => text.includes("UPDATE leaflogue.tags SET revision"))).toBe(true);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("serializes concurrent mutations that share a PostgreSQL client", async () => {
    const client = new FakeClient();
    client.returningRows.push(
      [{ id: bookId, archived: true, revision: 2, updated_at_ms: 2_000 }],
      [{ id: bookId, archived: false, revision: 3, updated_at_ms: 3_000 }],
    );
    const mutations = new PostgresLibraryMutations(client, libraryId);
    await Promise.all([
      mutations.setBookArchived({ id: bookId, archived: true, expectedRevision: 1 }),
      mutations.setBookArchived({ id: bookId, archived: false, expectedRevision: 2 }),
    ]);
    expect(client.queries.map(({ text }) => text.trim().split(/\s+/)[0])).toEqual([
      "BEGIN", "SELECT", "UPDATE", "WITH", "COMMIT",
      "BEGIN", "SELECT", "UPDATE", "WITH", "COMMIT",
    ]);
    expect(client.queries.filter(({ text }) => text.includes("pg_advisory_xact_lock")))
      .toEqual([
        expect.objectContaining({ values: [libraryId] }),
        expect.objectContaining({ values: [libraryId] }),
      ]);
  });
});

function syncedUpsert(overrides: {
  readonly deviceRevision: number;
  readonly status?: Book["status"];
  readonly completedOn?: string;
}): SyncedChange {
  const book: Book = {
    id: "3f1a0c62-1111-4111-8111-111111111111" as BookId,
    title: "Piranesi",
    authors: ["Susanna Clarke"],
    status: overrides.status ?? "reading",
    ...(overrides.completedOn ? { completedOn: overrides.completedOn } : {}),
    archived: false,
    createdAt: 1000,
    updatedAt: 2000,
    revision: 3,
    highlightCount: 0,
  };
  return {
    entityType: "book",
    operation: "upsert",
    deviceId: "9f3c7a10-0000-4000-8000-000000000000",
    deviceRevision: overrides.deviceRevision,
    collectionIds: [],
    tagIds: [],
    book,
  };
}

function syncedHighlight(): SyncedChange {
  return {
    entityType: "highlight",
    operation: "upsert",
    deviceId: "9f3c7a10-0000-4000-8000-000000000000",
    deviceRevision: 3,
    tagIds: [],
    threadIds: [],
    highlight: {
      id: "40000000-0000-4000-8000-000000000000" as never,
      bookId: "30000000-0000-4000-8000-000000000000" as BookId,
      text: "Incoming passage",
      sourceLocation: "Chapter 1",
      createdAt: 1_000,
      updatedAt: 2_000,
      revision: 3,
    },
  };
}

function syncedNote(): SyncedChange {
  return {
    entityType: "note",
    operation: "upsert",
    deviceId: "9f3c7a10-0000-4000-8000-000000000000",
    deviceRevision: 3,
    note: {
      id: "50000000-0000-4000-8000-000000000000" as never,
      bookId: "30000000-0000-4000-8000-000000000000" as BookId,
      markdown: "Reader thought",
      origin: "reader",
      createdAt: 1_000,
      updatedAt: 2_000,
      revision: 3,
    },
  };
}
