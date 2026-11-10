// @vitest-environment edge-runtime

import { defineSchema, defineTable, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leaflogueTables } from "./tables";
import { convexModules } from "./test.setup";
import { WEB_DEVICE_ID } from "./webWrites";

/** What another app's schema looks like when it hosts Leaflogue's backend. */
const hostSchema = defineSchema({
  ...leaflogueTables,
  hostProfiles: defineTable({ email: v.string() }).index("by_email", ["email"]),
});

const KEY = "host-test-sync-key-0123456789abcdef";
const OWNER = "https://host.example|owner";
const STRANGER = "https://host.example|stranger";

const provisionHostOwner = makeFunctionReference<"mutation", { identityTokenIdentifier: string }, {
  libraryId: string; libraryCreated: boolean;
}>("access:provisionHostOwner");
const myLibraries = makeFunctionReference<"query", Record<string, never>, Array<{ libraryId: string; role: string }>>("access:myLibraries");
const createBook = makeFunctionReference<"mutation", { libraryId: string; id: string; title: string }, { title: string }>("runtime:createBook");
const createHighlight = makeFunctionReference<"mutation", { libraryId: string; id: string; bookId: string; text: string }, unknown>("runtime:createHighlight");
const deleteHighlight = makeFunctionReference<"mutation", { libraryId: string; id: string; bookId: string; expectedRevision: number }, unknown>("runtime:deleteHighlight");
const listBooks = makeFunctionReference<"query", {
  libraryId: string; paginationOpts: { numItems: number; cursor: string | null };
}, { page: Array<{ title: string }> }>("reading:listBooks");
const ensureLibrary = makeFunctionReference<"mutation", { syncKey: string }, { libraryId: string }>("syncRuntime:ensureLibrary");
const pull = makeFunctionReference<"query", {
  libraryId: string; syncKey: string; cursor: { generation: number; afterSequence: number }; limit: number;
}, { changes: Array<Record<string, unknown> | null> }>("syncRuntime:pull");

describe("hosting Leaflogue's backend in another Convex app", () => {
  beforeEach(() => { vi.stubEnv("LEAFLOGUE_SYNC_KEY", KEY); });

  it("runs Leaflogue's functions beside the host's own tables", async () => {
    const t = convexTest(hostSchema, convexModules);
    await t.run((ctx) => ctx.db.insert("hostProfiles", { email: "reader@example.com" }));
    const { libraryId, libraryCreated } = await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER });
    expect(libraryCreated).toBe(true);

    const owner = t.withIdentity({ tokenIdentifier: OWNER });
    expect(await owner.query(myLibraries, {})).toEqual([{ libraryId, role: "owner" }]);
    await owner.mutation(createBook, { libraryId, id: "55555555-5555-4555-8555-555555555555", title: "The Glass Orchard" });
    expect((await owner.query(listBooks, { libraryId, paginationOpts: { numItems: 10, cursor: null } })).page.map(({ title }) => title))
      .toEqual(["The Glass Orchard"]);
    expect(await t.run((ctx) => ctx.db.query("hostProfiles").collect())).toHaveLength(1);
  });

  it("gives the web owner and the desktop's sync key the same library", async () => {
    const t = convexTest(hostSchema, convexModules);
    const fromDesktop = await t.mutation(ensureLibrary, { syncKey: KEY });
    const fromHost = await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER });
    expect(fromHost).toEqual({ libraryId: fromDesktop.libraryId, libraryCreated: false });

    const owner = t.withIdentity({ tokenIdentifier: OWNER });
    await owner.mutation(createBook, { libraryId: fromHost.libraryId, id: "66666666-6666-4666-8666-666666666666", title: "Notes on Tidewater" });
    const pulled = await t.query(pull, { libraryId: fromDesktop.libraryId, syncKey: KEY, cursor: { generation: 1, afterSequence: 0 }, limit: 10 });
    // A web edit carries a writer claim, so the desktop pulls it like any synced change.
    expect(pulled.changes).toContainEqual(expect.objectContaining({
      entityType: "book",
      operation: "upsert",
      deviceId: WEB_DEVICE_ID,
      book: expect.objectContaining({ title: "Notes on Tidewater" }),
    }));
  });

  it("sends web deletions to the desktop as tombstones", async () => {
    const t = convexTest(hostSchema, convexModules);
    const { libraryId } = await t.mutation(ensureLibrary, { syncKey: KEY });
    await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER });
    const owner = t.withIdentity({ tokenIdentifier: OWNER });
    const bookId = "77777777-7777-4777-8777-777777777777";
    const highlightId = "88888888-8888-4888-8888-888888888888";
    await owner.mutation(createBook, { libraryId, id: bookId, title: "The Glass Orchard" });
    await owner.mutation(createHighlight, { libraryId, id: highlightId, bookId, text: "Every pane held a season." });
    await owner.mutation(deleteHighlight, { libraryId, id: highlightId, bookId, expectedRevision: 1 });
    const pulled = await t.query(pull, { libraryId, syncKey: KEY, cursor: { generation: 1, afterSequence: 0 }, limit: 20 });
    expect(pulled.changes).toContainEqual(expect.objectContaining({
      entityType: "highlight", operation: "tombstone", deviceId: WEB_DEVICE_ID, entityId: highlightId,
    }));
  });

  it("is idempotent, keeps other identities out, and refuses a deployment with several libraries", async () => {
    const t = convexTest(hostSchema, convexModules);
    const first = await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER });
    expect(await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER })).toEqual({ libraryId: first.libraryId, libraryCreated: false });
    expect(await t.run((ctx) => ctx.db.query("libraryMembers").collect())).toHaveLength(1);

    const stranger = t.withIdentity({ tokenIdentifier: STRANGER });
    expect(await stranger.query(myLibraries, {})).toEqual([]);
    await expect(stranger.query(listBooks, { libraryId: first.libraryId, paginationOpts: { numItems: 10, cursor: null } }))
      .rejects.toThrow("LEAFLOGUE_ACCESS_DENIED");
    await expect(t.query(myLibraries, {})).rejects.toThrow("LEAFLOGUE_AUTH_REQUIRED");

    await t.run((ctx) => ctx.db.insert("libraries", {
      externalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", nextChangeSequence: 0, createdAt: 0, updatedAt: 0,
    }));
    await expect(t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER })).rejects.toThrow("LEAFLOGUE_LIBRARY_SELECTION_REQUIRED");
  });
});
