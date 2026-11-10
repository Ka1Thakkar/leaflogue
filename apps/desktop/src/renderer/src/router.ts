import { useSyncExternalStore } from "react";
import type { BookId, CollectionId, HighlightId, TagId, ThreadId } from "@leaflogue/contracts";

/**
 * In-document routes. Hash navigation never leaves the packaged page, so the
 * main process's navigation denial stays absolute while destinations remain
 * ordinary links with history, focus, and "open" semantics.
 */
export type Route =
  | { readonly name: "library"; readonly collectionId?: CollectionId; readonly tagId?: TagId }
  | { readonly name: "book"; readonly bookId: BookId; readonly highlightId?: HighlightId; readonly mergeWith?: BookId }
  | { readonly name: "highlights"; readonly search?: string; readonly tagId?: TagId; readonly bookId?: BookId }
  | { readonly name: "threads" }
  | { readonly name: "thread"; readonly threadId: ThreadId }
  | { readonly name: "statistics" }
  | { readonly name: "settings" }
  | { readonly name: "import" }
  | { readonly name: "conflicts" }
  | { readonly name: "sync-conflicts" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/u, "").split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "library" && parts[1] && UUID.test(parts[1])) {
    const params = new URLSearchParams(query);
    const highlightId = params.get("highlight");
    const mergeWith = params.get("merge");
    return {
      name: "book",
      bookId: parts[1] as BookId,
      ...(highlightId && UUID.test(highlightId) ? { highlightId: highlightId as HighlightId } : {}),
      ...(mergeWith && UUID.test(mergeWith) && mergeWith !== parts[1] ? { mergeWith: mergeWith as BookId } : {}),
    };
  }
  if (parts[0] === "highlights") {
    const params = new URLSearchParams(query);
    const search = params.get("q")?.trim().slice(0, 200);
    const tagId = params.get("tag");
    const bookId = params.get("book");
    return {
      name: "highlights",
      ...(search ? { search } : {}),
      ...(tagId && UUID.test(tagId) ? { tagId: tagId as TagId } : {}),
      ...(bookId && UUID.test(bookId) ? { bookId: bookId as BookId } : {}),
    };
  }
  if (parts[0] === "threads" && parts[1] && UUID.test(parts[1])) return { name: "thread", threadId: parts[1] as ThreadId };
  if (parts[0] === "threads") return { name: "threads" };
  if (parts[0] === "statistics") return { name: "statistics" };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "import" && parts[1] === "conflicts") return { name: "conflicts" };
  if (parts[0] === "import") return { name: "import" };
  if (parts[0] === "sync" && parts[1] === "conflicts") return { name: "sync-conflicts" };
  if (parts[0] === "library") {
    const params = new URLSearchParams(query);
    const collectionId = params.get("collection");
    const tagId = params.get("tag");
    return {
      name: "library",
      ...(collectionId && UUID.test(collectionId) ? { collectionId: collectionId as CollectionId } : {}),
      ...(tagId && UUID.test(tagId) ? { tagId: tagId as TagId } : {}),
    };
  }
  return { name: "library" };
}

export const href = {
  /** The library, optionally showing one collection's or tag's books. */
  library: (filter?: { readonly collectionId?: CollectionId; readonly tagId?: TagId }) => {
    const params = new URLSearchParams();
    if (filter?.collectionId) params.set("collection", filter.collectionId);
    if (filter?.tagId) params.set("tag", filter.tagId);
    const query = params.toString();
    return `#/library${query ? `?${query}` : ""}`;
  },
  book: (bookId: BookId, highlightId?: HighlightId) => `#/library/${bookId}${highlightId ? `?highlight=${highlightId}` : ""}`,
  /** A book page with its merge panel open on another copy. */
  mergeBooks: (bookId: BookId, otherId: BookId) => `#/library/${bookId}?merge=${otherId}`,
  /** Highlights, optionally opened on a search for these words, or narrowed to a tag or a book. */
  highlights: (search?: string, filter?: { readonly tagId?: TagId; readonly bookId?: BookId }) => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (filter?.tagId) params.set("tag", filter.tagId);
    if (filter?.bookId) params.set("book", filter.bookId);
    const query = params.toString().replace(/\+/gu, "%20");
    return `#/highlights${query ? `?${query}` : ""}`;
  },
  threads: () => "#/threads",
  thread: (threadId: ThreadId) => `#/threads/${threadId}`,
  statistics: () => "#/statistics",
  settings: () => "#/settings",
  import: () => "#/import",
  conflicts: () => "#/import/conflicts",
  syncConflicts: () => "#/sync/conflicts",
};

export function navigate(target: string): void {
  window.location.hash = target;
}

let navigationBlocker: (() => boolean) | undefined;

/** Register the one page-level guard allowed to veto in-document navigation. */
export function setNavigationBlocker(blocker: (() => boolean) | undefined): () => void {
  navigationBlocker = blocker;
  return () => {
    if (navigationBlocker === blocker) navigationBlocker = undefined;
  };
}

function subscribe(listener: () => void): () => void {
  let acceptedHash = window.location.hash;
  const guardedListener = () => {
    if (navigationBlocker && !navigationBlocker()) {
      window.history.replaceState(null, "", acceptedHash || "#/");
      return;
    }
    acceptedHash = window.location.hash;
    listener();
  };
  window.addEventListener("hashchange", guardedListener);
  return () => window.removeEventListener("hashchange", guardedListener);
}

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash, () => "");
}
