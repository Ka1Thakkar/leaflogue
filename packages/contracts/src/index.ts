export type EntityId<Kind extends string> = string & { readonly __kind: Kind };

export type BookId = EntityId<"book">;
export type HighlightId = EntityId<"highlight">;
export type NoteId = EntityId<"note">;
export type CollectionId = EntityId<"collection">;
export type TagId = EntityId<"tag">;
export type ThreadId = EntityId<"thread">;
export type DailySelectionId = EntityId<"daily-selection">;
export type ReadingStatusEventId = EntityId<"reading-status-event">;
export type ImportConflictId = EntityId<"import-conflict">;
export type SyncConflictId = EntityId<"sync-conflict">;

export type ReadingStatus = "unread" | "reading" | "finished" | "paused";

/** Stable provider-neutral key for case-insensitive collection and tag names. */
export function normalizeOrganizationName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export interface FeatureFlags {
  readonly ai: boolean;
  readonly metadata: boolean;
  readonly sync: boolean;
}

/** Where the interface runs: the desktop app, or the web app over a hosted backend. */
export type SystemHost =
  | { readonly kind: "desktop" }
  | {
    readonly kind: "web";
    readonly backend: "convex" | "server";
    readonly account?: string;
    /** On Convex, the deployment the reader chose. */
    readonly deployment?: string;
    /**
     * Whether readers may build, import, and share custom widgets. Off unless
     * whoever deploys the web app adds widget support and switches it on.
     */
    readonly customWidgets?: boolean;
  };

export interface SystemCapabilities {
  /** Absent in the desktop app. */
  readonly host?: SystemHost;
  readonly appVersion: string;
  readonly databaseSchemaVersion: number;
  readonly features: FeatureFlags;
  readonly persistenceAvailable: boolean;
  readonly setupRequired: boolean;
  readonly platform: "linux" | "darwin" | "win32";
  readonly storagePaths: {
    readonly configFile: string;
    readonly libraryFile: string;
    readonly cacheDirectory: string;
    readonly stateDirectory: string;
  };
}

export interface Book {
  readonly id: BookId;
  readonly title: string;
  readonly authors: readonly string[];
  readonly description?: string;
  readonly publisher?: string;
  readonly series?: string;
  readonly seriesNumber?: string;
  readonly language?: string;
  readonly isbn13?: string;
  readonly coverUrl?: string;
  readonly status: ReadingStatus;
  readonly completedOn?: string;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
  readonly highlightCount: number;
}

export interface CatalogBook {
  readonly provider: "google-books" | "open-library";
  /** The provider's own ID for the record. */
  readonly providerId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly isbn13?: string;
  readonly description?: string;
  readonly publisher?: string;
  readonly language?: string;
  readonly coverUrl?: string;
}

export interface CatalogSearch {
  readonly items: readonly CatalogBook[];
  readonly source: "google-books" | "open-library";
}

export interface NewBook {
  readonly title: string;
  readonly authors?: readonly string[];
  readonly isbn13?: string;
}

/**
 * Online creation receives the stable client-generated ID so a later sync
 * adapter can replay the same operation without inventing a second book.
 */
export interface CreateBook extends NewBook {
  readonly id: BookId;
}

export interface NewHighlight {
  readonly bookId: BookId;
  readonly text: string;
  readonly sourceLocation?: string;
  /** Optional reader note created atomically with the passage. */
  readonly noteMarkdown?: string;
}

export interface UpdateHighlight {
  readonly id: HighlightId;
  readonly bookId: BookId;
  readonly text: string;
  readonly sourceLocation?: string;
  readonly expectedRevision: number;
}

export interface NewNote {
  readonly bookId: BookId;
  readonly highlightId?: HighlightId;
  readonly markdown: string;
  /**
   * Who wrote it. Defaults to the reader. Only an importer writes "import",
   * so it is not offered here: an imported note has an original to reset to,
   * and a note created through this contract has none.
   */
  readonly origin?: "reader" | "ai";
}

export interface UpdateNote {
  readonly id: NoteId;
  readonly bookId: BookId;
  readonly markdown: string;
  readonly expectedRevision: number;
}

/** Bibliographic fields a reader can edit; each is also a resettable field. */
export type BookMetadataField = "title" | "authors" | "description" | "publisher" | "series" | "seriesNumber" | "language" | "isbn13" | "coverUrl";

/**
 * Replace a book's bibliographic metadata as one revision-checked edit. An
 * omitted optional field is cleared. Reading status, archive state, and
 * passages are unaffected.
 */
export interface UpdateBookMetadata {
  readonly id: BookId;
  readonly expectedRevision: number;
  readonly title: string;
  readonly authors: readonly string[];
  readonly description?: string;
  readonly publisher?: string;
  readonly series?: string;
  readonly seriesNumber?: string;
  readonly language?: string;
  readonly isbn13?: string;
  readonly coverUrl?: string;
}

/** The latest values an import source supplied for a book, for field reset. */
export interface BookMetadataSource {
  readonly sourceName: string;
  readonly lastSeenAt: number;
  readonly values: {
    readonly title: string;
    readonly authors: readonly string[];
    readonly description?: string;
    readonly publisher?: string;
    readonly series?: string;
    readonly seriesNumber?: string;
    readonly language?: string;
    readonly isbn13?: string;
    readonly coverUrl?: string;
  };
}

/** The latest version an import source supplied for a passage. */
export interface HighlightSource {
  readonly sourceName: string;
  readonly text: string;
  readonly location?: string;
  readonly note?: string;
  /** Whether the passage or its imported note currently differs from it. */
  readonly differs: boolean;
  /** Opaque binding to the source and attached-note state the reader reviewed. */
  readonly resetToken: string;
}

export interface ResetHighlightToSource {
  readonly id: HighlightId;
  readonly bookId: BookId;
  readonly expectedRevision: number;
  readonly resetToken: string;
}

/**
 * Deleting a passage records a synced tombstone rather than erasing the row.
 * Its notes are tombstoned with it, and its thread and tag memberships are
 * removed; re-importing its source never restores it.
 */
export interface DeleteHighlight {
  readonly id: HighlightId;
  readonly bookId: BookId;
  readonly expectedRevision: number;
}

export interface DeleteNote {
  readonly id: NoteId;
  readonly bookId: BookId;
  readonly expectedRevision: number;
}

export interface AnnotationDeletionReceipt {
  readonly bookId: BookId;
  readonly bookRevision: number;
  /** The tombstoned entity's revision. */
  readonly revision: number;
  readonly notesDeleted: number;
  /**
   * Whether every attached note is now tombstoned. A passage created by this
   * application cannot exceed the active-note bound, so this is always true for
   * SQLite and PostgreSQL, which delete in one transaction. A passage that
   * predates the bound is drained in batches on Convex, where one transaction
   * cannot read unbounded rows; the caller repeats the deletion until this
   * reports true rather than being refused outright.
   */
  readonly complete: boolean;
}

export interface SetBookArchived {
  readonly id: BookId;
  readonly archived: boolean;
  readonly expectedRevision: number;
}

export interface BookArchiveChange {
  readonly bookId: BookId;
  readonly archived: boolean;
  readonly revision: number;
  readonly updatedAt: number;
}

/**
 * Where a status change came from. This is synced, so it is a fixed list and
 * deliberately not tied to `ImportProvider`: imports set a book's status
 * directly and never add events, so newer import providers do not appear here.
 */
export type ReadingStatusSource = "reader" | "merge" | "kindle" | "kobo" | "portable";

export interface ReadingStatusEvent {
  readonly id: ReadingStatusEventId;
  readonly bookId: BookId;
  readonly status: ReadingStatus;
  readonly source: ReadingStatusSource;
  readonly changedAt: number;
  readonly completedOn?: string;
  readonly bookRevision: number;
}

export interface SetBookReadingStatus {
  readonly id: BookId;
  readonly status: ReadingStatus;
  readonly expectedRevision: number;
}

export interface SetBookCompletionDate {
  readonly id: BookId;
  readonly completedOn?: string;
  readonly expectedRevision: number;
}

export interface BookReadingStatusChange {
  readonly changed: boolean;
  readonly book: Book;
  readonly event?: ReadingStatusEvent;
}

export interface ReadingStatusHistoryPage {
  readonly events: readonly ReadingStatusEvent[];
  readonly hasMore: boolean;
}

export interface Thread {
  readonly id: ThreadId;
  readonly name: string;
  readonly description?: string;
  readonly passageCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface NewThread {
  readonly name: string;
  readonly description?: string;
}

export interface CreateThread extends NewThread {
  readonly id: ThreadId;
}

export interface UpdateThread extends NewThread {
  readonly id: ThreadId;
  readonly expectedRevision: number;
}

export interface DeleteThread {
  readonly id: ThreadId;
  readonly expectedRevision: number;
}

export interface ThreadPassage {
  readonly highlightId: HighlightId;
  readonly bookId: BookId;
  readonly bookTitle: string;
  readonly authors: readonly string[];
  readonly text: string;
  readonly sourceLocation?: string;
  readonly notes: readonly Note[];
  readonly addedAt: number;
}

export interface ThreadDetails {
  readonly thread: Thread;
  readonly passages: readonly ThreadPassage[];
}

export interface ThreadHighlightMembership {
  readonly threadId: ThreadId;
  readonly highlightId: HighlightId;
  readonly addedAt: number;
}

export interface SetHighlightThreadMembership {
  readonly bookId: BookId;
  readonly highlightId: HighlightId;
  readonly threadIds: readonly ThreadId[];
  readonly expectedHighlightRevision: number;
}

export interface ThreadMembershipReceipt {
  readonly changed: boolean;
  readonly bookId: BookId;
  readonly highlightId: HighlightId;
  readonly highlightRevision: number;
  readonly threadIds: readonly ThreadId[];
}

export interface DailySelection {
  readonly id: DailySelectionId;
  readonly localDay: string;
  readonly timezone: string;
  readonly highlightId?: HighlightId;
  readonly candidateDigest: string;
  readonly recentHighlightIds: readonly HighlightId[];
  readonly selectedAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface DailyPassage {
  readonly highlightId: HighlightId;
  readonly bookId: BookId;
  readonly bookTitle: string;
  readonly authors: readonly string[];
  readonly text: string;
  readonly sourceLocation?: string;
  readonly notes: readonly Note[];
}

export interface DailyHighlight {
  readonly selection: DailySelection;
  readonly passage: DailyPassage;
  readonly hasAlternatives: boolean;
}

export interface EnsureDailyHighlight {
  readonly timezone: string;
  readonly another?: boolean;
}

export interface EnsureDailySelection extends EnsureDailyHighlight {
  readonly id: DailySelectionId;
}

export interface MergeBooks {
  readonly sourceBookId: BookId;
  readonly targetBookId: BookId;
  readonly expectedSourceRevision: number;
  readonly expectedTargetRevision: number;
}

export interface MergeBooksReceipt {
  readonly sourceBookId: BookId;
  readonly targetBookId: BookId;
  readonly highlightsMoved: number;
  readonly notesMoved: number;
  readonly sourceRevision: number;
  readonly targetRevision: number;
}

export interface Note {
  readonly id: NoteId;
  readonly bookId: BookId;
  readonly highlightId?: HighlightId;
  readonly markdown: string;
  readonly origin: "reader" | "import" | "ai";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface Highlight {
  readonly id: HighlightId;
  readonly bookId: BookId;
  readonly text: string;
  readonly sourceLocation?: string;
  readonly sourceCreatedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
  readonly notes: readonly Note[];
}

export interface BookContents {
  readonly book: Book;
  readonly highlights: readonly Highlight[];
  readonly standaloneNotes: readonly Note[];
}

export const MAX_HIGHLIGHT_PAGE = 100;
export const MAX_HIGHLIGHT_SEARCH_LENGTH = 200;
/** Shared active-note bound that keeps provider mutations predictably atomic. */
export const MAX_NOTES_PER_HIGHLIGHT = 200;
/** UTF-8 body ceiling that keeps the worst valid Convex note cascade bounded. */
export const MAX_NOTE_BYTES = 24 * 1024;

/**
 * The device ID recorded for edits made in a web client, on every backend.
 * Sync orders writers by revision and breaks ties by device ID, so when the
 * web and a desktop edit the same thing from the same starting point, the
 * desktop's edit wins and the web's is kept as a reviewable conflict.
 */
export const WEB_DEVICE_ID = "00000000-0000-4000-8000-000000000001";

/**
 * A bounded, read-only passage query shared by the book workspace and the
 * cross-book Highlights destination. Date bounds are half-open epoch
 * milliseconds so the caller decides which local day they represent.
 */
export interface HighlightQuery {
  readonly bookId?: BookId;
  readonly search?: string;
  readonly source?: "imported" | "manual";
  readonly notes?: "with" | "without";
  readonly tagId?: TagId;
  readonly dateKind?: "created" | "imported";
  readonly dateFrom?: number;
  readonly dateBefore?: number;
  /** `relevance` is an internal search mode and requires a non-empty search. */
  readonly sort?: "oldest" | "newest" | "updated" | "relevance";
  readonly offset?: number;
  readonly limit?: number;
}

export interface HighlightListEntry extends Highlight {
  readonly bookTitle: string;
  readonly authors: readonly string[];
  readonly imported: boolean;
  readonly tagIds: readonly TagId[];
}

export interface HighlightPage {
  readonly entries: readonly HighlightListEntry[];
  readonly hasMore: boolean;
}

export interface Collection {
  readonly id: CollectionId;
  readonly name: string;
  readonly description?: string;
  readonly bookCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface Tag {
  readonly id: TagId;
  readonly name: string;
  readonly color?: string;
  readonly bookCount: number;
  readonly highlightCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface BookOrganization {
  readonly bookId: BookId;
  readonly collectionIds: readonly CollectionId[];
  readonly tagIds: readonly TagId[];
  readonly highlightTags: readonly {
    readonly highlightId: HighlightId;
    readonly tagIds: readonly TagId[];
  }[];
}

export interface NewCollection {
  readonly name: string;
  readonly description?: string;
}

export interface CreateCollection extends NewCollection {
  readonly id: CollectionId;
}

export interface NewTag {
  readonly name: string;
  readonly color?: string;
}

export interface CreateTag extends NewTag {
  readonly id: TagId;
}

export interface UpdateCollection extends NewCollection {
  readonly id: CollectionId;
  readonly expectedRevision: number;
}

export interface UpdateTag extends NewTag {
  readonly id: TagId;
  readonly expectedRevision: number;
}

export interface DeleteCollection {
  readonly id: CollectionId;
  readonly expectedRevision: number;
}

export interface DeleteTag {
  readonly id: TagId;
  readonly expectedRevision: number;
}

export interface SetBookCollectionMembership {
  readonly bookId: BookId;
  readonly collectionId: CollectionId;
  readonly included: boolean;
}

export interface SetBookTagMembership {
  readonly bookId: BookId;
  readonly tagId: TagId;
  readonly included: boolean;
}

export interface SetHighlightTagMembership {
  readonly bookId: BookId;
  readonly highlightId: HighlightId;
  readonly tagId: TagId;
  readonly included: boolean;
}

export interface OrganizationMembershipReceipt {
  readonly changed: boolean;
  readonly included: boolean;
  readonly bookId: BookId;
  readonly bookRevision: number;
  readonly containerId: CollectionId | TagId;
  readonly containerRevision: number;
  readonly highlightId?: HighlightId;
}

export interface LibraryRepository {
  /** Run related reads against one coherent repository snapshot. */
  readSnapshot<T>(read: () => T): T;
  createBook(input: NewBook): Book;
  updateBookMetadata(input: UpdateBookMetadata): Book;
  getBook(id: BookId): Book | undefined;
  getBookContents(id: BookId): BookContents | undefined;
  listHighlights(query: HighlightQuery): HighlightPage;
  listBooks(options?: { readonly includeArchived?: boolean }): readonly Book[];
  createHighlight(input: NewHighlight): Highlight;
  updateHighlight(input: UpdateHighlight): Highlight;
  createNote(input: NewNote): Note;
  updateNote(input: UpdateNote): Note;
  deleteHighlight(input: DeleteHighlight): AnnotationDeletionReceipt;
  deleteNote(input: DeleteNote): AnnotationDeletionReceipt;
  setBookArchived(input: SetBookArchived): BookArchiveChange;
  iterateReadingStatusHistory(id: BookId): Iterable<ReadingStatusEvent>;
  listReadingStatusHistory(id: BookId, options?: { readonly limit?: number }): readonly ReadingStatusEvent[];
  setBookReadingStatus(input: SetBookReadingStatus): BookReadingStatusChange;
  setBookCompletionDate(input: SetBookCompletionDate): Book;
  listThreads(): readonly Thread[];
  listThreadHighlightMemberships(): readonly ThreadHighlightMembership[];
  getThread(id: ThreadId): ThreadDetails | undefined;
  getHighlightThreadIds(bookId: BookId, highlightId: HighlightId): readonly ThreadId[];
  createThread(input: NewThread): Thread;
  updateThread(input: UpdateThread): Thread;
  deleteThread(input: DeleteThread): void;
  setHighlightThreadMembership(input: SetHighlightThreadMembership): ThreadMembershipReceipt;
  listDailySelections(): readonly DailySelection[];
  getDailyHighlight(timezone: string): DailyHighlight | undefined;
  ensureDailyHighlight(input: EnsureDailyHighlight): DailyHighlight | undefined;
  mergeBooks(input: MergeBooks): MergeBooksReceipt;
  listCollections(): readonly Collection[];
  listTags(): readonly Tag[];
  getBookOrganization(id: BookId): BookOrganization | undefined;
  createCollection(input: NewCollection): Collection;
  updateCollection(input: UpdateCollection): Collection;
  deleteCollection(input: DeleteCollection): void;
  createTag(input: NewTag): Tag;
  updateTag(input: UpdateTag): Tag;
  deleteTag(input: DeleteTag): void;
  setBookCollectionMembership(input: SetBookCollectionMembership): BookOrganization;
  setBookTagMembership(input: SetBookTagMembership): BookOrganization;
  setHighlightTagMembership(input: SetHighlightTagMembership): BookOrganization;
}

export type HighlightMutationResult = Omit<Highlight, "notes">;

export interface OnlineLibraryMutations {
  createBook(input: CreateBook): Promise<Book>;
  updateBookMetadata(input: UpdateBookMetadata): Promise<Book>;
  createHighlight(input: NewHighlight): Promise<HighlightMutationResult>;
  updateHighlight(input: UpdateHighlight): Promise<HighlightMutationResult>;
  createNote(input: NewNote): Promise<Note>;
  updateNote(input: UpdateNote): Promise<Note>;
  deleteHighlight(input: DeleteHighlight): Promise<AnnotationDeletionReceipt>;
  deleteNote(input: DeleteNote): Promise<AnnotationDeletionReceipt>;
  setBookArchived(input: SetBookArchived): Promise<BookArchiveChange>;
  setBookReadingStatus(input: SetBookReadingStatus): Promise<BookReadingStatusChange>;
  setBookCompletionDate(input: SetBookCompletionDate): Promise<Book>;
  mergeBooks(input: MergeBooks): Promise<MergeBooksReceipt>;
}

export interface OnlineOrganizationMutations {
  createCollection(input: CreateCollection): Promise<Collection>;
  updateCollection(input: UpdateCollection): Promise<Collection>;
  deleteCollection(input: DeleteCollection): Promise<void>;
  createTag(input: CreateTag): Promise<Tag>;
  updateTag(input: UpdateTag): Promise<Tag>;
  deleteTag(input: DeleteTag): Promise<void>;
  setBookCollectionMembership(input: SetBookCollectionMembership): Promise<OrganizationMembershipReceipt>;
  setBookTagMembership(input: SetBookTagMembership): Promise<OrganizationMembershipReceipt>;
  setHighlightTagMembership(input: SetHighlightTagMembership): Promise<OrganizationMembershipReceipt>;
}

export interface OnlineThreadMutations {
  createThread(input: CreateThread): Promise<Thread>;
  updateThread(input: UpdateThread): Promise<Thread>;
  deleteThread(input: DeleteThread): Promise<void>;
  setHighlightThreadMembership(input: SetHighlightThreadMembership): Promise<ThreadMembershipReceipt>;
}

export interface OnlineDailySelectionMutations {
  ensureDailySelection(input: EnsureDailySelection): Promise<DailySelection>;
}

/** Books and passages carry their complete organization membership sets.
 * Membership changes advance both the owning container and member revision, so
 * links never need unstable composite change identifiers and a fresh replica
 * can reconstruct them without a separate change stream.
 */
export type SyncEntityType = "book" | "highlight" | "note" | "collection" | "tag" | "thread" | "daily-selection";
export type SyncOperation = "upsert" | "tombstone";
export const MAX_SYNC_CHANGE_PAGE = 100;
/** Keeps one owner snapshot bounded while still allowing unusually rich organization. */
export const MAX_SYNC_ORGANIZATION_MEMBERSHIPS = 1_000;
/** Reading-status events kept per book on every provider, so a book snapshot stays bounded. */
export const MAX_STATUS_EVENTS_PER_BOOK = 1_000;
/** Wire and replay bound: headroom for events several devices added concurrently. */
export const MAX_SYNCED_STATUS_EVENTS_PER_BOOK = 2 * MAX_STATUS_EVENTS_PER_BOOK;
/** A passage belongs to at most this many threads on every provider. */
export const MAX_THREADS_PER_HIGHLIGHT = 20;

/** A remote change cursor is valid only within its library generation. */
export interface SyncCursor {
  readonly generation: number;
  readonly afterSequence: number;
  /** Provider-issued identity of sequence zero or the last consumed change. */
  readonly checkpoint?: string;
}

/**
 * A stable outbox operation identity is `${deviceId}:${sequence}`. Providers
 * must acknowledge it idempotently; they must never infer acknowledgement from
 * an entity revision alone.
 */
export interface SyncOutboxEntry {
  readonly sequence: number;
  readonly deviceId: string;
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly revision: number;
  readonly operation: SyncOperation;
  readonly createdAt: number;
}

export interface SyncChange {
  readonly sequence: number;
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly revision: number;
  readonly changedAt: number;
  /** Provider-issued identity of this exact history position. */
  readonly checkpoint?: string;
}

export interface SyncChangePage {
  readonly changes: readonly SyncChange[];
  readonly nextCursor: SyncCursor;
  readonly isDone: boolean;
  readonly resetRequired: boolean;
}

/**
 * One change another device made, replayed into a provider. This is deliberately
 * not the interactive mutation shape: those are guarded by `expectedRevision`
 * against the row the provider holds, which is right for a single writer and
 * wrong for a replay, where `deviceRevision` counts only the sending device's
 * edits. See ADR 0005.
 */
export interface SyncedBookUpsert {
  readonly entityType: "book";
  readonly operation: "upsert";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly book: Book;
  readonly collectionIds: readonly CollectionId[];
  readonly tagIds: readonly TagId[];
  /**
   * The book's complete reading-status history, oldest first. Events are an
   * immutable, grow-only set keyed by ID: receivers merge them even when this
   * change loses to a concurrent one, and only a winning snapshot may move an
   * existing event to this book (as after a merge). Absent only from an older
   * provider that cannot store history.
   */
  readonly statusEvents?: readonly ReadingStatusEvent[];
}

export interface SyncedBookTombstone {
  readonly entityType: "book";
  readonly operation: "tombstone";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly entityId: BookId;
}

export interface SyncedHighlightUpsert {
  readonly entityType: "highlight";
  readonly operation: "upsert";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly highlight: HighlightMutationResult;
  readonly tagIds: readonly TagId[];
  /**
   * Complete thread membership; a thread never owns or deletes its passages.
   * Absent only from an older provider that cannot store threads, in which
   * case the receiver keeps the thread links it already has.
   */
  readonly threadIds?: readonly ThreadId[];
}

export interface SyncedHighlightTombstone {
  readonly entityType: "highlight";
  readonly operation: "tombstone";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly entityId: HighlightId;
  readonly bookId: BookId;
}

export interface SyncedNoteUpsert {
  readonly entityType: "note";
  readonly operation: "upsert";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly note: Note;
}

export interface SyncedNoteTombstone {
  readonly entityType: "note";
  readonly operation: "tombstone";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly entityId: NoteId;
  readonly bookId: BookId;
}

export interface SyncedCollectionUpsert {
  readonly entityType: "collection";
  readonly operation: "upsert";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly collection: Collection;
}

export interface SyncedCollectionTombstone {
  readonly entityType: "collection";
  readonly operation: "tombstone";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly entityId: CollectionId;
}

export interface SyncedTagUpsert {
  readonly entityType: "tag";
  readonly operation: "upsert";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly tag: Tag;
}

export interface SyncedTagTombstone {
  readonly entityType: "tag";
  readonly operation: "tombstone";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly entityId: TagId;
}

export interface SyncedThreadUpsert {
  readonly entityType: "thread";
  readonly operation: "upsert";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly thread: Thread;
}

export interface SyncedThreadTombstone {
  readonly entityType: "thread";
  readonly operation: "tombstone";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly entityId: ThreadId;
}

/**
 * A daily pick as it syncs. `createdAt` is set once when the pick is first
 * made and never changes, so every node decides a same-day collision the same
 * way regardless of the order it saw the two picks.
 */
export interface SyncedDailySelection extends DailySelection {
  readonly createdAt: number;
}

export interface SyncedDailySelectionUpsert {
  readonly entityType: "daily-selection";
  readonly operation: "upsert";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly dailySelection: SyncedDailySelection;
}

/** A pick retired because another pick for the same day and time zone won. */
export interface SyncedDailySelectionTombstone {
  readonly entityType: "daily-selection";
  readonly operation: "tombstone";
  readonly deviceId: string;
  readonly deviceRevision: number;
  readonly entityId: DailySelectionId;
}

/**
 * Whether `candidate` keeps a (day, time zone) slot against `other`: the
 * earlier `createdAt` wins, then the lower ID. Both fields are immutable.
 */
export function dailySelectionWins(
  candidate: { readonly id: string; readonly createdAt: number },
  other: { readonly id: string; readonly createdAt: number },
): boolean {
  return candidate.createdAt < other.createdAt || (candidate.createdAt === other.createdAt && candidate.id < other.id);
}

export type SyncedChange = SyncedBookUpsert | SyncedBookTombstone |
  SyncedHighlightUpsert | SyncedHighlightTombstone | SyncedNoteUpsert | SyncedNoteTombstone |
  SyncedCollectionUpsert | SyncedCollectionTombstone | SyncedTagUpsert | SyncedTagTombstone |
  SyncedThreadUpsert | SyncedThreadTombstone | SyncedDailySelectionUpsert | SyncedDailySelectionTombstone;

/**
 * Whether a replayed change took effect. "superseded" is an ordinary outcome,
 * not a failure: a delivery that arrives twice, or after a change that already
 * won the entity, leaves the provider as it found it.
 */
export type SyncedChangeOutcome = "applied" | "superseded";

/**
 * One transmission resolved from the outbox at send time (ADR 0005). `change`
 * carries the entity's current local state; `entries` are the pending outbox
 * operations it discharges once the provider accepts it. A parent sent ahead of
 * a child whose state now references it carries no entries: its own entries are
 * still pending and will be resent, harmlessly, when they reach the front.
 */
export interface ResolvedSyncChange {
  readonly change: SyncedChange;
  readonly entries: readonly SyncOutboxEntry[];
}

/**
 * A bounded page of the outbox, resolved against current local state.
 * `superseded` entries belong to entities whose current state was written by a
 * winning incoming change after them; the provider already holds that winner,
 * any losing passage or note body was preserved locally when it arrived, and
 * there is no local state left that these entries could send.
 */
export interface ResolvedSyncBatch {
  readonly changes: readonly ResolvedSyncChange[];
  readonly superseded: readonly SyncOutboxEntry[];
  readonly hasMore: boolean;
}

export interface SyncAcknowledgement {
  readonly operationIds: readonly string[];
}

export interface SyncBookSnapshot {
  readonly contents: BookContents;
  readonly organization: BookOrganization;
  readonly readingStatusHistory: readonly ReadingStatusEvent[];
}

export interface LibrarySyncSnapshot {
  readonly format: "leaflogue-sync-snapshot";
  readonly formatVersion: 2;
  readonly generatedAt: number;
  readonly books: readonly SyncBookSnapshot[];
  readonly collections: readonly Collection[];
  readonly tags: readonly Tag[];
  readonly threads: readonly Thread[];
  readonly threadHighlightMemberships: readonly ThreadHighlightMembership[];
  readonly dailySelections: readonly DailySelection[];
}

export function syncOperationId(entry: Pick<SyncOutboxEntry, "deviceId" | "sequence">): string {
  if (!isCanonicalUuid(entry.deviceId) || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
    throw new Error("Sync operation identity is invalid");
  }
  return `${entry.deviceId}:${entry.sequence}`;
}

/** Reject acknowledgements that could discard an operation the adapter did not send. */
export function assertSyncAcknowledgement(
  submitted: readonly SyncOutboxEntry[],
  acknowledgement: SyncAcknowledgement,
): void {
  if (!Array.isArray(acknowledgement.operationIds) || acknowledgement.operationIds.length > submitted.length ||
      submitted.length > MAX_SYNC_CHANGE_PAGE) {
    throw new Error("Sync acknowledgement is invalid");
  }
  const submittedIds = new Set(submitted.map(syncOperationId));
  const acknowledged = new Set<string>();
  for (const operationId of acknowledgement.operationIds) {
    if (typeof operationId !== "string" || !submittedIds.has(operationId) || acknowledged.has(operationId)) {
      throw new Error("Sync acknowledgement is invalid");
    }
    acknowledged.add(operationId);
  }
}

/** Reject malformed or non-monotonic server pages before they reach local state. */
export function assertSyncChangePage(cursor: SyncCursor, page: SyncChangePage): void {
  assertSyncCursor(cursor);
  assertSyncCursor(page.nextCursor);
  if (typeof page.isDone !== "boolean" || typeof page.resetRequired !== "boolean") {
    throw new Error("Sync page flags are invalid");
  }
  if (page.resetRequired) {
    if (page.changes.length !== 0 || page.nextCursor.afterSequence !== 0 || page.isDone) {
      throw new Error("Sync reset page is invalid");
    }
    return;
  }
  if (page.changes.length > MAX_SYNC_CHANGE_PAGE) throw new Error("Sync page exceeds its limit");
  if (page.nextCursor.generation !== cursor.generation) throw new Error("Sync generation changed without reset");
  if (!page.isDone && page.changes.length === 0) throw new Error("Sync page made no progress");
  let previous = cursor.afterSequence;
  for (const change of page.changes) {
    if (!Number.isSafeInteger(change.sequence) || change.sequence <= previous ||
        !Number.isSafeInteger(change.revision) || change.revision < 1 ||
        !Number.isSafeInteger(change.changedAt) || change.changedAt < 0 ||
        !["book", "highlight", "note", "collection", "tag", "thread", "daily-selection"].includes(change.entityType) || !isUuid(change.entityId) ||
        (change.checkpoint !== undefined && !isCanonicalUuid(change.checkpoint))) {
      throw new Error("Sync change is invalid");
    }
    previous = change.sequence;
  }
  if (page.nextCursor.afterSequence !== previous) throw new Error("Sync page cursor does not match its changes");
  const finalCheckpoint = page.changes.at(-1)?.checkpoint ?? cursor.checkpoint;
  if (page.nextCursor.checkpoint !== finalCheckpoint) throw new Error("Sync page checkpoint does not match its changes");
}

function assertSyncCursor(cursor: SyncCursor): void {
  if (!Number.isSafeInteger(cursor.generation) || cursor.generation < 1 ||
      !Number.isSafeInteger(cursor.afterSequence) || cursor.afterSequence < 0 ||
      (cursor.checkpoint !== undefined && !isCanonicalUuid(cursor.checkpoint))) {
    throw new Error("Sync cursor is invalid");
  }
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export interface ImportBook {
  readonly providerRecordId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly isbn13?: string;
  readonly description?: string;
  readonly publisher?: string;
  readonly series?: string;
  readonly seriesNumber?: string;
  readonly language?: string;
  readonly status?: Exclude<ReadingStatus, "paused">;
}

export interface ImportAnnotation {
  readonly providerRecordId: string;
  readonly bookProviderRecordId: string;
  readonly text?: string;
  readonly note?: string;
  readonly location?: string;
  readonly createdAt?: number;
}

export interface ImportDocument {
  readonly formatVersion: 1;
  readonly books: readonly ImportBook[];
  readonly annotations: readonly ImportAnnotation[];
}

export interface ImportWarning {
  readonly code: "ambiguous-note" | "missing-book" | "skipped-records";
  readonly message: string;
  readonly providerRecordId?: string;
}

export interface ImportPreview {
  readonly document: ImportDocument;
  readonly warnings: readonly ImportWarning[];
}

export type ImportProvider = "kindle" | "kobo" | "koreader" | "pocketbook" | "tolino" | "boox" | "portable";

export interface ImportSourceProfile {
  readonly id: string;
  readonly provider: ImportProvider;
  readonly name: string;
  readonly lastImportedAt: number;
}

export interface ImportBookMatch {
  readonly providerRecordId: string;
  readonly candidates: readonly { readonly bookId: BookId; readonly title: string; readonly authors: readonly string[]; readonly archived: boolean }[];
  readonly links: readonly { readonly sourceId: string; readonly bookId: BookId }[];
}
export interface ImportBookSelection { readonly providerRecordId: string; readonly bookId: BookId | null }

export interface PendingImport {
  readonly token: string;
  readonly fileName: string;
  readonly provider: ImportProvider;
  readonly preview: ImportPreview;
  readonly sourceProfiles: readonly ImportSourceProfile[];
  readonly newSourceId: string;
  readonly bookMatches?: readonly ImportBookMatch[];
  readonly suggestedSourceId?: string;
  readonly suggestedSourceName: string;
}

export interface CommitImport {
  readonly bookSelections?: readonly ImportBookSelection[];
  readonly token: string;
  readonly sourceId: string;
  readonly newSourceName?: string;
}

export interface ImportConflict {
  readonly id: ImportConflictId;
  readonly sourceName: string;
  readonly bookTitle: string;
  readonly kind: "highlight" | "note";
  readonly base: ImportAnnotation;
  readonly local: ImportAnnotation;
  readonly incoming: ImportAnnotation;
  readonly createdAt: number;
}

export interface ResolveImportConflict {
  readonly id: ImportConflictId;
  readonly resolution: "keep-local" | "use-incoming";
}

/**
 * A passage or note body that lost a sync race and was kept rather than
 * discarded (ADR 0005). It names what the reader wrote and what the library
 * holds now; device identities and revisions stay in the main process.
 */
export interface SyncConflict {
  readonly id: SyncConflictId;
  readonly kind: "highlight" | "note";
  readonly bookId: BookId;
  /** Absent when the book itself is no longer in the library. */
  readonly bookTitle?: string;
  /** The body that did not win. */
  readonly preservedBody: string;
  /** Whether the preserved body was written on this installation. */
  readonly preservedOnThisDevice: boolean;
  /** What the library holds now; a deletion won when this is absent. */
  readonly currentBody?: string;
  /** The passage a note belongs to, for context, when it still exists. */
  readonly passageText?: string;
  /**
   * Restoring `copy` always creates a new local item and never overwrites the
   * winner. `unavailable` means its book is archived or gone.
   */
  readonly restore: "copy" | "unavailable";
  /** Binds a resolution to the current state shown beside the preserved body. */
  readonly currentRevision: number;
  readonly createdAt: number;
}

export interface SyncConflictPage {
  readonly conflicts: readonly SyncConflict[];
  readonly total: number;
}

export const MAX_SYNC_CONFLICT_PAGE = 100;

export interface ResolveSyncConflict {
  readonly id: SyncConflictId;
  readonly resolution: "restore" | "discard";
  readonly expectedRevision: number;
}

export interface ImportReceipt {
  readonly booksCreated: number;
  readonly booksReused: number;
  readonly highlightsCreated: number;
  readonly annotationsUpdated: number;
  readonly notesCreated: number;
  readonly conflictsCreated: number;
}

export interface BackupReceipt {
  readonly fileName: string;
}

/** Result of a manual update check (ADR 0007). */
export type UpdateStatus =
  | {
      readonly state: "unavailable";
      readonly currentVersion: string;
      /** development: an unpackaged build; not-appimage: the tarball; unconfigured: no trusted key; flatpak: Flathub updates it. */
      readonly reason: "development" | "not-appimage" | "unconfigured" | "flatpak" | "unsupported-installation";
    }
  | { readonly state: "up-to-date"; readonly currentVersion: string }
  | {
      readonly state: "available";
      readonly currentVersion: string;
      readonly version: string;
      readonly releasedAt: string;
      readonly notesUrl: string;
    }
  | { readonly state: "failed"; readonly currentVersion: string; readonly problem: "network" | "verification" };

export interface UpdateSettings {
  /** Check once shortly after launch and then daily; off unless turned on. */
  readonly automaticCheck: boolean;
  /** A verified newer version found by the last check, if any. */
  readonly availableVersion?: string;
}

/** The two pages whose overview the reader can rearrange. */
export const DASHBOARD_IDS = ["library", "statistics"] as const;
export type DashboardId = (typeof DASHBOARD_IDS)[number];

/**
 * Every widget either dashboard can show. Tiles are the small numbered cards;
 * the rest are panels. Any widget can go on either dashboard.
 */
export const DASHBOARD_TILE_IDS = ["passages", "notes", "books", "finished", "active-days", "longest-run", "busiest-day"] as const;
export const DASHBOARD_PANEL_IDS = ["activity", "top-books", "top-authors", "months", "weekdays", "coverage", "lengths", "finished-years", "series", "daily", "on-this-day", "reading-now", "hours", "recent", "pick-up"] as const;
export const DASHBOARD_WIDGET_IDS = [...DASHBOARD_TILE_IDS, ...DASHBOARD_PANEL_IDS] as const;
export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number];

/** How much of the row a panel takes. Tiles always take one sixth. */
export const DASHBOARD_WIDTHS = ["third", "half", "two-thirds", "full"] as const;
export type DashboardWidth = (typeof DASHBOARD_WIDTHS)[number];

/**
 * Where the library page's own list of books sits among its widgets: those
 * placed after it show below the books. Only the library layout has it.
 */
export const DASHBOARD_SHELF = "shelf";

/** A reader-built widget placed on a dashboard: `custom:` and its definition's ID. */
export type CustomWidgetSlot = `custom:${string}`;
export const CUSTOM_WIDGET_PREFIX = "custom:";
export const isCustomWidgetSlot = (widget: string): widget is CustomWidgetSlot => widget.startsWith(CUSTOM_WIDGET_PREFIX);
export const customWidgetSlot = (id: string): CustomWidgetSlot => `custom:${id}`;
export const customWidgetId = (slot: CustomWidgetSlot): string => slot.slice(CUSTOM_WIDGET_PREFIX.length);

/** Anything a dashboard can show besides the library's books. */
export type DashboardItemId = DashboardWidgetId | CustomWidgetSlot;
export type DashboardSlotId = DashboardItemId | typeof DASHBOARD_SHELF;

export interface DashboardPlacement {
  readonly widget: DashboardSlotId;
  /** Panels only; a tile ignores it. */
  readonly width?: DashboardWidth;
  /** Panels only: spans two rows so shorter panels can stack beside it. */
  readonly tall?: boolean;
}

/** A dashboard left out uses Leaflogue's default layout. */
export interface DashboardLayouts {
  readonly library?: readonly DashboardPlacement[];
  readonly statistics?: readonly DashboardPlacement[];
  /** The reader's own widgets, which either page may place as `custom:<id>`. */
  readonly widgets?: readonly CustomWidget[];
  /** Why a saved layout or widget in the config file was not used. */
  readonly problem?: string;
}

/*
 * Custom widgets. A widget is a recipe, never code: what to count, how to
 * group and filter it, and which chart to draw. The same recipe is stored in
 * the settings file, shared as a `.leaflogue-widget.json` file, and evaluated
 * by `evaluateWidget` in `@leaflogue/domain`. Version 1 is a stable format:
 * later versions may add to it, and a recipe that validates today keeps
 * working.
 */
export const CUSTOM_WIDGET_VERSION = 1;
export const CUSTOM_WIDGET_FILE_FORMAT = "leaflogue-widget";
export const CUSTOM_WIDGET_FILE_EXTENSION = ".leaflogue-widget.json";

/** What a widget counts. */
export const WIDGET_COUNTS = ["passages", "books", "notes"] as const;
export type WidgetCount = (typeof WIDGET_COUNTS)[number];

/** How a widget draws its count. */
export const WIDGET_CHARTS = ["number", "bars", "ranked", "heatmap", "list"] as const;
export type WidgetChart = (typeof WIDGET_CHARTS)[number];

/** Fields of a passage (the time and length fields also apply to notes). */
export const WIDGET_PASSAGE_FIELDS = ["length", "hour", "weekday", "month", "year", "has-note", "tag", "thread"] as const;
/** Fields of a book, also usable for the passages and notes in it. */
export const WIDGET_BOOK_FIELDS = ["book", "author", "series", "publisher", "language", "status", "finished-year"] as const;
export const WIDGET_FIELDS = [...WIDGET_PASSAGE_FIELDS, ...WIDGET_BOOK_FIELDS] as const;
export type WidgetField = (typeof WIDGET_FIELDS)[number];

/** The fields each count can be grouped and filtered by. */
export const WIDGET_FIELDS_BY_COUNT: Readonly<Record<WidgetCount, readonly WidgetField[]>> = {
  passages: WIDGET_FIELDS,
  notes: ["length", "hour", "weekday", "month", "year", ...WIDGET_BOOK_FIELDS],
  books: WIDGET_BOOK_FIELDS,
};

/** Groups by size, largest first (`count`), or in their own order: hours, weekdays, years, names A to Z (`label`). */
export const WIDGET_SORTS = ["count", "label"] as const;
export type WidgetSort = (typeof WIDGET_SORTS)[number];

export const WIDGET_LIMITS = {
  /** Custom widgets kept in the settings file. */
  widgets: 24,
  /** Characters in an ID. */
  id: 48,
  title: 60,
  description: 160,
  filters: 6,
  /** Characters in one filter value. */
  value: 100,
  /** Groups or items one widget shows. */
  shown: 50,
  /** A widget file is small; anything bigger is not a widget. */
  fileBytes: 16 * 1024,
  /** Files read by one import. */
  importFiles: 20,
  /** Recipes evaluated by one request. */
  evaluate: 48,
} as const;

/** Keep only what matches: the field `is` a value, or `isNot`. */
export type WidgetFilter =
  | { readonly field: WidgetField; readonly is: string }
  | { readonly field: WidgetField; readonly isNot: string };

export interface CustomWidget {
  /** Lowercase letters, digits and dashes; unique among the reader's widgets. */
  readonly id: string;
  readonly version: typeof CUSTOM_WIDGET_VERSION;
  readonly title: string;
  /** One line for the list of widgets to add. */
  readonly description?: string;
  readonly count: WidgetCount;
  /** Required by `bars` and `ranked`; the other charts take none. */
  readonly groupBy?: WidgetField;
  readonly where?: readonly WidgetFilter[];
  readonly show: WidgetChart;
  /** Groups or items to show, 1 to 50. Not used by `number` or `heatmap`. */
  readonly limit?: number;
  /** `bars` and `ranked` only. */
  readonly sort?: WidgetSort;
}

/** A `.leaflogue-widget.json` file: one recipe, nothing else. */
export interface CustomWidgetFile {
  readonly format: typeof CUSTOM_WIDGET_FILE_FORMAT;
  readonly widget: CustomWidget;
}

export interface WidgetGroup {
  /** Stable for the field: `mon`, `21`, `2025`, or a normalised name. */
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

export type WidgetItem =
  | { readonly kind: "passage"; readonly bookId: BookId; readonly highlightId: HighlightId; readonly title: string; readonly text: string; readonly day: string }
  | { readonly kind: "note"; readonly bookId: BookId; readonly highlightId?: HighlightId; readonly title: string; readonly text: string; readonly day: string }
  | { readonly kind: "book"; readonly bookId: BookId; readonly title: string; readonly authors: readonly string[]; readonly status: ReadingStatus };

export type WidgetResult =
  | { readonly kind: "number"; readonly value: number }
  /** `total` counts what matched; `missing` of those had no value to group by; `hidden` groups did not fit the limit. */
  | { readonly kind: "groups"; readonly groups: readonly WidgetGroup[]; readonly total: number; readonly missing: number; readonly hidden: number }
  | { readonly kind: "days"; readonly days: readonly { readonly day: string; readonly value: number }[]; readonly total: number }
  | { readonly kind: "items"; readonly items: readonly WidgetItem[]; readonly total: number };

export interface WidgetExportReceipt {
  readonly fileName: string;
  readonly title: string;
}

export interface WidgetImportReceipt {
  readonly layouts: DashboardLayouts;
  /** Titles of the widgets added. */
  readonly added: readonly string[];
  /** Files holding a widget the library already has. */
  readonly unchanged: number;
}

export interface RestoreReceipt {
  readonly fileName: string;
  readonly booksRestored: number;
  readonly databaseSchemaVersion: number;
}

export interface LibraryExportDocument {
  readonly format: "leaflogue-library";
  readonly formatVersion: 4;
  readonly exportedAt: string;
  readonly books: readonly BookContents[];
  readonly collections: readonly Collection[];
  readonly tags: readonly Tag[];
  readonly organizations: readonly BookOrganization[];
  readonly readingStatusEvents: readonly ReadingStatusEvent[];
  readonly threads: readonly Thread[];
  readonly threadHighlightMemberships: readonly ThreadHighlightMembership[];
  readonly dailySelections: readonly DailySelection[];
}

/** An e-reader mounted as a USB drive. The renderer never sees its path. */
export interface ConnectedReader {
  readonly id: string;
  readonly kind: "kobo" | "kindle" | "koreader" | "pocketbook" | "tolino" | "boox";
  /** The drive's name, e.g. "KOBOeReader". */
  readonly label: string;
}

/** Likely duplicates; suggestions only, nothing is changed automatically. */
export interface LibraryDuplicates {
  /** Active books that look like the same book, oldest first in each group. */
  readonly books: readonly { readonly bookIds: readonly BookId[]; readonly title: string }[];
  /** Passages repeated within one book, oldest first in each group. */
  readonly passages: readonly { readonly bookId: BookId; readonly highlightIds: readonly HighlightId[] }[];
}

/** Reading statistics drawn from the library itself; nothing extra is tracked. */
export interface LibraryStatistics {
  readonly totals: {
    readonly books: number;
    readonly reading: number;
    readonly finished: number;
    readonly highlights: number;
    readonly notes: number;
    readonly threads: number;
  };
  /**
   * Every year from the first finished book to this year, including empty
   * ones. Only books with a known finish date count: a completion date, or a
   * finished status the reader set in Leaflogue. An import's own timestamp is
   * when the file was read, not when the book was finished.
   */
  readonly finishedByYear: readonly { readonly year: number; readonly books: number }[];
  /** The last twelve months, oldest first, as `YYYY-MM`. */
  readonly highlightsByMonth: readonly { readonly month: string; readonly highlights: number }[];
  readonly topBooks: readonly { readonly bookId: BookId; readonly title: string; readonly highlights: number }[];
  readonly topAuthors: readonly { readonly name: string; readonly highlights: number; readonly books: number }[];
  /**
   * Passages per local calendar day (`YYYY-MM-DD`), oldest first, counting a
   * passage on the day the reader highlighted it when the device said so, or
   * else the day it was added. Days without passages are left out.
   */
  readonly days: readonly { readonly day: string; readonly highlights: number }[];
  /** Every active book with passages or notes, with what can be counted about it. */
  readonly books: readonly LibraryBookStatistics[];
  /** Series on the shelf, largest first. */
  readonly series: readonly {
    readonly name: string;
    readonly books: number;
    readonly finished: number;
    readonly highlights: number;
  }[];
  /** Passages by length in characters: up to 100, 101–300, 301–600, over 600. */
  readonly lengths: readonly [number, number, number, number];
  readonly averageLength: number;
  /** Passages with at least one note. */
  readonly highlightsWithNotes: number;
  readonly longestLength: number;
  /** How much of the library carries each kind of data, so a chart can say what it leaves out. */
  readonly coverage: {
    /** Passages whose device recorded when they were highlighted. */
    readonly highlightsDated: number;
    readonly booksWithSeries: number;
    /** Finished books counted in `finishedByYear`. */
    readonly finishedDated: number;
  };
  /**
   * Passages by the local hour (0–23) the reader highlighted them. Only
   * passages whose device recorded a time count: an import's own time is when
   * the file was read.
   */
  readonly hours: readonly number[];
  /** Dated passages highlighted on today's date in earlier years, newest year first. */
  readonly onThisDay: readonly LibraryPassageStatistic[];
  /** The passages kept most recently, newest first. */
  readonly recent: readonly LibraryPassageStatistic[];
  /** Books on the shelf being read or set aside, most recently highlighted first. */
  readonly inProgress: readonly LibraryProgressStatistic[];
}

/** One passage as a statistic shows it; the text is shortened for long passages. */
export interface LibraryPassageStatistic {
  readonly highlightId: HighlightId;
  readonly bookId: BookId;
  readonly title: string;
  readonly text: string;
  /** The local day it was highlighted, or added when the device did not say. */
  readonly day: string;
}

export interface LibraryProgressStatistic {
  readonly bookId: BookId;
  readonly title: string;
  readonly authors: readonly string[];
  readonly status: "reading" | "paused";
  readonly highlights: number;
  readonly lastDay?: string;
  readonly latest?: LibraryPassageStatistic;
}

export interface LibraryBookStatistics {
  readonly bookId: BookId;
  readonly title: string;
  readonly authors: readonly string[];
  readonly status: ReadingStatus;
  readonly series?: string;
  readonly highlights: number;
  readonly notes: number;
  /** Distinct local days with a passage from this book. */
  readonly activeDays: number;
  /** Mean passage length in characters; 0 without passages. */
  readonly averageLength: number;
  readonly firstDay?: string;
  readonly lastDay?: string;
}

export interface MarkdownExportOptions {
  readonly includeArchived: boolean;
}

export interface MarkdownExportReceipt {
  readonly folderName: string;
  readonly booksExported: number;
  readonly highlightsExported: number;
  readonly notesExported: number;
}

export interface LibraryExportReceipt {
  readonly fileName: string;
  readonly booksExported: number;
  readonly highlightsExported: number;
  readonly notesExported: number;
}

export interface RemoteConfigurationSummary {
  readonly configured: boolean;
  readonly provider?: "postgres" | "convex";
  readonly source?: "environment" | "config";
  readonly host?: string;
  readonly database?: string;
  readonly deployment?: string;
  readonly transport?: "tls" | "unspecified";
  readonly problem?: string;
  readonly previousConfigRetained?: boolean;
  /** Redacted: whether a Convex sync key is available, never its value. */
  readonly syncKeySaved?: boolean;
}

export type RemoteSetupInput =
  | {
      readonly provider: "postgres";
      readonly databaseUrl: string;
      readonly location: "default" | "choose";
    }
  | {
      readonly provider: "convex";
      /** Blank keeps the saved deployment URL. */
      readonly deploymentUrl: string;
      /** The deployment's `LEAFLOGUE_SYNC_KEY`; omitted keeps the saved key. Never returned. */
      readonly syncKey?: string;
      readonly location: "default" | "choose";
    };

export interface RemoteDatabaseStatus extends RemoteConfigurationSummary {
  readonly reachable: boolean;
  readonly initialized: boolean;
  readonly schemaVersion?: number;
}

export type SyncProblemKind = "configuration" | "schema" | "library" | "credentials" | "permission" | "unreachable" | "busy" | "stopped";

export interface SyncProblem {
  readonly phase: "connect" | "push" | "pull";
  readonly kind: SyncProblemKind;
  /** Fixed product copy only; never a provider or driver message. */
  readonly message: string;
}

export interface SyncRunCounts {
  readonly bootstrapped: number;
  readonly pushed: number;
  readonly superseded: number;
  readonly pulled: number;
}

export interface SyncMigrationProgress {
  readonly updated: number;
  readonly detached: number;
}

export interface SyncRunOptions {
  /** Confirm only the exact legacy note named by the previous review result. */
  readonly confirmDetachNoteId?: NoteId;
}

type SyncExchangeStatus = (
  | { readonly status: "complete" }
  | { readonly status: "incomplete" }
  | { readonly status: "snapshot-required" }
  | { readonly status: "unsupported-change"; readonly entityType: SyncEntityType }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly problem: SyncProblem }
);

export type SyncExchangeRunResult = SyncRunCounts & SyncExchangeStatus;

export type SyncRunResult =
  | (SyncExchangeRunResult & { readonly migration?: SyncMigrationProgress })
  | (SyncRunCounts & { readonly status: "migration-incomplete"; readonly migration: SyncMigrationProgress })
  | (SyncRunCounts & { readonly status: "migration-review-required"; readonly migration: SyncMigrationProgress & {
    readonly reviewNoteId: NoteId;
    readonly reviewReason: "oversized" | "too-many";
  } });

/**
 * Background sync as the header shows it. `off` means no sync provider is set
 * up; a finished run keeps its result, or the message it failed with.
 */
export interface SyncStatus {
  readonly state: "off" | "idle" | "syncing";
  readonly lastFinishedAt?: number;
  readonly lastResult?: SyncRunResult;
  readonly lastError?: string;
}

export interface AiProviderConfigurationSummary {
  readonly id: string;
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly selectedModel: string;
  readonly endpoint?: string;
  readonly capabilities: readonly string[];
  readonly credential: "saved" | "environment" | "missing";
  /** Whether the reader has accepted what this provider receives. */
  readonly consented: boolean;
}

export interface AiConfigurationSummary {
  readonly enabled: boolean;
  readonly selectedProvider?: string;
  readonly providers: readonly AiProviderConfigurationSummary[];
}

/** What one AI task would transmit, shown before the reader's first request. */
export interface AiTaskDisclosure {
  /** Opaque, short-lived binding for the exact provider, model, and material shown. */
  readonly disclosureId: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly model: string;
  /** True when this provider's free tier may train on what is sent. */
  readonly trainsOnFreeTier: boolean;
  /** False until the reader has accepted what this provider receives. */
  readonly consented: boolean;
  readonly bookTitle: string;
  readonly authors: readonly string[];
  /** Book details sent along so the explanation is about this book; shown in full before sending. */
  readonly series?: string;
  readonly seriesNumber?: string;
  readonly publisher?: string;
  readonly description?: string;
  readonly passage: string;
  readonly notes: readonly string[];
}

export interface ExplainPassageRequest {
  readonly requestId: string;
  /** Issued by describeExplainTask; the renderer cannot supply task material. */
  readonly disclosureId: string;
  /**
   * A follow-up question about the same passage. The opening explanation omits
   * it; follow-ups pass the conversation so far, which is only ever the
   * reader's own questions and the companion's earlier answers.
   */
  readonly followUp?: {
    readonly question: string;
    readonly history: readonly { readonly role: "reader" | "companion"; readonly text: string }[];
  };
}

export interface PassageExplanation {
  readonly providerId: string;
  readonly model: string;
  readonly explanation: string;
  /** False when the companion declined a question that was not about the passage. */
  readonly saveable?: boolean;
}

export interface AiSettingsInput {
  readonly enabled: boolean;
  readonly selectedProvider: string;
  readonly selectedModel: string;
  readonly apiKey?: string;
  readonly clearSavedApiKey?: boolean;
}

export type AppearanceMode = "light" | "dark" | "system";

export interface ThemeTokens {
  readonly paper: string;
  readonly dot: string;
  readonly ink: string;
  readonly pencil: string;
  readonly pen: string;
  readonly highlighter: string;
  readonly highlighterWash: string;
  readonly ruled: string;
  readonly ruledLine: string;
  readonly kraft: string;
  readonly kraftInk: string;
  readonly stamp: string;
  readonly hairline: string;
  readonly edge: string;
  readonly drop: string;
  readonly muted: string;
  readonly border: string;
  readonly controlBorder: string;
  /**
   * Optional: the colour of bars, activity calendars, meters, and the current
   * tab. Themes without it use `pen`. Like `pen` it marks things and never
   * carries text.
   */
  readonly chart?: string;
}

export interface ThemeDefinition {
  readonly id: string;
  readonly name: string;
  readonly light: ThemeTokens;
  readonly dark: ThemeTokens;
}

export interface AppearanceConfiguration {
  readonly themeId: string;
  readonly mode: AppearanceMode;
  readonly themes: readonly ThemeDefinition[];
  readonly problem?: string;
}

export interface ThemeExportReceipt {
  readonly fileName: string;
  readonly themeName: string;
}

export interface AppearanceSettingsInput {
  readonly themeId: string;
  readonly mode: AppearanceMode;
}

export const SYSTEM_CAPABILITIES_CHANNEL = "system:get-capabilities";
export const SYSTEM_COMPLETE_SETUP_CHANNEL = "system:complete-setup";
export const SYSTEM_OPEN_EXTERNAL_CHANNEL = "system:open-external";
export const LIBRARY_LIST_CHANNEL = "library:list-books";
export const LIBRARY_CREATE_CHANNEL = "library:create-book";
export const LIBRARY_UPDATE_METADATA_CHANNEL = "library:update-book-metadata";
export const LIBRARY_METADATA_SOURCE_CHANNEL = "library:get-metadata-source";
export const LIBRARY_GET_CONTENTS_CHANNEL = "library:get-contents";
export const LIBRARY_LIST_HIGHLIGHTS_CHANNEL = "library:list-highlights";
export const LIBRARY_CREATE_HIGHLIGHT_CHANNEL = "library:create-highlight";
export const LIBRARY_UPDATE_HIGHLIGHT_CHANNEL = "library:update-highlight";
export const LIBRARY_CREATE_NOTE_CHANNEL = "library:create-note";
export const LIBRARY_UPDATE_NOTE_CHANNEL = "library:update-note";
export const LIBRARY_DELETE_HIGHLIGHT_CHANNEL = "library:delete-highlight";
export const LIBRARY_DELETE_NOTE_CHANNEL = "library:delete-note";
export const LIBRARY_HIGHLIGHT_SOURCE_CHANNEL = "library:get-highlight-source";
export const LIBRARY_RESET_HIGHLIGHT_CHANNEL = "library:reset-highlight-to-source";
export const LIBRARY_SET_BOOK_ARCHIVED_CHANNEL = "library:set-book-archived";
export const LIBRARY_LIST_READING_STATUS_CHANNEL = "library:list-reading-status";
export const LIBRARY_SET_READING_STATUS_CHANNEL = "library:set-reading-status";
export const LIBRARY_SET_COMPLETION_DATE_CHANNEL = "library:set-completion-date";
export const LIBRARY_MERGE_BOOKS_CHANNEL = "library:merge-books";
export const ORGANIZATION_LIST_COLLECTIONS_CHANNEL = "organization:list-collections";
export const ORGANIZATION_LIST_TAGS_CHANNEL = "organization:list-tags";
export const ORGANIZATION_GET_BOOK_CHANNEL = "organization:get-book";
export const ORGANIZATION_CREATE_COLLECTION_CHANNEL = "organization:create-collection";
export const ORGANIZATION_UPDATE_COLLECTION_CHANNEL = "organization:update-collection";
export const ORGANIZATION_DELETE_COLLECTION_CHANNEL = "organization:delete-collection";
export const ORGANIZATION_CREATE_TAG_CHANNEL = "organization:create-tag";
export const ORGANIZATION_UPDATE_TAG_CHANNEL = "organization:update-tag";
export const ORGANIZATION_DELETE_TAG_CHANNEL = "organization:delete-tag";
export const ORGANIZATION_SET_BOOK_COLLECTION_CHANNEL = "organization:set-book-collection";
export const ORGANIZATION_SET_BOOK_TAG_CHANNEL = "organization:set-book-tag";
export const ORGANIZATION_SET_HIGHLIGHT_TAG_CHANNEL = "organization:set-highlight-tag";
export const THREAD_LIST_CHANNEL = "thread:list";
export const THREAD_GET_CHANNEL = "thread:get";
export const THREAD_GET_HIGHLIGHT_MEMBERSHIP_CHANNEL = "thread:get-highlight-membership";
export const THREAD_CREATE_CHANNEL = "thread:create";
export const THREAD_UPDATE_CHANNEL = "thread:update";
export const THREAD_DELETE_CHANNEL = "thread:delete";
export const THREAD_SET_HIGHLIGHT_MEMBERSHIP_CHANNEL = "thread:set-highlight-membership";
export const DAILY_GET_CHANNEL = "daily:get";
export const DAILY_ENSURE_CHANNEL = "daily:ensure";
export const IMPORT_CHOOSE_CHANNEL = "import:choose-file";
export const IMPORT_CHOOSE_FOLDER_CHANNEL = "import:choose-folder";
export const IMPORT_COMMIT_CHANNEL = "import:commit";
export const IMPORT_READERS_LIST_CHANNEL = "import:list-readers";
export const IMPORT_READER_CHOOSE_CHANNEL = "import:choose-reader";
export const IMPORT_READERS_CHANGED_CHANNEL = "import:readers-changed";
export const IMPORT_CONFLICTS_LIST_CHANNEL = "import:list-conflicts";
export const IMPORT_CONFLICT_RESOLVE_CHANNEL = "import:resolve-conflict";
export const SYNC_CONFLICTS_LIST_CHANNEL = "sync:list-conflicts";
export const SYNC_CONFLICT_RESOLVE_CHANNEL = "sync:resolve-conflict";
export const SYNC_RUN_CHANNEL = "sync:run";
export const SYNC_STATUS_CHANNEL = "sync:status";
export const SYNC_STATUS_CHANGED_CHANNEL = "sync:status-changed";
export const BACKUP_CREATE_CHANNEL = "backup:create";
export const BACKUP_RESTORE_CHANNEL = "backup:restore";
export const LIBRARY_EXPORT_CHANNEL = "library:export";
export const LIBRARY_EXPORT_MARKDOWN_CHANNEL = "library:export-markdown";
export const LIBRARY_STATISTICS_CHANNEL = "library:statistics";
export const LIBRARY_DUPLICATES_CHANNEL = "library:duplicates";
export const UPDATES_CHECK_CHANNEL = "updates:check";
export const UPDATES_INSTALL_CHANNEL = "updates:install";
export const UPDATES_DESCRIBE_CHANNEL = "updates:describe";
export const UPDATES_SET_AUTOMATIC_CHANNEL = "updates:set-automatic";
export const UPDATES_AVAILABLE_CHANNEL = "updates:available";
export const DASHBOARDS_DESCRIBE_CHANNEL = "dashboards:describe";
export const DASHBOARDS_SAVE_CHANNEL = "dashboards:save";
export const WIDGETS_SAVE_CHANNEL = "widgets:save";
export const WIDGETS_DELETE_CHANNEL = "widgets:delete";
export const WIDGETS_EVALUATE_CHANNEL = "widgets:evaluate";
export const WIDGETS_EXPORT_CHANNEL = "widgets:export";
export const WIDGETS_IMPORT_CHANNEL = "widgets:import";
export const REMOTE_DESCRIBE_CHANNEL = "remote:describe";
export const REMOTE_CHECK_CHANNEL = "remote:check";
export const REMOTE_INITIALIZE_CHANNEL = "remote:initialize";
export const REMOTE_SAVE_CHANNEL = "remote:save";
export const AI_DESCRIBE_CHANNEL = "ai:describe";
export const AI_SAVE_CHANNEL = "ai:save";
export const AI_ACCEPT_TERMS_CHANNEL = "ai:accept-terms";
export const AI_DESCRIBE_TASK_CHANNEL = "ai:describe-explain-task";
export const AI_EXPLAIN_CHANNEL = "ai:explain-passage";
export const AI_CANCEL_CHANNEL = "ai:cancel";
export const APPEARANCE_DESCRIBE_CHANNEL = "appearance:describe";
export const APPEARANCE_SAVE_CHANNEL = "appearance:save";
export const APPEARANCE_CHANGED_CHANNEL = "appearance:changed";
export const APPEARANCE_EXPORT_THEME_CHANNEL = "appearance:export-theme";
export const APPEARANCE_IMPORT_THEME_CHANNEL = "appearance:import-theme";
export const APPEARANCE_OPEN_THEMES_FOLDER_CHANNEL = "appearance:open-themes-folder";
export const COVER_RESOLVE_CHANNEL = "cover:resolve";
export const COVER_CANCEL_CHANNEL = "cover:cancel";

export interface ResolvedCoverImage {
  readonly url: string;
  /** Absent when the cover has no colour worth deriving an accent from, so
   *  the active theme's placeholder-cover colour stays in charge. */
  readonly accent?: string;
}

export interface DictionaryDefinition {
  readonly partOfSpeech: string;
  readonly definition: string;
  readonly synonyms: readonly string[];
}
export interface DictionaryResult {
  readonly word: string;
  readonly definitions: readonly DictionaryDefinition[];
}

export const DICTIONARY_LOOKUP_CHANNEL = "dictionary:lookup";
export const MCP_DESCRIBE_CHANNEL = "mcp:describe";
export const MCP_CONFIGURE_CHANNEL = "mcp:configure";

export interface McpConfiguration {
  readonly enabled: boolean;
  readonly clientConfiguration: string;
}

export const CATALOG_SEARCH_CHANNEL = "catalog:search";

export const CALIBRE_DESCRIBE_CHANNEL = "calibre:describe";
export const CALIBRE_CHOOSE_CHANNEL = "calibre:choose";
export const CALIBRE_SEARCH_CHANNEL = "calibre:search";
export const CALIBRE_LINK_CHANNEL = "calibre:link";
export const EPUB_UNLINK_CHANNEL = "epub:unlink";
export type CalibreFormat = "EPUB" | "KEPUB";
export interface CalibreReference { readonly format?: CalibreFormat; readonly libraryRoot: string; readonly libraryId: string; readonly bookUuid: string }
export interface CalibreConnection { readonly libraryId: string; readonly name: string; readonly bookCount: number }
export interface CalibreBook { readonly formats: readonly CalibreFormat[]; readonly uuid: string; readonly title: string; readonly authors: readonly string[]; readonly isbn13?: string; readonly match: "isbn" | "title-author" | "none" }
export interface CalibreSearch { readonly books: readonly CalibreBook[]; readonly hasMore: boolean }

export const EPUB_ATTACH_CHANNEL = "epub:attach";
export const EPUB_OPEN_CHANNEL = "epub:open";
export const EPUB_POSITION_CHANNEL = "epub:position";

export interface EpubDocument {
  readonly sha256: string;
  readonly chapters: readonly { readonly id: string; readonly title: string; readonly text: string; readonly html?: string; readonly styles?: string; readonly paragraphs?: readonly string[] }[];
  readonly position: { readonly chapter: number; readonly paragraph: number; readonly offset?: number };
}

export interface LeaflogueBridge {
  readonly calibre?: {
    describe(): Promise<CalibreConnection | undefined>;
    choose(): Promise<CalibreConnection | undefined>;
    search(bookId: BookId, query: string): Promise<CalibreSearch>;
    link(bookId: BookId, bookUuid: string, format?: CalibreFormat): Promise<EpubDocument>;
  };
  readonly catalog?: { search(query: string): Promise<CatalogSearch> };
  /** Desktop-only, local book files. Never automatically uploaded with library sync. */
  readonly epub?: {
    unlink?(bookId: BookId): Promise<void>;
    attach(bookId: BookId): Promise<EpubDocument | undefined>;
    open(bookId: BookId): Promise<EpubDocument | undefined>;
    savePosition(bookId: BookId, sha256: string, chapter: number, paragraph: number, offset?: number): Promise<void>;
  };
  readonly system: {
    getCapabilities(): Promise<SystemCapabilities>;
    completeSetup(): Promise<SystemCapabilities>;
    /** Ask the reader to confirm, then open an https link in their browser. */
    openExternal(url: string): Promise<boolean>;
    /** Bundled English dictionary, present on desktop; no network access. */
    lookupWord?(this: void, word: string): Promise<DictionaryResult>;
    describeMcp?(this: void): Promise<McpConfiguration>;
    configureMcp?(this: void, enabled: boolean): Promise<McpConfiguration>;
  };
  readonly library: {
    listBooks(options?: { readonly includeArchived?: boolean }): Promise<readonly Book[]>;
    /** Likely duplicate books and repeated passages; suggestions only. */
    findDuplicates(): Promise<LibraryDuplicates>;
    createBook(input: NewBook): Promise<Book>;
    updateBookMetadata(input: UpdateBookMetadata): Promise<Book>;
    getMetadataSource(id: BookId): Promise<BookMetadataSource | undefined>;
    getBookContents(id: BookId): Promise<BookContents | undefined>;
    listHighlights(query: HighlightQuery): Promise<HighlightPage>;
    createHighlight(input: NewHighlight): Promise<Highlight>;
    updateHighlight(input: UpdateHighlight): Promise<Highlight>;
    createNote(input: NewNote): Promise<Note>;
    updateNote(input: UpdateNote): Promise<Note>;
    deleteHighlight(input: DeleteHighlight): Promise<AnnotationDeletionReceipt>;
    deleteNote(input: DeleteNote): Promise<AnnotationDeletionReceipt>;
    getHighlightSource(bookId: BookId, highlightId: HighlightId): Promise<HighlightSource | undefined>;
    resetHighlightToSource(input: ResetHighlightToSource): Promise<Highlight>;
    setBookArchived(input: SetBookArchived): Promise<BookArchiveChange>;
    listReadingStatusHistory(id: BookId): Promise<ReadingStatusHistoryPage>;
    setBookReadingStatus(input: SetBookReadingStatus): Promise<BookReadingStatusChange>;
    setBookCompletionDate(input: SetBookCompletionDate): Promise<Book>;
    mergeBooks(input: MergeBooks): Promise<MergeBooksReceipt>;
  };
  readonly covers: {
    /** Resolve a remote cover through the bounded main-process cache. */
    resolve(sourceUrl: string, requestId: string): Promise<ResolvedCoverImage | undefined>;
    cancel(requestId: string): Promise<void>;
  };
  readonly organization: {
    listCollections(): Promise<readonly Collection[]>;
    listTags(): Promise<readonly Tag[]>;
    getBook(id: BookId): Promise<BookOrganization | undefined>;
    createCollection(input: NewCollection): Promise<Collection>;
    updateCollection(input: UpdateCollection): Promise<Collection>;
    deleteCollection(input: DeleteCollection): Promise<void>;
    createTag(input: NewTag): Promise<Tag>;
    updateTag(input: UpdateTag): Promise<Tag>;
    deleteTag(input: DeleteTag): Promise<void>;
    setBookCollection(input: SetBookCollectionMembership): Promise<BookOrganization>;
    setBookTag(input: SetBookTagMembership): Promise<BookOrganization>;
    setHighlightTag(input: SetHighlightTagMembership): Promise<BookOrganization>;
  };
  readonly threads: {
    list(): Promise<readonly Thread[]>;
    get(id: ThreadId): Promise<ThreadDetails | undefined>;
    getHighlightMembership(bookId: BookId, highlightId: HighlightId): Promise<readonly ThreadId[]>;
    create(input: NewThread): Promise<Thread>;
    update(input: UpdateThread): Promise<Thread>;
    delete(input: DeleteThread): Promise<void>;
    setHighlightMembership(input: SetHighlightThreadMembership): Promise<ThreadMembershipReceipt>;
  };
  readonly daily: {
    get(timezone: string): Promise<DailyHighlight | undefined>;
    ensure(input: EnsureDailyHighlight): Promise<DailyHighlight | undefined>;
  };
  readonly imports: {
    chooseFile(): Promise<PendingImport | undefined>;
    /** Choose a folder and read every KOReader sidecar inside it. */
    chooseFolder(): Promise<PendingImport | undefined>;
    /** E-readers currently plugged in. */
    listReaders(): Promise<readonly ConnectedReader[]>;
    /** Read a connected reader's annotations file for review, without a file dialog. */
    chooseReader(id: string): Promise<PendingImport | undefined>;
    onReadersChanged(listener: (readers: readonly ConnectedReader[]) => void): () => void;
    commit(input: CommitImport): Promise<ImportReceipt>;
    listConflicts(): Promise<readonly ImportConflict[]>;
    resolveConflict(input: ResolveImportConflict): Promise<void>;
  };
  /**
   * Where this bridge runs, known before `system.getCapabilities` answers, so
   * the interface never shows desktop-only controls in the web app while it
   * loads. Absent in the desktop app.
   */
  readonly host?: SystemHost;
  /** The web app's signed-in session; the desktop app has none. */
  readonly session?: {
    signOut(): Promise<void>;
    /** On Convex: sign out and choose another deployment. */
    changeDeployment?(): Promise<void>;
  };
  readonly sync: {
    listConflicts(): Promise<SyncConflictPage>;
    resolveConflict(input: ResolveSyncConflict): Promise<void>;
    run(options?: SyncRunOptions): Promise<SyncRunResult>;
    status(): Promise<SyncStatus>;
    onStatus(listener: (status: SyncStatus) => void): () => void;
  };
  readonly backups: {
    create(): Promise<BackupReceipt | undefined>;
    restore(): Promise<RestoreReceipt | undefined>;
  };
  readonly exports: {
    create(): Promise<LibraryExportReceipt | undefined>;
    /** Write Markdown files (one per book, plus library.md) into a new folder the reader picks a location for. */
    createMarkdown(options: MarkdownExportOptions): Promise<MarkdownExportReceipt | undefined>;
  };
  readonly statistics: {
    get(): Promise<LibraryStatistics>;
  };
  readonly dashboards: {
    describe(): Promise<DashboardLayouts>;
    /** Save one dashboard's layout; `null` returns it to the default. */
    save(dashboard: DashboardId, layout: readonly DashboardPlacement[] | null): Promise<DashboardLayouts>;
  };
  readonly widgets: {
    /** Add a custom widget, or replace the one with the same ID. */
    save(widget: CustomWidget): Promise<DashboardLayouts>;
    /** Remove a custom widget and every placement of it. */
    delete(id: string): Promise<DashboardLayouts>;
    /** Count each recipe over the library, in order. */
    evaluate(widgets: readonly CustomWidget[]): Promise<readonly WidgetResult[]>;
    /** Save a widget to a `.leaflogue-widget.json` file the reader picks. */
    export(id: string): Promise<WidgetExportReceipt | undefined>;
    /** Read widget files the reader picks and add them. */
    import(): Promise<WidgetImportReceipt | undefined>;
  };
  readonly updates: {
    check(): Promise<UpdateStatus>;
    /** Download, verify, and install the update the last check found, then restart. */
    install(): Promise<void>;
    describe(): Promise<UpdateSettings>;
    setAutomaticCheck(enabled: boolean): Promise<UpdateSettings>;
    /** Called when an automatic check finds a verified newer version. */
    onAvailable(listener: (version: string) => void): () => void;
  };
  readonly remote: {
    describe(): Promise<RemoteConfigurationSummary>;
    save(input: RemoteSetupInput): Promise<RemoteConfigurationSummary | undefined>;
    check(): Promise<RemoteDatabaseStatus>;
    initialize(): Promise<RemoteDatabaseStatus>;
  };
  readonly ai: {
    describe(): Promise<AiConfigurationSummary>;
    save(input: AiSettingsInput): Promise<AiConfigurationSummary>;
    /** Record that the reader accepted what this provider receives. */
    acceptTerms(providerId: string): Promise<AiConfigurationSummary>;
    /** What an explanation would transmit, without sending anything. */
    describeExplainTask(bookId: BookId, highlightId: HighlightId, includeNotes: boolean): Promise<AiTaskDisclosure>;
    explainPassage(input: ExplainPassageRequest): Promise<PassageExplanation>;
    cancel(requestId: string): Promise<void>;
  };
  readonly appearance: {
    describe(): Promise<AppearanceConfiguration>;
    save(input: AppearanceSettingsInput): Promise<AppearanceConfiguration>;
    exportTheme(themeId: string): Promise<ThemeExportReceipt | undefined>;
    importTheme(): Promise<AppearanceConfiguration | undefined>;
    /** Opens the folder whose theme files are picked up automatically, creating it if needed; returns its path. */
    openThemesFolder(): Promise<string>;
    onChanged(listener: (configuration: AppearanceConfiguration) => void): () => void;
  };
}
