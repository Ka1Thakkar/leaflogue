import { DatabaseSync } from "node:sqlite";
import { readFile, realpath, writeFile, mkdir, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { catalogIsbn13 } from "@leaflogue/catalog";
import type { CalibreConnection, CalibreFormat, CalibreReference, CalibreSearch, NewBook } from "@leaflogue/contracts";

const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f\d-]{36}$/iu.test(value);
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
interface Connection extends CalibreConnection { readonly root: string }
interface Entry { uuid: string; title: string; authors: string; isbn: string | null; path: string; name: string; formats: string }
const entryQuery = `SELECT b.uuid, b.title, b.path, d.name, group_concat(upper(d.format), char(31)) formats,
 (SELECT group_concat(a.name, char(31)) FROM books_authors_link l JOIN authors a ON a.id=l.author WHERE l.book=b.id) authors,
 (SELECT val FROM identifiers WHERE book=b.id AND type='isbn' LIMIT 1) isbn
 FROM books b JOIN data d ON d.book=b.id AND upper(d.format) IN ('EPUB','KEPUB')`;

/** Calibre owns all catalogue and book files. Only Leaflogue's connection file is written. */
export class CalibreLibrary {
  constructor(private readonly configFile: string) {}
  private async connection(): Promise<Connection | undefined> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.configFile, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!value || typeof value !== "object" || !("root" in value) || typeof value.root !== "string" || !isAbsolute(value.root) || !("libraryId" in value) || !uuid(value.libraryId)) throw new Error("Choose your Calibre library again.");
    return { root: value.root, libraryId: value.libraryId, name: basename(value.root), bookCount: 0 };
  }
  private async catalogue<T>(rootPath: string, expectedId: string | undefined, read: (db: DatabaseSync, root: string, id: string) => T): Promise<T> {
    const root = await realpath(rootPath);
    const file = await realpath(join(root, "metadata.db"));
    if (relative(root, file).startsWith(`..${sep}`) || isAbsolute(relative(root, file))) throw new Error("Calibre metadata must be inside the selected library.");
    const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
      const identity = db.prepare("SELECT uuid FROM library_id LIMIT 1").get()?.uuid;
      if (!uuid(identity) || (expectedId && identity !== expectedId)) throw new Error("This folder contains a different Calibre library. Choose the original library again.");
      return read(db, root, identity);
    } finally { db.close(); }
  }
  async connect(root: string): Promise<CalibreConnection> {
    const connection = await this.catalogue(root, undefined, (db, root, id): Connection => ({ root, libraryId: id, name: basename(root), bookCount: Number(db.prepare("SELECT count(DISTINCT book) n FROM data WHERE upper(format) IN ('EPUB','KEPUB')").get()!.n) }));
    await mkdir(dirname(this.configFile), { recursive: true, mode: 0o700 });
    const staged = `${this.configFile}.${randomUUID()}.tmp`;
    await writeFile(staged, JSON.stringify(connection), { mode: 0o600 }); await rename(staged, this.configFile);
    const { root: _root, ...status } = connection; void _root;
    return status;
  }
  async describe(): Promise<CalibreConnection | undefined> {
    const connection = await this.connection(); if (!connection) return undefined;
    return this.catalogue(connection.root, connection.libraryId, (db, root, id) => ({ libraryId: id, name: basename(root), bookCount: Number(db.prepare("SELECT count(DISTINCT book) n FROM data WHERE upper(format) IN ('EPUB','KEPUB')").get()!.n) }));
  }
  async search(query: string, book?: NewBook): Promise<CalibreSearch> {
    if (query.length > 200) throw new Error("Use a shorter Calibre search.");
    const connection = await this.connection(); if (!connection) throw new Error("Connect a Calibre library first.");
    return this.catalogue(connection.root, connection.libraryId, (db) => {
      const pattern = `%${query.trim().replace(/[\\%_]/gu, "\\$&")}%`;
      const rows = db.prepare(`${entryQuery} WHERE (b.title LIKE ? ESCAPE '\\' OR b.author_sort LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM books_authors_link l JOIN authors a ON a.id=l.author WHERE l.book=b.id AND a.name LIKE ? ESCAPE '\\') OR EXISTS(SELECT 1 FROM identifiers i WHERE i.book=b.id AND i.val LIKE ? ESCAPE '\\')) GROUP BY b.id ORDER BY b.title, b.uuid LIMIT 51`).all(pattern, pattern, pattern, pattern) as unknown as Entry[];
      return { hasMore: rows.length > 50, books: rows.slice(0, 50).filter((row) => uuid(row.uuid)).map((row) => {
        const authors = String(row.authors ?? "").split("\x1f").filter(Boolean).slice(0, 30).map((author) => author.slice(0, 300));
        const isbn13 = catalogIsbn13(row.isbn ?? undefined);
        const match = isbn13 && book?.isbn13 && isbn13 === catalogIsbn13(book.isbn13) ? "isbn" : book && normalize(row.title) === normalize(book.title) && authors.some((author) => book.authors?.some((candidate) => normalize(candidate) === normalize(author))) ? "title-author" : "none";
        const formats = (["EPUB", "KEPUB"] as const).filter((format) => String(row.formats).split("\x1f").includes(format));
        return { formats, uuid: row.uuid, title: String(row.title).slice(0, 1000), authors, ...(isbn13 ? { isbn13 } : {}), match };
      }) };
    });
  }
  async reference(bookUuid: string, format: CalibreFormat = "EPUB"): Promise<{ reference: CalibreReference; path: string }> {
    const connection = await this.connection(); if (!connection || !uuid(bookUuid) || !["EPUB", "KEPUB"].includes(format)) throw new Error("Choose a Calibre book first.");
    const reference = { libraryRoot: connection.root, libraryId: connection.libraryId, bookUuid, format };
    return { reference, path: await this.resolve(reference) };
  }
  async resolve(value: unknown): Promise<string> {
    if (!value || typeof value !== "object") throw new Error("Invalid Calibre reference.");
    const reference = value as Partial<CalibreReference>;
    if (!uuid(reference.libraryId) || !uuid(reference.bookUuid) || typeof reference.libraryRoot !== "string" || !isAbsolute(reference.libraryRoot)) throw new Error("Invalid Calibre reference.");
    const format = reference.format ?? "EPUB";
    if (format !== "EPUB" && format !== "KEPUB") throw new Error("Choose EPUB or KEPUB from Calibre.");
    const current = await this.connection();
    const rootPath = current?.libraryId === reference.libraryId ? current.root : reference.libraryRoot;
    const candidate = await this.catalogue(rootPath, reference.libraryId, (db, root) => {
      const row = db.prepare(`${entryQuery} WHERE b.uuid=? AND upper(d.format)=? GROUP BY b.id LIMIT 1`).get(reference.bookUuid!, format) as unknown as Entry | undefined;
      if (!row || !row.path || !row.name || basename(row.name) !== row.name || isAbsolute(row.path)) throw new Error(`The linked Calibre book no longer has the selected ${format} format.`);
      return { root, path: join(root, row.path, `${row.name}.${format.toLowerCase()}`) };
    });
    const file = await realpath(candidate.path);
    const offset = relative(candidate.root, file);
    if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error("The EPUB must stay inside the selected Calibre library.");
    return file;
  }
}
