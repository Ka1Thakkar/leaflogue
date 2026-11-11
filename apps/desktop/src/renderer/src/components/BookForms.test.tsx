/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaflogueBridge } from "@leaflogue/contracts";
import { BookForm } from "./BookForms";

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
