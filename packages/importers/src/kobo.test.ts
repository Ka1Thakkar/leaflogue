import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { extractKoboDatabase, type ReadonlyDatabase } from "./kobo";

function withDatabase(run: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    run(database);
  } finally {
    database.close();
  }
}

describe("Kobo extraction", () => {
  it("refuses tables that are really views computed at read time", () =>
    withDatabase((database) => {
      database.exec(`
        CREATE TABLE real_bookmarks (BookmarkID TEXT, VolumeID TEXT, Text TEXT);
        CREATE VIEW Bookmark AS SELECT * FROM real_bookmarks;
        CREATE TABLE content (ContentID TEXT, Title TEXT);
      `);
      expect(() => extractKoboDatabase(database as unknown as ReadonlyDatabase)).toThrow(/Bookmark is not a table/);
    }));

  it("shortens over-long fields and drops implausible dates instead of failing", () =>
    withDatabase((database) => {
      database.exec(`
        CREATE TABLE Bookmark (BookmarkID TEXT, VolumeID TEXT, Text TEXT, DateCreated TEXT);
        CREATE TABLE content (ContentID TEXT, Title TEXT, Attribution TEXT);
      `);
      database.prepare("INSERT INTO content VALUES ('book-1', ?, 'A. Writer')").run("T".repeat(5_000));
      database.prepare("INSERT INTO Bookmark VALUES ('mark-1', 'book-1', 'A passage.', '1600-01-01T00:00:00Z')").run();
      const { document } = extractKoboDatabase(database as unknown as ReadonlyDatabase);
      expect(document.books[0]?.title).toHaveLength(1_000);
      expect(document.annotations[0]).not.toHaveProperty("createdAt");
    }));


  it("selects only annotation and referenced book fields", () =>
    withDatabase((database) => {
      database.exec(`
        CREATE TABLE Bookmark (
          BookmarkID TEXT, VolumeID TEXT, Text TEXT, Annotation TEXT,
          Type TEXT, Hidden INTEGER, StartContainerPath TEXT, UserID TEXT
        );
        CREATE TABLE content (
          ContentID TEXT, Title TEXT, Attribution TEXT, ISBN TEXT,
          ReadStatus INTEGER, PrivateField TEXT
        );
        INSERT INTO content VALUES
          ('book-1', 'Piranesi', 'Susanna Clarke', '9781635575637', 2, 'do-not-copy'),
          ('unrelated', 'Private book', 'Someone', NULL, 0, 'do-not-copy');
        INSERT INTO Bookmark VALUES
          ('mark-1', 'book-1', 'Every room of the House.', 'Remember this.',
           'highlight', 0, '/chapter/1', 'private-user');
      `);
      const preview = extractKoboDatabase(database as unknown as ReadonlyDatabase);
      expect(preview.document.books).toEqual([
        {
          providerRecordId: "book-1",
          title: "Piranesi",
          authors: ["Susanna Clarke"],
          isbn13: "9781635575637",
          status: "finished",
        },
      ]);
      expect(preview.document.annotations[0]).toMatchObject({
        providerRecordId: "mark-1",
        text: "Every room of the House.",
        note: "Remember this.",
        location: "/chapter/1",
      });
      expect(JSON.stringify(preview)).not.toMatch(/private-user|do-not-copy|Private book/);
    }));

  it("keeps note-only records without inventing passage text", () =>
    withDatabase((database) => {
      database.exec(`
        CREATE TABLE Bookmark (BookmarkID TEXT, VolumeID TEXT, Annotation TEXT);
        CREATE TABLE content (ContentID TEXT, Title TEXT);
        INSERT INTO Bookmark VALUES ('note-1', 'missing-book', 'An independent note');
      `);
      const preview = extractKoboDatabase(database as unknown as ReadonlyDatabase);
      expect(preview.document.annotations[0]).toEqual({
        providerRecordId: "note-1",
        bookProviderRecordId: "missing-book",
        note: "An independent note",
      });
      expect(preview.warnings).toMatchObject([{ code: "missing-book" }]);
    }));

  it("rejects duplicate bookmark IDs before persistence", () =>
    withDatabase((database) => {
      database.exec(`
        CREATE TABLE Bookmark (BookmarkID TEXT, VolumeID TEXT, Text TEXT);
        CREATE TABLE content (ContentID TEXT);
        INSERT INTO Bookmark VALUES ('same', 'book', 'One'), ('same', 'book', 'Two');
      `);
      expect(() => extractKoboDatabase(database as unknown as ReadonlyDatabase)).toThrow(/duplicate bookmark IDs/);
    }));
  it("names the chapter and how far through the book a passage sits", () =>
    withDatabase((database) => {
      database.exec(`
        CREATE TABLE Bookmark (BookmarkID TEXT, VolumeID TEXT, Text TEXT, ContentID TEXT, StartContainerPath TEXT, ChapterProgress REAL);
        CREATE TABLE content (ContentID TEXT, Title TEXT, ContentType INTEGER, BookID TEXT, VolumeIndex INTEGER);
        INSERT INTO content VALUES
          ('book', 'Piranesi', 6, NULL, NULL),
          ('book!OEBPS!part1.xhtml-1', 'Part 1: Piranesi', 899, 'book', 0),
          ('book!OEBPS!part1.xhtml-2', 'Part 1, continued', 899, 'book', 1),
          ('book!OEBPS!part2.xhtml-1', 'Part 2: The Other', 899, 'book', 2),
          ('book!OEBPS!part3.xhtml-1', 'Part 3: The Prophet', 899, 'book', 3),
          ('book!OEBPS!notes.xhtml', '', 899, 'book', 4);
        INSERT INTO Bookmark VALUES
          ('a', 'book', 'First.', 'book!OEBPS!part1.xhtml', 'span#kobo\\.1\\.1', 0.1),
          ('b', 'book', 'Second.', 'book!OEBPS!part3.xhtml', 'span#kobo\\.9\\.1', 0.5),
          ('c', 'book', 'Third.', 'book!OEBPS!notes.xhtml', 'span#kobo\\.2\\.1', NULL),
          ('d', 'book', 'Fourth.', 'book!OEBPS!unknown.xhtml', 'span#kobo\\.3\\.1', 0.2);
      `);
      const locations = extractKoboDatabase(database as unknown as ReadonlyDatabase).document.annotations.map(({ location }) => location);
      expect(locations).toEqual(["Part 1: Piranesi · 3%", "Part 3: The Prophet · 63%", "75%", "span#kobo\\.3\\.1"]);
    }));
});
