import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MAX_NOTE_BYTES, MAX_NOTES_PER_HIGHLIGHT, MAX_SYNC_ORGANIZATION_MEMBERSHIPS, normalizeOrganizationName } from "@leaflogue/contracts";
import type { SyncedChange } from "@leaflogue/contracts";
import { LocalLibrary, applyMigrations, latestSchemaVersion, migrations, recoverInterruptedFileReplacement, replaceFileWithRollback, validateLibraryBackup } from "./index";

describe("SQLite migrations", () => {
  it("creates and reopens a durable library", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-storage-test-"));
    const path = join(directory, "library.sqlite");
    try {
      const library = new LocalLibrary(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(library.schemaVersion).toBe(17);
      const created = library.createBook({
        title: " Piranesi ",
        authors: ["Susanna Clarke"],
        isbn13: "978-1-63557-563-7",
      });
      expect(created).toMatchObject({
        title: "Piranesi",
        authors: ["Susanna Clarke"],
        isbn13: "9781635575637",
        revision: 1,
      });
      library.close();

      const reopened = new LocalLibrary(path);
      expect(reopened.listBooks()).toEqual([created]);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a restorable copy of the library as the previous release left it before migrating", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-upgrade-snapshot-"));
    const path = join(directory, "library.sqlite");
    const previous = latestSchemaVersion - 1;
    const snapshot = join(directory, `library.before-upgrade.schema-${previous}.sqlite`);
    try {
      new LocalLibrary(path).close();
      expect(readdirSync(directory).filter((name) => name.includes("before-upgrade"))).toEqual([]);

      rmSync(path);
      const older = new DatabaseSync(path);
      applyMigrations(older, migrations.slice(0, previous));
      older.prepare(`INSERT INTO books (id, title, authors_json, created_at, updated_at)
        VALUES ('10000000-0000-4000-8000-000000000000', 'Piranesi', '[]', 1, 1)`).run();
      older.close();
      writeFileSync(join(directory, "library.before-upgrade.schema-1.sqlite"), "stale");
      writeFileSync(join(directory, "library.before-upgrade.schema-2.sqlite"), "stale");

      const upgraded = new LocalLibrary(path);
      expect(upgraded.schemaVersion).toBe(latestSchemaVersion);
      upgraded.close();
      expect(statSync(snapshot).mode & 0o777).toBe(0o600);
      validateLibraryBackup(snapshot);
      const copy = new DatabaseSync(snapshot, { readOnly: true });
      expect(copy.prepare("PRAGMA user_version").get()).toEqual({ user_version: previous });
      expect(copy.prepare("SELECT title FROM books").all()).toEqual([{ title: "Piranesi" }]);
      copy.close();
      expect(readdirSync(directory).filter((name) => name.includes("before-upgrade")).sort()).toEqual([
        `library.before-upgrade.schema-${previous}.sqlite`,
        "library.before-upgrade.schema-2.sqlite",
      ].sort());

      new LocalLibrary(path).close();
      expect(statSync(snapshot).isFile()).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates a manual passage and its first note in one transaction", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const book = library.createBook({ title: "Piranesi" });
      const highlight = library.createHighlight({
        bookId: book.id,
        text: "The House",
        noteMarkdown: "Remember the tides.",
      });
      expect(highlight.notes).toMatchObject([{ markdown: "Remember the tides.", origin: "reader", revision: 1 }]);
      expect(() => library.createHighlight({
        bookId: book.id,
        text: "Never partially create this",
        noteMarkdown: "x".repeat(100_001),
      })).toThrow(/Note text is too long/);
      expect(library.getBookContents(book.id)?.highlights).toHaveLength(1);
    } finally {
      library.close();
    }
  });

  it("keeps an explanation as an AI note without promising an imported original", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const book = library.createBook({ title: "Piranesi" });
      const highlight = library.createHighlight({ bookId: book.id, text: "Every Room of the House" });
      const kept = library.createNote({ bookId: book.id, highlightId: highlight.id, markdown: "An explanation.", origin: "ai" });
      expect(kept).toMatchObject({ origin: "ai", revision: 1 });
      expect(library.createNote({ bookId: book.id, markdown: "Mine." })).toMatchObject({ origin: "reader" });
      expect(library.getBookContents(book.id)?.highlights[0]?.notes).toMatchObject([{ origin: "ai" }]);
      // An AI note has no imported source, so it must not surface as one.
      expect(library.getHighlightSource(book.id, highlight.id)).toBeUndefined();
    } finally {
      library.close();
    }
  });

  it("migrates collection and tag organisation while allowing synced name collisions", () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    try {
      expect(applyMigrations(database)).toBe(17);
      database.prepare(`INSERT INTO books
        (id, title, authors_json, status, archived, created_at, updated_at, revision)
        VALUES (?, ?, '[]', 'unread', 0, 1, 1, 1)`)
        .run("10000000-0000-4000-8000-000000000000", "Piranesi");
      database.prepare(`INSERT INTO highlights
        (id, book_id, text, archived, deleted, created_at, updated_at, revision)
        VALUES (?, ?, ?, 0, 0, 1, 1, 1)`)
        .run("20000000-0000-4000-8000-000000000000", "10000000-0000-4000-8000-000000000000", "The House");
      database.prepare(`INSERT INTO collections
        (id, name, normalized_name, created_at, updated_at, revision) VALUES (?, ?, ?, 1, 1, 1)`)
        .run("30000000-0000-4000-8000-000000000000", "Été Reads", normalizeOrganizationName("Été Reads"));
      database.prepare(`INSERT INTO tags
        (id, name, normalized_name, color, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1, 1, 1)`)
        .run("40000000-0000-4000-8000-000000000000", "Architecture", normalizeOrganizationName("Architecture"), "ochre");
      database.prepare("INSERT INTO collection_books (collection_id, book_id, created_at) VALUES (?, ?, 1)")
        .run("30000000-0000-4000-8000-000000000000", "10000000-0000-4000-8000-000000000000");
      database.prepare("INSERT INTO book_tags (tag_id, book_id, created_at) VALUES (?, ?, 1)")
        .run("40000000-0000-4000-8000-000000000000", "10000000-0000-4000-8000-000000000000");
      database.prepare("INSERT INTO highlight_tags (tag_id, highlight_id, created_at) VALUES (?, ?, 1)")
        .run("40000000-0000-4000-8000-000000000000", "20000000-0000-4000-8000-000000000000");

      expect(database.prepare("SELECT count(*) AS count FROM collection_books").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT count(*) AS count FROM book_tags").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT count(*) AS count FROM highlight_tags").get()).toEqual({ count: 1 });
      database.prepare(`INSERT INTO collections
        (id, name, normalized_name, created_at, updated_at, revision) VALUES (?, ?, ?, 1, 1, 1)`)
        .run("50000000-0000-4000-8000-000000000000", "été reads", normalizeOrganizationName("été reads"));
      expect(database.prepare("SELECT count(*) AS count FROM collections").get()).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("preserves the outbox sequence high-water mark while upgrading an empty v8 outbox", () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    try {
      expect(applyMigrations(database, migrations.slice(0, 8))).toBe(8);
      database.exec(`
        INSERT INTO sync_devices (id, created_at, updated_at) VALUES ('device', 1, 1);
        INSERT INTO sync_state (singleton, device_id, updated_at) VALUES (1, 'device', 1);
      `);
      database.prepare(`INSERT INTO books
        (id, title, authors_json, status, archived, created_at, updated_at, revision)
        VALUES (?, 'Piranesi', '[]', 'unread', 0, 1, 1, 1)`)
        .run("10000000-0000-4000-8000-000000000000");
      database.prepare("UPDATE books SET revision = 2, updated_at = 2 WHERE id = ?")
        .run("10000000-0000-4000-8000-000000000000");
      expect(database.prepare("SELECT max(sequence) AS sequence FROM sync_outbox").get()).toEqual({ sequence: 2 });
      database.prepare("DELETE FROM sync_outbox").run();

      expect(applyMigrations(database)).toBe(17);
      database.prepare(`INSERT INTO collections
        (id, name, normalized_name, created_at, updated_at, revision)
        VALUES (?, 'Keepers', 'keepers', 3, 3, 1)`)
        .run("30000000-0000-4000-8000-000000000000");
      expect(database.prepare("SELECT sequence, entity_type FROM sync_outbox").get())
        .toEqual({ sequence: 3, entity_type: "collection" });
    } finally {
      database.close();
    }
  });

  it("invalidates pre-checkpoint remote cursors during the schema 15 upgrade", () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    try {
      expect(applyMigrations(database, migrations.slice(0, 14))).toBe(14);
      database.exec(`
        INSERT INTO sync_devices (id, created_at, updated_at) VALUES ('device', 1, 1);
        INSERT INTO sync_state
          (singleton, device_id, remote_generation, remote_sequence, snapshot_required, updated_at)
        VALUES (1, 'device', 1, 42, 0, 1);
      `);
      expect(applyMigrations(database)).toBe(17);
      expect(database.prepare(`SELECT remote_generation, remote_sequence, remote_checkpoint, snapshot_required
        FROM sync_state WHERE singleton = 1`).get()).toEqual({
        remote_generation: null,
        remote_sequence: 0,
        remote_checkpoint: null,
        snapshot_required: 1,
      });
    } finally {
      database.close();
    }
  });

  it("supports revision-safe collection and tag CRUD with idempotent membership", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const book = library.createBook({ title: "Piranesi" });
      const secondBook = library.createBook({ title: "Jonathan Strange & Mr Norrell" });
      const highlight = library.createHighlight({ bookId: book.id, text: "Every room of the House" });
      const collection = library.createCollection({ name: "  Favourites  ", description: "  Return often  " });
      const tag = library.createTag({ name: "Architecture", color: "ochre" });

      expect(collection).toMatchObject({ name: "Favourites", description: "Return often", bookCount: 0, revision: 1 });
      expect(tag).toMatchObject({ name: "Architecture", color: "ochre", bookCount: 0, highlightCount: 0, revision: 1 });
      expect(() => library.createTag({ name: "ARCHITECTURE" })).toThrow();
      expect(() => library.createCollection({ name: "favourites" })).toThrow();

      library.setBookCollectionMembership({ bookId: book.id, collectionId: collection.id, included: true });
      library.setBookCollectionMembership({ bookId: book.id, collectionId: collection.id, included: true });
      library.setBookCollectionMembership({ bookId: secondBook.id, collectionId: collection.id, included: true });
      library.setBookTagMembership({ bookId: book.id, tagId: tag.id, included: true });
      library.setBookTagMembership({ bookId: secondBook.id, tagId: tag.id, included: true });
      library.setHighlightTagMembership({ bookId: book.id, highlightId: highlight.id, tagId: tag.id, included: true });
      expect(library.getBookOrganization(book.id)).toEqual({
        bookId: book.id,
        collectionIds: [collection.id],
        tagIds: [tag.id],
        highlightTags: [{ highlightId: highlight.id, tagIds: [tag.id] }],
      });
      const collectionWithBook = library.listCollections()[0]!;
      const tagWithMembership = library.listTags()[0]!;
      expect(collectionWithBook).toMatchObject({ bookCount: 2, revision: 3 });
      expect(tagWithMembership).toMatchObject({ bookCount: 2, highlightCount: 1, revision: 4 });

      const renamed = library.updateCollection({
        id: collection.id,
        name: "Best books",
        description: "",
        expectedRevision: collectionWithBook.revision,
      });
      expect(renamed).toMatchObject({ name: "Best books", revision: 4 });
      expect(renamed.description).toBeUndefined();
      expect(() => library.updateCollection({
        id: collection.id,
        name: "Stale",
        expectedRevision: collection.revision,
      })).toThrow("changed elsewhere");

      const firstBeforeTagDelete = library.getBook(book.id)!.revision;
      const secondBeforeTagDelete = library.getBook(secondBook.id)!.revision;
      library.deleteTag({ id: tag.id, expectedRevision: tagWithMembership.revision });
      expect(library.listTags()).toEqual([]);
      expect(library.getBook(book.id)!.revision).toBe(firstBeforeTagDelete + 1);
      expect(library.getBook(secondBook.id)!.revision).toBe(secondBeforeTagDelete + 1);
      expect(library.getBookOrganization(book.id)).toEqual({
        bookId: book.id,
        collectionIds: [collection.id],
        tagIds: [],
        highlightTags: [],
      });
      const firstBeforeCollectionDelete = library.getBook(book.id)!.revision;
      const secondBeforeCollectionDelete = library.getBook(secondBook.id)!.revision;
      library.deleteCollection({ id: collection.id, expectedRevision: renamed.revision });
      expect(library.listCollections()).toEqual([]);
      expect(library.getBook(book.id)!.revision).toBe(firstBeforeCollectionDelete + 1);
      expect(library.getBook(secondBook.id)!.revision).toBe(secondBeforeCollectionDelete + 1);
    } finally {
      library.close();
    }
  });

  it("keeps organization membership snapshots within the sync envelope", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const book = library.createBook({ title: "A richly organized library" });
      const tags = Array.from({ length: MAX_SYNC_ORGANIZATION_MEMBERSHIPS + 1 }, (_, index) =>
        library.createTag({ name: `Tag ${index}` }));
      for (const tag of tags.slice(0, MAX_SYNC_ORGANIZATION_MEMBERSHIPS)) {
        library.setBookTagMembership({ bookId: book.id, tagId: tag.id, included: true });
      }
      expect(library.getBookOrganization(book.id)?.tagIds).toHaveLength(MAX_SYNC_ORGANIZATION_MEMBERSHIPS);
      expect(() => library.setBookTagMembership({
        bookId: book.id,
        tagId: tags[MAX_SYNC_ORGANIZATION_MEMBERSHIPS]!.id,
        included: true,
      })).toThrow("at most 1000 tags");
      const source = library.createBook({ title: "Merge source" });
      library.setBookTagMembership({
        bookId: source.id,
        tagId: tags[MAX_SYNC_ORGANIZATION_MEMBERSHIPS]!.id,
        included: true,
      });
      expect(() => library.mergeBooks({
        sourceBookId: source.id,
        targetBookId: book.id,
        expectedSourceRevision: library.getBook(source.id)!.revision,
        expectedTargetRevision: library.getBook(book.id)!.revision,
      })).toThrow("merged book can belong to at most 1000 tags");
      expect(library.getBook(source.id)?.archived).toBe(false);
      // Idempotent inclusion and removal remain available at the cap, so old
      // over-limit data can be reduced rather than trapping the reader.
      expect(() => library.setBookTagMembership({
        bookId: book.id,
        tagId: tags[0]!.id,
        included: true,
      })).not.toThrow();
      library.setBookTagMembership({ bookId: book.id, tagId: tags[0]!.id, included: false });
      expect(() => library.setBookTagMembership({
        bookId: book.id,
        tagId: tags[MAX_SYNC_ORGANIZATION_MEMBERSHIPS]!.id,
        included: true,
      })).not.toThrow();
      expect(() => library.resolvePendingSyncChanges()).not.toThrow();
    } finally {
      library.close();
    }
  });

  it("moves collection and book-tag membership during a book merge", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const source = library.createBook({ title: "Source" });
      const target = library.createBook({ title: "Target" });
      const collection = library.createCollection({ name: "Source only" });
      const duplicateCollection = library.createCollection({ name: "Both books" });
      const tag = library.createTag({ name: "Source tag" });
      const duplicateTag = library.createTag({ name: "Both tag" });
      library.setBookCollectionMembership({ bookId: source.id, collectionId: collection.id, included: true });
      library.setBookCollectionMembership({ bookId: source.id, collectionId: duplicateCollection.id, included: true });
      library.setBookCollectionMembership({ bookId: target.id, collectionId: duplicateCollection.id, included: true });
      library.setBookTagMembership({ bookId: source.id, tagId: tag.id, included: true });
      library.setBookTagMembership({ bookId: source.id, tagId: duplicateTag.id, included: true });
      library.setBookTagMembership({ bookId: target.id, tagId: duplicateTag.id, included: true });
      const sourceStatus = library.setBookReadingStatus({
        id: source.id,
        status: "reading",
        expectedRevision: library.getBook(source.id)!.revision,
      });
      const collectionsBefore = new Map(library.listCollections().map((item) => [item.id, item]));
      const tagsBefore = new Map(library.listTags().map((item) => [item.id, item]));

      library.mergeBooks({
        sourceBookId: source.id,
        targetBookId: target.id,
        expectedSourceRevision: library.getBook(source.id)!.revision,
        expectedTargetRevision: library.getBook(target.id)!.revision,
      });

      expect(library.getBookOrganization(target.id)).toMatchObject({
        collectionIds: [duplicateCollection.id, collection.id],
        tagIds: [duplicateTag.id, tag.id],
      });
      expect(library.getBookOrganization(source.id)).toMatchObject({ collectionIds: [], tagIds: [] });
      expect(library.listReadingStatusHistory(target.id)).toEqual([
        expect.objectContaining({
          bookId: target.id,
          status: library.getBook(target.id)!.status,
          source: "merge",
          bookRevision: library.getBook(target.id)!.revision,
        }),
        { ...sourceStatus.event, bookId: target.id },
      ]);
      expect(library.listReadingStatusHistory(source.id)).toEqual([]);
      for (const item of library.listCollections()) {
        expect(item.bookCount).toBe(1);
        expect(item.revision).toBe(collectionsBefore.get(item.id)!.revision + 1);
      }
      for (const item of library.listTags()) {
        expect(item.bookCount).toBe(1);
        expect(item.revision).toBe(tagsBefore.get(item.id)!.revision + 1);
      }
    } finally {
      library.close();
    }
  });

  it("protects the database and SQLite sidecars under a permissive umask", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-storage-mode-"));
    const path = join(directory, "library.sqlite");
    const previousUmask = process.umask(0o000);
    try {
      const library = new LocalLibrary(path);
      library.createBook({ title: "Private library" });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
        if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }
      library.close();
    } finally {
      process.umask(previousUmask);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a failed migration and preserves the schema version", () => {
    const database = new DatabaseSync(":memory:");
    expect(() =>
      applyMigrations(database, [
        { version: 1, sql: "CREATE TABLE safe_value (id TEXT PRIMARY KEY) STRICT;" },
        { version: 2, sql: "THIS IS NOT SQL" },
      ]),
    ).toThrow();
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'safe_value'").get(),
    ).toBeUndefined();
    database.close();
  });

  it("refuses to open a database created by a newer application version", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA user_version = 999");
    expect(() => applyMigrations(database)).toThrow(/newer than this Leaflogue build/);
    database.close();
  });

  it("preserves v1 notes and source links when upgrading to v2", () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    database.exec("PRAGMA foreign_keys = ON");
    expect(applyMigrations(database, migrations.slice(0, 1))).toBe(1);
    database.exec(`
      INSERT INTO books (id, title, created_at, updated_at)
      VALUES ('book', 'Piranesi', 1, 1);
      INSERT INTO highlights (id, book_id, text, created_at, updated_at)
      VALUES ('highlight', 'book', 'A passage', 1, 1);
      INSERT INTO notes (id, highlight_id, markdown, created_at, updated_at)
      VALUES ('note', 'highlight', 'Remember this', 1, 1);
      INSERT INTO import_sources (id, provider, external_identity, created_at, updated_at)
      VALUES ('source', 'kobo', 'kobo:default', 1, 1);
      INSERT INTO source_annotations
        (source_id, provider_record_id, highlight_id, source_fingerprint, canonical_json, last_seen_at)
      VALUES ('source', 'annotation', 'highlight', 'digest', '{}', 1);
    `);

    expect(applyMigrations(database, migrations.slice(0, 2))).toBe(2);
    expect(database.prepare("SELECT book_id, highlight_id, markdown, origin FROM notes").get())
      .toEqual({
        book_id: "book",
        highlight_id: "highlight",
        markdown: "Remember this",
        origin: "reader",
      });
    expect(database.prepare(
      "SELECT highlight_id, note_id FROM source_annotations WHERE provider_record_id = 'annotation'",
    ).get()).toEqual({ highlight_id: "highlight", note_id: null });
    database.close();
  });

  it("detaches reader-edited v3 imports while upgrading to v4", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-v3-upgrade-"));
    const path = join(directory, "library.sqlite");
    const bookId = "10000000-0000-4000-8000-000000000000";
    const highlightId = "20000000-0000-4000-8000-000000000000";
    const noteId = "30000000-0000-4000-8000-000000000000";
    const sourceId = "40000000-0000-4000-8000-000000000000";
    try {
      const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrations(database, migrations.slice(0, 3));
      const canonical = JSON.stringify({
        providerRecordId: "highlight",
        bookProviderRecordId: "book",
        text: "Passage",
        note: "Imported note",
      });
      database.prepare("INSERT INTO books (id, title, created_at, updated_at) VALUES (?, 'Book', 1, 1)").run(bookId);
      database.prepare("INSERT INTO highlights (id, book_id, text, created_at, updated_at) VALUES (?, ?, 'Passage', 1, 1)")
        .run(highlightId, bookId);
      database.prepare(
        "INSERT INTO notes (id, book_id, highlight_id, markdown, origin, created_at, updated_at) VALUES (?, ?, ?, 'Reader edit', 'reader', 1, 2)",
      ).run(noteId, bookId, highlightId);
      database.prepare(
        "INSERT INTO import_sources (id, provider, external_identity, created_at, updated_at) VALUES (?, 'portable', 'legacy-source', 1, 1)",
      ).run(sourceId);
      database.prepare(
        "INSERT INTO source_books (source_id, provider_record_id, book_id, source_fingerprint, canonical_json, last_seen_at) VALUES (?, 'book', ?, 'book-fingerprint', '{}', 1)",
      ).run(sourceId, bookId);
      database.prepare(
        "INSERT INTO source_annotations (source_id, provider_record_id, highlight_id, note_id, source_fingerprint, canonical_json, last_seen_at) VALUES (?, 'highlight', ?, NULL, 'old-fingerprint', ?, 1)",
      ).run(sourceId, highlightId, canonical);
      database.close();

      const library = new LocalLibrary(path);
      expect(library.schemaVersion).toBe(17);
      library.importDocument({
        document: {
          formatVersion: 1,
          books: [{ providerRecordId: "book", title: "Book", authors: [] }],
          annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "book", text: "Passage", note: "Changed source note" }],
        },
        fileName: "source.json",
        provider: "portable",
        source: { id: sourceId },
        warnings: [],
      });
      expect(library.getBookContents(bookId as never)?.highlights[0]?.notes)
        .toMatchObject([{ markdown: "Reader edit", origin: "reader" }]);
      library.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves v4 path hints and reuses the linked source after upgrading to v5", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-v4-upgrade-"));
    const path = join(directory, "library.sqlite");
    const sourceId = "5a540f21-7f61-44d7-89a5-f1b4643ce26c";
    const bookId = "6b651032-8a72-45e8-9ab6-a2c5754df37d";
    const pathHash = "a".repeat(64);
    const document = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Piranesi", authors: ["Susanna Clarke"] }],
      annotations: [],
    };
    try {
      const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
      database.exec("PRAGMA foreign_keys = ON");
      applyMigrations(database, migrations.slice(0, 4));
      database.prepare(
        "INSERT INTO books (id, title, authors_json, created_at, updated_at) VALUES (?, 'Piranesi', '[\"Susanna Clarke\"]', 1, 1)",
      ).run(bookId);
      database.prepare(
        "INSERT INTO import_sources (id, provider, external_identity, created_at, updated_at) VALUES (?, 'kobo', ?, 1, 1)",
      ).run(sourceId, pathHash);
      database.prepare(
        "INSERT INTO source_books (source_id, provider_record_id, book_id, source_fingerprint, canonical_json, last_seen_at) VALUES (?, 'book', ?, 'fingerprint', '{}', 1)",
      ).run(sourceId, bookId);
      database.close();

      const library = new LocalLibrary(path);
      expect(library.schemaVersion).toBe(17);
      expect(library.listImportSources("kobo")).toMatchObject([{
        id: sourceId,
        name: `Kobo library — ${sourceId.slice(0, 8)}`,
        pathHintHash: pathHash,
      }]);
      const receipt = library.importDocument({
        document,
        fileName: "KoboReader.sqlite",
        provider: "kobo",
        source: { id: sourceId, pathHintHash: pathHash },
        warnings: [],
      });
      expect(receipt).toMatchObject({ booksCreated: 0, booksReused: 1 });
      expect(library.listBooks()).toHaveLength(1);
      library.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates a consistent backup that can be reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-backup-test-"));
    const sourcePath = join(directory, "library.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    try {
      const library = new LocalLibrary(sourcePath);
      const book = library.createBook({ title: "The Left Hand of Darkness", authors: ["Ursula K. Le Guin"] });
      await library.backupTo(backupPath);
      library.close();

      const inspection = new DatabaseSync(backupPath, { readOnly: true });
      expect(inspection.prepare("PRAGMA quick_check(1)").get()).toEqual({ quick_check: "ok" });
      expect(inspection.prepare("SELECT * FROM pragma_user_version(), pragma_application_id()").get())
        .toEqual({ user_version: 17, application_id: 1279671367 });
      inspection.close();

      const restored = new LocalLibrary(backupPath);
      expect(restored.schemaVersion).toBe(17);
      expect(restored.getBookContents(book.id)?.book).toMatchObject({
        title: "The Left Hand of Darkness",
        authors: ["Ursula K. Le Guin"],
      });
      restored.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates one durable device identity and atomically appends local reading changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-sync-state-"));
    const path = join(directory, "library.sqlite");
    try {
      const library = new LocalLibrary(path);
      const initialState = library.getSyncState();
      expect(initialState).toMatchObject({
        deviceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        snapshotRequired: true,
      });
      expect(initialState.remoteCursor).toBeUndefined();

      const book = library.createBook({ title: "Piranesi" });
      const highlight = library.createHighlight({ bookId: book.id, text: "A passage" });
      const note = library.createNote({ bookId: book.id, highlightId: highlight.id, markdown: "A note" });
      const archived = library.setBookArchived({ id: book.id, archived: true, expectedRevision: 3 });
      expect(archived.revision).toBe(4);
      const pending = library.listPendingSyncChanges();
      expect(pending).toMatchObject([
        { entityType: "book", entityId: book.id, revision: 1, operation: "upsert" },
        { entityType: "highlight", entityId: highlight.id, revision: 1, operation: "upsert" },
        { entityType: "book", entityId: book.id, revision: 2, operation: "upsert" },
        { entityType: "note", entityId: note.id, revision: 1, operation: "upsert" },
        { entityType: "book", entityId: book.id, revision: 3, operation: "upsert" },
        { entityType: "book", entityId: book.id, revision: 4, operation: "upsert" },
      ]);
      const first = pending[0]!;
      library.acknowledgeSyncChanges([first], { operationIds: [`${first.deviceId}:${first.sequence}`] });
      expect(library.listPendingSyncChanges()).toHaveLength(5);
      expect(() => library.acknowledgeSyncChanges([first], { operationIds: [`${first.deviceId}:${first.sequence}`] }))
        .toThrow(/no longer matches/);
      library.close();

      const reopened = new LocalLibrary(path);
      expect(reopened.getSyncState()).toEqual({
        deviceId: initialState.deviceId,
        snapshotRequired: true,
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bootstraps a cursor and queues every current entity without duplicates", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-sync-bootstrap-"));
    const path = join(directory, "library.sqlite");
    const remoteDeviceId = "c4000000-0000-4000-8000-000000000000";
    const remoteBookId = "c1000000-0000-4000-8000-000000000000";
    try {
      const library = new LocalLibrary(path);
      const book = library.createBook({ title: "Piranesi" });
      const highlight = library.createHighlight({ bookId: book.id, text: "The House", noteMarkdown: "Tides" });
      const note = library.createNote({ bookId: book.id, markdown: "Gone" });
      library.deleteNote({ id: note.id, bookId: book.id, expectedRevision: 1 });
      // A library that predates the outbox has history nothing queued.
      const setup = new DatabaseSync(path);
      setup.prepare("DELETE FROM sync_outbox").run();
      setup.close();

      expect(() => library.bootstrapSync({ generation: 0, afterSequence: 0 })).toThrow(/cursor is invalid/);
      expect(library.bootstrapSync({ generation: 1, afterSequence: 0 })).toEqual({ enqueued: 4 });
      expect(library.getSyncState()).toMatchObject({ snapshotRequired: false, remoteCursor: { generation: 1, afterSequence: 0 } });
      expect(() => library.bootstrapSync({ generation: 1, afterSequence: 0 })).toThrow(/already has a sync cursor/);
      const batch = library.resolvePendingSyncChanges(100);
      // Parents first; the two notes may share a millisecond, so their order is not fixed.
      const kinds = batch.changes.map(({ change }) => `${change.entityType}:${change.operation}`);
      expect(kinds.slice(0, 2)).toEqual(["book:upsert", "highlight:upsert"]);
      expect(kinds.slice(2).sort()).toEqual(["note:tombstone", "note:upsert"]);
      expect(batch.changes.find(({ change }) => change.entityType === "highlight")?.change)
        .toMatchObject({ highlight: { id: highlight.id } });

      library.applyIncomingSyncedChange({ change: { entityType: "book", operation: "upsert", deviceId: remoteDeviceId,
        deviceRevision: 1, collectionIds: [], tagIds: [], book: { id: remoteBookId, title: "Elsewhere", authors: [], status: "unread", archived: false,
          createdAt: 1, updatedAt: 1, revision: 1, highlightCount: 0 } } as unknown as SyncedChange,
      sequence: 1, expectedCursor: { generation: 1, afterSequence: 0 }, nextCursor: { generation: 1, afterSequence: 1 } });
      library.resetSyncStateAfterRestore();
      // Restoring clears provider claims, so everything is this library's own again.
      expect(library.bootstrapSync({ generation: 1, afterSequence: 0 })).toEqual({ enqueued: 5 });
      library.close();

      const second = new DatabaseSync(path);
      second.prepare("UPDATE sync_state SET snapshot_required = 1, remote_generation = NULL, remote_sequence = 0").run();
      second.close();
      const reopened = new LocalLibrary(path);
      // Everything is still pending at its current revision, so nothing is queued twice.
      expect(reopened.bootstrapSync({ generation: 1, afterSequence: 0 })).toEqual({ enqueued: 0 });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("queues received state when this replica may be the provider's only survivor", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-sync-rebootstrap-"));
    const path = join(directory, "library.sqlite");
    const remoteDeviceId = "d4000000-0000-4000-8000-000000000000";
    const remoteBookId = "d1000000-0000-4000-8000-000000000000";
    try {
      const library = new LocalLibrary(path);
      library.bootstrapSync({ generation: 1, afterSequence: 0 });
      library.applyIncomingSyncedChange({ change: { entityType: "book", operation: "upsert", deviceId: remoteDeviceId,
        deviceRevision: 1, collectionIds: [], tagIds: [], book: { id: remoteBookId, title: "Elsewhere", authors: [], status: "unread", archived: false,
          createdAt: 1, updatedAt: 1, revision: 1, highlightCount: 0 } } as unknown as SyncedChange,
      sequence: 1, expectedCursor: { generation: 1, afterSequence: 0 }, nextCursor: { generation: 1, afterSequence: 1 } });
      const own = library.createBook({ title: "Mine" });
      library.close();
      const setup = new DatabaseSync(path);
      setup.prepare("UPDATE sync_state SET snapshot_required = 1, remote_generation = NULL, remote_sequence = 0").run();
      setup.close();

      const reopened = new LocalLibrary(path);
      // "Mine" is already pending; the received book must still rebuild an
      // empty provider when its originating installation no longer exists.
      expect(reopened.bootstrapSync({ generation: 1, afterSequence: 0 })).toEqual({ enqueued: 1 });
      expect(reopened.listPendingSyncChanges()).toEqual(expect.arrayContaining([
        expect.objectContaining({ entityType: "book", entityId: own.id }),
        expect.objectContaining({ entityType: "book", entityId: remoteBookId }),
      ]));
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("compacts acknowledged history but keeps the write that still claims each entity", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-outbox-compaction-"));
    const path = join(directory, "library.sqlite");
    const remoteDeviceId = "b4000000-0000-4000-8000-000000000000";
    try {
      new LocalLibrary(path).close();
      const setup = new DatabaseSync(path);
      setup.prepare("UPDATE sync_state SET remote_generation = 1, remote_sequence = 0, snapshot_required = 0").run();
      setup.close();
      const library = new LocalLibrary(path);
      const book = library.createBook({ title: "Piranesi" });
      const note = library.createNote({ bookId: book.id, markdown: "First" });
      library.updateNote({ id: note.id, bookId: book.id, expectedRevision: 1, markdown: "Second" });
      const delivered = library.listPendingSyncChanges();
      library.acknowledgeSyncChanges(delivered, { operationIds: delivered.map((entry) => `${entry.deviceId}:${entry.sequence}`) });
      library.updateNote({ id: note.id, bookId: book.id, expectedRevision: 2, markdown: "Third" });
      const [pending] = library.listPendingSyncChanges();
      expect(pending).toMatchObject({ entityType: "note", entityId: note.id, revision: 3 });

      const inspection = new DatabaseSync(path, { readOnly: true });
      expect(inspection.prepare(
        "SELECT entity_type, revision, acknowledged_at IS NOT NULL AS acknowledged FROM sync_outbox ORDER BY sequence",
      ).all()).toEqual([
        { entity_type: "note", revision: 2, acknowledged: 1 },
        { entity_type: "book", revision: 3, acknowledged: 1 },
        { entity_type: "note", revision: 3, acknowledged: 0 },
        { entity_type: "book", revision: 4, acknowledged: 0 },
      ]);
      inspection.close();

      library.acknowledgeSyncChanges([pending!], { operationIds: [`${pending!.deviceId}:${pending!.sequence}`] });
      // The surviving row still identifies this device's claim, so an older
      // concurrent body from elsewhere loses instead of overwriting "Third".
      const incoming = { entityType: "note", operation: "upsert", deviceId: remoteDeviceId, deviceRevision: 2, note: {
        ...note, markdown: "Elsewhere", revision: 2,
      } } as unknown as SyncedChange;
      expect(library.applyIncomingSyncedChange({ change: incoming, sequence: 1,
        expectedCursor: { generation: 1, afterSequence: 0 }, nextCursor: { generation: 1, afterSequence: 1 } })).toBe("superseded");
      expect(library.getBookContents(book.id)?.standaloneNotes).toMatchObject([{ markdown: "Third" }]);
      library.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves pending entries to collapsed current state, including organization", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const { deviceId } = library.getSyncState();
      const collection = library.createCollection({ name: "Shelf" });
      const book = library.createBook({ title: "Piranesi" });
      const highlight = library.createHighlight({ bookId: book.id, text: "First wording" });
      const edited = library.updateHighlight({ id: highlight.id, bookId: book.id, text: "Final wording", expectedRevision: 1 });
      const note = library.createNote({ bookId: book.id, highlightId: highlight.id, markdown: "Gone soon" });
      library.deleteNote({ id: note.id, bookId: book.id, expectedRevision: note.revision });
      const currentBook = library.getBook(book.id)!;

      const batch = library.resolvePendingSyncChanges();
      expect(batch.hasMore).toBe(false);
      expect(batch.superseded).toEqual([]);
      expect(batch.changes.map(({ change }) => [change.entityType, change.operation, change.deviceRevision])).toEqual([
        ["collection", "upsert", 1],
        ["book", "upsert", currentBook.revision],
        ["highlight", "upsert", edited.revision],
        ["note", "tombstone", 2],
      ]);
      expect(batch.changes.every(({ change }) => change.deviceId === deviceId)).toBe(true);
      expect(batch.changes[0]!.change).toMatchObject({
        entityType: "collection", operation: "upsert", collection: { id: collection.id },
      });
      expect(batch.changes[1]!.change).toMatchObject({ book: { id: book.id, title: "Piranesi", revision: currentBook.revision } });
      expect(batch.changes[2]!.change).toMatchObject({ highlight: { id: highlight.id, text: "Final wording" } });
      expect(batch.changes[3]!.change).toEqual({
        entityType: "note", operation: "tombstone", deviceId, deviceRevision: 2, entityId: note.id, bookId: book.id,
      });
      // Every queued edit to one entity rides on its single latest-state change.
      expect(batch.changes.map(({ entries }) => entries.map(({ revision }) => revision))).toEqual([
        [1], Array.from({ length: currentBook.revision }, (_, index) => index + 1), [1, 2], [1, 2],
      ]);
      const discharged = batch.changes.flatMap(({ entries }) => entries);
      library.acknowledgeSyncChanges(discharged, { operationIds: discharged.map((entry) => `${entry.deviceId}:${entry.sequence}`) });
      expect(library.listPendingSyncChanges()).toEqual([]);
      expect(library.resolvePendingSyncChanges()).toEqual({ changes: [], superseded: [], hasMore: false });
      expect(() => library.resolvePendingSyncChanges(101)).toThrow(/limit is invalid/);
    } finally {
      library.close();
    }
  });

  it("sends a pending parent ahead of a moved child and bounds the page", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const source = library.createBook({ title: "Duplicate" });
      const highlight = library.createHighlight({ bookId: source.id, text: "A passage" });
      const target = library.createBook({ title: "Canonical" });
      library.mergeBooks({
        sourceBookId: source.id, targetBookId: target.id,
        expectedSourceRevision: library.getBook(source.id)!.revision,
        expectedTargetRevision: target.revision,
      });
      const batch = library.resolvePendingSyncChanges(2);
      expect(batch.hasMore).toBe(true);
      expect(batch.changes.map(({ change, entries }) => [change.entityType,
        change.operation === "upsert" && change.entityType === "book" ? change.book.id : undefined, entries.length])).toEqual([
        ["book", source.id, 1],
        ["book", target.id, 0],
        ["highlight", undefined, 1],
      ]);
      expect(batch.changes[2]!.change).toMatchObject({ highlight: { id: highlight.id, bookId: target.id } });
    } finally {
      library.close();
    }
  });

  it("marks local entries superseded once a winning incoming change owns the entity", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-outgoing-superseded-"));
    const path = join(directory, "library.sqlite");
    try {
      let library = new LocalLibrary(path);
      const book = library.createBook({ title: "Local title" });
      library.close();
      const setup = new DatabaseSync(path);
      setup.prepare("UPDATE sync_state SET remote_generation = 1, remote_sequence = 0, snapshot_required = 0").run();
      setup.close();
      library = new LocalLibrary(path);
      expect(library.applyIncomingSyncedChange({
        change: { entityType: "book", operation: "upsert", deviceId: "ffffffff-0000-4000-8000-000000000000", deviceRevision: 9,
          collectionIds: [], tagIds: [], book: { ...book, title: "Remote title", revision: 9 } },
        sequence: 1, expectedCursor: { generation: 1, afterSequence: 0 }, nextCursor: { generation: 1, afterSequence: 1 },
      })).toBe("applied");
      const batch = library.resolvePendingSyncChanges();
      expect(batch.changes).toEqual([]);
      expect(batch.superseded).toMatchObject([{ entityType: "book", entityId: book.id, revision: 1 }]);

      const renamed = library.updateBookMetadata({ id: book.id, expectedRevision: 2, title: "Newer local title", authors: [] });
      const next = library.resolvePendingSyncChanges();
      expect(next.superseded).toEqual([]);
      expect(next.changes).toMatchObject([{
        change: { deviceRevision: renamed.revision, book: { title: "Newer local title" } },
        entries: [{ revision: 1 }, { revision: renamed.revision }],
      }]);
      library.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies incoming reading data with its cursor atomically and without echoing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-incoming-sync-"));
    const path = join(directory, "library.sqlite");
    const bookId = "10000000-0000-4000-8000-000000000000";
    const highlightId = "20000000-0000-4000-8000-000000000000";
    const noteId = "30000000-0000-4000-8000-000000000000";
    const deviceId = "40000000-0000-4000-8000-000000000000";
    try {
      new LocalLibrary(path).close();
      const setup = new DatabaseSync(path);
      setup.prepare("UPDATE sync_state SET remote_generation = 1, remote_sequence = 0, snapshot_required = 0").run();
      setup.close();
      const library = new LocalLibrary(path);
      const book = { entityType: "book", operation: "upsert", deviceId, deviceRevision: 1, collectionIds: [], tagIds: [], book: {
        id: bookId, title: "Piranesi", authors: ["Susanna Clarke"], status: "reading", archived: false,
        createdAt: 10, updatedAt: 10, revision: 1, highlightCount: 0,
      } } as unknown as SyncedChange;
      const highlight = { entityType: "highlight", operation: "upsert", deviceId, deviceRevision: 1, tagIds: [], threadIds: [], highlight: {
        id: highlightId, bookId, text: "Every room of the House", createdAt: 11, updatedAt: 11, revision: 1,
      } } as unknown as SyncedChange;
      const note = { entityType: "note", operation: "upsert", deviceId, deviceRevision: 1, note: {
        id: noteId, bookId, highlightId, markdown: "Remember this", origin: "reader",
        createdAt: 12, updatedAt: 12, revision: 1,
      } } as unknown as SyncedChange;
      expect(library.applyIncomingSyncedChange({ change: book, sequence: 1,
        expectedCursor: { generation: 1, afterSequence: 0 }, nextCursor: { generation: 1, afterSequence: 1 } })).toBe("applied");
      expect(library.applyIncomingSyncedChange({ change: highlight, sequence: 2,
        expectedCursor: { generation: 1, afterSequence: 1 }, nextCursor: { generation: 1, afterSequence: 2 } })).toBe("applied");
      expect(library.applyIncomingSyncedChange({ change: note, sequence: 3,
        expectedCursor: { generation: 1, afterSequence: 2 }, nextCursor: { generation: 1, afterSequence: 3 } })).toBe("applied");
      expect(library.getSyncState()).toMatchObject({ remoteCursor: { generation: 1, afterSequence: 3 }, snapshotRequired: false });
      expect(library.listPendingSyncChanges()).toEqual([]);
      expect(library.getBookContents(bookId as never)).toMatchObject({
        book: { title: "Piranesi" },
        highlights: [{
          id: highlightId,
          text: "Every room of the House",
          notes: [{ id: noteId, markdown: "Remember this" }],
        }],
      });

      const malformed = { ...(book as Extract<SyncedChange, { entityType: "book"; operation: "upsert" }>),
        deviceRevision: 2, book: { ...(book as Extract<SyncedChange, { entityType: "book"; operation: "upsert" }>).book,
          archived: "false" } } as unknown as SyncedChange;
      expect(() => library.applyIncomingSyncedChange({ change: malformed, sequence: 4,
        expectedCursor: { generation: 1, afterSequence: 3 }, nextCursor: { generation: 1, afterSequence: 4 } }))
        .toThrow(/invalid/);
      expect(library.getSyncState().remoteCursor).toEqual({ generation: 1, afterSequence: 3 });
      expect(library.getBook(bookId as never)?.archived).toBe(false);
      const malformedDiscriminant = { ...note, entityType: ["note"] } as unknown as SyncedChange;
      expect(() => library.applyIncomingSyncedChange({ change: malformedDiscriminant, sequence: 4,
        expectedCursor: { generation: 1, afterSequence: 3 }, nextCursor: { generation: 1, afterSequence: 4 } }))
        .toThrow(/invalid/);
      expect(library.getSyncState().remoteCursor).toEqual({ generation: 1, afterSequence: 3 });
      expect(() => library.applyIncomingSyncedChange({ change: book, sequence: 5,
        expectedCursor: { generation: 1, afterSequence: 3 }, nextCursor: { generation: 1, afterSequence: 4 } }))
        .toThrow(/sequence does not match/);
      expect(library.getSyncState().remoteCursor).toEqual({ generation: 1, afterSequence: 3 });

      const broken = { ...note, note: { ...(note as Extract<SyncedChange, { entityType: "note"; operation: "upsert" }>).note,
        id: "50000000-0000-4000-8000-000000000000", bookId: "60000000-0000-4000-8000-000000000000" } } as SyncedChange;
      expect(() => library.applyIncomingSyncedChange({ change: broken, sequence: 4,
        expectedCursor: { generation: 1, afterSequence: 3 }, nextCursor: { generation: 1, afterSequence: 4 } }))
        .toThrow(/parent no longer exists/);
      expect(library.getSyncState().remoteCursor).toEqual({ generation: 1, afterSequence: 3 });
      expect(library.listPendingSyncChanges()).toEqual([]);
      library.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps pending local work while delete-wins replay advances the incoming cursor", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-incoming-delete-"));
    const path = join(directory, "library.sqlite");
    const remoteDeviceId = "70000000-0000-4000-8000-000000000000";
    try {
      let library = new LocalLibrary(path);
      const book = library.createBook({ title: "A local copy" });
      const pending = library.listPendingSyncChanges();
      library.close();
      const setup = new DatabaseSync(path);
      setup.prepare("UPDATE sync_state SET remote_generation = 2, remote_sequence = 0, snapshot_required = 0").run();
      setup.close();
      library = new LocalLibrary(path);

      const tombstone = { entityType: "book", operation: "tombstone", deviceId: remoteDeviceId,
        deviceRevision: 1, entityId: book.id } as SyncedChange;
      expect(library.applyIncomingSyncedChange({ change: tombstone, sequence: 1,
        expectedCursor: { generation: 2, afterSequence: 0 }, nextCursor: { generation: 2, afterSequence: 1 } })).toBe("applied");
      const staleUpsert = { entityType: "book", operation: "upsert", deviceId: remoteDeviceId,
        deviceRevision: 99, collectionIds: [], tagIds: [], book: { ...book, title: "Must not return", revision: 99 } } as SyncedChange;
      expect(library.applyIncomingSyncedChange({ change: staleUpsert, sequence: 2,
        expectedCursor: { generation: 2, afterSequence: 1 }, nextCursor: { generation: 2, afterSequence: 2 } })).toBe("superseded");
      expect(library.getBook(book.id)).toBeUndefined();
      expect(library.getSyncState().remoteCursor).toEqual({ generation: 2, afterSequence: 2 });
      expect(library.listPendingSyncChanges()).toEqual(pending);
      expect(() => library.applyIncomingSyncedChange({ change: staleUpsert, sequence: 2,
        expectedCursor: { generation: 2, afterSequence: 1 }, nextCursor: { generation: 2, afterSequence: 2 } }))
        .toThrow(/cursor no longer matches/);
      expect(library.getSyncState().remoteCursor).toEqual({ generation: 2, afterSequence: 2 });
      library.close();

      const inspection = new DatabaseSync(path, { readOnly: true });
      expect(inspection.prepare(
        "SELECT entity_type, entity_id FROM sync_tombstones WHERE entity_type = 'book' AND entity_id = ?",
      ).get(book.id)).toEqual({ entity_type: "book", entity_id: book.id });
      inspection.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves concurrent note bodies without inventing conflicts for causal replays", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-incoming-conflict-"));
    const path = join(directory, "library.sqlite");
    const bookId = "81000000-0000-4000-8000-000000000000";
    const noteId = "82000000-0000-4000-8000-000000000000";
    const firstDeviceId = "83000000-0000-4000-8000-000000000000";
    const secondDeviceId = "84000000-0000-4000-8000-000000000000";
    try {
      new LocalLibrary(path).close();
      const setup = new DatabaseSync(path);
      setup.prepare("UPDATE sync_state SET remote_generation = 3, remote_sequence = 0, snapshot_required = 0").run();
      setup.close();
      const library = new LocalLibrary(path);
      const localDeviceId = library.getSyncState().deviceId;
      const book = { entityType: "book", operation: "upsert", deviceId: firstDeviceId, deviceRevision: 1, collectionIds: [], tagIds: [], book: {
        id: bookId, title: "Piranesi", authors: [], status: "reading", archived: false,
        createdAt: 10, updatedAt: 10, revision: 1, highlightCount: 0,
      } } as unknown as SyncedChange;
      const original = { entityType: "note", operation: "upsert", deviceId: firstDeviceId, deviceRevision: 1, note: {
        id: noteId, bookId, markdown: "Remote ancestor", origin: "reader", createdAt: 11, updatedAt: 11, revision: 1,
      } } as unknown as SyncedChange;
      library.applyIncomingSyncedChange({ change: book, sequence: 1,
        expectedCursor: { generation: 3, afterSequence: 0 }, nextCursor: { generation: 3, afterSequence: 1 } });
      library.applyIncomingSyncedChange({ change: original, sequence: 2,
        expectedCursor: { generation: 3, afterSequence: 1 }, nextCursor: { generation: 3, afterSequence: 2 } });
      library.updateNote({ id: noteId as never, bookId: bookId as never, expectedRevision: 1, markdown: "Local draft" });
      const pending = library.listPendingSyncChanges();

      expect(library.applyIncomingSyncedChange({ change: original, sequence: 3,
        expectedCursor: { generation: 3, afterSequence: 2 }, nextCursor: { generation: 3, afterSequence: 3 } })).toBe("superseded");
      const concurrent = { ...original, deviceId: secondDeviceId, deviceRevision: 3,
        note: { ...(original as Extract<SyncedChange, { entityType: "note"; operation: "upsert" }>).note,
          markdown: "Other device draft", revision: 3 } } as SyncedChange;
      expect(library.applyIncomingSyncedChange({ change: concurrent, sequence: 4,
        expectedCursor: { generation: 3, afterSequence: 3 }, nextCursor: { generation: 3, afterSequence: 4 } })).toBe("applied");
      expect(library.getBookContents(bookId as never)?.standaloneNotes).toMatchObject([
        { id: noteId, markdown: "Other device draft" },
      ]);
      expect(library.listPendingSyncChanges()).toEqual(pending);
      library.close();

      const inspection = new DatabaseSync(path, { readOnly: true });
      expect(inspection.prepare(
        `SELECT losing_body, winning_body, losing_device_id, losing_device_revision
         FROM sync_conflicts WHERE entity_type = 'note' AND entity_id = ? ORDER BY created_at`,
      ).all(noteId)).toEqual([{
        losing_body: "Local draft",
        winning_body: "Other device draft",
        losing_device_id: localDeviceId,
        losing_device_revision: 2,
      }]);
      inspection.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps absent-row tombstones durable against later higher-revision upserts", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-absent-tombstones-"));
    const path = join(directory, "library.sqlite");
    const bookId = "91000000-0000-4000-8000-000000000000";
    const highlightId = "92000000-0000-4000-8000-000000000000";
    const noteId = "93000000-0000-4000-8000-000000000000";
    const deviceId = "94000000-0000-4000-8000-000000000000";
    try {
      new LocalLibrary(path).close();
      const setup = new DatabaseSync(path);
      setup.prepare("UPDATE sync_state SET remote_generation = 4, remote_sequence = 0, snapshot_required = 0").run();
      setup.close();
      const library = new LocalLibrary(path);
      const changes: SyncedChange[] = [
        { entityType: "book", operation: "tombstone", deviceId, deviceRevision: 1, entityId: bookId as never },
        { entityType: "highlight", operation: "tombstone", deviceId, deviceRevision: 1,
          entityId: highlightId as never, bookId: bookId as never },
        { entityType: "note", operation: "tombstone", deviceId, deviceRevision: 1,
          entityId: noteId as never, bookId: bookId as never },
      ];
      for (const [index, change] of changes.entries()) {
        expect(library.applyIncomingSyncedChange({ change, sequence: index + 1,
          expectedCursor: { generation: 4, afterSequence: index },
          nextCursor: { generation: 4, afterSequence: index + 1 } })).toBe("applied");
      }
      const upserts: SyncedChange[] = [
        { entityType: "book", operation: "upsert", deviceId, deviceRevision: 999, collectionIds: [], tagIds: [], book: {
          id: bookId as never, title: "Deleted", authors: [], status: "unread", archived: false,
          createdAt: 1, updatedAt: 1, revision: 999, highlightCount: 0,
        } },
        { entityType: "highlight", operation: "upsert", deviceId, deviceRevision: 999, tagIds: [], threadIds: [], highlight: {
          id: highlightId as never, bookId: bookId as never, text: "Deleted", createdAt: 1, updatedAt: 1, revision: 999,
        } },
        { entityType: "note", operation: "upsert", deviceId, deviceRevision: 999, note: {
          id: noteId as never, bookId: bookId as never, markdown: "Deleted", origin: "reader",
          createdAt: 1, updatedAt: 1, revision: 999,
        } },
      ];
      for (const [index, change] of upserts.entries()) {
        expect(library.applyIncomingSyncedChange({ change, sequence: index + 4,
          expectedCursor: { generation: 4, afterSequence: index + 3 },
          nextCursor: { generation: 4, afterSequence: index + 4 } })).toBe("superseded");
      }
      expect(library.getSyncState().remoteCursor).toEqual({ generation: 4, afterSequence: 6 });
      expect(library.listBooks({ includeArchived: true })).toEqual([]);
      expect(library.listPendingSyncChanges()).toEqual([]);
      library.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detaches imported annotation provenance before applying incoming reader edits", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-incoming-import-"));
    const path = join(directory, "library.sqlite");
    const source = sourceProfile("portable:incoming-reader-edit");
    const document = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Piranesi", authors: [] }],
      annotations: [{ providerRecordId: "passage", bookProviderRecordId: "book", text: "Source passage", note: "Source note" }],
    };
    const deviceId = "a1000000-0000-4000-8000-000000000000";
    try {
      let library = new LocalLibrary(path);
      library.importDocument({ document, fileName: "source.json", provider: "portable", source, warnings: [] });
      const book = library.listBooks()[0]!;
      const imported = library.getBookContents(book.id)!.highlights[0]!;
      const note = imported.notes[0]!;
      library.close();
      const setup = new DatabaseSync(path);
      setup.prepare("UPDATE sync_state SET remote_generation = 5, remote_sequence = 0, snapshot_required = 0").run();
      setup.close();
      library = new LocalLibrary(path);

      const highlightChange = { entityType: "highlight", operation: "upsert", deviceId, deviceRevision: 20,
        tagIds: [], threadIds: [], highlight: { ...imported, text: "Synced reader passage", revision: 20 } } as SyncedChange;
      const noteChange = { entityType: "note", operation: "upsert", deviceId, deviceRevision: 20,
        note: { ...note, markdown: "Synced reader note", origin: "reader", revision: 20 } } as SyncedChange;
      library.applyIncomingSyncedChange({ change: highlightChange, sequence: 1,
        expectedCursor: { generation: 5, afterSequence: 0 }, nextCursor: { generation: 5, afterSequence: 1 } });
      library.applyIncomingSyncedChange({ change: noteChange, sequence: 2,
        expectedCursor: { generation: 5, afterSequence: 1 }, nextCursor: { generation: 5, afterSequence: 2 } });
      library.importDocument({
        document: { ...document, annotations: [{ ...document.annotations[0]!, text: "New source passage", note: "New source note" }] },
        fileName: "source.json", provider: "portable", source, warnings: [],
      });
      expect(library.getBookContents(book.id)).toMatchObject({
        highlights: [{ text: "Synced reader passage", notes: [{ markdown: "Synced reader note" }] }],
      });
      expect(library.listImportConflicts()).toHaveLength(1);
      library.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes incoming-deleted passages from local containers without outbox echo", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-incoming-membership-"));
    const path = join(directory, "library.sqlite");
    try {
      let library = new LocalLibrary(path);
      const book = library.createBook({ title: "Piranesi" });
      const highlight = library.createHighlight({ bookId: book.id, text: "The House" });
      const thread = library.createThread({ name: "Architecture" });
      const tag = library.createTag({ name: "Revisit" });
      const assigned = library.setHighlightThreadMembership({
        bookId: book.id, highlightId: highlight.id, threadIds: [thread.id], expectedHighlightRevision: highlight.revision,
      });
      library.setHighlightTagMembership({
        bookId: book.id, highlightId: highlight.id, tagId: tag.id, included: true,
      });
      const beforeThread = library.listThreads()[0]!;
      const beforeTag = library.listTags()[0]!;
      const pending = library.listPendingSyncChanges();
      library.close();
      const setup = new DatabaseSync(path);
      setup.prepare("UPDATE sync_state SET remote_generation = 6, remote_sequence = 0, snapshot_required = 0").run();
      setup.close();
      library = new LocalLibrary(path);

      const change = { entityType: "highlight", operation: "tombstone",
        deviceId: "b1000000-0000-4000-8000-000000000000", deviceRevision: 50,
        entityId: highlight.id, bookId: book.id } as SyncedChange;
      expect(library.applyIncomingSyncedChange({ change, sequence: 1,
        expectedCursor: { generation: 6, afterSequence: 0 }, nextCursor: { generation: 6, afterSequence: 1 } })).toBe("applied");
      expect(library.getBookContents(book.id)?.highlights).toEqual([]);
      expect(library.listThreadHighlightMemberships()).toEqual([]);
      // Counts follow the removed memberships; the containers' own revisions stay claimed.
      expect(library.listThreads()[0]).toMatchObject({ passageCount: 0, revision: beforeThread.revision });
      expect(library.listTags()[0]).toMatchObject({ highlightCount: 0, revision: beforeTag.revision });
      expect(library.listPendingSyncChanges()).toEqual(pending);
      expect(assigned.highlightRevision).toBeGreaterThan(highlight.revision);
      library.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("appends organization entities and membership-bearing book revisions to the sync outbox", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-organization-sync-"));
    try {
      const library = new LocalLibrary(join(directory, "library.sqlite"));
      const book = library.createBook({ title: "Piranesi" });
      const collection = library.createCollection({ name: "Keepers" });
      const tag = library.createTag({ name: "Revisit" });
      library.setBookCollectionMembership({ bookId: book.id, collectionId: collection.id, included: true });
      library.setBookTagMembership({ bookId: book.id, tagId: tag.id, included: true });

      expect(library.listPendingSyncChanges()).toMatchObject([
        { entityType: "book", entityId: book.id, revision: 1, operation: "upsert" },
        { entityType: "collection", entityId: collection.id, revision: 1, operation: "upsert" },
        { entityType: "tag", entityId: tag.id, revision: 1, operation: "upsert" },
        { entityType: "collection", entityId: collection.id, revision: 2, operation: "upsert" },
        { entityType: "book", entityId: book.id, revision: 2, operation: "upsert" },
        { entityType: "tag", entityId: tag.id, revision: 2, operation: "upsert" },
        { entityType: "book", entityId: book.id, revision: 3, operation: "upsert" },
      ]);

      library.deleteCollection({ id: collection.id, expectedRevision: 2 });
      library.deleteTag({ id: tag.id, expectedRevision: 2 });
      expect(library.listPendingSyncChanges().filter(({ operation }) => operation === "tombstone"))
        .toMatchObject([
          { entityType: "collection", entityId: collection.id, revision: 3 },
          { entityType: "tag", entityId: tag.id, revision: 3 },
        ]);
      library.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts the current schema backup and rebinds it to the destination installation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-sync-restore-"));
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    try {
      const source = new LocalLibrary(sourcePath);
      const sourceDeviceId = source.getSyncState().deviceId;
      source.createBook({ title: "Piranesi" });
      await source.backupTo(backupPath);
      source.close();

      validateLibraryBackup(backupPath);
      const restored = new LocalLibrary(backupPath);
      expect(restored.getSyncState()).toMatchObject({
        deviceId: expect.not.stringMatching(new RegExp(`^${sourceDeviceId}$`)),
        snapshotRequired: true,
      });
      expect(restored.listPendingSyncChanges()).toEqual([]);
      expect(restored.listBooks()).toMatchObject([{ title: "Piranesi" }]);
      restored.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a backup carrying schema objects Leaflogue did not create", async () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-hostile-backup-"));
    const sourcePath = join(directory, "source.sqlite");
    try {
      const source = new LocalLibrary(sourcePath);
      source.createBook({ title: "Piranesi" });
      const tampered = async (name: string, sql: string) => {
        const path = join(directory, `${name}.sqlite`);
        await source.backupTo(path);
        const database = new DatabaseSync(path);
        database.exec(sql);
        database.close();
        return path;
      };
      const clean = join(directory, "clean.sqlite");
      await source.backupTo(clean);
      expect(() => validateLibraryBackup(clean)).not.toThrow();
      const extraTrigger = await tampered("trigger", "CREATE TRIGGER wipe AFTER INSERT ON highlights BEGIN DELETE FROM books; END");
      expect(() => validateLibraryBackup(extraTrigger)).toThrow(/did not create/);
      const view = await tampered("view", "CREATE VIEW everything AS SELECT * FROM books");
      expect(() => validateLibraryBackup(view)).toThrow(/did not create/);
      const reader = new DatabaseSync(clean, { readOnly: true });
      const trigger = (reader.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' LIMIT 1").get() as { name: string } | undefined)?.name;
      reader.close();
      expect(trigger).toBeDefined();
      const missingTrigger = await tampered("missing", `DROP TRIGGER "${trigger}"`);
      expect(() => validateLibraryBackup(missingTrigger)).toThrow(/did not create/);
      source.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resets sync progress when a backup replaces its originating library", async () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-sync-same-restore-"));
    const libraryPath = join(directory, "library.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    const stagedPath = `${libraryPath}.restore`;
    const recoveryPath = `${libraryPath}.previous`;
    const journalPath = `${libraryPath}.restore-state.json`;
    try {
      const source = new LocalLibrary(libraryPath);
      const deviceId = source.getSyncState().deviceId;
      source.createBook({ title: "Piranesi" });
      source.close();
      const seeded = new DatabaseSync(libraryPath);
      seeded.exec(`
        INSERT INTO sync_incoming_writers
          (entity_type, entity_id, device_id, device_revision, operation, entity_revision, applied_at)
        VALUES ('note', 'old-note', 'old-device', 1, 'tombstone', 1, 1);
        INSERT INTO sync_tombstones (entity_type, entity_id, book_id, revision, deleted_at)
        VALUES ('note', 'old-note', 'old-book', 1, 1);
        INSERT INTO sync_conflicts
          (id, entity_type, entity_id, book_id, losing_body, losing_operation,
           winning_operation, fingerprint, created_at)
        VALUES ('old-conflict', 'note', 'old-note', 'old-book', 'reader text',
          'upsert', 'tombstone', 'old-fingerprint', 1);
      `);
      seeded.close();
      const backedUp = new LocalLibrary(libraryPath);
      await backedUp.backupTo(backupPath);
      backedUp.close();
      copyFileSync(backupPath, stagedPath);

      const restored = replaceFileWithRollback({
        targetPath: libraryPath,
        stagedPath,
        recoveryPath,
        journalPath,
        activate: () => {
          const library = new LocalLibrary(libraryPath);
          library.resetSyncStateAfterRestore();
          return library;
        },
      });
      expect(restored.getSyncState()).toEqual({ deviceId, snapshotRequired: true });
      expect(restored.listPendingSyncChanges()).toEqual([]);
      expect(restored.listBooks()).toMatchObject([{ title: "Piranesi" }]);
      restored.close();
      const inspection = new DatabaseSync(libraryPath, { readOnly: true });
      expect(inspection.prepare("SELECT count(*) AS count FROM sync_incoming_writers").get()).toEqual({ count: 0 });
      expect(inspection.prepare("SELECT count(*) AS count FROM sync_tombstones").get()).toEqual({ count: 0 });
      expect(inspection.prepare("SELECT losing_body, status FROM sync_conflicts").get())
        .toEqual({ losing_body: "reader text", status: "pending" });
      inspection.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records a tombstone when a legacy soft-deleted annotation is changed", () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    database.exec(`
      INSERT INTO sync_devices (id, created_at, updated_at) VALUES ('device', 1, 1);
      INSERT INTO sync_state (singleton, device_id, updated_at) VALUES (1, 'device', 1);
      INSERT INTO books (id, title, created_at, updated_at) VALUES ('book', 'Book', 1, 1);
      INSERT INTO highlights (id, book_id, text, created_at, updated_at) VALUES ('highlight', 'book', 'Passage', 1, 1);
      UPDATE highlights SET deleted = 1, updated_at = 2, revision = revision + 1 WHERE id = 'highlight';
    `);
    expect(database.prepare(
      "SELECT entity_type, entity_id, revision, operation FROM sync_outbox ORDER BY sequence",
    ).all()).toEqual([
      { entity_type: "book", entity_id: "book", revision: 1, operation: "upsert" },
      { entity_type: "highlight", entity_id: "highlight", revision: 1, operation: "upsert" },
      { entity_type: "highlight", entity_id: "highlight", revision: 2, operation: "tombstone" },
    ]);
    database.close();
  });
});

describe("thematic threads", () => {
  it("manages threads and passage membership atomically without owning passages", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const library = new LocalLibrary(":memory:");
    try {
      const book = library.createBook({ title: "Piranesi", authors: ["Susanna Clarke"] });
      const highlight = library.createHighlight({ bookId: book.id, text: "Every room of the House" });
      library.createNote({ bookId: book.id, highlightId: highlight.id, markdown: "A note" });
      const thread = library.createThread({ name: "  Belonging   and exile  ", description: "  Across homes  " });
      expect(thread).toMatchObject({ name: "Belonging and exile", description: "Across homes", passageCount: 0, revision: 1 });
      expect(() => library.createThread({ name: "belonging and exile" })).toThrow();

      const assigned = library.setHighlightThreadMembership({
        bookId: book.id,
        highlightId: highlight.id,
        threadIds: [thread.id, thread.id],
        expectedHighlightRevision: highlight.revision,
      });
      expect(assigned).toEqual({
        changed: true,
        bookId: book.id,
        highlightId: highlight.id,
        highlightRevision: 2,
        threadIds: [thread.id],
      });
      expect(library.listThreads()).toMatchObject([{ id: thread.id, passageCount: 1, revision: 2 }]);
      expect(library.listThreadHighlightMemberships()).toEqual([{
        threadId: thread.id,
        highlightId: highlight.id,
        addedAt: 1_800_000_000_000,
      }]);
      expect(library.getThread(thread.id)).toMatchObject({
        thread: { id: thread.id, passageCount: 1 },
        passages: [{
          highlightId: highlight.id,
          bookId: book.id,
          bookTitle: "Piranesi",
          authors: ["Susanna Clarke"],
          text: "Every room of the House",
          notes: [{ markdown: "A note" }],
        }],
      });

      expect(library.setHighlightThreadMembership({
        bookId: book.id,
        highlightId: highlight.id,
        threadIds: [thread.id],
        expectedHighlightRevision: 2,
      })).toMatchObject({ changed: false, highlightRevision: 2 });
      expect(() => library.setHighlightThreadMembership({
        bookId: book.id,
        highlightId: highlight.id,
        threadIds: [],
        expectedHighlightRevision: 1,
      })).toThrow(/changed elsewhere/u);
      expect(library.getHighlightThreadIds(book.id, highlight.id)).toEqual([thread.id]);

      const renamed = library.updateThread({ id: thread.id, name: "Home", expectedRevision: 2 });
      expect(renamed).toMatchObject({ name: "Home", passageCount: 1, revision: 3 });
      expect(() => library.deleteThread({ id: thread.id, expectedRevision: 2 })).toThrow(/changed elsewhere/u);
      library.deleteThread({ id: thread.id, expectedRevision: 3 });
      expect(library.listThreads()).toEqual([]);
      expect(library.listThreadHighlightMemberships()).toEqual([]);
      expect(library.getThread(thread.id)).toBeUndefined();
      expect(library.getBookContents(book.id)?.highlights).toHaveLength(1);
    } finally {
      library.close();
      clock.mockRestore();
    }
  });

  it("rolls back all membership changes when any requested thread is invalid", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const book = library.createBook({ title: "Piranesi" });
      const highlight = library.createHighlight({ bookId: book.id, text: "The House" });
      const thread = library.createThread({ name: "Architecture" });
      const missing = "10000000-0000-4000-8000-000000000000" as typeof thread.id;
      expect(() => library.setHighlightThreadMembership({
        bookId: book.id,
        highlightId: highlight.id,
        threadIds: [thread.id, missing],
        expectedHighlightRevision: highlight.revision,
      })).toThrow(/Thread no longer exists/u);
      expect(library.getHighlightThreadIds(book.id, highlight.id)).toEqual([]);
      expect(library.getBookContents(book.id)?.highlights[0]?.revision).toBe(highlight.revision);
      expect(library.listThreads()).toMatchObject([{ id: thread.id, passageCount: 0, revision: 1 }]);
    } finally {
      library.close();
    }
  });

  it("omits memberships whose canonical highlight is not exportable", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-thread-export-"));
    const path = join(directory, "library.sqlite");
    try {
      const library = new LocalLibrary(path);
      const book = library.createBook({ title: "Piranesi" });
      const highlight = library.createHighlight({ bookId: book.id, text: "The House" });
      const thread = library.createThread({ name: "Architecture" });
      library.setHighlightThreadMembership({
        bookId: book.id,
        highlightId: highlight.id,
        threadIds: [thread.id],
        expectedHighlightRevision: highlight.revision,
      });
      library.close();

      const database = new DatabaseSync(path);
      database.prepare("UPDATE highlights SET archived = 1 WHERE id = ?").run(highlight.id);
      database.close();

      const reopened = new LocalLibrary(path);
      try {
        expect(reopened.listThreadHighlightMemberships()).toEqual([]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces the thread cap across two connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-thread-cap-"));
    const path = join(directory, "library.sqlite");
    try {
      const first = new LocalLibrary(path);
      for (let index = 0; index < 99; index += 1) first.createThread({ name: `Thread ${index}` });
      const second = new LocalLibrary(path);
      try {
        first.createThread({ name: "Thread 99" });
        expect(() => second.createThread({ name: "Thread 100" })).toThrow(/At most 100 threads/u);
        expect(second.listThreads()).toHaveLength(100);
      } finally {
        second.close();
        first.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("daily highlight selection", () => {
  it("reuses a local-day selection and rotates across books before passages", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-22T08:00:00.000Z"));
    const library = new LocalLibrary(":memory:");
    try {
      const large = library.createBook({ title: "Many passages" });
      const small = library.createBook({ title: "One passage" });
      for (let index = 0; index < 8; index += 1) {
        library.createHighlight({ bookId: large.id, text: `Large passage ${index}` });
      }
      library.createHighlight({ bookId: small.id, text: "Small passage" });

      const first = library.ensureDailyHighlight({ timezone: "UTC" });
      expect(first).toMatchObject({
        selection: { localDay: "2026-09-22", timezone: "UTC", revision: 1 },
        hasAlternatives: true,
      });
      expect(library.ensureDailyHighlight({ timezone: "utc" })).toEqual(first);
      expect(library.ensureDailyHighlight({ timezone: "Etc/UTC" })).toEqual(first);
      expect(library.listDailySelections()).toHaveLength(1);
      expect(library.ensureDailyHighlight({ timezone: "UTC" })).toEqual(first);
      const another = library.ensureDailyHighlight({ timezone: "UTC", another: true });
      expect(another).toMatchObject({ selection: { revision: 2 } });
      expect(another?.passage.highlightId).not.toBe(first?.passage.highlightId);
      expect(another?.passage.bookId).not.toBe(first?.passage.bookId);
      expect(library.getDailyHighlight("UTC")).toEqual(another);
      expect(library.listDailySelections()).toHaveLength(1);

      clock.mockReturnValue(Date.parse("2026-09-23T08:00:00.000Z"));
      const nextDay = library.ensureDailyHighlight({ timezone: "UTC" });
      expect(nextDay).toMatchObject({ selection: { localDay: "2026-09-23", revision: 1 } });
      expect(nextDay?.selection.recentHighlightIds.length).toBeLessThanOrEqual(7);
      expect(library.listDailySelections()).toHaveLength(2);
      expect(() => library.ensureDailyHighlight({ timezone: "Not/A_Zone" })).toThrow(/Timezone is invalid/u);
    } finally {
      library.close();
      clock.mockRestore();
    }
  });

  it("records an empty day and selects a passage when the candidate set later appears", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-22T08:00:00.000Z"));
    const library = new LocalLibrary(":memory:");
    try {
      expect(library.ensureDailyHighlight({ timezone: "Asia/Kolkata" })).toBeUndefined();
      expect(library.ensureDailyHighlight({ timezone: "Asia/Kolkata", another: true })).toBeUndefined();
      expect(library.listDailySelections()).toMatchObject([{
        localDay: "2026-09-22",
        timezone: expect.any(String),
        revision: 1,
        recentHighlightIds: [],
      }]);
      const book = library.createBook({ title: "Piranesi" });
      const highlight = library.createHighlight({ bookId: book.id, text: "The House" });
      const selected = library.ensureDailyHighlight({ timezone: "Asia/Kolkata" });
      expect(selected).toMatchObject({
        selection: { highlightId: highlight.id, revision: 2 },
        passage: { highlightId: highlight.id, bookTitle: "Piranesi" },
        hasAlternatives: false,
      });
      expect(library.ensureDailyHighlight({ timezone: "Asia/Kolkata", another: true })).toEqual(selected);
    } finally {
      library.close();
      clock.mockRestore();
    }
  });

  it("returns the day captured before a local-midnight boundary", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const book = library.createBook({ title: "Piranesi" });
      library.createHighlight({ bookId: book.id, text: "The House" });
      const clock = vi.spyOn(Date, "now")
        .mockReturnValueOnce(Date.parse("2026-09-22T23:59:59.999Z"))
        .mockReturnValue(Date.parse("2026-09-23T00:00:00.001Z"));
      try {
        expect(library.ensureDailyHighlight({ timezone: "UTC" })).toMatchObject({
          selection: { localDay: "2026-09-22" },
        });
      } finally {
        clock.mockRestore();
      }
    } finally {
      library.close();
    }
  });
});

describe("reading status history", () => {
  it("atomically changes status and appends one immutable event", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-reading-status-"));
    try {
      const library = new LocalLibrary(join(directory, "library.sqlite"));
      const book = library.createBook({ title: "Piranesi" });
      const pendingBeforeStatusChange = library.listPendingSyncChanges();
      const changed = library.setBookReadingStatus({ id: book.id, status: "reading", expectedRevision: book.revision });
      expect(changed).toMatchObject({
        changed: true,
        book: { id: book.id, status: "reading", revision: 2 },
        event: { bookId: book.id, status: "reading", source: "reader", bookRevision: 2 },
      });
      expect(library.listReadingStatusHistory(book.id)).toEqual([changed.event]);
      expect(library.listPendingSyncChanges().slice(pendingBeforeStatusChange.length)).toMatchObject([
        { entityType: "book", entityId: book.id, revision: 2, operation: "upsert" },
      ]);

      expect(library.setBookReadingStatus({ id: book.id, status: "reading", expectedRevision: 2 }))
        .toEqual({ changed: false, book: changed.book });
      expect(library.listReadingStatusHistory(book.id)).toHaveLength(1);
      expect(() => library.setBookReadingStatus({ id: book.id, status: "finished", expectedRevision: 1 }))
        .toThrow(/changed elsewhere/);

      const finished = library.setBookReadingStatus({ id: book.id, status: "finished", expectedRevision: 2 });
      expect(finished.book).toMatchObject({ status: "finished", revision: 3, completedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) });
      expect(finished.event).toMatchObject({ source: "reader", completedOn: finished.book.completedOn });
      expect(library.listReadingStatusHistory(book.id).map(({ status, bookRevision }) => ({ status, bookRevision })))
        .toEqual([{ status: "finished", bookRevision: 3 }, { status: "reading", bookRevision: 2 }]);
      expect(library.listReadingStatusHistory(book.id, { limit: 1 }).map(({ status }) => status))
        .toEqual(["finished"]);
      expect(() => library.listReadingStatusHistory(book.id, { limit: 0 })).toThrow(/limit is invalid/u);

      const pendingBeforeDate = library.listPendingSyncChanges().length;
      const dated = library.setBookCompletionDate({ id: book.id, completedOn: "2024-02-29", expectedRevision: 3 });
      expect(dated).toMatchObject({ status: "finished", completedOn: "2024-02-29", revision: 4 });
      expect(library.listReadingStatusHistory(book.id)).toHaveLength(2);
      expect(library.listPendingSyncChanges().slice(pendingBeforeDate)).toMatchObject([
        { entityType: "book", entityId: book.id, revision: 4, operation: "upsert" },
      ]);
      const pendingAfterDate = library.listPendingSyncChanges().length;
      expect(library.setBookCompletionDate({ id: book.id, completedOn: "2024-02-29", expectedRevision: 4 })).toEqual(dated);
      expect(library.listPendingSyncChanges()).toHaveLength(pendingAfterDate);
      expect(() => library.setBookCompletionDate({ id: book.id, completedOn: "2023-02-29", expectedRevision: 4 }))
        .toThrow(/valid calendar date/);

      library.setBookReadingStatus({ id: book.id, status: "reading", expectedRevision: 4 });
      expect(() => library.setBookCompletionDate({ id: book.id, completedOn: "2024-02-29", expectedRevision: 5 }))
        .toThrow(/Set the book to Finished/);
      library.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("orders transitions deterministically when their timestamps match", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const library = new LocalLibrary(":memory:");
    try {
      const book = library.createBook({ title: "Piranesi" });
      library.setBookReadingStatus({ id: book.id, status: "reading", expectedRevision: 1 });
      library.setBookReadingStatus({ id: book.id, status: "paused", expectedRevision: 2 });
      expect(library.listReadingStatusHistory(book.id).map(({ status }) => status))
        .toEqual(["paused", "reading"]);
    } finally {
      library.close();
      clock.mockRestore();
    }
  });

  it("rolls back the book, history, and outbox when the event append fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-reading-status-rollback-"));
    const path = join(directory, "library.sqlite");
    try {
      const setup = new LocalLibrary(path);
      const book = setup.createBook({ title: "Piranesi" });
      setup.close();

      const database = new DatabaseSync(path);
      database.exec(`
        CREATE TRIGGER reject_reading_status_event
        BEFORE INSERT ON reading_status_events
        BEGIN
          SELECT RAISE(ABORT, 'forced status event failure');
        END;
      `);
      database.close();

      const library = new LocalLibrary(path);
      try {
        const pendingBefore = library.listPendingSyncChanges();
        expect(() => library.setBookReadingStatus({ id: book.id, status: "reading", expectedRevision: 1 }))
          .toThrow(/forced status event failure/u);
        expect(library.getBook(book.id)).toMatchObject({ status: "unread", revision: 1 });
        expect(library.listReadingStatusHistory(book.id)).toEqual([]);
        expect(library.listPendingSyncChanges()).toEqual(pendingBefore);
      } finally {
        library.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("rollback-safe file replacement", () => {
  it("restores the original when the replacement cannot be activated", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-file-replace-"));
    const targetPath = join(directory, "library.sqlite");
    const stagedPath = join(directory, "staged.sqlite");
    const recoveryPath = join(directory, "recovery.sqlite");
    const journalPath = join(directory, "restore-state.json");
    try {
      writeFileSync(targetPath, "known-good");
      writeFileSync(stagedPath, "invalid-replacement");
      expect(() => replaceFileWithRollback({
        targetPath,
        stagedPath,
        recoveryPath,
        journalPath,
        activate: () => { throw new Error("activation failed"); },
      })).toThrow(/activation failed/);
      expect(readFileSync(targetPath, "utf8")).toBe("known-good");
      expect(existsSync(stagedPath)).toBe(false);
      expect(existsSync(recoveryPath)).toBe(false);
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the original when the staged file disappears before installation", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-file-replace-"));
    const targetPath = join(directory, "library.sqlite");
    const stagedPath = join(directory, "missing.sqlite");
    const recoveryPath = join(directory, "recovery.sqlite");
    const journalPath = join(directory, "restore-state.json");
    try {
      writeFileSync(targetPath, "known-good");
      expect(() => replaceFileWithRollback({
        targetPath,
        stagedPath,
        recoveryPath,
        journalPath,
        activate: () => undefined,
      })).toThrow();
      expect(readFileSync(targetPath, "utf8")).toBe("known-good");
      expect(existsSync(recoveryPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes the recovery copy only after successful activation", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-file-replace-"));
    const targetPath = join(directory, "library.sqlite");
    const stagedPath = join(directory, "staged.sqlite");
    const recoveryPath = join(directory, "recovery.sqlite");
    const journalPath = join(directory, "restore-state.json");
    try {
      writeFileSync(targetPath, "old");
      writeFileSync(stagedPath, "new");
      const activated = replaceFileWithRollback({
        targetPath,
        stagedPath,
        recoveryPath,
        journalPath,
        activate: () => readFileSync(targetPath, "utf8"),
      });
      expect(activated).toBe("new");
      expect(readFileSync(targetPath, "utf8")).toBe("new");
      expect(existsSync(recoveryPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers the previous file after a crash during replacement", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-file-recover-"));
    const targetPath = join(directory, "library.sqlite");
    const stagedPath = join(directory, "library.sqlite.restore");
    const recoveryPath = join(directory, "library.sqlite.previous");
    const journalPath = join(directory, "library.sqlite.restore-state.json");
    try {
      writeFileSync(targetPath, "unverified-new-file");
      writeFileSync(recoveryPath, "known-good");
      writeFileSync(journalPath, JSON.stringify({ version: 1, hadOriginal: true }), { mode: 0o600 });
      recoverInterruptedFileReplacement({ targetPath, stagedPath, recoveryPath, journalPath });
      expect(readFileSync(targetPath, "utf8")).toBe("known-good");
      expect(existsSync(recoveryPath)).toBe(false);
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("highlight queries", () => {
  it("lists bounded passages across books with filters, tags, and provenance", () => {
    const clock = vi.spyOn(Date, "now");
    const library = new LocalLibrary(":memory:");
    try {
      clock.mockReturnValue(1_000);
      library.importDocument({
        document: {
          formatVersion: 1,
          books: [{ providerRecordId: "book", title: "Piranesi", authors: ["Susanna Clarke"] }],
          annotations: [{ providerRecordId: "one", bookProviderRecordId: "book", text: "The House is 100% kind" }],
        },
        fileName: "source.json",
        provider: "portable",
        source: sourceProfile("portable:query"),
        warnings: [],
      });
      const piranesi = library.listBooks()[0]!;
      clock.mockReturnValue(2_000);
      const manual = library.createHighlight({ bookId: piranesi.id, text: "Statues in the vestibules" });
      library.createNote({ bookId: piranesi.id, highlightId: manual.id, markdown: "Remember the minotaur" });
      clock.mockReturnValue(3_000);
      const other = library.createBook({ title: "Middlemarch", authors: ["George Eliot"] });
      const otherHighlight = library.createHighlight({ bookId: other.id, text: "A growing good of the world" });
      const tag = library.createTag({ name: "Kindness" });
      library.setHighlightTagMembership({ bookId: other.id, highlightId: otherHighlight.id, tagId: tag.id, included: true });

      const all = library.listHighlights({});
      expect(all.hasMore).toBe(false);
      expect(all.entries.map(({ text }) => text)).toEqual([
        "The House is 100% kind",
        "Statues in the vestibules",
        "A growing good of the world",
      ]);
      expect(all.entries[0]).toMatchObject({ bookTitle: "Piranesi", authors: ["Susanna Clarke"], imported: true, tagIds: [] });
      expect(all.entries[2]).toMatchObject({ bookTitle: "Middlemarch", imported: false, tagIds: [tag.id] });

      expect(library.listHighlights({ sort: "newest", limit: 1 })).toMatchObject({
        entries: [{ id: otherHighlight.id }],
        hasMore: true,
      });
      expect(library.listHighlights({ sort: "newest", limit: 1, offset: 2 }).entries.map(({ text }) => text))
        .toEqual(["The House is 100% kind"]);
      expect(library.listHighlights({ bookId: other.id }).entries.map(({ id }) => id)).toEqual([otherHighlight.id]);
      expect(library.listHighlights({ search: "minotaur" }).entries.map(({ id }) => id)).toEqual([manual.id]);
      expect(library.listHighlights({ search: "100%" }).entries).toHaveLength(1);
      expect(library.listHighlights({ search: "_" }).entries).toHaveLength(0);
      expect(library.listHighlights({ source: "imported" }).entries).toHaveLength(1);
      expect(library.listHighlights({ source: "manual" }).entries).toHaveLength(2);
      expect(library.listHighlights({ notes: "with" }).entries.map(({ notes }) => notes.map(({ markdown }) => markdown)))
        .toEqual([["Remember the minotaur"]]);
      expect(library.listHighlights({ notes: "without" }).entries).toHaveLength(2);
      expect(library.listHighlights({ tagId: tag.id }).entries.map(({ id }) => id)).toEqual([otherHighlight.id]);
      expect(library.listHighlights({ dateFrom: 2_000, dateBefore: 3_000 }).entries.map(({ id }) => id)).toEqual([manual.id]);
      expect(library.listHighlights({ dateKind: "imported", dateFrom: 0, dateBefore: 1_500 }).entries).toHaveLength(1);

      library.setBookArchived({ id: other.id, archived: true, expectedRevision: library.getBook(other.id)!.revision });
      expect(library.listHighlights({}).entries).toHaveLength(2);
      expect(() => library.listHighlights({ limit: 101 })).toThrow("Highlight page is invalid");
      expect(() => library.listHighlights({ search: "x".repeat(201) })).toThrow("Highlight search is invalid");
    } finally {
      library.close();
      clock.mockRestore();
    }
  });

  it("orders search matches by bounded relevance with stable pagination", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const library = new LocalLibrary(":memory:");
    try {
      const book = library.createBook({ title: "Search" });
      const exact = library.createHighlight({ bookId: book.id, text: "needle" });
      const prefix = library.createHighlight({ bookId: book.id, text: "Needle starts here" });
      const contains = library.createHighlight({ bookId: book.id, text: "A hidden needle here" });
      const noteExact = library.createHighlight({ bookId: book.id, text: "First note match" });
      library.createNote({ bookId: book.id, highlightId: noteExact.id, markdown: "NEEDLE" });
      const notePrefix = library.createHighlight({ bookId: book.id, text: "Second note match" });
      library.createNote({ bookId: book.id, highlightId: notePrefix.id, markdown: "Needle starts here too" });
      const noteContains = library.createHighlight({ bookId: book.id, text: "Third note match" });
      library.createNote({ bookId: book.id, highlightId: noteContains.id, markdown: "A hidden needle here too" });

      const query = { search: "needle", sort: "relevance" as const };
      const ordered = library.listHighlights(query).entries.map(({ id }) => id);
      expect(ordered).toEqual([exact.id, prefix.id, contains.id, noteExact.id, notePrefix.id, noteContains.id]);
      const first = library.listHighlights({ ...query, limit: 2 });
      const second = library.listHighlights({ ...query, limit: 2, offset: 2 });
      const third = library.listHighlights({ ...query, limit: 2, offset: 4 });
      expect([...first.entries, ...second.entries, ...third.entries].map(({ id }) => id)).toEqual(ordered);
      expect(first.hasMore).toBe(true);
      expect(third.hasMore).toBe(false);
      expect(() => library.listHighlights({ sort: "relevance" })).toThrow(/requires a search/);
    } finally {
      clock.mockRestore();
      library.close();
    }
  });
});

describe("annotation deletion", () => {
  it("tombstones a passage with its notes, removes memberships, and advances every container", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const book = library.createBook({ title: "Piranesi" });
      const kept = library.createHighlight({ bookId: book.id, text: "Kept" });
      const doomed = library.createHighlight({ bookId: book.id, text: "Doomed" });
      library.createNote({ bookId: book.id, highlightId: doomed.id, markdown: "Attached" });
      const standalone = library.createNote({ bookId: book.id, markdown: "Standalone" });
      const tag = library.createTag({ name: "Architecture" });
      library.setHighlightTagMembership({ bookId: book.id, highlightId: doomed.id, tagId: tag.id, included: true });
      const thread = library.createThread({ name: "Tides" });
      const membership = library.setHighlightThreadMembership({ bookId: book.id, highlightId: doomed.id, threadIds: [thread.id], expectedHighlightRevision: 2 });
      const beforeTag = library.listTags()[0]!;
      const beforeThread = library.listThreads()[0]!;
      const beforeBook = library.getBook(book.id)!;
      const pendingBefore = library.listPendingSyncChanges(1_000).length;

      expect(() => library.deleteHighlight({ id: doomed.id, bookId: book.id, expectedRevision: 1 })).toThrow(/changed elsewhere/);
      const receipt = library.deleteHighlight({ id: doomed.id, bookId: book.id, expectedRevision: membership.highlightRevision });
      expect(receipt).toEqual({ bookId: book.id, bookRevision: beforeBook.revision + 1, revision: membership.highlightRevision + 1, notesDeleted: 1, complete: true });

      const contents = library.getBookContents(book.id)!;
      expect(contents.highlights.map(({ id }) => id)).toEqual([kept.id]);
      expect(contents.standaloneNotes.map(({ id }) => id)).toEqual([standalone.id]);
      expect(contents.book.highlightCount).toBe(1);
      expect(library.listHighlights({}).entries.map(({ id }) => id)).toEqual([kept.id]);
      expect(library.listTags()[0]).toMatchObject({ highlightCount: 0, revision: beforeTag.revision + 1 });
      expect(library.listThreads()[0]).toMatchObject({ passageCount: 0, revision: beforeThread.revision + 1 });
      expect(library.getThread(thread.id)?.passages).toEqual([]);

      const appended = library.listPendingSyncChanges(1_000).slice(pendingBefore);
      expect(appended.filter(({ operation }) => operation === "tombstone").map(({ entityType }) => entityType).sort())
        .toEqual(["highlight", "note"]);
      expect(() => library.deleteHighlight({ id: doomed.id, bookId: book.id, expectedRevision: receipt.revision })).toThrow(/no longer exists/);
      expect(() => library.createNote({ bookId: book.id, highlightId: doomed.id, markdown: "Too late" })).toThrow();

      const note = library.getBookContents(book.id)!.standaloneNotes[0]!;
      expect(library.deleteNote({ id: note.id, bookId: book.id, expectedRevision: note.revision }))
        .toMatchObject({ bookId: book.id, revision: note.revision + 1, notesDeleted: 1 });
      expect(library.getBookContents(book.id)!.standaloneNotes).toEqual([]);
      expect(() => library.deleteNote({ id: note.id, bookId: book.id, expectedRevision: note.revision + 1 })).toThrow(/no longer exists/);
    } finally {
      library.close();
    }
  });

  it("never restores a deleted passage or imported note when its source is imported again", () => {
    const library = new LocalLibrary(":memory:");
    const source = sourceProfile("portable:deletion");
    const documentWith = (first: string, second: string, note: string) => ({
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Book", authors: [] }],
      annotations: [
        { providerRecordId: "first", bookProviderRecordId: "book", text: first },
        { providerRecordId: "second", bookProviderRecordId: "book", text: second, note },
      ],
    });
    try {
      library.importDocument({ document: documentWith("First", "Second", "Imported note"), fileName: "a.json", provider: "portable", source, warnings: [] });
      const book = library.listBooks()[0]!;
      const imported = library.getBookContents(book.id)!.highlights;
      const first = imported.find(({ text }) => text === "First");
      const second = imported.find(({ text }) => text === "Second");
      library.deleteHighlight({ id: first!.id, bookId: book.id, expectedRevision: first!.revision });
      const note = second!.notes[0]!;
      library.deleteNote({ id: note.id, bookId: book.id, expectedRevision: note.revision });

      const unchanged = library.importDocument({ document: documentWith("First", "Second", "Imported note"), fileName: "a.json", provider: "portable", source, warnings: [] });
      expect(unchanged).toMatchObject({ highlightsCreated: 0, annotationsUpdated: 0, notesCreated: 0, conflictsCreated: 0 });
      const changed = library.importDocument({ document: documentWith("First, revised", "Second", "Imported note, revised"), fileName: "a.json", provider: "portable", source, warnings: [] });
      expect(changed).toMatchObject({ highlightsCreated: 0, annotationsUpdated: 0, notesCreated: 0 });

      const contents = library.getBookContents(book.id)!;
      expect(contents.highlights.map(({ text }) => text)).toEqual(["Second"]);
      expect(contents.highlights[0]!.notes).toEqual([]);

      // A passage edited, conflicted, then deleted leaves nothing to review.
      const survivor = contents.highlights[0]!;
      library.updateHighlight({ id: survivor.id, bookId: book.id, text: "Second, my edit", expectedRevision: survivor.revision });
      library.importDocument({ document: documentWith("First", "Second, source edit", "Imported note"), fileName: "a.json", provider: "portable", source, warnings: [] });
      expect(library.listImportConflicts()).toHaveLength(1);
      const edited = library.getBookContents(book.id)!.highlights[0]!;
      library.deleteHighlight({ id: edited.id, bookId: book.id, expectedRevision: edited.revision });
      expect(library.listImportConflicts()).toEqual([]);
      expect(library.getBookContents(book.id)!.highlights).toEqual([]);
    } finally {
      library.close();
    }
  });
});

describe("book metadata", () => {
  it("replaces metadata revision-safely without disturbing reading state", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const book = library.createBook({ title: "Draft title", authors: ["Someone"] });
      library.createBook({ title: "Holder", isbn13: "9781635575637" });
      library.setBookReadingStatus({ id: book.id, status: "reading", expectedRevision: 1 });
      const current = library.getBook(book.id)!;
      const pending = library.listPendingSyncChanges(1_000).length;
      const updated = library.updateBookMetadata({
        id: book.id,
        expectedRevision: current.revision,
        title: "  Piranesi ",
        authors: ["Susanna Clarke"],
        description: "A house of tides.",
        publisher: "Bloomsbury",
        series: "Standalone",
        seriesNumber: "1",
        language: "en",
        coverUrl: "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg",
      });
      expect(updated).toMatchObject({
        title: "Piranesi", authors: ["Susanna Clarke"], description: "A house of tides.", publisher: "Bloomsbury",
        series: "Standalone", seriesNumber: "1", language: "en", coverUrl: "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg", status: "reading", revision: current.revision + 1,
      });
      expect(library.listPendingSyncChanges(1_000).slice(pending)).toMatchObject([{ entityType: "book", entityId: book.id, operation: "upsert" }]);

      expect(() => library.updateBookMetadata({ id: book.id, expectedRevision: current.revision, title: "Stale", authors: [] }))
        .toThrow(/changed elsewhere/);
      expect(() => library.updateBookMetadata({ id: book.id, expectedRevision: updated.revision, title: "Piranesi", authors: [], isbn13: "978-1-63557-563-7" }))
        .toThrow(/Another book already has that ISBN-13/);
      const cleared = library.updateBookMetadata({ id: book.id, expectedRevision: updated.revision, title: "Piranesi", authors: [] });
      expect(cleared).not.toHaveProperty("description");
      expect(cleared).not.toHaveProperty("publisher");
      expect(cleared).not.toHaveProperty("coverUrl");
      expect(cleared.authors).toEqual([]);

      library.setBookArchived({ id: book.id, archived: true, expectedRevision: cleared.revision });
      expect(() => library.updateBookMetadata({ id: book.id, expectedRevision: cleared.revision + 1, title: "Archived", authors: [] }))
        .toThrow(/no longer exists/);
    } finally {
      library.close();
    }
  });

  it("remembers the newest source values for reset while keeping the reader's edits", () => {
    const library = new LocalLibrary(":memory:");
    const source = sourceProfile("portable:metadata");
    const document = (publisher: string) => ({
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Piranesi", authors: ["Susanna Clarke"], publisher }],
      annotations: [],
    });
    try {
      library.importDocument({ document: document("Bloomsbury"), fileName: "a.json", provider: "portable", source, warnings: [] });
      const book = library.listBooks()[0]!;
      expect(library.getMetadataSource(book.id)).toMatchObject({ sourceName: source.name, values: { title: "Piranesi", publisher: "Bloomsbury" } });
      const edited = library.updateBookMetadata({ id: book.id, expectedRevision: book.revision, title: "Piranesi (annotated)", authors: ["Susanna Clarke"], publisher: "My edition" });

      library.importDocument({ document: document("Bloomsbury Publishing"), fileName: "a.json", provider: "portable", source, warnings: [] });
      expect(library.getBook(book.id)).toMatchObject({ title: "Piranesi (annotated)", publisher: "My edition", revision: edited.revision });
      expect(library.getMetadataSource(book.id)?.values).toEqual({ title: "Piranesi", authors: ["Susanna Clarke"], publisher: "Bloomsbury Publishing" });
      expect(library.getMetadataSource(library.createBook({ title: "Manual" }).id)).toBeUndefined();
    } finally {
      library.close();
    }
  });
});

describe("imported originals", () => {
  it("shows the latest imported original and resets an edited passage to it", () => {
    const library = new LocalLibrary(":memory:");
    const source = sourceProfile("portable:reset");
    const documentWith = (text: string, note: string) => ({
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Book", authors: [] }],
      annotations: [{ providerRecordId: "passage", bookProviderRecordId: "book", text, note, location: "Page 3" }],
    });
    try {
      library.importDocument({ document: documentWith("Original", "Source note"), fileName: "a.json", provider: "portable", source, warnings: [] });
      const book = library.listBooks()[0]!;
      const imported = library.getBookContents(book.id)!.highlights[0]!;
      expect(library.getHighlightSource(book.id, imported.id)).toMatchObject({
        sourceName: source.name, text: "Original", location: "Page 3", note: "Source note", differs: false,
        resetToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(library.getHighlightSource(book.id, library.createHighlight({ bookId: book.id, text: "Manual" }).id)).toBeUndefined();

      const edited = library.updateHighlight({ id: imported.id, bookId: book.id, text: "My wording", expectedRevision: imported.revision });
      const note = library.getBookContents(book.id)!.highlights.find(({ id }) => id === imported.id)!.notes[0]!;
      library.updateNote({ id: note.id, bookId: book.id, markdown: "My note", expectedRevision: note.revision });
      library.importDocument({ document: documentWith("Revised original", "Source note"), fileName: "a.json", provider: "portable", source, warnings: [] });
      expect(library.listImportConflicts()).toHaveLength(1);
      const reviewed = library.getHighlightSource(book.id, imported.id)!;
      expect(reviewed).toMatchObject({ text: "Revised original", differs: true });

      const current = library.getBookContents(book.id)!.highlights.find(({ id }) => id === imported.id)!;
      expect(() => library.resetHighlightToSource({
        id: imported.id, bookId: book.id, expectedRevision: edited.revision - 1, resetToken: reviewed.resetToken,
      })).toThrow(/changed elsewhere/);

      const currentNote = current.notes[0]!;
      library.updateNote({ id: currentNote.id, bookId: book.id, markdown: "Changed after review", expectedRevision: currentNote.revision });
      expect(() => library.resetHighlightToSource({
        id: imported.id, bookId: book.id, expectedRevision: current.revision, resetToken: reviewed.resetToken,
      })).toThrow(/changed after it was reviewed/);

      const reviewedAgain = library.getHighlightSource(book.id, imported.id)!;
      library.importDocument({ document: documentWith("Newest unreviewed original", "Source note"), fileName: "a.json", provider: "portable", source, warnings: [] });
      expect(() => library.resetHighlightToSource({
        id: imported.id, bookId: book.id, expectedRevision: current.revision, resetToken: reviewedAgain.resetToken,
      })).toThrow(/changed after it was reviewed/);

      const latest = library.getHighlightSource(book.id, imported.id)!;
      const reset = library.resetHighlightToSource({
        id: imported.id, bookId: book.id, expectedRevision: current.revision, resetToken: latest.resetToken,
      });
      expect(reset).toMatchObject({ text: "Newest unreviewed original", sourceLocation: "Page 3", revision: current.revision + 1 });
      expect(reset.notes.map(({ markdown, origin }) => [markdown, origin])).toEqual([["Source note", "import"]]);
      expect(library.listImportConflicts()).toEqual([]);
      expect(library.getHighlightSource(book.id, imported.id)).toMatchObject({ differs: false });

      // Reattached: the next changed import updates the passage directly again.
      const receipt = library.importDocument({ document: documentWith("Third original", "Source note"), fileName: "a.json", provider: "portable", source, warnings: [] });
      expect(receipt).toMatchObject({ annotationsUpdated: 1, conflictsCreated: 0 });
      expect(library.getBookContents(book.id)!.highlights.find(({ id }) => id === imported.id)!.text).toBe("Third original");
    } finally {
      library.close();
    }
  });
});

describe("atomic imports", () => {
  it("records three-way highlight conflicts and resolves them without silent overwrite", () => {
    const library = new LocalLibrary(":memory:");
    const source = sourceProfile("portable:conflict");
    const original = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Book", authors: [] }],
      annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "book", text: "Source base", location: "10" }],
    };
    library.importDocument({ document: original, fileName: "source.json", provider: "portable", source, warnings: [] });
    const book = library.listBooks()[0]!;
    const highlight = library.getBookContents(book.id)!.highlights[0]!;
    library.updateHighlight({
      id: highlight.id,
      bookId: book.id,
      text: "Reader edit",
      sourceLocation: "Local location",
      expectedRevision: highlight.revision,
    });

    const changed = {
      ...original,
      annotations: [{ ...original.annotations[0]!, text: "Source changed", location: "11" }],
    };
    const receipt = library.importDocument({ document: changed, fileName: "source.json", provider: "portable", source, warnings: [] });
    expect(receipt).toMatchObject({ annotationsUpdated: 0, conflictsCreated: 1 });
    expect(library.getBookContents(book.id)?.highlights[0]).toMatchObject({ text: "Reader edit", sourceLocation: "Local location" });
    const [conflict] = library.listImportConflicts();
    expect(conflict).toMatchObject({
      sourceName: source.name,
      bookTitle: "Book",
      kind: "highlight",
      base: { text: "Source base", location: "10" },
      local: { text: "Reader edit", location: "Local location" },
      incoming: { text: "Source changed", location: "11" },
    });
    if (!conflict) throw new Error("Conflict missing");

    const repeated = library.importDocument({ document: changed, fileName: "source.json", provider: "portable", source, warnings: [] });
    expect(repeated.conflictsCreated).toBe(0);
    expect(library.listImportConflicts()).toHaveLength(1);
    const current = library.getBookContents(book.id)!.highlights[0]!;
    library.updateHighlight({
      id: current.id,
      bookId: book.id,
      text: "Reader edit after review opened",
      sourceLocation: current.sourceLocation,
      expectedRevision: current.revision,
    });
    expect(library.resolveImportConflict({ id: conflict.id, resolution: "use-incoming" })).toBe(false);
    const refreshedConflict = library.listImportConflicts()[0]!;
    expect(refreshedConflict.local.text).toBe("Reader edit after review opened");
    expect(library.resolveImportConflict({ id: refreshedConflict.id, resolution: "keep-local" })).toBe(true);
    expect(library.listImportConflicts()).toEqual([]);
    expect(library.getBookContents(book.id)?.highlights[0]?.text).toBe("Reader edit after review opened");

    const changedAgain = {
      ...original,
      annotations: [{ ...original.annotations[0]!, text: "Newest source", location: "12" }],
    };
    expect(library.importDocument({ document: changedAgain, fileName: "source.json", provider: "portable", source, warnings: [] }).conflictsCreated).toBe(1);
    const nextConflict = library.listImportConflicts()[0]!;
    library.resolveImportConflict({ id: nextConflict.id, resolution: "use-incoming" });
    expect(library.getBookContents(book.id)?.highlights[0]).toMatchObject({ text: "Newest source", sourceLocation: "12" });
    expect(library.listImportConflicts()).toEqual([]);
    library.close();
  });

  it("tracks and explicitly resolves reader-edited imported notes", () => {
    const library = new LocalLibrary(":memory:");
    const source = sourceProfile("portable:note-conflict");
    const original = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Book", authors: [] }],
      annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "book", text: "Passage", note: "Source note" }],
    };
    library.importDocument({ document: original, fileName: "source.json", provider: "portable", source, warnings: [] });
    const book = library.listBooks()[0]!;
    const importedNote = library.getBookContents(book.id)!.highlights[0]!.notes[0]!;
    library.updateNote({ id: importedNote.id, bookId: book.id, markdown: "Reader note", expectedRevision: importedNote.revision });

    const changed = { ...original, annotations: [{ ...original.annotations[0]!, note: "Changed source note" }] };
    expect(library.importDocument({ document: changed, fileName: "source.json", provider: "portable", source, warnings: [] }).conflictsCreated).toBe(1);
    const conflict = library.listImportConflicts()[0]!;
    expect(conflict.local.note).toBe("Reader note");
    library.resolveImportConflict({ id: conflict.id, resolution: "use-incoming" });
    expect(library.getBookContents(book.id)?.highlights[0]?.notes).toMatchObject([
      { id: importedNote.id, markdown: "Changed source note", origin: "import" },
    ]);
    library.close();
  });

  it("does not let a newly imported source note bypass the active-note bound", () => {
    const library = new LocalLibrary(":memory:");
    const source = sourceProfile("portable:note-capacity");
    const original = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Book", authors: [] }],
      annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "book", text: "Passage" }],
    };
    library.importDocument({ document: original, fileName: "source.json", provider: "portable", source, warnings: [] });
    const book = library.listBooks()[0]!;
    const highlight = library.getBookContents(book.id)!.highlights[0]!;
    const notes = Array.from({ length: MAX_NOTES_PER_HIGHLIGHT }, (_, index) =>
      library.createNote({ bookId: book.id, highlightId: highlight.id, markdown: `Reader note ${index}` }));
    const changed = { ...original, annotations: [{ ...original.annotations[0]!, note: "New source note" }] };

    expect(() => library.importDocument({ document: changed, fileName: "source.json", provider: "portable", source, warnings: [] }))
      .toThrow(/delete one before importing its source note/);
    expect(library.getBookContents(book.id)?.highlights[0]?.notes).toHaveLength(MAX_NOTES_PER_HIGHLIGHT);

    const last = notes.at(-1)!;
    library.deleteNote({ id: last.id, bookId: book.id, expectedRevision: last.revision });
    expect(library.importDocument({ document: changed, fileName: "source.json", provider: "portable", source, warnings: [] }))
      .toMatchObject({ annotationsUpdated: 1, notesCreated: 1 });
    expect(library.getBookContents(book.id)?.highlights[0]?.notes).toHaveLength(MAX_NOTES_PER_HIGHLIGHT);
    library.close();
  });

  it("enforces the shared UTF-8 note-body bound for edits and imports", () => {
    const library = new LocalLibrary(":memory:");
    const book = library.createBook({ title: "Book" });
    expect(() => library.createNote({ bookId: book.id, markdown: "é".repeat(MAX_NOTE_BYTES / 2 + 1) }))
      .toThrow(/too long/);
    const source = sourceProfile("portable:oversized-note");
    expect(() => library.importDocument({
      document: {
        formatVersion: 1,
        books: [{ providerRecordId: "book", title: "Imported", authors: [] }],
        annotations: [{ providerRecordId: "passage", bookProviderRecordId: "book", text: "Passage", note: "é".repeat(MAX_NOTE_BYTES / 2 + 1) }],
      },
      fileName: "source.json", provider: "portable", source, warnings: [],
    })).toThrow(/too long/);
    expect(library.listBooks()).toEqual([book]);
    library.close();
  });

  it("bounds standalone imported notes and treats blank source notes as absent", () => {
    const library = new LocalLibrary(":memory:");
    const source = sourceProfile("portable:standalone-note");
    const standalone = (note: string) => ({
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Imported", authors: [] }],
      annotations: [{ providerRecordId: "loose", bookProviderRecordId: "book", note }],
    });
    try {
      // A note with no passage takes the same bound as one the reader writes.
      expect(() => library.importDocument({
        document: standalone("é".repeat(MAX_NOTE_BYTES / 2 + 1)),
        fileName: "source.json", provider: "portable", source, warnings: [],
      })).toThrow(/too long/);
      expect(library.listBooks()).toEqual([]);

      library.importDocument({ document: standalone("  Kept  "), fileName: "source.json", provider: "portable", source, warnings: [] });
      const book = library.listBooks()[0]!;
      expect(library.getBookContents(book.id)!.standaloneNotes.map(({ markdown }) => markdown)).toEqual(["Kept"]);

      // Re-importing the same note with fresh padding is not a reader edit.
      const repeated = library.importDocument({ document: standalone(" Kept "), fileName: "source.json", provider: "portable", source, warnings: [] });
      expect(repeated).toMatchObject({ notesCreated: 0 });
      expect(library.getBookContents(book.id)!.standaloneNotes.map(({ markdown, revision }) => [markdown, revision])).toEqual([["Kept", 1]]);

      const blanked = library.importDocument({ document: standalone("   "), fileName: "source.json", provider: "portable", source, warnings: [] });
      expect(blanked).toMatchObject({ annotationsUpdated: 1, notesCreated: 0 });
      expect(library.getBookContents(book.id)!.standaloneNotes.map(({ markdown, revision }) => [markdown, revision]))
        .toEqual([["Kept", 1]]);
    } finally {
      library.close();
    }
  });

  it("does not report whitespace in an imported note as a reader's edit", () => {
    const library = new LocalLibrary(":memory:");
    const source = sourceProfile("portable:padded-note");
    try {
      library.importDocument({
        document: {
          formatVersion: 1,
          books: [{ providerRecordId: "book", title: "Imported", authors: [] }],
          annotations: [{ providerRecordId: "passage", bookProviderRecordId: "book", text: "Passage", note: "  Padded note  " }],
        },
        fileName: "source.json", provider: "portable", source, warnings: [],
      });
      const book = library.listBooks()[0]!;
      const highlight = library.getBookContents(book.id)!.highlights[0]!;
      expect(highlight.notes.map(({ markdown }) => markdown)).toEqual(["Padded note"]);
      expect(library.getHighlightSource(book.id, highlight.id)).toMatchObject({ note: "Padded note", differs: false });

      const edited = library.updateNote({ id: highlight.notes[0]!.id, bookId: book.id, markdown: "My own note", expectedRevision: highlight.notes[0]!.revision });
      expect(library.getHighlightSource(book.id, highlight.id)?.differs).toBe(true);
      const reset = library.resetHighlightToSource({
        id: highlight.id,
        bookId: book.id,
        expectedRevision: library.getBookContents(book.id)!.highlights[0]!.revision,
        resetToken: library.getHighlightSource(book.id, highlight.id)!.resetToken,
      });
      expect(reset.notes.map(({ markdown }) => markdown)).toEqual(["Padded note"]);
      expect(edited.revision).toBe(2);
      // The reset converges: nothing is left to restore.
      expect(library.getHighlightSource(book.id, highlight.id)?.differs).toBe(false);
    } finally {
      library.close();
    }
  });

  it("refuses a completion date on a tombstoned book, as the online providers do", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-tombstoned-book-"));
    const path = join(directory, "library.sqlite");
    try {
      const library = new LocalLibrary(path);
      const book = library.createBook({ title: "Piranesi" });
      const finished = library.setBookReadingStatus({ id: book.id, status: "finished", expectedRevision: book.revision });
      library.close();

      // A tombstone only reaches a local book through sync, so apply it the
      // way a delivered change would.
      const database = new DatabaseSync(path);
      database.prepare("UPDATE books SET deleted_at = ? WHERE id = ?").run(Date.now(), book.id);
      database.close();

      const reopened = new LocalLibrary(path);
      try {
        expect(() => reopened.setBookCompletionDate({ id: book.id, completedOn: "2020-01-01", expectedRevision: finished.book.revision }))
          .toThrow(/changed elsewhere|no longer exists/);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists named source profiles and reuses them independently of file location", () => {
    const library = new LocalLibrary(":memory:");
    const source = {
      id: "5a540f21-7f61-44d7-89a5-f1b4643ce26c",
      name: "Kobo Clara",
      pathHintHash: "a".repeat(64),
    };
    const document = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Piranesi", authors: ["Susanna Clarke"] }],
      annotations: [],
    };

    library.importDocument({ document, fileName: "KoboReader.sqlite", provider: "kobo", source, warnings: [] });
    expect(library.listImportSources("kobo")).toEqual([{
      id: source.id,
      provider: "kobo",
      name: "Kobo Clara",
      lastImportedAt: expect.any(Number),
      pathHintHash: "a".repeat(64),
    }]);

    const repeated = library.importDocument({
      document,
      fileName: "moved.sqlite",
      provider: "kobo",
      source: { id: source.id, pathHintHash: "b".repeat(64) },
      warnings: [],
    });
    expect(repeated).toMatchObject({ booksCreated: 0, booksReused: 1 });
    expect(library.listImportSources("kobo")[0]).toMatchObject({
      id: source.id,
      name: "Kobo Clara",
      pathHintHash: "b".repeat(64),
    });
    library.close();
  });

  it("rejects invalid or cross-provider source reuse without changing the library", () => {
    const library = new LocalLibrary(":memory:");
    const document = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Book", authors: [] }],
      annotations: [],
    };
    const source = sourceProfile("portable:reader");
    library.importDocument({ document, fileName: "source.json", provider: "portable", source, warnings: [] });

    expect(() => library.importDocument({
      document,
      fileName: "clippings.txt",
      provider: "kindle",
      source: { id: source.id },
      warnings: [],
    })).toThrow(/another provider/);
    expect(() => library.importDocument({
      document,
      fileName: "source.json",
      provider: "portable",
      source: { id: source.id, pathHintHash: "not-a-hash" },
      warnings: [],
    })).toThrow(/path hint is invalid/);
    expect(library.listBooks()).toHaveLength(1);
    expect(library.listImportSources("kindle")).toEqual([]);
    library.close();
  });

  it("persists highlights and independent notes and makes re-import idempotent", () => {
    const library = new LocalLibrary(":memory:");
    const document = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book-1", title: "Piranesi", authors: ["Susanna Clarke"] }],
      annotations: [
        { providerRecordId: "highlight-1", bookProviderRecordId: "book-1", text: "A passage", note: "A note" },
        { providerRecordId: "note-1", bookProviderRecordId: "book-1", note: "Independent note" },
      ],
    };
    const first = library.importDocument({
      document,
      fileName: "KoboReader.sqlite",
      provider: "kobo",
      source: sourceProfile("kobo:default"),
      warnings: [],
    });
    expect(first).toEqual({
      booksCreated: 1,
      booksReused: 0,
      highlightsCreated: 1,
      annotationsUpdated: 0,
      notesCreated: 2,
      conflictsCreated: 0,
    });
    const [book] = library.listBooks();
    expect(book).toMatchObject({ title: "Piranesi", highlightCount: 1 });
    if (!book) throw new Error("Imported book missing");
    expect(library.getBookContents(book.id)).toMatchObject({
      highlights: [{ text: "A passage", notes: [{ markdown: "A note", origin: "import" }] }],
      standaloneNotes: [{ markdown: "Independent note", origin: "import" }],
    });

    const second = library.importDocument({
      document,
      fileName: "KoboReader.sqlite",
      provider: "kobo",
      source: sourceProfile("kobo:default"),
      warnings: [],
    });
    expect(second).toEqual({
      booksCreated: 0,
      booksReused: 1,
      highlightsCreated: 0,
      annotationsUpdated: 0,
      notesCreated: 0,
      conflictsCreated: 0,
    });
    expect(library.listBooks()).toMatchObject([{ highlightCount: 1 }]);
    library.close();
  });

  it("rolls back the whole import when an annotation changes identity form", () => {
    const library = new LocalLibrary(":memory:");
    const base = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Book", authors: [] }],
      annotations: [{ providerRecordId: "item", bookProviderRecordId: "book", text: "Passage" }],
    };
    library.importDocument({ document: base, fileName: "source.json", provider: "portable", source: sourceProfile("portable:default"), warnings: [] });
    expect(() => library.importDocument({
      document: { ...base, annotations: [{ providerRecordId: "item", bookProviderRecordId: "book", note: "Now a note" }] },
      fileName: "source.json",
      provider: "portable",
      source: sourceProfile("portable:default"),
      warnings: [],
    })).toThrow(/changed between note and highlight/);
    expect(library.listBooks()).toMatchObject([{ highlightCount: 1 }]);
    library.close();
  });

  it("does not overwrite a passage that the reader edited after importing", () => {
    const library = new LocalLibrary(":memory:");
    const original = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Book", authors: [] }],
      annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "book", text: "Imported text" }],
    };
    library.importDocument({ document: original, fileName: "source.json", provider: "portable", source: sourceProfile("portable:edited"), warnings: [] });
    const book = library.listBooks()[0]!;
    const highlight = library.getBookContents(book.id)!.highlights[0]!;
    library.updateHighlight({
      id: highlight.id,
      bookId: book.id,
      text: "Reader's deliberate edit",
      expectedRevision: highlight.revision,
    });

    const receipt = library.importDocument({
      document: { ...original, annotations: [{ ...original.annotations[0]!, text: "Changed at source" }] },
      fileName: "source.json",
      provider: "portable",
      source: sourceProfile("portable:edited"),
      warnings: [],
    });
    expect(receipt.annotationsUpdated).toBe(0);
    expect(library.getBookContents(book.id)?.highlights[0]?.text).toBe("Reader's deliberate edit");
    library.close();
  });

  it("removes an imported attached note when the source removes it", () => {
    const library = new LocalLibrary(":memory:");
    const original = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Book", authors: [] }],
      annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "book", text: "Passage", note: "Source note" }],
    };
    library.importDocument({ document: original, fileName: "source.json", provider: "portable", source: sourceProfile("portable:note-removal"), warnings: [] });
    const book = library.listBooks()[0]!;
    expect(library.getBookContents(book.id)?.highlights[0]?.notes).toHaveLength(1);

    const receipt = library.importDocument({
      document: { ...original, annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "book", text: "Passage" }] },
      fileName: "source.json",
      provider: "portable",
      source: sourceProfile("portable:note-removal"),
      warnings: [],
    });
    expect(receipt.annotationsUpdated).toBe(1);
    expect(library.getBookContents(book.id)?.highlights[0]?.notes).toEqual([]);
    library.close();
  });

  it("keeps sources with overlapping provider IDs independent", () => {
    const library = new LocalLibrary(":memory:");
    const first = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "First device book", authors: [] }],
      annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "book", text: "First passage" }],
    };
    const second = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Second device book", authors: [] }],
      annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "book", text: "Second passage" }],
    };
    library.importDocument({ document: first, fileName: "first.json", provider: "portable", source: sourceProfile("source-one"), warnings: [] });
    library.importDocument({ document: second, fileName: "second.json", provider: "portable", source: sourceProfile("source-two"), warnings: [] });
    expect(library.listBooks().map(({ title, highlightCount }) => ({ title, highlightCount }))
      .sort((left, right) => left.title.localeCompare(right.title))).toEqual([
        { title: "First device book", highlightCount: 1 },
        { title: "Second device book", highlightCount: 1 },
      ]);
    library.close();
  });

  it("preserves an imported note after the reader edits it", () => {
    const library = new LocalLibrary(":memory:");
    const original = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Book", authors: [] }],
      annotations: [{ providerRecordId: "note", bookProviderRecordId: "book", note: "Imported note" }],
    };
    library.importDocument({ document: original, fileName: "source.json", provider: "portable", source: sourceProfile("portable:edited-note"), warnings: [] });
    const book = library.listBooks()[0]!;
    const note = library.getBookContents(book.id)!.standaloneNotes[0]!;
    library.updateNote({ id: note.id, bookId: book.id, markdown: "Reader's note", expectedRevision: note.revision });
    library.importDocument({
      document: { ...original, annotations: [{ ...original.annotations[0]!, note: "Changed at source" }] },
      fileName: "source.json",
      provider: "portable",
      source: sourceProfile("portable:edited-note"),
      warnings: [],
    });
    expect(library.getBookContents(book.id)?.standaloneNotes).toMatchObject([{ markdown: "Reader's note", origin: "reader" }]);
    library.close();
  });

  it("does not duplicate an attached imported note after the reader edits it", () => {
    const library = new LocalLibrary(":memory:");
    const original = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "book", title: "Book", authors: [] }],
      annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "book", text: "Passage", note: "Imported note" }],
    };
    library.importDocument({ document: original, fileName: "source.json", provider: "portable", source: sourceProfile("portable:attached-note"), warnings: [] });
    const book = library.listBooks()[0]!;
    const note = library.getBookContents(book.id)!.highlights[0]!.notes[0]!;
    library.updateNote({ id: note.id, bookId: book.id, markdown: "Reader's note", expectedRevision: note.revision });
    library.importDocument({
      document: { ...original, annotations: [{ ...original.annotations[0]!, note: "Changed at source" }] },
      fileName: "source.json",
      provider: "portable",
      source: sourceProfile("portable:attached-note"),
      warnings: [],
    });
    expect(library.getBookContents(book.id)?.highlights[0]?.notes)
      .toMatchObject([{ markdown: "Reader's note", origin: "reader" }]);
    library.close();
  });

  it("rolls back provenance when a source moves an annotation to another book", () => {
    const library = new LocalLibrary(":memory:");
    const original = {
      formatVersion: 1 as const,
      books: [
        { providerRecordId: "first", title: "First", authors: [] },
        { providerRecordId: "second", title: "Second", authors: [] },
      ],
      annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "first", text: "Passage" }],
    };
    library.importDocument({ document: original, fileName: "source.json", provider: "portable", source: sourceProfile("portable:moved"), warnings: [] });
    const moved = { ...original, annotations: [{ ...original.annotations[0]!, bookProviderRecordId: "second", text: "Moved passage" }] };
    expect(() => library.importDocument({ document: moved, fileName: "source.json", provider: "portable", source: sourceProfile("portable:moved"), warnings: [] }))
      .toThrow(/moved or no longer exists/);
    expect(() => library.importDocument({ document: moved, fileName: "source.json", provider: "portable", source: sourceProfile("portable:moved"), warnings: [] }))
      .toThrow(/moved or no longer exists/);
    expect(library.listBooks().reduce((count, book) => count + book.highlightCount, 0)).toBe(1);
    library.close();
  });
});

describe("manual annotation editing", () => {
  it("creates and revises highlights, attached notes, and standalone notes", () => {
    const library = new LocalLibrary(":memory:");
    const book = library.createBook({ title: "Piranesi" });
    const highlight = library.createHighlight({
      bookId: book.id,
      text: "  Every Room of the House keeps its weather.  ",
      sourceLocation: "  Entry 1  ",
    });
    expect(highlight).toMatchObject({ text: "Every Room of the House keeps its weather.", sourceLocation: "Entry 1", revision: 1 });

    const attached = library.createNote({ bookId: book.id, highlightId: highlight.id, markdown: "  Remember this.  " });
    const standalone = library.createNote({ bookId: book.id, markdown: "  Look up the statues.  " });
    expect(attached).toMatchObject({ markdown: "Remember this.", origin: "reader", revision: 1 });
    expect(standalone.highlightId).toBeUndefined();

    const revisedHighlight = library.updateHighlight({
      id: highlight.id,
      bookId: book.id,
      text: "Every Room of the House keeps its weather; its stairs keep count.",
      expectedRevision: highlight.revision,
    });
    const revisedNote = library.updateNote({
      id: attached.id,
      bookId: book.id,
      markdown: "Place can be mystery and shelter.",
      expectedRevision: attached.revision,
    });
    expect(revisedHighlight).toMatchObject({ revision: 2 });
    expect(revisedHighlight.sourceLocation).toBeUndefined();
    expect(revisedNote).toMatchObject({ revision: 2, markdown: "Place can be mystery and shelter.", origin: "reader" });
    expect(library.getBookContents(book.id)).toMatchObject({
      book: { highlightCount: 1, revision: 6 },
      highlights: [{ revision: 2, notes: [{ revision: 2 }] }],
      standaloneNotes: [{ id: standalone.id }],
    });
    library.close();
  });

  it("rejects stale revisions without partially touching the book", () => {
    const library = new LocalLibrary(":memory:");
    const book = library.createBook({ title: "Piranesi" });
    const highlight = library.createHighlight({ bookId: book.id, text: "First version" });
    const revised = library.updateHighlight({
      id: highlight.id,
      bookId: book.id,
      text: "Second version",
      expectedRevision: 1,
    });
    const bookRevision = library.getBook(book.id)?.revision;
    expect(() => library.updateHighlight({
      id: highlight.id,
      bookId: book.id,
      text: "Stale overwrite",
      expectedRevision: 1,
    })).toThrow(/changed elsewhere/);
    expect(library.getBook(book.id)?.revision).toBe(bookRevision);
    expect(library.getBookContents(book.id)?.highlights[0]).toEqual(revised);
    library.close();
  });

  it("does not attach a note to a highlight from another book", () => {
    const library = new LocalLibrary(":memory:");
    const first = library.createBook({ title: "First" });
    const second = library.createBook({ title: "Second" });
    const highlight = library.createHighlight({ bookId: first.id, text: "A passage" });
    expect(() => library.createNote({ bookId: second.id, highlightId: highlight.id, markdown: "Wrong book" }))
      .toThrow(/Highlight no longer exists/);
    expect(library.getBook(second.id)?.revision).toBe(1);
    library.close();
  });

  it("bounds active notes per passage and releases capacity after deletion", () => {
    const library = new LocalLibrary(":memory:");
    const book = library.createBook({ title: "Piranesi" });
    const highlight = library.createHighlight({ bookId: book.id, text: "A passage" });
    const notes = Array.from({ length: MAX_NOTES_PER_HIGHLIGHT }, (_, index) =>
      library.createNote({ bookId: book.id, highlightId: highlight.id, markdown: `Note ${index}` }));
    expect(() => library.createNote({ bookId: book.id, highlightId: highlight.id, markdown: "One too many" }))
      .toThrow(/at most 200 active notes/);
    const last = notes.at(-1)!;
    library.deleteNote({ id: last.id, bookId: book.id, expectedRevision: last.revision });
    expect(() => library.createNote({ bookId: book.id, highlightId: highlight.id, markdown: "Replacement" }))
      .not.toThrow();
    library.close();
  });
});

describe("book archive shelf", () => {
  it("archives and restores without removing reading data", () => {
    const library = new LocalLibrary(":memory:");
    const book = library.createBook({ title: "Piranesi" });
    library.createHighlight({ bookId: book.id, text: "A passage" });
    const current = library.getBook(book.id)!;
    const archived = library.setBookArchived({ id: book.id, archived: true, expectedRevision: current.revision });
    expect(archived).toMatchObject({ archived: true, revision: current.revision + 1 });
    expect(library.listBooks()).toEqual([]);
    expect(library.listBooks({ includeArchived: true })).toHaveLength(1);
    expect(library.getBookContents(book.id)?.highlights).toHaveLength(1);
    expect(() => library.createNote({ bookId: book.id, markdown: "Hidden edit" })).toThrow(/Book no longer exists/);

    const restored = library.setBookArchived({ id: book.id, archived: false, expectedRevision: archived.revision });
    expect(restored).toMatchObject({ archived: false, revision: archived.revision + 1 });
    expect(library.listBooks()).toMatchObject([{ id: book.id, highlightCount: 1 }]);
    library.close();
  });

  it("rejects a stale or redundant shelf change", () => {
    const library = new LocalLibrary(":memory:");
    const book = library.createBook({ title: "Piranesi" });
    const archived = library.setBookArchived({ id: book.id, archived: true, expectedRevision: 1 });
    expect(() => library.setBookArchived({ id: book.id, archived: false, expectedRevision: 1 })).toThrow(/changed elsewhere/);
    expect(() => library.setBookArchived({ id: book.id, archived: true, expectedRevision: archived.revision })).toThrow(/already in that shelf/);
    library.close();
  });
});

describe("explicit book merging", () => {
  it("moves pending import conflicts with a merged book", () => {
    const library = new LocalLibrary(":memory:");
    const sourceProfileInput = sourceProfile("portable:merge-conflict");
    const original = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "source-book", title: "Source edition", authors: [] }],
      annotations: [{ providerRecordId: "highlight", bookProviderRecordId: "source-book", text: "Source base" }],
    };
    library.importDocument({ document: original, fileName: "source.json", provider: "portable", source: sourceProfileInput, warnings: [] });
    const source = library.listBooks()[0]!;
    const highlight = library.getBookContents(source.id)!.highlights[0]!;
    library.updateHighlight({ id: highlight.id, bookId: source.id, text: "Reader edit", expectedRevision: highlight.revision });
    const changed = { ...original, annotations: [{ ...original.annotations[0]!, text: "Source changed" }] };
    library.importDocument({ document: changed, fileName: "source.json", provider: "portable", source: sourceProfileInput, warnings: [] });
    const target = library.createBook({ title: "Kept edition" });
    const currentSource = library.getBook(source.id)!;
    library.mergeBooks({
      sourceBookId: source.id,
      targetBookId: target.id,
      expectedSourceRevision: currentSource.revision,
      expectedTargetRevision: target.revision,
    });

    const conflict = library.listImportConflicts()[0]!;
    expect(conflict.bookTitle).toBe("Kept edition");
    expect(library.resolveImportConflict({ id: conflict.id, resolution: "use-incoming" })).toBe(true);
    expect(library.getBookContents(target.id)?.highlights[0]?.text).toBe("Source changed");
    library.close();
  });

  it("moves reading data and import links, then archives the duplicate atomically", () => {
    const library = new LocalLibrary(":memory:");
    const document = {
      formatVersion: 1 as const,
      books: [{ providerRecordId: "source-book", title: "Piranesi", authors: ["Susanna Clarke"] }],
      annotations: [{ providerRecordId: "source-highlight", bookProviderRecordId: "source-book", text: "A passage", note: "A note" }],
    };
    library.importDocument({ document, fileName: "source.json", provider: "portable", source: sourceProfile("portable:merge"), warnings: [] });
    const source = library.listBooks()[0]!;
    library.createNote({ bookId: source.id, markdown: "Standalone thought" });
    const currentSource = library.getBook(source.id)!;
    const target = library.createBook({ title: "Piranesi — preferred edition" });

    const receipt = library.mergeBooks({
      sourceBookId: source.id,
      targetBookId: target.id,
      expectedSourceRevision: currentSource.revision,
      expectedTargetRevision: target.revision,
    });
    expect(receipt).toMatchObject({ highlightsMoved: 1, notesMoved: 2 });
    expect(library.getBookContents(target.id)).toMatchObject({
      book: { archived: false, highlightCount: 1 },
      highlights: [{ text: "A passage", notes: [{ markdown: "A note" }] }],
      standaloneNotes: [{ markdown: "Standalone thought" }],
    });
    expect(library.getBookContents(source.id)).toMatchObject({ book: { archived: true }, highlights: [], standaloneNotes: [] });

    const repeated = library.importDocument({ document, fileName: "source.json", provider: "portable", source: sourceProfile("portable:merge"), warnings: [] });
    expect(repeated).toMatchObject({ booksCreated: 0, booksReused: 1, highlightsCreated: 0 });
    expect(library.getBookContents(target.id)?.highlights).toHaveLength(1);
    library.close();
  });

  it("rolls back when either reviewed book revision is stale", () => {
    const library = new LocalLibrary(":memory:");
    const source = library.createBook({ title: "Source" });
    const target = library.createBook({ title: "Target" });
    library.createHighlight({ bookId: source.id, text: "A passage" });
    expect(() => library.mergeBooks({ sourceBookId: source.id, targetBookId: target.id, expectedSourceRevision: 1, expectedTargetRevision: 1 }))
      .toThrow(/Source book changed/);
    expect(library.getBook(source.id)?.archived).toBe(false);
    expect(library.getBookContents(source.id)?.highlights).toHaveLength(1);
    expect(library.getBook(target.id)?.revision).toBe(1);
    library.close();
  });
});

function sourceProfile(identity: string): { readonly id: string; readonly name: string } {
  const digest = createHash("sha256").update(identity).digest("hex");
  return {
    id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
    name: identity,
  };
}

describe("sync conflict review", () => {
  const bookId = "a1000000-0000-4000-8000-000000000000";
  const highlightId = "a2000000-0000-4000-8000-000000000000";
  const noteId = "a3000000-0000-4000-8000-000000000000";
  const remoteDeviceId = "a4000000-0000-4000-8000-000000000000";

  function withIncomingLibrary(run: (library: LocalLibrary, apply: (change: SyncedChange) => void, path: string) => void): void {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-sync-review-"));
    const path = join(directory, "library.sqlite");
    try {
      new LocalLibrary(path).close();
      const setup = new DatabaseSync(path);
      setup.prepare("UPDATE sync_state SET remote_generation = 1, remote_sequence = 0, snapshot_required = 0").run();
      setup.close();
      const library = new LocalLibrary(path);
      let sequence = 0;
      const apply = (change: SyncedChange) => {
        library.applyIncomingSyncedChange({ change, sequence: sequence + 1,
          expectedCursor: { generation: 1, afterSequence: sequence }, nextCursor: { generation: 1, afterSequence: sequence + 1 } });
        sequence += 1;
      };
      apply({ entityType: "book", operation: "upsert", deviceId: remoteDeviceId, deviceRevision: 1, collectionIds: [], tagIds: [], book: {
        id: bookId, title: "Piranesi", authors: [], status: "reading", archived: false,
        createdAt: 10, updatedAt: 10, revision: 1, highlightCount: 0,
      } } as unknown as SyncedChange);
      apply({ entityType: "highlight", operation: "upsert", deviceId: remoteDeviceId, deviceRevision: 1, tagIds: [], threadIds: [], highlight: {
        id: highlightId, bookId, text: "The House is kept", sourceLocation: "p. 4",
        createdAt: 11, updatedAt: 11, revision: 1,
      } } as unknown as SyncedChange);
      apply({ entityType: "note", operation: "upsert", deviceId: remoteDeviceId, deviceRevision: 1, note: {
        id: noteId, bookId, highlightId, markdown: "Remote ancestor", origin: "reader", createdAt: 12, updatedAt: 12, revision: 1,
      } } as unknown as SyncedChange);
      try {
        run(library, apply, path);
      } finally {
        library.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const remoteNote = (markdown: string, deviceRevision: number) => ({
    entityType: "note", operation: "upsert", deviceId: remoteDeviceId, deviceRevision, note: {
      id: noteId, bookId, highlightId, markdown, origin: "reader", createdAt: 12, updatedAt: 12, revision: deviceRevision,
    } } as unknown as SyncedChange);

  it("restores a losing note body as an ordinary synced edit, bound to the state shown", () => {
    withIncomingLibrary((library, apply) => {
      library.updateNote({ id: noteId as never, bookId: bookId as never, expectedRevision: 1, markdown: "Local draft" });
      apply(remoteNote("Other device draft", 5));
      const page = library.listSyncConflicts();
      expect(page.total).toBe(1);
      expect(page.conflicts).toEqual([expect.objectContaining({
        kind: "note", bookId, bookTitle: "Piranesi", preservedBody: "Local draft", preservedOnThisDevice: true,
        currentBody: "Other device draft", passageText: "The House is kept", restore: "copy",
      })]);
      const [conflict] = page.conflicts;
      expect(JSON.stringify(conflict)).not.toContain(remoteDeviceId);

      expect(library.resolveSyncConflict({ id: conflict!.id, resolution: "restore",
        expectedRevision: conflict!.currentRevision - 1 })).toBe(false);
      expect(library.listSyncConflicts().total).toBe(1);

      const pendingBefore = library.listPendingSyncChanges().length;
      expect(library.resolveSyncConflict({ id: conflict!.id, resolution: "restore",
        expectedRevision: conflict!.currentRevision })).toBe(true);
      const notes = library.getBookContents(bookId as never)!.highlights[0]!.notes;
      expect(notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: noteId, markdown: "Other device draft", origin: "reader" }),
        expect.objectContaining({ markdown: "Local draft", origin: "reader" }),
      ]));
      const note = notes.find(({ id }) => id !== noteId)!;
      expect(library.listPendingSyncChanges().slice(pendingBefore)).toEqual(expect.arrayContaining([
        expect.objectContaining({ entityType: "note", entityId: note.id, revision: note.revision }),
      ]));
      expect(library.listSyncConflicts()).toEqual({ conflicts: [], total: 0 });
      expect(() => library.resolveSyncConflict({ id: conflict!.id, resolution: "discard",
        expectedRevision: conflict!.currentRevision })).toThrow(/no longer exists/);
    });
  });

  it("brings back a passage whose deletion won under a new identity, and clears discarded bodies", () => {
    withIncomingLibrary((library, apply) => {
      library.updateHighlight({ id: highlightId as never, bookId: bookId as never, expectedRevision: 1,
        text: "The House is kind", sourceLocation: "p. 4" });
      apply({ entityType: "note", operation: "tombstone", deviceId: remoteDeviceId, deviceRevision: 2,
        entityId: noteId, bookId } as unknown as SyncedChange);
      apply({ entityType: "highlight", operation: "tombstone", deviceId: remoteDeviceId, deviceRevision: 2,
        entityId: highlightId, bookId } as unknown as SyncedChange);
      const [passage] = library.listSyncConflicts().conflicts;
      expect(passage).toMatchObject({ kind: "highlight", preservedBody: "The House is kind", restore: "copy" });
      expect(passage).not.toHaveProperty("currentBody");

      expect(library.resolveSyncConflict({ id: passage!.id, resolution: "restore",
        expectedRevision: passage!.currentRevision })).toBe(true);
      const restored = library.getBookContents(bookId as never)!.highlights;
      expect(restored).toMatchObject([{ text: "The House is kind", sourceLocation: "p. 4" }]);
      expect(restored[0]!.id).not.toBe(highlightId);
      // The deleted note still held the remote ancestor, so only the passage needed review.
      expect(library.listSyncConflicts().total).toBe(0);
    });
  });

  it("recreates a deleted note on its passage and discards without keeping the body", () => {
    withIncomingLibrary((library, apply, path) => {
      library.updateNote({ id: noteId as never, bookId: bookId as never, expectedRevision: 1, markdown: "Keep me" });
      apply({ entityType: "note", operation: "tombstone", deviceId: remoteDeviceId, deviceRevision: 2,
        entityId: noteId, bookId } as unknown as SyncedChange);
      const [first] = library.listSyncConflicts().conflicts;
      expect(first).toMatchObject({ kind: "note", preservedBody: "Keep me", restore: "copy", passageText: "The House is kept" });
      expect(library.resolveSyncConflict({ id: first!.id, resolution: "restore",
        expectedRevision: first!.currentRevision })).toBe(true);
      const notes = library.getBookContents(bookId as never)!.highlights[0]!.notes;
      expect(notes).toMatchObject([{ markdown: "Keep me", origin: "reader" }]);
      expect(notes[0]!.id).not.toBe(noteId);

      const second = notes[0]!;
      library.updateNote({ id: second.id, bookId: bookId as never, expectedRevision: second.revision, markdown: "Mine" });
      apply({ entityType: "note", operation: "tombstone", deviceId: remoteDeviceId, deviceRevision: 3,
        entityId: second.id, bookId } as unknown as SyncedChange);
      const [conflict] = library.listSyncConflicts().conflicts;
      expect(library.resolveSyncConflict({ id: conflict!.id, resolution: "discard",
        expectedRevision: conflict!.currentRevision })).toBe(true);
      expect(library.listSyncConflicts().total).toBe(0);
      expect(library.getBookContents(bookId as never)!.highlights[0]!.notes).toEqual([]);
      const inspection = new DatabaseSync(path, { readOnly: true });
      expect(inspection.prepare("SELECT losing_body, winning_body, status FROM sync_conflicts").all())
        .toEqual([{ losing_body: "", winning_body: null, status: "resolved" }, { losing_body: "", winning_body: null, status: "resolved" }]);
      inspection.close();
    });
  });

  it("offers only discard while the book is archived and validates input", () => {
    withIncomingLibrary((library, apply) => {
      library.updateNote({ id: noteId as never, bookId: bookId as never, expectedRevision: 1, markdown: "Local draft" });
      apply(remoteNote("Other device draft", 5));
      const book = library.getBook(bookId as never)!;
      library.setBookArchived({ id: book.id, expectedRevision: book.revision, archived: true });
      const [conflict] = library.listSyncConflicts().conflicts;
      expect(conflict).toMatchObject({ restore: "unavailable", bookTitle: "Piranesi" });
      expect(() => library.resolveSyncConflict({ id: conflict!.id, resolution: "restore",
        expectedRevision: conflict!.currentRevision })).toThrow(/not available/);
      expect(library.listSyncConflicts().total).toBe(1);
      expect(() => library.resolveSyncConflict({ id: "not-a-uuid" as never, resolution: "discard", expectedRevision: 1 }))
        .toThrow(/invalid/);
      expect(() => library.resolveSyncConflict({ id: conflict!.id, resolution: "keep" as never, expectedRevision: 1 }))
        .toThrow(/invalid/);
      expect(() => library.listSyncConflicts(0)).toThrow(/page size/);
      expect(library.resolveSyncConflict({ id: conflict!.id, resolution: "discard",
        expectedRevision: conflict!.currentRevision })).toBe(true);
    });
  });
});

describe("thread synchronization", () => {
  it("queues existing threads and threaded passages once when a synced library upgrades to schema 17", () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database, migrations.slice(0, 16));
      const device = "20000000-0000-4000-8000-000000000000";
      database.exec(`
        INSERT INTO sync_devices (id, created_at, updated_at) VALUES ('${device}', 1, 1);
        INSERT INTO sync_state (singleton, device_id, remote_generation, remote_sequence, snapshot_required, updated_at)
          VALUES (1, '${device}', 1, 4, 0, 1);
        INSERT INTO books (id, title, authors_json, created_at, updated_at) VALUES ('30000000-0000-4000-8000-000000000000', 'Piranesi', '[]', 1, 1);
        INSERT INTO highlights (id, book_id, text, created_at, updated_at, revision)
          VALUES ('40000000-0000-4000-8000-000000000000', '30000000-0000-4000-8000-000000000000', 'Threaded', 1, 1, 3),
                 ('41000000-0000-4000-8000-000000000000', '30000000-0000-4000-8000-000000000000', 'Alone', 1, 1, 1);
        INSERT INTO threads (id, name, normalized_name, created_at, updated_at, revision)
          VALUES ('50000000-0000-4000-8000-000000000000', 'Architecture', 'architecture', 1, 1, 2);
        INSERT INTO thread_highlights (thread_id, highlight_id, added_at)
          VALUES ('50000000-0000-4000-8000-000000000000', '40000000-0000-4000-8000-000000000000', 1);
      `);
      const before = Number((database.prepare("SELECT count(*) AS count FROM sync_outbox").get() as { count: number }).count);
      expect(applyMigrations(database)).toBe(17);
      const queued = database.prepare(
        "SELECT entity_type, entity_id, revision, operation FROM sync_outbox ORDER BY sequence",
      ).all().slice(before);
      expect(queued).toEqual([
        { entity_type: "thread", entity_id: "50000000-0000-4000-8000-000000000000", revision: 2, operation: "upsert" },
        { entity_type: "highlight", entity_id: "40000000-0000-4000-8000-000000000000", revision: 3, operation: "upsert" },
      ]);
      // Same-name threads can now coexist when they come from different devices.
      database.exec(`INSERT INTO threads (id, name, normalized_name, created_at, updated_at)
        VALUES ('51000000-0000-4000-8000-000000000000', 'architecture', 'architecture', 2, 2)`);
    } finally {
      database.close();
    }
  });

  it("sends threads before the passages that reference them and replays thread membership", () => {
    const directory = mkdtempSync(join(tmpdir(), "leaflogue-thread-sync-"));
    try {
      const library = new LocalLibrary(join(directory, "library.sqlite"));
      library.bootstrapSync({ generation: 1, afterSequence: 0 });
      const book = library.createBook({ title: "Piranesi" });
      const highlight = library.createHighlight({ bookId: book.id, text: "The House" });
      const thread = library.createThread({ name: "Architecture", description: "Halls" });
      library.setHighlightThreadMembership({
        bookId: book.id, highlightId: highlight.id, threadIds: [thread.id], expectedHighlightRevision: highlight.revision,
      });
      expect(() => library.createThread({ name: " architecture " })).toThrow("already in use");
      const { changes } = library.resolvePendingSyncChanges();
      const order = changes.map(({ change }) => change.entityType);
      expect(order.indexOf("thread")).toBeLessThan(order.indexOf("highlight"));
      expect(changes.find(({ change }) => change.entityType === "thread")?.change)
        .toMatchObject({ operation: "upsert", thread: { id: thread.id, name: "Architecture", description: "Halls" } });
      expect(changes.find(({ change }) => change.entityType === "highlight")?.change)
        .toMatchObject({ operation: "upsert", threadIds: [thread.id] });

      const remote = "60000000-0000-4000-8000-000000000000" as never;
      const deviceId = "70000000-0000-4000-8000-000000000000";
      let sequence = 0;
      const apply = (change: SyncedChange) => {
        const state = library.getSyncState();
        sequence += 1;
        return library.applyIncomingSyncedChange({ change, sequence, expectedCursor: state.remoteCursor!,
          nextCursor: { generation: 1, afterSequence: sequence } });
      };
      expect(apply({ entityType: "thread", operation: "upsert", deviceId, deviceRevision: 1,
        thread: { id: remote, name: "architecture", passageCount: 0, createdAt: 1, updatedAt: 1, revision: 1 } })).toBe("applied");
      const current = library.getBookContents(book.id)!.highlights[0]!;
      const stale = "80000000-0000-4000-8000-000000000000" as never;
      expect(apply({ entityType: "thread", operation: "tombstone", deviceId, deviceRevision: 1, entityId: stale })).toBe("applied");
      expect(apply({ entityType: "highlight", operation: "upsert", deviceId, deviceRevision: current.revision + 10,
        tagIds: [], threadIds: [remote, stale], highlight: { ...current, revision: current.revision + 10 } } as SyncedChange)).toBe("applied");
      // The winning snapshot replaces membership wholesale and drops the tombstoned thread.
      expect(library.getHighlightThreadIds(book.id, highlight.id)).toEqual([remote]);
      expect(library.listThreads().map(({ name }) => name.toLowerCase())).toEqual(["architecture", "architecture"]);
      // An older provider's passage carries no membership: local links stay.
      const newer = library.getBookContents(book.id)!.highlights[0]!;
      expect(apply({ entityType: "highlight", operation: "upsert", deviceId, deviceRevision: newer.revision + 10,
        tagIds: [], highlight: { ...newer, text: "The House, revised", revision: newer.revision + 10 } } as SyncedChange)).toBe("applied");
      expect(library.getHighlightThreadIds(book.id, highlight.id)).toEqual([remote]);
      expect(apply({ entityType: "thread", operation: "tombstone", deviceId, deviceRevision: 2, entityId: remote })).toBe("applied");
      expect(library.getHighlightThreadIds(book.id, highlight.id)).toEqual([]);
      expect(library.getBookContents(book.id)!.highlights).toHaveLength(1);
      library.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("importing on a second synced installation", () => {
  const document = {
    formatVersion: 1 as const,
    books: [{ providerRecordId: "file:///mnt/onboard/glass.epub", title: "The Glass Orchard", authors: ["Imogen Vale"] }],
    annotations: [
      { providerRecordId: "kobo-mark-1", bookProviderRecordId: "file:///mnt/onboard/glass.epub", text: "Every pane held a different season.", location: "/chapter/1", createdAt: 1700000000000, note: "A note from Kobo." },
      { providerRecordId: "kobo-note-1", bookProviderRecordId: "file:///mnt/onboard/glass.epub", note: "A standalone Kobo note." },
    ],
  };
  const source = { id: "11111111-1111-4111-8111-111111111111", name: "My Kobo" };
  const laptopSource = { id: "22222222-2222-4222-8222-222222222222", name: "My Kobo on laptop" };
  it("reattaches reviewed synced books and exact annotations without changing their IDs or notes", () => {
    const first = new LocalLibrary(":memory:"), laptop = new LocalLibrary(":memory:");
    try {
      first.importDocument({ document, source, provider: "kobo", fileName: "KoboReader.sqlite", warnings: [] });
      laptop.bootstrapSync({ generation: 1, afterSequence: 0 });
      let sequence = 0;
      for (const { change } of first.resolvePendingSyncChanges().changes) {
        laptop.applyIncomingSyncedChange({ change, sequence: sequence + 1, expectedCursor: { generation: 1, afterSequence: sequence }, nextCursor: { generation: 1, afterSequence: ++sequence } });
      }
      expect(laptop.listImportSources("kobo")).toEqual([]);
      const book = laptop.listBooks()[0]!;
      const original = laptop.getBookContents(book.id)!;
      const review = laptop.reviewImportBooks(document, "kobo");
      expect(review).toMatchObject([{ providerRecordId: document.books[0]!.providerRecordId, candidates: [{ bookId: book.id }], links: [] }]);
      const input = { document, source: laptopSource, provider: "kobo" as const, fileName: "KoboReader.sqlite", warnings: [], bookSelections: [{ providerRecordId: document.books[0]!.providerRecordId, bookId: book.id }] };
      expect(laptop.importDocument(input)).toMatchObject({ booksCreated: 0, booksReused: 1, highlightsCreated: 0, notesCreated: 0 });
      expect(laptop.listBooks()).toHaveLength(1);
      expect(laptop.getBookContents(book.id)).toEqual(original);
      expect(laptop.importDocument({ ...input, bookSelections: undefined })).toMatchObject({ booksCreated: 0, highlightsCreated: 0, notesCreated: 0 });
      const extra = { ...document.annotations[0]!, providerRecordId: "kobo-mark-2", text: "A newly highlighted sentence.", note: undefined };
      expect(laptop.importDocument({ ...input, document: { ...document, annotations: [...document.annotations, extra] } })).toMatchObject({ booksCreated: 0, highlightsCreated: 1, notesCreated: 0 });
      const passage = laptop.getBookContents(book.id)!.highlights[0]!;
      laptop.updateHighlight({ id: passage.id, bookId: book.id, expectedRevision: passage.revision, text: "My local correction." });
      expect(laptop.importDocument({ ...input, document: { ...document, annotations: [{ ...document.annotations[0]!, text: "Changed on Kobo." }, document.annotations[1]!] } })).toMatchObject({ conflictsCreated: 1, highlightsCreated: 0 });
      expect(laptop.getBookContents(book.id)!.highlights.find((item) => item.id === passage.id)?.text).toBe("My local correction.");
    } finally { first.close(); laptop.close(); }
  });
  it("keeps ambiguous editions explicit and permits an intentional separate copy", () => {
    const library = new LocalLibrary(":memory:");
    try {
      const first = library.createBook({ title: document.books[0]!.title, authors: ["Imogen Vale"] });
      library.createBook({ title: document.books[0]!.title, authors: ["Imogen Vale"] });
      expect(library.reviewImportBooks(document, "kobo")[0]?.candidates).toHaveLength(2);
      expect(library.importDocument({ document, source, provider: "kobo", fileName: "KoboReader.sqlite", warnings: [], bookSelections: [{ providerRecordId: document.books[0]!.providerRecordId, bookId: null }] })).toMatchObject({ booksCreated: 1, booksReused: 0 });
      expect(library.listBooks()).toHaveLength(3);
      expect(() => library.importDocument({ document, source: laptopSource, provider: "kobo", fileName: "KoboReader.sqlite", warnings: [], bookSelections: [{ providerRecordId: "unknown", bookId: first.id }] })).toThrow(/selection/u);
    } finally { library.close(); }
  });
});

it("keeps a local location edit when an identical source quotation and date reconnect on another source", () => {
  const library = new LocalLibrary(":memory:");
  try {
    const document = { formatVersion: 1 as const, books: [{ providerRecordId: "book", title: "A book", authors: ["A Reader"] }], annotations: [{ providerRecordId: "mark", bookProviderRecordId: "book", text: "A passage with a stable source timestamp.", createdAt: 1700000000000, location: "/old-location" }] };
    library.importDocument({ document, provider: "kobo", fileName: "KoboReader.sqlite", source: { id: "11111111-1111-4111-8111-111111111111", name: "Kobo" }, warnings: [] });
    const book = library.listBooks()[0]!;
    const original = library.getBookContents(book.id)!;
    const changed = { ...document, annotations: [{ ...document.annotations[0]!, location: "Chapter one · 10%" }] };
    const input = { document: changed, provider: "kobo" as const, fileName: "KoboReader.sqlite", source: { id: "22222222-2222-4222-8222-222222222222", name: "Same Kobo" }, warnings: [], bookSelections: [{ providerRecordId: "book", bookId: book.id }] };
    expect(library.importDocument(input)).toMatchObject({ booksCreated: 0, highlightsCreated: 0 });
    expect(library.getBookContents(book.id)).toEqual(original);
    expect(library.importDocument({ ...input, document: { ...changed, annotations: [{ ...changed.annotations[0]!, text: "Changed later on the source." }] } })).toMatchObject({ conflictsCreated: 1 });
    expect(library.getBookContents(book.id)).toEqual(original);
  } finally { library.close(); }
});
