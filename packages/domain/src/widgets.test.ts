import { describe, expect, it } from "vitest";
import type { BookId, CustomWidget, HighlightId, NoteId } from "@leaflogue/contracts";
import { customWidgetFile, customWidgetIdFor, evaluateWidget, parseCustomWidget, parseCustomWidgetFile, parseCustomWidgets, sameRecipe, widgetDataset, type WidgetDataset } from "./widgets";

const piranesi = "b1" as BookId;
const strange = "b2" as BookId;
const archived = "b3" as BookId;
const unread = "b4" as BookId;
const at = (iso: string) => Date.parse(iso);

const dataset: WidgetDataset = {
  books: [
    { id: piranesi, title: "Piranesi", authors: ["Susanna Clarke"], publisher: "Bloomsbury", language: "en", status: "reading", archived: false },
    { id: strange, title: "Jonathan Strange & Mr Norrell", authors: ["Susanna Clarke"], series: "Clarke", language: "EN", status: "finished", finishedYear: 2023, archived: false },
    { id: archived, title: "The Ladies of Grace Adieu", authors: ["Susanna Clarke", "Charles Vess"], status: "finished", finishedYear: 2021, archived: true },
    { id: unread, title: "A Wizard of Earthsea", authors: ["Ursula K. Le Guin"], status: "unread", archived: false },
  ],
  passages: [
    // Monday 2025-03-03 21:30 UTC, highlighted on the device.
    { id: "h1" as HighlightId, bookId: piranesi, text: "x".repeat(80), at: at("2025-03-03T21:30:00Z"), timed: true, notes: 1, tags: ["Favourite", "house"], threads: ["Tides"] },
    // Tuesday 2025-03-04 08:00 UTC, highlighted on the device.
    { id: "h2" as HighlightId, bookId: piranesi, text: "y".repeat(250), at: at("2025-03-04T08:00:00Z"), timed: true, notes: 0, tags: ["favourite"], threads: [] },
    // Added on import: the day counts, the hour does not.
    { id: "h3" as HighlightId, bookId: strange, text: "z".repeat(700), at: at("2024-12-31T23:30:00Z"), timed: false, notes: 0, tags: [], threads: [] },
    { id: "h4" as HighlightId, bookId: archived, text: "w".repeat(400), at: at("2022-06-01T12:00:00Z"), timed: true, notes: 2, tags: [], threads: ["Tides"] },
  ],
  notes: [
    { id: "n1" as NoteId, bookId: piranesi, highlightId: "h1" as HighlightId, text: "The House is kind.", at: at("2025-03-03T21:30:00Z"), timed: true },
    { id: "n2" as NoteId, bookId: strange, text: "Reread the footnotes.", at: at("2025-05-10T10:00:00Z"), timed: true },
  ],
};

const UTC = { timeZone: "UTC", now: at("2025-07-01T00:00:00Z") };

function widget(recipe: Partial<CustomWidget>): CustomWidget {
  return parseCustomWidget({ id: "test", version: 1, title: "Test", count: "passages", show: "number", ...recipe });
}

describe("evaluating a custom widget", () => {
  it("counts passages, books on the shelf, and notes", () => {
    expect(evaluateWidget(dataset, widget({}), UTC)).toEqual({ kind: "number", value: 4 });
    expect(evaluateWidget(dataset, widget({ count: "books" }), UTC)).toEqual({ kind: "number", value: 3 });
    expect(evaluateWidget(dataset, widget({ count: "notes" }), UTC)).toEqual({ kind: "number", value: 2 });
  });

  it("filters by tag without minding case, and by what a passage is not", () => {
    expect(evaluateWidget(dataset, widget({ where: [{ field: "tag", is: "FAVOURITE" }] }), UTC)).toEqual({ kind: "number", value: 2 });
    expect(evaluateWidget(dataset, widget({ where: [{ field: "thread", isNot: "tides" }] }), UTC)).toEqual({ kind: "number", value: 2 });
    expect(evaluateWidget(dataset, widget({ where: [{ field: "has-note", is: "yes" }, { field: "author", is: "Charles Vess" }] }), UTC)).toEqual({ kind: "number", value: 1 });
  });

  it("matches relative years against the reader's own year", () => {
    expect(evaluateWidget(dataset, widget({ where: [{ field: "year", is: "this-year" }] }), UTC)).toEqual({ kind: "number", value: 2 });
    expect(evaluateWidget(dataset, widget({ where: [{ field: "year", is: "last-year" }] }), UTC)).toEqual({ kind: "number", value: 1 });
    expect(evaluateWidget(dataset, widget({ count: "books", where: [{ field: "finished-year", is: "2023" }] }), UTC)).toEqual({ kind: "number", value: 1 });
  });

  it("finds a book by its title as well as its ID", () => {
    expect(evaluateWidget(dataset, widget({ where: [{ field: "book", is: "piranesi" }] }), UTC)).toEqual({ kind: "number", value: 2 });
  });

  it("groups by weekday with every day shown, in the reader's time zone", () => {
    const utc = evaluateWidget(dataset, widget({ show: "bars", groupBy: "weekday" }), UTC);
    expect(utc.kind === "groups" && utc.groups.map(({ key, value }) => `${key}:${value}`)).toEqual(["mon:1", "tue:2", "wed:1", "thu:0", "fri:0", "sat:0", "sun:0"]);
    // 21:30 UTC on a Monday is already Tuesday in Tokyo, and 23:30 on New Year's Eve is 2025.
    const tokyo = evaluateWidget(dataset, widget({ show: "bars", groupBy: "weekday" }), { ...UTC, timeZone: "Asia/Tokyo" });
    expect(tokyo.kind === "groups" && tokyo.groups.find(({ key }) => key === "tue")?.value).toBe(2);
    const years = evaluateWidget(dataset, widget({ show: "bars", groupBy: "year" }), { ...UTC, timeZone: "Asia/Tokyo" });
    expect(years.kind === "groups" && years.groups.map(({ key, value }) => `${key}:${value}`)).toEqual(["2022:1", "2023:0", "2024:0", "2025:3"]);
  });

  it("counts hours only where the device recorded a time, and says how many had none", () => {
    const result = evaluateWidget(dataset, widget({ show: "bars", groupBy: "hour" }), UTC);
    expect(result.kind).toBe("groups");
    if (result.kind !== "groups") return;
    expect(result.groups).toHaveLength(24);
    expect(result.groups[21]).toEqual({ key: "21", label: "21", value: 1 });
    expect(result.missing).toBe(1);
    expect(result.total).toBe(4);
  });

  it("counts a passage once for each of its authors and tags", () => {
    const authors = evaluateWidget(dataset, widget({ show: "ranked", groupBy: "author" }), UTC);
    expect(authors).toEqual({ kind: "groups", groups: [{ key: "susanna clarke", label: "Susanna Clarke", value: 4 }, { key: "charles vess", label: "Charles Vess", value: 1 }], total: 4, missing: 0, hidden: 0 });
    const tags = evaluateWidget(dataset, widget({ show: "ranked", groupBy: "tag" }), UTC);
    expect(tags.kind === "groups" && tags.groups.map(({ label, value }) => `${label}:${value}`)).toEqual(["Favourite:2", "house:1"]);
    expect(tags.kind === "groups" && tags.missing).toBe(2);
  });

  it("merges names that differ only in case, and keeps the first spelling", () => {
    const result = evaluateWidget(dataset, widget({ count: "books", show: "ranked", groupBy: "language" }), UTC);
    expect(result.kind === "groups" && result.groups).toEqual([{ key: "en", label: "en", value: 2 }]);
  });

  it("sorts, limits, and keeps the latest years in their own order", () => {
    const ranked = evaluateWidget(dataset, widget({ show: "ranked", groupBy: "length", limit: 2 }), UTC);
    expect(ranked.kind === "groups" && ranked.groups.map(({ key }) => key)).toEqual(["short", "medium"]);
    expect(ranked.kind === "groups" && ranked.hidden).toBe(2);
    const alphabetical = evaluateWidget(dataset, widget({ show: "ranked", groupBy: "book", sort: "label" }), UTC);
    expect(alphabetical.kind === "groups" && alphabetical.groups.map(({ label }) => label)).toEqual(["Jonathan Strange & Mr Norrell", "Piranesi", "The Ladies of Grace Adieu"]);
    const years = evaluateWidget(dataset, widget({ show: "bars", groupBy: "year", limit: 2 }), UTC);
    expect(years.kind === "groups" && years.groups.map(({ key }) => key)).toEqual(["2024", "2025"]);
  });

  it("groups books by status and finish year, leaving out unknown years", () => {
    const status = evaluateWidget(dataset, widget({ count: "books", show: "bars", groupBy: "status" }), UTC);
    expect(status.kind === "groups" && status.groups.map(({ value }) => value)).toEqual([1, 1, 1, 0]);
    const finished = evaluateWidget(dataset, widget({ count: "books", show: "bars", groupBy: "finished-year" }), UTC);
    expect(finished.kind === "groups" && finished.groups).toEqual([{ key: "2023", label: "2023", value: 1 }]);
  });

  it("draws a calendar of local days", () => {
    expect(evaluateWidget(dataset, widget({ show: "heatmap", where: [{ field: "book", is: "Piranesi" }] }), { ...UTC, timeZone: "Asia/Tokyo" })).toEqual({
      kind: "days",
      days: [{ day: "2025-03-04", value: 2 }],
      total: 2,
    });
  });

  it("lists the newest passages and notes, and books by title", () => {
    const passages = evaluateWidget(dataset, widget({ show: "list", limit: 2 }), UTC);
    expect(passages.kind === "items" && passages.items.map((item) => item.kind === "passage" && item.highlightId)).toEqual(["h2", "h1"]);
    expect(passages.kind === "items" && passages.total).toBe(4);
    const notes = evaluateWidget(dataset, widget({ count: "notes", show: "list" }), UTC);
    expect(notes.kind === "items" && notes.items[0]).toEqual({ kind: "note", bookId: strange, title: "Jonathan Strange & Mr Norrell", text: "Reread the footnotes.", day: "2025-05-10" });
    const books = evaluateWidget(dataset, widget({ count: "books", show: "list" }), UTC);
    expect(books.kind === "items" && books.items.map((item) => item.kind === "book" && item.title)).toEqual(["A Wizard of Earthsea", "Jonathan Strange & Mr Norrell", "Piranesi"]);
  });

  it("shortens long passages in a list", () => {
    const long = { ...dataset, passages: [{ ...dataset.passages[0]!, text: "word ".repeat(100) }] };
    const result = evaluateWidget(long, widget({ show: "list" }), UTC);
    expect(result.kind === "items" && result.items[0]?.kind === "passage" && result.items[0].text.endsWith("…")).toBe(true);
  });

  it("refuses an unknown time zone", () => {
    expect(() => evaluateWidget(dataset, widget({}), { timeZone: "Mars/Olympus" })).toThrow("Time zone is invalid");
  });
});

describe("validating a custom widget", () => {
  const valid = { id: "favourite-tags", version: 1, title: "  Favourites by weekday ", count: "passages", groupBy: "weekday", where: [{ field: "tag", is: "favourite" }], show: "bars", limit: 7, sort: "label" };

  it("accepts a full recipe and trims its text", () => {
    expect(parseCustomWidget(valid)).toEqual({ ...valid, title: "Favourites by weekday" });
  });

  it.each([
    [{ ...valid, script: "alert(1)" }, "unknown fields: script"],
    [{ ...valid, version: 2 }, "newer Leaflogue"],
    [{ ...valid, id: "Has Spaces" }, "ID must be"],
    [{ ...valid, id: "x".repeat(49) }, "ID must be"],
    [{ ...valid, title: "" }, "title is empty"],
    [{ ...valid, title: "x".repeat(61) }, "longer than 60"],
    [{ ...valid, title: "Sneaky‮txt" }, "control characters"],
    [{ ...valid, count: "words" }, "counts is not one of"],
    [{ ...valid, show: "pie" }, "chart is not one of"],
    [{ ...valid, groupBy: undefined }, "needs something to group by"],
    [{ ...valid, show: "number" }, "is not grouped"],
    [{ ...valid, count: "books" }, "Books cannot be grouped by weekday"],
    [{ ...valid, groupBy: "colour" }, "grouping is not one of"],
    [{ ...valid, where: [{ field: "tag" }] }, "exactly one of is or isNot"],
    [{ ...valid, where: [{ field: "tag", is: "a", isNot: "b" }] }, "exactly one of is or isNot"],
    [{ ...valid, where: [{ field: "tag", is: "a", or: "b" }] }, "unknown fields"],
    [{ ...valid, where: [{ field: "weekday", is: "funday" }] }, "not one of mon"],
    [{ ...valid, where: [{ field: "year", is: "next-year" }] }, "must be a year"],
    [{ ...valid, where: [{ field: "tag", is: "x".repeat(101) }] }, "longer than 100"],
    [{ ...valid, where: Array.from({ length: 7 }, () => ({ field: "tag", is: "a" })) }, "more than 6 filters"],
    [{ ...valid, limit: 0 }, "from 1 to 50"],
    [{ ...valid, limit: 2.5 }, "from 1 to 50"],
    [{ ...valid, sort: "random" }, "sort is not one of"],
    [{ ...valid, show: "heatmap", groupBy: undefined, sort: undefined, limit: undefined, count: "books", where: undefined }, "no day"],
    [{ ...valid, show: "list", groupBy: undefined, sort: "count" }, "has no sort"],
    [{ ...valid, show: "number", groupBy: undefined, sort: undefined }, "has no limit"],
    [["not", "an", "object"], "must be an object"],
  ])("refuses %j", (input, message) => {
    expect(() => parseCustomWidget(input)).toThrow(message);
  });

  it("keeps a list of widgets free of repeats and within the limit", () => {
    const one = parseCustomWidget(valid);
    expect(parseCustomWidgets([one])).toEqual([one]);
    expect(() => parseCustomWidgets([one, one])).toThrow('repeats the ID "favourite-tags"');
    expect(() => parseCustomWidgets(Array.from({ length: 25 }, (_, index) => ({ ...one, id: `w${index}` })))).toThrow("more than 24");
    expect(() => parseCustomWidgets([{ ...one, show: "pie" }])).toThrow("Custom widget 1: A widget chart");
  });

  it("reads and writes widget files", () => {
    const file = customWidgetFile(parseCustomWidget(valid));
    expect(file.format).toBe("leaflogue-widget");
    expect(parseCustomWidgetFile(JSON.parse(JSON.stringify(file)))).toEqual(file.widget);
    expect(() => parseCustomWidgetFile({ widget: file.widget })).toThrow("not a Leaflogue widget file");
    expect(() => parseCustomWidgetFile({ ...file, run: "code" })).toThrow("unknown fields");
  });

  it("makes IDs from titles and compares recipes without them", () => {
    expect(customWidgetIdFor("Passages by tag!", [])).toBe("passages-by-tag");
    expect(customWidgetIdFor("Passages by tag", ["passages-by-tag", "passages-by-tag-2"])).toBe("passages-by-tag-3");
    expect(customWidgetIdFor("✨", [])).toBe("widget");
    const one = parseCustomWidget(valid);
    expect(sameRecipe(one, { ...one, id: "other" })).toBe(true);
    expect(sameRecipe(one, { ...one, limit: 3 })).toBe(false);
  });
});

describe("the widget dataset", () => {
  it("flattens a library export, carrying tags and threads by name", () => {
    const book = (id: string, status: "reading" | "finished", extra: object = {}) => ({ id: id as BookId, title: id, authors: ["A"], status, archived: false, createdAt: 0, updatedAt: 0, revision: 1, highlightCount: 1, ...extra });
    const note = (id: string, origin: "reader" | "import", createdAt: number, highlightId?: string) => ({ id: id as NoteId, bookId: "b" as BookId, markdown: id, origin, createdAt, updatedAt: createdAt, revision: 1, ...(highlightId ? { highlightId: highlightId as HighlightId } : {}) });
    const result = widgetDataset({
      format: "leaflogue-library",
      formatVersion: 4,
      exportedAt: "",
      books: [
        {
          book: book("b", "finished", { publisher: " Faber ", series: "  " }),
          highlights: [{ id: "h" as HighlightId, bookId: "b" as BookId, text: "passage", sourceCreatedAt: 100, createdAt: 900, updatedAt: 900, revision: 1, notes: [note("imported", "import", 900, "h"), note("written", "reader", 950, "h")] }],
          standaloneNotes: [note("loose", "import", 990)],
        },
        { book: book("c", "finished", { completedOn: "2024-05-01" }), highlights: [], standaloneNotes: [] },
      ],
      collections: [],
      tags: [{ id: "t" as never, name: "Favourite", bookCount: 0, highlightCount: 1, createdAt: 0, updatedAt: 0, revision: 1 }],
      organizations: [{ bookId: "b" as BookId, collectionIds: [], tagIds: [], highlightTags: [{ highlightId: "h" as HighlightId, tagIds: ["t" as never] }] }],
      readingStatusEvents: [{ id: "e" as never, bookId: "b" as BookId, status: "finished", source: "kobo", changedAt: 500, bookRevision: 1 }],
      threads: [{ id: "th" as never, name: "Tides", passageCount: 1, createdAt: 0, updatedAt: 0, revision: 1 }],
      threadHighlightMemberships: [{ threadId: "th" as never, highlightId: "h" as HighlightId, addedAt: 0 }],
      dailySelections: [],
    });
    // A finish an import recorded says nothing about the year; a completion date does.
    expect(result.books).toEqual([
      { id: "b", title: "b", authors: ["A"], publisher: "Faber", status: "finished", archived: false },
      { id: "c", title: "c", authors: ["A"], status: "finished", finishedYear: 2024, archived: false },
    ]);
    expect(result.passages).toEqual([{ id: "h", bookId: "b", text: "passage", at: 100, timed: true, notes: 2, tags: ["Favourite"], threads: ["Tides"] }]);
    // An imported note counts when its passage was kept; one written here, when it was written.
    expect(result.notes).toEqual([
      { id: "imported", bookId: "b", highlightId: "h", text: "imported", at: 100, timed: true },
      { id: "written", bookId: "b", highlightId: "h", text: "written", at: 950, timed: true },
      { id: "loose", bookId: "b", text: "loose", at: 990, timed: false },
    ]);
  });
});
