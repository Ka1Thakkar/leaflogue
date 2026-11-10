// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { convexModules } from "./test.setup";

const OWNER = "https://host.example|owner";
const KEY = "import-test-sync-key-0123456789abcdef";
type Args = Record<string, unknown>;
const m = <R = unknown>(name: string) => makeFunctionReference<"mutation", Args, R>(name);
const q = <R = unknown>(name: string) => makeFunctionReference<"query", Args, R>(name);

const provisionHostOwner = m<{ libraryId: string }>("access:provisionHostOwner");
const createSource = m<{ sourceId: string }>("importRuntime:createSource");
const importBooks = m<{ booksCreated: number; booksReused: number }>("importRuntime:importBooks");
const importAnnotations = m<Record<string, number>>("importRuntime:importAnnotations");
const listConflicts = q<Array<{ id: string; incoming: string }>>("importRuntime:listConflicts");
const resolveConflict = m("importRuntime:resolveConflict");
const listBooks = q<{ page: Array<{ id: string; title: string; status: string }> }>("reading:listBooks");
const listHighlights = q<{ page: Array<{ id: string; text: string; revision: number }> }>("reading:listHighlights");
const listNotes = q<{ page: Array<{ markdown: string; origin: string; highlightId?: string }> }>("reading:listNotes");
const updateHighlight = m("runtime:updateHighlight");
const importedVersion = q<{ text: string; note?: string; edited: boolean } | null>("importRuntime:importedVersion");
const resetToImported = m("importRuntime:resetToImported");
const createHighlight = m("runtime:createHighlight");
const deleteHighlight = m("runtime:deleteHighlight");
const ensureLibrary = m<{ libraryId: string }>("syncRuntime:ensureLibrary");
const pull = q<{
  page: { isDone: boolean; nextCursor: { generation: number; afterSequence: number } };
  changes: Array<Record<string, unknown> | null>;
}>("syncRuntime:pull");

const book = { providerRecordId: "kobo-book-1", title: "The Glass Orchard", authors: ["Imogen Vale"], publisher: "Hollow Press", status: "finished" as const };
const passage = { providerRecordId: "bm-1", bookProviderRecordId: "kobo-book-1", text: "Every pane held a season.", note: "Glass as time.", location: "Chapter 3", createdAt: 1_700_000_000_000 };
const standalone = { providerRecordId: "bm-2", bookProviderRecordId: "kobo-book-1", note: "Read again in winter." };

async function setup() {
  const t = convexTest(schema, convexModules);
  const { libraryId } = await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER });
  const owner = t.withIdentity({ tokenIdentifier: OWNER });
  const { sourceId } = await owner.mutation(createSource, { libraryId, provider: "kobo", name: "My Kobo Clara" });
  const run = async (annotations: Args[]) => {
    await owner.mutation(importBooks, { libraryId, sourceId, books: [book] });
    return owner.mutation(importAnnotations, { libraryId, sourceId, annotations });
  };
  const page = { numItems: 50, cursor: null };
  const bookId = async () => (await owner.query(listBooks, { libraryId, paginationOpts: page })).page[0]!.id;
  const passages = async () => (await owner.query(listHighlights, { libraryId, bookId: await bookId(), paginationOpts: page })).page;
  return { t, owner, libraryId, sourceId, run, bookId, passages, page };
}

describe("import in a web client", () => {
  beforeEach(() => { vi.stubEnv("LEAFLOGUE_SYNC_KEY", KEY); });

  it("adds books, passages with their notes, and standalone notes, and desktops pull them", async () => {
    const { t, owner, libraryId, run, bookId, passages, page } = await setup();
    expect(await run([passage, standalone])).toMatchObject({ highlightsCreated: 1, notesCreated: 1, conflictsCreated: 0 });
    const books = (await owner.query(listBooks, { libraryId, paginationOpts: page })).page;
    expect(books).toMatchObject([{ title: "The Glass Orchard", status: "finished" }]);
    expect(await passages()).toMatchObject([{ text: "Every pane held a season." }]);
    const notes = (await owner.query(listNotes, { libraryId, bookId: await bookId(), paginationOpts: page })).page;
    expect(notes.map(({ markdown, origin }) => ({ markdown, origin })).sort((a, b) => a.markdown.localeCompare(b.markdown))).toEqual([
      { markdown: "Glass as time.", origin: "import" },
      { markdown: "Read again in winter.", origin: "import" },
    ]);
    // A desktop pulls everything the import wrote (pull pages are small, so read them all).
    const desktop = await t.mutation(ensureLibrary, { syncKey: KEY });
    const types = new Set<unknown>();
    let cursor = { generation: 1, afterSequence: 0 };
    for (let pageCount = 0; pageCount < 20; pageCount += 1) {
      const pulled = await t.query(pull, { libraryId: desktop.libraryId, syncKey: KEY, cursor, limit: 50 });
      for (const change of pulled.changes) if (change) types.add(change.entityType);
      if (pulled.page.isDone) break;
      cursor = pulled.page.nextCursor;
    }
    expect([...types].sort()).toEqual(["book", "highlight", "note"]);
  });

  it("skips what is unchanged and updates what the reader has not touched", async () => {
    const { run, passages } = await setup();
    await run([passage]);
    expect(await run([passage])).toMatchObject({ unchanged: 1, annotationsUpdated: 0, highlightsCreated: 0 });
    expect(await run([{ ...passage, text: "Every pane held a whole season." }])).toMatchObject({ annotationsUpdated: 1 });
    expect(await passages()).toMatchObject([{ text: "Every pane held a whole season." }]);
  });

  it("keeps a passage the reader edited as a conflict, resolvable either way", async () => {
    const { owner, libraryId, run, bookId, passages } = await setup();
    await run([passage]);
    const [current] = await passages();
    await owner.mutation(updateHighlight, { libraryId, id: current!.id, bookId: await bookId(), text: "My own wording.", expectedRevision: current!.revision });
    expect(await run([{ ...passage, text: "The source changed too." }])).toMatchObject({ conflictsCreated: 1 });
    expect(await passages()).toMatchObject([{ text: "My own wording." }]);
    const [conflict] = await owner.query(listConflicts, { libraryId });
    expect(JSON.parse(conflict!.incoming)).toMatchObject({ text: "The source changed too." });
    await owner.mutation(resolveConflict, { libraryId, conflictId: conflict!.id, resolution: "accept-incoming" });
    expect(await passages()).toMatchObject([{ text: "The source changed too." }]);
    expect(await owner.query(listConflicts, { libraryId })).toEqual([]);
    expect(await run([{ ...passage, text: "The source changed too." }])).toMatchObject({ unchanged: 1, conflictsCreated: 0 });
  });

  it("keeps the reader's version when chosen, and leaves deleted passages deleted", async () => {
    const { t, owner, libraryId, run, bookId, passages } = await setup();
    await run([passage]);
    const [current] = await passages();
    await owner.mutation(updateHighlight, { libraryId, id: current!.id, bookId: await bookId(), text: "Mine.", expectedRevision: current!.revision });
    await run([{ ...passage, text: "Theirs." }]);
    const [conflict] = await owner.query(listConflicts, { libraryId });
    await owner.mutation(resolveConflict, { libraryId, conflictId: conflict!.id, resolution: "keep-local" });
    expect(await passages()).toMatchObject([{ text: "Mine." }]);
    const [kept] = await passages();
    await owner.mutation(deleteHighlight, { libraryId, id: kept!.id, bookId: await bookId(), expectedRevision: kept!.revision });
    expect(await run([{ ...passage, text: "Theirs, revised." }])).toMatchObject({ unchanged: 1, conflictsCreated: 0, highlightsCreated: 0 });
    const rows = await t.run((ctx) => ctx.db.query("highlights").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deletedAt).toBeDefined();
  });

  it("requires books first, skips oversized records, and keeps others out", async () => {
    const { t, owner, libraryId, sourceId, run } = await setup();
    await expect(owner.mutation(importAnnotations, { libraryId, sourceId, annotations: [{ ...passage, bookProviderRecordId: "unknown" }] }))
      .rejects.toThrow("book before the annotation");
    expect(await run([{ ...passage, providerRecordId: "huge", text: "x".repeat(100_001) }])).toMatchObject({ skipped: 1, highlightsCreated: 0 });
    await expect(t.withIdentity({ tokenIdentifier: "https://host.example|stranger" }).mutation(importBooks, { libraryId, sourceId, books: [book] }))
      .rejects.toThrow("LEAFLOGUE_ACCESS_DENIED");
  });

  it("shows the imported version of an edited passage and puts it back", async () => {
    const { owner, libraryId, run, bookId, passages } = await setup();
    await run([passage]);
    const [imported] = await passages();
    expect(await owner.query(importedVersion, { libraryId, highlightId: imported!.id }))
      .toEqual({ text: "Every pane held a season.", note: "Glass as time.", location: "Chapter 3", edited: false });
    await owner.mutation(updateHighlight, { libraryId, id: imported!.id, bookId: await bookId(), text: "My wording.", expectedRevision: imported!.revision });
    expect(await owner.query(importedVersion, { libraryId, highlightId: imported!.id })).toMatchObject({ edited: true });
    await owner.mutation(resetToImported, { libraryId, highlightId: imported!.id });
    expect((await passages())[0]).toMatchObject({ text: "Every pane held a season." });
    expect(await owner.query(importedVersion, { libraryId, highlightId: imported!.id })).toMatchObject({ edited: false });
    // Importing the same record again is unchanged, not a conflict.
    expect(await run([passage])).toMatchObject({ unchanged: 1, conflictsCreated: 0 });

    const typed = "77777777-7777-4777-8777-777777777777";
    await owner.mutation(createHighlight, { libraryId, id: typed, bookId: await bookId(), text: "Typed by hand." });
    expect(await owner.query(importedVersion, { libraryId, highlightId: typed })).toBeNull();
    await expect(owner.mutation(resetToImported, { libraryId, highlightId: typed })).rejects.toThrow("no imported version");
  });
});
