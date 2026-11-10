import type { LibraryRepository, LibrarySyncSnapshot, ReadingStatusEvent } from "@leaflogue/contracts";

type SnapshotRepository = Pick<
  LibraryRepository,
  "getBookContents" | "getBookOrganization" | "iterateReadingStatusHistory" | "listBooks" | "listCollections" |
  "listDailySelections" | "listTags" | "listThreadHighlightMemberships" | "listThreads" | "readSnapshot"
>;

const MAX_STATUS_EVENTS_PER_FULL_SNAPSHOT = 100_000;

/** Build a credential-free provider-neutral payload for a required full sync. */
export function createLibrarySyncSnapshot(
  repository: SnapshotRepository,
  generatedAt = Date.now(),
): LibrarySyncSnapshot {
  if (!Number.isSafeInteger(generatedAt) || generatedAt < 0) {
    throw new Error("Sync snapshot timestamp is invalid");
  }
  return repository.readSnapshot(() => {
    let statusEventCount = 0;
    const books = repository.listBooks({ includeArchived: true }).map((book) => {
      const contents = repository.getBookContents(book.id);
      const organization = repository.getBookOrganization(book.id);
      if (!contents || !organization || contents.book.revision !== book.revision) {
        throw new Error("Library changed while its sync snapshot was being created");
      }
      const readingStatusHistory: ReadingStatusEvent[] = [];
      for (const event of repository.iterateReadingStatusHistory(book.id)) {
        statusEventCount += 1;
        if (statusEventCount > MAX_STATUS_EVENTS_PER_FULL_SNAPSHOT) {
          throw new Error("Sync snapshot contains too many reading status events");
        }
        readingStatusHistory.push(event);
      }
      return { contents, organization, readingStatusHistory };
    });
    for (const { contents } of books) {
      if (repository.getBookContents(contents.book.id)?.book.revision !== contents.book.revision) {
        throw new Error("Library changed while its sync snapshot was being created");
      }
    }
    const threads = repository.listThreads();
    const threadHighlightMemberships = repository.listThreadHighlightMemberships();
    const dailySelections = repository.listDailySelections();
    const finalThreads = repository.listThreads();
    if (JSON.stringify(finalThreads.map(({ id, revision }) => [id, revision])) !==
        JSON.stringify(threads.map(({ id, revision }) => [id, revision]))) {
      throw new Error("Library changed while its sync snapshot was being created");
    }
    return {
      format: "leaflogue-sync-snapshot",
      formatVersion: 2,
      generatedAt,
      books,
      collections: repository.listCollections(),
      tags: repository.listTags(),
      threads,
      threadHighlightMemberships,
      dailySelections,
    };
  });
}
