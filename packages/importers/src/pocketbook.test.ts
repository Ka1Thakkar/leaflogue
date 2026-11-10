import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ReadonlyDatabase } from "./kobo";
import { extractPocketBookDatabase, isPocketBookDatabase } from "./pocketbook";

function library(run: (database: DatabaseSync) => void): ReadonlyDatabase {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE Books (OID INTEGER PRIMARY KEY, Title TEXT, Authors TEXT, Isbn TEXT, Lang TEXT);
    CREATE TABLE Items (OID INTEGER PRIMARY KEY, ParentID INTEGER, TypeID INTEGER, State INTEGER, TimeAlt INTEGER, HashUUID TEXT);
    CREATE TABLE TagNames (OID INTEGER PRIMARY KEY, TagName TEXT);
    CREATE TABLE Tags (OID INTEGER PRIMARY KEY, ItemID INTEGER, TagID INTEGER, Val TEXT, TimeEdt INTEGER);
    INSERT INTO TagNames VALUES (101, 'bm.anchor'), (102, 'bm.type'), (104, 'bm.quotation'), (105, 'bm.note'), (106, 'bm.color');
    INSERT INTO Books VALUES (1, 'The Glass Orchard', 'Imogen Vale; A. Translator', '978-0-306-40615-7', 'en');
  `);
  run(database);
  return database as unknown as ReadonlyDatabase;
}

describe("PocketBook import", () => {
  it("joins each item's quotation, note, and type, reading JSON and plain values", async () => {
    const database = library((db) => db.exec(`
      INSERT INTO Items VALUES (10, 1, 4, 0, 1735689600, '6f1c2b0e-1111-4c6f-9a55-000000000010');
      INSERT INTO Tags VALUES (1, 10, 104, '{"begin":"pbr:/word?page=11&offs=40","end":"pbr:/word?page=11&offs=90","text":"Every pane held a season."}', 1735689600);
      INSERT INTO Tags VALUES (2, 10, 105, '{"text":"Seasons as glass."}', 1735689700);
      INSERT INTO Tags VALUES (3, 10, 102, 'note', 1735689600);
      INSERT INTO Tags VALUES (4, 10, 106, 'yellow', 1735689600);
      INSERT INTO Items VALUES (11, 1, 4, 0, 1735776000, NULL);
      INSERT INTO Tags VALUES (5, 11, 104, 'She pruned the light.', 1735776000);
      INSERT INTO Items VALUES (12, 1, 4, 2, 1735776000, 'deleted');
      INSERT INTO Tags VALUES (6, 12, 104, '{"text":"Removed on the reader."}', 1735776000);
      INSERT INTO Items VALUES (13, 1, 4, 0, 1735776000, 'bookmark');
      INSERT INTO Tags VALUES (7, 13, 102, 'bookmark', 1735776000);
    `));
    expect(isPocketBookDatabase(database)).toBe(true);
    const { document, warnings } = await extractPocketBookDatabase(database, Date.UTC(2026, 0, 1));
    expect(document.books).toEqual([{
      providerRecordId: expect.stringMatching(/^pocketbook-book:[0-9a-f]{64}$/),
      title: "The Glass Orchard",
      authors: ["Imogen Vale", "A. Translator"],
      isbn13: "9780306406157",
      language: "en",
    }]);
    expect(document.annotations).toEqual([
      {
        providerRecordId: "pocketbook:6f1c2b0e-1111-4c6f-9a55-000000000010",
        bookProviderRecordId: document.books[0]!.providerRecordId,
        text: "Every pane held a season.",
        note: "Seasons as glass.",
        location: "Page 11",
        createdAt: 1735689600000,
      },
      {
        providerRecordId: expect.stringMatching(/^pocketbook:[0-9a-f]{64}:1$/),
        bookProviderRecordId: document.books[0]!.providerRecordId,
        text: "She pruned the light.",
        createdAt: 1735776000000,
      },
    ]);
    expect(warnings.map(({ message }) => message)).toEqual(["Skipped 1 deleted highlight.", "Skipped 1 bookmark or pencil drawing."]);
  });

  it("falls back to PocketBook's tag IDs, links through Files, and reads the published sample values", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE Books (OID INTEGER PRIMARY KEY, Title TEXT, Authors TEXT);
      CREATE TABLE Files (OID INTEGER PRIMARY KEY, BookID INTEGER, Name TEXT);
      CREATE TABLE Items (OID INTEGER PRIMARY KEY, ParentID INTEGER, TypeID INTEGER, State INTEGER, TimeAlt INTEGER, HashUUID TEXT);
      CREATE TABLE TagNames (OID INTEGER PRIMARY KEY, TagName TEXT);
      CREATE TABLE Tags (ItemID INTEGER, TagID INTEGER, Val TEXT, TimeEdt INTEGER);
      INSERT INTO Books VALUES (7, 'Le Consentement', 'Vanessa Springora');
      INSERT INTO Files VALUES (300, 7, 'consentement.epub');
      INSERT INTO Items VALUES (900, 300, 4, 0, 1687936650, 'f3a9');
      INSERT INTO Tags VALUES (900, 101, '{"anchor":"pbr:/word?page=1&offs=398","created":1687936650}', 1687936650);
      INSERT INTO Tags VALUES (900, 102, 'note', 1687936650);
      INSERT INTO Tags VALUES (900, 104, '{"begin":"pbr:/word?page=1&offs=398","end":"pbr:/word?page=1&over=484","text":"Nous avons toujours cru que les vies de nos enfants seraient meilleures que les nôtres."}', 1687936650);
      INSERT INTO Tags VALUES (900, 105, '{"context":"Et maintenant en 2023 on en est encore plus sûrs que ça ne sera pas le cas !"}', 1687936650);
      INSERT INTO Tags VALUES (900, 106, 'cian', 1687936650);
      INSERT INTO Items VALUES (901, 300, 4, 0, 1687936660, 'f3aa');
      INSERT INTO Tags VALUES (901, 102, 'draws', 1687936660);
      INSERT INTO Tags VALUES (901, 104, '{"text":"Potlood"}', 1687936660);
    `);
    const { document, warnings } = await extractPocketBookDatabase(database as unknown as ReadonlyDatabase, Date.UTC(2026, 0, 1));
    expect(document.books.map(({ title }) => title)).toEqual(["Le Consentement"]);
    expect(document.annotations).toEqual([{
      providerRecordId: "pocketbook:f3a9",
      bookProviderRecordId: document.books[0]!.providerRecordId,
      text: "Nous avons toujours cru que les vies de nos enfants seraient meilleures que les nôtres.",
      note: "Et maintenant en 2023 on en est encore plus sûrs que ça ne sera pas le cas !",
      location: "Page 1",
      createdAt: 1687936650000,
    }]);
    expect(warnings.map(({ message }) => message)).toEqual(["Skipped 1 bookmark or pencil drawing."]);
  });

  it("refuses views posing as tables, and a database that is not PocketBook's", async () => {
    const view = new DatabaseSync(":memory:");
    view.exec(`
      CREATE TABLE Books (OID INTEGER); CREATE TABLE real_items (OID INTEGER, ParentID INTEGER);
      CREATE VIEW Items AS SELECT * FROM real_items; CREATE TABLE Tags (ItemID INTEGER, TagID INTEGER, Val TEXT);
      CREATE TABLE TagNames (OID INTEGER, TagName TEXT);
    `);
    const database = view as unknown as ReadonlyDatabase;
    expect(isPocketBookDatabase(database)).toBe(false);
    await expect(extractPocketBookDatabase(database)).rejects.toThrow(/Items is not a table/);
    const kobo = new DatabaseSync(":memory:");
    kobo.exec("CREATE TABLE Bookmark (BookmarkID TEXT); CREATE TABLE content (ContentID TEXT);");
    expect(isPocketBookDatabase(kobo as unknown as ReadonlyDatabase)).toBe(false);
  });

  it("drops implausible times instead of failing", async () => {
    const database = library((db) => db.exec(`
      INSERT INTO Items VALUES (10, 1, 4, 0, 99999999999, NULL);
      INSERT INTO Tags VALUES (1, 10, 104, 'A passage.', NULL);
    `));
    expect((await extractPocketBookDatabase(database, Date.UTC(2026, 0, 1))).document.annotations[0]).not.toHaveProperty("createdAt");
  });
});

describe("PocketBook limits", () => {
  it("refuses a Files view and survives duplicate item IDs repeating a large value", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE Books (OID INTEGER, Title TEXT, Authors TEXT);
      CREATE TABLE Items (OID INTEGER, ParentID INTEGER, TypeID INTEGER, State INTEGER, TimeAlt INTEGER, HashUUID TEXT);
      CREATE TABLE TagNames (OID INTEGER, TagName TEXT);
      CREATE TABLE Tags (ItemID INTEGER, TagID INTEGER, Val TEXT, TimeEdt INTEGER);
      CREATE VIEW Files AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x AS OID, x AS BookID FROM c;
      INSERT INTO Books VALUES (1, 'Orchard', '');
      INSERT INTO Tags VALUES (5, 104, '{"text":"A passage."}', 0);
    `);
    const repeat = database.prepare("INSERT INTO Items VALUES (5, 1, 4, 0, 0, NULL)");
    for (let index = 0; index < 3; index += 1) repeat.run();
    // A value over 1 MiB is skipped unread.
    database.prepare("INSERT INTO Tags VALUES (5, 105, ?, 0)").run("x".repeat(2 * 1024 * 1024));
    const { document } = await extractPocketBookDatabase(database as unknown as ReadonlyDatabase);
    expect(document.annotations).toHaveLength(1);
    expect(document.annotations[0]).not.toHaveProperty("note");

    // Many duplicates of a large value reach the total cap quickly instead of freezing.
    for (let index = 0; index < 50; index += 1) repeat.run();
    const started = performance.now();
    await expect(extractPocketBookDatabase(database as unknown as ReadonlyDatabase)).rejects.toThrow("exceed the 64 MiB limit");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("gives a book the same identity on another device or after a re-index", async () => {
    const first = await extractPocketBookDatabase(library((db) => db.exec(`
      INSERT INTO Items VALUES (10, 1, 4, 0, 0, NULL);
      INSERT INTO Tags VALUES (1, 10, 104, 'Every pane held a season.', 0);
    `)));
    const reindexed = new DatabaseSync(":memory:");
    reindexed.exec(`
      CREATE TABLE Books (OID INTEGER PRIMARY KEY, Title TEXT, Authors TEXT, Isbn TEXT, Lang TEXT);
      CREATE TABLE Items (OID INTEGER PRIMARY KEY, ParentID INTEGER, TypeID INTEGER, State INTEGER, TimeAlt INTEGER, HashUUID TEXT);
      CREATE TABLE TagNames (OID INTEGER PRIMARY KEY, TagName TEXT);
      CREATE TABLE Tags (OID INTEGER PRIMARY KEY, ItemID INTEGER, TagID INTEGER, Val TEXT, TimeEdt INTEGER);
      INSERT INTO Books VALUES (1, 'A different book', '', NULL, NULL);
      INSERT INTO Books VALUES (40, 'The Glass Orchard', 'Imogen Vale; A. Translator', '978-0-306-40615-7', 'en');
      INSERT INTO Items VALUES (99, 40, 4, 0, 0, NULL);
      INSERT INTO Tags VALUES (1, 99, 104, 'Every pane held a season.', 0);
    `);
    const second = await extractPocketBookDatabase(reindexed as unknown as ReadonlyDatabase);
    expect(second.document.books[0]!.providerRecordId).toBe(first.document.books[0]!.providerRecordId);
    expect(second.document.annotations[0]!.providerRecordId).toBe(first.document.annotations[0]!.providerRecordId);
  });
});
