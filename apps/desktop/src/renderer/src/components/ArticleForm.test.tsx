/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LeaflogueBridge } from "@leaflogue/contracts";
import { ArticleForm } from "./ArticleForm";
let root: Root, container: HTMLDivElement;
const preview = vi.fn(), save = vi.fn(), cancel = vi.fn(), onSaved = vi.fn(), onClose = vi.fn();
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const sample = { token: 'preview-token', url: 'https://example.com/article', title: 'Synthetic article', author: 'A Reader', excerpt: '<script>literal text, not markup</script>', paragraphs: 2, existing: false };
async function submit() { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick(); }); }
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); preview.mockResolvedValue(sample); save.mockResolvedValue({ id: 'saved-id', title: sample.title }); cancel.mockResolvedValue(undefined);
  Object.defineProperty(window, 'leaflogue', { configurable: true, value: { articles: { preview, save, cancel } } as unknown as LeaflogueBridge });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<ArticleForm onSaved={onSaved} onClose={onClose} />); });
  const input = container.querySelector<HTMLInputElement>('input')!;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
  await act(async () => { descriptor.set!.call(input, sample.url); input.dispatchEvent(new Event('input', { bubbles: true })); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it('previews inert text and requires separate save confirmation', async () => {
  await submit();
  expect(preview).toHaveBeenCalledWith(sample.url, expect.any(String));
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector('script')).toBeNull();
  const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Save article')!;
  await act(async () => { button.click(); await tick(); });
  expect(save).toHaveBeenCalledWith(sample.token);
  expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'saved-id' }));
  expect(onClose).toHaveBeenCalledOnce();
});
it('cancels pending retrieval and ignores a late result', async () => {
  let resolve!: (value: typeof sample) => void;
  preview.mockReturnValue(new Promise(done => { resolve = done; }));
  await submit();
  const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Cancel retrieval')!;
  await act(async () => { button.click(); resolve(sample); await tick(); });
  expect(cancel).toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Article preview"]')).toBeNull();
  expect(save).not.toHaveBeenCalled();
});
it('keeps a failed save reviewable and handles expired previews with a retrieval action', async () => {
  await submit(); save.mockRejectedValue(new Error('disk unavailable'));
  await act(async () => { Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Save article')!.click(); await tick(); });
  expect(container.querySelector('[aria-label="Article preview"]')).not.toBeNull();
  save.mockRejectedValue(new Error('Article preview expired.'));
  await act(async () => { Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Save article')!.click(); await tick(); });
  expect(container.textContent).toContain('Preview the article again');
  expect(container.querySelector('[aria-label="Article preview"]')).toBeNull();
});
