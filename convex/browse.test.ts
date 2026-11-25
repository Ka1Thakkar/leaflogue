// @vitest-environment edge-runtime

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { convexModules } from "./test.setup";

const OWNER = "https://host.example|owner";
const STRANGER = "https://host.example|stranger";
type Args = Record<string, unknown>;
const m = <R = unknown>(name: string) => makeFunctionReference<"mutation", Args, R>(name);
const q = <R = unknown>(name: string) => makeFunctionReference<"query", Args, R>(name);

interface Passage { id: string; text: string; bookTitle: string; notes: { markdown: string; origin: string }[]; tags: { name: string }[]; imported: boolean; importedVersion: unknown }
interface Page { page: Passage[]; isDone: boolean; continueCursor: string }

const provisionHostOwner = m<{ libraryId: string }>("access:provisionHostOwner");
const createBook = m("runtime:createBook");
const createHighlight = m<{ id: string; revision: number }>("runtime:createHighlight");
const deleteHighlight = m("runtime:deleteHighlight");
const setBookArchived = m("runtime:setBookArchived");
const setBookReadingStatus = m("runtime:setBookReadingStatus");
const createTag = m("organizationRuntime:createTag");
const createCollection = m("organizationRuntime:createCollection");
const setHighlightTagMembership = m("organizationRuntime:setHighlightTagMembership");
const setBookTagMembership = m("organizationRuntime:setBookTagMembership");
const setBookCollectionMembership = m("organizationRuntime:setBookCollectionMembership");
const createThread = m("threadRuntime:createThread");
const setHighlightThreadMembership = m("threadRuntime:setHighlightThreadMembership");
const books = q<Array<{ id: string; title: string; collectionIds: string[]; tagIds: string[]; highlightCount: number }>>("browse:books");
const book = q<{ id: string; revision: number } | null>("browse:book");
const highlights = q<Page>("browse:highlights");
const highlight = q<Passage | null>("browse:highlight");
const memberships = q<{ tagIds: string[]; threadIds: string[] }>("browse:highlightMemberships");
const tags = q<Array<{ id: string; name: string; highlightCount: number }>>("browse:tags");
const collections = q<Array<{ id: string; name: string; bookCount: number }>>("browse:collections");
const threads = q<Array<{ id: string; name: string; passageCount: number }>>("browse:threads");
const thread = q<{ name: string; passages: Array<{ id: string; addedAt: number }> } | null>("browse:thread");
const readingHistory = q<Array<{ status: string; source: string }>>("browse:readingHistory");
const exportPage = q<{ records: Array<Record<string, unknown>>; isDone: boolean; continueCursor: string }>("browse:exportPage");

const ORCHARD = "11111111-1111-4111-8111-111111111111";
const ATLAS = "22222222-2222-4222-8222-222222222222";
const SHELVED = "33333333-3333-4333-8333-333333333333";
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const page = (numItems = 50) => ({ numItems, cursor: null });

afterEach(() => { vi.useRealTimers(); });

/** Passages written on known UTC days, so the day filters have something to find. */
async function library() {
  vi.useFakeTimers({ toFake: ["Date"] });
  const t = convexTest(schema, convexModules);
  const { libraryId } = await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER });
  const owner = t.withIdentity({ tokenIdentifier: OWNER });
  vi.setSystemTime(Date.UTC(2026, 0, 1, 9));
  await owner.mutation(createBook, { libraryId, id: ORCHARD, title: "The Glass Orchard", authors: ["Imogen Vale"] });
  await owner.mutation(createBook, { libraryId, id: ATLAS, title: "An Atlas of Rain", authors: ["Tobias Wren"] });
  await owner.mutation(createBook, { libraryId, id: SHELVED, title: "Put Away", authors: [] });
  const write = async (n: number, bookId: string, text: string, day: number, note?: string) => {
    vi.setSystemTime(Date.UTC(2026, 0, day, 12));
    return owner.mutation(createHighlight, { libraryId, id: id(n), bookId, text, ...(note ? { noteId: id(100 + n), noteMarkdown: note } : {}) });
  };
  const first = await write(1, ORCHARD, "Every pane held a season.", 2, "Seasons as windows.");
  await write(2, ORCHARD, "The orchard kept its own weather.", 3);
  const third = await write(3, ATLAS, "Rain is a map of where the sky has been.", 3);
  await write(4, ATLAS, "Gone tomorrow.", 4);
  await write(5, SHELVED, "On an archived book.", 4);
  await owner.mutation(deleteHighlight, { libraryId, id: id(4), bookId: ATLAS, expectedRevision: 1 });
  const shelved = await owner.query(book, { libraryId, bookId: SHELVED }) as { revision: number };
  await owner.mutation(setBookArchived, { libraryId, id: SHELVED, archived: true, expectedRevision: shelved.revision });
  vi.setSystemTime(Date.UTC(2026, 0, 5, 12));
  return { t, owner, libraryId, first, third };
}

const texts = (result: Page) => result.page.map((passage) => passage.text);

describe("browsing a library", () => {
  it("lists the shelf with each book's collections and tags, and leaves archived books off it", async () => {
    const { owner, libraryId } = await library();
    await owner.mutation(createCollection, { libraryId, id: id(201), name: "Favourites" });
    await owner.mutation(createTag, { libraryId, id: id(202), name: "nature" });
    await owner.mutation(setBookCollectionMembership, { libraryId, bookId: ORCHARD, collectionId: id(201), included: true });
    await owner.mutation(setBookTagMembership, { libraryId, bookId: ORCHARD, tagId: id(202), included: true });
    const shelf = await owner.query(books, { libraryId });
    expect(shelf.map((entry) => entry.title).sort()).toEqual(["An Atlas of Rain", "The Glass Orchard"]);
    expect(shelf.find((entry) => entry.id === ORCHARD)).toMatchObject({ collectionIds: [id(201)], tagIds: [id(202)], highlightCount: 2 });
    expect(await owner.query(collections, { libraryId })).toMatchObject([{ name: "Favourites", bookCount: 1 }]);
    expect(await owner.query(book, { libraryId, bookId: SHELVED })).toMatchObject({ archived: true });
    expect(await owner.query(book, { libraryId, bookId: id(999) })).toBeNull();
  });

  it("refuses readers without access", async () => {
    const { t, libraryId } = await library();
    const stranger = t.withIdentity({ tokenIdentifier: STRANGER });
    await expect(stranger.query(books, { libraryId })).rejects.toThrow();
    await expect(stranger.query(highlights, { libraryId, paginationOpts: page() })).rejects.toThrow();
  });

  it("orders passages, leaving out deleted ones and those on archived books", async () => {
    const { owner, libraryId } = await library();
    expect(texts(await owner.query(highlights, { libraryId, paginationOpts: page() }))).toEqual([
      "Every pane held a season.", "The orchard kept its own weather.", "Rain is a map of where the sky has been.",
    ]);
    expect(texts(await owner.query(highlights, { libraryId, sort: "newest", paginationOpts: page() }))[0]).toBe("Rain is a map of where the sky has been.");
    expect(texts(await owner.query(highlights, { libraryId, bookId: ATLAS, paginationOpts: page() }))).toEqual(["Rain is a map of where the sky has been."]);
    const [withNote] = (await owner.query(highlights, { libraryId, paginationOpts: page() })).page;
    expect(withNote).toMatchObject({ bookTitle: "The Glass Orchard", notes: [{ markdown: "Seasons as windows.", origin: "reader" }], imported: false, importedVersion: null });
  });

  it("pages through passages until done", async () => {
    const { owner, libraryId } = await library();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let round = 0; round < 10; round += 1) {
      const result: Page = await owner.query(highlights, { libraryId, paginationOpts: { numItems: 1, cursor } });
      seen.push(...texts(result));
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect(seen).toHaveLength(3);
  });

  it("searches, and filters by tag, notes, and the day a passage was added", async () => {
    const { owner, libraryId, first } = await library();
    expect(texts(await owner.query(highlights, { libraryId, search: "orchard weather", sort: "relevance", paginationOpts: page() })))
      .toEqual(["The orchard kept its own weather."]);
    expect(texts(await owner.query(highlights, { libraryId, search: "rain", bookId: ORCHARD, paginationOpts: page() }))).toEqual([]);

    await owner.mutation(createTag, { libraryId, id: id(301), name: "light" });
    await owner.mutation(setHighlightTagMembership, { libraryId, bookId: ORCHARD, highlightId: first.id, tagId: id(301), included: true });
    expect(texts(await owner.query(highlights, { libraryId, tagId: id(301), paginationOpts: page() }))).toEqual(["Every pane held a season."]);
    expect((await owner.query(highlights, { libraryId, tagId: id(301), paginationOpts: page() })).page[0]!.tags).toEqual([{ id: id(301), name: "light" }]);
    expect(await owner.query(tags, { libraryId })).toMatchObject([{ name: "light", highlightCount: 1 }]);

    expect(texts(await owner.query(highlights, { libraryId, notes: "with", paginationOpts: page() }))).toEqual(["Every pane held a season."]);
    expect(texts(await owner.query(highlights, { libraryId, notes: "without", paginationOpts: page() }))).toHaveLength(2);
    expect(texts(await owner.query(highlights, { libraryId, dateFrom: Date.UTC(2026, 0, 3), dateBefore: Date.UTC(2026, 0, 4), paginationOpts: page() })))
      .toEqual(["The orchard kept its own weather.", "Rain is a map of where the sky has been."]);
    expect(texts(await owner.query(highlights, { libraryId, dateFrom: Date.UTC(2026, 0, 3), dateBefore: Date.UTC(2026, 0, 4), bookId: ATLAS, paginationOpts: page() })))
      .toEqual(["Rain is a map of where the sky has been."]);
    expect(texts(await owner.query(highlights, { libraryId, dateFrom: Date.UTC(2026, 0, 3), dateBefore: Date.UTC(2026, 0, 4), dateKind: "imported", paginationOpts: page() }))).toEqual([]);
    expect(texts(await owner.query(highlights, { libraryId, source: "imported", paginationOpts: page() }))).toEqual([]);
  });

  it("shows threads with their passages, and what a passage belongs to", async () => {
    const { owner, libraryId, first, third } = await library();
    await owner.mutation(createThread, { libraryId, id: id(401), name: "Weather" });
    await owner.mutation(setHighlightThreadMembership, { libraryId, bookId: ATLAS, highlightId: third.id, threadIds: [id(401)], expectedHighlightRevision: third.revision });
    await owner.mutation(setHighlightThreadMembership, { libraryId, bookId: ORCHARD, highlightId: first.id, threadIds: [id(401)], expectedHighlightRevision: first.revision });
    expect(await owner.query(threads, { libraryId })).toMatchObject([{ name: "Weather", passageCount: 2 }]);
    const view = await owner.query(thread, { libraryId, threadId: id(401) });
    expect(view?.passages.map((passage) => passage.id)).toEqual([third.id, first.id]);
    expect(await owner.query(memberships, { libraryId, highlightId: first.id })).toEqual({ tagIds: [], threadIds: [id(401)] });
    expect(await owner.query(thread, { libraryId, threadId: id(999) })).toBeNull();
    expect(await owner.query(highlight, { libraryId, highlightId: id(4) })).toBeNull();
  });

  it("keeps reading history, and pages raw rows for statistics and export", async () => {
    const { owner, libraryId } = await library();
    const orchard = await owner.query(book, { libraryId, bookId: ORCHARD }) as { revision: number };
    await owner.mutation(setBookReadingStatus, { libraryId, id: ORCHARD, status: "reading", expectedRevision: orchard.revision });
    expect(await owner.query(readingHistory, { libraryId, bookId: ORCHARD })).toMatchObject([{ status: "reading", source: "reader" }]);

    const rows: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    for (let round = 0; round < 10; round += 1) {
      const result: { records: Array<Record<string, unknown>>; isDone: boolean; continueCursor: string } =
        await owner.query(exportPage, { libraryId, table: "highlights", paginationOpts: { numItems: 2, cursor } });
      rows.push(...result.records);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.deletedAt !== undefined)).toHaveLength(1);
    expect(Object.keys(rows[0]!)).not.toContain("libraryId");
    expect(Object.keys(rows[0]!)).not.toContain("_id");
  });
});

/** Every page of a passage query, read the way the web client reads it. */
async function allPassages(read: (cursor: string | null) => Promise<Page>): Promise<Passage[]> {
  const seen: Passage[] = [];
  let cursor: string | null = null;
  for (let round = 0; round < 50; round += 1) {
    const result = await read(cursor);
    seen.push(...result.page);
    if (result.isDone) return seen;
    cursor = result.continueCursor;
  }
  throw new Error("Paging did not finish");
}

const createNote = m<{ id: string; revision: number }>("runtime:createNote");
const updateNote = m<{ id: string; revision: number }>("runtime:updateNote");
const deleteNote = m("runtime:deleteNote");

describe("web parity with the other backends", () => {
  it("keeps deleted books from crowding live ones off the shelf", async () => {
    const { t, owner, libraryId } = await library();
    // More tombstones than the shelf bound, all sorting before a live book.
    await t.run(async (ctx) => {
      for (let n = 0; n < 2_001; n += 1) {
        await ctx.db.insert("books", {
          libraryId, id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: `Gone ${n}`, authors: [],
          status: "unread", archived: false, deletedAt: 1, highlightCount: 0, noteCount: 0, readingDataBytes: 0,
          revision: 2, createdAt: 1, updatedAt: 1,
        });
      }
    });
    const shelf = await owner.query(books, { libraryId });
    expect(shelf.map((entry) => entry.title).sort()).toEqual(["An Atlas of Rain", "The Glass Orchard"]);
  });

  it("still refuses a shelf with more than 2,000 live books", async () => {
    const { t, owner, libraryId } = await library();
    await t.run(async (ctx) => {
      for (let n = 0; n < 1_999; n += 1) {
        await ctx.db.insert("books", {
          libraryId, id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: `Live ${n}`, authors: [],
          status: "unread", archived: false, highlightCount: 0, noteCount: 0, readingDataBytes: 0,
          revision: 1, createdAt: 1, updatedAt: 1,
        });
      }
    });
    await expect(owner.query(books, { libraryId })).rejects.toThrow("too many books");
  });

  it("shows every note on a passage past fifty", async () => {
    const { owner, libraryId, first } = await library();
    for (let n = 0; n < 50; n += 1) {
      await owner.mutation(createNote, { libraryId, id: id(1_000 + n), bookId: ORCHARD, highlightId: first.id, markdown: `Note ${n}` });
    }
    // The passage was written with one note already, so it now has 51.
    const shown = await owner.query(highlight, { libraryId, highlightId: first.id });
    expect(shown?.notes).toHaveLength(51);
    const listed = (await owner.query(highlights, { libraryId, bookId: ORCHARD, paginationOpts: page() })).page
      .find((passage) => passage.id === first.id);
    expect(listed?.notes).toHaveLength(51);
  });

  it("finds passages by words in their notes, once each, and never by deleted notes", async () => {
    const { owner, libraryId, third } = await library();
    // id(1)'s note is "Seasons as windows."; give id(3) two notes that match too.
    const lantern = await owner.mutation(createNote, { libraryId, id: id(501), bookId: ATLAS, highlightId: third.id, markdown: "Windows like lanterns" });
    await owner.mutation(createNote, { libraryId, id: id(502), bookId: ATLAS, highlightId: third.id, markdown: "More windows" });
    // A book note matches but belongs to no passage.
    await owner.mutation(createNote, { libraryId, id: id(503), bookId: ORCHARD, markdown: "windows everywhere" });
    // Text and note both match: still listed once.
    await owner.mutation(createNote, { libraryId, id: id(504), bookId: ORCHARD, highlightId: id(2), markdown: "weather windows" });

    const search = (term: string, extra: Args = {}) => allPassages((cursor) =>
      owner.query(highlights, { libraryId, search: term, ...extra, paginationOpts: { numItems: 1, cursor } }));
    const found = await search("windows");
    expect(found.map((passage) => passage.id).sort()).toEqual([id(1), id(2), id(3)].sort());
    expect((await search("weather")).map((passage) => passage.id)).toEqual([id(2)]);
    expect((await search("windows", { bookId: ATLAS })).map((passage) => passage.id)).toEqual([id(3)]);

    // Only a deleted note mentions lanterns; an edit removes the other mention.
    expect((await search("lanterns")).map((passage) => passage.id)).toEqual([id(3)]);
    await owner.mutation(deleteNote, { libraryId, id: id(501), bookId: ATLAS, expectedRevision: lantern.revision });
    expect(await search("lanterns")).toEqual([]);
    const seasons = await owner.query(highlight, { libraryId, highlightId: id(1) }) as unknown as { notes: { id: string; revision: number }[] };
    await owner.mutation(updateNote, { libraryId, id: seasons.notes[0]!.id, bookId: ORCHARD, markdown: "Seasons as panes.", expectedRevision: seasons.notes[0]!.revision });
    expect((await search("windows")).map((passage) => passage.id).sort()).toEqual([id(2), id(3)].sort());
  });

  it("filters by an exact local day, including the hours before UTC midnight", async () => {
    const { owner, libraryId } = await library();
    // 01:30 on 3 January in India (UTC+5:30) is still 2 January in UTC.
    vi.setSystemTime(Date.UTC(2026, 0, 2, 20));
    await owner.mutation(createHighlight, { libraryId, id: id(601), bookId: ORCHARD, text: "Early in Kolkata." });
    // 19:00 on 3 January in California (UTC-8) is already 4 January in UTC.
    vi.setSystemTime(Date.UTC(2026, 0, 4, 3));
    await owner.mutation(createHighlight, { libraryId, id: id(602), bookId: ORCHARD, text: "Late in Oakland." });

    const day = async (start: number, args: Args = {}) => (await allPassages((cursor) => owner.query(highlights, {
      libraryId, dateFrom: start, dateBefore: start + 24 * 60 * 60 * 1000, ...args, paginationOpts: { numItems: 50, cursor },
    }))).map((passage) => passage.text);
    const india = Date.UTC(2026, 0, 3) - 5.5 * 60 * 60 * 1000;
    const california = Date.UTC(2026, 0, 3) + 8 * 60 * 60 * 1000;
    expect(await day(india)).toEqual(["Early in Kolkata.", "The orchard kept its own weather.", "Rain is a map of where the sky has been."]);
    expect(await day(india, { bookId: ATLAS })).toEqual(["Rain is a map of where the sky has been."]);
    expect(await day(india, { search: "kolkata" })).toEqual(["Early in Kolkata."]);
    expect(await day(california)).toEqual(["The orchard kept its own weather.", "Rain is a map of where the sky has been.", "Late in Oakland."]);
    expect(await day(california, { search: "kolkata" })).toEqual([]);
    // Passages just outside the span are left out.
    expect(await day(india + 24 * 60 * 60 * 1000)).not.toContain("Early in Kolkata.");

    // UTC ranges and invalid millisecond bounds use the same protocol.
    expect(texts(await owner.query(highlights, { libraryId, dateFrom: Date.UTC(2026, 0, 3), dateBefore: Date.UTC(2026, 0, 4), paginationOpts: page() })))
      .toEqual(["The orchard kept its own weather.", "Rain is a map of where the sky has been."]);
    await expect(owner.query(highlights, { libraryId, dateFrom: india, dateBefore: 0.5, paginationOpts: page() })).rejects.toThrow("whole milliseconds");
    await expect(owner.query(highlights, { libraryId, dateFrom: 0.5, paginationOpts: page() })).rejects.toThrow("whole milliseconds");
  });
});
