/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppearanceSettingsInput, Book, BookId, CollectionId, HighlightId, HighlightListEntry, HighlightQuery, LeaflogueBridge, NoteId, ReadingStatusEvent, SetBookCompletionDate, SetBookReadingStatus, TagId, ThreadId, UpdateBookMetadata } from "@leaflogue/contracts";
import { appearanceConfiguration } from "@leaflogue/appearance";
import { App } from "./App";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let describeRemote: ReturnType<typeof vi.fn>;
let checkRemote: ReturnType<typeof vi.fn>;
let createExport: ReturnType<typeof vi.fn>;
let describeAppearance: ReturnType<typeof vi.fn>;
let saveAppearance: ReturnType<typeof vi.fn>;
let appearanceListeners: ((configuration: ReturnType<typeof appearanceConfiguration>) => void)[];

const firstBookId = "bd809783-25e1-4d95-80a0-d03442a57d5c" as BookId;
const secondBookId = "ad97b895-7fd8-46af-8de1-c12b1ca284af" as BookId;
const collectionId = "ba043082-c430-4ec1-a0dd-29fd80792fbd" as CollectionId;
const tagId = "a4f12f7f-ea09-45e3-a92a-d414ae8d4019" as TagId;
const threadId = "c3283cdd-4bc3-492f-bb69-99daef715610" as ThreadId;
const highlightId = "98da45c8-a8ea-42fc-aaae-8d75ec12dc16" as HighlightId;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function bridge(): LeaflogueBridge {
  return window.leaflogue;
}

function override(patch: { readonly [K in keyof LeaflogueBridge]?: Partial<LeaflogueBridge[K]> }): void {
  const current = bridge() as unknown as Record<string, Record<string, unknown>>;
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) next[key] = { ...current[key], ...value };
  Object.defineProperty(window, "leaflogue", { configurable: true, value: next });
}

async function render(hash = "#/library"): Promise<void> {
  window.history.replaceState(null, "", hash);
  await act(async () => {
    root?.render(<App />);
    await tick();
    await tick();
  });
}

async function visit(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await tick();
    await tick();
  });
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error("Element to click is missing");
  await act(async () => {
    if (element.getAttribute("aria-haspopup") === "menu") element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    else element.click();
    await tick();
    await tick();
  });
}

async function choose(select: HTMLElement | null | undefined, value: string): Promise<void> {
  if (!select) throw new Error("Select is missing");
  await act(async () => {
    if (select.getAttribute("aria-expanded") !== "true") {
      select.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await tick();
      await tick();
    }
    const option = Array.from(document.querySelectorAll<HTMLElement>("[role='option']"))
      .find(item => item.dataset.value === value);
    if (!option) throw new Error(`Option ${value} is missing`);
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    await tick();
  });
}

async function selectOptions(select: HTMLElement | null | undefined): Promise<{ value: string; text: string }[]> {
  if (!select) throw new Error("Select is missing");
  let options: { value: string; text: string }[] = [];
  await act(async () => {
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    await tick();
    options = Array.from(document.querySelectorAll<HTMLElement>("[role='option']"))
      .map(option => ({ value: option.dataset.value ?? "", text: option.textContent?.replace("✓", "").trim() ?? "" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
  });
  return options;
}

function button(name: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name);
}

/** The in-app confirmation that replaced window.confirm, if one is open. */
function confirmation(): HTMLDialogElement | undefined {
  return Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open][aria-describedby$='-message']")).at(-1);
}

/** The theme card currently chosen in Settings. */
function chosenTheme(): string | undefined {
  return document.querySelector<HTMLInputElement>("input[type='radio'][name='Theme']:checked")?.value;
}

async function pickTheme(id: string): Promise<void> {
  const card = document.querySelector<HTMLInputElement>(`input[type='radio'][name='Theme'][value='${id}']`);
  if (!card) throw new Error(`Theme card ${id} is missing`);
  await click(card);
}

function labelledSelect(name: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[role='combobox']"))
    .find((select) => select.getAttribute("aria-label") === name || select.closest("label")?.querySelector(".sr-only, [class*='srOnly']")?.textContent === name);
}

function entry(overrides: Partial<HighlightListEntry> = {}): HighlightListEntry {
  return {
    id: highlightId,
    bookId: firstBookId,
    bookTitle: "Piranesi",
    authors: ["Susanna Clarke"],
    text: "Every room of the House keeps its weather.",
    createdAt: 1,
    updatedAt: 1,
    revision: 3,
    notes: [],
    imported: false,
    tagIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    clear: () => stored.clear(),
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    key: (index: number) => [...stored.keys()][index] ?? null,
    get length() { return stored.size; },
  } satisfies Storage });
  describeRemote = vi.fn().mockResolvedValue({ configured: false });
  checkRemote = vi.fn().mockResolvedValue({ configured: false, reachable: false, initialized: false });
  createExport = vi.fn().mockResolvedValue({ fileName: "Leaflogue-library.json", booksExported: 2, highlightsExported: 3, notesExported: 4 });
  describeAppearance = vi.fn().mockResolvedValue(appearanceConfiguration());
  saveAppearance = vi.fn().mockImplementation(async (input: AppearanceSettingsInput) => appearanceConfiguration(input));
  appearanceListeners = [];
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) });
  // Unit tests have no viewport; the component's fallback resolves covers
  // immediately while real Chromium exercises IntersectionObserver laziness.
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
  Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn().mockReturnValue(true) });
  const value = {
    system: {
      describeMcp: vi.fn().mockResolvedValue({ enabled: false, clientConfiguration: "{}" }),
      configureMcp: vi.fn().mockImplementation(async (enabled: boolean) => ({ enabled, clientConfiguration: "{}" })),
      getCapabilities: vi.fn().mockResolvedValue({
      appVersion: "test",
      databaseSchemaVersion: 12,
      features: { ai: false, metadata: false, sync: true },
      persistenceAvailable: true,
      setupRequired: false,
      platform: "linux",
      storagePaths: {
        configFile: "/home/reader/.config/leaflogue/config.json",
        libraryFile: "/home/reader/.local/share/leaflogue/library.sqlite",
        cacheDirectory: "/home/reader/.cache/leaflogue",
        stateDirectory: "/home/reader/.local/state/leaflogue",
      },
    }), completeSetup: vi.fn().mockImplementation(async () => ({
      appVersion: "test", databaseSchemaVersion: 12,
      features: { ai: false, metadata: false, sync: true }, persistenceAvailable: true, setupRequired: false, platform: "linux",
      storagePaths: {
        configFile: "/home/reader/.config/leaflogue/config.json", libraryFile: "/home/reader/.local/share/leaflogue/library.sqlite",
        cacheDirectory: "/home/reader/.cache/leaflogue", stateDirectory: "/home/reader/.local/state/leaflogue",
      },
    })) },
    library: {
      findDuplicates: vi.fn().mockResolvedValue({ books: [], passages: [] }),
      listBooks: vi.fn().mockResolvedValue([]),
      getBookContents: vi.fn().mockResolvedValue(undefined),
      getMetadataSource: vi.fn().mockResolvedValue(undefined),
      listHighlights: vi.fn().mockResolvedValue({ entries: [], hasMore: false }),
      listReadingStatusHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
    },
    covers: { resolve: vi.fn().mockResolvedValue(undefined), cancel: vi.fn().mockResolvedValue(undefined) },
    organization: {
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
      getBook: vi.fn().mockResolvedValue(undefined),
    },
    threads: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined),
      getHighlightMembership: vi.fn().mockResolvedValue([]),
    },
    daily: { get: vi.fn().mockResolvedValue(undefined), ensure: vi.fn().mockResolvedValue(undefined) },
    imports: {
      listConflicts: vi.fn().mockResolvedValue([]),
      listReaders: vi.fn().mockResolvedValue([]),
      chooseReader: vi.fn(),
      chooseFolder: vi.fn(),
      onReadersChanged: vi.fn().mockReturnValue(() => undefined),
    },
    sync: {
      listConflicts: vi.fn().mockResolvedValue({ conflicts: [], total: 0 }),
      resolveConflict: vi.fn(),
      run: vi.fn().mockResolvedValue({ status: "complete", bootstrapped: 0, pushed: 0, superseded: 0, pulled: 0 }),
      status: vi.fn().mockResolvedValue({ state: "off" }),
      onStatus: vi.fn().mockReturnValue(() => undefined),
    },
    exports: { create: createExport },
    backups: { create: vi.fn(), restore: vi.fn() },
    remote: {
      describe: describeRemote,
      check: checkRemote,
      initialize: vi.fn().mockResolvedValue({ configured: false, reachable: false, initialized: false }),
    },
    ai: {
      describe: vi.fn().mockResolvedValue({ enabled: false, providers: [] }),
      acceptTerms: vi.fn(),
      describeExplainTask: vi.fn(),
      explainPassage: vi.fn(),
      cancel: vi.fn(),
    },
    statistics: {
      get: vi.fn().mockResolvedValue({
        totals: { books: 1, reading: 1, finished: 0, highlights: 2, notes: 1, threads: 0 },
        finishedByYear: [{ year: 2026, books: 0 }],
        highlightsByMonth: [{ month: "2026-10", highlights: 2 }],
        topBooks: [{ bookId: firstBookId, title: "Piranesi", highlights: 2 }],
        topAuthors: [{ name: "Susanna Clarke", highlights: 2, books: 1 }],
        days: [],
        books: [{ bookId: firstBookId, title: "Piranesi", authors: ["Susanna Clarke"], status: "reading", highlights: 2, notes: 1, activeDays: 1, averageLength: 40 }],
        series: [],
        lengths: [0, 2, 0, 0],
        averageLength: 120,
        highlightsWithNotes: 1,
        longestLength: 200,
        coverage: { highlightsDated: 2, booksWithSeries: 0, finishedDated: 0 },
        hours: Array.from({ length: 24 }, (_, hour) => (hour === 21 ? 2 : 0)),
        onThisDay: [],
        recent: [],
        inProgress: [{ bookId: firstBookId, title: "Piranesi", authors: ["Susanna Clarke"], status: "reading", highlights: 2 }],
      }),
    },
    dashboards: {
      describe: vi.fn().mockResolvedValue({}),
      save: vi.fn().mockImplementation(async (dashboard: string, layout: unknown) => (layout ? { [dashboard]: layout } : {})),
    },
    widgets: {
      save: vi.fn().mockImplementation(async (widget: unknown) => ({ widgets: [widget] })),
      delete: vi.fn().mockResolvedValue({}),
      evaluate: vi.fn().mockImplementation(async (widgets: readonly unknown[]) => widgets.map(() => ({ kind: "number", value: 0 }))),
      export: vi.fn().mockResolvedValue(undefined),
      import: vi.fn().mockResolvedValue(undefined),
    },
    updates: {
      check: vi.fn().mockResolvedValue({ state: "up-to-date", currentVersion: "0.1.0" }),
      install: vi.fn(),
      describe: vi.fn().mockResolvedValue({ automaticCheck: false }),
      setAutomaticCheck: vi.fn().mockImplementation(async (enabled: boolean) => ({ automaticCheck: enabled })),
      onAvailable: vi.fn().mockReturnValue(() => undefined),
    },
    appearance: {
      describe: describeAppearance,
      save: saveAppearance,
      openThemesFolder: vi.fn().mockResolvedValue("/home/reader/.config/leaflogue/themes"),
      onChanged: vi.fn().mockImplementation((listener) => {
        appearanceListeners.push(listener as (typeof appearanceListeners)[number]);
        return () => { appearanceListeners = appearanceListeners.filter((candidate) => candidate !== listener); };
      }),
    },
  } as unknown as LeaflogueBridge;
  Object.defineProperty(window, "leaflogue", { configurable: true, value });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  window.history.replaceState(null, "", "#");
  delete (window as { leaflogue?: LeaflogueBridge }).leaflogue;
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("application shell", () => {
  it("expands, resizes, and remembers the sidebar", async () => {
    await render();
    const navigation = () => document.querySelector<HTMLElement>("[aria-label='Main navigation']")!;
    expect(navigation().hasAttribute("data-expanded")).toBe(false);
    await click(button("Expand sidebar"));
    expect(navigation().hasAttribute("data-expanded")).toBe(true);
    expect(navigation().style.getPropertyValue("--ui-rail-expanded")).toBe("208px");
    const edge = navigation().querySelector<HTMLElement>("[role='separator']")!;
    await act(async () => { edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await tick(); });
    expect(navigation().style.getPropertyValue("--ui-rail-expanded")).toBe("224px");
    expect(JSON.parse(localStorage.getItem("leaflogue.sidebar")!)).toEqual({ expanded: true, width: 224 });
    // ⌘B folds it back from anywhere.
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true })); await tick(); });
    expect(navigation().hasAttribute("data-expanded")).toBe(false);
  });

  it("offers the reference destinations, marks the current one, and has no separate daily page", async () => {
    await render();
    const navigation = document.querySelector("[aria-label='Main navigation']");
    const links = Array.from(navigation?.querySelectorAll("a") ?? []);
    expect(links.map((link) => link.textContent)).toEqual(["Library", "Highlights", "Threads", "Statistics", "Import", "Settings"]);
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
    expect(links.at(-1)?.getAttribute("href")).toBe("#/settings");
    expect(document.body.textContent).not.toContain("Daily highlight");

    await visit("#/highlights");
    expect(links[1]?.getAttribute("aria-current")).toBe("page");
    expect(links[0]?.hasAttribute("aria-current")).toBe(false);
    expect(document.querySelector("h1")?.textContent).toBe("Your highlights");
    expect(document.title).toBe("Highlights | Leaflogue");
  });

  it("opens Import as its own page from the rail and from the library", async () => {
    await render();
    expect(document.querySelector("[aria-label='Main navigation'] a[href='#/import']")).not.toBeNull();
    await click(button("Import"));
    expect(window.location.hash).toBe("#/import");
    expect(document.querySelector("h1")?.textContent).toBe("Import");
    expect(document.querySelector("[aria-label='Main navigation'] a[href='#/import']")?.getAttribute("aria-current")).toBe("page");
  });

  it("applies a validated appearance pushed by the main-process file watcher", async () => {
    await render();
    await act(async () => appearanceListeners.forEach((listener) => listener(appearanceConfiguration({ themeId: "rose-pine", mode: "dark" }))));
    expect(document.documentElement.dataset.theme).toBe("rose-pine");
    expect(document.documentElement.dataset.appearance).toBe("dark");
  });

  it("reports background sync in the header and reloads the page when changes arrive", async () => {
    let push: (status: unknown) => void = () => undefined;
    const run = vi.fn().mockResolvedValue({ status: "complete", bootstrapped: 0, pushed: 0, superseded: 0, pulled: 0 });
    const listBooks = vi.fn().mockResolvedValue([]);
    override({
      sync: { run, status: vi.fn().mockResolvedValue({ state: "idle" }), onStatus: (listener) => { push = listener as typeof push; return () => undefined; } },
      library: { listBooks },
    });
    await render();
    const state = () => document.querySelector(".ui-header [role='status']");
    expect(state()?.textContent).toBe("Ready to sync");
    expect(state()?.getAttribute("href")).toBe("#/settings");

    await click(document.querySelector("button[aria-label='Sync now']"));
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => { push({ state: "syncing" }); await tick(); });
    expect(state()?.textContent).toBe("Syncing…");
    expect(document.querySelector("button[aria-label='Sync now']")?.getAttribute("aria-busy")).toBe("true");

    const loads = listBooks.mock.calls.length;
    await act(async () => {
      push({ state: "idle", lastFinishedAt: 1, lastResult: { status: "complete", bootstrapped: 0, pushed: 0, superseded: 0, pulled: 3 } });
      await tick();
      await tick();
    });
    expect(state()?.textContent).toBe("Synced");
    expect(listBooks.mock.calls.length).toBeGreaterThan(loads);

    await act(async () => { push({ state: "idle", lastFinishedAt: 2, lastResult: { status: "failed", bootstrapped: 0, pushed: 0, superseded: 0, pulled: 0, problem: { phase: "connect", kind: "stopped", message: "The provider rejected the credentials." } } }); await tick(); });
    expect(state()?.textContent).toBe("Sync failed");
    expect(state()?.getAttribute("title")).toBe("The provider rejected the credentials.");
  });

  it("keeps the local-only line when no sync provider is set up", async () => {
    await render();
    expect(document.querySelector(".ui-header [role='status']")?.textContent).toBe("Saved locally");
    expect(document.querySelector("button[aria-label='Sync now']")).toBeNull();
  });
});

describe("settings", () => {
  it("keeps optional service setup behind calm disclosures", async () => {
    await render("#/settings");
    const optional = Array.from(document.querySelectorAll("details"))
      .filter((details) => ["Optional AI", "Remote library"].some((label) => details.querySelector("summary")?.textContent?.includes(label)));
    expect(optional).toHaveLength(2);
    expect(optional.every((details) => !details.open)).toBe(true);
    await click(optional[0]?.querySelector("summary"));
    expect(optional[0]?.open).toBe(true);
  });

  it("asks before replacing the local library from a backup", async () => {
    const restore = vi.fn();
    override({ backups: { restore } });
    await render("#/settings");
    await click(button("Restore backup"));
    expect(confirmation()?.textContent).toContain("replaces your local library");
    await click(button("Cancel", confirmation()));
    expect(restore).not.toHaveBeenCalled();
  });

  it("checks for updates only when asked and asks before installing one", async () => {
    const check = vi.fn().mockResolvedValue({ state: "available", currentVersion: "0.1.0", version: "0.2.0", releasedAt: "2026-10-01T00:00:00.000Z", notesUrl: "https://github.com/Ka1Thakkar/leaflogue/releases/tag/v0.2.0" });
    const install = vi.fn();
    const setAutomaticCheck = vi.fn().mockResolvedValue({ automaticCheck: true });
    override({ updates: { check, install, setAutomaticCheck } });
    await render("#/settings");
    expect(check).not.toHaveBeenCalled();
    const automatic = Array.from(document.querySelectorAll("label")).find((label) => label.textContent?.includes("Check for updates automatically"))?.querySelector("input");
    expect(automatic?.checked).toBe(false);
    await click(automatic);
    expect(setAutomaticCheck).toHaveBeenCalledWith(true);
    await click(button("Check for updates"));
    expect(document.body.textContent).toContain("Leaflogue 0.2.0 is available.");
    await click(button("Install and restart"));
    expect(confirmation()?.textContent).toContain("checks that it was signed by Leaflogue");
    await click(button("Cancel", confirmation()));
    expect(install).not.toHaveBeenCalled();
  });

  it("saves and applies a built-in appearance as soon as it is chosen", async () => {
    await render("#/settings");
    await pickTheme("rose-pine");
    expect(saveAppearance).toHaveBeenLastCalledWith({ themeId: "rose-pine", mode: "system" });
    await choose(labelledSelect("Appearance mode"), "dark");
    expect(saveAppearance).toHaveBeenLastCalledWith({ themeId: "rose-pine", mode: "dark" });
    expect(document.documentElement.dataset.theme).toBe("rose-pine");
    expect(document.documentElement.dataset.appearance).toBe("dark");
  });

  it("reaches and operates the appearance controls from the keyboard", async () => {
    await render("#/settings");
    const themeCard = document.querySelector<HTMLInputElement>("input[type='radio'][name='Theme']:checked");
    for (const control of [themeCard, labelledSelect("Appearance mode")]) {
      if (!control) throw new Error("An appearance control is missing");
      expect(control.getAttribute("aria-label")).toBeTruthy();
      expect(control.closest("[aria-hidden='true']")).toBeNull();
      expect(control.tabIndex).toBeGreaterThanOrEqual(0);
      control.focus();
      expect(document.activeElement).toBe(control);
    }
    // Arrow keys in a native select fire change and nothing else, so this is
    // the whole keyboard path to a new theme.
    await choose(labelledSelect("Appearance mode"), "dark");
    expect(document.documentElement.dataset.appearance).toBe("dark");
  });

  it("exports the chosen theme and applies an imported one", async () => {
    const exportTheme = vi.fn().mockResolvedValue({ fileName: "nord-custom.json", themeName: "Nord custom" });
    const imported = { ...appearanceConfiguration({ themeId: "nord", mode: "dark" }) };
    const importTheme = vi.fn().mockResolvedValue(imported);
    override({ appearance: { exportTheme, importTheme } });
    await render("#/settings");
    await click(button("Export theme"));
    expect(exportTheme).toHaveBeenCalledWith("leaflogue");
    expect(document.body.textContent).toContain("Exported Nord custom to nord-custom.json.");
    await click(button("Import theme"));
    expect(importTheme).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.theme).toBe("nord");
    expect(chosenTheme()).toBe("nord");
    expect(document.body.textContent).toContain("Imported Nord and made it your theme.");
  });

  it("lists dropped-in themes and names the files it skipped, with why", async () => {
    const custom = { ...appearanceConfiguration().themes.find(({ id }) => id === "nord")!, id: "dusk", name: "Dusk" };
    const openThemesFolder = vi.fn().mockResolvedValue("/home/reader/.config/leaflogue/themes");
    override({ appearance: { openThemesFolder, describe: vi.fn().mockResolvedValue(appearanceConfiguration(undefined, "Skipped themes/loose.json: Custom theme file permissions must be 0600", [custom])) } });
    await render("#/settings");
    const card = document.querySelector<HTMLInputElement>("input[name='Theme'][value='dusk']")?.closest("label");
    expect(card?.textContent).toContain("From your folder");
    const skipped = Array.from(document.querySelectorAll("[role='alert']")).find((element) => element.textContent?.includes("loose.json"));
    expect(skipped?.textContent).toContain("themes/loose.json: Custom theme file permissions must be 0600");
    await click(button("Open folder"));
    expect(openThemesFolder).toHaveBeenCalledOnce();
  });

  it("keeps the current theme when an import is refused", async () => {
    override({ appearance: { importTheme: vi.fn().mockRejectedValue(new Error("contrast")), exportTheme: vi.fn() } });
    await render("#/settings");
    await click(button("Import theme"));
    expect(document.body.textContent).toContain("Your current theme was kept.");
    expect(chosenTheme()).toBe("leaflogue");
  });

  it("offers the default Gemini catalog and shows its warning only when enabling it", async () => {
    const save = vi.fn().mockResolvedValue({ enabled: true, selectedProvider: "gemini", providers: [
      { id: "gemini", models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"], defaultModel: "gemini-3.8-flash", selectedModel: "gemini-3.8-flash", capabilities: ["chat", "structured-output"], credential: "missing" },
    ] });
    override({ ai: { describe: vi.fn().mockResolvedValue({ enabled: false, providers: [
      { id: "gemini", models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"], defaultModel: "gemini-3.8-flash", selectedModel: "gemini-3.8-flash", capabilities: ["chat", "structured-output"], credential: "missing" },
    ] }), save } });
    await render("#/settings");
    const provider = labelledSelect("AI provider");
    expect((await selectOptions(provider)).map(({ text }) => text)).toEqual(["Google Gemini"]);
    expect((await selectOptions(labelledSelect("AI model"))).map(({ value }) => value)).toEqual(["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    expect(document.body.textContent).not.toContain("Google may use free-tier Gemini prompts");
    await click(document.querySelector('input[aria-label="Enable AI features"]'));
    await click(button("Save AI settings"));
    expect(confirmation()?.textContent).toContain("Google may use free-tier Gemini prompts");
    expect(save).not.toHaveBeenCalled();
    await click(button("Continue with Gemini", confirmation()));
    expect(save).toHaveBeenCalledOnce();
  });

  it("protects an unsaved provider secret from accidental in-app navigation", async () => {
    override({ ai: { describe: vi.fn().mockResolvedValue({ enabled: false, providers: [
      { id: "gemini", models: ["gemini-3.8-flash"], defaultModel: "gemini-3.8-flash", selectedModel: "gemini-3.8-flash", capabilities: ["chat"], credential: "missing" },
    ] }) } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await render("#/settings");
    const key = document.querySelector<HTMLInputElement>('input[aria-label="AI API key"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(key, "unsaved-secret");
      key.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
    });
    await click(document.querySelector('a[href="#/library"]'));
    expect(confirm).toHaveBeenLastCalledWith("Leave Settings? Your unsaved changes will be discarded.");
    expect(window.location.hash).toBe("#/settings");
    expect(document.querySelector("h1")?.textContent).toBe("Settings");
  });

  it("shows a terminal error when appearance configuration cannot be read", async () => {
    describeAppearance.mockRejectedValueOnce(new Error("unreadable"));
    await render("#/settings");
    expect(Array.from(document.querySelectorAll("[role='alert']")).some((alert) => alert.textContent?.includes("current safe theme was kept"))).toBe(true);
    expect(document.body.textContent).not.toContain("Reading appearance…");
  });

  it("shows the effective filesystem layout and cannot check an unsaved connection", async () => {
    await render("#/settings");
    const storage = Array.from(document.querySelectorAll("details"))
      .find((element) => element.textContent?.includes("Storage locations"));
    expect(storage?.textContent).toContain(".config/leaflogue/config.json");
    expect(button("Check connection")?.disabled).toBe(true);
    expect(button("Sync now")?.disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Connected. This database has not been initialized");
  });

  it("runs PostgreSQL sync only from the explicit Settings action", async () => {
    const summary = { configured: true, provider: "postgres", source: "config", host: "db.example", database: "leaflogue", transport: "tls" } as const;
    const run = vi.fn().mockResolvedValue({ status: "complete", bootstrapped: 1, pushed: 3, superseded: 1, pulled: 2 });
    describeRemote.mockResolvedValue(summary);
    override({ sync: { run } });
    await render("#/settings");
    expect(run).not.toHaveBeenCalled();
    await click(button("Sync now"));
    expect(run).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Sync complete. 3 sent, 2 received, 1 already current.");
  });

  it("shows that a PostgreSQL connection is saved without revealing it", async () => {
    describeRemote.mockResolvedValue({ configured: true, provider: "postgres", source: "config", host: "db.example", database: "leaflogue", transport: "tls" });
    await render("#/settings");
    const remote = Array.from(document.querySelectorAll("details")).find((element) => element.querySelector("summary")?.textContent?.includes("Remote library"));
    expect(remote?.querySelector("summary")?.textContent).toContain("PostgreSQL · db.example");
    const url = remote?.querySelector<HTMLInputElement>('input[type="password"]');
    expect(url?.placeholder).toContain("••••");
    expect(url?.placeholder).toContain("leave blank to keep");
    expect(url?.required).toBe(false);
    expect(url?.value).toBe("");
  });

  it("shows an incompatible Convex error without contradictory initialization guidance", async () => {
    const summary = { configured: true, provider: "convex", source: "config", host: "quiet-otter-123.convex.cloud", deployment: "quiet-otter-123", transport: "tls" } as const;
    describeRemote.mockResolvedValue(summary);
    checkRemote.mockResolvedValue({ ...summary, reachable: true, initialized: false, problem: "This desktop supports Convex schema 6; the deployment reports schema 7." });
    await render("#/settings");
    await click(button("Check connection"));
    expect(document.querySelector("[role='alert']")?.textContent).toContain("deployment reports schema 7");
    expect(container?.textContent).not.toContain("database has not been initialized");
    expect(button("Initialize schema")).toBeUndefined();
  });

  it("saves a Convex sync key write-only and offers Sync now only once a key is saved", async () => {
    const withoutKey = { configured: true, provider: "convex", source: "config", host: "quiet-otter-123.convex.cloud", deployment: "quiet-otter-123", transport: "tls", syncKeySaved: false } as const;
    const save = vi.fn().mockResolvedValue({ ...withoutKey, syncKeySaved: true });
    const run = vi.fn().mockResolvedValue({ status: "complete", bootstrapped: 0, pushed: 1, superseded: 0, pulled: 0 });
    describeRemote.mockResolvedValue(withoutKey);
    override({ remote: { save }, sync: { run } });
    await render("#/settings");
    expect(button("Sync now")).toBeUndefined();
    const key = container!.querySelector<HTMLInputElement>('input[type="password"][minlength="32"]')!;
    expect(key.required).toBe(true);
    const secret = "k".repeat(44);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(key, secret);
      key.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
    });
    await click(button("Save connection"));
    expect(save).toHaveBeenCalledWith({ provider: "convex", deploymentUrl: "", location: "default", syncKey: secret });
    expect(key.value).toBe("");
    expect(document.body.textContent).not.toContain(secret);
    await click(button("Sync now"));
    expect(run).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Sync complete. 1 sent");
  });

  it("asks before preserving an over-limit legacy attachment as a standalone note", async () => {
    const noteId = "99999999-9999-4999-8999-999999999999" as NoteId;
    const summary = { configured: true, provider: "convex", source: "config",
      host: "quiet-otter-123.convex.cloud", deployment: "quiet-otter-123",
      transport: "tls", syncKeySaved: true } as const;
    const run = vi.fn()
      .mockResolvedValueOnce({ status: "migration-review-required", bootstrapped: 0, pushed: 0,
        superseded: 0, pulled: 0, migration: { updated: 2, detached: 0,
          reviewNoteId: noteId, reviewReason: "oversized" } })
      .mockResolvedValueOnce({ status: "complete", bootstrapped: 0, pushed: 0,
        superseded: 0, pulled: 0, migration: { updated: 1, detached: 1 } });
    describeRemote.mockResolvedValue(summary);
    override({ sync: { run } });
    await render("#/settings");
    await click(button("Sync now"));
    expect(confirmation()?.textContent).toContain("standalone note");
    expect(run).toHaveBeenCalledOnce();
    await click(button("Keep and continue", confirmation()));
    expect(run).toHaveBeenNthCalledWith(1);
    expect(run).toHaveBeenNthCalledWith(2, { confirmDetachNoteId: noteId });
    expect(document.body.textContent).toContain("preserved 1 as standalone notes");
  });

  it("exports the local library and reports a useful receipt", async () => {
    await render("#/settings");
    await click(button("Export your library"));
    await click(Array.from(document.querySelectorAll("label")).find((label) => label.textContent?.startsWith("JSON"))?.querySelector("input"));
    await click(button("Export", document.querySelector("dialog[open]") as HTMLElement));
    expect(createExport).toHaveBeenCalledOnce();
    expect(Array.from(document.querySelectorAll("[role='status']"))
      .some((element) => element.textContent?.includes("Exported 2 books, 3 highlights, and 4 notes to Leaflogue-library.json.")))
      .toBe(true);
  });

  it("exports Markdown into a folder and names it", async () => {
    const createMarkdown = vi.fn().mockResolvedValue({ folderName: "Leaflogue Markdown 2026-10-05", booksExported: 2, highlightsExported: 3, notesExported: 4 });
    override({ exports: { createMarkdown } });
    await render("#/settings");
    await click(button("Export your library"));
    const archived = Array.from(document.querySelectorAll("label")).find((label) => label.textContent?.includes("Include archived books"))?.querySelector("input");
    expect(archived?.checked).toBe(true);
    await click(archived);
    await click(button("Export", document.querySelector("dialog[open]") as HTMLElement));
    expect(createMarkdown).toHaveBeenCalledWith({ includeArchived: false });
    expect(document.body.textContent).toContain("Saved 2 books as Markdown in “Leaflogue Markdown 2026-10-05”.");
  });
});

describe("in the web app", () => {
  async function asWebApp(patch: Parameters<typeof override>[0] = {}) {
    const current = await bridge().system.getCapabilities();
    const host = { kind: "web", backend: "server", account: "reader@example.test" } as const;
    // The bridge names its host at once; the capabilities say so again once read.
    override({ ...patch, host, system: { ...patch.system, getCapabilities: vi.fn().mockResolvedValue({ ...current, host }) } });
  }

  it("says the library is online instead of on this computer", async () => {
    await asWebApp();
    await render();
    const state = document.querySelector(".ui-header [role='status']");
    expect(state?.textContent).toBe("Saved online");
    expect(state?.getAttribute("title")).toBe("Signed in as reader@example.test");
    expect(document.querySelector("button[aria-label='Sync now']")).toBeNull();
  });

  it("keeps Settings to what a browser can do, with a way to sign out", async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    await asWebApp({ session: { signOut } });
    await render("#/settings");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Signed in as reader@example.test.");
    for (const hidden of ["Storage locations", "Backups", "Updates", "Your data", "Remote library", "Import theme"]) expect(text).not.toContain(hidden);
    expect(document.querySelector("input[aria-label='AI API key']")).toBeNull();
    await click(button("Sign out"));
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("names the reader's Convex deployment and offers another", async () => {
    const current = await bridge().system.getCapabilities();
    const changeDeployment = vi.fn().mockResolvedValue(undefined);
    override({
      session: { signOut: vi.fn(), changeDeployment },
      system: { getCapabilities: vi.fn().mockResolvedValue({ ...current, host: { kind: "web", backend: "convex", deployment: "https://quiet-otter-123.convex.cloud", account: "reader@example.test" } }) },
    });
    await render("#/settings");
    expect(document.body.textContent).toContain("Your library is on quiet-otter-123.convex.cloud.");
    await click(button("Use a different deployment"));
    expect(changeDeployment).toHaveBeenCalledOnce();
  });

  it("imports from a chosen file, not a folder or a plugged-in reader", async () => {
    const listReaders = vi.fn().mockResolvedValue([{ id: "a".repeat(32), kind: "kobo", label: "KOBOeReader" }]);
    await asWebApp({ imports: { listReaders } });
    await render("#/import");
    expect(button("Choose file")).toBeDefined();
    expect(button("Choose folder")).toBeUndefined();
    expect(listReaders).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Files are read in this browser");
  });

  it("customises the dashboards with Leaflogue's own widgets only", async () => {
    const evaluate = vi.fn();
    await asWebApp({ widgets: { evaluate } });
    await render("#/statistics");
    await click(button("Customise"));
    const tray = document.querySelector("[aria-label='Add widgets']");
    expect(tray).not.toBeNull();
    expect(button("New widget")).toBeUndefined();
    expect(button("Import widgets")).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("hides the themes folder and theme files, which live on a computer", async () => {
    await asWebApp();
    await render("#/settings");
    expect(document.body.textContent).not.toContain("Themes folder");
    expect(button("Open folder")).toBeUndefined();
    expect(button("Export theme")).toBeUndefined();
    expect(document.querySelector("nav[aria-label='Settings sections']")?.textContent).toBe("AppearanceAccountOptional AI");
  });
});

describe("first-run setup", () => {
  it("shows exact storage paths and completes a local-only setup", async () => {
    const current = await bridge().system.getCapabilities();
    const completeSetup = vi.fn().mockResolvedValue({ ...current, setupRequired: false });
    override({ system: {
      getCapabilities: vi.fn().mockResolvedValue({ ...current, setupRequired: true }),
      completeSetup,
    } });
    await render("#/library");
    const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-labelledby="setup-title"]');
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain(current.storagePaths.configFile);
    expect(dialog?.textContent).toContain(current.storagePaths.libraryFile);
    await click(button("Continue", dialog ?? document));
    expect(dialog?.textContent).toContain("Would you like a remote library?");
    await click(button("Continue", dialog ?? document));
    expect(dialog?.textContent).toContain("Remote sync");
    expect(dialog?.textContent).toContain("Not configured");
    await click(button("Open Leaflogue", dialog ?? document));
    expect(completeSetup).toHaveBeenCalledOnce();
    expect(document.querySelector('dialog[aria-labelledby="setup-title"]')).toBeNull();
    // The wizard has no trigger to return focus to; the reader starts at the page.
    expect(document.activeElement?.id).toBe("content");
  });

  it("can defer optional services without saving a remote credential", async () => {
    const current = await bridge().system.getCapabilities();
    const completeSetup = vi.fn().mockResolvedValue({ ...current, setupRequired: false });
    const save = vi.fn();
    override({
      system: { getCapabilities: vi.fn().mockResolvedValue({ ...current, setupRequired: true }), completeSetup },
      remote: { save },
    });
    await render("#/library");
    await click(button("Set up later"));
    expect(completeSetup).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it("saves a PostgreSQL URL transiently and reviews only redacted connection state", async () => {
    const current = await bridge().system.getCapabilities();
    const save = vi.fn().mockResolvedValue({ configured: true, provider: "postgres", source: "config", host: "db.example.test", database: "leaflogue", transport: "tls" });
    const check = vi.fn().mockResolvedValue({ configured: true, provider: "postgres", source: "config", host: "db.example.test", database: "leaflogue", transport: "tls", reachable: true, initialized: true, schemaVersion: 7 });
    override({
      system: { getCapabilities: vi.fn().mockResolvedValue({ ...current, setupRequired: true }) },
      remote: { save, check },
    });
    await render("#/library");
    const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-labelledby="setup-title"]')!;
    await click(button("Continue", dialog));
    const postgres = Array.from(dialog.querySelectorAll("label")).find((label) => label.textContent?.includes("PostgreSQL"));
    await click(postgres);
    await click(button("Continue", dialog));
    const input = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
    const secret = "postgresql://reader:very-secret@db.example.test/leaflogue?sslmode=require";
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, secret);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
    });
    await click(button("Save and check", dialog));
    expect(save).toHaveBeenCalledWith({ provider: "postgres", databaseUrl: secret, location: "default" });
    expect(check).toHaveBeenCalledOnce();
    expect(dialog.textContent).toContain("db.example.test");
    expect(dialog.textContent).not.toContain("very-secret");
  });
});

describe("library", () => {
  const books: Book[] = [
    { id: firstBookId, title: "Piranesi", authors: ["Susanna Clarke"], status: "reading", archived: false, createdAt: 1, updatedAt: 1, revision: 1, highlightCount: 1 },
    { id: secondBookId, title: "The Left Hand of Darkness", authors: ["Ursula K. Le Guin"], status: "unread", archived: false, createdAt: 1, updatedAt: 2, revision: 1, highlightCount: 0 },
  ];
  const collection = { id: collectionId, name: "Quiet wonders", description: "Close attention", bookCount: 1, createdAt: 1, updatedAt: 1, revision: 1 } as const;
  const tag = { id: tagId, name: "Revisit", bookCount: 1, highlightCount: 0, createdAt: 1, updatedAt: 1, revision: 1 } as const;

  function installLibrary() {
    let currentBooks = books.map((book) => ({ ...book }));
    let history: ReadingStatusEvent[] = [{ id: "72ed4f39-f7e7-40ae-8c5b-450ce678c0e1" as never, bookId: firstBookId, status: "reading", source: "reader", changedAt: 1, bookRevision: 1 }];
    const listReadingStatusHistory = vi.fn().mockImplementation(async () => ({ events: history, hasMore: false }));
    const setBookReadingStatus = vi.fn().mockImplementation(async ({ id, status, expectedRevision }: SetBookReadingStatus) => {
      const updated = { ...currentBooks.find((book) => book.id === id)!, status, revision: expectedRevision + 1 };
      currentBooks = currentBooks.map((book) => book.id === id ? updated : book);
      const event = { id: "83fe504a-081a-4ced-99dc-b6141266e1f2" as never, bookId: id, status, source: "reader" as const, changedAt: 2, bookRevision: updated.revision };
      history = [event, ...history];
      return { changed: true, book: updated, event };
    });
    const setBookCompletionDate = vi.fn().mockImplementation(async ({ id, completedOn, expectedRevision }: SetBookCompletionDate) => {
      const current = currentBooks.find((book) => book.id === id)!;
      const updated = { ...current, completedOn, revision: expectedRevision + 1 };
      currentBooks = currentBooks.map((book) => book.id === id ? updated : book);
      return updated;
    });
    const setBookCollection = vi.fn().mockResolvedValue({ bookId: firstBookId, collectionIds: [], tagIds: [tagId], highlightTags: [] });
    const updateCollection = vi.fn().mockResolvedValue(collection);
    const createHighlight = vi.fn().mockResolvedValue(entry());
    const ensure = vi.fn().mockResolvedValue({
      selection: { id: "582d4f52-e5cb-455f-a314-278b9253758e", localDay: "2026-09-24", timezone: "UTC", highlightId, candidateDigest: "a", recentHighlightIds: [], selectedAt: 1, updatedAt: 1, revision: 1 },
      passage: { highlightId, bookId: firstBookId, bookTitle: "Piranesi", authors: ["Susanna Clarke"], text: "Every room of the House keeps its weather.", notes: [] },
      hasAlternatives: true,
    });
    override({
      library: {
        listBooks: vi.fn().mockImplementation(async () => currentBooks),
        getBookContents: vi.fn().mockImplementation(async (id) => ({ book: currentBooks.find((book) => book.id === id), highlights: [], standaloneNotes: [] })),
        listHighlights: vi.fn().mockImplementation(async (query: HighlightQuery) => ({ entries: query.bookId === firstBookId ? [entry()] : [], hasMore: false })),
        listReadingStatusHistory,
        setBookReadingStatus,
        setBookCompletionDate,
        createHighlight,
      },
      organization: {
        listCollections: vi.fn().mockResolvedValue([collection]),
        listTags: vi.fn().mockResolvedValue([tag]),
        getBook: vi.fn().mockImplementation(async (id) => ({ bookId: id, collectionIds: id === firstBookId ? [collectionId] : [], tagIds: id === firstBookId ? [tagId] : [], highlightTags: [] })),
        updateCollection,
        setBookCollection,
      },
      daily: { ensure },
    });
    return { createHighlight, ensure, listReadingStatusHistory, setBookCollection, setBookCompletionDate, setBookReadingStatus, updateCollection };
  }

  it("filters the shelf by collection and tag and sorts it like the reference", async () => {
    installLibrary();
    await render();
    const titles = () => Array.from(document.querySelectorAll("a[aria-label^='Open '] h2")).map((heading) => heading.textContent);
    expect(titles()).toEqual(["Piranesi", "The Left Hand of Darkness"]);
    await choose(labelledSelect("Sort by"), "recent");
    expect(titles()).toEqual(["The Left Hand of Darkness", "Piranesi"]);
    await choose(labelledSelect("Collection"), collectionId);
    expect(titles()).toEqual(["Piranesi"]);
    await choose(labelledSelect("Collection"), "");
    await choose(labelledSelect("Tag"), tagId);
    expect(titles()).toEqual(["Piranesi"]);
  });

  it("pins today's highlight inside the library and asks for another only on request", async () => {
    const { ensure } = installLibrary();
    await render();
    const daily = document.querySelector("[aria-labelledby='daily-heading']");
    expect(daily?.textContent).toContain("Every room of the House keeps its weather.");
    expect(daily?.querySelector("a[aria-label='Open book']")?.getAttribute("href")).toBe(`#/library/${firstBookId}?highlight=${highlightId}`);
    await click(button("Another passage", daily ?? document));
    expect(ensure).toHaveBeenLastCalledWith(expect.objectContaining({ another: true }));
  });

  it("marks and focuses the passage a link opens on the book page", async () => {
    installLibrary();
    await render(`#/library/${firstBookId}?highlight=${highlightId}`);
    const article = document.getElementById(`highlight-${highlightId}`);
    expect(article?.getAttribute("aria-current")).toBe("true");
    expect(article?.hasAttribute("data-focused")).toBe(true);
    expect(document.activeElement).toBe(article);
    expect(document.querySelectorAll("article[data-focused]")).toHaveLength(1);
  });

  it("does not show a daily card before any passage exists", async () => {
    installLibrary();
    const statistics = await window.leaflogue.statistics.get();
    override({
      library: { listBooks: vi.fn().mockResolvedValue(books.map((book) => ({ ...book, highlightCount: 0 }))) },
      statistics: { get: vi.fn().mockResolvedValue({ ...statistics, totals: { ...statistics.totals, highlights: 0, notes: 0 }, days: [], books: [] }) },
    });
    await render();
    expect(document.querySelector("[aria-labelledby='daily-heading']")).toBeNull();
  });

  it("renames a collection without discarding its stored description", async () => {
    const { updateCollection } = installLibrary();
    await render();
    await click(button("Collections"));
    await click(button("Rename Quiet wonders"));
    const form = document.querySelector<HTMLInputElement>(`#collection-${collectionId}`)?.closest("form");
    await act(async () => { form?.requestSubmit(); await tick(); await tick(); });
    expect(updateCollection).toHaveBeenCalledWith({ id: collectionId, name: "Quiet wonders", description: "Close attention", expectedRevision: 1 });
  });

  it("changes reading status and refreshes its visible timeline", async () => {
    const { setBookReadingStatus } = installLibrary();
    await render(`#/library/${firstBookId}`);
    const status = labelledSelect("Reading status");
    expect(status?.value).toBe("reading");
    await choose(status, "paused");
    expect(setBookReadingStatus).toHaveBeenCalledWith({ id: firstBookId, status: "paused", expectedRevision: 1 });
    expect(document.querySelector("[aria-label='Reading history']")?.textContent).toContain("Paused");
    expect(labelledSelect("Reading status")?.value).toBe("paused");
  });

  it("renders a resolved cover and applies its sampled accent to the book workspace", async () => {
    installLibrary();
    const source = "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg";
    override({
      library: { getBookContents: vi.fn().mockResolvedValue({ book: { ...books[0], coverUrl: source }, highlights: [], standaloneNotes: [] }) },
      covers: { resolve: vi.fn().mockResolvedValue({ url: "leaflogue://cover/abc", accent: "rgb(235 111 146)" }), cancel: vi.fn().mockResolvedValue(undefined) },
    });
    await render(`#/library/${firstBookId}`);
    const image = document.querySelector<HTMLImageElement>('img[alt="Cover of Piranesi"]');
    expect(image?.getAttribute("src")).toBe("leaflogue://cover/abc");
    expect(document.querySelector<HTMLElement>('[style*="--book-accent"]')?.style.getPropertyValue("--book-accent")).toBe("rgb(235 111 146)");
  });

  it("keeps a saved status when only its history refresh fails", async () => {
    const { listReadingStatusHistory, setBookReadingStatus } = installLibrary();
    await render(`#/library/${firstBookId}`);
    listReadingStatusHistory.mockRejectedValueOnce(new Error("refresh unavailable"));
    await choose(labelledSelect("Reading status"), "paused");
    expect(setBookReadingStatus).toHaveBeenCalledOnce();
    expect(labelledSelect("Reading status")?.value).toBe("paused");
    expect(document.querySelector("[role='alert']")?.textContent).toContain("Reading history could not be refreshed.");
    expect(document.body.textContent).not.toContain("changed elsewhere");
  });

  it("edits a finished book's completion date in place", async () => {
    const { setBookCompletionDate } = installLibrary();
    await render(`#/library/${firstBookId}`);
    await choose(labelledSelect("Reading status"), "finished");
    const completionDate = document.querySelector<HTMLInputElement>("input[aria-label='Completion date']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(completionDate, "2024-02-29");
      completionDate.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
      await tick();
    });
    expect(setBookCompletionDate).toHaveBeenCalledWith({ id: firstBookId, completedOn: "2024-02-29", expectedRevision: 2 });
    expect(document.querySelector<HTMLInputElement>("input[aria-label='Completion date']")?.value).toBe("2024-02-29");
  });

  it("discloses a truncated timeline and preserves state after a stale mutation", async () => {
    const { listReadingStatusHistory, setBookReadingStatus } = installLibrary();
    listReadingStatusHistory.mockResolvedValue({ events: [{ id: "72ed4f39-f7e7-40ae-8c5b-450ce678c0e1" as never, bookId: firstBookId, status: "reading", source: "reader", changedAt: 1, bookRevision: 1 }], hasMore: true });
    await render(`#/library/${firstBookId}`);
    expect(document.body.textContent).toContain("Showing the latest 100 changes.");
    setBookReadingStatus.mockRejectedValueOnce(new Error("stale revision"));
    await choose(labelledSelect("Reading status"), "paused");
    expect(labelledSelect("Reading status")?.value).toBe("reading");
    expect(document.body.textContent).toContain("changed elsewhere");
  });

  it("edits metadata as one revision-checked replacement and resets a field from its import", async () => {
    installLibrary();
    const updateBookMetadata = vi.fn().mockImplementation(async (input: UpdateBookMetadata) => ({ ...books[0], ...input, revision: input.expectedRevision + 1 }));
    override({ library: {
      updateBookMetadata,
      getBookContents: vi.fn().mockResolvedValue({ book: { ...books[0], language: "en", publisher: "My edition" }, highlights: [], standaloneNotes: [] }),
      getMetadataSource: vi.fn().mockResolvedValue({ sourceName: "Kobo Clara", lastSeenAt: 1, values: { title: "Piranesi", authors: ["Susanna Clarke"], publisher: "Bloomsbury", language: "en" } }),
    } });
    await render(`#/library/${firstBookId}`);

    await click(button("Edit metadata"));
    const form = document.querySelector<HTMLFormElement>("main form")!;
    form.querySelector<HTMLInputElement>("input[name='title']")!.value = " Piranesi (annotated) ";
    form.querySelector<HTMLTextAreaElement>("textarea[name='authors']")!.value = "Susanna Clarke; A. Reader";
    await act(async () => { form.requestSubmit(); await tick(); await tick(); });
    expect(updateBookMetadata).toHaveBeenLastCalledWith({
      id: firstBookId, expectedRevision: 1, title: " Piranesi (annotated) ", authors: ["Susanna Clarke", "A. Reader"], publisher: "My edition", language: "en",
    });
    expect(document.querySelector("h1")?.textContent).toBe(" Piranesi (annotated) ");

    await click(button("Reset metadata field"));
    const dialog = document.querySelector("dialog[open]")!;
    expect(Array.from(dialog.querySelectorAll("li strong")).map(({ textContent }) => textContent)).toEqual(["Title", "Authors", "Publisher"]);
    const publisherRow = Array.from(dialog.querySelectorAll("li")).find((row) => row.textContent?.includes("Publisher"))!;
    await click(button("Reset", publisherRow));
    expect(updateBookMetadata).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 2, publisher: "Bloomsbury", title: " Piranesi (annotated) " }));
  });

  it("removes a book from a collection through the searchable picker", async () => {
    const { setBookCollection } = installLibrary();
    await render(`#/library/${firstBookId}`);
    const picker = Array.from(document.querySelectorAll("details")).find((details) => details.querySelector("summary")?.textContent?.startsWith("Collections"));
    const option = Array.from(picker?.querySelectorAll<HTMLInputElement>("input[type='checkbox']") ?? [])
      .find((input) => input.closest("label")?.textContent?.includes("Quiet wonders"));
    expect(option?.checked).toBe(true);
    await click(option);
    expect(setBookCollection).toHaveBeenCalledWith({ bookId: firstBookId, collectionId, included: false });
  });

  it("keeps the extra highlight filters behind a Filters toggle and counts the active ones", async () => {
    installLibrary();
    await render("#/highlights");
    const toggle = button("Filters")!;
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    await click(toggle);
    expect(panel.hidden).toBe(false);
    await choose(labelledSelect("Notes"), "with");
    expect(toggle.textContent).toContain("1");
  });

  it("keeps passage controls as named icon buttons beside the passage", async () => {
    installLibrary();
    await render(`#/library/${firstBookId}`);
    const passage = document.querySelector(`#highlight-${highlightId}`);
    expect(passage?.textContent).toContain("Every room of the House keeps its weather.");
    for (const name of ["Add to thematic thread", "Manage tags", "Add another note", "Edit quote"]) {
      const control = button(name, passage ?? document);
      expect(control?.getAttribute("title")).toBe(name);
      expect(control?.textContent?.trim()).toBe("");
    }
    expect(button("Add highlight")?.getAttribute("title")).toBe("Add highlight");
  });

  it("creates a passage and its first note through one atomic mutation", async () => {
    const { createHighlight } = installLibrary();
    await render(`#/library/${firstBookId}`);
    await click(button("Add highlight"));
    const form = document.querySelector("textarea[name='text']")!.closest("form")!;
    form.querySelector<HTMLTextAreaElement>("textarea[name='text']")!.value = "A remembered passage";
    form.querySelector<HTMLTextAreaElement>("textarea[name='note']")!.value = "Why it matters";
    await act(async () => { form.requestSubmit(); await tick(); await tick(); });
    expect(createHighlight).toHaveBeenCalledWith({
      bookId: firstBookId,
      text: "A remembered passage",
      noteMarkdown: "Why it matters",
    });
  });

  it("places the cursor in a dialog form's first field when it opens", async () => {
    installLibrary();
    await render("#/library");
    // Browsers refuse focus inside a closed dialog, which this DOM does not
    // model, so record whether the dialog was already open at focus time.
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const openWhenFocused = new Map<string, boolean>();
    focus.mockImplementation(function (this: HTMLElement) {
      const name = this.getAttribute("name");
      if (name) openWhenFocused.set(name, this.closest("dialog")?.open === true);
    });
    try {
      await click(button("Add book"));
    } finally {
      focus.mockRestore();
    }
    expect(openWhenFocused.get("title")).toBe(true);
  });

  it("replaces an empty book's empty state with its first new passage", async () => {
    const { createHighlight } = installLibrary();
    let saved: HighlightListEntry[] = [];
    const listHighlights = vi.fn().mockImplementation(async () => ({ entries: saved, hasMore: false }));
    createHighlight.mockImplementation(async () => {
      saved = [entry({ text: "The first passage kept here." })];
      return saved[0];
    });
    override({ library: { listHighlights } });
    await render(`#/library/${firstBookId}`);
    expect(document.body.textContent).toContain("No highlights yet");

    await click(button("Add highlight"));
    const form = document.querySelector("textarea[name='text']")!.closest("form")!;
    form.querySelector<HTMLTextAreaElement>("textarea[name='text']")!.value = "The first passage kept here.";
    await act(async () => { form.requestSubmit(); await tick(); await tick(); });

    expect(listHighlights).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("The first passage kept here.");
    expect(document.body.textContent).not.toContain("No highlights yet");
  });
});

describe("highlights", () => {
  it("loads the next passages when the end of the list comes into view", async () => {
    const observers: { callback: IntersectionObserverCallback; elements: Element[] }[] = [];
    class FakeObserver {
      readonly elements: Element[] = [];
      constructor(readonly callback: IntersectionObserverCallback) { observers.push(this); }
      observe(element: Element) { this.elements.push(element); }
      disconnect() { this.elements.length = 0; }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    try {
      const page = (start: number) => Array.from({ length: 20 }, (_, index) => entry({ id: `20000000-0000-4000-8000-${String(start + index).padStart(12, "0")}` as HighlightId }));
      const listHighlights = vi.fn()
        .mockResolvedValueOnce({ entries: page(0), hasMore: true })
        .mockResolvedValueOnce({ entries: page(20), hasMore: false });
      override({ library: { listHighlights, listBooks: vi.fn().mockResolvedValue([]) } });
      await render("#/highlights");
      const watching = observers.filter(({ elements }) => elements.length > 0).at(-1)!;
      await act(async () => {
        watching.callback([{ isIntersecting: true } as IntersectionObserverEntry], watching as unknown as IntersectionObserver);
        await tick();
        await tick();
      });
      expect(listHighlights).toHaveBeenLastCalledWith({ sort: "oldest", offset: 20, limit: 20 });
      expect(document.querySelectorAll("article[id^='highlight-']")).toHaveLength(40);
      expect(button("Load more highlights")).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists passages across books and pages through bounded queries", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => entry({ id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}` as HighlightId }));
    const listHighlights = vi.fn()
      .mockResolvedValueOnce({ entries: firstPage, hasMore: true })
      .mockResolvedValueOnce({ entries: [entry({ id: "30000000-0000-4000-8000-000000000000" as never, bookId: secondBookId, bookTitle: "Middlemarch", text: "A growing good." })], hasMore: false })
      .mockResolvedValue({ entries: [], hasMore: false });
    override({ library: { listHighlights, listBooks: vi.fn().mockResolvedValue([]) } });
    await render("#/highlights");
    expect(listHighlights).toHaveBeenCalledWith({ sort: "oldest", offset: 0, limit: 20 });
    expect(document.querySelector("article a")?.getAttribute("href")).toBe(`#/library/${firstBookId}`);
    await click(button("Load more highlights"));
    // Only the next page is read; what is already shown is not fetched again.
    expect(listHighlights).toHaveBeenLastCalledWith({ sort: "oldest", offset: 20, limit: 20 });
    expect(document.body.textContent).toContain("A growing good.");
    expect(document.querySelectorAll("article[id^='highlight-']")).toHaveLength(21);
    expect(button("Load more highlights")).toBeUndefined();

    await choose(labelledSelect("Notes"), "with");
    expect(listHighlights).toHaveBeenLastCalledWith({ notes: "with", sort: "oldest", offset: 0, limit: 20 });
    expect(document.body.textContent).toContain("No matching passages");
    await click(button("Clear filters"));
    expect(listHighlights).toHaveBeenLastCalledWith({ sort: "oldest", offset: 0, limit: 20 });
  });

  it("uses automatic relevance ordering while searching", async () => {
    const listHighlights = vi.fn().mockResolvedValue({ entries: [], hasMore: false });
    override({ library: { listHighlights, listBooks: vi.fn().mockResolvedValue([]) } });
    await render("#/highlights");
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Find a word you kept…"]');
    if (!input) throw new Error("Search input is missing");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "house");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
      await tick();
    });
    expect(listHighlights).toHaveBeenLastCalledWith({ search: "house", sort: "relevance", offset: 0, limit: 20 });
    expect(document.body.textContent).toContain("Search results are sorted by relevance");
    expect((await selectOptions(labelledSelect("Sort by"))).map(({ value }) => value)).not.toContain("relevance");
  });

  it("keeps imported source locations as provenance without rendering or editing them", async () => {
    const sourceLocation = "OEBPS/Text/chapter_004.xhtml#point(/1/4/2:17)";
    const listHighlights = vi.fn().mockResolvedValue({
      entries: [entry({ sourceLocation, imported: true })],
      hasMore: false,
    });
    const updateHighlight = vi.fn().mockResolvedValue(entry({ sourceLocation, imported: true, revision: 4 }));
    override({ library: { listHighlights, listBooks: vi.fn().mockResolvedValue([]), updateHighlight } });
    await render("#/highlights");

    expect(document.body.textContent).not.toContain(sourceLocation);
    await click(button("Edit quote"));
    const form = document.querySelector<HTMLFormElement>("main form")!;
    expect(form.querySelector("[name='location']")).toBeNull();
    form.querySelector<HTMLTextAreaElement>("textarea[name='text']")!.value = "Edited without exposing provenance";
    await act(async () => { form.requestSubmit(); await tick(); await tick(); });

    expect(updateHighlight).toHaveBeenCalledWith({
      id: highlightId,
      bookId: firstBookId,
      text: "Edited without exposing provenance",
      sourceLocation,
      expectedRevision: 3,
    });
  });

  it("deletes a passage or note with its current revision only after confirmation", async () => {
    const note = { id: "10000000-0000-4000-8000-000000000001" as never, bookId: firstBookId, highlightId, markdown: "Keep this", origin: "reader" as const, createdAt: 1, updatedAt: 1, revision: 2 };
    const listHighlights = vi.fn()
      .mockResolvedValueOnce({ entries: [entry({ notes: [note] })], hasMore: false })
      .mockResolvedValueOnce({ entries: [entry()], hasMore: false })
      .mockResolvedValue({ entries: [], hasMore: false });
    const deleteHighlight = vi.fn().mockResolvedValue({ bookId: firstBookId, bookRevision: 9, revision: 4, notesDeleted: 0 });
    const deleteNote = vi.fn().mockResolvedValue({ bookId: firstBookId, bookRevision: 8, revision: 3, notesDeleted: 1 });
    override({ library: { listHighlights, listBooks: vi.fn().mockResolvedValue([]), deleteHighlight, deleteNote } });
    await render("#/highlights");

    await click(button("Delete note"));
    expect(confirmation()?.textContent).toContain("This cannot be undone.");
    expect(deleteNote).not.toHaveBeenCalled();
    await click(button("Delete note", confirmation()));
    expect(deleteNote).toHaveBeenCalledWith({ id: note.id, bookId: firstBookId, expectedRevision: 2 });
    expect(document.body.textContent).not.toContain("Keep this");

    await click(button("More passage actions"));
    await click(button("Delete highlight"));
    await click(button("Cancel", confirmation()));
    expect(confirmation()).toBeUndefined();
    expect(deleteHighlight).not.toHaveBeenCalled();
    await click(button("More passage actions"));
    await click(button("Delete highlight"));
    expect(confirmation()?.textContent).toContain("This deletes the highlight. This cannot be undone.");
    await click(button("Delete highlight", confirmation()));
    expect(deleteHighlight).toHaveBeenCalledWith({ id: highlightId, bookId: firstBookId, expectedRevision: 3 });
    expect(document.body.textContent).toContain("No highlights yet");
  });

  it("shows and revision-safely restores the latest imported passage", async () => {
    const listHighlights = vi.fn().mockResolvedValue({ entries: [entry({ imported: true, text: "My edited passage" })], hasMore: false });
    const getHighlightSource = vi.fn().mockResolvedValue({
      sourceName: "Kobo",
      text: "The original passage",
      location: "Chapter 4",
      note: "Original note",
      differs: true,
      resetToken: "a".repeat(64),
    });
    const resetHighlightToSource = vi.fn().mockResolvedValue(entry({ text: "The original passage", revision: 4 }));
    override({ library: { listHighlights, listBooks: vi.fn().mockResolvedValue([]), getHighlightSource, resetHighlightToSource } });
    await render("#/highlights");

    await click(button("View imported original"));
    expect(getHighlightSource).toHaveBeenCalledWith(firstBookId, highlightId);
    expect(document.querySelector("dialog[open]")?.textContent).toContain("The original passage");
    expect(document.querySelector("dialog[open]")?.textContent).toContain("Original note");
    await click(button("Reset to imported original"));
    expect(confirmation()?.textContent).toContain("Your edits will be overwritten.");
    expect(resetHighlightToSource).not.toHaveBeenCalled();
    await click(button("Reset passage", confirmation()));

    expect(resetHighlightToSource).toHaveBeenCalledWith({
      id: highlightId, bookId: firstBookId, expectedRevision: 3, resetToken: "a".repeat(64),
    });
    expect(document.querySelector("dialog[open]")).toBeNull();
  });

  it("does not invite a duplicate write when a committed edit cannot refresh", async () => {
    const listHighlights = vi.fn()
      .mockResolvedValueOnce({ entries: [entry()], hasMore: false })
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    const updateHighlight = vi.fn().mockResolvedValue(entry({ text: "A changed passage", revision: 4 }));
    override({ library: { listHighlights, listBooks: vi.fn().mockResolvedValue([]), updateHighlight } });
    await render("#/highlights");

    await click(button("Edit quote"));
    const form = document.querySelector<HTMLFormElement>("main form")!;
    form.querySelector<HTMLTextAreaElement>("textarea[name='text']")!.value = "A changed passage";
    await act(async () => { form.requestSubmit(); await tick(); await tick(); });

    expect(updateHighlight).toHaveBeenCalledOnce();
    expect(Array.from(document.querySelectorAll("[role='alert']")).some((alert) => alert.textContent?.includes("was saved, but this view could not refresh"))).toBe(true);
    expect(button("Saved")?.disabled).toBe(true);
    await act(async () => { form.requestSubmit(); await tick(); });
    expect(updateHighlight).toHaveBeenCalledOnce();
  });

  it("assigns a passage to a thread with its current revision", async () => {
    const thread = { id: threadId, name: "Impossible architecture", passageCount: 0, createdAt: 1, updatedAt: 1, revision: 1 };
    const setHighlightMembership = vi.fn()
      .mockResolvedValueOnce({ changed: true, bookId: firstBookId, highlightId, highlightRevision: 4, threadIds: [threadId] })
      .mockResolvedValueOnce({ changed: true, bookId: firstBookId, highlightId, highlightRevision: 5, threadIds: [] });
    override({
      library: { listHighlights: vi.fn().mockResolvedValue({ entries: [entry()], hasMore: false }), listBooks: vi.fn().mockResolvedValue([]) },
      threads: { list: vi.fn().mockResolvedValue([thread]), getHighlightMembership: vi.fn().mockResolvedValue([]), setHighlightMembership },
    });
    await render("#/highlights");
    await click(button("Add to thematic thread"));
    await click(button("Threads"));
    const option = () => Array.from(document.querySelectorAll<HTMLInputElement>("dialog input[type='checkbox']"))
      .find((input) => input.closest("label")?.textContent?.includes("Impossible architecture"));
    await click(option());
    expect(setHighlightMembership).toHaveBeenCalledWith({ bookId: firstBookId, highlightId, threadIds: [threadId], expectedHighlightRevision: 3 });
    expect(option()?.checked).toBe(true);
    await click(option());
    expect(setHighlightMembership).toHaveBeenLastCalledWith({ bookId: firstBookId, highlightId, threadIds: [], expectedHighlightRevision: 4 });
  });
});

describe("markdown", () => {
  it("shows passages as written and notes as Markdown, dropping raw HTML and keeping links inside the app", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    override({
      system: { openExternal },
      library: {
        listBooks: vi.fn().mockResolvedValue([]),
        listHighlights: vi.fn().mockResolvedValue({ entries: [entry({
          text: "A **starred** line\n\n    an indented line",
          notes: [{ id: "10000000-0000-4000-8000-000000000001" as never, bookId: firstBookId, highlightId, markdown: "- A **bold** idea <img src=x onerror=alert(1)>\n- [safe](https://example.test/a) [unsafe](javascript:alert(1)) [local](http://example.test)", origin: "reader", createdAt: 1, updatedAt: 1, revision: 1 }],
        })], hasMore: false }),
      },
    });
    await render("#/highlights");
    const passage = document.querySelector(`#highlight-${highlightId}`)!;
    const quote = passage.querySelector("blockquote")!;
    expect(quote.querySelector("strong, pre, code")).toBeNull();
    expect(quote.textContent).toContain("A **starred** line");
    expect(quote.textContent).toContain("an indented line");
    const note = passage.querySelector("ul")!;
    expect(note.querySelector("strong")?.textContent).toBe("bold");
    expect(passage.querySelector("img")).toBeNull();
    expect(passage.innerHTML).not.toContain("onerror");
    const links = Array.from(note.querySelectorAll<HTMLAnchorElement>("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://example.test/a"]);
    expect(note.textContent).toContain("unsafe");
    await click(links[0]);
    expect(openExternal).toHaveBeenCalledWith("https://example.test/a");
    expect(window.location.hash).toBe("#/highlights");
  });
});

describe("explaining a passage with AI", () => {
  const enabledAi = {
    enabled: true,
    selectedProvider: "gemini",
    providers: [{ id: "gemini", models: ["gemini-3.8-flash"], defaultModel: "gemini-3.8-flash", selectedModel: "gemini-3.8-flash", capabilities: ["chat"], credential: "saved" as const, consented: false }],
  };
  const disclosure = {
    disclosureId: "dddddddd-0000-4000-8000-000000000000",
    providerId: "gemini",
    providerName: "Google Gemini",
    model: "gemini-3.8-flash",
    trainsOnFreeTier: true,
    consented: false,
    bookTitle: "Piranesi",
    authors: ["Susanna Clarke"],
    passage: "Every room of the House keeps its weather.",
    notes: [],
  };

  it("offers no AI action at all while AI is switched off", async () => {
    override({ library: { listHighlights: vi.fn().mockResolvedValue({ entries: [entry()], hasMore: false }), listBooks: vi.fn().mockResolvedValue([]) } });
    await render("#/highlights");
    expect(button("Explain this passage")).toBeUndefined();
  });

  it("reflects saved AI settings in the Assistant tab without claiming a configured provider is disabled", async () => {
    const describe = vi.fn().mockResolvedValue({ ...enabledAi, enabled: false });
    override({ ai: { describe } });
    await render("#/highlights");
    await click(button("Open context panel"));
    await click(document.querySelector("#context-assistant-tab"));
    expect(document.querySelector("#context-assistant")?.textContent).toContain("AI is disabled.");
    describe.mockResolvedValue(enabledAi);
    await act(async () => { window.dispatchEvent(new Event("leaflogue:ai-saved")); await tick(); });
    expect(document.querySelector("#context-assistant")?.textContent).toContain("Your AI provider is ready.");
    expect(document.querySelector("#context-assistant")?.textContent).not.toContain("AI is disabled.");
  });

  it("shows what would be sent, records consent once, and returns the explanation", async () => {
    const acceptTerms = vi.fn().mockResolvedValue({ ...enabledAi, providers: [{ ...enabledAi.providers[0], consented: true }] });
    const explainPassage = vi.fn().mockResolvedValue({ providerId: "gemini", model: "gemini-3.8-flash", explanation: "A house read as a presence.", saveable: true });
    override({
      library: { listHighlights: vi.fn().mockResolvedValue({ entries: [entry()], hasMore: false }), listBooks: vi.fn().mockResolvedValue([]) },
      ai: { describe: vi.fn().mockResolvedValue(enabledAi), describeExplainTask: vi.fn().mockResolvedValue(disclosure), acceptTerms, explainPassage, cancel: vi.fn() },
    });
    await render("#/highlights");
    await click(button("Explain this passage"));

    const dialog = document.querySelector("#context-assistant")!;
    expect(dialog.textContent).toContain("has not sent anything to Google Gemini yet");
    expect(dialog.textContent).toContain("Every room of the House keeps its weather.");
    expect(dialog.textContent).toContain("may be used to improve their products");
    expect(explainPassage).not.toHaveBeenCalled();

    await click(button("Send to Google Gemini", dialog));
    expect(acceptTerms).toHaveBeenCalledWith("gemini");
    expect(explainPassage).toHaveBeenCalledWith(expect.objectContaining({
      disclosureId: disclosure.disclosureId,
    }));
    expect(dialog.textContent).toContain("A house read as a presence.");
    expect(dialog.textContent).toContain("check it against the book");
  });

  it("lists the book details it would send alongside the passage before a provider's first use", async () => {
    override({
      library: { listHighlights: vi.fn().mockResolvedValue({ entries: [entry()], hasMore: false }), listBooks: vi.fn().mockResolvedValue([]) },
      ai: {
        describe: vi.fn().mockResolvedValue(enabledAi),
        describeExplainTask: vi.fn().mockResolvedValue({ ...disclosure, series: "The House", seriesNumber: "1", publisher: "Bloomsbury", description: "A man lives in a house of endless halls." }),
        acceptTerms: vi.fn(), explainPassage: vi.fn(), cancel: vi.fn(),
      },
    });
    await render("#/highlights");
    await click(button("Explain this passage"));
    const dialog = document.querySelector("#context-assistant")!;
    expect(dialog.textContent).toContain("Asking about this passage transmits");
    expect(dialog.textContent).toContain("The House, book 1");
    expect(dialog.textContent).toContain("Bloomsbury");
    expect(dialog.querySelector("details summary")?.textContent).toBe("The book's description is sent too");
    expect(dialog.querySelector("details")?.textContent).toContain("A man lives in a house of endless halls.");
  });

  it("explains straight away once the provider is accepted, then answers follow-ups", async () => {
    const explainPassage = vi.fn()
      .mockResolvedValueOnce({ providerId: "gemini", model: "gemini-3.8-flash", explanation: "A house read as a presence.", saveable: true })
      .mockResolvedValueOnce({ providerId: "gemini", model: "gemini-3.8-flash", explanation: "The tides stand for memory.", saveable: true });
    const followUpDisclosure = { ...disclosure, disclosureId: "eeeeeeee-0000-4000-8000-000000000000", consented: true };
    const describeExplainTask = vi.fn().mockResolvedValueOnce({ ...disclosure, consented: true }).mockResolvedValue(followUpDisclosure);
    override({
      library: { listHighlights: vi.fn().mockResolvedValue({ entries: [entry()], hasMore: false }), listBooks: vi.fn().mockResolvedValue([]) },
      ai: { describe: vi.fn().mockResolvedValue(enabledAi), describeExplainTask, acceptTerms: vi.fn(), explainPassage, cancel: vi.fn() },
    });
    await render("#/highlights");
    await click(button("Explain this passage"));
    const dialog = document.querySelector("#context-assistant")!;
    expect(explainPassage).toHaveBeenCalledTimes(1);
    expect(explainPassage.mock.calls[0]?.[0]).not.toHaveProperty("followUp");
    expect(dialog.textContent).toContain("A house read as a presence.");

    const field = dialog.querySelector<HTMLTextAreaElement>("textarea[name='question']")!;
    await act(async () => { field.value = "What do the tides mean?"; await tick(); });
    await click(button("Send question", dialog));
    expect(explainPassage).toHaveBeenLastCalledWith(expect.objectContaining({
      disclosureId: followUpDisclosure.disclosureId,
      followUp: { question: "What do the tides mean?", history: [
        { role: "reader", text: "Explain this passage." },
        { role: "companion", text: "A house read as a presence." },
      ] },
    }));
    expect(dialog.textContent).toContain("What do the tides mean?");
    expect(dialog.textContent).toContain("The tides stand for memory.");
    await click(document.querySelector("#context-reader-tab"));
    await click(document.querySelector("#context-assistant-tab"));
    expect(dialog.textContent).toContain("The tides stand for memory.");
    expect(explainPassage).toHaveBeenCalledTimes(2);
  });

  it("saves an answer as an AI note the passage then shows", async () => {
    const createNote = vi.fn().mockResolvedValue({});
    const listHighlights = vi.fn()
      .mockResolvedValueOnce({ entries: [entry()], hasMore: false })
      .mockResolvedValue({ entries: [entry({ notes: [{ id: "f1f1f1f1-0000-4000-8000-000000000000" as NoteId, bookId: firstBookId, highlightId, markdown: "A house read as a presence.", origin: "ai", createdAt: 1, updatedAt: 1, revision: 1 }] })], hasMore: false });
    override({
      library: { listHighlights, listBooks: vi.fn().mockResolvedValue([]), createNote },
      ai: {
        describe: vi.fn().mockResolvedValue(enabledAi),
        describeExplainTask: vi.fn().mockResolvedValue({ ...disclosure, consented: true }),
        acceptTerms: vi.fn(),
        explainPassage: vi.fn().mockResolvedValue({ providerId: "gemini", model: "gemini-3.8-flash", explanation: "A house read as a presence.", saveable: true }),
        cancel: vi.fn(),
      },
    });
    await render("#/highlights");
    await click(button("Explain this passage"));

    const dialog = document.querySelector("#context-assistant")!;
    await click(button("Save as note", dialog));
    expect(createNote).toHaveBeenCalledWith({ bookId: firstBookId, highlightId, markdown: "A house read as a presence.", origin: "ai" });
    expect(button("Saved to this highlight", dialog)?.disabled).toBe(true);
    expect(document.body.textContent).toContain("AI note");
  });

  it("offers no save for an answer the companion declined", async () => {
    override({
      library: { listHighlights: vi.fn().mockResolvedValue({ entries: [entry()], hasMore: false }), listBooks: vi.fn().mockResolvedValue([]) },
      ai: {
        describe: vi.fn().mockResolvedValue(enabledAi),
        describeExplainTask: vi.fn().mockResolvedValue({ ...disclosure, consented: true }),
        acceptTerms: vi.fn(),
        explainPassage: vi.fn().mockResolvedValue({ providerId: "gemini", model: "gemini-3.8-flash", explanation: "I can only help discuss this saved passage.", saveable: false }),
        cancel: vi.fn(),
      },
    });
    await render("#/highlights");
    await click(button("Explain this passage"));
    const dialog = document.querySelector("#context-assistant")!;
    expect(dialog.textContent).toContain("I can only help discuss this saved passage.");
    expect(button("Save as note", dialog)).toBeUndefined();
  });

  it("keeps the saved state when only the follow-up refresh fails", async () => {
    const createNote = vi.fn().mockResolvedValue({});
    const listHighlights = vi.fn()
      .mockResolvedValueOnce({ entries: [entry()], hasMore: false })
      .mockRejectedValueOnce(new Error("refresh failed"));
    override({
      library: { listHighlights, listBooks: vi.fn().mockResolvedValue([]), createNote },
      ai: {
        describe: vi.fn().mockResolvedValue(enabledAi),
        describeExplainTask: vi.fn().mockResolvedValue({ ...disclosure, consented: true }),
        acceptTerms: vi.fn(),
        explainPassage: vi.fn().mockResolvedValue({ providerId: "gemini", model: "gemini-3.8-flash", explanation: "A house read as a presence.", saveable: true }),
        cancel: vi.fn(),
      },
    });
    await render("#/highlights");
    await click(button("Explain this passage"));
    const dialog = document.querySelector("#context-assistant")!;
    await click(button("Save as note", dialog));
    expect(button("Saved to this highlight", dialog)?.disabled).toBe(true);
    expect(dialog.textContent).toContain("was saved as a note");
    expect(dialog.textContent).not.toContain("could not be saved");
    expect(button("Try again", dialog)).toBeUndefined();
  });

  it("reports a reached free-tier limit and retries the same question", async () => {
    const explainPassage = vi.fn()
      .mockRejectedValueOnce(new Error("The gemini per-day request limit was reached. Try again in 45 seconds."))
      .mockResolvedValueOnce({ providerId: "gemini", model: "gemini-3.8-flash", explanation: "A house read as a presence.", saveable: true });
    override({
      library: { listHighlights: vi.fn().mockResolvedValue({ entries: [entry()], hasMore: false }), listBooks: vi.fn().mockResolvedValue([]) },
      ai: {
        describe: vi.fn().mockResolvedValue(enabledAi),
        describeExplainTask: vi.fn().mockResolvedValue({ ...disclosure, consented: true }),
        acceptTerms: vi.fn(),
        explainPassage,
        cancel: vi.fn(),
      },
    });
    await render("#/highlights");
    await click(button("Explain this passage"));
    const dialog = document.querySelector("#context-assistant")!;
    expect(dialog.querySelector("[role='alert']")?.textContent)
      .toContain("The gemini per-day request limit was reached. Try again in 45 seconds.");
    await click(button("Try again", dialog));
    expect(explainPassage).toHaveBeenCalledTimes(2);
    expect(dialog.textContent).toContain("A house read as a presence.");
  });
});

describe("threads", () => {
  it("creates a thread and opens its passages from the list", async () => {
    const thread = { id: threadId, name: "Unreliable rooms", description: "Places that resist their maps.", passageCount: 1, createdAt: 1, updatedAt: 1, revision: 1 };
    const create = vi.fn().mockResolvedValue(thread);
    const get = vi.fn().mockResolvedValue({
      thread,
      passages: [{ highlightId, bookId: firstBookId, bookTitle: "Piranesi", authors: ["Susanna Clarke"], text: "The House is kept because it keeps us.", notes: [], addedAt: 1 }],
    });
    override({ threads: { list: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([thread]), create, get } });
    await render("#/threads");
    await click(button("Create your first thread"));
    const form = document.querySelector<HTMLFormElement>("main form");
    form!.querySelector<HTMLInputElement>("input[name='name']")!.value = thread.name;
    form!.querySelector<HTMLTextAreaElement>("textarea[name='description']")!.value = thread.description;
    await act(async () => { form!.requestSubmit(); await tick(); await tick(); });
    expect(create).toHaveBeenCalledWith({ name: thread.name, description: thread.description });
    const open = document.querySelector<HTMLAnchorElement>(`a[href='#/threads/${threadId}']`);
    expect(open?.textContent).toContain("Unreliable rooms");
    await visit(open!.getAttribute("href")!);
    expect(get).toHaveBeenCalledWith(threadId);
    expect(document.body.textContent).toContain("The House is kept because it keeps us.");
  });

  it("opens the most recently added thread beside the list, with figures across the top", async () => {
    const older = { id: "00000000-0000-4000-8000-0000000000f1" as ThreadId, name: "Older idea", passageCount: 1, createdAt: 1, updatedAt: 1, revision: 1 };
    const newer = { id: threadId, name: "Unreliable rooms", description: "Places that resist their maps.", passageCount: 2, createdAt: 1, updatedAt: 1, revision: 1 };
    const passage = (id: string, text: string, addedAt: number) => ({ highlightId: id as HighlightId, bookId: firstBookId, bookTitle: "Piranesi", authors: ["Susanna Clarke"], text, notes: [], addedAt });
    const get = vi.fn().mockImplementation(async (id: ThreadId) => id === threadId
      ? { thread: newer, passages: [passage(highlightId, "The House is kept because it keeps us.", 50), passage("00000000-0000-4000-8000-0000000000f2", "Another room.", 40)] }
      : { thread: older, passages: [passage(highlightId, "The House is kept because it keeps us.", 10)] });
    override({ threads: { list: vi.fn().mockResolvedValue([older, newer]), get } });
    await render("#/threads");
    const rows = [...document.querySelectorAll<HTMLAnchorElement>("nav[aria-label='Your threads'] a")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Unreliable rooms", "Older idea"]);
    expect(rows[0]!.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector("#thread-title")?.textContent).toBe("Unreliable rooms");
    expect(document.body.textContent).toContain("Another room.");
    // Two distinct passages across both threads, out of the library's two.
    expect(document.body.textContent).toContain("100% of your passages");
  });

  it("deletes a thread only after the in-app confirmation", async () => {
    const thread = { id: threadId, name: "Unreliable rooms", passageCount: 1, createdAt: 1, updatedAt: 1, revision: 3 };
    const remove = vi.fn().mockResolvedValue(undefined);
    override({ threads: { list: vi.fn().mockResolvedValue([thread]), get: vi.fn().mockResolvedValue({ thread, passages: [] }), delete: remove } });
    await render("#/threads");

    await click(button("Delete Unreliable rooms"));
    expect(confirmation()?.textContent).toContain("The passages themselves will stay in your library.");
    await click(button("Cancel", confirmation()));
    expect(confirmation()).toBeUndefined();
    expect(remove).not.toHaveBeenCalled();

    await click(button("Delete Unreliable rooms"));
    await click(button("Delete thread", confirmation()));
    expect(remove).toHaveBeenCalledWith({ id: threadId, expectedRevision: 3 });
  });

  it("removes a passage from a thread with the passage's current revision", async () => {
    const thread = { id: threadId, name: "Unreliable rooms", passageCount: 1, createdAt: 1, updatedAt: 1, revision: 1 };
    const setHighlightMembership = vi.fn().mockResolvedValue({ changed: true, bookId: firstBookId, highlightId, highlightRevision: 8, threadIds: [] });
    override({
      library: { getBookContents: vi.fn().mockResolvedValue({ book: {}, highlights: [{ id: highlightId, revision: 7 }], standaloneNotes: [] }) },
      threads: {
        get: vi.fn().mockResolvedValue({ thread, passages: [{ highlightId, bookId: firstBookId, bookTitle: "Piranesi", authors: [], text: "Passage", notes: [], addedAt: 1 }] }),
        getHighlightMembership: vi.fn().mockResolvedValue([threadId]),
        setHighlightMembership,
      },
    });
    await render(`#/threads/${threadId}`);
    await click(button("Remove from thread"));
    expect(setHighlightMembership).toHaveBeenCalledWith({ bookId: firstBookId, highlightId, threadIds: [], expectedHighlightRevision: 7 });
  });

  it("ends loading announcements when initial thread and daily reads fail", async () => {
    override({
      library: { listBooks: vi.fn().mockResolvedValue([{ id: firstBookId, title: "Piranesi", authors: [], status: "reading", archived: false, createdAt: 1, updatedAt: 1, revision: 1, highlightCount: 1 }]) },
      threads: { list: vi.fn().mockRejectedValue(new Error("unavailable")) },
      daily: { ensure: vi.fn().mockRejectedValue(new Error("unavailable")) },
    });
    await render("#/threads");
    expect(document.body.textContent).toContain("could not open your threads");
    expect(document.body.textContent).not.toContain("Opening your threads");
    await visit("#/library");
    expect(document.body.textContent).toContain("Today's highlight could not be chosen");
    expect(document.body.textContent).not.toContain("Preparing today's passage");
  });
});

describe("imports", () => {
  it("reviews a file inside the import tool, commits it, and reports it in notifications", async () => {
    const commit = vi.fn().mockResolvedValue({ booksCreated: 1, booksReused: 0, highlightsCreated: 2, annotationsUpdated: 1, notesCreated: 1, conflictsCreated: 1 });
    override({
      imports: {
        chooseFile: vi.fn().mockResolvedValue({
          token: "0f7b7f76-5ba7-4b59-8f0d-4c1a5f8c2c1b",
          fileName: "KoboReader.sqlite",
          provider: "kobo",
          sourceProfiles: [],
          newSourceId: "9b3b2cca-0e42-4423-ae4e-c1318247095c",
          suggestedSourceName: "Kobo — KoboReader",
          preview: { document: { formatVersion: 1, books: [{ providerRecordId: "book", title: "Piranesi", authors: ["Susanna Clarke"] }], annotations: [] }, warnings: [] },
        }),
        commit,
      },
    });
    await render();
    await click(button("Import"));
    const dialog = document.querySelector("main");
    expect(dialog?.querySelector("h1")?.textContent).toBe("Import");
    await click(button("Choose file", dialog!));
    expect(dialog?.textContent).toContain("KoboReader.sqlite (Kobo database)");
    await click(button("Import highlights and notes", dialog!));
    expect(commit).toHaveBeenCalledWith({ token: "0f7b7f76-5ba7-4b59-8f0d-4c1a5f8c2c1b", sourceId: "9b3b2cca-0e42-4423-ae4e-c1318247095c", newSourceName: "Kobo — KoboReader" });
    expect(dialog?.textContent).toContain("Import complete: 3 added, 1 updated, 1 new book.");
    expect(dialog?.querySelector("a[href='#/import/conflicts']")?.textContent).toContain("1 conflicting version saved for review");
    expect(document.querySelector("section[aria-label='Import notifications']")?.textContent).toContain("KoboReader.sqlite");
  });
});

describe("statistics", () => {
  it("shows totals, charts with text alternatives, and the most highlighted books", async () => {
    await render("#/statistics");
    expect(document.querySelector("h1")?.textContent).toBe("Your reading");
    expect(document.body.textContent).toContain("Books on your shelf");
    const tables = Array.from(document.querySelectorAll("figure.ui-bars table"));
    const months = tables.find((table) => table.querySelector("caption")?.textContent === "Highlights in the last twelve months");
    expect(months?.querySelector("tbody tr td")?.textContent).toBe("2");
    expect(document.body.textContent).toContain("No finished book has a finish date yet.");
    expect(document.body.textContent).toContain("What these numbers use");
    expect(document.querySelector(`a[href='#/library/${firstBookId}']`)?.textContent).toBe("Piranesi");
  });
});

describe("customising a dashboard", () => {
  it("removes, adds, and resizes widgets, then saves the layout", async () => {
    const save = vi.fn().mockImplementation(async (dashboard: string, layout: unknown) => (layout ? { [dashboard]: layout } : {}));
    override({ dashboards: { describe: vi.fn().mockResolvedValue({}), save } });
    await render("#/statistics");
    await click(button("Customise"));
    await click(button("Remove By weekday"));
    expect(document.body.textContent).not.toContain("Passages by weekday");
    await click(button("Notes"));
    await choose(document.querySelector<HTMLButtonElement>("[role='combobox'][aria-label='Highlights by month width']"), "full");
    await click(button("Done"));
    const [dashboard, layout] = save.mock.calls[0] as [string, { widget: string; width?: string }[]];
    expect(dashboard).toBe("statistics");
    expect(layout.map(({ widget }) => widget)).not.toContain("weekdays");
    expect(layout.findIndex(({ widget }) => widget === "notes")).toBe(6);
    expect(layout.find(({ widget }) => widget === "months")).toEqual({ widget: "months", width: "full" });
    expect(button("Customise")).toBeDefined();
  });

  it("uses a saved layout and stores the default as no layout", async () => {
    const save = vi.fn().mockResolvedValue({});
    override({ dashboards: { describe: vi.fn().mockResolvedValue({ statistics: [{ widget: "lengths" }] }), save } });
    await render("#/statistics");
    expect(document.body.textContent).toContain("Passage length");
    expect(document.body.textContent).not.toContain("Books on your shelf");
    await click(button("Customise"));
    await click(button("Default layout"));
    await click(button("Done"));
    expect(save).toHaveBeenCalledWith("statistics", null);
    expect(document.body.textContent).toContain("Books on your shelf");
  });

  it("offers the passage and reading widgets only to add, and shows them once added", async () => {
    override({ dashboards: { describe: vi.fn().mockResolvedValue({ statistics: [{ widget: "reading-now" }, { widget: "hours" }, { widget: "pick-up" }, { widget: "on-this-day" }] }), save: vi.fn() } });
    await render("#/statistics");
    expect(document.body.textContent).toContain("Currently reading");
    expect(document.querySelector<HTMLAnchorElement>("a[href*='#/library/']")?.textContent).toBe("Piranesi");
    expect(document.body.textContent).toContain("mostly at night");
    // Piranesi has no passage date here, so it counts as waiting.
    expect(document.body.textContent).toContain("Pick back up");
    expect(document.body.textContent).toContain("in earlier years");
  });

  it("leaves the new widgets off the default pages", async () => {
    await render("#/statistics");
    for (const title of ["Currently reading", "Time of day", "Recently kept", "Pick back up", "On this day"]) {
      expect(document.body.textContent).not.toContain(title);
    }
    await click(button("Customise"));
    for (const title of ["Currently reading", "Time of day", "Recently kept", "Pick back up", "On this day"]) {
      expect(button(title)).toBeDefined();
    }
  });

  it("shows widgets placed after the books below them on the library page", async () => {
    const save = vi.fn().mockImplementation(async (dashboard: string, layout: unknown) => ({ [dashboard]: layout }));
    override({ dashboards: { describe: vi.fn().mockResolvedValue({ library: [{ widget: "passages" }, { widget: "shelf" }, { widget: "lengths" }] }), save } });
    await render("#/library");
    const shelf = [...document.querySelectorAll("h2")].find((heading) => heading.textContent === "A place for what stays with you.")!;
    const lengths = [...document.querySelectorAll("h2")].find((heading) => heading.textContent === "Passage length")!;
    expect(shelf.compareDocumentPosition(lengths) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click(button("Customise"));
    expect(document.body.textContent).not.toContain("A place for what stays with you.");
    await click(button("Move your books later"));
    await click(button("Done"));
    expect(save).toHaveBeenCalledWith("library", [{ widget: "passages" }, { widget: "lengths" }, { widget: "shelf" }]);
  });

  it("puts the edit back with Cancel", async () => {
    const save = vi.fn();
    override({ dashboards: { describe: vi.fn().mockResolvedValue({}), save } });
    await render("#/statistics");
    await click(button("Customise"));
    await click(button("Remove What these numbers use"));
    await click(button("Cancel"));
    expect(document.body.textContent).toContain("What these numbers use");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("custom widgets", () => {
  const favourites = { id: "favourites", version: 1, title: "Favourites by weekday", count: "passages", groupBy: "weekday", where: [{ field: "tag", is: "Favourite" }], show: "bars", sort: "label", limit: 24 } as const;
  const groups = { kind: "groups", groups: [{ key: "mon", label: "Mon", value: 3 }, { key: "tue", label: "Tue", value: 1 }], total: 4, missing: 0, hidden: 0 } as const;

  function dialog(): HTMLDialogElement {
    const open = document.querySelector<HTMLDialogElement>("dialog[open][aria-labelledby$='-heading']");
    if (!open) throw new Error("The widget builder is not open");
    return open;
  }

  function field(label: string): HTMLInputElement | HTMLButtonElement {
    const element = Array.from(dialog().querySelectorAll("label")).find((candidate) => candidate.textContent?.startsWith(label))?.control
      ?? dialog().querySelector<HTMLButtonElement>(`[role="combobox"][aria-label='${label}']`);
    if (!(element instanceof HTMLInputElement || element instanceof HTMLButtonElement)) throw new Error(`Field ${label} is missing`);
    return element;
  }

  async function type(input: HTMLInputElement | HTMLButtonElement, value: string): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
    });
  }

  it("builds a widget with a live preview, saves it, and places it on the page", async () => {
    const evaluate = vi.fn().mockImplementation(async (widgets: readonly { groupBy?: string; show: string }[]) => widgets.map((widget) => (
      widget.groupBy === "tag" ? { kind: "groups", groups: [{ key: "favourite", label: "Favourite", value: 4 }], total: 4, missing: 0, hidden: 0 } : groups
    )));
    const saveWidget = vi.fn().mockImplementation(async (widget: unknown) => ({ widgets: [widget] }));
    const save = vi.fn().mockImplementation(async (dashboard: string, layout: unknown) => ({ [dashboard]: layout }));
    override({ dashboards: { describe: vi.fn().mockResolvedValue({}), save }, widgets: { evaluate, save: saveWidget } });
    await render("#/statistics");
    await click(button("Customise"));
    await click(button("New widget"));
    await type(field("Title"), "Favourites by weekday");
    await choose(field("Group by") as HTMLButtonElement, "weekday");
    await click(button("Add a filter", dialog()));
    await choose(field("Filter 1 field") as HTMLButtonElement, "tag");
    // The filter offers the tags in this library.
    const value = field("Filter 1 value") as HTMLButtonElement;
    await choose(value, "Favourite");
    expect(value.textContent).toContain("Favourite");
    await choose(value, "Favourite");
    // The preview draws the count with the shared charts.
    expect(dialog().querySelector("figure.ui-bars caption")?.textContent).toBe("Favourites by weekday");
    expect(dialog().textContent).toContain("Only where tag is Favourite.");
    await click(button("Add widget", dialog()));
    expect(saveWidget).toHaveBeenCalledWith({ id: "favourites-by-weekday", version: 1, title: "Favourites by weekday", count: "passages", groupBy: "weekday", where: [{ field: "tag", is: "Favourite" }], show: "bars", limit: 24, sort: "label" });
    expect(document.querySelector("dialog[open][aria-labelledby$='-heading']")).toBeNull();
    await click(button("Done"));
    const [, layout] = save.mock.calls[0] as [string, { widget: string }[]];
    expect(layout.at(-1)).toEqual({ widget: "custom:favourites-by-weekday" });
  });

  it("asks for a title before saving", async () => {
    const saveWidget = vi.fn();
    override({ widgets: { save: saveWidget } });
    await render("#/statistics");
    await click(button("Customise"));
    await click(button("New widget"));
    await click(button("Add widget", dialog()));
    expect(saveWidget).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("Give the widget a title.");
  });

  it("shows a saved custom widget and edits it from its toolbar", async () => {
    const evaluate = vi.fn().mockImplementation(async (widgets: readonly unknown[]) => widgets.map(() => groups));
    const saveWidget = vi.fn().mockImplementation(async (widget: unknown) => ({ widgets: [widget], statistics: [{ widget: "custom:favourites" }] }));
    override({
      dashboards: { describe: vi.fn().mockResolvedValue({ widgets: [favourites], statistics: [{ widget: "passages" }, { widget: "custom:favourites" }] }), save: vi.fn() },
      widgets: { evaluate, save: saveWidget },
    });
    await render("#/statistics");
    const caption = Array.from(document.querySelectorAll("figure.ui-bars caption")).find((element) => element.textContent === "Favourites by weekday");
    expect(caption?.closest("figure")?.querySelector("tbody tr td")?.textContent).toBe("3");
    expect(evaluate).toHaveBeenCalledWith([favourites]);
    await click(button("Customise"));
    await click(button("Edit Favourites by weekday"));
    expect((field("Title") as HTMLInputElement).value).toBe("Favourites by weekday");
    await choose(field("Show as") as HTMLButtonElement, "ranked");
    await click(button("Save widget", dialog()));
    expect(saveWidget).toHaveBeenCalledWith({ ...favourites, show: "ranked", limit: 6, sort: "count" });
  });

  it("deletes a custom widget after asking", async () => {
    const deleteWidget = vi.fn().mockResolvedValue({ statistics: [{ widget: "passages" }] });
    override({
      dashboards: { describe: vi.fn().mockResolvedValue({ widgets: [favourites], statistics: [{ widget: "passages" }, { widget: "custom:favourites" }] }), save: vi.fn() },
      widgets: { delete: deleteWidget },
    });
    await render("#/statistics");
    await click(button("Customise"));
    await click(button("Delete Favourites by weekday"));
    expect(confirmation()?.textContent).toContain("Delete “Favourites by weekday”?");
    await click(button("Delete widget", confirmation()));
    expect(deleteWidget).toHaveBeenCalledWith("favourites");
    expect(button("Edit Favourites by weekday")).toBeUndefined();
    // Still customising: the confirmation's buttons did not end the session.
    expect(button("Done")).toBeDefined();
  });

  it("imports widget files into the list of widgets to add", async () => {
    const importWidgets = vi.fn().mockResolvedValue({ layouts: { widgets: [favourites] }, added: ["Favourites by weekday"], unchanged: 1 });
    override({ widgets: { import: importWidgets } });
    await render("#/statistics");
    await click(button("Customise"));
    await click(button("Import widgets"));
    expect(importWidgets).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Added “Favourites by weekday”");
    expect(document.body.textContent).toContain("One widget was already here.");
    await click(button("Favourites by weekday"));
    expect(button("Edit Favourites by weekday")).toBeDefined();
  });

  it("says why an import was refused", async () => {
    override({ widgets: { import: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'widgets:import': Error: bad.json: This is not a Leaflogue widget file")) } });
    await render("#/statistics");
    await click(button("Customise"));
    await click(button("Import widgets"));
    expect(document.body.textContent).toContain("Nothing was imported. bad.json: This is not a Leaflogue widget file");
  });
});

describe("duplicates", () => {
  it("suggests reviewing a likely duplicate book on the library page", async () => {
    override({ library: { findDuplicates: vi.fn().mockResolvedValue({ books: [{ bookIds: [firstBookId, secondBookId], title: "Piranesi" }], passages: [] }) } });
    await render("#/library");
    expect(document.body.textContent).toContain("These may be the same book imported twice.");
    expect(document.querySelector(`a[href='#/library/${firstBookId}?merge=${secondBookId}']`)?.textContent).toBe("Review");
  });
});

describe("connected readers", () => {
  it("offers a plugged-in Kobo and reads it without a file dialog", async () => {
    const chooseFile = vi.fn();
    const chooseReader = vi.fn().mockResolvedValue({
      token: "0f7b7f76-5ba7-4b59-8f0d-4c1a5f8c2c1b",
      fileName: "KoboReader.sqlite",
      provider: "kobo",
      sourceProfiles: [],
      newSourceId: "9b3b2cca-0e42-4423-ae4e-c1318247095c",
      suggestedSourceName: "Kobo — KOBOeReader",
      preview: { document: { formatVersion: 1, books: [{ providerRecordId: "book", title: "Piranesi", authors: [] }], annotations: [] }, warnings: [] },
    });
    override({ imports: { chooseFile, chooseReader, listReaders: vi.fn().mockResolvedValue([{ id: "a".repeat(32), kind: "kobo", label: "KOBOeReader" }]) } });
    await render();
    await click(button("Import"));
    const dialog = document.querySelector("main")!;
    expect(dialog.textContent).toContain("Your Kobo KOBOeReader is plugged in.");
    await click(button("Import from Kobo", dialog));
    expect(chooseReader).toHaveBeenCalledWith("a".repeat(32));
    expect(chooseFile).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain("KoboReader.sqlite (Kobo database)");
  });
});

describe("synced change review", () => {
  const conflictId = "e1b7a0d4-3c55-4b43-9d53-4f7a3b0d2c11";
  const conflict = {
    id: conflictId, kind: "note", bookId: firstBookId, bookTitle: "Piranesi",
    preservedBody: "Written offline on the train", preservedOnThisDevice: true,
    currentBody: "Written on the laptop", passageText: "The House is kept",
    restore: "copy", currentRevision: 4, createdAt: 1,
  };

  it("is announced by the notification bell only while something waits", async () => {
    await render();
    expect(document.querySelector("summary[aria-label='Import notifications']")).not.toBeNull();
    expect(document.querySelector(".ll-notification-count")).toBeNull();

    override({ sync: { listConflicts: vi.fn().mockResolvedValue({ conflicts: [conflict], total: 1 }) } });
    await visit("#/highlights");
    expect(document.querySelector("summary")?.getAttribute("aria-label")).toBe("Notifications, 1 synced version to review");
    expect(document.querySelector(".ll-notification-count")?.textContent).toBe("1");
    expect(document.querySelector(".ll-popover a[href='#/sync/conflicts']")?.textContent).toBe("1 synced version to review");
    expect(document.querySelector(".ll-popover")?.textContent).not.toContain("All caught up.");
  });

  it("compares both versions without device details and restores with the revision shown", async () => {
    const resolveConflict = vi.fn().mockResolvedValue(undefined);
    const listConflicts = vi.fn()
      .mockResolvedValueOnce({ conflicts: [conflict], total: 1 })
      .mockResolvedValue({ conflicts: [], total: 0 });
    override({ sync: { listConflicts, resolveConflict } });
    await render("#/sync/conflicts");
    expect(document.title).toBe("Review synced changes | Leaflogue");
    expect(document.querySelector("h1")?.textContent).toBe("Review synced changes");
    expect(document.body.textContent).toContain("Note written on this device");
    await click(button("Compare versions"));
    const text = document.querySelector(".ll-conflicts")?.textContent ?? "";
    expect(text).toContain("On the passage");
    expect(text).toContain("Written on the laptop");
    expect(text).toContain("Written offline on the train");
    expect(text).toContain("Restoring adds this version as a new note");
    expect(text).toContain("already in your library stays untouched");
    await click(button("Restore this version"));
    expect(resolveConflict).toHaveBeenCalledWith({ id: conflictId, resolution: "restore", expectedRevision: 4 });
    expect(document.querySelector(".ll-empty")?.textContent).toBe("No synced changes need review.");
  });

  it("asks before discarding and offers no restore when the book is archived", async () => {
    const resolveConflict = vi.fn().mockResolvedValue(undefined);
    override({ sync: { listConflicts: vi.fn().mockResolvedValue({
      conflicts: [{ ...conflict, restore: "unavailable", currentBody: undefined }], total: 1,
    }), resolveConflict } });
    await render("#/sync/conflicts");
    await click(button("Compare versions"));
    expect(button("Restore this version")).toBeUndefined();
    expect(document.body.textContent).toContain("This note was deleted.");
    expect(document.body.textContent).toContain("Its book is archived.");
    await click(button("Discard this version"));
    expect(confirmation()?.textContent).toContain("cannot be recovered");
    await click(button("Cancel", confirmation()));
    expect(resolveConflict).not.toHaveBeenCalled();
    await click(button("Discard this version"));
    await act(async () => {
      confirmation()?.dispatchEvent(new Event("cancel", { cancelable: true }));
      await tick();
    });
    expect(confirmation()).toBeUndefined();
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it("refreshes a stale review instead of applying it", async () => {
    const listConflicts = vi.fn().mockResolvedValue({ conflicts: [conflict], total: 1 });
    override({ sync: { listConflicts, resolveConflict: vi.fn().mockRejectedValue(new Error("changed")) } });
    await render("#/sync/conflicts");
    const reads = listConflicts.mock.calls.length;
    await click(button("Compare versions"));
    await click(button("Restore this version"));
    expect(document.querySelector("[role='alert']")?.textContent).toContain("changed while you were reviewing it");
    expect(listConflicts.mock.calls.length).toBeGreaterThan(reads);
  });
});

describe("command palette", () => {
  const books: Book[] = [
    { id: firstBookId, title: "Piranesi", authors: ["Susanna Clarke"], series: "House", status: "reading", archived: false, createdAt: 1, updatedAt: 1, revision: 1, highlightCount: 1 },
    { id: secondBookId, title: "The Left Hand of Darkness", authors: ["Ursula K. Le Guin"], status: "unread", archived: false, createdAt: 1, updatedAt: 2, revision: 1, highlightCount: 0 },
  ];
  const tag = { id: tagId, name: "Revisit", bookCount: 1, highlightCount: 2, createdAt: 1, updatedAt: 1, revision: 1 } as const;
  const thread = { id: threadId, name: "Impossible architecture", passageCount: 1, createdAt: 1, updatedAt: 1, revision: 1 } as const;
  const collection = { id: collectionId, name: "Quiet wonders", bookCount: 1, createdAt: 1, updatedAt: 1, revision: 1 } as const;
  const enabledAi = {
    enabled: true,
    selectedProvider: "gemini",
    providers: [{ id: "gemini", models: ["gemini-3.8-flash"], defaultModel: "gemini-3.8-flash", selectedModel: "gemini-3.8-flash", capabilities: ["chat"], credential: "saved" as const, consented: true }],
  };

  function installPaletteLibrary(listHighlights = vi.fn().mockImplementation(async (query: HighlightQuery) => ({
    entries: query.search
      ? [entry(), entry({ id: "0d5f8b6e-1f7a-4c3e-9b2d-6a1e4f2c8b90" as HighlightId, text: "Statues stand in every hall.", notes: [{ id: "f1c2d3e4-5a6b-4c7d-8e9f-a0b1c2d3e4f5" as NoteId, bookId: firstBookId, highlightId: "0d5f8b6e-1f7a-4c3e-9b2d-6a1e4f2c8b90" as HighlightId, markdown: "The weather of the soul, again.", origin: "reader", createdAt: 1, updatedAt: 1, revision: 1 }] })]
      : query.bookId === firstBookId ? [entry()] : [],
    hasMore: false,
  }))) {
    override({
      library: {
        listBooks: vi.fn().mockResolvedValue(books),
        listHighlights,
        getBookContents: vi.fn().mockImplementation(async (id: BookId) => ({ book: books.find((book) => book.id === id), highlights: [], standaloneNotes: [] })),
      },
      organization: {
        listTags: vi.fn().mockResolvedValue([tag]),
        listCollections: vi.fn().mockResolvedValue([collection]),
        getBook: vi.fn().mockImplementation(async (id: BookId) => ({ bookId: id, collectionIds: [], tagIds: [], highlightTags: [] })),
      },
      threads: { list: vi.fn().mockResolvedValue([thread]) },
    });
    return { listHighlights };
  }

  const palette = () => document.querySelector<HTMLDialogElement>("dialog[aria-label='Search and commands']");
  const field = () => palette()!.querySelector<HTMLInputElement>("[role='combobox']")!;
  const options = () => Array.from(palette()?.querySelectorAll<HTMLElement>("[role='option']") ?? []);
  const titles = () => options().map((option) => option.querySelector("span > span")?.textContent ?? "");
  const groupNames = () => Array.from(palette()?.querySelectorAll("[role='group'] > [role='presentation']") ?? []).map((heading) => heading.textContent);
  const selected = () => options().find((option) => option.getAttribute("aria-selected") === "true");

  async function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? window): Promise<void> {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
      await tick();
      await tick();
    });
  }

  async function openPalette(): Promise<void> {
    await press("k", { ctrlKey: true }, window);
  }

  async function type(text: string): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field(), text);
      field().dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
      await tick();
    });
  }

  /** Let the debounced passage search answer. */
  async function settle(ms = 200): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await tick();
    });
  }

  it("opens with ⌘K (Ctrl K) or the header bar, and gives focus back when closed", async () => {
    installPaletteLibrary();
    await render();
    const bar = document.querySelector<HTMLInputElement>(".ui-header input[aria-label='Search and commands']")!;
    expect(bar).not.toBeNull();
    const start = document.querySelector<HTMLElement>("[aria-label='Main navigation'] a")!;
    start.focus();
    await openPalette();
    expect(palette()?.open).toBe(true);
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute("aria-expanded")).toBe("true");
    expect(field().getAttribute("aria-controls")).toBe(palette()!.querySelector("[role='listbox']")!.id);
    await press("Escape");
    expect(palette()?.open).toBe(false);
    expect(document.activeElement).toBe(start);

    // Focusing the bar (by clicking or tabbing to it) opens the palette.
    await act(async () => { bar.focus(); await tick(); });
    await click(bar);
    expect(palette()?.open).toBe(true);
    expect(document.activeElement).toBe(field());
    // ⌘K again closes it, and the bar it returns to does not reopen it.
    await openPalette();
    expect(palette()?.open).toBe(false);
    expect(document.activeElement).toBe(bar);
    expect(palette()?.open).toBe(false);
  });

  it("shows recent items, this page's commands, and the prefixes before anything is typed", async () => {
    installPaletteLibrary();
    await render();
    await openPalette();
    expect(palette()!.textContent).toContain("Narrow with");
    for (const hint of [">actions", "#tags", "@authors", "/pages and settings"]) expect(palette()!.textContent).toContain(hint);
    // The library adds its own commands, such as managing collections.
    expect(groupNames()).toEqual(["This page", "Pages", "Actions"]);
    expect(titles()).toContain("Manage collections");
    // An action's shortcut is shown beside it.
    const sidebar = options().find((option) => option.textContent?.includes("Expand the sidebar"));
    expect(sidebar?.querySelector("kbd")?.textContent).toBe("Ctrl B");

    await type("pira");
    expect(titles()[0]).toBe("Piranesi");
    await press("Enter");
    expect(window.location.hash).toBe(`#/library/${firstBookId}`);

    await openPalette();
    expect(groupNames()[0]).toBe("Recent");
    expect(titles()[0]).toBe("Piranesi");
    expect((JSON.parse(localStorage.getItem("leaflogue.palette")!) as { recent: unknown[] }).recent[0]).toMatchObject({ key: `book:${firstBookId}`, title: "Piranesi" });
    // The book page's own commands are offered while it is open.
    expect(groupNames()).toContain("This page");
    expect(titles()).toContain("Mark as finished");
  });

  it("moves through results with the arrow keys, wrapping at either end, and runs the selected one", async () => {
    installPaletteLibrary();
    await render();
    await openPalette();
    await type("/");
    const count = options().length;
    expect(count).toBeGreaterThan(3);
    expect(selected()).toBe(options()[0]);
    expect(field().getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    await press("ArrowDown");
    expect(selected()).toBe(options()[1]);
    expect(field().getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    await press("ArrowUp");
    await press("ArrowUp");
    expect(selected()).toBe(options()[count - 1]);
    await press("ArrowDown");
    await press("ArrowDown");
    expect(selected()?.textContent).toContain("Highlights");
    await press("Enter");
    expect(palette()?.open).toBe(false);
    expect(window.location.hash).toBe("#/highlights");
  });

  it("narrows to actions, tags, authors, or pages and settings with a prefix", async () => {
    installPaletteLibrary();
    await render();
    await openPalette();
    await type(">");
    expect(new Set(groupNames())).toEqual(new Set(["Actions", "This page"]));
    expect(titles()).toContain("Add a book");
    expect(titles()).not.toContain("Piranesi");

    await type("#");
    expect(groupNames()).toEqual(["Tags"]);
    expect(titles()).toEqual(["Revisit"]);
    await press("Enter");
    expect(window.location.hash).toBe(`#/highlights?tag=${tagId}`);

    await openPalette();
    await type("@le guin");
    expect(groupNames()).toEqual(["Books"]);
    expect(titles()).toEqual(["The Left Hand of Darkness"]);

    await type("/statistics");
    expect(new Set(groupNames())).toEqual(new Set(["Pages"]));
    await type("/backup");
    expect(groupNames()).toEqual(["Settings"]);
    expect(titles().slice(0, 2)).toEqual(["Create a backup", "Restore a backup"]);
  });

  it("finds books, threads, collections, passages, and notes together, ending with a search of all highlights", async () => {
    const { listHighlights } = installPaletteLibrary();
    await render();
    await openPalette();
    await type("weather");
    // Passages wait for a pause in typing.
    expect(listHighlights).not.toHaveBeenCalledWith(expect.objectContaining({ search: "weather" }));
    await settle();
    expect(listHighlights).toHaveBeenCalledWith({ search: "weather", sort: "relevance", limit: 8 });
    expect(groupNames()).toEqual(expect.arrayContaining(["Passages", "Notes"]));
    expect(titles()).toContain("Every room of the House keeps its weather.");
    expect(titles()).toContain("The weather of the soul, again.");
    expect(groupNames().at(-1)).toBe("Search");
    expect(titles().at(-1)).toBe("Search all highlights for “weather”");

    await press("ArrowUp");
    await press("Enter");
    expect(window.location.hash).toBe("#/highlights?q=weather");
    expect(document.querySelector<HTMLInputElement>("main input[type='search']")?.value).toBe("weather");

    await openPalette();
    expect(titles()[0]).toBe("“weather”");
    await press("Enter");
    // A recent search fills the palette again rather than running.
    expect(field().value).toBe("weather");

    await type("archi");
    expect(titles()).toContain("Impossible architecture");
    await type("quiet");
    expect(titles()[0]).toBe("Quiet wonders");
    await press("Enter");
    expect(window.location.hash).toBe(`#/library?collection=${collectionId}`);
  });

  it("ignores a passage search answer that arrives after a newer one", async () => {
    let answerFirst: ((page: { entries: HighlightListEntry[]; hasMore: boolean }) => void) | undefined;
    const listHighlights = vi.fn().mockImplementation((query: HighlightQuery) => query.search === "hous"
      ? new Promise((resolve) => { answerFirst = resolve; })
      : Promise.resolve({ entries: query.search ? [entry({ text: "The House is kept by tides." })] : [], hasMore: false }));
    installPaletteLibrary(listHighlights);
    await render();
    await openPalette();
    await type("hous");
    await settle();
    await type("house");
    await settle();
    await act(async () => { answerFirst?.({ entries: [entry({ text: "An old answer about a hous." })], hasMore: false }); await tick(); });
    expect(titles()).toContain("The House is kept by tides.");
    expect(titles()).not.toContain("An old answer about a hous.");
  });

  it("opens a passage centred on its book page, and copies it with Ctrl Enter", async () => {
    installPaletteLibrary();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await render();
    await openPalette();
    await type("every room");
    await settle();
    const index = titles().indexOf("Every room of the House keeps its weather.");
    for (let step = 0; step < index; step += 1) await press("ArrowDown");
    expect(palette()!.textContent).toContain("copy the passage");
    await press("Enter", { ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith("Every room of the House keeps its weather.");
    await openPalette();
    await type("every room");
    await settle();
    for (let step = 0; step < titles().indexOf("Every room of the House keeps its weather."); step += 1) await press("ArrowDown");
    await press("Enter");
    expect(window.location.hash).toBe(`#/library/${firstBookId}?highlight=${highlightId}`);
  });

  it("opens Settings at the chosen control and focuses it", async () => {
    installPaletteLibrary();
    override({ ai: { describe: vi.fn().mockResolvedValue(enabledAi) } });
    await render();
    await openPalette();
    await type("check for updates automatically");
    expect(titles()[0]).toBe("Check for updates automatically");
    expect(options()[0]!.textContent).toContain("Settings · Backups and your data");
    await press("Enter");
    expect(window.location.hash).toBe("#/settings");
    await settle(150);
    const checkbox = document.querySelector<HTMLInputElement>("[data-setting='updates-automatic']");
    expect(checkbox).not.toBeNull();
    expect(document.activeElement).toBe(checkbox);
    expect(checkbox!.closest("label")!.hasAttribute("data-setting-flash")).toBe(true);

    // A control inside a closed section opens the section first.
    await openPalette();
    await type("ai provider");
    await press("Enter");
    await settle(150);
    expect(document.activeElement?.getAttribute("data-setting")).toBe("ai-provider");
    expect(document.activeElement?.closest("details")?.open).toBe(true);
  });

  it("marks every setting the palette lists on the Settings page", async () => {
    const { SETTINGS } = await import("./palette/settings-index");
    override({
      ai: { describe: vi.fn().mockResolvedValue(enabledAi) },
      remote: { describe: vi.fn().mockResolvedValue({ configured: true, provider: "convex", host: "example.convex.cloud", deployment: "example", source: "file", transport: "tls", syncKeySaved: true }) },
    });
    await render("#/settings");
    await settle(50);
    const missing = SETTINGS.filter(({ id, host }: { id: string; host?: string }) => host !== "web" && !document.querySelector(`[data-setting='${id}']`)).map(({ id }) => id);
    expect(missing).toEqual([]);
  });

  describe("in the web app", () => {
    async function asWebApp(host: Record<string, unknown> = {}) {
      const current = await bridge().system.getCapabilities();
      const web = { kind: "web", backend: "convex", deployment: "https://quiet-otter-123.convex.cloud", account: "reader@example.test", ...host } as const;
      override({
        host: web,
        ai: { describe: vi.fn().mockResolvedValue(enabledAi) },
        session: { signOut: vi.fn().mockResolvedValue(undefined), changeDeployment: vi.fn().mockResolvedValue(undefined) },
        system: { getCapabilities: vi.fn().mockResolvedValue({ ...current, host: web }) },
      });
    }

    it("marks every setting it lists on the web Settings page, and lists nothing the web lacks", async () => {
      const { settingsFor } = await import("./palette/settings-index");
      installPaletteLibrary();
      await asWebApp();
      const web = settingsFor({ kind: "web", backend: "convex" }).map(({ id }) => id);
      for (const desktopOnly of ["themes-folder", "theme-import", "sync-url", "ai-key", "backup-create", "backup-restore", "export", "updates-check", "storage-locations"]) expect(web).not.toContain(desktopOnly);
      await render("#/settings");
      await settle(50);
      expect(web.filter((id) => !document.querySelector(`[data-setting='${id}']`))).toEqual([]);
    });

    it("searches the library and offers only what a browser can do", async () => {
      installPaletteLibrary();
      await asWebApp();
      await render();
      await openPalette();
      await type(">");
      const actions = titles();
      expect(actions).toEqual(expect.arrayContaining(["Import highlights from a file", "Add a book", "Sign out"]));
      for (const missing of ["Export your library", "Create a backup", "Check for updates", "Sync now"]) expect(actions).not.toContain(missing);
      await type("/");
      expect(titles()).not.toContain("Review synced changes");
      await type("backup");
      expect(titles().filter((title) => /backup/iu.test(title) && !title.startsWith("Search all"))).toEqual([]);
      await type("theme folder");
      expect(titles()).not.toContain("Themes folder");
      await type("piranesi");
      expect(titles()[0]).toBe("Piranesi");
      await press("Enter");
      expect(window.location.hash).toBe(`#/library/${firstBookId}`);
    });

    it("signs out from the palette through Settings", async () => {
      installPaletteLibrary();
      await asWebApp();
      const signOut = vi.fn().mockResolvedValue(undefined);
      override({ session: { signOut } });
      await render();
      await openPalette();
      await type(">sign out");
      expect(titles()[0]).toBe("Sign out");
      await press("Enter");
      await settle(100);
      expect(window.location.hash).toBe("#/settings");
      expect(signOut).toHaveBeenCalledOnce();
    });
  });

  it("runs app actions: collapsing the sidebar and adding a book", async () => {
    installPaletteLibrary();
    await render("#/highlights");
    await openPalette();
    await type(">sidebar");
    expect(titles()[0]).toBe("Expand the sidebar");
    await press("Enter");
    expect(document.querySelector("[aria-label='Main navigation']")?.hasAttribute("data-expanded")).toBe(true);

    await openPalette();
    await type(">add a book");
    await press("Enter");
    expect(window.location.hash).toBe("#/library");
    expect(document.querySelector<HTMLDialogElement>("dialog[aria-labelledby]:has(input[name='title'])")?.open ?? Array.from(document.querySelectorAll("dialog[open] h2")).some((heading) => heading.textContent === "Add a book")).toBe(true);
  });

  it("switches between light and dark from the palette", async () => {
    installPaletteLibrary();
    await render();
    await openPalette();
    await type(">dark mode");
    expect(titles()[0]).toBe("Switch to dark mode");
    await press("Enter");
    expect(saveAppearance).toHaveBeenCalledWith({ themeId: appearanceConfiguration().themeId, mode: "dark" });
  });

  it("offers AI actions only while AI is switched on", async () => {
    installPaletteLibrary();
    await render(`#/library/${firstBookId}?highlight=${highlightId}`);
    await openPalette();
    await type(">explain");
    expect(titles()).not.toContain("Explain this passage");
    await press("Escape");

    if (root) act(() => root?.unmount());
    root = createRoot(container!);
    override({ ai: { describe: vi.fn().mockResolvedValue(enabledAi), describeExplainTask: vi.fn().mockReturnValue(new Promise(() => undefined)) } });
    await render(`#/library/${firstBookId}?highlight=${highlightId}`);
    await openPalette();
    await type(">explain");
    expect(titles()).toContain("Explain this passage");
    await press("Enter");
    expect(document.querySelector("#context-assistant-tab")?.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("#reading-context")?.hasAttribute("hidden")).toBe(false);
  });

  it("imports straight from a plugged-in reader", async () => {
    installPaletteLibrary();
    const chooseReader = vi.fn().mockResolvedValue(undefined);
    override({ imports: { chooseReader, listReaders: vi.fn().mockResolvedValue([{ id: "a".repeat(32), kind: "kobo", label: "KOBOeReader" }]) } });
    await render();
    await openPalette();
    await type(">kobo");
    expect(titles()[0]).toBe("Import from your Kobo");
    await press("Enter");
    expect(window.location.hash).toBe("#/import");
    expect(chooseReader).toHaveBeenCalledWith("a".repeat(32));
  });
});
