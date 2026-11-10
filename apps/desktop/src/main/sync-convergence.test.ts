import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializePostgres, PostgresLibraryMutations, PostgresSyncTransport, type PostgresClient } from "@leaflogue/remote";
import { LocalLibrary } from "@leaflogue/storage";
import { createSyncRunner } from "./sync-runner";

/**
 * Two desktop installations converging through one real PostgreSQL, run
 * in-process by PGlite. This is the multi-device gate that must pass before
 * sync is exposed; it exercises the real schema, replay, and change pages.
 */

function pgliteClient(database: PGlite): PostgresClient {
  return {
    async connect() {},
    async end() {},
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      if (values && values.length > 0) return { rows: (await database.query<Row>(text, [...values])).rows };
      // Migrations are multi-statement scripts, which only exec accepts.
      const results = await database.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as Row[] };
    },
  };
}

let database: PGlite;
let client: PostgresClient;
let libraryId: string;
let directory: string;
const opened: LocalLibrary[] = [];

beforeEach(async () => {
  database = new PGlite();
  client = pgliteClient(database);
  await expect(initializePostgres("pglite://memory", () => client)).resolves.toMatchObject({ initialized: true });
  libraryId = randomUUID();
  await client.query("INSERT INTO leaflogue.libraries (id, name) VALUES ($1, $2)", [libraryId, "Shared"]);
  directory = mkdtempSync(join(tmpdir(), "leaflogue-convergence-"));
});

afterEach(async () => {
  for (const library of opened.splice(0)) library.close();
  rmSync(directory, { recursive: true, force: true });
  await database.close();
});

function device(name: string): { readonly library: LocalLibrary; readonly sync: () => Promise<unknown> } {
  const library = new LocalLibrary(join(directory, `${name}.sqlite`));
  opened.push(library);
  const runner = createSyncRunner({ ledger: library, transport: new PostgresSyncTransport(client, libraryId) });
  return {
    library,
    sync: async () => {
      const result = await runner.run();
      expect(result).toMatchObject({ status: "complete" });
      return result;
    },
  };
}

function reading(library: LocalLibrary) {
  return library.listBooks().map((book) => {
    const contents = library.getBookContents(book.id)!;
    return {
      title: book.title,
      highlights: contents.highlights.map((highlight) => ({
        id: highlight.id,
        text: highlight.text,
        notes: highlight.notes.map((note) => ({ id: note.id, markdown: note.markdown })),
      })),
      standaloneNotes: contents.standaloneNotes.map((note) => ({ id: note.id, markdown: note.markdown })),
    };
  }).sort((first, second) => first.title.localeCompare(second.title));
}

function organization(library: LocalLibrary) {
  return {
    collections: library.listCollections().map(({ name, description, bookCount }) => ({ name, description, bookCount })),
    tags: library.listTags().map(({ name, color, bookCount, highlightCount }) => ({ name, color, bookCount, highlightCount })),
    books: library.listBooks().map((book) => ({
      title: book.title,
      organization: library.getBookOrganization(book.id),
    })).sort((first, second) => first.title.localeCompare(second.title)),
  };
}

describe("two-device sync convergence through PostgreSQL", () => {
  it("brings web-client edits, including deletions, to a desktop", async () => {
    const web = new PostgresLibraryMutations(client, libraryId);
    const bookId = randomUUID();
    await web.createBook({ id: bookId as never, title: "Notes on Tidewater", authors: ["Ada Morrow"] });
    const highlight = await web.createHighlight({ bookId: bookId as never, text: "The tide keeps its own calendar." });
    const desktop = device("desktop");
    await desktop.sync();
    expect(reading(desktop.library)).toMatchObject([{ title: "Notes on Tidewater", highlights: [{ text: "The tide keeps its own calendar." }] }]);

    await web.deleteHighlight({ id: highlight.id, bookId: bookId as never, expectedRevision: highlight.revision });
    await desktop.sync();
    expect(reading(desktop.library)).toMatchObject([{ title: "Notes on Tidewater", highlights: [] }]);
  });

  it("serializes interactive organization names while allowing synced same-name IDs", async () => {
    const first = new PostgresLibraryMutations(pgliteClient(database), libraryId);
    const second = new PostgresLibraryMutations(pgliteClient(database), libraryId);
    const [left, right] = await Promise.allSettled([
      first.createCollection({ id: randomUUID() as never, name: " Favourites " }),
      second.createCollection({ id: randomUUID() as never, name: "favourites" }),
    ]);
    expect([left.status, right.status].sort()).toEqual(["fulfilled", "rejected"]);

    const firstTag = await first.createTag({ id: randomUUID() as never, name: "Architecture" });
    const secondTag = await second.createTag({ id: randomUUID() as never, name: "Structure" });
    const renamed = await Promise.allSettled([
      first.updateTag({ id: firstTag.id, name: "Shared", expectedRevision: firstTag.revision }),
      second.updateTag({ id: secondTag.id, name: " shared ", expectedRevision: secondTag.revision }),
    ]);
    expect(renamed.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("rejects a PostgreSQL merge whose organization union cannot be synchronized", async () => {
    const sourceBookId = randomUUID();
    const targetBookId = randomUUID();
    await client.query(`
      INSERT INTO leaflogue.books (library_id, id, title, revision, updated_at)
      VALUES ($1, $2, 'Source', 1, now()), ($1, $3, 'Target', 1, now())
    `, [libraryId, sourceBookId, targetBookId]);
    const tagIds = Array.from({ length: 1_001 }, () => randomUUID());
    await client.query(`
      INSERT INTO leaflogue.tags
        (library_id, id, name, normalized_name, revision, updated_at)
      SELECT $1, ids.id, 'Tag ' || ids.ordinality, 'tag ' || ids.ordinality, 1, now()
      FROM unnest($2::uuid[]) WITH ORDINALITY AS ids(id, ordinality)
    `, [libraryId, tagIds]);
    await client.query(`
      INSERT INTO leaflogue.book_tags (library_id, tag_id, book_id)
      SELECT $1, unnest($2::uuid[]), $3
    `, [libraryId, tagIds.slice(0, 500), sourceBookId]);
    await client.query(`
      INSERT INTO leaflogue.book_tags (library_id, tag_id, book_id)
      SELECT $1, unnest($2::uuid[]), $3
    `, [libraryId, tagIds.slice(500), targetBookId]);

    await expect(new PostgresLibraryMutations(client, libraryId).mergeBooks({
      sourceBookId: sourceBookId as never,
      targetBookId: targetBookId as never,
      expectedSourceRevision: 1,
      expectedTargetRevision: 1,
    })).rejects.toThrow("merged book can belong to at most 1000 tags");
    await expect(client.query<{ archived: boolean; revision: number }>(`
      SELECT archived, revision FROM leaflogue.books WHERE library_id = $1 ORDER BY title
    `, [libraryId])).resolves.toMatchObject({ rows: [
      { archived: false, revision: 1 },
      { archived: false, revision: 1 },
    ] });
  });

  it("brings a second installation up to date and keeps each device's identity and cursor", async () => {
    const first = device("first");
    const second = device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    const highlight = first.library.createHighlight({ bookId: book.id, text: "Every room of the House keeps its weather.", noteMarkdown: "Tides" });
    first.library.createNote({ bookId: book.id, markdown: "A note about the whole book" });
    const collection = first.library.createCollection({ name: "Labyrinths", description: "Impossible places" });
    const tag = first.library.createTag({ name: "Favourite", color: "#eb6f92" });
    first.library.setBookCollectionMembership({ bookId: book.id, collectionId: collection.id, included: true });
    first.library.setBookTagMembership({ bookId: book.id, tagId: tag.id, included: true });
    first.library.setHighlightTagMembership({ bookId: book.id, highlightId: highlight.id, tagId: tag.id, included: true });
    await first.sync();

    second.library.createBook({ title: "Jonathan Strange & Mr Norrell" });
    await second.sync();
    await first.sync();

    expect(reading(second.library)).toEqual(reading(first.library));
    expect(organization(second.library)).toEqual(organization(first.library));
    expect(second.library.listCollections()).toMatchObject([{ name: "Labyrinths", bookCount: 1 }]);
    expect(second.library.listTags()).toMatchObject([{ name: "Favourite", bookCount: 1, highlightCount: 1 }]);
    expect(reading(first.library).map(({ title }) => title)).toEqual(["Jonathan Strange & Mr Norrell", "Piranesi"]);
    expect(first.library.getSyncState().deviceId).not.toBe(second.library.getSyncState().deviceId);
    expect(first.library.getSyncState().remoteCursor).toEqual(second.library.getSyncState().remoteCursor);
    expect(first.library.listPendingSyncChanges()).toEqual([]);
    expect(second.library.listPendingSyncChanges()).toEqual([]);

    const [secondCollection] = second.library.listCollections();
    const [secondTag] = second.library.listTags();
    second.library.deleteCollection({ id: secondCollection!.id, expectedRevision: secondCollection!.revision });
    second.library.deleteTag({ id: secondTag!.id, expectedRevision: secondTag!.revision });
    await second.sync();
    await first.sync();
    expect(first.library.listCollections()).toEqual([]);
    expect(first.library.listTags()).toEqual([]);
    expect(first.library.getBookOrganization(book.id)).toMatchObject({ collectionIds: [], tagIds: [], highlightTags: [] });

    // Delivering and pulling again changes nothing on either side.
    const before = reading(first.library);
    await first.sync();
    await second.sync();
    expect(reading(first.library)).toEqual(before);
    expect(reading(second.library)).toEqual(before);
  });

  it("syncs threads and passage membership, keeps same-name threads distinct, and never deletes passages with a thread", async () => {
    const first = device("first");
    const second = device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    const highlight = first.library.createHighlight({ bookId: book.id, text: "The House" });
    const thread = first.library.createThread({ name: "Architecture", description: "Halls and tides" });
    first.library.setHighlightThreadMembership({
      bookId: book.id, highlightId: highlight.id, threadIds: [thread.id], expectedHighlightRevision: highlight.revision,
    });
    await first.sync();
    await second.sync();
    expect(second.library.listThreads()).toMatchObject([{ id: thread.id, name: "Architecture", description: "Halls and tides", passageCount: 1 }]);
    expect(second.library.getHighlightThreadIds(book.id, highlight.id)).toEqual([thread.id]);

    expect(() => second.library.createThread({ name: "architecture" })).toThrow("already in use");
    // Created offline on both desktops before either syncs.
    first.library.createThread({ name: "Tides" });
    second.library.createThread({ name: "tides" });
    await second.sync();
    await first.sync();
    await second.sync();
    const names = (library: LocalLibrary) => library.listThreads().map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
    expect(names(first.library)).toHaveLength(3);
    expect(names(second.library)).toEqual(names(first.library));

    const [shared] = second.library.listThreads().filter(({ id }) => id === thread.id);
    second.library.deleteThread({ id: thread.id, expectedRevision: shared!.revision });
    await second.sync();
    await first.sync();
    expect(first.library.listThreads().some(({ id }) => id === thread.id)).toBe(false);
    expect(first.library.getHighlightThreadIds(book.id, highlight.id)).toEqual([]);
    expect(reading(first.library)[0]!.highlights.map(({ text }) => text)).toEqual(["The House"]);
    expect(first.library.listPendingSyncChanges()).toEqual([]);
  });

  it("keeps every device's reading-status history, including concurrent offline changes and merges", async () => {
    const first = device("first");
    const second = device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    const other = first.library.createBook({ title: "Piranesi (duplicate)" });
    const current = first.library.setBookReadingStatus({ id: book.id, status: "reading", expectedRevision: book.revision }).book;
    first.library.setBookReadingStatus({ id: other.id, status: "paused", expectedRevision: other.revision });
    await first.sync();
    await second.sync();
    const history = (library: LocalLibrary, id: string) =>
      library.listReadingStatusHistory(id as never).map(({ id: eventId, status }) => ({ eventId, status })).sort((a, b) => a.eventId.localeCompare(b.eventId));
    expect(history(second.library, book.id)).toEqual(history(first.library, book.id));

    // Both devices change status while offline; the book converges on one
    // status, and both changes stay in the history everywhere.
    first.library.setBookReadingStatus({ id: book.id, status: "finished", expectedRevision: current.revision });
    const onSecond = second.library.getBook(book.id)!;
    second.library.setBookReadingStatus({ id: book.id, status: "paused", expectedRevision: onSecond.revision });
    await first.sync();
    await second.sync();
    await first.sync();
    expect(history(first.library, book.id).map(({ status }) => status).sort()).toEqual(["finished", "paused", "reading"]);
    expect(history(second.library, book.id)).toEqual(history(first.library, book.id));
    expect(second.library.getBook(book.id)!.status).toBe(first.library.getBook(book.id)!.status);

    const target = first.library.getBook(book.id)!;
    const source = first.library.getBook(other.id)!;
    first.library.mergeBooks({ sourceBookId: other.id, targetBookId: book.id,
      expectedSourceRevision: source.revision, expectedTargetRevision: target.revision });
    await first.sync();
    await second.sync();
    expect(history(second.library, book.id)).toEqual(history(first.library, book.id));
    expect(history(second.library, book.id).map(({ status }) => status)).toContain("paused");

    const fresh = device("fresh");
    await fresh.sync();
    expect(history(fresh.library, book.id)).toEqual(history(first.library, book.id));
  });

  it("settles two devices' offline daily picks on the earlier one and shares later reselection", async () => {
    const first = device("first");
    const second = device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    for (const text of ["One", "Two", "Three"]) first.library.createHighlight({ bookId: book.id, text });
    await first.sync();
    await second.sync();

    const earlier = first.library.ensureDailyHighlight({ timezone: "UTC" })!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = second.library.ensureDailyHighlight({ timezone: "UTC" })!;
    expect(later.selection.id).not.toBe(earlier.selection.id);
    await second.sync();
    await first.sync();
    await second.sync();
    const picks = (library: LocalLibrary) => library.listDailySelections().map(({ id, highlightId }) => ({ id, highlightId }));
    expect(picks(first.library)).toEqual([{ id: earlier.selection.id, highlightId: earlier.selection.highlightId }]);
    expect(picks(second.library)).toEqual(picks(first.library));

    const another = second.library.ensureDailyHighlight({ timezone: "UTC", another: true })!;
    expect(another.selection.id).toBe(earlier.selection.id);
    await second.sync();
    await first.sync();
    expect(first.library.getDailyHighlight("UTC")?.selection).toMatchObject({ id: earlier.selection.id, highlightId: another.selection.highlightId });
    expect(first.library.listPendingSyncChanges()).toEqual([]);
    expect(second.library.listPendingSyncChanges()).toEqual([]);

    const fresh = device("fresh");
    await fresh.sync();
    expect(picks(fresh.library)).toEqual(picks(first.library));
  });

  it("converges after concurrent offline edits and keeps the losing note for review", async () => {
    const first = device("first");
    const second = device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    const note = first.library.createNote({ bookId: book.id, markdown: "Shared start" });
    await first.sync();
    await second.sync();

    first.library.updateNote({ id: note.id, bookId: book.id, expectedRevision: note.revision, markdown: "Written on the first device" });
    const onSecond = second.library.getBookContents(book.id)!.standaloneNotes[0]!;
    second.library.updateNote({ id: onSecond.id, bookId: book.id, expectedRevision: onSecond.revision, markdown: "Written on the second device" });
    await first.sync();
    await second.sync();
    await first.sync();

    expect(reading(first.library)).toEqual(reading(second.library));
    const kept = reading(first.library)[0]!.standaloneNotes[0]!.markdown;
    const lost = kept === "Written on the first device" ? "Written on the second device" : "Written on the first device";
    const preserved = [first.library, second.library].flatMap((library) => library.listSyncConflicts().conflicts);
    expect(preserved.map((conflict) => conflict.preservedBody)).toContain(lost);
    expect(preserved.every((conflict) => conflict.currentBody === kept)).toBe(true);
  });

  it("preserves concurrent same-name collections and tags as distinct records", async () => {
    const first = device("first");
    const second = device("second");
    await first.sync();
    await second.sync();

    first.library.createCollection({ name: "Favourites" });
    second.library.createCollection({ name: "favourites" });
    first.library.createTag({ name: "Architecture" });
    second.library.createTag({ name: "ARCHITECTURE" });
    await first.sync();
    await second.sync();
    await first.sync();

    expect(first.library.listCollections().map(({ name }) => name.toLowerCase())).toEqual(["favourites", "favourites"]);
    expect(second.library.listCollections().map(({ id, name, revision }) => ({ id, name, revision })))
      .toEqual(first.library.listCollections().map(({ id, name, revision }) => ({ id, name, revision })));
    expect(first.library.listTags().map(({ name }) => name.toLowerCase())).toEqual(["architecture", "architecture"]);
    expect(second.library.listTags().map(({ id, name, revision }) => ({ id, name, revision })))
      .toEqual(first.library.listTags().map(({ id, name, revision }) => ({ id, name, revision })));
  });

  it("lets a deletion win over a concurrent edit everywhere without losing the edit", async () => {
    const first = device("first");
    const second = device("second");
    const book = first.library.createBook({ title: "Piranesi" });
    const highlight = first.library.createHighlight({ bookId: book.id, text: "The House" });
    await first.sync();
    await second.sync();

    first.library.deleteHighlight({ id: highlight.id, bookId: book.id, expectedRevision: highlight.revision });
    const onSecond = second.library.getBookContents(book.id)!.highlights[0]!;
    second.library.updateHighlight({ id: onSecond.id, bookId: book.id, text: "The House, revised", expectedRevision: onSecond.revision });
    await second.sync();
    await first.sync();
    await second.sync();

    expect(reading(first.library)[0]!.highlights).toEqual([]);
    expect(reading(second.library)[0]!.highlights).toEqual([]);
    const preserved = [first.library, second.library].flatMap((library) => library.listSyncConflicts().conflicts);
    expect(preserved).toEqual([expect.objectContaining({ kind: "highlight", preservedBody: "The House, revised", restore: "copy" })]);

    // Restoring on the device that holds it syncs as a new passage everywhere.
    const holder = [first, second].find(({ library }) => library.listSyncConflicts().total === 1)!;
    const [conflict] = holder.library.listSyncConflicts().conflicts;
    expect(holder.library.resolveSyncConflict({ id: conflict!.id, resolution: "restore", expectedRevision: conflict!.currentRevision })).toBe(true);
    await holder.sync();
    await first.sync();
    await second.sync();
    expect(reading(first.library)[0]!.highlights.map(({ text }) => text)).toEqual(["The House, revised"]);
    expect(reading(second.library)).toEqual(reading(first.library));
  });

  it("resumes cleanly after the connection drops part-way through a delivery", async () => {
    const first = device("first");
    const book = first.library.createBook({ title: "Piranesi" });
    for (const text of ["One", "Two", "Three", "Four"]) first.library.createHighlight({ bookId: book.id, text });
    const queued = first.library.listPendingSyncChanges().length;
    let remaining = 12;
    let dropped = false;
    const flaky: PostgresClient = {
      ...client,
      query: async (text, values) => {
        if (remaining-- <= 0) {
          // A server aborts the open transaction when its connection drops.
          if (!dropped) await client.query("ROLLBACK");
          dropped = true;
          throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
        }
        return client.query(text, values);
      },
    };
    const interrupted = await createSyncRunner({ ledger: first.library, transport: new PostgresSyncTransport(flaky, libraryId) }).run();
    // Some changes landed before the drop and were acknowledged; the rest wait.
    expect(interrupted).toMatchObject({ status: "failed", problem: { phase: "push", kind: "unreachable" } });
    expect(first.library.listPendingSyncChanges().length).toBeGreaterThan(0);
    expect(first.library.listPendingSyncChanges().length).toBeLessThan(queued);
    expect((interrupted as { pushed: number }).pushed).toBe(queued - first.library.listPendingSyncChanges().length);

    await first.sync();
    expect(first.library.listPendingSyncChanges()).toEqual([]);
    const second = device("second");
    await second.sync();
    expect(reading(second.library)[0]!.highlights.map(({ text }) => text).sort()).toEqual(["Four", "One", "Three", "Two"]);
  });

  it("repopulates a replaced provider when only a receiving replica survives", async () => {
    const first = device("first");
    const book = first.library.createBook({ title: "Piranesi" });
    const highlight = first.library.createHighlight({ bookId: book.id, text: "The House" });
    const collection = first.library.createCollection({ name: "Labyrinths" });
    const tag = first.library.createTag({ name: "Architecture" });
    first.library.setBookCollectionMembership({ bookId: book.id, collectionId: collection.id, included: true });
    first.library.setHighlightTagMembership({ bookId: book.id, highlightId: highlight.id, tagId: tag.id, included: true });
    await first.sync();
    const receiver = device("receiver");
    await receiver.sync();
    expect(reading(receiver.library)).toEqual(reading(first.library));

    // The operator restores an empty database: the old cursor is now ahead of it.
    await client.query("TRUNCATE leaflogue.libraries CASCADE");
    await client.query("INSERT INTO leaflogue.libraries (id, name) VALUES ($1, $2)", [libraryId, "Shared"]);
    // The originating installation is unavailable. The receiver is the only
    // source from which the provider can recover.
    await receiver.sync();

    const fresh = device("fresh");
    await fresh.sync();
    expect(reading(fresh.library)).toEqual(reading(receiver.library));
    expect(organization(fresh.library)).toEqual(organization(receiver.library));
  });
});
