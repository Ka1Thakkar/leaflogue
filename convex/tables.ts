import { defineTable } from "convex/server";
import { v } from "convex/values";

const readingStatus = v.union(
  v.literal("unread"),
  v.literal("reading"),
  v.literal("finished"),
  v.literal("paused"),
);

/**
 * Leaflogue's tables, shared so another Convex app can host Leaflogue's
 * backend: its own schema spreads these beside its tables (for example a
 * sign-in library's), and Leaflogue's functions run unchanged against them.
 * Leaflogue itself uses exactly these (see schema.ts).
 */
export const leaflogueTables = {
  libraries: defineTable({
    externalId: v.string(),
    nextChangeSequence: v.number(),
    syncGeneration: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_external_id", ["externalId"]),

  libraryMembers: defineTable({
    libraryId: v.string(),
    identityTokenIdentifier: v.string(),
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_identity_and_library", ["identityTokenIdentifier", "libraryId"])
    .index("by_library", ["libraryId"]),

  deviceSessions: defineTable({
    libraryId: v.string(),
    deviceId: v.string(),
    identityTokenIdentifier: v.string(),
    name: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_library_and_device", ["libraryId", "deviceId"])
    .index("by_identity_and_library", ["identityTokenIdentifier", "libraryId"])
    .index("by_library", ["libraryId"]),

  books: defineTable({
    libraryId: v.string(),
    id: v.string(),
    title: v.string(),
    authors: v.array(v.string()),
    description: v.optional(v.string()),
    publisher: v.optional(v.string()),
    series: v.optional(v.string()),
    seriesNumber: v.optional(v.string()),
    language: v.optional(v.string()),
    isbn13: v.optional(v.string()),
    coverUrl: v.optional(v.string()),
    status: readingStatus,
    completedOn: v.optional(v.string()),
    archived: v.boolean(),
    deletedAt: v.optional(v.number()),
    highlightCount: v.number(),
    noteCount: v.number(),
    readingDataBytes: v.number(),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_library_and_id", ["libraryId", "id"])
    .index("by_library_archived_and_id", ["libraryId", "archived", "id"])
    .index("by_library_and_isbn13", ["libraryId", "isbn13"]),

  readingStatusEvents: defineTable({
    libraryId: v.string(),
    id: v.string(),
    bookId: v.string(),
    sequence: v.number(),
    status: readingStatus,
    source: v.union(
      v.literal("reader"),
      v.literal("merge"),
      v.literal("kindle"),
      v.literal("kobo"),
      v.literal("portable"),
    ),
    changedAt: v.number(),
    completedOn: v.optional(v.string()),
    bookRevision: v.number(),
  })
    .index("by_library_and_id", ["libraryId", "id"])
    .index("by_library_and_book_and_sequence", ["libraryId", "bookId", "sequence"]),

  threads: defineTable({
    libraryId: v.string(),
    id: v.string(),
    name: v.string(),
    normalizedName: v.string(),
    description: v.optional(v.string()),
    passageCount: v.number(),
    deletedAt: v.optional(v.number()),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_library_and_id", ["libraryId", "id"])
    .index("by_library_deleted_and_id", ["libraryId", "deletedAt", "id"])
    .index("by_library_normalized_name_and_deleted", ["libraryId", "normalizedName", "deletedAt"]),

  threadHighlights: defineTable({
    libraryId: v.string(),
    threadId: v.string(),
    highlightId: v.string(),
    addedAt: v.number(),
  })
    .index("by_library_and_thread", ["libraryId", "threadId"])
    .index("by_library_and_highlight", ["libraryId", "highlightId"])
    .index("by_library_thread_and_highlight", ["libraryId", "threadId", "highlightId"]),

  dailySelections: defineTable({
    libraryId: v.string(),
    id: v.string(),
    localDay: v.string(),
    timezone: v.string(),
    highlightId: v.optional(v.string()),
    candidateDigest: v.string(),
    recentHighlightIds: v.array(v.string()),
    selectedAt: v.number(),
    updatedAt: v.number(),
    revision: v.number(),
    /** First-selection time; immutable. Absent on picks made before sync, which fall back to selectedAt. */
    createdAt: v.optional(v.number()),
  })
    .index("by_library_and_id", ["libraryId", "id"])
    .index("by_library_day_and_timezone", ["libraryId", "localDay", "timezone"])
    .index("by_library_timezone_and_day", ["libraryId", "timezone", "localDay"])
    .index("by_library_and_updated", ["libraryId", "updatedAt"]),

  dailyCandidates: defineTable({
    libraryId: v.string(),
    highlightId: v.string(),
    bookId: v.string(),
    bookActive: v.boolean(),
  })
    .index("by_library_active_book_and_highlight", ["libraryId", "bookActive", "bookId", "highlightId"])
    .index("by_library_and_book", ["libraryId", "bookId"])
    .index("by_library_and_highlight", ["libraryId", "highlightId"]),

  dailyProjectionBlocks: defineTable({
    libraryId: v.string(),
    bookId: v.string(),
    desiredActive: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_library", ["libraryId"])
    .index("by_library_and_book", ["libraryId", "bookId"]),

  highlights: defineTable({
    libraryId: v.string(),
    id: v.string(),
    bookId: v.string(),
    text: v.string(),
    sourceLocation: v.optional(v.string()),
    sourceCreatedAt: v.optional(v.number()),
    dailyCandidateReady: v.optional(v.boolean()),
    archived: v.boolean(),
    deletedAt: v.optional(v.number()),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_library_and_id", ["libraryId", "id"])
    .index("by_library_candidate_ready_and_id", ["libraryId", "dailyCandidateReady", "id"])
    .index("by_library_and_book", ["libraryId", "bookId"])
    // For browsing in a web client: newest/oldest, recently edited, a day, and search.
    .index("by_library_deleted_and_created", ["libraryId", "deletedAt", "createdAt"])
    .index("by_library_deleted_and_updated", ["libraryId", "deletedAt", "updatedAt"])
    .index("by_library_book_deleted_and_created", ["libraryId", "bookId", "deletedAt", "createdAt"])
    .index("by_library_book_deleted_and_updated", ["libraryId", "bookId", "deletedAt", "updatedAt"])
    .searchIndex("search_text", { searchField: "text", filterFields: ["libraryId", "bookId", "deletedAt"] }),

  notes: defineTable({
    libraryId: v.string(),
    id: v.string(),
    bookId: v.string(),
    highlightId: v.optional(v.string()),
    markdown: v.string(),
    origin: v.union(v.literal("reader"), v.literal("import"), v.literal("ai")),
    attachmentBoundsReady: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_library_and_id", ["libraryId", "id"])
    .index("by_library_attachment_ready_and_id", ["libraryId", "attachmentBoundsReady", "id"])
    .index("by_library_and_book", ["libraryId", "bookId"])
    .index("by_library_and_highlight", ["libraryId", "highlightId"])
    .index("by_library_highlight_and_deleted", ["libraryId", "highlightId", "deletedAt"]),

  collections: defineTable({
    libraryId: v.string(),
    id: v.string(),
    name: v.string(),
    normalizedName: v.string(),
    description: v.optional(v.string()),
    bookCount: v.number(),
    deletedAt: v.optional(v.number()),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_library_and_id", ["libraryId", "id"])
    .index("by_library_normalized_name_and_deleted", ["libraryId", "normalizedName", "deletedAt"]),

  tags: defineTable({
    libraryId: v.string(),
    id: v.string(),
    name: v.string(),
    normalizedName: v.string(),
    color: v.optional(v.string()),
    bookCount: v.number(),
    highlightCount: v.number(),
    deletedAt: v.optional(v.number()),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_library_and_id", ["libraryId", "id"])
    .index("by_library_normalized_name_and_deleted", ["libraryId", "normalizedName", "deletedAt"]),

  collectionBooks: defineTable({
    libraryId: v.string(),
    collectionId: v.string(),
    bookId: v.string(),
    createdAt: v.number(),
  })
    .index("by_library_and_collection", ["libraryId", "collectionId"])
    .index("by_library_and_book", ["libraryId", "bookId"])
    .index("by_library_collection_and_book", ["libraryId", "collectionId", "bookId"]),

  bookTags: defineTable({
    libraryId: v.string(),
    tagId: v.string(),
    bookId: v.string(),
    createdAt: v.number(),
  })
    .index("by_library_and_tag", ["libraryId", "tagId"])
    .index("by_library_and_book", ["libraryId", "bookId"])
    .index("by_library_tag_and_book", ["libraryId", "tagId", "bookId"]),

  highlightTags: defineTable({
    libraryId: v.string(),
    tagId: v.string(),
    bookId: v.optional(v.string()),
    highlightId: v.string(),
    createdAt: v.number(),
  })
    .index("by_library_and_tag", ["libraryId", "tagId"])
    .index("by_library_and_book", ["libraryId", "bookId"])
    .index("by_library_and_highlight", ["libraryId", "highlightId"])
    .index("by_library_highlight_and_book", ["libraryId", "highlightId", "bookId"])
    .index("by_library_tag_and_highlight", ["libraryId", "tagId", "highlightId"]),

  highlightProjectionBlocks: defineTable({
    libraryId: v.string(),
    highlightId: v.string(),
    operation: v.union(v.literal("upsert"), v.literal("tombstone")),
    targetBookId: v.string(),
    createdAt: v.number(),
  }).index("by_library_and_highlight", ["libraryId", "highlightId"]),

  highlightProjectionSources: defineTable({
    libraryId: v.string(),
    highlightId: v.string(),
    sourceBookId: v.string(),
  }).index("by_library_highlight_and_source", ["libraryId", "highlightId", "sourceBookId"])
    .index("by_library_and_highlight", ["libraryId", "highlightId"]),

  syncChanges: defineTable({
    libraryId: v.string(),
    sequence: v.number(),
    entityType: v.union(v.literal("book"), v.literal("highlight"), v.literal("note"), v.literal("collection"), v.literal("tag"), v.literal("thread"), v.literal("daily-selection")),
    entityId: v.string(),
    revision: v.number(),
    changedAt: v.number(),
  }).index("by_library_and_sequence", ["libraryId", "sequence"]),

  syncedWriters: defineTable({
    libraryId: v.string(),
    entityType: v.union(v.literal("book"), v.literal("highlight"), v.literal("note"), v.literal("collection"), v.literal("tag"), v.literal("thread"), v.literal("daily-selection")),
    entityId: v.string(),
    deviceId: v.string(),
    deviceRevision: v.number(),
    operation: v.union(v.literal("upsert"), v.literal("tombstone")),
    entityRevision: v.number(),
    appliedAt: v.number(),
  }).index("by_library_entity", ["libraryId", "entityType", "entityId"]),

  syncTombstones: defineTable({
    libraryId: v.string(),
    entityType: v.union(v.literal("book"), v.literal("highlight"), v.literal("note"), v.literal("collection"), v.literal("tag"), v.literal("thread"), v.literal("daily-selection")),
    entityId: v.string(),
    bookId: v.string(),
    revision: v.number(),
    deletedAt: v.number(),
  }).index("by_library_entity", ["libraryId", "entityType", "entityId"]),

  syncConflicts: defineTable({
    libraryId: v.string(),
    id: v.string(),
    entityType: v.union(v.literal("highlight"), v.literal("note")),
    entityId: v.string(),
    bookId: v.string(),
    losingBody: v.string(),
    winningBody: v.optional(v.string()),
    losingDeviceId: v.optional(v.string()),
    losingDeviceRevision: v.optional(v.number()),
    losingOperation: v.union(v.literal("upsert"), v.literal("tombstone")),
    winningOperation: v.union(v.literal("upsert"), v.literal("tombstone")),
    status: v.union(v.literal("pending"), v.literal("resolved")),
    createdAt: v.number(),
  })
    .index("by_library_entity_and_status", ["libraryId", "entityType", "entityId", "status"])
    .index("by_library_loser", ["libraryId", "entityType", "entityId", "losingDeviceId", "losingDeviceRevision", "losingOperation"]),

  syncConflictCounters: defineTable({
    libraryId: v.string(),
    entityType: v.union(v.literal("highlight"), v.literal("note")),
    entityId: v.string(),
    pendingCount: v.number(),
  }).index("by_library_entity", ["libraryId", "entityType", "entityId"]),

  // --- Web-only tables --------------------------------------------------
  // Used by the web functions alone; desktops never sync them, so adding one
  // does not change the sync schema version (setup:status).

  /**
   * Public links: a frozen copy of a passage at a random address. The
   * highlight's revision at publishing tells whether it has changed since.
   */
  publications: defineTable({
    libraryId: v.string(),
    publicId: v.string(),
    highlightId: v.string(),
    bookId: v.string(),
    highlightRevision: v.number(),
    noteIds: v.array(v.string()),
    passage: v.string(),
    bookTitle: v.string(),
    authors: v.array(v.string()),
    notes: v.array(v.object({ markdown: v.string(), ai: v.boolean() })),
    active: v.boolean(),
    publishedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_library_and_highlight", ["libraryId", "highlightId"])
    .index("by_library_active_published", ["libraryId", "active", "publishedAt"]),

  /** Anonymous reports about a public link, for the owner to review. */
  publicationReports: defineTable({
    publicId: v.string(),
    libraryId: v.string(),
    reporterKey: v.string(),
    day: v.string(),
    reason: v.union(v.literal("copyright"), v.literal("harassment"), v.literal("personal_information"), v.literal("other")),
    details: v.optional(v.string()),
    status: v.union(v.literal("open"), v.literal("reviewed")),
    createdAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_reporter_and_day", ["reporterKey", "day"])
    .index("by_library_and_status", ["libraryId", "status"]),

  /**
   * Imports made through a web client. Like the desktop's own import
   * history, these stay on the server and are not synced: they remember
   * which records came from which source, so importing again updates
   * passages instead of duplicating them.
   */
  importSources: defineTable({
    libraryId: v.string(),
    id: v.string(),
    provider: v.string(),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_library_and_id", ["libraryId", "id"]),

  importSourceBooks: defineTable({
    libraryId: v.string(),
    sourceId: v.string(),
    providerRecordId: v.string(),
    bookId: v.string(),
    fingerprint: v.string(),
    updatedAt: v.number(),
  }).index("by_source_record", ["libraryId", "sourceId", "providerRecordId"]),

  /** A passage (with its attached note) or a standalone note, and its revisions right after the import wrote it. */
  importSourceAnnotations: defineTable({
    libraryId: v.string(),
    sourceId: v.string(),
    providerRecordId: v.string(),
    bookId: v.string(),
    highlightId: v.optional(v.string()),
    highlightRevision: v.optional(v.number()),
    attachedNoteId: v.optional(v.string()),
    attachedNoteRevision: v.optional(v.number()),
    noteId: v.optional(v.string()),
    noteRevision: v.optional(v.number()),
    fingerprint: v.string(),
    incoming: v.string(),
    updatedAt: v.number(),
  })
    .index("by_source_record", ["libraryId", "sourceId", "providerRecordId"])
    .index("by_library_and_highlight", ["libraryId", "highlightId"])
    .index("by_library_and_updated", ["libraryId", "updatedAt"]),

  /** A source change to something the reader had edited, kept for review. */
  importConflicts: defineTable({
    libraryId: v.string(),
    id: v.string(),
    sourceId: v.string(),
    providerRecordId: v.string(),
    bookId: v.string(),
    previous: v.string(),
    incoming: v.string(),
    incomingFingerprint: v.string(),
    status: v.union(v.literal("pending"), v.literal("kept"), v.literal("accepted")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_library_and_id", ["libraryId", "id"])
    .index("by_library_and_status", ["libraryId", "status"])
    .index("by_source_record", ["libraryId", "sourceId", "providerRecordId"]),

  /** The library's chosen AI provider and model. Keys stay in the server's environment. */
  aiSettings: defineTable({
    libraryId: v.string(),
    provider: v.string(),
    model: v.string(),
    updatedAt: v.number(),
  }).index("by_library", ["libraryId"]),

  /** How each web reader arranged a dashboard. A preference, never synced. */
  dashboardLayouts: defineTable({
    libraryId: v.string(),
    identityTokenIdentifier: v.string(),
    dashboard: v.union(v.literal("library"), v.literal("statistics")),
    layout: v.array(v.object({ widget: v.string(), width: v.optional(v.string()), tall: v.optional(v.boolean()) })),
    updatedAt: v.number(),
  }).index("by_identity_and_library", ["identityTokenIdentifier", "libraryId", "dashboard"]),

  /** Each signed-in reader's AI request count in the current hour. */
  aiRequestWindows: defineTable({
    identityTokenIdentifier: v.string(),
    windowStartedAt: v.number(),
    requests: v.number(),
  }).index("by_identity", ["identityTokenIdentifier"]),
};
