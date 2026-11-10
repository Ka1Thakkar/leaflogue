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
    expect(texts(await owner.query(highlights, { libraryId, date: "2026-01-03", paginationOpts: page() })))
      .toEqual(["The orchard kept its own weather.", "Rain is a map of where the sky has been."]);
    expect(texts(await owner.query(highlights, { libraryId, date: "2026-01-03", bookId: ATLAS, paginationOpts: page() })))
      .toEqual(["Rain is a map of where the sky has been."]);
    expect(texts(await owner.query(highlights, { libraryId, date: "2026-01-03", dateKind: "imported", paginationOpts: page() }))).toEqual([]);
    expect(texts(await owner.query(highlights, { libraryId, source: "imported", paginationOpts: page() }))).toEqual([]);
    await expect(owner.query(highlights, { libraryId, date: "2026-02-30", paginationOpts: page() })).rejects.toThrow("valid calendar date");
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
