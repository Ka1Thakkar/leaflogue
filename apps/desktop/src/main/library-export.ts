import type {
  LibraryExportDocument,
  LibraryRepository,
} from "@leaflogue/contracts";
import { closeSync, fsyncSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

const MAX_EXPORT_BYTES = 256 * 1024 * 1024;

type ExportRepository = Pick<LibraryRepository,
  "getBookContents" | "getBookOrganization" | "iterateReadingStatusHistory" | "listBooks" | "listCollections" |
  "listDailySelections" | "listTags" | "listThreadHighlightMemberships" | "listThreads" | "readSnapshot"
>;

export function createLibraryExport(
  repository: ExportRepository,
  exportedAt = new Date(),
): LibraryExportDocument {
  return repository.readSnapshot(() => {
    const books = repository.listBooks({ includeArchived: true }).map((book) => {
      const contents = repository.getBookContents(book.id);
      if (!contents || contents.book.revision !== book.revision) {
        throw new Error("Library changed while it was being exported");
      }
      return contents;
    });
    const organizations = books.map(({ book }) => {
      const organization = repository.getBookOrganization(book.id);
      if (!organization) throw new Error("Library changed while it was being exported");
      return organization;
    });

    const threads = repository.listThreads();
    const document: LibraryExportDocument = {
      format: "leaflogue-library",
      formatVersion: 4,
      exportedAt: exportedAt.toISOString(),
      books,
      collections: repository.listCollections(),
      tags: repository.listTags(),
      organizations,
      readingStatusEvents: books.flatMap(({ book }) => [...repository.iterateReadingStatusHistory(book.id)]),
      threads,
      threadHighlightMemberships: repository.listThreadHighlightMemberships(),
      dailySelections: repository.listDailySelections(),
    };
    assertBookRevisionsUnchanged(repository, books.map(({ book }) => book));
    assertThreadRevisionsUnchanged(repository, threads);
    return document;
  });
}

export function countLibraryExport(document: LibraryExportDocument): {
  readonly booksExported: number;
  readonly highlightsExported: number;
  readonly notesExported: number;
} {
  return document.books.reduce(
    (counts, contents) => ({
      booksExported: counts.booksExported + 1,
      highlightsExported: counts.highlightsExported + contents.highlights.length,
      notesExported:
        counts.notesExported +
        contents.standaloneNotes.length +
        contents.highlights.reduce((total, highlight) => total + highlight.notes.length, 0),
    }),
    { booksExported: 0, highlightsExported: 0, notesExported: 0 },
  );
}

export function assertSafeExportDestination(path: string, liveLibraryPath: string): void {
  const destination = canonicalPath(path);
  const livePath = canonicalPath(liveLibraryPath);
  if ([livePath, `${livePath}-wal`, `${livePath}-shm`].includes(destination)) {
    throw new Error("Choose a location outside Leaflogue's live library");
  }
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return join(realpathSync(dirname(resolved)), basename(resolved));
  }
}

export function writeLibraryExport(
  path: string,
  repository: ExportRepository,
  exportedAt = new Date(),
  byteLimit = MAX_EXPORT_BYTES,
): ReturnType<typeof countLibraryExport> {
  return repository.readSnapshot(() => writeLibraryExportSnapshot(path, repository, exportedAt, byteLimit));
}

function writeLibraryExportSnapshot(
  path: string,
  repository: Omit<ExportRepository, "readSnapshot">,
  exportedAt: Date,
  byteLimit: number,
): ReturnType<typeof countLibraryExport> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let bytesWritten = 0;
  const counts = { booksExported: 0, highlightsExported: 0, notesExported: 0 };
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    const writeChunk = (chunk: string): void => {
      bytesWritten += Buffer.byteLength(chunk, "utf8");
      if (bytesWritten > byteLimit) throw new Error("Library export exceeds the 256 MiB limit");
      writeFileSync(descriptor!, chunk, "utf8");
    };
    writeChunk(`{"format":"leaflogue-library","formatVersion":4,"exportedAt":${JSON.stringify(exportedAt.toISOString())},"books":[`);
    const books = repository.listBooks({ includeArchived: true });
    const threads = repository.listThreads();
    books.forEach((book, bookIndex) => {
      const contents = repository.getBookContents(book.id);
      if (!contents) throw new Error("Library changed while it was being exported");
      if (bookIndex > 0) writeChunk(",");
      writeChunk(`{"book":${JSON.stringify(contents.book)},"highlights":[`);
      contents.highlights.forEach((highlight, highlightIndex) => {
        if (highlightIndex > 0) writeChunk(",");
        const { notes, ...highlightFields } = highlight;
        writeChunk(`${JSON.stringify(highlightFields).slice(0, -1)},"notes":[`);
        notes.forEach((note, noteIndex) => {
          if (noteIndex > 0) writeChunk(",");
          writeChunk(JSON.stringify(note));
          counts.notesExported += 1;
        });
        writeChunk("]}");
        counts.highlightsExported += 1;
      });
      writeChunk(`],"standaloneNotes":[`);
      contents.standaloneNotes.forEach((note, noteIndex) => {
        if (noteIndex > 0) writeChunk(",");
        writeChunk(JSON.stringify(note));
        counts.notesExported += 1;
      });
      writeChunk("]}");
      counts.booksExported += 1;
    });
    writeChunk(`],"collections":${JSON.stringify(repository.listCollections())},"tags":${JSON.stringify(repository.listTags())},"organizations":[`);
    books.forEach((book, bookIndex) => {
      const organization = repository.getBookOrganization(book.id);
      if (!organization) throw new Error("Library changed while it was being exported");
      if (bookIndex > 0) writeChunk(",");
      writeChunk(JSON.stringify(organization));
    });
    writeChunk(`],"readingStatusEvents":[`);
    let statusEventIndex = 0;
    books.forEach((book) => {
      for (const event of repository.iterateReadingStatusHistory(book.id)) {
        if (statusEventIndex > 0) writeChunk(",");
        writeChunk(JSON.stringify(event));
        statusEventIndex += 1;
      }
    });
    assertBookRevisionsUnchanged(repository, books);
    writeChunk(`],"threads":${JSON.stringify(threads)},"threadHighlightMemberships":${JSON.stringify(repository.listThreadHighlightMemberships())},"dailySelections":${JSON.stringify(repository.listDailySelections())}}\n`);
    assertThreadRevisionsUnchanged(repository, threads);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    return counts;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function assertThreadRevisionsUnchanged(
  repository: Pick<LibraryRepository, "listThreads">,
  threads: ReturnType<LibraryRepository["listThreads"]>,
): void {
  const final = repository.listThreads();
  if (final.length !== threads.length || final.some((thread, index) =>
    thread.id !== threads[index]?.id || thread.revision !== threads[index]?.revision)) {
    throw new Error("Library changed while it was being exported");
  }
}

function assertBookRevisionsUnchanged(
  repository: Pick<LibraryRepository, "getBookContents">,
  books: ReturnType<LibraryRepository["listBooks"]>,
): void {
  for (const book of books) {
    if (repository.getBookContents(book.id)?.book.revision !== book.revision) {
      throw new Error("Library changed while it was being exported");
    }
  }
}
