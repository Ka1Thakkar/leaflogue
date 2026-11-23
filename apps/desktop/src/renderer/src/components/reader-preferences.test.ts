/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_READER_PREFERENCES, applyReaderTypography, readReaderPreferenceStore, useReaderPreferences, validateReaderPreferences, type ReaderPreferences } from "./reader-preferences";

const KEY = "leaflogue.reader-preferences.v1";
beforeEach(() => { localStorage.clear(); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

describe("persisted reader preference boundary", () => {
  it("rejects invalid choices and non-finite values from stale or edited storage", () => {
    expect(validateReaderPreferences({ size: Infinity, weight: NaN, columns: "url(javascript:alert(1))", alignment: {}, dark: "false" })).toEqual(DEFAULT_READER_PREFERENCES);
    expect(validateReaderPreferences(null)).toEqual(DEFAULT_READER_PREFERENCES);
  });
  it("bounds values so edited preferences cannot overflow the reader or inject CSS", () => {
    const value = validateReaderPreferences({ size: 900, horizontal: -50, letter: "1em;color:red", width: 0, weight: -800 });
    expect(value.size).toBe(48); expect(value.horizontal).toBe(8); expect(value.width).toBe(30); expect(value.weight).toBe(0); expect(value.letter).toBe(0);
  });
});

describe("stored reader preferences", () => {
  it("ignores a damaged legacy display setting when current preferences exist", () => {
    localStorage.setItem(KEY, JSON.stringify({ global: { ...DEFAULT_READER_PREFERENCES, size: 24 }, books: {}, presets: [] }));
    localStorage.setItem("leaflogue.reader-display", "{not json");
    expect(readReaderPreferenceStore().global.size).toBe(24);
  });
  it("migrates the legacy display setting only when there are no current preferences", () => {
    localStorage.setItem("leaflogue.reader-display", JSON.stringify({ dark: false }));
    expect(readReaderPreferenceStore().global.dark).toBe(false);
    localStorage.setItem(KEY, JSON.stringify({ global: { dark: true } }));
    expect(readReaderPreferenceStore().global.dark).toBe(true);
  });
  it("keeps valid sections when another part of the store is damaged", () => {
    localStorage.setItem(KEY, JSON.stringify({ global: { ...DEFAULT_READER_PREFERENCES, size: 30 }, books: { good: { ...DEFAULT_READER_PREFERENCES, size: 20 }, bad: "oops" }, presets: [null, { name: "Night", preferences: { dark: true } }, 7] }));
    const store = readReaderPreferenceStore();
    expect(store.global.size).toBe(30);
    expect(store.books).toEqual({ good: { ...DEFAULT_READER_PREFERENCES, size: 20 } });
    expect(store.presets.map((preset) => preset.name)).toEqual(["Night"]);
  });
  it("keeps an unreadable store aside instead of losing it", () => {
    localStorage.setItem(KEY, "{broken");
    expect(readReaderPreferenceStore().global).toEqual(DEFAULT_READER_PREFERENCES);
    expect(localStorage.getItem(`${KEY}.corrupt`)).toBe("{broken");
  });
});

describe("separate preferences for one book", () => {
  it("keeps the book's settings when switched off, restores them when switched on, and forgets them on request", async () => {
    let hook!: ReturnType<typeof useReaderPreferences>;
    const Probe = () => { hook = useReaderPreferences("book-1"); return null; };
    const root = createRoot(document.createElement("div"));
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { hook.setOverride(true); });
    await act(async () => { hook.update({ ...hook.preferences, size: 31 }); });
    expect(hook.preferences.size).toBe(31);
    await act(async () => { hook.setOverride(false); });
    expect(hook.override).toBe(false);
    expect(hook.preferences.size).toBe(DEFAULT_READER_PREFERENCES.size);
    expect(hook.savedBookSettings).toBe(true);
    await act(async () => { hook.setOverride(true); });
    expect(hook.preferences.size).toBe(31);
    // Survives a reload as well.
    expect(readReaderPreferenceStore().books["book-1"]?.size).toBe(31);
    await act(async () => { hook.forgetBookSettings(); });
    expect(hook.override).toBe(false); expect(hook.savedBookSettings).toBe(false);
    await act(async () => { hook.setOverride(true); });
    expect(hook.preferences.size).toBe(DEFAULT_READER_PREFERENCES.size);
    act(() => root.unmount());
  });
});

describe("reader typography", () => {
  async function page(html: string) {
    const frame = document.createElement("iframe");
    frame.srcdoc = `<!doctype html><html><head></head><body><main id="reader-scroll"><div id="reader-pages">${html}</div></main></body></html>`;
    const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    document.body.append(frame); await loaded;
    return frame.contentDocument!;
  }
  it("lets the reader's own alignment, spacing and indent win over publisher inline !important styles", async () => {
    const doc = await page('<p id="prose" style="text-align: left !important; line-height: 3 !important; text-indent: 4em !important; margin-bottom: 3em !important">Text</p><p id="title" style="text-align: center !important">Title</p>');
    const prose = doc.getElementById("prose")!; const title = doc.getElementById("title")!;
    applyReaderTypography(doc, { ...DEFAULT_READER_PREFERENCES, alignment: "justify", line: 1.5, indent: 1, paragraph: 0.5 });
    for (const property of ["text-align", "line-height", "text-indent", "margin-bottom"]) expect(prose.style.getPropertyPriority(property)).toBe("");
    // A centred title keeps its publisher alignment.
    expect(title.style.getPropertyPriority("text-align")).toBe("important");
    applyReaderTypography(doc, { ...DEFAULT_READER_PREFERENCES });
    for (const property of ["text-align", "line-height", "text-indent", "margin-bottom"]) expect(prose.style.getPropertyPriority(property)).toBe("important");
    expect(prose.style.getPropertyValue("line-height")).toBe("3");
  });
  it("sets a chapter swapped in later from its publisher sizes, not the sizes already enlarged around it", async () => {
    const doc = await page('<article><p id="first">One</p></article>');
    const base = doc.createElement("style"); base.textContent = "body{font-size:18px}"; doc.head.append(base);
    const pages = doc.getElementById("reader-pages")!;
    applyReaderTypography(doc, { ...DEFAULT_READER_PREFERENCES, size: 24, weight: 100 });
    expect(doc.getElementById("first")!.style.getPropertyValue("font-size")).toBe("24px");
    pages.innerHTML = '<article><p id="next">Two</p><p id="small" style="font-size: 9px">Three</p></article>';
    applyReaderTypography(doc, { ...DEFAULT_READER_PREFERENCES, size: 24, weight: 100 });
    expect(doc.getElementById("next")!.style.getPropertyValue("font-size")).toBe("24px");
    expect(doc.getElementById("next")!.style.getPropertyValue("font-weight")).toBe("500");
    expect(doc.getElementById("small")!.style.getPropertyValue("font-size")).toBe("12px");
    // The surrounding page keeps its own settings afterwards.
    expect(pages.style.getPropertyValue("font-size")).toBe("24px");
    expect(doc.body.style.getPropertyValue("font-size")).toBe("24px");
  });
  it("writes nothing to paragraphs when the typography has not changed", async () => {
    const doc = await page("<p>One</p><p>Two</p>");
    applyReaderTypography(doc, { ...DEFAULT_READER_PREFERENCES });
    const writes: string[] = [];
    for (const element of doc.querySelectorAll<HTMLElement>("p")) {
      const original = element.style.setProperty.bind(element.style);
      element.style.setProperty = (property: string, value: string | null, priority?: string) => { writes.push(property); original(property, value, priority); };
    }
    applyReaderTypography(doc, { ...DEFAULT_READER_PREFERENCES, dark: false, clock: true } as ReaderPreferences);
    expect(writes).toEqual([]);
    applyReaderTypography(doc, { ...DEFAULT_READER_PREFERENCES, size: 20 });
    expect(writes).toEqual(["font-size", "font-size"]);
  });
});
