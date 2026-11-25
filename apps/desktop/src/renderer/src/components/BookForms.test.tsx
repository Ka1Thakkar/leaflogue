/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, LeaflogueBridge } from "@leaflogue/contracts";
import { BookForm, MetadataForm } from "./BookForms";

let root: Root;
let container: HTMLDivElement;
const item = { provider: "google-books", providerId: "volume-1", title: "A quiet beginning", authors: ["A Reader"], isbn13: "9780306406157", publisher: "Quiet Press", description: "A book about reading.", language: "en", coverUrl: "https://books.google.com/books/content?id=volume-1&img=1" };
const book = { id: "bd809783-25e1-4d95-80a0-d03442a57d5c", title: item.title, authors: item.authors, revision: 1 };
const search = vi.fn();
const createBook = vi.fn();
const updateBookMetadata = vi.fn();
const onSaved = vi.fn();
const onClose = vi.fn();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function submit(label: string) {
  await act(async () => { container.querySelector(`form[aria-label="${label}"]`)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick(); });
}
async function choose() {
  await submit("Search book catalogue");
  await act(async () => { container.querySelector<HTMLButtonElement>("li button")!.click(); await tick(); });
}
beforeEach(async () => {
  vi.clearAllMocks();
  search.mockResolvedValue({ source: "google-books", items: [item] });
  createBook.mockResolvedValue(book);
  updateBookMetadata.mockResolvedValue({ ...book, ...item, revision: 2 });
  Object.defineProperty(window, "leaflogue", { configurable: true, value: { catalog: { search }, library: { createBook, updateBookMetadata } } as unknown as LeaflogueBridge });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<BookForm onClose={onClose} onSaved={onSaved} />); await tick(); });
  container.querySelector<HTMLInputElement>('input[name="query"]')!.value = "reading";
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("Add book catalogue search", () => {
  it("reviews an edition before adding it, then retains its cover and metadata", async () => {
    await choose();
    expect(createBook).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[name="title"]')!.value).toBe(item.title);
    await submit("Book details");
    expect(createBook).toHaveBeenCalledWith({ title: item.title, authors: item.authors, isbn13: item.isbn13 });
    expect(updateBookMetadata).toHaveBeenCalledWith(expect.objectContaining({ id: book.id, expectedRevision: 1, coverUrl: item.coverUrl, publisher: item.publisher, description: item.description, language: "en" }));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
  it("keeps manual entry usable when online search fails", async () => {
    search.mockRejectedValue(new Error("offline"));
    await submit("Search book catalogue");
    expect(container.textContent).toContain("enter the book manually");
    container.querySelector<HTMLInputElement>('input[name="title"]')!.value = "An offline book";
    await submit("Book details");
    expect(createBook).toHaveBeenCalledWith({ title: "An offline book", authors: [] });
    expect(updateBookMetadata).not.toHaveBeenCalled();
  });
  it("retries a failed metadata save on the same created book", async () => {
    updateBookMetadata.mockRejectedValueOnce(new Error("temporary failure"));
    await choose();
    await submit("Book details");
    expect(container.textContent).toContain("already exists in your library");
    expect(onSaved).not.toHaveBeenCalled();
    await submit("Book details");
    expect(createBook).toHaveBeenCalledTimes(1);
    expect(updateBookMetadata).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

/** Type into a details field the way a person does, so React sees the edit. */
async function typeField(name: string, value: string) {
  await act(async () => {
    const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const fieldValue = (name: string) => container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!.value;
const second = { ...item, providerId: "volume-2", title: "A quiet beginning (2nd edition)", authors: ["A Reader", "An Editor"], isbn13: "9780306406164", publisher: "Second Press" };
async function searchCatalogue() {
  container.querySelector<HTMLInputElement>('input[name="query"]')!.value = "reading";
  await submit("Search book catalogue");
}
async function pick(index: number) {
  await act(async () => { container.querySelectorAll<HTMLButtonElement>("li button")[index]!.click(); await tick(); });
}

describe("comparing catalogue editions", () => {
  it("keeps a typed title when an edition is chosen, and fills only the untouched fields", async () => {
    search.mockResolvedValue({ source: "google-books", items: [item, second] });
    await typeField("title", "My own title");
    await searchCatalogue();
    await pick(0);
    expect(fieldValue("title")).toBe("My own title");
    expect(fieldValue("authors")).toBe("A Reader");
    expect(fieldValue("isbn")).toBe(item.isbn13);
    expect(container.textContent).toContain("Kept the title you typed");
    // Another edition replaces what the first one filled, never what was typed.
    await pick(1);
    expect(fieldValue("title")).toBe("My own title");
    expect(fieldValue("authors")).toBe("A Reader\nAn Editor");
    expect(fieldValue("isbn")).toBe(second.isbn13);
    await submit("Book details");
    expect(createBook).toHaveBeenCalledWith({ title: "My own title", authors: ["A Reader", "An Editor"], isbn13: second.isbn13 });
    expect(updateBookMetadata).toHaveBeenCalledWith(expect.objectContaining({ title: "My own title", publisher: "Second Press" }));
  });

  it("keeps a correction made to an edition's value when another edition is compared", async () => {
    search.mockResolvedValue({ source: "google-books", items: [item, second] });
    await searchCatalogue();
    await pick(0);
    await typeField("authors", "A. Reader");
    await pick(1);
    expect(fieldValue("authors")).toBe("A. Reader");
    expect(fieldValue("title")).toBe(second.title);
  });

  it("fills a field the reader cleared when an edition is chosen again", async () => {
    await typeField("title", "Draft");
    await typeField("title", "");
    await searchCatalogue();
    await pick(0);
    expect(fieldValue("title")).toBe(item.title);
  });
});

async function typeQuery(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[name="query"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("debounces typing and clears results without searching an empty query", async () => {
  vi.useFakeTimers();
  await typeQuery("quiet");
  await act(async () => { await vi.advanceTimersByTimeAsync(399); });
  expect(search).not.toHaveBeenCalled();
  await typeQuery("quiet reading");
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(search).toHaveBeenCalledExactlyOnceWith("quiet reading");
  expect(container.querySelector("li button")?.textContent).toContain(item.title);
  await typeQuery("");
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(search).toHaveBeenCalledTimes(1);
  expect(container.querySelector("li button")).toBeNull();
});

it("ignores a slow response for a superseded query", async () => {
  vi.useFakeTimers();
  let finishOld: ((value: unknown) => void) | undefined;
  search.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
  await typeQuery("older query");
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  await typeQuery("latest query");
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(container.querySelector("li button")?.textContent).toContain(item.title);
  await act(async () => { finishOld!({ source: "google-books", items: [{ ...item, title: "Outdated result" }] }); });
  expect(container.querySelector("li button")?.textContent).toContain(item.title);
  expect(container.textContent).not.toContain("Outdated result");
});


const metadataBook: Book = { ...book, id: book.id as Book["id"], status: "unread" as const, archived: false, createdAt: 1, updatedAt: 1, highlightCount: 0, isbn13: "9780306406157" };
async function metadataEditor(latest = metadataBook) {
  Object.defineProperty(window, "leaflogue", { configurable: true, value: { library: { listBooks: vi.fn().mockResolvedValue([]), updateBookMetadata, getBookContents: vi.fn().mockResolvedValue({ book: latest, highlights: [], standaloneNotes: [] }) } } as unknown as LeaflogueBridge });
  await act(async () => { root.render(<MetadataForm book={metadataBook} onClose={onClose} onSaved={onSaved} />); await tick(); });
}

describe("metadata save feedback", () => {
  it("identifies an invalid ISBN before sending and keeps the edited field", async () => {
    await metadataEditor();
    container.querySelector<HTMLInputElement>('input[name="isbn13"]')!.value = "123";
    await submit("Edit book metadata");
    expect(updateBookMetadata).not.toHaveBeenCalled();
    expect(container.textContent).toContain("valid 13-digit ISBN");
    expect(container.querySelector<HTMLInputElement>('input[name="isbn13"]')!.value).toBe("123");
  });
  it("explains ISBN collisions without exposing raw IPC or database errors", async () => {
    await metadataEditor();
    updateBookMetadata.mockRejectedValue(new Error("Error invoking remote method: Error: Another book already has that ISBN-13"));
    await submit("Edit book metadata");
    expect(container.textContent).toContain("Another book already uses this ISBN-13");
    expect(container.textContent).not.toContain("remote method");
    expect(onClose).not.toHaveBeenCalled();
  });
  it("retries a stale revision only when the latest metadata is unchanged", async () => {
    await metadataEditor({ ...metadataBook, revision: 2 });
    container.querySelector<HTMLInputElement>('input[name="title"]')!.value = "My edited title";
    updateBookMetadata.mockRejectedValueOnce(new Error("Book changed elsewhere or no longer exists")).mockResolvedValueOnce({ ...metadataBook, title: "My edited title", revision: 3 });
    await submit("Edit book metadata");
    expect(updateBookMetadata).toHaveBeenCalledTimes(2);
    expect(updateBookMetadata).toHaveBeenLastCalledWith(expect.objectContaining({ title: "My edited title", expectedRevision: 2 }));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ title: "My edited title", revision: 3 }));
  });
  it("preserves the draft and refuses to overwrite metadata changed through sync", async () => {
    await metadataEditor({ ...metadataBook, title: "Changed through sync", revision: 2 });
    container.querySelector<HTMLInputElement>('input[name="title"]')!.value = "My edited title";
    updateBookMetadata.mockRejectedValue(new Error("Book changed elsewhere or no longer exists"));
    await submit("Edit book metadata");
    expect(updateBookMetadata).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("changed while the editor was open");
    expect(container.querySelector<HTMLInputElement>('input[name="title"]')!.value).toBe("My edited title");
  });
});
