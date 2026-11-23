/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookId, EpubDocument, Highlight, HighlightId } from "@leaflogue/contracts";
import { EpubReader, describeOpenFailure } from "./EpubReader";

const bookId = "12345678-1234-4234-8234-123456789abc" as BookId;
const highlightId = "22345678-1234-4234-8234-123456789abc" as HighlightId;
const sha256 = "a".repeat(64);
const paragraphs = [["Opening words of the book.", "A quiet second paragraph."], ["Second chapter begins here.", "And it carries on."]];
const book: EpubDocument = {
  sha256,
  chapters: paragraphs.map((items, index) => ({ id: `c${index}.xhtml`, title: `Chapter ${index + 1}`, text: items.join("\n\n"), paragraphs: items, html: items.map((text, paragraph) => `<p data-paragraph="${paragraph}">${text}</p>`).join("") })),
  position: { chapter: 0, paragraph: 0 },
  bookmarks: [{ chapter: 1, paragraph: 0 }],
};
const highlight = { id: highlightId, bookId, text: "A quiet second paragraph.", notes: [], revision: 1 } as unknown as Highlight;
let highlights: Highlight[] = [highlight];
// Three chapters of 3, 2 and 4 equally long paragraphs; the page stubs below make each paragraph one page.
const sentence = (chapter: number, paragraph: number) => `Chapter ${chapter + 1} paragraph ${paragraph + 1} reads evenly.`;
const long: EpubDocument = {
  sha256,
  chapters: [3, 2, 4].map((size, index) => {
    const items = Array.from({ length: size }, (_, paragraph) => sentence(index, paragraph));
    return { id: `l${index}.xhtml`, title: `Part ${index + 1}`, text: items.join("\n\n"), paragraphs: items, html: items.map((text, paragraph) => `<p data-paragraph="${paragraph}">${text}</p>`).join("") };
  }),
  position: { chapter: 0, paragraph: 0 },
  bookmarks: [{ chapter: 2, paragraph: 2 }],
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let root: Root; let container: HTMLDivElement;
let epub: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  localStorage.clear();
  highlights = [highlight];
  epub = {
    open: vi.fn().mockResolvedValue(book), savePosition: vi.fn().mockResolvedValue(undefined), saveBookmarks: vi.fn(), saveAnchor: vi.fn(),
    attach: vi.fn(), readPdf: vi.fn(), unlink: vi.fn().mockResolvedValue(undefined), relocate: vi.fn(),
  };
  Object.defineProperty(window, "leaflogue", { configurable: true, value: {
    epub,
    appearance: { describe: vi.fn().mockResolvedValue(undefined), onChanged: vi.fn().mockReturnValue(() => undefined) },
    library: { getBookContents: vi.fn().mockImplementation(() => Promise.resolve({ book: { id: bookId, title: "Quiet Book", archived: false }, highlights })) },
    sync: { onStatus: vi.fn().mockReturnValue(() => undefined) },
  } });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

async function settle(times = 3) { await act(async () => { for (let index = 0; index < times; index++) await tick(); }); }
async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error("Element to click is missing");
  await act(async () => { element.click(); await tick(); });
}
const button = (label: string | RegExp) => Array.from(document.querySelectorAll("button")).find((item) => typeof label === "string" ? item.textContent?.trim() === label || item.getAttribute("aria-label") === label : label.test(item.textContent ?? ""));
const frameDocument = () => container.querySelector("iframe")!.contentDocument!;

/** Give the reader a measurable size and painting support, which happy-dom lacks. */
async function renderReader() {
  await act(async () => { root.render(<EpubReader bookId={bookId} embedded />); await tick(); });
  await settle();
  const viewport = container.querySelector<HTMLElement>('[aria-label="Book pages"]')!;
  Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 800 });
  const inner = container.querySelector("iframe")!.contentWindow as unknown as Record<string, unknown>;
  inner.Highlight = class { priority = 0; ranges: unknown[]; constructor(...ranges: unknown[]) { this.ranges = ranges; } };
  Object.defineProperty(inner, "CSS", { configurable: true, value: { highlights: new Map() } });
  const scroll = frameDocument().getElementById("reader-scroll")!;
  Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 760 });
  // Refresh contents so saved highlights paint with the support above.
  await act(async () => { window.dispatchEvent(new Event("leaflogue:annotations-changed")); await tick(); await tick(); });
  return viewport;
}
/** A reader whose pages can be counted: every paragraph takes one 48px page. */
async function renderPaged(next: EpubDocument) {
  epub.open!.mockResolvedValue(next);
  const viewport = await renderReader();
  const pages = frameDocument().getElementById("reader-pages")!;
  Object.defineProperty(pages, "scrollWidth", { configurable: true, get: () => Math.max(0, pages.querySelectorAll("[data-paragraph]").length * 48 - 48) });
  // Lay out again now the page has a size, as a real resize would.
  await act(async () => { container.querySelector("iframe")!.dispatchEvent(new Event("load")); await tick(); await tick(); });
  return viewport;
}
const shownChapters = () => Array.from(frameDocument().querySelectorAll<HTMLElement>("article[data-chapter]"), (article) => Number(article.dataset.chapter));
function progress() {
  const [, page, count] = /Page (\d+) of (\d+)/u.exec(container.querySelector(".sr-only[role=status]")?.textContent ?? "") ?? [];
  return { page: Number(page), count: Number(count) };
}
async function press(key: string) {
  await act(async () => { frameDocument().body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await tick(); });
}
const scrolled = () => frameDocument().getElementById("reader-scroll")!.scrollLeft;
async function openOptions(viewport: HTMLElement) {
  await act(async () => { viewport.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); await tick(); });
}
function watchTypography() {
  const doc = frameDocument();
  const calls: string[] = [];
  for (const element of doc.querySelectorAll<HTMLElement>("[data-paragraph]")) {
    const original = element.style.setProperty.bind(element.style);
    element.style.setProperty = (property: string, value: string | null, priority?: string) => { calls.push(property); original(property, value, priority); };
  }
  const pages = doc.getElementById("reader-pages")!;
  const original = pages.style.setProperty.bind(pages.style);
  pages.style.setProperty = (property: string, value: string | null, priority?: string) => { calls.push(`layout:${property}`); original(property, value, priority); };
  return calls;
}

describe("reader work per preference", () => {
  it("does not reset typography or layout when only the clock is toggled", async () => {
    const viewport = await renderReader();
    expect(frameDocument().querySelector<HTMLElement>("[data-paragraph]")!.style.getPropertyValue("font-size")).toBe("18px");
    const calls = watchTypography();
    await openOptions(viewport);
    await click(document.getElementById("reader-tab-Layout"));
    await click(document.querySelector('input[aria-label="Clock"]'));
    expect(container.querySelector('[aria-label="Reading information"] time')).not.toBeNull();
    expect(calls).toEqual([]);
    // A real typography change still reaches every paragraph and lays the pages out again.
    await click(document.getElementById("reader-tab-Text"));
    await click(button("Increase text size"));
    expect(calls).toContain("font-size");
    expect(calls.some((call) => call.startsWith("layout:"))).toBe(true);
  });
  it("typesets only the chapter it moves into and keeps the page geometry", async () => {
    const viewport = await renderReader();
    const calls = watchTypography();
    await openOptions(viewport);
    await click(button(/Chapter 2Second chapter begins here/u));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(epub.savePosition).toHaveBeenLastCalledWith(bookId, sha256, 1, 0, undefined);
    // The chapter left behind is not touched again, and the page shape is not recomputed.
    expect(calls.filter((call) => !call.startsWith("layout:"))).toEqual([]);
    expect(calls.filter((call) => /^layout:(width|max-width|column-width|column-count)$/u.test(call))).toEqual([]);
    expect(shownChapters()).toEqual([1]);
    for (const paragraph of frameDocument().querySelectorAll<HTMLElement>("[data-paragraph]")) expect(paragraph.style.getPropertyValue("font-size")).toBe("18px");
  });
});

describe("one chapter on the page at a time", () => {
  it("keeps only the chapter being read in the reading document", async () => {
    await renderPaged(long);
    expect(shownChapters()).toEqual([0]);
    expect(frameDocument().body.textContent).not.toContain(sentence(1, 0));
    expect(Array.from(frameDocument().querySelectorAll<HTMLElement>("[data-paragraph]"), (node) => `${node.dataset.chapter}:${node.dataset.paragraph}`)).toEqual(["0:0", "0:1", "0:2"]);
  });
  it("turns into the next chapter at its last page and back onto the previous chapter's last page", async () => {
    await renderPaged(long);
    for (let index = 0; index < 3; index++) await press("ArrowRight");
    expect(shownChapters()).toEqual([1]);
    expect(scrolled()).toBe(0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(epub.savePosition).toHaveBeenLastCalledWith(bookId, sha256, 1, 0, undefined);
    await press("ArrowLeft");
    expect(shownChapters()).toEqual([0]);
    expect(scrolled()).toBe(96);
    expect(progress().page).toBe(3);
    // The wheel turns pages the same way.
    await act(async () => { frameDocument().dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true })); await tick(); });
    expect(shownChapters()).toEqual([1]);
    await press("End");
    expect(shownChapters()).toEqual([2]);
    expect(scrolled()).toBe(144);
    expect(progress()).toEqual({ page: 9, count: 9 });
    await press("Home");
    expect(shownChapters()).toEqual([0]);
    expect(progress().page).toBe(1);
  });
  it("moves the book-wide page forward one page at a time while the total settles", async () => {
    await renderPaged(long);
    const seen = [progress()];
    for (let index = 0; index < 8; index++) { await press("ArrowRight"); seen.push(progress()); }
    expect(seen.map((item) => item.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const percent = seen.map((item) => item.page / item.count);
    for (let index = 1; index < percent.length; index++) expect(percent[index]).toBeGreaterThanOrEqual(percent[index - 1]!);
    expect(seen.at(-1)).toEqual({ page: 9, count: 9 });
    // Pressing on at the end stays on the last page.
    await press("ArrowRight");
    expect(progress()).toEqual({ page: 9, count: 9 });
  });
  it("opens a saved position in a later chapter", async () => {
    await renderPaged({ ...long, position: { chapter: 2, paragraph: 0 } });
    expect(shownChapters()).toEqual([2]);
    expect(progress().page).toBe(6);
  });
  it("jumps to a bookmark, a search result and the contents in chapters that are not on the page", async () => {
    const viewport = await renderPaged(long);
    await openOptions(viewport);
    await click(button(new RegExp(`^Part 3${sentence(2, 2)}`, "u")));
    expect(shownChapters()).toEqual([2]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(epub.savePosition).toHaveBeenLastCalledWith(bookId, sha256, 2, 2, undefined);
    await openOptions(viewport);
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search this book"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Chapter 2 paragraph 2");
      search.dispatchEvent(new Event("input", { bubbles: true })); await tick();
    });
    await click(button(/^Part 2/u));
    expect(shownChapters()).toEqual([1]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(epub.savePosition).toHaveBeenLastCalledWith(bookId, sha256, 1, 1, 0);
  });
  it("lists and opens a highlight in a chapter that is not on the page, painting it once its chapter is shown", async () => {
    highlights = [{ ...highlight, text: sentence(2, 3) } as Highlight];
    const viewport = await renderPaged(long);
    const painted = () => ((frameDocument().defaultView as unknown as { CSS: { highlights: Map<string, { ranges: Range[] }> } }).CSS.highlights.get("leaflogue-saved")?.ranges ?? []);
    expect(painted()).toHaveLength(0);
    await openOptions(viewport);
    const list = document.querySelector('ol[aria-label="Highlights in this book"]');
    expect(list?.textContent).toContain(sentence(2, 3));
    await click(list!.querySelector("button"));
    expect(shownChapters()).toEqual([2]);
    expect(document.querySelector('[role="dialog"][aria-label="Saved highlight actions"]')).not.toBeNull();
    await settle();
    expect(painted().map((range) => range.toString())).toEqual([sentence(2, 3)]);
  });
});

describe("reader shortcuts leave other controls alone", () => {
  it("does not take Shift+F10 from a focused editor elsewhere in the window", async () => {
    await renderReader();
    const editor = document.createElement("textarea"); document.body.append(editor); editor.focus();
    const event = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => { editor.dispatchEvent(event); await tick(); });
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="dialog"][aria-label="Reader options"]')).toBeNull();
  });
  it("leaves arrow keys to an open menu", async () => {
    await renderReader();
    const menu = document.createElement("div"); menu.setAttribute("role", "menu");
    const item = document.createElement("div"); item.setAttribute("role", "menuitem"); item.tabIndex = -1; menu.append(item);
    menu.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList;
    document.body.append(menu); item.focus();
    for (const target of [item, document.body]) {
      const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      await act(async () => { target.dispatchEvent(event); await tick(); });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(epub.savePosition).not.toHaveBeenCalled();
  });
  it("still opens reader options with Shift+F10 from the page", async () => {
    await renderReader();
    const event = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => { frameDocument().body.dispatchEvent(event); await tick(); });
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="dialog"][aria-label="Reader options"]')).not.toBeNull();
  });
});

describe("saved highlights from the keyboard", () => {
  it("lists highlights in reader options, opens their actions with focus, and keeps a typed note through Shift+F10", async () => {
    const viewport = await renderReader();
    await openOptions(viewport);
    const list = document.querySelector('ol[aria-label="Highlights in this book"]');
    expect(list?.textContent).toContain("A quiet second paragraph.");
    await click(list!.querySelector("button"));
    const actions = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Saved highlight actions"]');
    expect(actions).not.toBeNull();
    expect(document.activeElement).toBe(actions);
    expect(document.querySelector('[role="dialog"][aria-label="Reader options"]')).toBeNull();
    await click(button("Add note"));
    const note = actions!.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Keep this thought");
      note.dispatchEvent(new Event("input", { bubbles: true })); await tick();
    });
    const event = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => { note.dispatchEvent(event); await tick(); });
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Saved highlight actions"] textarea')?.value).toBe("Keep this thought");
    await click(button("Cancel"));
    expect(document.querySelector('[aria-label="Saved highlight actions"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("iframe"));
  });
});

describe("a linked book that cannot open", () => {
  const moved = new Error("Error invoking remote method 'epub:open': Error: The linked book file moved or is unavailable. Return it to its original location to read it. [book-file:missing]");
  it("explains the problem plainly and keeps technical detail secondary", () => {
    expect(describeOpenFailure(moved)).toEqual({ kind: "missing", calibre: false, detail: "The linked book file moved or is unavailable. Return it to its original location to read it." });
    expect(describeOpenFailure(new Error("x [book-file:changed+calibre]"))).toMatchObject({ kind: "changed", calibre: true });
    expect(describeOpenFailure("boom").kind).toBe("unknown");
  });
  it("offers Locate file and asks before linking a different edition", async () => {
    epub.open!.mockRejectedValue(moved);
    epub.relocate!.mockResolvedValueOnce({ status: "different-edition" }).mockResolvedValueOnce({ status: "relinked", document: book });
    await act(async () => { root.render(<EpubReader bookId={bookId} embedded />); await tick(); });
    await settle();
    expect(container.textContent).toContain("can't find this book's file");
    expect(container.textContent).not.toContain("Error invoking");
    expect(button("Attach book file")).toBeUndefined();
    expect(button("Unlink book file")).toBeDefined();
    await click(button("Locate file…"));
    const dialog = document.querySelector("dialog");
    expect(dialog?.textContent).toContain("This looks like a different edition; your place and highlight locations may shift");
    await click(button("Link this file"));
    await settle();
    expect(epub.relocate).toHaveBeenNthCalledWith(1, bookId);
    expect(epub.relocate).toHaveBeenNthCalledWith(2, bookId, true);
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(container.textContent).not.toContain("can't find this book's file");
  });
  it("lets the reader unlink from the error state and names everything unlinking removes", async () => {
    epub.open!.mockRejectedValue(new Error("x [book-file:changed+calibre]"));
    await act(async () => { root.render(<EpubReader bookId={bookId} embedded />); await tick(); });
    await settle();
    expect(button("Locate file…")).toBeUndefined();
    await click(button("Unlink book file"));
    const message = document.querySelector("dialog")?.textContent ?? "";
    for (const part of ["link to this book file", "reading position", "bookmarks", "reviewed highlight locations", "Calibre link"]) expect(message).toContain(part);
    await click(button("Unlink file"));
    expect(epub.unlink).toHaveBeenCalledWith(bookId);
    expect(button("Attach book file")).toBeDefined();
  });
});
