import { readReaderSource } from "./reader-source";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, link } from "node:fs/promises";
import { join } from "node:path";
import type { ArticlePreview, Book, ImportDocument } from "@leaflogue/contracts";
import type { LocalLibrary } from "@leaflogue/storage";
import type { EpubStore } from "./epub";
import { articleUrl, MAX_ARTICLE_BYTES, parseArticle, type ArticleSnapshot } from "./article-document";
import { fetchArticle, type ArticleFetcher } from "./article-network";
import { extractArticleOffThread } from "./article-extraction";


/** Publish immutable files atomically, without overwriting an existing capture. */
async function publish(path: string, bytes: string | Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.pending`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
    await link(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

const SOURCE = { id: "06826113-c4c1-4c2d-a919-2179e44f8f45", name: "Web articles" };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type ArticleLibrary = Pick<LocalLibrary, "importDocument" | "reviewImportBooks" | "getBook">;
type ArticleReader = Pick<EpubStore, "open" | "attach">;
interface Held { readonly snapshot: ArticleSnapshot; readonly library: ArticleLibrary; readonly at: number }
interface CaptureManifest { readonly hash: string }
type Extractor = (html: string, url: string, signal: AbortSignal) => Promise<ArticleSnapshot>;

/** Article adapter over canonical imports and edition-checked reader attachments. */
export class ArticleCapture {
  private readonly operations = new Map<string, AbortController>();
  private readonly previews = new Map<string, Held>();
  private readonly saving = new Map<string, Promise<Book>>();
  constructor(private readonly root: string, private readonly library: () => ArticleLibrary, private readonly reader: () => ArticleReader,
    private readonly fetcher?: ArticleFetcher, private readonly extract: Extractor = extractArticleOffThread) {}

  cancel(token: string): void { this.operations.get(token)?.abort(); this.previews.delete(token); }
  async preview(value: string, token: string): Promise<ArticlePreview> {
    articleUrl(value);
    if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(token)) throw new Error("Invalid article operation.");
    if (this.operations.has(token) || this.operations.size >= 2) throw new Error("Finish or cancel the current article request first.");
    for (const [key, held] of this.previews) if (Date.now() - held.at > 600_000) this.previews.delete(key);
    while (this.previews.size >= 4) this.previews.delete(this.previews.keys().next().value!);
    const library = this.library();
    const controller = new AbortController(); this.operations.set(token, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    try {
      const response = await fetchArticle(value, signal, this.fetcher);
      const snapshot = await this.extract(response.html, response.url, signal);
      signal.throwIfAborted();
      if (this.library() !== library) throw new Error("The library changed. Retrieve the article again.");
      parseArticle(Buffer.from(JSON.stringify(snapshot)));
      this.previews.set(token, { snapshot, library, at: Date.now() });
      const existing = library.reviewImportBooks(this.document(snapshot), "portable")[0]?.links.some(link => link.sourceId === SOURCE.id) ?? false;
      return { token, url: snapshot.url, title: snapshot.title, author: snapshot.author,
        excerpt: snapshot.paragraphs.join("\n\n").slice(0, 1500), paragraphs: snapshot.paragraphs.length, existing };
    } finally { this.operations.delete(token); }
  }
  save(token: string): Promise<Book> {
    const running = this.saving.get(token); if (running) return running;
    const job = this.persist(token).finally(() => this.saving.delete(token));
    this.saving.set(token, job); return job;
  }
  private document(snapshot: ArticleSnapshot): ImportDocument {
    return { formatVersion: 1, annotations: [], books: [{ providerRecordId: `article:${hash(snapshot.url)}`,
      title: snapshot.title, authors: snapshot.author ? [snapshot.author] : [], description: `Web article: ${snapshot.url}` }] };
  }
  private async persist(token: string): Promise<Book> {
    const held = this.previews.get(token);
    if (!held || Date.now() - held.at > 600_000 || held.library !== this.library()) throw new Error("Article preview expired. Retrieve it again before saving.");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const manifestPath = join(this.root, `${hash(held.snapshot.url)}.capture.json`);
    let manifest: CaptureManifest | undefined;
    try { manifest = JSON.parse((await readReaderSource(manifestPath, 4096)).bytes.toString("utf8")) as CaptureManifest; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!manifest) {
      const bytes = Buffer.from(JSON.stringify(held.snapshot)); const digest = hash(bytes);
      const file = join(this.root, `${digest}.article.json`);
      try { await publish(file, bytes); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      try { await publish(manifestPath, JSON.stringify({ hash: digest })); manifest = { hash: digest }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        manifest = JSON.parse((await readReaderSource(manifestPath, 4096)).bytes.toString("utf8")) as CaptureManifest;
        if (manifest.hash !== digest) await rm(file, { force: true });
      }
    }
    if (!manifest || !/^[\da-f]{64}$/u.test(manifest.hash)) throw new Error("The saved article manifest is damaged.");
    const file = join(this.root, `${manifest.hash}.article.json`);
    const { bytes } = await readReaderSource(file, MAX_ARTICLE_BYTES);
    if (hash(bytes) !== manifest.hash) throw new Error("The stored article failed its integrity check. The capture has not been replaced.");
    parseArticle(bytes);
    const snapshot = JSON.parse(bytes.toString("utf8")) as ArticleSnapshot;
    if (snapshot.url !== held.snapshot.url) throw new Error("Saved article source does not match this capture.");
    const document = this.document(snapshot);
    // Retry-safe: the canonical source mapping is committed atomically by the existing importer.
    if (held.library !== this.library()) throw new Error("The library changed. Retrieve the article again.");
    held.library.importDocument({ document, provider: "portable", source: SOURCE, fileName: "web-article", warnings: [] });
    const id = held.library.reviewImportBooks(document, "portable")[0]?.links.find(link => link.sourceId === SOURCE.id)?.bookId;
    if (!id) throw new Error("The saved article could not be found. Retry saving this preview.");
    const reader = this.reader();
    if (!await reader.open(id)) await reader.attach(id, file);
    if (held.library !== this.library()) throw new Error("The library changed. Open the saved article from its original library.");
    const book = held.library.getBook(id);
    if (!book) throw new Error("The article entry was removed. Its local capture has been kept.");
    this.previews.delete(token);
    return book;
  }
}
