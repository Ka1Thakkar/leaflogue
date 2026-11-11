import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { EpubStore, epubText, parseEpub } from "./epub";

/** Minimal ZIP fixtures with real central directory and CRCs, no external tools. */
function zip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path);
    const bytes = Buffer.from(text);
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
    await expect(parseEpub(zip({ ...files, "META-INF/encryption.xml": "<encryption/>" }))).rejects.toThrow(/Encrypted/u);
    await expect(parseEpub(zip({ ...files, "../outside": "escape" }))).rejects.toThrow();
    await expect(parseEpub(zip({ ...files, "OPS/large": "x".repeat(8 * 1024 * 1024 + 1) }))).rejects.toThrow(/expanded/u);
    await expect(parseEpub(Buffer.from("not a zip"))).rejects.toThrow();
  });
  it("retains original bytes and restores a validated position after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "leaflogue-epub-"));
    const id = "12345678-1234-4234-8234-123456789abc";
    try {
      const store = new EpubStore(root);
      expect(await store.open(id)).toBeUndefined();
      const bytes = zip(files);
      const source = join(root, "original.epub");
      await writeFile(source, bytes);
      const document = await store.attach(id, source);
      await store.savePosition(id, document.sha256, 0, 2);
      expect((await new EpubStore(root).open(id))?.position).toEqual({ chapter: 0, paragraph: 2 });
      expect(await readFile(source)).toEqual(bytes);
      await expect(store.attach(id, source)).rejects.toThrow(/already/u);
      await expect(store.savePosition(id, "different-edition", 0, 0)).rejects.toThrow();
      await expect(store.savePosition(id, document.sha256, -1, 0)).rejects.toThrow();
      await expect(store.savePosition(id, document.sha256, 0, 999)).rejects.toThrow();
      await store.savePosition(id, document.sha256, 0, 1, 3);
      expect((await new EpubStore(root).open(id))?.position).toEqual({ chapter: 0, paragraph: 1, offset: 3 });
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
