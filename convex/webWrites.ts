import type { DataModelFromSchemaDefinition, GenericMutationCtx } from "convex/server";
import { WEB_DEVICE_ID } from "@leaflogue/contracts";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MutationContext = Pick<GenericMutationCtx<DataModel>, "db">;
type SyncedEntity = "book" | "highlight" | "note" | "collection" | "tag" | "thread" | "daily-selection";

export { WEB_DEVICE_ID };

const TABLES = {
  book: "books",
  highlight: "highlights",
  note: "notes",
  collection: "collections",
  tag: "tags",
  thread: "threads",
  "daily-selection": "dailySelections",
} as const;

/**
 * Record a writer claim (and, for a deletion, a tombstone) for each entity a
 * web-client mutation changed, so desktops pull it like any synced change.
 * Without a claim, pull treats the entity as not yet synced and skips it.
 * Desktops claim with the entity's own revision as their device revision, so
 * the web does the same.
 */
export async function claimWebWrites(
  ctx: MutationContext,
  libraryId: string,
  changes: readonly { readonly entityType: SyncedEntity; readonly entityId: string }[],
  now: number,
): Promise<void> {
  const seen = new Set<string>();
  for (const { entityType, entityId } of changes) {
    const key = `${entityType}:${entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = await ctx.db.query(TABLES[entityType])
      .withIndex("by_library_and_id", (query) => query.eq("libraryId", libraryId).eq("id", entityId))
      .unique() as { revision: number; deletedAt?: number; bookId?: string } | null;
    let operation: "upsert" | "tombstone";
    let entityRevision: number;
    if (row) {
      operation = row.deletedAt === undefined ? "upsert" : "tombstone";
      entityRevision = Number(row.revision);
    } else {
      // Daily selections are removed outright; their tombstone carries the revision.
      const tombstone = await ctx.db.query("syncTombstones").withIndex("by_library_entity", (query) => query
        .eq("libraryId", libraryId).eq("entityType", entityType).eq("entityId", entityId)).unique();
      if (!tombstone) continue;
      operation = "tombstone";
      entityRevision = Number(tombstone.revision);
    }
    if (row && operation === "tombstone") {
      // Pull confirms a deletion against its tombstone, as sync deletions record one.
      const tombstone = await ctx.db.query("syncTombstones").withIndex("by_library_entity", (query) => query
        .eq("libraryId", libraryId).eq("entityType", entityType).eq("entityId", entityId)).unique();
      // As sync deletions do, a passage or note records its book; anything else, itself.
      const record = { revision: entityRevision, deletedAt: row.deletedAt ?? now, bookId: row.bookId ?? entityId };
      if (tombstone) await ctx.db.patch(tombstone._id, record);
      else await ctx.db.insert("syncTombstones", { libraryId, entityType, entityId, ...record });
    }
    const claim = { deviceId: WEB_DEVICE_ID, deviceRevision: entityRevision, operation, entityRevision, appliedAt: now };
    const writer = await ctx.db.query("syncedWriters").withIndex("by_library_entity", (query) => query
      .eq("libraryId", libraryId).eq("entityType", entityType).eq("entityId", entityId)).unique();
    if (writer) await ctx.db.patch(writer._id, claim);
    else await ctx.db.insert("syncedWriters", { libraryId, entityType, entityId, ...claim });
  }
}
