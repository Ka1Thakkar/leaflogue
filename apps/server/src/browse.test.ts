import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PostgresClient } from "@leaflogue/remote";
import { PostgresLibraryMutations } from "@leaflogue/remote";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as browse from "./browse";

/** The PostgreSQL side of `browse:*`, against a real schema in PGlite. */

let pglite: PGlite;
let client: PostgresClient;
let libraryId: string;
let library: PostgresLibraryMutations;

beforeEach(async () => {
  pglite = new PGlite();
  client = {
    async connect() {},
    async end() {},
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      if (values && values.length > 0) return { rows: (await pglite.query<Row>(text, [...values])).rows };
      const results = await pglite.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as Row[] };
    },
  };
  const { prepareDatabase } = await import("./web-schema");
  await prepareDatabase({ withClient: (operation) => operation(client), close: async () => {} });
  libraryId = randomUUID();
  await client.query("INSERT INTO leaflogue.libraries (id, name) VALUES ($1, 'Test')", [libraryId]);
  library = new PostgresLibraryMutations(client, libraryId);
});

afterEach(async () => { await pglite.close(); });

const page = (numItems = 50, cursor: string | null = null) => ({ numItems, cursor });
const texts = (result: { page: { text: string }[] }) => result.page.map((passage) => passage.text);

async function shelf() {
  const orchard = randomUUID() as never;
  const atlas = randomUUID() as never;
  const shelved = randomUUID() as never;
  await library.createBook({ id: orchard, title: "The Glass Orchard", authors: ["Imogen Vale"] });
  await library.createBook({ id: atlas, title: "An Atlas of Rain", authors: ["Tobias Wren"] });
  const away = await library.createBook({ id: shelved, title: "Put Away", authors: [] });
  const first = await library.createHighlight({ bookId: orchard, text: "Every pane held a season.", noteMarkdown: "Seasons as windows." });
  await library.createHighlight({ bookId: orchard, text: "The orchard kept its own weather." });
  const third = await library.createHighlight({ bookId: atlas, text: "Rain is a map of where the sky has been." });
  const gone = await library.createHighlight({ bookId: atlas, text: "Gone tomorrow." });
  await library.createHighlight({ bookId: shelved, text: "On an archived book." });
  await library.deleteHighlight({ id: gone.id, bookId: atlas, expectedRevision: gone.revision });
  await library.setBookArchived({ id: shelved, archived: true, expectedRevision: away.revision + 1 });
  // Give the passages distinct, known times.
  const days = [["Every pane held a season.", "2026-01-02"], ["The orchard kept its own weather.", "2026-01-03"], ["Rain is a map of where the sky has been.", "2026-01-03"]];
  for (const [index, [text, day]] of days.entries()) {
    await client.query("UPDATE leaflogue.highlights SET created_at = $2::timestamptz + make_interval(mins => $3) WHERE library_id = $1 AND text = $4", [libraryId, `${day}T12:00:00Z`, index, text]);
  }
  return { orchard: orchard as string, atlas: atlas as string, shelved: shelved as string, first, third };
}

describe("browsing a PostgreSQL library", () => {
  it("lists the shelf with memberships, leaving archived books off it", async () => {
    const { orchard, shelved } = await shelf();
    const collection = randomUUID() as never;
    const tag = randomUUID() as never;
    await library.createCollection({ id: collection, name: "Favourites" });
    await library.createTag({ id: tag, name: "nature" });
    await library.setBookCollectionMembership({ bookId: orchard as never, collectionId: collection, included: true });
    await library.setBookTagMembership({ bookId: orchard as never, tagId: tag, included: true });
    const books = await browse.books(client, libraryId);
    expect(books.map((entry) => entry.title).sort()).toEqual(["An Atlas of Rain", "The Glass Orchard"]);
    expect(books.find((entry) => entry.id === orchard)).toMatchObject({ collectionIds: [collection], tagIds: [tag], highlightCount: 2, noteCount: 1 });
    expect(await browse.collections(client, libraryId)).toMatchObject([{ name: "Favourites", bookCount: 1 }]);
    expect(await browse.book(client, libraryId, shelved)).toMatchObject({ archived: true });
    expect(await browse.book(client, libraryId, randomUUID())).toBeNull();
  });

  it("orders, pages, searches, and filters passages", async () => {
    const { orchard, atlas, first } = await shelf();
    expect(texts(await browse.highlights(client, libraryId, { paginationOpts: page() }))).toEqual([
      "Every pane held a season.", "The orchard kept its own weather.", "Rain is a map of where the sky has been.",
    ]);
    expect(texts(await browse.highlights(client, libraryId, { sort: "newest", paginationOpts: page() }))[0]).toBe("Rain is a map of where the sky has been.");
    const firstPage = await browse.highlights(client, libraryId, { paginationOpts: page(2) });
    const secondPage = await browse.highlights(client, libraryId, { paginationOpts: page(2, firstPage.continueCursor) });
    expect([firstPage.isDone, secondPage.isDone, texts(secondPage)]).toEqual([false, true, ["Rain is a map of where the sky has been."]]);

    expect(texts(await browse.highlights(client, libraryId, { search: "orchard weather", paginationOpts: page() }))).toEqual(["The orchard kept its own weather."]);
    expect(texts(await browse.highlights(client, libraryId, { search: "pan", paginationOpts: page() }))).toEqual(["Every pane held a season."]);
    expect(texts(await browse.highlights(client, libraryId, { search: "rain", bookId: orchard, paginationOpts: page() }))).toEqual([]);
    expect(texts(await browse.highlights(client, libraryId, { search: "100%_", paginationOpts: page() }))).toEqual([]);

    const tag = randomUUID() as never;
    await library.createTag({ id: tag, name: "light" });
    await library.setHighlightTagMembership({ bookId: orchard as never, highlightId: first.id, tagId: tag, included: true });
    const tagged = await browse.highlights(client, libraryId, { tagId: tag, paginationOpts: page() });
    expect(tagged.page).toMatchObject([{ text: "Every pane held a season.", tags: [{ name: "light" }], notes: [{ markdown: "Seasons as windows." }] }]);
    expect(await browse.tags(client, libraryId)).toMatchObject([{ name: "light", highlightCount: 1 }]);

    expect(texts(await browse.highlights(client, libraryId, { notes: "with", paginationOpts: page() }))).toEqual(["Every pane held a season."]);
    expect(texts(await browse.highlights(client, libraryId, { notes: "without", paginationOpts: page() }))).toHaveLength(2);
    expect(texts(await browse.highlights(client, libraryId, { date: "2026-01-03", paginationOpts: page() })))
      .toEqual(["The orchard kept its own weather.", "Rain is a map of where the sky has been."]);
    expect(texts(await browse.highlights(client, libraryId, { date: "2026-01-03", bookId: atlas, paginationOpts: page() })))
      .toEqual(["Rain is a map of where the sky has been."]);
    expect(texts(await browse.highlights(client, libraryId, { date: "2026-01-03", dateKind: "imported", paginationOpts: page() }))).toEqual([]);
    expect(texts(await browse.highlights(client, libraryId, { source: "imported", paginationOpts: page() }))).toEqual([]);
    await expect(browse.highlights(client, libraryId, { date: "2026-02-30", paginationOpts: page() })).rejects.toThrow("valid calendar date");
  });

  it("finds passages by words in their notes, but not in deleted notes", async () => {
    const { atlas, third } = await shelf();
    const note = await library.createNote({ bookId: atlas as never, highlightId: third.id, markdown: "Lanterns on the hill" });
    await library.createNote({ bookId: atlas as never, highlightId: third.id, markdown: "More lanterns" });
    // A book note belongs to no passage.
    await library.createNote({ bookId: atlas as never, markdown: "lanterns everywhere" });
    expect(texts(await browse.highlights(client, libraryId, { search: "lanterns", paginationOpts: page() })))
      .toEqual(["Rain is a map of where the sky has been."]);
    expect(texts(await browse.highlights(client, libraryId, { search: "windows", paginationOpts: page() })))
      .toEqual(["Every pane held a season."]);
    await library.updateNote({ id: note.id, bookId: atlas as never, markdown: "Candles on the hill", expectedRevision: note.revision });
    expect(texts(await browse.highlights(client, libraryId, { search: "hill", paginationOpts: page() })))
      .toEqual(["Rain is a map of where the sky has been."]);
    const edited = (await browse.highlight(client, libraryId, third.id))!.notes.find((entry) => entry.id === note.id)!;
    await library.deleteNote({ id: note.id, bookId: atlas as never, expectedRevision: edited.revision });
    expect(texts(await browse.highlights(client, libraryId, { search: "hill", paginationOpts: page() }))).toEqual([]);
  });

  it("filters by an exact local day, including the hours either side of UTC midnight", async () => {
    const { orchard } = await shelf();
    const kolkata = await library.createHighlight({ bookId: orchard as never, text: "Early in Kolkata." });
    const oakland = await library.createHighlight({ bookId: orchard as never, text: "Late in Oakland." });
    // 01:30 on 3 January in India (UTC+5:30) is still 2 January in UTC;
    // 19:00 on 3 January in California (UTC-8) is already 4 January in UTC.
    await client.query("UPDATE leaflogue.highlights SET created_at = $2::timestamptz WHERE library_id = $1 AND id = $3", [libraryId, "2026-01-02T20:00:00Z", kolkata.id]);
    await client.query("UPDATE leaflogue.highlights SET created_at = $2::timestamptz WHERE library_id = $1 AND id = $3", [libraryId, "2026-01-04T03:00:00Z", oakland.id]);
    const DAY = 24 * 60 * 60 * 1000;
    const day = async (start: number) => texts(await browse.highlights(client, libraryId, { dateFrom: start, dateBefore: start + DAY, paginationOpts: page() }));
    const india = Date.UTC(2026, 0, 3) - 5.5 * 60 * 60 * 1000;
    const california = Date.UTC(2026, 0, 3) + 8 * 60 * 60 * 1000;
    expect(await day(india)).toEqual(["Early in Kolkata.", "The orchard kept its own weather.", "Rain is a map of where the sky has been."]);
    expect(await day(california)).toEqual(["The orchard kept its own weather.", "Rain is a map of where the sky has been.", "Late in Oakland."]);
    expect(await day(india + DAY)).not.toContain("Early in Kolkata.");
    // The end is excluded, and an open end reads to the last passage.
    expect(texts(await browse.highlights(client, libraryId, { dateBefore: Date.parse("2026-01-02T20:00:00Z"), paginationOpts: page() })))
      .toEqual(["Every pane held a season."]);
    expect(texts(await browse.highlights(client, libraryId, { dateFrom: Date.parse("2026-01-04T03:00:00Z"), paginationOpts: page() })))
      .toEqual(["Late in Oakland."]);
    await expect(browse.highlights(client, libraryId, { date: "2026-01-03", dateFrom: india, paginationOpts: page() })).rejects.toThrow("not both");
  });

  it("shows threads, memberships, reading history, and export pages", async () => {
    const { orchard, atlas, first, third } = await shelf();
    const thread = randomUUID() as never;
    await library.createThread({ id: thread, name: "Weather" });
    await library.setHighlightThreadMembership({ bookId: atlas as never, highlightId: third.id, threadIds: [thread], expectedHighlightRevision: third.revision });
    await library.setHighlightThreadMembership({ bookId: orchard as never, highlightId: first.id, threadIds: [thread], expectedHighlightRevision: first.revision });
    expect(await browse.threads(client, libraryId)).toMatchObject([{ name: "Weather", passageCount: 2 }]);
    expect((await browse.thread(client, libraryId, thread))?.passages.map((passage) => passage.id)).toEqual([third.id, first.id]);
    expect(await browse.highlightMemberships(client, libraryId, first.id)).toEqual({ tagIds: [], threadIds: [thread] });

    const book = await browse.book(client, libraryId, orchard);
    await library.setBookReadingStatus({ id: orchard as never, status: "finished", expectedRevision: book!.revision });
    expect(await browse.readingHistory(client, libraryId, orchard)).toMatchObject([{ status: "finished", source: "reader" }]);

    const rows = [];
    let cursor: string | null = null;
    for (let round = 0; round < 10; round += 1) {
      const result = await browse.exportPage(client, libraryId, { table: "highlights", paginationOpts: page(2, cursor) });
      rows.push(...result.records);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.deletedAt !== undefined)).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("libraryId");
    expect(typeof rows[0]!.createdAt).toBe("number");
    const [exportedBook] = (await browse.exportPage(client, libraryId, { table: "books", paginationOpts: page(50) })).records
      .filter((row) => row.id === orchard);
    expect(exportedBook).toMatchObject({ title: "The Glass Orchard", status: "finished", completedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) });
  });
});
