import { describe, expect, it } from "vitest";
import type { SyncedChange } from "@leaflogue/contracts";
import { ConvexSyncTransport, convexSyncedChange, prepareConvexLibrary } from "./convex-sync";

const SESSION = {
  libraryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  deviceId: "11111111-1111-4111-8111-111111111111",
};
const SYNC_KEY = "k".repeat(44);

function transport(fetch: typeof globalThis.fetch) {
  return new ConvexSyncTransport({ deploymentUrl: "https://example.convex.cloud", syncKey: SYNC_KEY, fetch, session: SESSION });
}

describe("Convex sync transport", () => {
  it("projects local changes onto the exact provider shape", () => {
    const change = {
      entityType: "highlight", operation: "upsert", deviceId: SESSION.deviceId, deviceRevision: 3,
      highlight: { id: "h", bookId: "b", text: "Passage", sourceLocation: undefined, createdAt: 1, updatedAt: 2, revision: 3, notes: [] },
      tagIds: ["t"], threadIds: [],
    } as unknown as SyncedChange;
    expect(convexSyncedChange(change)).toEqual({
      entityType: "highlight", operation: "upsert", deviceId: SESSION.deviceId, deviceRevision: 3,
      highlight: { id: "h", bookId: "b", text: "Passage", createdAt: 1, updatedAt: 2, revision: 3 }, tagIds: ["t"], threadIds: [],
    });
    expect(convexSyncedChange({ entityType: "tag", operation: "tombstone", deviceId: SESSION.deviceId, deviceRevision: 1, entityId: "t" } as SyncedChange))
      .toEqual({ entityType: "tag", operation: "tombstone", deviceId: SESSION.deviceId, deviceRevision: 1, entityId: "t" });
  });

  it("sends the sync key only as a function argument and classifies failures by code only", async () => {
    const bodies: string[] = [];
    const refused = transport(async (_input, init) => {
      bodies.push(String(init?.body));
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return Response.json({ status: "error", errorMessage: "wrong key for reader@example.com",
        errorData: { code: "LEAFLOGUE_SYNC_KEY_INVALID", message: "x" }, logLines: [] }, { status: 560 });
    });
    const failure = await refused.bootstrapCursor().catch((error: unknown) => error);
    expect((JSON.parse(bodies[0]!) as { args: unknown[] }).args[0]).toMatchObject({ libraryId: SESSION.libraryId, syncKey: SYNC_KEY });
    expect(failure).toMatchObject({ code: "LEAFLOGUE_SYNC_KEY_INVALID" });
    expect(String((failure as Error).message)).not.toContain("reader@example.com");
    const offline = transport(async () => { throw new TypeError("fetch failed"); });
    await expect(offline.bootstrapCursor()).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("returns the landed prefix and the failure when a push is refused", async () => {
    const refused = transport(async () => Response.json({
      status: "error", errorMessage: "inactive", errorData: { code: "LEAFLOGUE_SESSION_INACTIVE", message: "inactive" }, logLines: [],
    }, { status: 560 }));
    const submission = await refused.submit([{
      change: { entityType: "book", operation: "tombstone", deviceId: SESSION.deviceId, deviceRevision: 1, entityId: "b" } as SyncedChange,
      entries: [],
    }]);
    expect(submission.operationIds).toEqual([]);
    expect(submission.failure).toMatchObject({ code: "LEAFLOGUE_SESSION_INACTIVE" });
  });

  it("holds thread and passage upserts for a contract-22 backend without acknowledging them", async () => {
    const pushed: string[] = [];
    const older = new ConvexSyncTransport({
      deploymentUrl: "https://example.convex.cloud", syncKey: SYNC_KEY, session: SESSION, mutationContractVersion: 22,
      fetch: async (_input, init) => {
        pushed.push((JSON.parse(String(init?.body)) as { args: Array<{ change: { entityType: string } }> }).args[0]!.change.entityType);
        return Response.json({ status: "success", value: "applied", logLines: [] });
      },
    });
    const entry = (sequence: number) => ({ sequence, deviceId: SESSION.deviceId, entityType: "book", entityId: "b",
      revision: 1, operation: "upsert", createdAt: 1 }) as never;
    const book = { entityType: "book", operation: "tombstone", deviceId: SESSION.deviceId, deviceRevision: 1, entityId: "b" } as SyncedChange;
    const thread = { entityType: "thread", operation: "tombstone", deviceId: SESSION.deviceId, deviceRevision: 1, entityId: "t" } as SyncedChange;
    const submission = await older.submit([{ change: book, entries: [entry(1)] }, { change: thread, entries: [entry(2)] }]);
    expect(pushed).toEqual(["book"]);
    expect(submission.operationIds).toEqual([`${SESSION.deviceId}:1`]);
    expect(submission.failure).toMatchObject({ code: "LEAFLOGUE_CONVEX_UPGRADE_REQUIRED" });

    const bookWith = (statusEvents: unknown[]) => ({ entityType: "book", operation: "upsert", deviceId: SESSION.deviceId,
      deviceRevision: 2, collectionIds: [], tagIds: [], statusEvents,
      book: { id: "b", title: "Piranesi", authors: [], status: "reading", archived: false, createdAt: 1, updatedAt: 2, revision: 2, highlightCount: 0 },
    }) as unknown as SyncedChange;
    pushed.length = 0;
    const withoutHistory = await older.submit([{ change: bookWith([]), entries: [entry(3)] }]);
    expect(withoutHistory).toEqual({ operationIds: [`${SESSION.deviceId}:3`] });
    const withHistory = await older.submit([{ change: bookWith([{ id: "e", bookId: "b", status: "reading", source: "reader", changedAt: 1, bookRevision: 2 }]), entries: [entry(4)] }]);
    expect(withHistory.failure).toMatchObject({ code: "LEAFLOGUE_CONVEX_UPGRADE_REQUIRED" });
    expect(pushed).toEqual(["book"]);
  });

  it("refuses redirected responses", async () => {
    const redirected = transport(async () => {
      const response = Response.json({ status: "success", value: true, logLines: [] });
      Object.defineProperty(response, "url", { value: "https://elsewhere.example/api/query" });
      return response;
    });
    await expect(redirected.validateCursor({ generation: 1, afterSequence: 0 })).rejects.toMatchObject({ code: "LEAFLOGUE_PROVIDER_FAILED" });
  });

  it("drains bounded migration progress and confirms only the reviewed note", async () => {
    const firstSteps = [
      { status: "progress", migration: "daily-candidates", updated: 50, detached: 0 },
      { status: "review-required", migration: "attached-notes", updated: 0, detached: 0,
        reviewNoteId: "note-to-detach", reviewReason: "oversized" },
    ];
    const first = await prepareConvexLibrary({
      deploymentUrl: "https://example.convex.cloud", syncKey: SYNC_KEY,
      fetch: async () => Response.json({ status: "success", value: firstSteps.shift(), logLines: [] }),
    }, SESSION.libraryId);
    expect(first).toEqual({ status: "review-required", updated: 50, detached: 0,
      reviewNoteId: "note-to-detach", reviewReason: "oversized" });

    const bodies: Array<{ args: Array<Record<string, unknown>> }> = [];
    const confirmedSteps = [
      { status: "progress", migration: "attached-notes", updated: 1, detached: 1 },
      { status: "complete", updated: 0, detached: 0 },
    ];
    await expect(prepareConvexLibrary({
      deploymentUrl: "https://example.convex.cloud", syncKey: SYNC_KEY,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { args: Array<Record<string, unknown>> });
        return Response.json({ status: "success", value: confirmedSteps.shift(), logLines: [] });
      },
    }, SESSION.libraryId, { confirmDetachNoteId: "note-to-detach" })).resolves.toEqual({
      status: "ready", updated: 1, detached: 1,
    });
    expect(bodies[0]?.args[0]).toMatchObject({ confirmDetachNoteId: "note-to-detach" });
    expect(bodies[1]?.args[0]).not.toHaveProperty("confirmDetachNoteId");
  });

  it("reports a migration safety-bound pause and rejects malformed progress", async () => {
    const progress = async () => Response.json({ status: "success", value: {
      status: "progress", migration: "highlight-projection", updated: 1, detached: 0,
    }, logLines: [] });
    await expect(prepareConvexLibrary({
      deploymentUrl: "https://example.convex.cloud", syncKey: SYNC_KEY, fetch: progress,
    }, SESSION.libraryId, { maxSteps: 2 })).resolves.toEqual({ status: "incomplete", updated: 2, detached: 0 });
    await expect(prepareConvexLibrary({
      deploymentUrl: "https://example.convex.cloud", syncKey: SYNC_KEY,
      fetch: async () => Response.json({ status: "success", value: {
        status: "review-required", migration: "attached-notes", updated: 0, detached: 1,
      }, logLines: [] }),
    }, SESSION.libraryId)).rejects.toMatchObject({ code: "LEAFLOGUE_PROVIDER_PROTOCOL" });

    for (const value of [
      { status: "complete", updated: 1, detached: 0 },
      { status: "complete", updated: 0, detached: 0, unexpected: true },
      { status: "progress", migration: "highlight-tag-books", updated: 51, detached: 0 },
      { status: "progress", migration: "daily-candidates", updated: 1, detached: 1 },
      { status: "progress", migration: "attached-notes", updated: 0, detached: 0 },
      { status: "progress", migration: "attached-notes", updated: 2, detached: 1 },
      { status: "progress", migration: "highlight-projection", updated: 2, detached: 0 },
      { status: "review-required", migration: "attached-notes", updated: 1, detached: 0,
        reviewNoteId: "note", reviewReason: "oversized" },
    ]) {
      await expect(prepareConvexLibrary({
        deploymentUrl: "https://example.convex.cloud", syncKey: SYNC_KEY,
        fetch: async () => Response.json({ status: "success", value, logLines: [] }),
      }, SESSION.libraryId)).rejects.toMatchObject({ code: "LEAFLOGUE_PROVIDER_PROTOCOL" });
    }
  });
});
