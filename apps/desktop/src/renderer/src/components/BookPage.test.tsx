/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, BookContents, BookId, HighlightId, HighlightListEntry, LeaflogueBridge, NoteId } from "@leaflogue/contracts";
import { BookPage } from "./BookPage";
import { ImportDialogProvider } from "./shared";

const bookId = "bd809783-25e1-4d95-80a0-d03442a57d5c" as BookId;
const highlightId = "98da45c8-a8ea-42fc-aaae-8d75ec12dc16" as HighlightId;
const book: Book = { id: bookId, title: "Piranesi", authors: ["Susanna Clarke"], status: "reading", archived: false, createdAt: 1, updatedAt: 1, revision: 1, highlightCount: 1 };
const passage: HighlightListEntry = {
  id: highlightId, bookId, bookTitle: book.title, authors: book.authors, text: "Every room of the House keeps its weather.",
  createdAt: 1, updatedAt: 1, revision: 3, notes: [], imported: false, tagIds: [],
};
const contents = (title = book.title): BookContents => ({ book: { ...book, title }, highlights: [], standaloneNotes: [] });

let root: Root;
let container: HTMLDivElement;
let library: Record<string, ReturnType<typeof vi.fn>>;
let organization: Record<string, ReturnType<typeof vi.fn>>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { await act(async () => { for (let i = 0; i < 4; i += 1) await tick(); }); };
const text = () => container.textContent ?? "";
const announce = async () => { await act(async () => { window.dispatchEvent(new Event("leaflogue:annotations-changed")); await tick(); await tick(); }); };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name);
  if (!found) throw new Error(`Button ${name} is missing`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); await tick(); await tick(); });
}

async function render() {
  await act(async () => { root.render(<ImportDialogProvider value={() => undefined}><BookPage bookId={bookId} /></ImportDialogProvider>); });
  await settle();
}

/** Write in the open note dialog and save it. */
async function writeNote(value: string) {
  const dialog = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog")).find((candidate) => candidate.querySelector("textarea[name='text']"));
  if (!dialog) throw new Error("Note dialog is missing");
  dialog.querySelector<HTMLTextAreaElement>("textarea[name='text']")!.value = value;
  await act(async () => { dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
  library = {
    getBookContents: vi.fn().mockResolvedValue(contents()),
    listBooks: vi.fn().mockResolvedValue([book]),
    getMetadataSource: vi.fn().mockResolvedValue(undefined),
    findDuplicates: vi.fn().mockResolvedValue({ books: [], passages: [] }),
    listHighlights: vi.fn().mockResolvedValue({ entries: [], hasMore: false }),
    listReadingStatusHistory: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
    createNote: vi.fn().mockResolvedValue({ id: "e0b6c1a4-5c0e-4a39-9f53-2f1c5f43b0a1" as NoteId }),
  };
  organization = {
    getBook: vi.fn().mockResolvedValue({ bookId, collectionIds: [], tagIds: [] }),
    listCollections: vi.fn().mockResolvedValue([{ id: "ba043082-c430-4ec1-a0dd-29fd80792fbd", name: "Book club" }]),
    listTags: vi.fn().mockResolvedValue([{ id: "a4f12f7f-ea09-45e3-a92a-d414ae8d4019", name: "Labyrinths" }]),
  };
  Object.defineProperty(window, "leaflogue", { configurable: true, value: {
    library,
    organization,
    statistics: { get: vi.fn().mockRejectedValue(new Error("not needed")) },
    covers: { resolve: vi.fn().mockResolvedValue(undefined), cancel: vi.fn().mockResolvedValue(undefined) },
    threads: { list: vi.fn().mockResolvedValue([]), getHighlightMembership: vi.fn().mockResolvedValue([]) },
    ai: { describe: vi.fn().mockResolvedValue({ enabled: false, providers: [] }) },
  } as unknown as LeaflogueBridge });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { leaflogue?: LeaflogueBridge }).leaflogue;
});

describe("opening a book", () => {
  it("says Book not found only when the library confirms the book does not exist", async () => {
    library.getBookContents!.mockResolvedValue(undefined);
    await render();
    expect(text()).toContain("Book not found");
  });

  it("reports a failed read with Retry instead of calling the book missing", async () => {
    library.getBookContents!.mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(text()).toContain("This book couldn't be opened");
    expect(text()).not.toContain("Book not found");
    await click(button("Try again"));
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe("Piranesi");
    expect(library.getBookContents).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["organization", "getBook", "collections and tags"],
    ["organization", "listCollections", "collections and tags"],
    ["organization", "listTags", "collections and tags"],
    ["library", "listBooks", "merging is unavailable"],
  ] as const)("still shows the book when %s.%s fails, with that part marked", async (namespace, method, problem) => {
    (namespace === "library" ? library : organization)[method]!.mockRejectedValue(new Error("offline"));
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Piranesi");
    expect(text()).not.toContain("Book not found");
    expect(text()).not.toContain("couldn't be opened");
    expect(text()).toContain(problem);
  });

  it("keeps collection and tag pickers read-only while the book's memberships are unknown", async () => {
    organization.getBook!.mockRejectedValueOnce(new Error("offline"));
    await render();
    const pickers = () => Array.from(container.querySelectorAll<HTMLDetailsElement>("details")).filter((details) => /^(Collections|Tags)/.test(details.querySelector("summary")?.textContent ?? ""));
    expect(pickers()).toHaveLength(2);
    for (const picker of pickers()) {
      const controls = Array.from(picker.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));
      expect(controls.length).toBeGreaterThan(0);
      expect(controls.every((control) => control.disabled)).toBe(true);
    }
    await click(button("Try again"));
    await settle();
    expect(text()).not.toContain("collections and tags");
    expect(pickers().flatMap((picker) => Array.from(picker.querySelectorAll<HTMLInputElement>("input[type='checkbox']"))).every((control) => !control.disabled)).toBe(true);
  });
});

describe("refreshing a book after a change", () => {
  it("keeps the current book when a refresh fails, and offers another try", async () => {
    await render();
    library.getBookContents!.mockRejectedValueOnce(new Error("offline"));
    await announce();
    expect(container.querySelector("h1")?.textContent).toBe("Piranesi");
    expect(text()).toContain("couldn't refresh this book");
    library.getBookContents!.mockResolvedValueOnce(contents("Piranesi (revised)"));
    await click(button("Try again"));
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe("Piranesi (revised)");
    expect(text()).not.toContain("couldn't refresh this book");
  });

  it("never lets an older, slower reply replace a newer one", async () => {
    await render();
    const older = deferred<BookContents>();
    const newer = deferred<BookContents>();
    library.getBookContents!.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await announce();
    await announce();
    await act(async () => { newer.resolve(contents("Newer title")); await tick(); });
    await act(async () => { older.resolve(contents("Older title")); await tick(); });
    expect(container.querySelector("h1")?.textContent).toBe("Newer title");
  });

  it("reads the book once when a note is added to a passage", async () => {
    library.listHighlights!.mockResolvedValue({ entries: [passage], hasMore: false });
    await render();
    const before = library.getBookContents!.mock.calls.length;
    await click(button("Add another note"));
    await writeNote("A second thought on the tides.");
    expect(library.createNote).toHaveBeenCalledWith({ bookId, highlightId, markdown: "A second thought on the tides." });
    expect(library.getBookContents!.mock.calls.length - before).toBe(1);
  });

  it("reads the book once when a book note is written", async () => {
    await render();
    const before = library.getBookContents!.mock.calls.length;
    await click(button("Write a book note"));
    await writeNote("A book about attention.");
    expect(library.createNote).toHaveBeenCalledWith({ bookId, markdown: "A book about attention." });
    expect(library.getBookContents!.mock.calls.length - before).toBe(1);
  });
});

describe("book notes", () => {
  it("names the section Book notes and invites a first note when there are none", async () => {
    await render();
    const heading = Array.from(container.querySelectorAll("h2")).find((candidate) => candidate.textContent === "Book notes");
    expect(heading).toBeDefined();
    expect(text()).not.toContain("Notes without passages");
    const section = heading!.closest("section")!;
    expect(section.textContent).toContain("Thoughts about the whole book");
    // A visible text action in the header, not only an icon with a tooltip.
    expect(button("Write a book note").textContent).toContain("Write a book note");
    await click(button("Write your first book note"));
    expect(Array.from(document.querySelectorAll<HTMLDialogElement>("dialog")).some((dialog) => dialog.open && dialog.textContent?.includes("Write a book note"))).toBe(true);
  });

  it("lists existing book notes under the same heading", async () => {
    library.getBookContents!.mockResolvedValue({ ...contents(), standaloneNotes: [{ id: "e0b6c1a4-5c0e-4a39-9f53-2f1c5f43b0a1", bookId, markdown: "It made me slow down.", origin: "user", createdAt: 1, updatedAt: 1, revision: 1 }] });
    await render();
    const section = Array.from(container.querySelectorAll("h2")).find((candidate) => candidate.textContent === "Book notes")!.closest("section")!;
    expect(section.textContent).toContain("It made me slow down.");
    expect(section.textContent).not.toContain("Thoughts about the whole book");
  });
});
