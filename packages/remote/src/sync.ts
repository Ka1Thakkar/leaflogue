import {
  assertSyncAcknowledgement,
  assertSyncChangePage,
  MAX_SYNC_CHANGE_PAGE,
  MAX_SYNC_ORGANIZATION_MEMBERSHIPS,
  syncOperationId,
  type ResolvedSyncBatch,
  type ResolvedSyncChange,
  type SyncAcknowledgement,
  type SyncChangePage,
  type SyncCursor,
  type SyncedChange,
  type SyncedChangeOutcome,
  type SyncEntityType,
  type SyncOutboxEntry,
} from "@leaflogue/contracts";

/**
 * What a provider accepted. `operationIds` name the outbox entries of the
 * changes that landed, in order; a transport that meets a failure stops there,
 * reports the landed prefix, and returns the failure rather than throwing so
 * the prefix is still acknowledged (ADR 0005).
 */
export interface SyncSubmission extends SyncAcknowledgement {
  readonly failure?: unknown;
}

/**
 * Provider edge. Implementations may use PostgreSQL, Convex, or a future HTTP
 * API, but must apply changes in order and treat a repeated delivery of the
 * same change as harmless.
 */
export interface SyncTransport {
  submit(changes: readonly ResolvedSyncChange[], signal?: AbortSignal): Promise<SyncSubmission>;
  /** Terminate an in-flight provider call; the transport is unusable afterward. */
  cancel?(): Promise<void>;
}

/** Local persistence edge; it intentionally exposes no credentials or network. */
export interface SyncOutboxLedger {
  resolvePendingSyncChanges(limit: number): ResolvedSyncBatch;
  acknowledgeSyncChanges(entries: readonly SyncOutboxEntry[], acknowledgement: SyncAcknowledgement): void;
}

export interface SyncDelivery {
  /** Outbox entries acknowledged because the provider accepted their change. */
  readonly delivered: number;
  /** Outbox entries retired because a winning incoming change already owns their entity. */
  readonly superseded: number;
  readonly hasMore: boolean;
}

/**
 * Deliver one bounded outbox page. The ledger resolves it against current local
 * state; the landed prefix is acknowledged before any transport failure is
 * rethrown, so an interrupted delivery repeats only what did not land.
 */
export async function deliverPendingSyncChanges(
  ledger: SyncOutboxLedger,
  transport: SyncTransport,
  limit = MAX_SYNC_CHANGE_PAGE,
  signal?: AbortSignal,
  /** Told what was acknowledged even when the delivery then fails. */
  onAcknowledged?: (progress: Omit<SyncDelivery, "hasMore">) => void,
): Promise<SyncDelivery> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYNC_CHANGE_PAGE) {
    throw new Error("Sync delivery limit is invalid");
  }
  const batch = ledger.resolvePendingSyncChanges(limit);
  const submitted = batch.changes.flatMap(({ entries }) => entries);
  // A page may bring each owner's bounded collection/tag dependencies ahead of
  // it. The envelope remains finite even during a full provider rebuild.
  const maxResolvedChanges = limit * (MAX_SYNC_ORGANIZATION_MEMBERSHIPS * 3 + 3);
  if (submitted.length + batch.superseded.length > limit || batch.changes.length > maxResolvedChanges) {
    throw new Error("Sync delivery batch exceeds its limit");
  }
  if (batch.superseded.length > 0) {
    ledger.acknowledgeSyncChanges(batch.superseded, { operationIds: batch.superseded.map(syncOperationId) });
  }
  if (batch.changes.length === 0) return { delivered: 0, superseded: batch.superseded.length, hasMore: batch.hasMore };
  const submission = await transport.submit(batch.changes, signal);
  const landed = assertLandedPrefix(batch.changes, submission);
  if (landed.entries.length > 0) {
    ledger.acknowledgeSyncChanges(landed.entries, { operationIds: submission.operationIds });
  }
  if (submission.failure !== undefined) {
    onAcknowledged?.({ delivered: landed.entries.length, superseded: batch.superseded.length });
    throw submission.failure;
  }
  return {
    delivered: landed.entries.length,
    superseded: batch.superseded.length,
    hasMore: batch.hasMore || landed.changes < batch.changes.length,
  };
}

/**
 * Accept only an acknowledgement that names, in order, every entry of some
 * prefix of the submitted changes. Anything else could acknowledge an entry
 * whose change never landed, or leave a gap behind a later acknowledged one.
 */
function assertLandedPrefix(
  changes: readonly ResolvedSyncChange[],
  submission: SyncSubmission,
): { readonly entries: readonly SyncOutboxEntry[]; readonly changes: number } {
  const submitted = changes.flatMap(({ entries }) => entries);
  assertSyncAcknowledgement(submitted, submission);
  const acknowledged = submission.operationIds;
  let offset = 0;
  let landedChanges = 0;
  for (const { entries } of changes) {
    if (offset + entries.length > acknowledged.length) break;
    for (const [index, entry] of entries.entries()) {
      if (acknowledged[offset + index] !== syncOperationId(entry)) throw new Error("Sync acknowledgement is not an ordered prefix");
    }
    offset += entries.length;
    landedChanges += 1;
  }
  if (offset !== acknowledged.length) throw new Error("Sync acknowledgement is not an ordered prefix");
  if (submission.failure === undefined && landedChanges === changes.length) return { entries: submitted, changes: landedChanges };
  // A dependency-only change carries no entries, so a trailing one cannot be
  // counted as landed from the acknowledgement alone.
  while (landedChanges > 0 && changes[landedChanges - 1]!.entries.length === 0) landedChanges -= 1;
  return { entries: submitted.slice(0, offset), changes: landedChanges };
}

/**
 * One provider page and the entity state behind each change, aligned by index.
 * A provider leaves a slot undefined when it cannot express that change as a
 * `SyncedChange`: an entity type replay does not cover yet, or a row written
 * by an interactive mutation that recorded no device claim to order it by.
 */
export interface SyncPullPage {
  readonly page: SyncChangePage;
  readonly changes: readonly (SyncedChange | undefined)[];
}

export interface SyncChangeSource {
  pull(cursor: SyncCursor, limit: number, signal?: AbortSignal): Promise<SyncPullPage>;
}

/**
 * Where a library that needs a snapshot starts reading this provider. A
 * provider that keeps its whole change history can start at its beginning,
 * so replaying the history is the snapshot.
 */
export interface SyncBootstrapSource {
  bootstrapCursor(signal?: AbortSignal): Promise<SyncCursor>;
  /** Verify an existing cursor before any local changes are pushed. */
  validateCursor?(cursor: SyncCursor, signal?: AbortSignal): Promise<boolean>;
}

/** Local edge of a snapshot rebuild; see `LocalLibrary.bootstrapSync`. */
export interface SyncBootstrapLedger {
  bootstrapSync(cursor: SyncCursor): { readonly enqueued: number };
  requireSyncSnapshot(): void;
}

export interface SyncIncomingLedger {
  getSyncState(): { readonly remoteCursor?: SyncCursor; readonly snapshotRequired: boolean };
  applyIncomingSyncedChange(input: {
    readonly change: SyncedChange;
    readonly sequence: number;
    readonly expectedCursor: SyncCursor;
    readonly nextCursor: SyncCursor;
  }): SyncedChangeOutcome;
}

export type SyncPull =
  | { readonly status: "pulled"; readonly applied: number; readonly superseded: number; readonly isDone: boolean }
  /** The local cursor has no provider history to continue from; only a snapshot rebuild can proceed. */
  | { readonly status: "snapshot-required" }
  /** Stopped before a change this build cannot apply; the cursor stays behind it. */
  | { readonly status: "unsupported-change"; readonly applied: number; readonly superseded: number; readonly entityType: SyncEntityType };

/**
 * Apply one bounded provider page. Each change is written with its exact cursor
 * advance in one local transaction, so stopping between changes — for
 * cancellation, an unsupported change, or a failure — never skips or repeats
 * one. Nothing is guessed on reset: the caller is told a snapshot is required.
 */
export async function pullSyncChanges(
  ledger: SyncIncomingLedger,
  source: SyncChangeSource,
  limit = MAX_SYNC_CHANGE_PAGE,
  signal?: AbortSignal,
): Promise<SyncPull> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYNC_CHANGE_PAGE) {
    throw new Error("Sync pull limit is invalid");
  }
  const state = ledger.getSyncState();
  if (state.snapshotRequired || !state.remoteCursor) return { status: "snapshot-required" };
  let cursor = state.remoteCursor;
  const { page, changes } = await source.pull(cursor, limit, signal);
  assertSyncChangePage(cursor, page);
  if (page.resetRequired) return { status: "snapshot-required" };
  if (page.changes.length > limit || !Array.isArray(changes) || changes.length !== page.changes.length) {
    throw new Error("Sync page payloads do not match its changes");
  }
  let applied = 0;
  let superseded = 0;
  for (const [index, identity] of page.changes.entries()) {
    if (signal?.aborted) return { status: "pulled", applied, superseded, isDone: false };
    const change: SyncedChange | undefined = changes[index];
    if (!change) return { status: "unsupported-change", applied, superseded, entityType: identity.entityType };
    if (change.entityType !== identity.entityType ||
        syncedEntityId(change).toLowerCase() !== identity.entityId.toLowerCase()) {
      throw new Error("Sync page payloads do not match its changes");
    }
    const nextCursor = {
      generation: cursor.generation,
      afterSequence: identity.sequence,
      ...(identity.checkpoint ? { checkpoint: identity.checkpoint } : cursor.checkpoint ? { checkpoint: cursor.checkpoint } : {}),
    };
    const outcome = ledger.applyIncomingSyncedChange({ change, sequence: identity.sequence, expectedCursor: cursor, nextCursor });
    if (outcome === "applied") applied += 1;
    else superseded += 1;
    cursor = nextCursor;
  }
  return { status: "pulled", applied, superseded, isDone: page.isDone };
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
