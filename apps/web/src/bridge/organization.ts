import type {
  BookId,
  BookOrganization,
  Collection,
  CollectionId,
  DailySelection,
  DailySelectionId,
  LeaflogueBridge,
  Tag,
  TagId,
  Thread,
  ThreadId,
  ThreadMembershipReceipt,
} from "@leaflogue/contracts";
import { BackendError } from "../transport/transport";
import { newId, type LibraryClient } from "./client";
import { passageNotes, toCollection, toTag, toThread, type WireCollection, type WirePassage, type WireShelfBook, type WireTag, type WireThread, type WireThreadDetails } from "./wire";

export function createOrganization(client: LibraryClient): LeaflogueBridge["organization"] {
  // The library page asks for every book's organization at once; requests
  // made together share one read of the shelf instead of one each.
  let shelf: Promise<ReadonlyMap<string, WireShelfBook>> | undefined;
  function shelfBooks(): Promise<ReadonlyMap<string, WireShelfBook>> {
    if (shelf) return shelf;
    const current = client.query<WireShelfBook[]>("browse:books").then((books) => new Map(books.map((book) => [book.id, book])));
    shelf = current;
    const forget = () => { if (shelf === current) shelf = undefined; };
    current.then(forget, forget);
    return current;
  }

  /**
   * A book's collections and tags. Its passages' tags are left out: each
   * passage already carries its own (see getBookContents), and reading them
   * here would mean paging through every passage of every book.
   */
  function organizationOf(bookId: BookId, book: WireShelfBook): BookOrganization {
    return { bookId, collectionIds: book.collectionIds, tagIds: book.tagIds, highlightTags: [] };
  }

  async function readBook(bookId: BookId): Promise<BookOrganization | undefined> {
    const book = await client.query<WireShelfBook | null>("browse:book", { bookId });
    return book ? organizationOf(bookId, book) : undefined;
  }

  async function getBook(bookId: BookId): Promise<BookOrganization | undefined> {
    // Archived books are not on the shelf, so they are read on their own.
    const book = (await shelfBooks()).get(bookId);
    return book ? organizationOf(bookId, book) : readBook(bookId);
  }

  async function refreshed(bookId: BookId): Promise<BookOrganization> {
    const organization = await readBook(bookId);
    if (!organization) throw new BackendError("That book is no longer in your library.", "LEAFLOGUE_NOT_FOUND");
    return organization;
  }

  return {
    listCollections: async () => (await client.query<WireCollection[]>("browse:collections")).map(toCollection),
    listTags: async () => (await client.query<WireTag[]>("browse:tags")).map(toTag),
    getBook,
    createCollection: (input) => client.mutation<Collection>("organizationRuntime:createCollection", { id: newId<CollectionId>(), ...input }),
    updateCollection: (input) => client.mutation<Collection>("organizationRuntime:updateCollection", { ...input }),
    deleteCollection: async (input) => { await client.mutation("organizationRuntime:deleteCollection", { ...input }); },
    createTag: (input) => client.mutation<Tag>("organizationRuntime:createTag", { id: newId<TagId>(), ...input }),
    updateTag: (input) => client.mutation<Tag>("organizationRuntime:updateTag", { ...input }),
    deleteTag: async (input) => { await client.mutation("organizationRuntime:deleteTag", { ...input }); },
    async setBookCollection(input) {
      await client.mutation("organizationRuntime:setBookCollectionMembership", { ...input });
      return refreshed(input.bookId);
    },
    async setBookTag(input) {
      await client.mutation("organizationRuntime:setBookTagMembership", { ...input });
      return refreshed(input.bookId);
    },
    async setHighlightTag(input) {
      await client.mutation("organizationRuntime:setHighlightTagMembership", { ...input });
      return refreshed(input.bookId);
    },
  };
}

export function createThreads(client: LibraryClient): LeaflogueBridge["threads"] {
  return {
    list: async () => (await client.query<WireThread[]>("browse:threads")).map(toThread),
    async get(id) {
      const thread = await client.query<WireThreadDetails | null>("browse:thread", { threadId: id });
      if (!thread) return undefined;
      return {
        thread: toThread(thread),
        passages: thread.passages.map((passage) => ({
          highlightId: passage.id,
          bookId: passage.bookId,
          bookTitle: passage.bookTitle,
          authors: passage.bookAuthors,
          text: passage.text,
          ...(passage.sourceLocation !== undefined ? { sourceLocation: passage.sourceLocation } : {}),
          notes: passageNotes(passage),
          addedAt: passage.addedAt,
        })),
      };
    },
    async getHighlightMembership(_bookId, highlightId) {
      const memberships = await client.query<{ readonly threadIds: readonly ThreadId[] }>("browse:highlightMemberships", { highlightId });
      return memberships.threadIds;
    },
    create: (input) => client.mutation<Thread>("threadRuntime:createThread", { id: newId<ThreadId>(), ...input }),
    update: (input) => client.mutation<Thread>("threadRuntime:updateThread", { ...input }),
    delete: async (input) => { await client.mutation("threadRuntime:deleteThread", { ...input }); },
    setHighlightMembership: (input) => client.mutation<ThreadMembershipReceipt>("threadRuntime:setHighlightThreadMembership", { ...input }),
  };
}

export function createDaily(client: LibraryClient): LeaflogueBridge["daily"] {
  const ensure: LeaflogueBridge["daily"]["ensure"] = async ({ timezone, another }) => {
    const selection = await client.mutation<DailySelection>("dailyRuntime:ensureDailySelection", {
      id: newId<DailySelectionId>(),
      timezone,
      ...(another ? { another: true } : {}),
    });
    if (!selection.highlightId) return undefined;
    const passage = await client.query<WirePassage | null>("browse:highlight", { highlightId: selection.highlightId });
    if (!passage) return undefined;
    return {
      selection,
      passage: {
        highlightId: passage.id,
        bookId: passage.bookId,
        bookTitle: passage.bookTitle,
        authors: passage.bookAuthors,
        text: passage.text,
        ...(passage.sourceLocation !== undefined ? { sourceLocation: passage.sourceLocation } : {}),
        notes: passageNotes(passage),
      },
      // The backend does not say whether another passage could be chosen.
      hasAlternatives: true,
    };
  };
  return {
    // There is no read-only lookup on the backend; ensuring today's pick is
    // idempotent, so the first visit of the day makes it.
    get: (timezone) => ensure({ timezone }),
    ensure,
  };
}
