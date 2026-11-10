import { randomUUID } from "node:crypto";
import { syncOperationId, type ResolvedSyncChange, type SyncCursor } from "@leaflogue/contracts";
import type { PostgresClient } from "./postgres";
import { PostgresLibraryMutations } from "./postgres-library";
import type { SyncBootstrapSource, SyncChangeSource, SyncPullPage, SyncSubmission, SyncTransport } from "./sync";

/**
 * Resolve the one shared library in a dedicated Leaflogue database, creating it
 * on first use. Multiple libraries need an explicit selector and are refused.
 */
export async function ensurePostgresSyncLibrary(client: PostgresClient, deviceId: string): Promise<string> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(1279671368)");
    const libraries = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM leaflogue.libraries ORDER BY created_at, id LIMIT 2",
    );
    if (libraries.rows.length > 1) {
      throw Object.assign(new Error("Remote library selection is required"), { code: "LEAFLOGUE_LIBRARY_SELECTION_REQUIRED" });
    }
    const libraryId = libraries.rows[0]?.id ?? randomUUID();
    if (libraries.rows.length === 0) {
      await client.query("INSERT INTO leaflogue.libraries (id, name) VALUES ($1, $2)", [libraryId, "Leaflogue"]);
    }
    await client.query(
      `INSERT INTO leaflogue.devices (id, library_id, name)
       VALUES ($1, $2, 'Leaflogue desktop') ON CONFLICT (id) DO NOTHING`,
      [deviceId, libraryId],
    );
    await client.query("COMMIT");
    return libraryId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * Sync transport for a directly configured PostgreSQL library. It runs in the
 * desktop main process beside the local database and is handed an already
 * connected client; it never sees paths, and never reports credentials or
 * bodies itself.
 *
 * PostgreSQL keeps no ledger of applied operation IDs. Re-delivery is harmless
 * without one because `applySyncedChange` claims each entity only for a
 * strictly greater (revision, device) with the same operation, or a tombstone
 * over an upsert: a repeated change presents exactly the claim it already
 * wrote, so it is `superseded` and touches no row. The only side effect a loser
 * can have — preserving its body as a conflict — is deduplicated by a
 * fingerprint of that same causal identity, and same-device history is never
 * treated as a conflict at all.
 */
export class PostgresSyncTransport implements SyncTransport, SyncChangeSource, SyncBootstrapSource {
  readonly #library: PostgresLibraryMutations;
  readonly #client: PostgresClient;
  #cancelled = false;

  constructor(client: PostgresClient, libraryId: string) {
    this.#client = client;
    this.#library = new PostgresLibraryMutations(client, libraryId);
  }

  async cancel(): Promise<void> {
    if (this.#cancelled) return;
    this.#cancelled = true;
    await this.#client.end();
  }

  /** Apply in order, one transaction each; stop at the first failure and report what landed. */
  async submit(changes: readonly ResolvedSyncChange[], signal?: AbortSignal): Promise<SyncSubmission> {
    const operationIds: string[] = [];
    for (const { change, entries } of changes) {
      if (signal?.aborted) break;
      try {
        await this.#library.applySyncedChange(change);
      } catch (failure) {
        return { operationIds, failure };
      }
      operationIds.push(...entries.map(syncOperationId));
    }
    return { operationIds };
  }

  /** `sync_changes` is never trimmed, so its generation stays 1 and replay from the start is complete. */
  async bootstrapCursor(): Promise<SyncCursor> {
    return this.#library.syncOrigin();
  }

  async validateCursor(cursor: SyncCursor): Promise<boolean> {
    return this.#library.recognizesSyncCursor(cursor);
  }

  async pull(cursor: SyncCursor, limit: number): Promise<SyncPullPage> {
    return this.#library.readSyncedChangePage(cursor, limit);
  }
}
