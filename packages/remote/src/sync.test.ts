import { describe, expect, it } from "vitest";
import type { ResolvedSyncBatch, ResolvedSyncChange, SyncedChange, SyncOutboxEntry } from "@leaflogue/contracts";
import {
  deliverPendingSyncChanges,
  pullSyncChanges,
  type SyncChangeSource,
  type SyncIncomingLedger,
  type SyncOutboxLedger,
  type SyncTransport,
} from "./sync";

const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bookId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const noteId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function entry(sequence: number, entityType: SyncOutboxEntry["entityType"] = "book", entityId = bookId): SyncOutboxEntry {
  return { sequence, deviceId, entityType, entityId, revision: sequence, operation: "upsert", createdAt: 1 };
}

function bookChange(deviceRevision = 1): SyncedChange {
  return { entityType: "book", operation: "tombstone", deviceId, deviceRevision, entityId: bookId as never };
}

function noteChange(deviceRevision = 1): SyncedChange {
  return { entityType: "note", operation: "tombstone", deviceId, deviceRevision, entityId: noteId as never, bookId: bookId as never };
}

function ledgerFor(batch: ResolvedSyncBatch, acknowledged: string[][] = []): SyncOutboxLedger {
  return {
    resolvePendingSyncChanges: (limit) => {
      expect(limit).toBeLessThanOrEqual(100);
      return batch;
    },
    acknowledgeSyncChanges: (_entries, acknowledgement) => { acknowledged.push([...acknowledgement.operationIds]); },
  };
}

const ids = (...sequences: number[]) => sequences.map((sequence) => `${deviceId}:${sequence}`);

describe("provider-neutral sync delivery", () => {
  it("retires superseded entries locally and acknowledges every landed change", async () => {
    const acknowledged: string[][] = [];
    const changes: ResolvedSyncChange[] = [
      { change: bookChange(2), entries: [entry(1), entry(2)] },
      { change: noteChange(), entries: [entry(4, "note", noteId)] },
    ];
    const ledger = ledgerFor({ changes, superseded: [entry(3, "highlight")], hasMore: false }, acknowledged);
    const submitted: ResolvedSyncChange[][] = [];
    const transport: SyncTransport = {
      submit: async (batch) => {
        submitted.push([...batch]);
        return { operationIds: ids(1, 2, 4) };
      },
    };
    await expect(deliverPendingSyncChanges(ledger, transport)).resolves.toEqual({ delivered: 3, superseded: 1, hasMore: false });
    expect(submitted).toEqual([changes]);
    expect(acknowledged).toEqual([ids(3), ids(1, 2, 4)]);
  });

  it("acknowledges the landed prefix before rethrowing a transport failure", async () => {
    const acknowledged: string[][] = [];
    const ledger = ledgerFor({
      changes: [{ change: bookChange(), entries: [entry(1)] }, { change: noteChange(), entries: [entry(2, "note", noteId)] }],
      superseded: [],
      hasMore: false,
    }, acknowledged);
    const failure = new Error("provider refused");
    await expect(deliverPendingSyncChanges(ledger, { submit: async () => ({ operationIds: ids(1), failure }) }))
      .rejects.toBe(failure);
    expect(acknowledged).toEqual([ids(1)]);
  });

  it("does not count a trailing dependency-only change as landed", async () => {
    const ledger = ledgerFor({
      changes: [{ change: bookChange(), entries: [entry(1)] }, { change: bookChange(5), entries: [] },
        { change: noteChange(), entries: [entry(2, "note", noteId)] }],
      superseded: [],
      hasMore: false,
    });
    await expect(deliverPendingSyncChanges(ledger, { submit: async () => ({ operationIds: ids(1) }) }))
      .resolves.toEqual({ delivered: 1, superseded: 0, hasMore: true });
  });

  it("refuses acknowledgements that skip or split a change", async () => {
    const batch = {
      changes: [{ change: bookChange(2), entries: [entry(1), entry(2)] }, { change: noteChange(), entries: [entry(3, "note", noteId)] }],
      superseded: [],
      hasMore: false,
    };
    const rejectAll = () => { throw new Error("must not acknowledge"); };
    for (const operationIds of [ids(3), ids(1), ids(2, 1, 3), ["other:1"]]) {
      await expect(deliverPendingSyncChanges({ resolvePendingSyncChanges: () => batch, acknowledgeSyncChanges: rejectAll },
        { submit: async () => ({ operationIds }) })).rejects.toThrow(/acknowledgement/);
    }
  });

  it("rejects oversized requests and empty pages without invoking a transport", async () => {
    let calls = 0;
    const transport: SyncTransport = { submit: async () => { calls += 1; return { operationIds: [] }; } };
    const ledger = ledgerFor({ changes: [], superseded: [], hasMore: false });
    await expect(deliverPendingSyncChanges(ledger, transport, 101)).rejects.toThrow(/limit/);
    await expect(deliverPendingSyncChanges(ledger, transport)).resolves.toEqual({ delivered: 0, superseded: 0, hasMore: false });
    const overReturning = ledgerFor({
      changes: [{ change: bookChange(), entries: [entry(1), entry(2)] }], superseded: [], hasMore: true,
    });
    await expect(deliverPendingSyncChanges(overReturning, transport, 1)).rejects.toThrow(/batch exceeds/);
    expect(calls).toBe(0);
  });

  it("allows the bounded note-to-passage-to-book dependency closure", async () => {
    const dependencies = Array.from({ length: 3_002 }, (_, index) => ({
      change: bookChange(index + 2),
      entries: [],
    }));
    const root = { change: noteChange(), entries: [entry(1, "note", noteId)] };
    const accepted = ledgerFor({ changes: [...dependencies, root], superseded: [], hasMore: false });
    await expect(deliverPendingSyncChanges(accepted, {
      submit: async () => ({ operationIds: ids(1) }),
    }, 1)).resolves.toEqual({ delivered: 1, superseded: 0, hasMore: false });

    const rejected = ledgerFor({
      changes: [{ change: bookChange(9_999), entries: [] }, ...dependencies, root],
      superseded: [],
      hasMore: false,
    });
    await expect(deliverPendingSyncChanges(rejected, {
      submit: async () => ({ operationIds: ids(1) }),
    }, 1)).rejects.toThrow("batch exceeds its limit");
  });
});

describe("provider-neutral sync pull", () => {
  function incoming(state: ReturnType<SyncIncomingLedger["getSyncState"]>) {
    const applied: Array<{ sequence: number; expected: number; next: number }> = [];
    const ledger: SyncIncomingLedger = {
      getSyncState: () => state,
      applyIncomingSyncedChange: ({ sequence, expectedCursor, nextCursor }) => {
        applied.push({ sequence, expected: expectedCursor.afterSequence, next: nextCursor.afterSequence });
        return sequence % 2 === 0 ? "superseded" : "applied";
      },
    };
    return { ledger, applied };
  }

  const identity = (sequence: number, entityType: "book" | "note" | "collection" = "book") => ({
    sequence, entityType, entityId: entityType === "note" ? noteId : bookId, revision: 1, changedAt: 1,
  });

  it("applies each change with its own exact cursor advance", async () => {
    const { ledger, applied } = incoming({ remoteCursor: { generation: 1, afterSequence: 4 }, snapshotRequired: false });
    const source: SyncChangeSource = {
      pull: async (cursor, limit) => {
        expect([cursor, limit]).toEqual([{ generation: 1, afterSequence: 4 }, 100]);
        return {
          page: { changes: [identity(5), identity(8, "note")], nextCursor: { generation: 1, afterSequence: 8 }, isDone: true, resetRequired: false },
          changes: [bookChange(), noteChange()],
        };
      },
    };
    await expect(pullSyncChanges(ledger, source)).resolves.toEqual({ status: "pulled", applied: 1, superseded: 1, isDone: true });
    expect(applied).toEqual([{ sequence: 5, expected: 4, next: 5 }, { sequence: 8, expected: 5, next: 8 }]);
  });

  it("reports a required snapshot instead of guessing, before or after asking the provider", async () => {
    let pulls = 0;
    const source: SyncChangeSource = {
      pull: async () => {
        pulls += 1;
        return { page: { changes: [], nextCursor: { generation: 2, afterSequence: 0 }, isDone: false, resetRequired: true }, changes: [] };
      },
    };
    await expect(pullSyncChanges(incoming({ snapshotRequired: true }).ledger, source)).resolves.toEqual({ status: "snapshot-required" });
    expect(pulls).toBe(0);
    const { ledger, applied } = incoming({ remoteCursor: { generation: 1, afterSequence: 9 }, snapshotRequired: false });
    await expect(pullSyncChanges(ledger, source)).resolves.toEqual({ status: "snapshot-required" });
    expect(applied).toEqual([]);
  });

  it("stops before an unexpressed change and leaves the cursor behind it", async () => {
    const { ledger, applied } = incoming({ remoteCursor: { generation: 1, afterSequence: 0 }, snapshotRequired: false });
    const source: SyncChangeSource = {
      pull: async () => ({
        page: { changes: [identity(1), identity(2, "collection"), identity(3)], nextCursor: { generation: 1, afterSequence: 3 }, isDone: true, resetRequired: false },
        changes: [bookChange(), undefined, bookChange(2)],
      }),
    };
    await expect(pullSyncChanges(ledger, source)).resolves.toEqual({
      status: "unsupported-change", applied: 1, superseded: 0, entityType: "collection",
    });
    expect(applied.map(({ sequence }) => sequence)).toEqual([1]);
  });

  it("rejects malformed pages and payloads that do not match their change", async () => {
    const { ledger, applied } = incoming({ remoteCursor: { generation: 1, afterSequence: 0 }, snapshotRequired: false });
    const pageOf = (changes: readonly (SyncedChange | undefined)[]): SyncChangeSource => ({
      pull: async () => ({
        page: { changes: [identity(1, "note")], nextCursor: { generation: 1, afterSequence: 1 }, isDone: true, resetRequired: false },
        changes,
      }),
    });
    await expect(pullSyncChanges(ledger, pageOf([bookChange()]))).rejects.toThrow(/do not match/);
    await expect(pullSyncChanges(ledger, pageOf([]))).rejects.toThrow(/do not match/);
    await expect(pullSyncChanges(ledger, {
      pull: async () => ({
        page: { changes: [identity(1)], nextCursor: { generation: 1, afterSequence: 7 }, isDone: true, resetRequired: false },
        changes: [bookChange()],
      }),
    })).rejects.toThrow(/cursor does not match/);
    expect(applied).toEqual([]);
  });

  it("stops between changes once cancelled", async () => {
    const { ledger, applied } = incoming({ remoteCursor: { generation: 1, afterSequence: 0 }, snapshotRequired: false });
    const controller = new AbortController();
    const source: SyncChangeSource = {
      pull: async () => {
        controller.abort();
        return {
          page: { changes: [identity(1)], nextCursor: { generation: 1, afterSequence: 1 }, isDone: true, resetRequired: false },
          changes: [bookChange()],
        };
      },
    };
    await expect(pullSyncChanges(ledger, source, 100, controller.signal))
      .resolves.toEqual({ status: "pulled", applied: 0, superseded: 0, isDone: false });
    expect(applied).toEqual([]);
  });
});
