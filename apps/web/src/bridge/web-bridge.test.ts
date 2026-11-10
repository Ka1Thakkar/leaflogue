/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookId, HighlightId, NoteId, TagId } from "@leaflogue/contracts";
import { BackendError } from "../transport/transport";
import { FakeTransport } from "./fake-transport";
import { createWebBridge } from "./web-bridge";
import type { WirePassage } from "./wire";

const LIBRARY = "library-1";
const BOOK = "11111111-1111-4111-8111-111111111111" as BookId;
const TAG = "22222222-2222-4222-8222-222222222222" as TagId;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function passage(n: number, extra: Partial<WirePassage> = {}): WirePassage {
  return {
    id: `h${n}` as HighlightId,
    bookId: BOOK,
    bookTitle: "Piranesi",
    bookAuthors: ["Susanna Clarke"],
    text: `Passage ${n}`,
    imported: false,
    importedVersion: null,
    notes: [],
    tags: [],
    revision: 1,
    createdAt: 1_000 * n,
    updatedAt: 1_000 * n,
    ...extra,
  };
}

const shelfBook = {
  id: BOOK, title: "Piranesi", authors: ["Susanna Clarke"], series: "Standalone", status: "reading", archived: false,
  highlightCount: 2, noteCount: 1, collectionIds: ["c1"], tagIds: [TAG], revision: 4, createdAt: 1, updatedAt: 2,
};

let transport: FakeTransport;
const bridge = () => createWebBridge({
  transport,
  libraryId: LIBRARY,
  host: { kind: "web", backend: "server", account: "reader@example.com" },
  signOut: async () => undefined,
});

beforeEach(() => {
  transport = new FakeTransport();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listHighlights", () => {
  it("walks cursors to reach an offset and continues where the last read stopped", async () => {
    const pages: Record<string, { page: WirePassage[]; isDone: boolean; continueCursor: string }> = {
      start: { page: [passage(1, { tags: [{ id: TAG, name: "Revisit" }], notes: [{ id: "n1" as NoteId, markdown: "Mine", origin: "reader", revision: 1, createdAt: 5, updatedAt: 5 }] })], isDone: false, continueCursor: "a" },
      a: { page: [passage(2), passage(3)], isDone: false, continueCursor: "b" },
      b: { page: [passage(4)], isDone: true, continueCursor: "c" },
    };
    transport.on("browse:highlights", (args) => pages[((args.paginationOpts as { cursor: string | null }).cursor) ?? "start"]);
    const library = bridge().library;
    const query = { search: " tides ", source: "manual", notes: "with", sort: "newest", tagId: TAG } as const;

    const first = await library.listHighlights({ ...query, offset: 0, limit: 2 });
    expect(first.entries.map(({ id }) => id)).toEqual(["h1", "h2"]);
    expect(first.hasMore).toBe(true);
    expect(first.entries[0]).toMatchObject({
      bookTitle: "Piranesi",
      authors: ["Susanna Clarke"],
      tagIds: [TAG],
      imported: false,
      notes: [{ id: "n1", bookId: BOOK, highlightId: "h1", markdown: "Mine" }],
    });
    expect(transport.calls[0]).toEqual({
      kind: "query",
      name: "browse:highlights",
      args: { libraryId: LIBRARY, search: "tides", source: "typed", notes: "with", sort: "newest", tagId: TAG, paginationOpts: { numItems: 50, cursor: null } },
    });
    expect(transport.called("browse:highlights").map(({ args }) => (args.paginationOpts as { cursor: unknown }).cursor)).toEqual([null, "a"]);

    const second = await library.listHighlights({ ...query, offset: 2, limit: 2 });
    expect(second.entries.map(({ id }) => id)).toEqual(["h3", "h4"]);
    expect(second.hasMore).toBe(false);
    expect(transport.called("browse:highlights").map(({ args }) => (args.paginationOpts as { cursor: unknown }).cursor)).toEqual([null, "a", "b"]);

    await library.listHighlights({ ...query, offset: 0, limit: 1 });
    expect(transport.called("browse:highlights")[3]?.args.paginationOpts).toEqual({ numItems: 50, cursor: null });
  });

  it("asks for a local day by its date and keeps only passages inside it", async () => {
    const from = new Date(2026, 9, 8).getTime();
    const before = new Date(2026, 9, 9).getTime();
    transport.on("browse:highlights", () => ({
      page: [passage(1, { createdAt: from + 60_000 }), passage(2, { createdAt: before + 60_000 })],
      isDone: true,
      continueCursor: "",
    }));
    const page = await bridge().library.listHighlights({ dateKind: "created", dateFrom: from, dateBefore: before });
    expect(transport.calls[0]?.args).toMatchObject({ date: "2026-10-08", dateKind: "added" });
    expect(page.entries.map(({ id }) => id)).toEqual(["h1"]);

    await bridge().library.listHighlights({ dateKind: "imported", dateFrom: from, dateBefore: before });
    expect(transport.calls[1]?.args).toMatchObject({ date: "2026-10-08", dateKind: "imported" });
  });
});

describe("library", () => {
  it("assembles a book's contents from every page of its passages and notes", async () => {
    const row = (id: string, extra: object = {}) => ({ id, bookId: BOOK, text: id, archived: false, revision: 1, createdAt: 10, updatedAt: 10, ...extra });
    transport
      .on("browse:book", () => shelfBook)
      .on("reading:listHighlights", (args) => (args.paginationOpts as { cursor: string | null }).cursor === null
        ? { page: [row("late", { createdAt: 30 }), row("early", { sourceCreatedAt: 1, createdAt: 40 })], isDone: false, continueCursor: "late" }
        : { page: [row("gone", { deletedAt: 50 }), row("hidden", { archived: true })], isDone: true, continueCursor: "hidden" })
      .on("reading:listNotes", () => ({
        page: [
          { id: "n2", bookId: BOOK, markdown: "Loose", origin: "reader", revision: 1, createdAt: 20, updatedAt: 20 },
          { id: "n1", bookId: BOOK, highlightId: "late", markdown: "Attached", origin: "import", revision: 2, createdAt: 15, updatedAt: 15, deletedAt: undefined },
          { id: "n3", bookId: BOOK, highlightId: "late", markdown: "Deleted", origin: "reader", revision: 3, createdAt: 16, updatedAt: 16, deletedAt: 17 },
        ],
        isDone: true,
        continueCursor: "",
      }));
    const contents = await bridge().library.getBookContents(BOOK);
    expect(contents?.book).toEqual({
      id: BOOK, title: "Piranesi", authors: ["Susanna Clarke"], series: "Standalone", status: "reading", archived: false,
      createdAt: 1, updatedAt: 2, revision: 4, highlightCount: 2,
    });
    expect(contents?.highlights.map(({ id }) => id)).toEqual(["early", "late"]);
    expect(contents?.highlights[1]?.notes.map(({ id }) => id)).toEqual(["n1"]);
    expect(contents?.standaloneNotes.map(({ id }) => id)).toEqual(["n2"]);
    expect(transport.called("reading:listHighlights").map(({ args }) => args)).toEqual([
      { libraryId: LIBRARY, bookId: BOOK, paginationOpts: { numItems: 100, cursor: null } },
      { libraryId: LIBRARY, bookId: BOOK, paginationOpts: { numItems: 100, cursor: "late" } },
    ]);
  });

  it("returns nothing for a book the backend does not have", async () => {
    transport.on("browse:book", () => null).on("reading:listHighlights", () => ({ page: [], isDone: true, continueCursor: "" }))
      .on("reading:listNotes", () => ({ page: [], isDone: true, continueCursor: "" }));
    expect(await bridge().library.getBookContents(BOOK)).toBeUndefined();
  });

  it("creates a passage under a new ID and returns it with its note", async () => {
    transport.on("runtime:createHighlight", (args) => ({ id: args.id, bookId: BOOK, text: "Quote", revision: 1, createdAt: 7, updatedAt: 7 }));
    const highlight = await bridge().library.createHighlight({ bookId: BOOK, text: "Quote", noteMarkdown: "  Mine  " });
    const [call] = transport.calls;
    expect(call?.kind).toBe("mutation");
    expect(call?.args.id).toMatch(UUID);
    expect(call?.args.noteId).toMatch(UUID);
    expect(call?.args).toMatchObject({ libraryId: LIBRARY, bookId: BOOK, text: "Quote", noteMarkdown: "Mine" });
    expect(highlight).toEqual({
      id: call?.args.id, bookId: BOOK, text: "Quote", createdAt: 7, updatedAt: 7, revision: 1,
      notes: [{ id: call?.args.noteId, bookId: BOOK, highlightId: call?.args.id, markdown: "Mine", origin: "reader", createdAt: 7, updatedAt: 7, revision: 1 }],
    });
  });

  it("creates a passage without a note when none is given", async () => {
    transport.on("runtime:createHighlight", (args) => ({ id: args.id, bookId: BOOK, text: "Quote", revision: 1, createdAt: 7, updatedAt: 7 }));
    const highlight = await bridge().library.createHighlight({ bookId: BOOK, text: "Quote" });
    expect(transport.calls[0]?.args).not.toHaveProperty("noteId");
    expect(highlight.notes).toEqual([]);
  });

  it("computes statistics from every export page", async () => {
    transport.on("browse:exportPage", (args) => {
      const cursor = (args.paginationOpts as { cursor: string | null }).cursor;
      switch (args.table) {
        case "books": return { records: [{ ...shelfBook, status: "finished", completedOn: "2025-03-01" }], isDone: true, continueCursor: "1" };
        case "highlights": return cursor === null
          ? { records: [{ id: "h1", bookId: BOOK, text: "One", archived: false, revision: 1, createdAt: 1, updatedAt: 1 }], isDone: false, continueCursor: "1" }
          : { records: [{ id: "h2", bookId: BOOK, text: "Two", archived: false, revision: 1, createdAt: 2, updatedAt: 2, deletedAt: 3 }], isDone: true, continueCursor: "2" };
        default: return { records: [], isDone: true, continueCursor: "0" };
      }
    });
    const statistics = await bridge().statistics.get();
    expect(statistics.totals).toMatchObject({ books: 1, finished: 1, highlights: 1 });
    expect(transport.called("browse:exportPage").filter(({ args }) => args.table === "highlights")).toHaveLength(2);
    // The newer statistics come from the same snapshot: passages by hour, recent ones, books in progress.
    expect(statistics.hours).toHaveLength(24);
    expect(statistics.recent.map(({ text }) => text)).toEqual(["One"]);
    expect(statistics.onThisDay).toEqual([]);
    expect(statistics.inProgress).toEqual([]);
  });
});

describe("dashboards and widgets", () => {
  it("keeps the reader's layouts on the backend", async () => {
    transport
      .on("dashboardRuntime:layouts", () => ({ library: [{ widget: "on-this-day", width: "half" }, { widget: "shelf" }] }))
      .on("dashboardRuntime:saveLayout", (args) => (args.layout === null ? {} : { statistics: args.layout }));
    expect(await bridge().dashboards.describe()).toEqual({ library: [{ widget: "on-this-day", width: "half" }, { widget: "shelf" }] });
    expect(await bridge().dashboards.save("statistics", [{ widget: "hours" }])).toEqual({ statistics: [{ widget: "hours" }] });
    expect(transport.called("dashboardRuntime:saveLayout")[0]).toMatchObject({ kind: "mutation", args: { libraryId: LIBRARY, dashboard: "statistics", layout: [{ widget: "hours" }] } });
    expect(await bridge().dashboards.save("library", null)).toEqual({});
  });

  it("leaves custom widgets to the desktop app, and says where it runs at once", async () => {
    const web = bridge();
    expect(web.host).toEqual({ kind: "web", backend: "server", account: "reader@example.com" });
    await expect(web.widgets.import()).rejects.toMatchObject({ code: "LEAFLOGUE_WEB_UNSUPPORTED" });
    await expect(web.widgets.evaluate([])).rejects.toBeInstanceOf(BackendError);
    await expect(web.appearance.openThemesFolder()).rejects.toMatchObject({ code: "LEAFLOGUE_WEB_UNSUPPORTED" });
    expect(transport.calls).toEqual([]);
  });
});

describe("organization and daily", () => {
  it("returns the refreshed book organization after changing a tag", async () => {
    transport
      .on("organizationRuntime:setBookTagMembership", () => ({ changed: true }))
      .on("browse:book", () => ({ ...shelfBook, tagIds: [] }));
    const organization = await bridge().organization.setBookTag({ bookId: BOOK, tagId: TAG, included: false });
    expect(transport.calls[0]).toMatchObject({ kind: "mutation", args: { libraryId: LIBRARY, bookId: BOOK, tagId: TAG, included: false } });
    expect(organization).toEqual({ bookId: BOOK, collectionIds: ["c1"], tagIds: [], highlightTags: [] });
  });

  it("answers a whole shelf's organization from one read, and reads an archived book on its own", async () => {
    const archived = "b0000000-0000-4000-8000-000000000009";
    transport
      .on("browse:books", () => [shelfBook])
      .on("browse:book", () => ({ ...shelfBook, id: archived, collectionIds: [], tagIds: [TAG] }));
    const organization = bridge().organization;
    const [shelved, other] = await Promise.all([organization.getBook(BOOK), organization.getBook(archived as never)]);
    expect(shelved).toEqual({ bookId: BOOK, collectionIds: ["c1"], tagIds: [TAG], highlightTags: [] });
    expect(other).toEqual({ bookId: archived, collectionIds: [], tagIds: [TAG], highlightTags: [] });
    expect(transport.called("browse:books")).toHaveLength(1);
    expect(transport.called("browse:book")).toHaveLength(1);
    expect(transport.called("browse:highlights")).toHaveLength(0);
  });

  it("builds today's highlight from the selection and its passage", async () => {
    const selection = { id: "s1", localDay: "2026-10-08", timezone: "Europe/London", highlightId: "h1", candidateDigest: "d", recentHighlightIds: [], selectedAt: 1, updatedAt: 1, revision: 1 };
    transport.on("dailyRuntime:ensureDailySelection", () => selection).on("browse:highlight", () => passage(1, { sourceLocation: "Part 1" }));
    const daily = await bridge().daily.ensure({ timezone: "Europe/London", another: true });
    const [call] = transport.calls;
    expect(call?.kind).toBe("mutation");
    expect(call?.args).toMatchObject({ libraryId: LIBRARY, timezone: "Europe/London", another: true });
    expect(call?.args.id).toMatch(UUID);
    expect(daily).toEqual({
      selection,
      passage: { highlightId: "h1", bookId: BOOK, bookTitle: "Piranesi", authors: ["Susanna Clarke"], text: "Passage 1", sourceLocation: "Part 1", notes: [] },
      hasAlternatives: true,
    });
  });

  it("has no daily highlight when the library has no passages", async () => {
    transport.on("dailyRuntime:ensureDailySelection", () => ({ id: "s1", localDay: "2026-10-08", timezone: "UTC", candidateDigest: "d", recentHighlightIds: [], selectedAt: 1, updatedAt: 1, revision: 1 }));
    expect(await bridge().daily.get("UTC")).toBeUndefined();
    expect(transport.calls[0]?.args).not.toHaveProperty("another");
  });
});

describe("ai", () => {
  beforeEach(() => {
    transport
      .on("aiRuntime:settings", () => ({
        providers: [
          { id: "anthropic", configured: true, keyVariable: "ANTHROPIC_API_KEY", models: ["claude-a", "claude-b"], defaultModel: "claude-a" },
          { id: "gemini", configured: false, keyVariable: "GEMINI_API_KEY", models: ["gemini-x"], defaultModel: "gemini-x" },
          { id: "openai-compatible", configured: false, keyVariable: "OPENAI_COMPATIBLE_API_KEY", models: [] },
        ],
        selected: { provider: "anthropic", model: "claude-b" },
        hourlyLimit: 30,
      }))
      .on("browse:highlight", () => passage(1, { notes: [{ id: "n1" as NoteId, markdown: "A house of tides", origin: "reader", revision: 1, createdAt: 1, updatedAt: 1 }] }))
      .on("browse:book", () => shelfBook)
      .on("aiRuntime:companion", () => ({ answer: "It is about attention.", remaining: 29, saveable: true }));
  });

  it("describes the server's providers and remembers accepted terms", async () => {
    const ai = bridge().ai;
    const summary = await ai.describe();
    expect(summary.enabled).toBe(true);
    expect(summary.selectedProvider).toBe("anthropic");
    expect(summary.providers.map(({ id, credential, selectedModel }) => ({ id, credential, selectedModel }))).toEqual([
      { id: "anthropic", credential: "environment", selectedModel: "claude-b" },
      { id: "gemini", credential: "missing", selectedModel: "gemini-x" },
    ]);
    expect((await ai.acceptTerms("anthropic")).providers[0]?.consented).toBe(true);
    expect((await ai.describe()).providers[0]?.consented).toBe(true);
  });

  it("discloses the passage, book, and notes, then explains it through the companion", async () => {
    const ai = bridge().ai;
    const disclosure = await ai.describeExplainTask(BOOK, "h1" as HighlightId, true);
    expect(disclosure).toMatchObject({
      providerId: "anthropic", providerName: "Anthropic", model: "claude-b", trainsOnFreeTier: false, consented: false,
      bookTitle: "Piranesi", authors: ["Susanna Clarke"], series: "Standalone", passage: "Passage 1", notes: ["A house of tides"],
    });
    expect(disclosure.disclosureId).toMatch(UUID);

    const explanation = await ai.explainPassage({ requestId: crypto.randomUUID(), disclosureId: disclosure.disclosureId });
    expect(explanation).toEqual({ providerId: "anthropic", model: "claude-b", explanation: "It is about attention." });
    const call = transport.called("aiRuntime:companion")[0];
    expect(call?.kind).toBe("action");
    expect(call?.args).toEqual({
      libraryId: LIBRARY, highlightId: "h1", history: [],
      prompt: "Explain this passage.\n\nMy notes on this passage:\n- A house of tides",
    });
  });

  it("sends the preset question alone without notes, and sets aside a cancelled answer", async () => {
    const ai = bridge().ai;
    const disclosure = await ai.describeExplainTask(BOOK, "h1" as HighlightId, false);
    expect(disclosure.notes).toEqual([]);
    const requestId = crypto.randomUUID();
    const pending = ai.explainPassage({ requestId, disclosureId: disclosure.disclosureId });
    await ai.cancel(requestId);
    await expect(pending).rejects.toBeInstanceOf(BackendError);
    expect(transport.called("aiRuntime:companion")[0]?.args.prompt).toBe("Explain this passage.");
  });

  it("turns AI off in this browser and saves the model when turned on", async () => {
    transport.on("aiRuntime:setSettings", () => null);
    const ai = bridge().ai;
    expect((await ai.save({ enabled: false, selectedProvider: "anthropic", selectedModel: "claude-a" })).enabled).toBe(false);
    expect(transport.called("aiRuntime:setSettings")).toHaveLength(0);
    await expect(ai.describeExplainTask(BOOK, "h1" as HighlightId, false)).rejects.toThrow("turned off");
    expect((await ai.save({ enabled: true, selectedProvider: "anthropic", selectedModel: "claude-a", apiKey: "ignored" })).enabled).toBe(true);
    expect(transport.called("aiRuntime:setSettings")[0]).toMatchObject({ kind: "mutation", args: { libraryId: LIBRARY, provider: "anthropic", model: "claude-a" } });
  });
});

describe("desktop-only features", () => {
  it("reports sync as off and refuses backups, exports, and folder imports", async () => {
    const web = bridge();
    expect(await web.sync.status()).toEqual({ state: "off" });
    expect(await web.sync.listConflicts()).toEqual({ conflicts: [], total: 0 });
    await expect(web.sync.run()).rejects.toThrow("needs the desktop app");
    await expect(web.backups.create()).rejects.toBeInstanceOf(BackendError);
    await expect(web.backups.restore()).rejects.toThrow("needs the desktop app");
    await expect(web.exports.create()).rejects.toThrow("needs the desktop app");
    await expect(web.imports.chooseFolder()).rejects.toThrow("needs the desktop app");
    expect(await web.imports.listReaders()).toEqual([]);
    expect(await web.updates.describe()).toEqual({ automaticCheck: false });
    expect(transport.calls).toEqual([]);
  });

  it("describes the web host", async () => {
    const capabilities = await bridge().system.getCapabilities();
    expect(capabilities).toMatchObject({
      host: { kind: "web", backend: "server", account: "reader@example.com" },
      appVersion: "web",
      persistenceAvailable: true,
      setupRequired: false,
    });
  });

  it("opens only https links, after the reader confirms", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, "confirm", { value: confirm, configurable: true });
    const system = bridge().system;
    expect(await system.openExternal("http://example.com/")).toBe(false);
    expect(await system.openExternal("https://example.com/notes")).toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("https://example.com/notes"));
    expect(open).toHaveBeenCalledWith("https://example.com/notes", "_blank", "noopener,noreferrer");
  });
});

describe("imports", () => {
  it("maps import conflicts and their resolution", async () => {
    transport
      .on("importRuntime:listConflicts", () => [{
        id: "c1", sourceId: "s1", sourceName: "Kobo", bookId: BOOK, createdAt: 9,
        previous: JSON.stringify({ providerRecordId: "r", bookProviderRecordId: "b", text: "Old" }),
        incoming: JSON.stringify({ providerRecordId: "r", bookProviderRecordId: "b", text: "New" }),
      }])
      .on("browse:book", () => shelfBook)
      .on("importRuntime:resolveConflict", () => null);
    const imports = bridge().imports;
    const [conflict] = await imports.listConflicts();
    expect(conflict).toMatchObject({ id: "c1", sourceName: "Kobo", bookTitle: "Piranesi", kind: "highlight", base: { text: "Old" }, incoming: { text: "New" }, createdAt: 9 });
    await imports.resolveConflict({ id: conflict!.id, resolution: "use-incoming" });
    expect(transport.called("importRuntime:resolveConflict")[0]?.args).toEqual({ libraryId: LIBRARY, conflictId: "c1", resolution: "accept-incoming" });
  });
});

describe("appearance", () => {
  it("keeps the chosen theme in this browser and hears changes from other tabs", async () => {
    const appearance = bridge().appearance;
    const saved = await appearance.save({ themeId: "rose-pine", mode: "dark" });
    expect(saved).toMatchObject({ themeId: "rose-pine", mode: "dark" });
    expect(await createWebBridge({ transport, libraryId: LIBRARY, host: { kind: "web", backend: "server" }, signOut: async () => undefined }).appearance.describe())
      .toMatchObject({ themeId: "rose-pine", mode: "dark" });
    await expect(appearance.save({ themeId: "no-such-theme", mode: "dark" })).rejects.toThrow();

    const heard: string[] = [];
    const stop = appearance.onChanged((configuration) => heard.push(`${configuration.themeId}/${configuration.mode}`));
    window.localStorage.setItem("leaflogue:appearance", JSON.stringify({ themeId: "rose-pine", mode: "light" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "leaflogue:appearance" }));
    stop();
    window.dispatchEvent(new StorageEvent("storage", { key: "leaflogue:appearance" }));
    expect(heard).toEqual(["rose-pine/light"]);
    await expect(appearance.exportTheme("rose-pine")).rejects.toBeInstanceOf(BackendError);
  });
});
