import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, mkdir, readFile, writeFile, rename, rm, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CalibreLibrary } from "./calibre";
const libraryId = "11111111-1111-4111-8111-111111111111";
const bookUuid = "22222222-2222-4222-8222-222222222222";
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "leaflogue-calibre-"))); const library = join(root, "Calibre Library");
  await mkdir(join(library, "Author", "Book"), { recursive: true });
  const db = new DatabaseSync(join(library, "metadata.db"));
  db.exec(`CREATE TABLE library_id(uuid TEXT); CREATE TABLE books(id INTEGER,uuid TEXT,title TEXT,path TEXT,author_sort TEXT); CREATE TABLE data(book INTEGER,format TEXT,name TEXT); CREATE TABLE authors(id INTEGER,name TEXT); CREATE TABLE books_authors_link(book INTEGER,author INTEGER); CREATE TABLE identifiers(book INTEGER,type TEXT,val TEXT);`);
  db.prepare("INSERT INTO library_id VALUES(?)").run(libraryId);
  db.prepare("INSERT INTO books VALUES(1,?,'A Book','Author/Book','A Reader')").run(bookUuid);
  db.exec("INSERT INTO data VALUES(1,'EPUB','a-book'); INSERT INTO authors VALUES(1,'A Reader'); INSERT INTO books_authors_link VALUES(1,1); INSERT INTO identifiers VALUES(1,'isbn','9780306406157');"); db.close();
  await writeFile(join(library, "Author/Book/a-book.epub"), "unchanged book bytes");
  return { root, library, service: new CalibreLibrary(join(root, "leaflogue", "calibre.json")) };
}
describe("read-only Calibre connections", () => {
  it("searches current schema, suggests matches, and writes only Leaflogue configuration", async () => {
    const { root, library, service } = await fixture();
    try {
      const before = await readFile(join(library, "metadata.db")); const beforeFiles = await readdir(library);
      expect(await service.connect(library)).toMatchObject({ libraryId, bookCount: 1 });
      expect((await service.search("A Book", { title: "A Book", authors: ["A Reader"], isbn13: "9780306406157" })).books[0]).toMatchObject({ uuid: bookUuid, match: "isbn" });
      expect((await service.search("%' OR 1=1 --")).books).toHaveLength(0);
      expect((await service.search("A Book", { title: "A Book", authors: ["A Reader"] })).books[0]?.match).toBe("title-author");
      const linked = await service.reference(bookUuid);
      expect(linked.path).toBe(join(library, "Author/Book/a-book.epub"));
      expect(await readFile(join(library, "metadata.db"))).toEqual(before);
      expect(await readdir(library)).toEqual(beforeFiles);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("follows a renamed file and a reconnected library by stable UUIDs", async () => {
    const { root, library, service } = await fixture();
    try {
      await service.connect(library); const { reference } = await service.reference(bookUuid);
      await rename(join(library, "Author/Book/a-book.epub"), join(library, "Author/Book/renamed.epub"));
      const db = new DatabaseSync(join(library, "metadata.db")); db.exec("UPDATE data SET name='renamed'"); db.close();
      expect(await service.resolve(reference)).toBe(join(library, "Author/Book/renamed.epub"));
      const moved = join(root, "Moved Calibre"); await rename(library, moved); await service.connect(moved);
      expect(await service.resolve(reference)).toBe(join(moved, "Author/Book/renamed.epub"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects links escaping the selected library and missing books", async () => {
    const { root, library, service } = await fixture();
    try {
      await service.connect(library);
      const source = join(library, "Author/Book/a-book.epub"); await rm(source); await writeFile(join(root, "outside.epub"), "private file"); await symlink(join(root, "outside.epub"), source);
      await expect(service.reference(bookUuid)).rejects.toThrow(/inside/u);
      await expect(service.reference("33333333-3333-4333-8333-333333333333")).rejects.toThrow(/no longer/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("Calibre book formats", () => {
  it("lists a book once and preserves the selected KEPUB format through renames and reconnects", async () => {
    const { root, library, service } = await fixture();
    try {
      const db = new DatabaseSync(join(library, "metadata.db"));
      db.exec("INSERT INTO data VALUES(1,'KEPUB','kobo-book'); INSERT INTO data VALUES(1,'PDF','print-book')"); db.close();
      await writeFile(join(library, "Author/Book/kobo-book.kepub"), "kobo edition bytes");
      const before = await readFile(join(library, "metadata.db"));
      expect(await service.connect(library)).toMatchObject({ bookCount: 1 });
      const books = (await service.search("A Book")).books;
      expect(books).toHaveLength(1); expect(books[0]?.formats).toEqual(["EPUB", "KEPUB"]);
      const { reference, path } = await service.reference(bookUuid, "KEPUB");
      expect(reference.format).toBe("KEPUB"); expect(path).toBe(join(library, "Author/Book/kobo-book.kepub"));
      expect(await readFile(join(library, "metadata.db"))).toEqual(before);
      expect((await service.reference(bookUuid, "EPUB")).path).toBe(join(library, "Author/Book/a-book.epub"));
      const { format: _format, ...legacy } = reference; void _format;
      expect(await service.resolve(legacy)).toBe(join(library, "Author/Book/a-book.epub"));
      await rename(path, join(library, "Author/Book/kobo-renamed.kepub"));
      const changed = new DatabaseSync(join(library, "metadata.db")); changed.exec("UPDATE data SET name='kobo-renamed' WHERE format='KEPUB'"); changed.close();
      const moved = join(root, "Moved Calibre"); await rename(library, moved); await service.connect(moved);
      expect(await service.resolve(reference)).toBe(join(moved, "Author/Book/kobo-renamed.kepub"));
      const missing = new DatabaseSync(join(moved, "metadata.db")); missing.exec("DELETE FROM data WHERE format='KEPUB'"); missing.close();
      await expect(service.resolve(reference)).rejects.toThrow(/selected KEPUB/u);
      await expect(service.resolve({ ...reference, format: "../PDF" })).rejects.toThrow(/Choose EPUB or KEPUB/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("offers KEPUB-only books and applies the same file-boundary checks", async () => {
    const { root, library, service } = await fixture();
    try {
      const db = new DatabaseSync(join(library, "metadata.db")); db.exec("UPDATE data SET format='KEPUB'"); db.close();
      await rename(join(library, "Author/Book/a-book.epub"), join(library, "Author/Book/a-book.kepub"));
      expect(await service.connect(library)).toMatchObject({ bookCount: 1 });
      expect((await service.search("")).books[0]?.formats).toEqual(["KEPUB"]);
      await expect(service.reference(bookUuid, "EPUB")).rejects.toThrow(/selected EPUB/u);
      expect((await service.reference(bookUuid, "KEPUB")).path).toMatch(/a-book\.kepub$/u);
      await rm(join(library, "Author/Book/a-book.kepub"));
      await writeFile(join(root, "outside.kepub"), "outside");
      await symlink(join(root, "outside.kepub"), join(library, "Author/Book/a-book.kepub"));
      await expect(service.reference(bookUuid, "KEPUB")).rejects.toThrow(/inside/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
