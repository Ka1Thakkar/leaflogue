import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Synthetic reader exports. Every title, author, and passage below was written
 * for these tests; none is an excerpt from a real book or a personal library.
 */

export const KOBO_BOOK = { title: "The Glass Orchard", author: "Imogen Vale" } as const;
export const KOBO_PASSAGES = [
  "Every pane of the orchard held a different season.",
  "She pruned the light instead of the branches.",
] as const;
export const KOBO_NOTE = "Return to this image when writing about patience.";

export const KINDLE_BOOK = "Harbour of Small Lights (Tomas Reyes)";
export const KINDLE_PASSAGE = "The lighthouse kept a ledger of every ship it had failed to see.";
export const KINDLE_NOTE = "Compare with the orchard's seasons.";

export const PORTABLE_BOOKS = {
  duplicate: { id: "portable-orchard", title: "The Glass Orchard", authors: ["Imogen Vale"] },
  tidewater: { id: "portable-tidewater", title: "Notes on Tidewater", authors: ["Ada Morrow"] },
} as const;
export const PORTABLE_PASSAGES = {
  orchard: "Glass remembers the hand that shaped it.",
  tide: "The tide keeps its own calendar.",
  tideRevised: "The tide keeps its own calendar, and it is never late.",
} as const;

/** A minimal Kobo `KoboReader.sqlite` with the columns the importer reads. */
export function writeKoboDatabase(directory: string): string {
  const path = join(directory, "KoboReader.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE Bookmark (
        BookmarkID TEXT, VolumeID TEXT, Text TEXT, Annotation TEXT, Type TEXT,
        Hidden INTEGER, StartContainerPath TEXT, DateCreated TEXT
      );
      CREATE TABLE content (
        ContentID TEXT, Title TEXT, Attribution TEXT, ISBN TEXT, ReadStatus INTEGER
      );
    `);
    database.prepare("INSERT INTO content VALUES (?, ?, ?, NULL, 1)")
      .run("file:///mnt/onboard/glass-orchard.epub", KOBO_BOOK.title, KOBO_BOOK.author);
    const bookmark = database.prepare("INSERT INTO Bookmark VALUES (?, ?, ?, ?, 'highlight', 0, ?, '2026-01-04T10:00:00Z')");
    bookmark.run("kobo-mark-1", "file:///mnt/onboard/glass-orchard.epub", KOBO_PASSAGES[0], KOBO_NOTE, "/chapter/1");
    bookmark.run("kobo-mark-2", "file:///mnt/onboard/glass-orchard.epub", KOBO_PASSAGES[1], null, "/chapter/2");
  } finally {
    database.close();
  }
  return path;
}

/** An English Kindle `My Clippings.txt` with one highlight and its note. */
export function writeKindleClippings(directory: string): string {
  const path = join(directory, "My Clippings.txt");
  writeFileSync(path, [
    KINDLE_BOOK,
    "- Your Highlight on Location 120-122 | Added on Monday, January 5, 2026 9:15:00 PM",
    "",
    KINDLE_PASSAGE,
    "==========",
    KINDLE_BOOK,
    "- Your Note on Location 121 | Added on Monday, January 5, 2026 9:16:00 PM",
    "",
    KINDLE_NOTE,
    "==========",
    "",
  ].join("\r\n"));
  return path;
}

/**
 * A portable JSON export. The same path is rewritten with `revised` for the
 * re-import, so the import source recognises the file it read before.
 */
export function writePortableExport(directory: string, revised = false): string {
  const path = join(directory, "reading-export.json");
  writeFileSync(path, JSON.stringify({
    formatVersion: 1,
    books: [PORTABLE_BOOKS.duplicate, PORTABLE_BOOKS.tidewater],
    annotations: [
      { id: "portable-1", bookId: PORTABLE_BOOKS.duplicate.id, text: PORTABLE_PASSAGES.orchard, location: "Page 12" },
      { id: "portable-2", bookId: PORTABLE_BOOKS.tidewater.id, text: revised ? PORTABLE_PASSAGES.tideRevised : PORTABLE_PASSAGES.tide, location: "Page 3" },
    ],
  }, null, 2));
  return path;
}

/** A file that names a supported format but cannot be parsed. */
export function writeMalformedPortable(directory: string): string {
  const path = join(directory, "damaged-export.json");
  writeFileSync(path, "{ \"formatVersion\": 1, \"books\": [");
  return path;
}

/** A file with a backup extension that is not a SQLite database. */
export function writeInvalidBackup(directory: string): string {
  const path = join(directory, "not-a-backup.sqlite");
  writeFileSync(path, "This is plain text with a database extension.\n".repeat(8));
  return path;
}

export const TOLINO_PASSAGE = "Every pane held a season.";
export const TOLINO_NOTE = "Seasons as glass.";
export const KOREADER_PASSAGE = "The frost kept its counsel.";

/** A Tolino notes.txt with a highlight, a note on a passage, and a bookmark. */
export function writeTolinoNotes(directory: string): string {
  const path = join(directory, "notes.txt");
  writeFileSync(path, [
    `Winter Glass (Vale, Imogen)\nHighlight on page 12: "${TOLINO_PASSAGE}"\nAdded on 01/05/2026 | 9:15`,
    `Winter Glass (Vale, Imogen)\nNote on page 14: ${TOLINO_NOTE}\n"She pruned the light."\nAdded on 01/05/2026 | 9:16`,
    "Winter Glass (Vale, Imogen)\nBookmark on page 20: \"The end of the chapter.\"\nAdded on 01/05/2026 | 9:17",
  ].join("\n-----------------------------------\n"));
  return path;
}

/** A books folder with one KOReader sidecar beside its (absent) book. */
export function writeKOReaderFolder(directory: string): string {
  const folder = join(directory, "KOReader books");
  mkdirSync(join(folder, "Frost Ledger.sdr"), { recursive: true });
  writeFileSync(join(folder, "Frost Ledger.sdr", "metadata.epub.lua"), `-- we can read Lua syntax here!
return {
    ["annotations"] = {
        [1] = {
            ["datetime"] = "2026-01-05 21:14:05",
            ["pageno"] = 9,
            ["pos0"] = "/body/DocFragment[3]/body/p[2]/text().0",
            ["text"] = "${KOREADER_PASSAGE}",
        },
    },
    ["doc_props"] = {
        ["authors"] = "Tomas Reyes",
        ["title"] = "The Frost Ledger",
    },
}
`);
  return folder;
}
