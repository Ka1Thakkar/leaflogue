import { describe, expect, it } from "vitest";
import type { ResolvedSyncChange, SyncedChange, SyncOutboxEntry } from "@leaflogue/contracts";
import type { PostgresClient } from "./postgres";
import { PostgresSyncTransport } from "./postgres-sync";

const libraryId = "00000000-0000-4000-8000-000000000001";
const deviceId = "9f3c7a10-0000-4000-8000-000000000000";
const bookId = "30000000-0000-4000-8000-000000000000";
const secondBookId = "31000000-0000-4000-8000-000000000000";
const highlightId = "40000000-0000-4000-8000-000000000000";
const noteId = "50000000-0000-4000-8000-000000000000";
const collectionId = "60000000-0000-4000-8000-000000000000";
const origin = "10000000-0000-4000-8000-000000000000";
const token = (sequence: number) => `${String(sequence).padStart(8, "0")}-0000-4000-8000-000000000000`;

type Handler = (text: string, values: readonly unknown[]) => Array<Record<string, unknown>> | undefined;

class ScriptedClient implements PostgresClient {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  ends = 0;
  constructor(readonly handler: Handler = () => undefined) {}
  async connect(): Promise<void> {}
  async end(): Promise<void> { this.ends += 1; }
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: Row[] }> {
    this.queries.push({ text, values });
    return { rows: (this.handler(text, values) ?? []) as Row[] };
  }
}

function entry(sequence: number, entityId = bookId): SyncOutboxEntry {
  return { sequence, deviceId, entityType: "book", entityId, revision: sequence, operation: "tombstone", createdAt: 1 };
}

function bookTombstone(entityId: string, deviceRevision: number): SyncedChange {
  return { entityType: "book", operation: "tombstone", deviceId, deviceRevision, entityId: entityId as never };
}

describe("PostgreSQL sync transport", () => {
  it("applies resolved changes in order and reports the landed prefix at the first failure", async () => {
    let claims = 0;
    const client = new ScriptedClient((text) => {
      if (text.includes("INSERT INTO leaflogue.synced_writers")) {
        claims += 1;
        if (claims === 2) throw Object.assign(new Error("connection reset: postgres://user:secret@db"), { code: "ECONNRESET" });
        return [{ device_id: deviceId }];
      }
      if (text.includes("RETURNING revision")) return [{ revision: 2 }];
      return undefined;
    });
    const changes: ResolvedSyncChange[] = [
      { change: bookTombstone(bookId, 2), entries: [entry(1), entry(2)] },
      { change: bookTombstone(secondBookId, 3), entries: [entry(3, secondBookId)] },
      { change: bookTombstone(bookId, 4), entries: [entry(4)] },
    ];
    const submission = await new PostgresSyncTransport(client, libraryId).submit(changes);
    expect(submission.operationIds).toEqual([`${deviceId}:1`, `${deviceId}:2`]);
    expect(submission.failure).toMatchObject({ code: "ECONNRESET" });
    expect(claims).toBe(2);
    // Each change is its own transaction; the failed one rolled back alone.
    expect(client.queries.filter(({ text }) => text === "COMMIT")).toHaveLength(1);
    expect(client.queries.filter(({ text }) => text === "ROLLBACK")).toHaveLength(1);
  });

  it("acknowledges a repeated delivery that the provider already holds without rewriting it", async () => {
    // No claim row comes back: the same (revision, device) already owns the entity.
    const client = new ScriptedClient(() => undefined);
    const submission = await new PostgresSyncTransport(client, libraryId)
      .submit([{ change: bookTombstone(bookId, 2), entries: [entry(2)] }]);
    expect(submission).toEqual({ operationIds: [`${deviceId}:2`] });
    expect(client.queries.some(({ text }) => text.includes("UPDATE leaflogue.books"))).toBe(false);
    expect(client.queries.some(({ text }) => text.includes("sync_changes"))).toBe(false);
  });

  it("sends nothing once cancelled", async () => {
    const client = new ScriptedClient();
    const controller = new AbortController();
    controller.abort();
    await expect(new PostgresSyncTransport(client, libraryId)
      .submit([{ change: bookTombstone(bookId, 2), entries: [entry(2)] }], controller.signal))
      .resolves.toEqual({ operationIds: [] });
    expect(client.queries).toEqual([]);
  });

  it("terminates its client once when an in-flight run is cancelled", async () => {
    const client = new ScriptedClient();
    const transport = new PostgresSyncTransport(client, libraryId);
    await transport.cancel();
    await transport.cancel();
    expect(client.ends).toBe(1);
  });

  it("bootstraps from the provider-issued history origin", async () => {
    const client = new ScriptedClient((text) => text.includes("library_sync_state") ? [{ checkpoint: origin }] : undefined);
    await expect(new PostgresSyncTransport(client, libraryId).bootstrapCursor())
      .resolves.toEqual({ generation: 1, afterSequence: 0, checkpoint: origin });
    expect(client.queries).toHaveLength(1);
  });
});

describe("PostgreSQL sync change pages", () => {
  const claim = (operation: "upsert" | "tombstone", revision = 7) => ({ device_id: deviceId, device_revision: String(revision), operation });

  function pageClient(latest: number, changes: Array<Record<string, unknown>>) {
    return new ScriptedClient((text, values) => {
      if (text.includes("library_sync_state")) return [{ checkpoint: origin }];
      if (text.includes("WHERE library_id = $1 AND sequence = $2")) return Number(values[1]) <= latest
        ? [{ checkpoint: token(Number(values[1])) }]
        : [];
      if (text.includes("FROM leaflogue.sync_changes")) return changes.slice(0, Number(values[2]));
      if (text.includes("LEFT JOIN leaflogue.books AS entity")) return [{
        entity_id: bookId, id: bookId, deleted: false, title: "Piranesi", authors: ["Susanna Clarke"], metadata: {},
        status: "finished", archived: false, completed_on: "2026-09-01", highlight_count: "2",
        collection_ids: [], tag_ids: [],
        created_at_ms: "1000", updated_at_ms: "2000", revision: "5", ...claim("upsert"), tombstone_book_id: null,
      }];
      if (text.includes("LEFT JOIN leaflogue.highlights AS entity")) return [{
        entity_id: highlightId, id: highlightId, deleted: false, book_id: bookId, text: "Interactive only",
        source_location: null, source_created_at_ms: null, archived: false, created_at_ms: "1", updated_at_ms: "1",
        revision: "1", tag_ids: [], device_id: null, device_revision: null, operation: null, tombstone_book_id: null,
      }];
      if (text.includes("LEFT JOIN leaflogue.notes AS entity")) return [{
        entity_id: noteId, id: null, deleted: null, book_id: null, created_at_ms: null, updated_at_ms: null, revision: null,
        ...claim("tombstone", 3), tombstone_book_id: bookId,
      }];
      return undefined;
    });
  }

  const change = (sequence: number, entity_type: string, entity_id: string) =>
    ({ sequence: String(sequence), entity_type, entity_id, revision: "1", changed_at_ms: "1700000000000", checkpoint: token(sequence) });

  it("reads a bounded page under the library lock with each entity's current claimed state", async () => {
    const client = pageClient(40, [
      change(11, "book", bookId), change(12, "highlight", highlightId), change(13, "collection", collectionId),
      change(14, "note", noteId), change(15, "book", bookId),
    ]);
    const { page, changes } = await new PostgresSyncTransport(client, libraryId)
      .pull({ generation: 1, afterSequence: 10, checkpoint: token(10) }, 4);
    expect(client.queries.slice(0, 2).map(({ text }) => text.trim().split(/\s+/)[0])).toEqual(["BEGIN", "SELECT"]);
    expect(client.queries[1]?.text).toContain("pg_advisory_xact_lock");
    expect(client.queries.find(({ text }) => text.includes("FROM leaflogue.sync_changes") && text.includes("LIMIT"))?.values)
      .toEqual([libraryId, 10, 5]);
    expect(page).toEqual({
      changes: [
        { sequence: 11, entityType: "book", entityId: bookId, revision: 1, changedAt: 1_700_000_000_000, checkpoint: token(11) },
        { sequence: 12, entityType: "highlight", entityId: highlightId, revision: 1, changedAt: 1_700_000_000_000, checkpoint: token(12) },
        { sequence: 13, entityType: "collection", entityId: collectionId, revision: 1, changedAt: 1_700_000_000_000, checkpoint: token(13) },
        { sequence: 14, entityType: "note", entityId: noteId, revision: 1, changedAt: 1_700_000_000_000, checkpoint: token(14) },
      ],
      nextCursor: { generation: 1, afterSequence: 14, checkpoint: token(14) },
      isDone: false,
      resetRequired: false,
    });
    expect(changes).toEqual([
      { entityType: "book", operation: "upsert", deviceId, deviceRevision: 7, book: {
        id: bookId, title: "Piranesi", authors: ["Susanna Clarke"], status: "finished", completedOn: "2026-09-01",
        archived: false, createdAt: 1000, updatedAt: 2000, revision: 5, highlightCount: 2,
      }, collectionIds: [], tagIds: [], statusEvents: [] },
      // Written interactively: no device claim to order it by, so it is not guessed.
      undefined,
      undefined,
      { entityType: "note", operation: "tombstone", deviceId, deviceRevision: 3, entityId: noteId, bookId },
    ]);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("requires a snapshot for a foreign generation or a cursor beyond the recorded history", async () => {
    for (const cursor of [
      { generation: 2, afterSequence: 3, checkpoint: token(3) },
      { generation: 1, afterSequence: 41, checkpoint: token(41) },
      { generation: 1, afterSequence: 3, checkpoint: token(999) },
    ]) {
      const client = pageClient(40, []);
      await expect(new PostgresSyncTransport(client, libraryId).pull(cursor, 100)).resolves.toEqual({
        page: { changes: [], nextCursor: { generation: 1, afterSequence: 0, checkpoint: origin }, isDone: false, resetRequired: true },
        changes: [],
      });
      expect(client.queries.some(({ text }) => text.includes("ORDER BY sequence"))).toBe(false);
    }
    const idle = pageClient(40, []);
    await expect(new PostgresSyncTransport(idle, libraryId).pull({ generation: 1, afterSequence: 40, checkpoint: token(40) }, 100)).resolves.toEqual({
      page: { changes: [], nextCursor: { generation: 1, afterSequence: 40, checkpoint: token(40) }, isDone: true, resetRequired: false },
      changes: [],
    });
    await expect(new PostgresSyncTransport(idle, libraryId).pull({ generation: 1, afterSequence: 0, checkpoint: origin }, 101)).rejects.toThrow(/limit/);
  });
});
