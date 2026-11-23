import { parsePdf } from "./pdf";
import { formatEpubChapter, type EpubFormatBudget } from "./epub-format";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile, rm } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { SaxesParser } from "saxes";
import type { CalibreReference, EpubBookmark, EpubDocument, EpubFailureKind } from "@leaflogue/contracts";

const MAX_FILE = 50 * 1024 * 1024;
const MAX_EXPANDED = 100 * 1024 * 1024;
const MAX_ENTRY = 8 * 1024 * 1024;

/** No archive entry is extracted to disk. Limits apply to actual inflated bytes. */
async function entries(bytes: Buffer): Promise<Map<string, Buffer>> {
  if (bytes.length > MAX_FILE) throw new Error("EPUB exceeds the 50 MB limit.");
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, value) => {
      if (error || !value) reject(error ?? new Error("Invalid EPUB archive."));
      else resolve(value);
    });
  });
  return new Promise((resolve, reject) => {
    const files = new Map<string, Buffer>();
    let total = 0;
    let count = 0;
    const fail = (error: Error) => { zip.close(); reject(error); };
    zip.on("error", fail);
    zip.on("end", () => resolve(files));
    zip.on("entry", (entry: Entry) => {
      if (++count > 4000 || entry.uncompressedSize > MAX_ENTRY || total + entry.uncompressedSize > MAX_EXPANDED) {
        fail(new Error("EPUB contains too much expanded content.")); return;
      }
      if (entry.generalPurposeBitFlag & 1) { fail(new Error("Encrypted EPUBs are not supported.")); return; }
      if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
      if (files.has(entry.fileName)) { fail(new Error("EPUB contains duplicate paths.")); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { fail(error ?? new Error("Cannot read EPUB.")); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("error", fail);
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          total += chunk.length;
          if (size > MAX_ENTRY || total > MAX_EXPANDED) {
            stream.destroy(new Error("EPUB contains too much expanded content.")); return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
}

/** XML is parsed as data, never inserted into a browser or allowed to resolve entities. */
function xml(text: string, handlers: {
  open?: (name: string, attributes: Record<string, string>) => void;
  close?: (name: string) => void;
  text?: (text: string) => void;
}) {
  const parser = new SaxesParser({ xmlns: false });
  parser.on("doctype", (value) => { if (value.trim().toLowerCase() !== "html") throw new Error("EPUB external entities and document types are not supported."); });
  parser.on("opentag", (tag) => handlers.open?.(tag.name.split(":").at(-1)!.toLowerCase(), tag.attributes as Record<string, string>));
  parser.on("closetag", (tag) => handlers.close?.(tag.name.split(":").at(-1)!.toLowerCase()));
  parser.on("text", (value) => handlers.text?.(value));
  parser.on("cdata", (value) => handlers.text?.(value));
  parser.write(text).close();
}

export function epubText(source: string): string {
  const blocked = new Set(["head", "script", "style", "svg", "math", "iframe", "object", "audio", "video"]);
  const blocks = new Set(["p", "div", "section", "h1", "h2", "h3", "h4", "li", "br", "tr", "blockquote"]);
  let hidden = 0;
  let body = false;
  let output = "";
  xml(source, {
    open(name) {
      if (name === "body") body = true;
      if (blocked.has(name)) hidden++;
      if (body && !hidden && blocks.has(name)) output += "\n\n";
    },
    close(name) {
      if (body && !hidden && blocks.has(name)) output += "\n\n";
      if (blocked.has(name)) hidden--;
      if (name === "body") body = false;
    },
    text(value) { if (body && !hidden) output += value; },
  });
  return output.split(/\n\s*\n/u).map((part) => part.replace(/\s+/gu, " ").trim()).filter(Boolean).join("\n\n");
}

const IDPF_FONT_OBFUSCATION = "http://www.idpf.org/2008/embedding";
const ADOBE_FONT_OBFUSCATION = "http://ns.adobe.com/pdf/enc#RC";

/**
 * META-INF/encryption.xml usually only means embedded fonts are obfuscated,
 * which Calibre conversions and many publishers do. Both published schemes
 * XOR the start of the font with a key derived from the book's identifier, so
 * those fonts are restored in memory. Anything else is real encryption (DRM),
 * which this reader cannot and does not try to open.
 */
function unmaskFonts(files: Map<string, Buffer>, encryption: string, bookIdentifier: string) {
  const entries: { algorithm: string; uri: string }[] = [];
  let current: { algorithm: string; uri: string } | undefined;
  xml(encryption, {
    open(name, attrs) {
      if (name === "encrypteddata") current = { algorithm: "", uri: "" };
      if (name === "encryptionmethod" && current) current.algorithm = attrs.Algorithm ?? "";
      if (name === "cipherreference" && current) current.uri = attrs.URI ?? "";
    },
    close(name) { if (name === "encrypteddata" && current) { entries.push(current); current = undefined; } },
  });
  if (entries.some(({ algorithm }) => algorithm !== IDPF_FONT_OBFUSCATION && algorithm !== ADOBE_FONT_OBFUSCATION)) {
    throw new Error("This book is protected by DRM, so Leaflogue can't open it. Link a DRM-free copy instead.");
  }
  const idpfKey = createHash("sha1").update(bookIdentifier.replace(/[ \t\r\n]/gu, ""), "utf8").digest();
  const adobeHex = bookIdentifier.replace(/^urn:uuid:/iu, "").replace(/-/gu, "");
  const adobeKey = /^[\da-f]{32}$/iu.test(adobeHex) ? Buffer.from(adobeHex, "hex") : undefined;
  for (const { algorithm, uri } of entries) {
    let path: string;
    try { path = posix.normalize(decodeURIComponent(uri)); } catch { continue; }
    const font = files.get(path);
    if (!font) continue;
    const idpf = algorithm === IDPF_FONT_OBFUSCATION;
    const key = idpf && bookIdentifier ? idpfKey : adobeKey;
    // Without the identifier the font cannot be restored; the book still opens
    // in the reader's own fonts rather than showing scrambled glyph data.
    if (!key) { files.delete(path); continue; }
    const restored = Buffer.from(font);
    const length = Math.min(restored.length, idpf ? 1040 : 1024);
    for (let index = 0; index < length; index++) restored[index]! ^= key[index % key.length]!;
    files.set(path, restored);
  }
}

export async function parseEpub(bytes: Buffer): Promise<EpubDocument> {
  const files = await entries(bytes);
  if (files.get("mimetype")?.toString().trim() !== "application/epub+zip") throw new Error("Choose a valid EPUB file.");
  const get = (name: string) => {
    const result = files.get(name);
    if (!result) throw new Error("EPUB is missing a required document.");
    return result.toString("utf8");
  };
  let packagePath = "";
  xml(get("META-INF/container.xml"), { open(name, attrs) {
    if (name === "rootfile" && attrs["media-type"] === "application/oebps-package+xml" && !packagePath) packagePath = attrs["full-path"] ?? "";
  } });
  const manifest = new Map<string, { href: string; media: string }>();
  const spine: string[] = [];
  const identifiers = new Map<string, string>();
  let uniqueIdentifier = "";
  let identifier: { id: string; text: string } | undefined;
  xml(get(packagePath), {
    open(name, attrs) {
      if (name === "package") uniqueIdentifier = attrs["unique-identifier"] ?? "";
      if (name === "identifier") identifier = { id: attrs.id ?? "", text: "" };
      if (name === "item") manifest.set(attrs.id ?? "", { href: attrs.href ?? "", media: attrs["media-type"] ?? "" });
      if (name === "itemref" && attrs.linear !== "no") spine.push(attrs.idref ?? "");
    },
    text(value) { if (identifier) identifier.text += value; },
    close(name) { if (name === "identifier" && identifier) { identifiers.set(identifier.id, identifier.text.trim()); identifier = undefined; } },
  });
  if (files.has("META-INF/encryption.xml")) unmaskFonts(files, get("META-INF/encryption.xml"), identifiers.get(uniqueIdentifier) ?? [...identifiers.values()][0] ?? "");
  if (!spine.length || spine.length > 1000) throw new Error("EPUB has no supported reading order.");
  const media = new Map([...manifest.values()].map((item) => [posix.normalize(posix.join(posix.dirname(packagePath), decodeURIComponent(item.href.split("#")[0]!))), item.media]));
  const budget: EpubFormatBudget = { bytes: 0, embedded: new Map(), sheets: new Set() };
  const chapters = spine.map((id, index) => {
    const item = manifest.get(id);
    if (!item || item.media !== "application/xhtml+xml") throw new Error("Only text EPUB chapters are supported yet.");
    const path = posix.normalize(posix.join(posix.dirname(packagePath), decodeURIComponent(item.href.split("#")[0]!)));
    if (path.startsWith("../") || path.startsWith("/") || item.href.includes(":")) throw new Error("EPUB chapter path is invalid.");
    const formatted = formatEpubChapter(get(path), path, files, media, budget);
    return { id: path, title: formatted.text.split("\n")[0]?.slice(0, 120) || `Chapter ${index + 1}`, ...formatted };
  });
  return { sha256: createHash("sha256").update(bytes).digest("hex"), chapters, position: { chapter: 0, paragraph: 0 } };
}

/** Read only a bounded regular file; never copy book bytes into the library. */
export async function readEpubFile(path: string): Promise<Buffer> {
  return (await readBookFile(path)).bytes;
}

/** The size and modification time come from the same handle the bytes were read through. */
async function readBookFile(path: string): Promise<{ bytes: Buffer; size: number; mtimeMs: number }> {
  if (!isAbsolute(path)) throw new Error("EPUB path must be absolute.");
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE) throw new Error("Choose an EPUB file under 50 MB.");
    const stream = handle.createReadStream({ start: 0, end: MAX_FILE, autoClose: false });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > MAX_FILE) throw new Error("EPUB exceeds the 50 MB limit.");
      chunks.push(bytes);
    }
    return { bytes: Buffer.concat(chunks), size: info.size, mtimeMs: info.mtimeMs };
  } finally { await handle.close(); }
}

/**
 * Opening failures carry a stable marker through IPC, so the reader can offer
 * the right recovery (locate, Calibre reconnect, unlink) without parsing prose.
 */
export class BookFileError extends Error {
  constructor(readonly kind: EpubFailureKind, message: string, calibre: boolean, options?: ErrorOptions) {
    super(`${message} [book-file:${kind}${calibre ? "+calibre" : ""}]`, options);
  }
}

interface Attachment { readonly path: string; readonly sha256: string; readonly calibre?: CalibreReference }
interface CachedEdition { readonly raw: string; readonly source: string; readonly size: number; readonly mtimeMs: number; readonly document: EpubDocument }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
const CACHED_EDITIONS = 2;

/** Local references only; neither book paths nor bytes participate in library sync. */
export class EpubStore {
  /**
   * Parsed editions keyed by book, valid while the link file is byte-identical
   * and the resolved book file keeps its size and modification time. Position,
   * bookmark and reviewed-location saves reuse it instead of re-reading the book.
   */
  private readonly editions = new Map<string, CachedEdition>();
  constructor(
    private readonly root: string,
    private readonly resolveCalibre?: (reference: unknown) => Promise<string>,
    private readonly parse: (bytes: Buffer) => Promise<EpubDocument> = parseBook,
  ) {}
  private path(bookId: string, suffix: string) {
    if (!/^[\da-f-]{36}$/iu.test(bookId)) throw new Error("Invalid EPUB book ID.");
    return join(this.root, `${bookId}.${suffix}`);
  }
  private async write(target: string, value: unknown) {
    const staged = `${target}.${randomUUID()}.tmp`;
    await writeFile(staged, JSON.stringify(value), { mode: 0o600 });
    await rename(staged, target);
  }
  /** Damaged optional state is kept beside the original for recovery, never deleted. */
  private async setAside(target: string) {
    await rename(target, `${target}.corrupt-${Date.now()}`).catch(() => undefined);
  }
  /** Optional per-edition state. Unreadable or unparseable files never block opening. */
  private async sidecar(bookId: string, suffix: string): Promise<unknown> {
    const target = this.path(bookId, suffix);
    let text: string;
    try { text = await readFile(target, "utf8"); } catch { return undefined; }
    try { return JSON.parse(text) as unknown; } catch { await this.setAside(target); return undefined; }
  }
  private async attachment(bookId: string): Promise<{ raw: string; value: Attachment } | undefined> {
    let raw: string;
    try { raw = await readFile(this.path(bookId, "attachment.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch (error) { throw new BookFileError("invalid-link", "Book file link is invalid.", false, { cause: error }); }
    if (!isRecord(value) || typeof value.path !== "string" || typeof value.sha256 !== "string") throw new BookFileError("invalid-link", "Book file link is invalid.", false);
    return { raw, value: value as unknown as Attachment };
  }
  private remember(bookId: string, edition: CachedEdition) {
    this.editions.delete(bookId); this.editions.set(bookId, edition);
    while (this.editions.size > CACHED_EDITIONS) this.editions.delete(this.editions.keys().next().value!);
  }
  /** The linked edition, verified against its stored checksum. Sidecars are not included. */
  private async edition(bookId: string): Promise<{ attachment: Attachment; document: EpubDocument } | undefined> {
    const link = await this.attachment(bookId);
    if (!link) { this.editions.delete(bookId); return undefined; }
    const cached = this.editions.get(bookId);
    if (cached?.raw === link.raw) {
      const info = await stat(cached.source).catch(() => undefined);
      if (info?.isFile() && info.size === cached.size && info.mtimeMs === cached.mtimeMs) return { attachment: link.value, document: cached.document };
    }
    this.editions.delete(bookId);
    const calibre = "calibre" in link.value && link.value.calibre !== undefined;
    let source: string;
    try { source = calibre && this.resolveCalibre ? await this.resolveCalibre(link.value.calibre) : link.value.path; }
    catch (error) { throw new BookFileError("missing", "The linked Calibre book file is unavailable. Reconnect it from Calibre to read it.", true, { cause: error }); }
    let file: Awaited<ReturnType<typeof readBookFile>>;
    try { file = await readBookFile(source); }
    catch (error) {
      if (missing(error)) throw new BookFileError("missing", "The linked book file moved or is unavailable. Return it to its original location to read it.", calibre, { cause: error });
      throw new BookFileError("unreadable", error instanceof Error ? error.message : "The linked book file cannot be read.", calibre, { cause: error });
    }
    let document: EpubDocument;
    try { document = await this.parse(file.bytes); }
    catch (error) { throw new BookFileError("unreadable", error instanceof Error ? error.message : "The linked book file cannot be read.", calibre, { cause: error }); }
    if (document.sha256 !== link.value.sha256) throw new BookFileError("changed", "The linked book file has changed. Edition review is needed before reusing its reading position.", calibre);
    this.remember(bookId, { raw: link.raw, source, size: file.size, mtimeMs: file.mtimeMs, document });
    return { attachment: link.value, document };
  }
  async attach(bookId: string, sourcePath: string, calibre?: CalibreReference): Promise<EpubDocument> {
    this.editions.delete(bookId);
    const file = await readBookFile(sourcePath);
    const document = await this.parse(file.bytes);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // One reference per book for now; never silently replace an edition.
    const raw = JSON.stringify({ path: sourcePath, sha256: document.sha256, ...(calibre ? { calibre } : {}) });
    try {
      await writeFile(this.path(bookId, "attachment.json"), raw, { flag: "wx", mode: 0o600 });
      this.remember(bookId, { raw, source: sourcePath, size: file.size, mtimeMs: file.mtimeMs, document });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && calibre) {
        const previous: unknown = await readFile(this.path(bookId, "attachment.json"), "utf8").then((text) => JSON.parse(text) as unknown).catch(() => undefined);
        if (!isRecord(previous) || previous.sha256 !== document.sha256) throw new Error("This is a different book-file edition. Unlink the current file before linking another edition.", { cause: error });
        await this.write(this.path(bookId, "attachment.json"), { path: sourcePath, sha256: document.sha256, calibre });
        this.editions.delete(bookId);
        return await this.open(bookId) ?? document;
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This book already has a book file linked.", { cause: error });
      throw error;
    }
    return calibre ? { ...document, calibre: true } : document;
  }
  async open(bookId: string): Promise<EpubDocument | undefined> {
    const edition = await this.edition(bookId);
    if (!edition) return undefined;
    let document: EpubDocument = edition.attachment.calibre !== undefined ? { ...edition.document, calibre: true } : edition.document;
    const localAnchors = await this.anchors(bookId, document);
    if (localAnchors) document = { ...document, localAnchors };
    const bookmarks = await this.bookmarks(bookId, document);
    if (bookmarks) document = { ...document, bookmarks };
    const position = await this.position(bookId, document);
    return position ? { ...document, position } : document;
  }
  private async anchors(bookId: string, document: EpubDocument): Promise<Record<string, string> | undefined> {
    const saved = await this.sidecar(bookId, "anchors.json");
    if (saved === undefined) return undefined;
    if (!isRecord(saved)) { await this.setAside(this.path(bookId, "anchors.json")); return undefined; }
    // Reviews for another edition stay untouched in case that edition is linked again.
    if (saved.sha256 !== document.sha256) return undefined;
    if (!isRecord(saved.anchors)) { await this.setAside(this.path(bookId, "anchors.json")); return undefined; }
    const anchors: Record<string, string> = {};
    for (const [id, location] of Object.entries(saved.anchors).slice(0, 10000)) {
      if (/^[\da-f-]{36}$/iu.test(id) && validAnchor(document, location)) anchors[id] = location as string;
    }
    return anchors;
  }
  private async bookmarks(bookId: string, document: EpubDocument): Promise<EpubBookmark[] | undefined> {
    const target = this.path(bookId, "bookmarks.json");
    const saved = await this.sidecar(bookId, "bookmarks.json");
    if (saved === undefined) return undefined;
    if (!isRecord(saved)) { await this.setAside(target); return undefined; }
    if (saved.sha256 !== document.sha256) return undefined;
    try { return validateBookmarks(document, saved.bookmarks); }
    catch {
      // Keep every bookmark that is still valid; the original file is kept for recovery.
      const kept = salvageBookmarks(document, saved.bookmarks);
      await this.setAside(target);
      await this.write(target, { sha256: document.sha256, bookmarks: kept }).catch(() => undefined);
      return kept;
    }
  }
  private async position(bookId: string, document: EpubDocument): Promise<EpubDocument["position"] | undefined> {
    const saved = await this.sidecar(bookId, "json");
    if (saved === undefined) return undefined;
    if (!isRecord(saved)) { await this.setAside(this.path(bookId, "json")); return undefined; }
    if (saved.sha256 !== document.sha256) return undefined;
    return validPosition(document, saved.chapter, saved.paragraph, saved.offset);
  }
  async readPdf(bookId: string, sha256: unknown) {
    const link = await this.attachment(bookId);
    if (!link) throw new Error("The linked PDF changed. Relink this edition before reading it.");
    const attachment = link.value;
    const source = attachment.calibre && this.resolveCalibre ? await this.resolveCalibre(attachment.calibre) : attachment.path;
    const bytes = await readEpubFile(source);
    if (attachment.sha256 !== sha256 || createHash("sha256").update(bytes).digest("hex") !== sha256 || bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("The linked PDF changed. Relink this edition before reading it.");
    return new Uint8Array(bytes);
  }
  async unlink(bookId: string): Promise<void> {
    this.editions.delete(bookId);
    await rm(this.path(bookId, "attachment.json"), { force: true });
    await rm(this.path(bookId, "json"), { force: true });
    await rm(this.path(bookId, "bookmarks.json"), { force: true });
    await rm(this.path(bookId, "anchors.json"), { force: true });
  }
  /**
   * Point an existing link at a file the reader located. The same edition
   * (equal checksum) keeps every piece of local state. Another edition is only
   * linked once the reader accepts it; then bookmarks and the reading position
   * are kept where they still exist in the new edition.
   */
  async relocate(bookId: string, sourcePath: string, acceptDifferentEdition = false): Promise<{ status: "relinked"; document: EpubDocument } | { status: "different-edition" }> {
    let previous: unknown;
    try { previous = JSON.parse(await readFile(this.path(bookId, "attachment.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("This book has no linked book file to locate.", { cause: error });
      previous = undefined;
    }
    if (isRecord(previous) && previous.calibre !== undefined) throw new Error("This book is linked through Calibre. Reconnect it from Calibre instead.");
    const document = await this.parse(await readEpubFile(sourcePath));
    const stored = isRecord(previous) && typeof previous.sha256 === "string" ? previous.sha256 : undefined;
    this.editions.delete(bookId);
    if (stored !== document.sha256) {
      if (!acceptDifferentEdition) return { status: "different-edition" };
      const bookmarks = await this.sidecar(bookId, "bookmarks.json");
      if (isRecord(bookmarks)) await this.write(this.path(bookId, "bookmarks.json"), { sha256: document.sha256, bookmarks: salvageBookmarks(document, bookmarks.bookmarks) });
      const saved = await this.sidecar(bookId, "json");
      const position = isRecord(saved) ? validPosition(document, saved.chapter, saved.paragraph, saved.offset) : undefined;
      if (position) await this.write(this.path(bookId, "json"), { sha256: document.sha256, ...position });
      else await rm(this.path(bookId, "json"), { force: true });
      // Reviewed locations name the old edition, so they stop applying but are left in place.
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.write(this.path(bookId, "attachment.json"), { path: sourcePath, sha256: document.sha256 });
    this.editions.delete(bookId);
    return { status: "relinked", document: await this.open(bookId) ?? document };
  }
  async saveAnchor(bookId: string, sha256: unknown, highlightId: unknown, location: unknown) {
    const edition = await this.edition(bookId);
    const document = edition?.document;
    if (!document || document.sha256 !== sha256 || typeof highlightId !== "string" || !/^[\da-f-]{36}$/iu.test(highlightId) || (location !== null && !validAnchor(document, location))) throw new Error("Highlight location is invalid for this edition.");
    const anchors = { ...await this.anchors(bookId, document) };
    if (location === null) delete anchors[highlightId]; else anchors[highlightId] = location as string;
    if (Object.keys(anchors).length > 10000) throw new Error("Too many reviewed highlight locations.");
    await this.write(this.path(bookId, "anchors.json"), { sha256, anchors });
    return anchors;
  }
  async saveBookmarks(bookId: string, sha256: unknown, value: unknown) {
    const document = (await this.edition(bookId))?.document;
    if (!document || document.sha256 !== sha256) throw new Error("Bookmark edition is invalid.");
    const bookmarks = validateBookmarks(document, value);
    await this.write(this.path(bookId, "bookmarks.json"), { sha256, bookmarks });
    return bookmarks;
  }
  async savePosition(bookId: string, sha256: unknown, chapter: unknown, paragraph: unknown, offset?: unknown): Promise<void> {
    const document = (await this.edition(bookId))?.document;
    if (!document || document.sha256 !== sha256 || typeof chapter !== "number" || !Number.isInteger(chapter) || chapter < 0 || chapter >= document.chapters.length || typeof paragraph !== "number" || !Number.isInteger(paragraph) || paragraph < 0 || paragraph >= paragraphsOf(document, chapter).length) throw new Error("Reading position is invalid.");
    if (offset !== undefined && (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > paragraphsOf(document, chapter)[paragraph]!.length)) throw new Error("Reading offset is invalid.");
    await this.write(this.path(bookId, "json"), { sha256, chapter, paragraph, ...(offset ? { offset } : {}) });
  }
}

function paragraphsOf(document: EpubDocument, chapter: number): readonly string[] {
  return document.chapters[chapter]!.paragraphs ?? document.chapters[chapter]!.text.split("\n\n");
}

function validPosition(document: EpubDocument, chapter: unknown, paragraph: unknown, offset: unknown): EpubDocument["position"] | undefined {
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter < 0 || chapter >= document.chapters.length) return undefined;
  if (typeof paragraph !== "number" || !Number.isInteger(paragraph) || paragraph < 0 || paragraph >= paragraphsOf(document, chapter).length) return undefined;
  if (offset !== undefined && (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > paragraphsOf(document, chapter)[paragraph]!.length)) return undefined;
  return { chapter, paragraph, ...(offset ? { offset } : {}) };
}

/** Each valid, distinct bookmark survives; anything else is dropped. */
function salvageBookmarks(document: EpubDocument, value: unknown): EpubBookmark[] {
  if (!Array.isArray(value)) return [];
  const kept: EpubBookmark[] = []; const keys = new Set<string>();
  for (const item of value.slice(0, 500)) {
    try {
      const [bookmark] = validateBookmarks(document, [item]);
      const key = `${bookmark!.chapter}:${bookmark!.paragraph}:${bookmark!.offset}`;
      if (!keys.has(key)) { keys.add(key); kept.push(bookmark!); }
    } catch { /* Invalid entries are dropped. */ }
  }
  return kept;
}

function validateBookmarks(document: EpubDocument, value: unknown): EpubBookmark[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("A book can have up to 500 bookmarks.");
  const keys = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Bookmark is invalid.");
    const { chapter, paragraph, offset = 0 } = item as Record<string, unknown>;
    if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter < 0 || chapter >= document.chapters.length || typeof paragraph !== "number" || !Number.isInteger(paragraph) || paragraph < 0 || typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw new Error("Bookmark is invalid.");
    const text = (document.chapters[chapter]!.paragraphs ?? document.chapters[chapter]!.text.split("\n\n"))[paragraph];
    if (text === undefined || offset > text.length) throw new Error("Bookmark is invalid.");
    const key = `${chapter}:${paragraph}:${offset}`;
    if (keys.has(key)) throw new Error("Duplicate bookmark.");
    keys.add(key);
    return { chapter, paragraph, offset };
  });
}

function validAnchor(document: EpubDocument, location: unknown): boolean {
  if (typeof location !== "string" || location.length > 200) return false;
  const [prefix, hash, ...parts] = location.split(":"); const values = parts.map(Number);
  if (prefix !== "epub" || hash !== document.sha256 || parts.length !== 5 || parts.some((part) => !/^\d+$/u.test(part)) || values.some((value) => !Number.isSafeInteger(value))) return false;
  const [chapter, first, start, last, end] = values as [number, number, number, number, number];
  const paragraphs = document.chapters[chapter]?.paragraphs ?? document.chapters[chapter]?.text.split("\n\n");
  return paragraphs?.[first] !== undefined && paragraphs?.[last] !== undefined && start <= paragraphs[first]!.length && end <= paragraphs[last]!.length && (first < last || (first === last && start < end));
}

function parseBook(bytes: Buffer) { return bytes.subarray(0, 5).toString() === "%PDF-" ? parsePdf(bytes) : parseEpub(bytes); }
