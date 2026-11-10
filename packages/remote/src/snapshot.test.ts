import { describe, expect, it } from "vitest";
import type { BookContents, BookId, BookOrganization, ReadingStatusEvent } from "@leaflogue/contracts";
import { createLibrarySyncSnapshot } from "./snapshot";

const bookId = "10000000-0000-4000-8000-000000000000" as BookId;
const contents: BookContents = {
  book: {
    id: bookId,
    title: "Piranesi",
    authors: ["Susanna Clarke"],
    status: "finished",
    completedOn: "2024-02-29",
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    revision: 3,
    highlightCount: 0,
  },
  highlights: [],
  standaloneNotes: [],
};
const organization: BookOrganization = { bookId, collectionIds: [], tagIds: [], highlightTags: [] };
const history: readonly ReadingStatusEvent[] = [{
  id: "20000000-0000-4000-8000-000000000000" as never,
  bookId,
  status: "finished",
  completedOn: "2024-02-29",
  source: "reader",
  changedAt: 2,
  bookRevision: 3,
}];
const thread = { id: "30000000-0000-4000-8000-000000000000" as never, name: "Home", passageCount: 1, createdAt: 1, updatedAt: 2, revision: 1 };
const membership = { threadId: thread.id, highlightId: "40000000-0000-4000-8000-000000000000" as never, addedAt: 2 };
const dailySelection = { id: "50000000-0000-4000-8000-000000000000" as never, localDay: "2026-09-23", timezone: "UTC", highlightId: membership.highlightId, candidateDigest: "a".repeat(64), recentHighlightIds: [membership.highlightId], selectedAt: 2, updatedAt: 2, revision: 1 };

function repository(overrides: Partial<{
  readonly contents: BookContents;
  readonly organization: BookOrganization;
}> = {}) {
  const selectedContents = overrides.contents ?? contents;
  const selectedOrganization = overrides.organization ?? organization;
  return {
    readSnapshot: <T>(read: () => T): T => read(),
    listBooks: () => [contents.book],
    getBookContents: () => selectedContents,
    getBookOrganization: () => selectedOrganization,
    iterateReadingStatusHistory: () => history.values(),
    listCollections: () => [],
    listTags: () => [],
    listThreads: () => [thread],
    listThreadHighlightMemberships: () => [membership],
    listDailySelections: () => [dailySelection],
  };
}

describe("provider-neutral sync snapshots", () => {
  it("includes the complete status timeline beside each book snapshot", () => {
    const snapshot = createLibrarySyncSnapshot(repository(), 10);
    expect(snapshot).toEqual({
      format: "leaflogue-sync-snapshot",
      formatVersion: 2,
      generatedAt: 10,
      books: [{ contents, organization, readingStatusHistory: history }],
      collections: [],
      tags: [],
      threads: [thread],
      threadHighlightMemberships: [membership],
      dailySelections: [dailySelection],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/credential|databaseUrl|deviceId/iu);
  });

  it("fails closed when the book projection changes during assembly", () => {
    expect(() => createLibrarySyncSnapshot(repository({
      contents: { ...contents, book: { ...contents.book, revision: 4 } },
    }))).toThrow(/changed while its sync snapshot/u);
    expect(() => createLibrarySyncSnapshot(repository(), -1)).toThrow(/timestamp is invalid/u);
  });

  it("fails closed if status history advances the book during assembly", () => {
    let revision = contents.book.revision;
    expect(() => createLibrarySyncSnapshot({
      ...repository(),
      getBookContents: () => ({ ...contents, book: { ...contents.book, revision } }),
      iterateReadingStatusHistory: function* () {
        yield history[0]!;
        revision += 1;
      },
    })).toThrow(/changed while its sync snapshot/u);
  });

  it("rejects a full snapshot above the bounded status-event limit", () => {
    expect(() => createLibrarySyncSnapshot({
      ...repository(),
      iterateReadingStatusHistory: function* () {
        for (let index = 0; index < 100_001; index += 1) yield history[0]!;
      },
    })).toThrow(/too many reading status events/u);
  });
});
