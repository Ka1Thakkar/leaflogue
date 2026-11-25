import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { LocalLibrary } from "@leaflogue/storage";
import { ArticleCapture } from "./article-capture";
import { articleUrl, MAX_ARTICLE_BYTES, parseArticle } from "./article-document";
import { extractArticle } from "./article-extract";
import { fetchArticle } from "./article-network";
import { fetchPublicResource } from "./public-resource-fetch";
import { ReaderStore } from "./reader-store";

const paragraph = "A synthetic paragraph about reading, thinking and remembering what matters. ".repeat(6);
const html = `<html><head><title>Fixture article</title><meta name="author" content="A Reader"></head><body><nav>Navigation links</nav><article><h1>Fixture article</h1><p>${paragraph}</p><p>${paragraph} Second paragraph.</p><img src="https://images.invalid/track"><script>throw new Error('must not run')</script></article></body></html>`;
const response = () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
const extract = async (source: string, url: string) => extractArticle(source, url, 123);

it.each(['http://example.com/a', 'https://user:password@example.com/a', 'https://example.com:8443/a', 'file:///tmp/a', 'https://example.com/a?access_token=secret'])('rejects unsupported article URL %s', url => {
  expect(() => articleUrl(url)).toThrow();
});
it('reuses DNS-pinned fetching to reject local addresses before making a request', async () => {
  await expect(fetchArticle('https://127.0.0.1/a', AbortSignal.timeout(1000))).rejects.toThrow(/public address/);
});
it('validates every redirect hop and never follows one onto a private address', async () => {
  const first = vi.fn(async (url: string, init: RequestInit) => url.includes('example.com') ? new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } }) : fetchPublicResource(url, init));
  await expect(fetchArticle('https://example.com/a', AbortSignal.timeout(1000), first)).rejects.toThrow(/public address/);
  expect(first).toHaveBeenCalledTimes(2);
});
it('bounds streamed bytes, cancels oversized responses and rejects non-HTML and compressed bodies', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(MAX_ARTICLE_BYTES + 1)); }, cancel });
  await expect(fetchArticle('https://example.com/a', AbortSignal.timeout(1000), async () => new Response(stream, { headers: { 'content-type': 'text/html' } }))).rejects.toThrow(/5 MiB/);
  expect(cancel).toHaveBeenCalled();
  const badHeaders: Record<string, string>[] = [{ 'content-type': 'application/json' }, { 'content-type': 'text/html', 'content-encoding': 'gzip' }];
  for (const headers of badHeaders) {
    await expect(fetchArticle('https://example.com/a', AbortSignal.timeout(1000), async () => new Response('body', { headers }))).rejects.toThrow();
  }
});
it('extracts inert text into a versioned reader document without remote markup or resources', () => {
  const snapshot = extractArticle(html, 'https://example.com/article', 123);
  const parsed = parseArticle(Buffer.from(JSON.stringify(snapshot)));
  expect(parsed.format).toBe('article');
  expect(parsed.source).toEqual({ url: 'https://example.com/article', capturedAt: 123 });
  expect(parsed.chapters[0]?.text).toContain('synthetic paragraph');
  expect(parsed.chapters[0]?.html).not.toMatch(/<script|<img|https:\/\/images|must not run/);
  const escaped = parseArticle(Buffer.from(JSON.stringify({ ...snapshot, paragraphs: ['Text <script>alert(1)</script> & more.'] })));
  expect(escaped.chapters[0]?.html).toContain('&lt;script&gt;');
  expect(() => parseArticle(Buffer.from(JSON.stringify({ ...snapshot, version: 999 })))).toThrow(/unsupported/);
  expect(() => parseArticle(Buffer.from(JSON.stringify({ ...snapshot, paragraphs: [null] })))).toThrow(/unsupported/);
});

describe('article capture over the existing library and reader', () => {
  it('requires confirmation, retries without duplicates and preserves the original version, notes and reader state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leaflogue-article-'));
    const library = new LocalLibrary(join(root, 'library.sqlite'));
    const reader = new ReaderStore(join(root, 'reader'));
    let body = html;
    const capture = new ArticleCapture(join(root, 'articles'), () => library, () => reader, async () => new Response(body, { headers: { "content-type": "text/html" } }), extract);
    try {
      const preview = await capture.preview('https://example.com/a#selection', randomUUID());
      expect(library.listBooks()).toEqual([]);
      const book = await capture.save(preview.token);
      const document = (await reader.open(book.id))!;
      expect(document.format).toBe('article');
      const note = library.createNote({ bookId: book.id, markdown: 'My reflection' });
      await reader.savePosition(book.id, document.sha256, 0, 1);
      body = html.replaceAll('synthetic paragraph', 'CHANGED VERSION');
      const again = await capture.preview('https://example.com/a', randomUUID());
      expect(again.existing).toBe(true);
      expect((await capture.save(again.token)).id).toBe(book.id);
      expect(library.listBooks()).toHaveLength(1);
      expect(library.getBookContents(book.id)!.standaloneNotes[0]!.id).toBe(note.id);
      expect((await reader.open(book.id))!.sha256).toBe(document.sha256);
      expect((await reader.open(book.id))!.position.paragraph).toBe(1);
      expect((await readdir(join(root, 'articles'))).filter(name => name.endsWith('.article.json'))).toHaveLength(1);
      await expect(capture.save(again.token)).rejects.toThrow(/expired/);
    } finally { library.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('recovers a failed reader-link step through the same canonical record on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leaflogue-article-'));
    const library = new LocalLibrary(join(root, 'library.sqlite'));
    const reader = new ReaderStore(join(root, 'reader'));
    const capture = new ArticleCapture(join(root, 'articles'), () => library, () => reader, async () => response(), extract);
    try {
      const preview = await capture.preview('https://example.com/a', randomUUID());
      vi.spyOn(reader, 'attach').mockRejectedValueOnce(new Error('disk unavailable'));
      await expect(capture.save(preview.token)).rejects.toThrow('disk unavailable');
      expect(library.listBooks()).toHaveLength(1);
      const book = await capture.save(preview.token);
      expect(library.listBooks()).toHaveLength(1);
      expect((await reader.open(book.id))!.format).toBe('article');
    } finally { library.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('cancels in-flight work and rejects a preview after the active library changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leaflogue-article-'));
    const first = new LocalLibrary(':memory:'), second = new LocalLibrary(':memory:'); let current = first;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })));
    const cancelled = new ArticleCapture(root, () => current, () => new ReaderStore(root), fetcher, extract);
    try {
      const token = randomUUID(); const pending = cancelled.preview('https://example.com/a', token);
      cancelled.cancel(token); await expect(pending).rejects.toThrow(/Cancelled/);
      const capture = new ArticleCapture(root, () => current, () => new ReaderStore(root), async () => response(), extract);
      const preview = await capture.preview('https://example.com/a', randomUUID()); current = second;
      await expect(capture.save(preview.token)).rejects.toThrow(/expired/);
      expect(second.listBooks()).toEqual([]);
    } finally { first.close(); second.close(); await rm(root, { recursive: true, force: true }); }
  });
});

it('cancels during DNS resolution without waiting for the resolver or sending a request', async () => {
  const controller = new AbortController();
  const pending = fetchPublicResource('https://example.test/article', { signal: controller.signal }, () => new Promise(() => undefined));
  controller.abort(new Error('Cancelled during DNS'));
  await expect(pending).rejects.toThrow('Cancelled during DNS');
});
