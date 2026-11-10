import { describe, expect, it } from "vitest";
import { assertSyncAcknowledgement, assertSyncChangePage, MAX_SYNC_CHANGE_PAGE, syncOperationId } from "./index";

const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("sync protocol contracts", () => {
  it("creates a stable idempotency key from a local device sequence", () => {
    expect(syncOperationId({ deviceId, sequence: 42 })).toBe(`${deviceId}:42`);
    expect(() => syncOperationId({ deviceId: deviceId.toUpperCase(), sequence: 1 })).toThrow(/identity is invalid/);
  });

  it("accepts ordered same-generation pages and rejects unsafe cursor transitions", () => {
    expect(() => assertSyncChangePage(
      { generation: 3, afterSequence: 4 },
      {
        changes: [{ sequence: 5, entityType: "book", entityId: deviceId, revision: 1, changedAt: 1 }],
        nextCursor: { generation: 3, afterSequence: 5 }, isDone: true, resetRequired: false,
      },
    )).not.toThrow();
    expect(() => assertSyncChangePage(
      { generation: 3, afterSequence: 5 },
      {
        changes: [
          { sequence: 6, entityType: "collection", entityId: deviceId, revision: 2, changedAt: 2 },
          { sequence: 7, entityType: "tag", entityId: deviceId, revision: 3, changedAt: 3 },
          { sequence: 8, entityType: "thread", entityId: deviceId, revision: 1, changedAt: 4 },
          { sequence: 9, entityType: "daily-selection", entityId: deviceId, revision: 1, changedAt: 5 },
        ],
        nextCursor: { generation: 3, afterSequence: 9 }, isDone: true, resetRequired: false,
      },
    )).not.toThrow();
    expect(() => assertSyncChangePage(
      { generation: 3, afterSequence: 4 },
      { changes: [], nextCursor: { generation: 4, afterSequence: 0 }, isDone: false, resetRequired: false },
    )).toThrow(/generation changed/);
  });

  it("requires reset pages to contain no data and restart at sequence zero", () => {
    expect(() => assertSyncChangePage(
      { generation: 3, afterSequence: 4 },
      { changes: [], nextCursor: { generation: 4, afterSequence: 0 }, isDone: false, resetRequired: true },
    )).not.toThrow();
    expect(() => assertSyncChangePage(
      { generation: 3, afterSequence: 4 },
      {
        changes: [{ sequence: 5, entityType: "book", entityId: deviceId, revision: 1, changedAt: 1 }],
        nextCursor: { generation: 4, afterSequence: 5 }, isDone: false, resetRequired: true,
      },
    )).toThrow(/reset page/);
  });

  it("rejects unbounded or non-progressing change pages while accepting legacy entity IDs", () => {
    const change = { sequence: 1, entityType: "book" as const, entityId: deviceId.toUpperCase(), revision: 1, changedAt: 1 };
    expect(() => assertSyncChangePage(
      { generation: 1, afterSequence: 0 },
      { changes: [change], nextCursor: { generation: 1, afterSequence: 1 }, isDone: true, resetRequired: false },
    )).not.toThrow();
    expect(() => assertSyncChangePage(
      { generation: 1, afterSequence: 0 },
      { changes: [], nextCursor: { generation: 1, afterSequence: 0 }, isDone: false, resetRequired: false },
    )).toThrow(/no progress/);
    expect(() => assertSyncChangePage(
      { generation: 1, afterSequence: 0 },
      { changes: Array.from({ length: MAX_SYNC_CHANGE_PAGE + 1 }, (_, index) => ({ ...change, sequence: index + 1 })), nextCursor: { generation: 1, afterSequence: MAX_SYNC_CHANGE_PAGE + 1 }, isDone: true, resetRequired: false },
    )).toThrow(/exceeds/);
  });

  it("accepts only unique acknowledgements for operations that were submitted", () => {
    const submitted = [{ sequence: 1, deviceId, entityType: "book" as const, entityId: deviceId, revision: 1, operation: "upsert" as const, createdAt: 1 }];
    expect(() => assertSyncAcknowledgement(submitted, { operationIds: [`${deviceId}:1`] })).not.toThrow();
    expect(() => assertSyncAcknowledgement(submitted, { operationIds: [`${deviceId}:2`] })).toThrow(/acknowledgement/);
    expect(() => assertSyncAcknowledgement(submitted, { operationIds: [`${deviceId}:1`, `${deviceId}:1`] })).toThrow(/acknowledgement/);
  });
});
