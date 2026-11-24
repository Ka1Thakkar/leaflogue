/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Book, BookId, LeaflogueBridge } from "@leaflogue/contracts";
import { LibraryPage } from "./Library";
import { ImportDialogProvider } from "./shared";

let root: Root;
let container: HTMLDivElement;
const cards = () => Array.from(container.querySelectorAll<HTMLAnchorElement>('a[aria-label^="Open Book"]'));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function click(name: string) {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === name);
  if (!button) throw new Error(`Missing ${name}`);
  await act(async () => { button.click(); await tick(); });
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const books: Book[] = Array.from({ length: 125 }, (_, i) => ({ id: `book-${i}` as BookId, title: `Book ${String(i).padStart(3, '0')}`, authors: [], status: i === 124 ? 'reading' : 'unread', archived: false, createdAt: 1, updatedAt: 1, revision: 1, highlightCount: 0 }));
  Object.defineProperty(window, 'leaflogue', { configurable: true, value: {
    library: { listBooks: vi.fn().mockResolvedValue(books), findDuplicates: vi.fn().mockResolvedValue({ books: [] }) },
    organization: { listCollections: vi.fn().mockResolvedValue([]), listTags: vi.fn().mockResolvedValue([]), getBook: vi.fn().mockResolvedValue(undefined) },
    dashboards: { describe: vi.fn().mockRejectedValue(new Error('unavailable')) },
    statistics: { get: vi.fn().mockRejectedValue(new Error('unavailable')) },
    covers: { resolve: vi.fn().mockResolvedValue(undefined), cancel: vi.fn().mockResolvedValue(undefined) },
  } as unknown as LeaflogueBridge });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<ImportDialogProvider value={() => undefined}><LibraryPage /></ImportDialogProvider>); await tick(); await tick(); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); delete (window as { leaflogue?: LeaflogueBridge }).leaflogue; });

it('bounds rendered cards while keeping every book reachable in order', async () => {
  expect(cards()).toHaveLength(60);
  expect(cards()[0]?.textContent).toContain('Book 000');
  expect(container.textContent).toContain('Books 1–60 of 125');
  await click('Next books');
  expect(cards()).toHaveLength(60);
  expect(cards()[0]?.textContent).toContain('Book 060');
  expect(document.activeElement).toBe(cards()[0]);
  await click('Next books');
  expect(cards()).toHaveLength(5);
  expect(cards()[4]?.textContent).toContain('Book 124');
  const next = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Next books');
  expect(next?.disabled).toBe(true);
  await click('Previous books');
  expect(cards()[0]?.textContent).toContain('Book 060');
});

it('filters the whole shelf and resets to the first page rather than filtering only visible cards', async () => {
  await click('Next books');
  await click('Reading 1');
  expect(cards()).toHaveLength(1);
  expect(cards()[0]?.textContent).toContain('Book 124');
  expect(container.querySelector('nav[aria-label="Book pages"]')).toBeNull();
  await click('All 125');
  expect(cards()).toHaveLength(60);
  expect(cards()[0]?.textContent).toContain('Book 000');
});

it('searches books beyond the displayed page and restores the first page when cleared', async () => {
  await click('Next books');
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
  async function search(value: string) {
    await act(async () => { descriptor.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await tick(); });
  }
  await search('Book 124');
  expect(cards()).toHaveLength(1);
  expect(cards()[0]?.textContent).toContain('Book 124');
  await search('');
  expect(cards()).toHaveLength(60);
  expect(cards()[0]?.textContent).toContain('Book 000');
});
