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
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let root: Root; let container: HTMLDivElement;
let epub: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  localStorage.clear();
  epub = {
    open: vi.fn().mockResolvedValue(book), savePosition: vi.fn().mockResolvedValue(undefined), saveBookmarks: vi.fn(), saveAnchor: vi.fn(),
    attach: vi.fn(), readPdf: vi.fn(), unlink: vi.fn().mockResolvedValue(undefined), relocate: vi.fn(),
  };
  Object.defineProperty(window, "leaflogue", { configurable: true, value: {
    epub,
    appearance: { describe: vi.fn().mockResolvedValue(undefined), onChanged: vi.fn().mockReturnValue(() => undefined) },
    library: { getBookContents: vi.fn().mockImplementation(() => Promise.resolve({ book: { id: bookId, title: "Quiet Book", archived: false }, highlights: [highlight] })) },
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
  inner.Highlight = class { priority = 0; constructor(...ranges: unknown[]) { void ranges; } };
  Object.defineProperty(inner, "CSS", { configurable: true, value: { highlights: new Map() } });
  const scroll = frameDocument().getElementById("reader-scroll")!;
  Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 760 });
  // Refresh contents so saved highlights paint with the support above.
  await act(async () => { window.dispatchEvent(new Event("leaflogue:annotations-changed")); await tick(); await tick(); });
  return viewport;
}
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
  it("does not redo typography when reading moves into another chapter", async () => {
    const viewport = await renderReader();
    const calls = watchTypography();
    await openOptions(viewport);
    await click(button(/Chapter 2Second chapter begins here/u));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(epub.savePosition).toHaveBeenLastCalledWith(bookId, sha256, 1, 0, undefined);
    // Neither typography nor the page layout is redone for an ordinary move between chapters.
    expect(calls).toEqual([]);
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
