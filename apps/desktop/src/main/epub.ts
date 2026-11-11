import { formatEpubChapter, type EpubFormatBudget } from "./epub-format";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile, rm } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { SaxesParser } from "saxes";
import type { CalibreReference, EpubDocument } from "@leaflogue/contracts";

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

export async function parseEpub(bytes: Buffer): Promise<EpubDocument> {
  const files = await entries(bytes);
  if (files.get("mimetype")?.toString().trim() !== "application/epub+zip") throw new Error("Choose a valid EPUB file.");
  if (files.has("META-INF/encryption.xml")) throw new Error("Encrypted EPUB resources are not supported in this reader yet.");
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
  xml(get(packagePath), { open(name, attrs) {
    if (name === "item") manifest.set(attrs.id ?? "", { href: attrs.href ?? "", media: attrs["media-type"] ?? "" });
    if (name === "itemref" && attrs.linear !== "no") spine.push(attrs.idref ?? "");
  } });
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
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

/** Local references only; neither book paths nor bytes participate in library sync. */
export class EpubStore {
  constructor(private readonly root: string, private readonly resolveCalibre?: (reference: unknown) => Promise<string>) {}
  private path(bookId: string, suffix: string) {
    if (!/^[\da-f-]{36}$/iu.test(bookId)) throw new Error("Invalid EPUB book ID.");
    return join(this.root, `${bookId}.${suffix}`);
  }
  async attach(bookId: string, sourcePath: string, calibre?: CalibreReference): Promise<EpubDocument> {
    const document = await parseEpub(await readEpubFile(sourcePath));
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // One reference per book for now; never silently replace an edition.
    try {
      await writeFile(this.path(bookId, "attachment.json"), JSON.stringify({ path: sourcePath, sha256: document.sha256, ...(calibre ? { calibre } : {}) }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && calibre) {
        const previous = JSON.parse(await readFile(this.path(bookId, "attachment.json"), "utf8")) as { sha256?: unknown };
        if (previous.sha256 !== document.sha256) throw new Error("This is a different EPUB edition. Unlink the current file before linking another edition.", { cause: error });
        const staged = this.path(bookId, `${randomUUID()}.tmp`);
        await writeFile(staged, JSON.stringify({ path: sourcePath, sha256: document.sha256, calibre }), { mode: 0o600 });
        await rename(staged, this.path(bookId, "attachment.json")); return await this.open(bookId) ?? document;
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This book already has an EPUB linked.", { cause: error });
      throw error;
    }
    return document;
  }
  async open(bookId: string): Promise<EpubDocument | undefined> {
    let attachment: unknown;
    try { attachment = JSON.parse(await readFile(this.path(bookId, "attachment.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!attachment || typeof attachment !== "object" || !("path" in attachment) || typeof attachment.path !== "string" || !("sha256" in attachment) || typeof attachment.sha256 !== "string") throw new Error("EPUB link is invalid.");
    let document: EpubDocument;
    try {
      const source = "calibre" in attachment && this.resolveCalibre ? await this.resolveCalibre(attachment.calibre) : attachment.path;
      document = await parseEpub(await readEpubFile(source));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("The linked EPUB moved or is unavailable. Return it to its original location to read it.", { cause: error });
      throw error;
    }
    if (document.sha256 !== attachment.sha256) throw new Error("The linked EPUB has changed. Edition review is needed before reusing its reading position.");
    try {
      const saved: unknown = JSON.parse(await readFile(this.path(bookId, "json"), "utf8"));
      if (saved && typeof saved === "object" && "sha256" in saved && saved.sha256 === document.sha256 && "chapter" in saved && "paragraph" in saved) {
        const { chapter, paragraph } = saved;
        if (typeof chapter === "number" && Number.isInteger(chapter) && chapter >= 0 && chapter < document.chapters.length && typeof paragraph === "number" && Number.isInteger(paragraph) && paragraph >= 0 && paragraph < (document.chapters[chapter]!.paragraphs ?? document.chapters[chapter]!.text.split("\n\n")).length) {
          const offset = "offset" in saved ? saved.offset : undefined;
          if (offset === undefined || (typeof offset === "number" && Number.isInteger(offset) && offset >= 0 && offset <= (document.chapters[chapter]!.paragraphs ?? document.chapters[chapter]!.text.split("\n\n"))[paragraph]!.length)) {
            return { ...document, position: { chapter, paragraph, ...(offset ? { offset } : {}) } };
          }
        }
      }
    } catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return document;
  }
  async unlink(bookId: string): Promise<void> {
    await rm(this.path(bookId, "attachment.json"), { force: true });
    await rm(this.path(bookId, "json"), { force: true });
  }
  async savePosition(bookId: string, sha256: unknown, chapter: unknown, paragraph: unknown, offset?: unknown): Promise<void> {
    const document = await this.open(bookId);
    if (!document || document.sha256 !== sha256 || typeof chapter !== "number" || !Number.isInteger(chapter) || chapter < 0 || chapter >= document.chapters.length || typeof paragraph !== "number" || !Number.isInteger(paragraph) || paragraph < 0 || paragraph >= (document.chapters[chapter]!.paragraphs ?? document.chapters[chapter]!.text.split("\n\n")).length) throw new Error("Reading position is invalid.");
    if (offset !== undefined && (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > (document.chapters[chapter]!.paragraphs ?? document.chapters[chapter]!.text.split("\n\n"))[paragraph]!.length)) throw new Error("Reading offset is invalid.");
    const target = this.path(bookId, "json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ sha256, chapter, paragraph, ...(offset ? { offset } : {}) }), { mode: 0o600 });
    await rename(temporary, target);
  }
}
