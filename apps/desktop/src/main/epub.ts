import { formatEpubChapter, type EpubFormatBudget } from "./epub-format";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { SaxesParser } from "saxes";
import type { ReaderDocument } from "@leaflogue/contracts";

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

export async function parseEpub(bytes: Buffer): Promise<ReaderDocument> {
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
  return { format: "epub", sha256: createHash("sha256").update(bytes).digest("hex"), chapters, position: { chapter: 0, paragraph: 0 } };
}
