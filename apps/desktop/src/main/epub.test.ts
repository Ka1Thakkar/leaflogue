import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { epubText, parseEpub } from "./epub";
import { ReaderStore } from "./reader-store";
import { utimes } from "node:fs/promises";

/** Minimal ZIP fixtures with real central directory and CRCs, no external tools. */
function zip(files: Record<string, string | Buffer>): Buffer {
  const local: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path);
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += header.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...directory, end]);
}
const files = {
  mimetype: "application/epub+zip",
  "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  "OPS/book.opf": '<package><manifest><item id="two" href="second.xhtml" media-type="application/xhtml+xml"/><item id="one" href="first.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
  "OPS/first.xhtml": '<html><head><title>Hidden</title></head><body><h1>First chapter</h1><p>One &amp; two.</p><script>evil()</script><p onclick="evil()">Three.</p><img src="https://example.com/tracker"/></body></html>',
  "OPS/second.xhtml": '<html><body><p>Second chapter.</p></body></html>',
};

describe("local EPUB reader", () => {
  it("reads Kobo KEPUB spans and emphasis through the same inert EPUB parser", async () => {
    const bytes = await readFile(new URL("../../../../tests/fixtures/local-reader.kepub", import.meta.url));
    const book = await parseEpub(bytes);
    expect(book.chapters[0]?.text).toContain("A small passage with emphasis stays readable.");
    expect(book.chapters[0]?.html).toContain("<em");
    expect(book.chapters[0]?.html).not.toContain("<script");
  });
  it("follows the spine, preserves original file identity, and returns only inert text", async () => {
    const result = await parseEpub(zip(files));
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.chapters.map((chapter) => chapter.id)).toEqual(["OPS/first.xhtml", "OPS/second.xhtml"]);
    expect(result.chapters[0]!.text).toBe("First chapter\n\nOne & two.\n\nThree.");
    expect(JSON.stringify(result)).not.toMatch(/evil|tracker|onclick/u);
  });
  it("rejects entities, malformed XML, encryption, traversal and oversized content", async () => {
    expect(() => epubText('<!DOCTYPE html [<!ENTITY x SYSTEM "file:///etc/passwd">]><html><body>&x;</body></html>')).toThrow();
    expect(() => epubText("<html><body><p>Broken</html>")).toThrow();
    await expect(parseEpub(zip({ ...files, "META-INF/encryption.xml": '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OPS/first.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>' }))).rejects.toThrow(/DRM/u);
    await expect(parseEpub(zip({ ...files, "../outside": "escape" }))).rejects.toThrow();
    await expect(parseEpub(zip({ ...files, "OPS/large": "x".repeat(8 * 1024 * 1024 + 1) }))).rejects.toThrow(/expanded/u);
    await expect(parseEpub(Buffer.from("not a zip"))).rejects.toThrow();
  });
  it("retains local reviewed locations without altering the original file or another edition", async () => {
    const root = await mkdtemp(join(tmpdir(), "leaflogue-reviewed-anchor-"));
    const id = "12345678-1234-4234-8234-123456789abc"; const highlightId = "22345678-1234-4234-8234-123456789abc";
    try {
      const source = join(root, "book.epub"); const bytes = zip(files); await writeFile(source, bytes);
      const store = new ReaderStore(root); const book = await store.attach(id, source);
      const location = `epub:${book.sha256}:0:1:0:1:3`;
      await store.saveAnchor(id, book.sha256, highlightId, location);
      expect((await new ReaderStore(root).open(id))?.localAnchors).toEqual({ [highlightId]: location });
      for (const invalid of [`epub:other:0:1:0:1:3`, `epub:${book.sha256}:99:1:0:1:3`, `epub:${book.sha256}:0:1:9:1:3`, `epub:${book.sha256}:0:1:0:1:999`, `epub:${book.sha256}:0:1:-1:1:3`]) await expect(store.saveAnchor(id, book.sha256, highlightId, invalid)).rejects.toThrow();
      expect(await readFile(source)).toEqual(bytes);
      await store.saveAnchor(id, book.sha256, highlightId, null);
      expect((await store.open(id))?.localAnchors).toEqual({});
      await store.saveAnchor(id, book.sha256, highlightId, location); await store.unlink(id); await store.attach(id, source);
      expect((await store.open(id))?.localAnchors).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("persists edition-bound bookmarks and clears them on unlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "leaflogue-bookmarks-"));
    const id = "12345678-1234-4234-8234-123456789abc";
    try {
      const source = join(root, "book.epub"); const bytes = zip(files);
      await writeFile(source, bytes);
      const store = new ReaderStore(root); const document = await store.attach(id, source);
      const bookmarks = [{ chapter: 0, paragraph: 1, offset: 2 }];
      await store.saveBookmarks(id, document.sha256, bookmarks);
      expect((await new ReaderStore(root).open(id))?.bookmarks).toEqual(bookmarks);
      await expect(store.saveBookmarks(id, "other-edition", [])).rejects.toThrow(/edition/u);
      for (const invalid of [[{ chapter: 9, paragraph: 0 }], [{ chapter: 0, paragraph: 1, offset: 999 }], [bookmarks[0], bookmarks[0]], Array(501).fill(bookmarks[0]), null]) await expect(store.saveBookmarks(id, document.sha256, invalid)).rejects.toThrow();
      expect((await store.open(id))?.bookmarks).toEqual(bookmarks);
      await store.saveBookmarks(id, document.sha256, []);
      expect((await store.open(id))?.bookmarks).toEqual([]);
      expect(await readFile(source)).toEqual(bytes);
      await store.unlink(id); await store.attach(id, source);
      expect((await store.open(id))?.bookmarks).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("retains original bytes and restores a validated position after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "leaflogue-epub-"));
    const id = "12345678-1234-4234-8234-123456789abc";
    try {
      const store = new ReaderStore(root);
      expect(await store.open(id)).toBeUndefined();
      const bytes = zip(files);
      const source = join(root, "original.epub");
      await writeFile(source, bytes);
      const document = await store.attach(id, source);
      await store.savePosition(id, document.sha256, 0, 2);
      expect((await new ReaderStore(root).open(id))?.position).toEqual({ chapter: 0, paragraph: 2 });
      expect(await readFile(source)).toEqual(bytes);
      await expect(store.attach(id, source)).rejects.toThrow(/already/u);
      await expect(store.savePosition(id, "different-edition", 0, 0)).rejects.toThrow();
      await expect(store.savePosition(id, document.sha256, -1, 0)).rejects.toThrow();
      await expect(store.savePosition(id, document.sha256, 0, 999)).rejects.toThrow();
      await store.savePosition(id, document.sha256, 0, 1, 3);
      expect((await new ReaderStore(root).open(id))?.position).toEqual({ chapter: 0, paragraph: 1, offset: 3 });
      await expect(store.savePosition(id, document.sha256, 0, 1, 9999)).rejects.toThrow();
      await expect(store.open("../../outside")).rejects.toThrow();
      expect((await readdir(root)).filter((name) => name.endsWith(".epub"))).toEqual(["original.epub"]);
      await writeFile(source, zip({ ...files, "OPS/second.xhtml": "<html><body><p>Edited edition</p></body></html>" }));
      await expect(store.open(id)).rejects.toThrow(/changed/u);
      await rm(source);
      await expect(store.open(id)).rejects.toThrow(/moved or is unavailable/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("linked book state", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  async function linked(prefix: string) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const source = join(root, "book.epub"); await writeFile(source, zip(files));
    let parses = 0;
    const store = new ReaderStore(root, undefined, (bytes) => { parses++; return parseEpub(bytes); });
    const document = await store.attach(id, source);
    return { root, source, store, document, parses: () => parses };
  }
  it("saves positions, bookmarks and reviewed locations without parsing the book again", async () => {
    const { root, source, store, document, parses } = await linked("leaflogue-parse-cache-");
    try {
      await store.open(id);
      for (let index = 0; index < 20; index++) await store.savePosition(id, document.sha256, 0, index % 3, index % 2);
      await store.saveBookmarks(id, document.sha256, [{ chapter: 0, paragraph: 1 }]);
      await store.saveAnchor(id, document.sha256, "22345678-1234-4234-8234-123456789abc", `epub:${document.sha256}:0:1:0:1:3`);
      await store.open(id);
      // Linking parsed the book once; opening and every save reuse that parse.
      expect(parses()).toBe(1);
      expect((await store.open(id))?.bookmarks).toEqual([{ chapter: 0, paragraph: 1, offset: 0 }]);
      // A changed file is noticed by its size and modification time, keeping edition protection.
      await writeFile(source, zip({ ...files, "OPS/second.xhtml": "<html><body><p>Edited edition</p></body></html>" }));
      await utimes(source, new Date(), new Date(Date.now() + 5000));
      await expect(store.savePosition(id, document.sha256, 0, 0)).rejects.toThrow(/changed/u);
      // Unlinking forgets the cached edition.
      await store.unlink(id);
      await expect(store.savePosition(id, document.sha256, 0, 0)).rejects.toThrow(/invalid/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("opens a book whose optional sidecars are damaged and keeps the damaged files for recovery", async () => {
    const { root, store, document } = await linked("leaflogue-sidecars-");
    try {
      for (const [suffix, body] of [["anchors.json", "null"], ["bookmarks.json", "null"], ["json", "null"]] as const) await writeFile(join(root, `${id}.${suffix}`), body);
      const opened = await store.open(id);
      expect(opened?.sha256).toBe(document.sha256);
      expect(opened?.position).toEqual({ chapter: 0, paragraph: 0 });
      expect(opened?.bookmarks).toBeUndefined();
      expect((await readdir(root)).filter((name) => name.includes(".corrupt-")).length).toBe(3);
      // Malformed JSON and hash-matching but malformed bookmarks also stop blocking the book.
      await writeFile(join(root, `${id}.anchors.json`), "{not json");
      await writeFile(join(root, `${id}.bookmarks.json`), JSON.stringify({ sha256: document.sha256, bookmarks: [{ chapter: 0, paragraph: 1 }, null, { chapter: 9, paragraph: 0 }, { chapter: 0, paragraph: 1 }] }));
      await writeFile(join(root, `${id}.json`), JSON.stringify({ sha256: document.sha256, chapter: "x" }));
      const recovered = await store.open(id);
      expect(recovered?.bookmarks).toEqual([{ chapter: 0, paragraph: 1, offset: 0 }]);
      expect(recovered?.localAnchors).toBeUndefined();
      expect((await new ReaderStore(root).open(id))?.bookmarks).toEqual([{ chapter: 0, paragraph: 1, offset: 0 }]);
      expect((await readdir(root)).filter((name) => name.includes(".corrupt-")).length).toBe(5);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("relinks a moved file of the same edition and keeps every piece of local state", async () => {
    const { root, source, store, document } = await linked("leaflogue-relocate-");
    try {
      const highlight = "22345678-1234-4234-8234-123456789abc"; const location = `epub:${document.sha256}:0:1:0:1:3`;
      await store.savePosition(id, document.sha256, 0, 2);
      await store.saveBookmarks(id, document.sha256, [{ chapter: 1, paragraph: 0 }]);
      await store.saveAnchor(id, document.sha256, highlight, location);
      const moved = join(root, "moved.epub"); await writeFile(moved, await readFile(source)); await rm(source);
      await expect(store.open(id)).rejects.toThrow(/\[book-file:missing\]/u);
      const result = await store.relocate(id, moved);
      expect(result.status).toBe("relinked");
      const reopened = await new ReaderStore(root).open(id);
      expect(reopened?.position).toEqual({ chapter: 0, paragraph: 2 });
      expect(reopened?.bookmarks).toEqual([{ chapter: 1, paragraph: 0, offset: 0 }]);
      expect(reopened?.localAnchors).toEqual({ [highlight]: location });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("links another edition only after confirmation, keeping bookmarks that still exist", async () => {
    const { root, source, store, document } = await linked("leaflogue-relocate-edition-");
    try {
      await store.savePosition(id, document.sha256, 0, 2);
      await store.saveBookmarks(id, document.sha256, [{ chapter: 0, paragraph: 0 }, { chapter: 0, paragraph: 2 }]);
      const other = join(root, "other.epub");
      await writeFile(other, zip({ ...files, "OPS/first.xhtml": "<html><body><p>Only one paragraph now.</p></body></html>" }));
      await writeFile(source, zip({ ...files, "OPS/second.xhtml": "<html><body><p>Edited edition</p></body></html>" }));
      await expect(store.open(id)).rejects.toThrow(/\[book-file:changed\]/u);
      expect(await store.relocate(id, other)).toEqual({ status: "different-edition" });
      await expect(store.open(id)).rejects.toThrow(/changed/u);
      const result = await store.relocate(id, other, true);
      if (result.status !== "relinked") throw new Error("Expected a relinked book");
      expect(result.document.sha256).not.toBe(document.sha256);
      expect(result.document.bookmarks).toEqual([{ chapter: 0, paragraph: 0, offset: 0 }]);
      expect(result.document.position).toEqual({ chapter: 0, paragraph: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("reports unreadable files and damaged links with their own failure kinds", async () => {
    const { root, source, store } = await linked("leaflogue-failure-kinds-");
    try {
      await writeFile(source, "not a book");
      await expect(store.open(id)).rejects.toThrow(/\[book-file:unreadable\]/u);
      await writeFile(join(root, `${id}.attachment.json`), "null");
      await expect(store.open(id)).rejects.toThrow(/\[book-file:invalid-link\]/u);
      await store.unlink(id);
      expect(await store.open(id)).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("leaves Calibre-linked books to the Calibre reconnect path", async () => {
    const root = await mkdtemp(join(tmpdir(), "leaflogue-relocate-calibre-"));
    try {
      const source = join(root, "book.epub"); await writeFile(source, zip(files));
      await new ReaderStore(root, async () => source).attach(id, source, { libraryRoot: root, libraryId: id, bookUuid: id, format: "EPUB" });
      const store = new ReaderStore(root, async () => { throw new Error("gone"); });
      await expect(store.open(id)).rejects.toThrow(/\[book-file:missing\+calibre\]/u);
      await expect(store.relocate(id, source)).rejects.toThrow(/Calibre/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("Calibre KEPUB conversions", () => {
  it("opens a KEPUB that links Adobe's page template as a stylesheet", async () => {
    const kepub = zip({
      mimetype: "application/epub+zip",
      "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      "OEBPS/content.opf": '<package><manifest><item id="t" href="page-template.xpgt" media-type="application/vnd.adobe-page-template+xml"/><item id="s" href="stylesheet.css" media-type="text/css"/><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>',
      "OEBPS/page-template.xpgt": "<?xml version='1.0' encoding='utf-8'?>\n<ade:template xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:ade=\"http://ns.adobe.com/2006/ade\" xmlns:fo=\"http://www.w3.org/1999/XSL/Format\"><fo:layout-master-set/></ade:template>",
      "OEBPS/stylesheet.css": "p { text-indent: 1em }",
      "OEBPS/chapter.xhtml": '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" type="text/css" href="stylesheet.css"/><link rel="stylesheet" type="application/vnd.adobe-page-template+xml" href="page-template.xpgt"/><style type="text/css" id="kobostylehacks">div#book-inner p, div#book-inner div { font-size: 1.0em; }</style></head><body><div id="book-columns"><div id="book-inner"><p><span class="koboSpan" id="kobo.1.1">Linked at last.</span></p></div></div></body></html>',
    });
    const document = await parseEpub(kepub);
    expect(JSON.stringify(document)).toContain("Linked at last.");
    expect(JSON.stringify(document)).toContain("text-indent");
    expect(JSON.stringify(document)).not.toContain("ade:template");
  });
  it("embeds a font shared by every chapter once instead of once per chapter", async () => {
    const chapters = Array.from({ length: 30 }, (_, index) => index);
    const kepub = zip({
      mimetype: "application/epub+zip",
      "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      "OEBPS/content.opf": `<package><manifest><item id="s" href="style.css" media-type="text/css"/><item id="f" href="book.ttf" media-type="font/ttf"/>${chapters.map((index) => `<item id="c${index}" href="c${index}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((index) => `<itemref idref="c${index}"/>`).join("")}</spine></package>`,
      "OEBPS/style.css": "@font-face { font-family: Book; src: url(book.ttf) } body { font-family: Book }",
      "OEBPS/book.ttf": "f".repeat(2 * 1024 * 1024),
      ...Object.fromEntries(chapters.map((index) => [`OEBPS/c${index}.xhtml`, `<html><head><link rel="stylesheet" href="style.css"/></head><body><p><span class="koboSpan" id="kobo.1.1">Chapter ${index + 1}.</span></p></body></html>`])),
    });
    const document = await parseEpub(kepub);
    expect(document.chapters).toHaveLength(30);
    const styles = document.chapters.map((chapter) => chapter.styles ?? "").join("");
    expect(styles.match(/data:font\/ttf;base64,/gu)).toHaveLength(1);
    expect(document.chapters[29]!.text).toBe("Chapter 30.");
  });
  it("restores fonts obfuscated with the IDPF and Adobe schemes, as Calibre KEPUBs carry them", async () => {
    const { createHash } = await import("node:crypto");
    const font = Buffer.from(Array.from({ length: 1500 }, (_, index) => index % 251));
    const mask = (bytes: Buffer, key: Buffer, length: number) => { const out = Buffer.from(bytes); for (let index = 0; index < Math.min(out.length, length); index++) out[index]! ^= key[index % key.length]!; return out; };
    const book = (identifier: string, algorithm: string, masked: Buffer) => zip({
      mimetype: "application/epub+zip",
      "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      "META-INF/encryption.xml": `<encryption xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="OEBPS/fonts/Book%20Face.ttf"/></enc:CipherData></enc:EncryptedData></encryption>`,
      "OEBPS/content.opf": `<package unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="isbn">9781423155164</dc:identifier><dc:identifier id="uid">${identifier}</dc:identifier></metadata><manifest><item id="f" href="fonts/Book%20Face.ttf" media-type="font/ttf"/><item id="s" href="style.css" media-type="text/css"/><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>`,
      "OEBPS/fonts/Book Face.ttf": masked,
      "OEBPS/style.css": '@font-face { font-family: Book; src: url("fonts/Book%20Face.ttf") }',
      "OEBPS/c.xhtml": '<html><head><link rel="stylesheet" href="style.css"/></head><body><p>Readable.</p></body></html>',
    });
    const embedded = (document: Awaited<ReturnType<typeof parseEpub>>) => Buffer.from(/data:font\/ttf;base64,([A-Za-z\d+/=]+)/u.exec(document.chapters[0]!.styles ?? "")![1]!, "base64");
    const idpfId = " urn:uuid:6f1c3b0e-8d2a-4f5b-9c1e-2a7b3c4d5e6f\n";
    const idpfKey = createHash("sha1").update(idpfId.replace(/[ \t\r\n]/gu, "")).digest();
    expect(embedded(await parseEpub(book(idpfId, "http://www.idpf.org/2008/embedding", mask(font, idpfKey, 1040))))).toEqual(font);
    const adobeId = "urn:uuid:6f1c3b0e-8d2a-4f5b-9c1e-2a7b3c4d5e6f";
    const adobeKey = Buffer.from("6f1c3b0e8d2a4f5b9c1e2a7b3c4d5e6f", "hex");
    const adobe = await parseEpub(book(adobeId, "http://ns.adobe.com/pdf/enc#RC", mask(font, adobeKey, 1024)));
    expect(embedded(adobe)).toEqual(font);
    expect(adobe.chapters[0]!.text).toBe("Readable.");
  });
  it("opens the book without a masked font it cannot restore", async () => {
    const document = await parseEpub(zip({
      ...files,
      "META-INF/encryption.xml": '<encryption xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/><enc:CipherData><enc:CipherReference URI="OPS/font.ttf"/></enc:CipherData></enc:EncryptedData></encryption>',
      "OPS/font.ttf": "scrambled",
    }));
    expect(document.chapters[0]!.text).toContain("First chapter");
  });
});

