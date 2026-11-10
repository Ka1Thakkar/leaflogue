import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_CREATE_CHANNEL,
  BACKUP_RESTORE_CHANNEL,
  IMPORT_CHOOSE_CHANNEL,
  IMPORT_CHOOSE_FOLDER_CHANNEL,
  IMPORT_COMMIT_CHANNEL,
  IMPORT_CONFLICT_RESOLVE_CHANNEL,
  IMPORT_CONFLICTS_LIST_CHANNEL,
  SYNC_CONFLICT_RESOLVE_CHANNEL,
  SYNC_CONFLICTS_LIST_CHANNEL,
  SYNC_RUN_CHANNEL,
  LIBRARY_CREATE_CHANNEL,
  LIBRARY_UPDATE_METADATA_CHANNEL,
  LIBRARY_METADATA_SOURCE_CHANNEL,
  LIBRARY_CREATE_HIGHLIGHT_CHANNEL,
  LIBRARY_CREATE_NOTE_CHANNEL,
  LIBRARY_GET_CONTENTS_CHANNEL,
  LIBRARY_LIST_HIGHLIGHTS_CHANNEL,
  LIBRARY_EXPORT_CHANNEL,
  LIBRARY_LIST_CHANNEL,
  LIBRARY_LIST_READING_STATUS_CHANNEL,
  LIBRARY_MERGE_BOOKS_CHANNEL,
  LIBRARY_SET_BOOK_ARCHIVED_CHANNEL,
  LIBRARY_SET_COMPLETION_DATE_CHANNEL,
  LIBRARY_SET_READING_STATUS_CHANNEL,
  LIBRARY_UPDATE_HIGHLIGHT_CHANNEL,
  LIBRARY_UPDATE_NOTE_CHANNEL,
  LIBRARY_DELETE_HIGHLIGHT_CHANNEL,
  LIBRARY_DELETE_NOTE_CHANNEL,
  LIBRARY_HIGHLIGHT_SOURCE_CHANNEL,
  LIBRARY_RESET_HIGHLIGHT_CHANNEL,
  ORGANIZATION_LIST_COLLECTIONS_CHANNEL,
  ORGANIZATION_LIST_TAGS_CHANNEL,
  ORGANIZATION_GET_BOOK_CHANNEL,
  ORGANIZATION_CREATE_COLLECTION_CHANNEL,
  ORGANIZATION_UPDATE_COLLECTION_CHANNEL,
  ORGANIZATION_DELETE_COLLECTION_CHANNEL,
  ORGANIZATION_CREATE_TAG_CHANNEL,
  ORGANIZATION_UPDATE_TAG_CHANNEL,
  ORGANIZATION_DELETE_TAG_CHANNEL,
  ORGANIZATION_SET_BOOK_COLLECTION_CHANNEL,
  ORGANIZATION_SET_BOOK_TAG_CHANNEL,
  ORGANIZATION_SET_HIGHLIGHT_TAG_CHANNEL,
  THREAD_LIST_CHANNEL,
  THREAD_GET_CHANNEL,
  THREAD_GET_HIGHLIGHT_MEMBERSHIP_CHANNEL,
  THREAD_CREATE_CHANNEL,
  THREAD_UPDATE_CHANNEL,
  THREAD_DELETE_CHANNEL,
  THREAD_SET_HIGHLIGHT_MEMBERSHIP_CHANNEL,
  DAILY_GET_CHANNEL,
  DAILY_ENSURE_CHANNEL,
  REMOTE_CHECK_CHANNEL,
  REMOTE_DESCRIBE_CHANNEL,
  REMOTE_INITIALIZE_CHANNEL,
  REMOTE_SAVE_CHANNEL,
  SYSTEM_CAPABILITIES_CHANNEL,
  SYSTEM_COMPLETE_SETUP_CHANNEL,
  SYSTEM_OPEN_EXTERNAL_CHANNEL,
  AI_DESCRIBE_CHANNEL,
  AI_SAVE_CHANNEL,
  AI_ACCEPT_TERMS_CHANNEL,
  AI_DESCRIBE_TASK_CHANNEL,
  AI_EXPLAIN_CHANNEL,
  AI_CANCEL_CHANNEL,
  APPEARANCE_DESCRIBE_CHANNEL,
  APPEARANCE_SAVE_CHANNEL,
  APPEARANCE_EXPORT_THEME_CHANNEL,
  APPEARANCE_IMPORT_THEME_CHANNEL,
  APPEARANCE_OPEN_THEMES_FOLDER_CHANNEL,
  APPEARANCE_CHANGED_CHANNEL,
  COVER_RESOLVE_CHANNEL,
  COVER_CANCEL_CHANNEL,
  type LeaflogueBridge,
} from "@leaflogue/contracts";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

let bridge: LeaflogueBridge;
const bookId = "5a540f21-7f61-44d7-89a5-f1b4643ce26c" as never;
const highlightId = "6b651032-8a72-45e8-9ab6-a2c5754df37d" as never;
const requestId = "2f3c9b5e-9f1d-4f2b-8c3a-6d1e5b7a9c04";
const noteId = "78f05c4d-699a-4aeb-b9c1-8e7e753e40a4" as never;
const collectionId = "8c061d5e-7aab-4c55-8f02-0e7909cecc91" as never;
const tagId = "9d172e6f-8bbc-4d66-9013-1f801adfdda2" as never;
const threadId = "ae283f70-9ccd-4e77-a124-20912be0eeb3" as never;

beforeAll(async () => {
  await import("./index");
  expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
  expect(electron.exposeInMainWorld.mock.calls[0]?.[0]).toBe("leaflogue");
  bridge = electron.exposeInMainWorld.mock.calls[0]?.[1] as LeaflogueBridge;
});

beforeEach(() => {
  electron.invoke.mockClear();
  electron.on.mockClear();
  electron.removeListener.mockClear();
});

describe("preload IPC bridge", () => {
  it("exposes only a frozen product API", () => {
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(bridge.imports)).toBe(true);
    expect(Object.isFrozen(bridge.exports)).toBe(true);
    expect(Object.isFrozen(bridge.ai)).toBe(true);
    expect(Object.isFrozen(bridge.appearance)).toBe(true);
    expect(Object.isFrozen(bridge.organization)).toBe(true);
    expect(Object.isFrozen(bridge.threads)).toBe(true);
    expect(Object.isFrozen(bridge.daily)).toBe(true);
    expect(Object.isFrozen(bridge.covers)).toBe(true);
    expect(Object.isFrozen(bridge.updates)).toBe(true);
    expect(Object.keys(bridge.updates).sort()).toEqual(["check", "describe", "install", "onAvailable", "setAutomaticCheck"]);
    expect(Object.isFrozen(bridge.dashboards)).toBe(true);
    expect(Object.keys(bridge.dashboards).sort()).toEqual(["describe", "save"]);
    expect(Object.isFrozen(bridge.widgets)).toBe(true);
    expect(Object.keys(bridge.widgets).sort()).toEqual(["delete", "evaluate", "export", "import", "save"]);
    expect(Object.keys(bridge.ai).sort()).toEqual(["acceptTerms", "cancel", "describe", "describeExplainTask", "explainPassage", "save"]);
    expect(Object.keys(bridge.appearance).sort()).toEqual(["describe", "exportTheme", "importTheme", "onChanged", "openThemesFolder", "save"]);
    expect(Object.keys(bridge).sort()).toEqual(["ai", "appearance", "backups", "covers", "daily", "dashboards", "exports", "imports", "library", "organization", "remote", "statistics", "sync", "system", "threads", "updates", "widgets"]);
  });

  it("subscribes to appearance changes without exposing raw IPC", () => {
    const listener = vi.fn();
    const stop = bridge.appearance.onChanged(listener);
    expect(electron.on).toHaveBeenCalledWith(APPEARANCE_CHANGED_CHANNEL, expect.any(Function));
    const receive = electron.on.mock.calls[0]?.[1] as ((event: unknown, value: unknown) => void) | undefined;
    const configuration = { themeId: "rose-pine", mode: "dark", themes: [] } as never;
    receive?.({}, configuration);
    expect(listener).toHaveBeenCalledWith(configuration);
    stop();
    expect(electron.removeListener).toHaveBeenCalledWith(APPEARANCE_CHANGED_CHANNEL, receive);
  });

  it("maps every product operation to its fixed channel", async () => {
    await bridge.system.getCapabilities();
    await bridge.system.completeSetup();
    await bridge.system.openExternal("https://example.test/");
    await bridge.covers.resolve("https://covers.openlibrary.org/b/id/1-L.jpg", requestId);
    await bridge.covers.cancel(requestId);
    await bridge.library.listBooks({ includeArchived: true });
    await bridge.library.createBook({ title: "Book" });
    await bridge.library.updateBookMetadata({ id: bookId, expectedRevision: 1, title: "Book", authors: [] });
    await bridge.library.getMetadataSource(bookId);
    await bridge.library.getBookContents(bookId);
    await bridge.library.listHighlights({ bookId, limit: 20 });
    await bridge.library.createHighlight({ bookId, text: "Passage" });
    await bridge.library.updateHighlight({ id: highlightId, bookId, text: "Passage", expectedRevision: 1 });
    await bridge.library.createNote({ bookId, markdown: "Note" });
    await bridge.library.updateNote({ id: noteId, bookId, markdown: "Note", expectedRevision: 1 });
    await bridge.library.deleteHighlight({ id: highlightId, bookId, expectedRevision: 1 });
    await bridge.library.deleteNote({ id: noteId, bookId, expectedRevision: 1 });
    await bridge.library.getHighlightSource(bookId, highlightId);
    await bridge.library.resetHighlightToSource({ id: highlightId, bookId, expectedRevision: 1, resetToken: "a".repeat(64) });
    await bridge.library.setBookArchived({ id: bookId, archived: true, expectedRevision: 1 });
    await bridge.library.listReadingStatusHistory(bookId);
    await bridge.library.setBookReadingStatus({ id: bookId, status: "reading", expectedRevision: 1 });
    await bridge.library.setBookCompletionDate({ id: bookId, completedOn: "2024-02-29", expectedRevision: 2 });
    await bridge.library.mergeBooks({ sourceBookId: bookId, targetBookId: "8c061d5e-7aab-4c55-8f02-0e7909cecc91" as never, expectedSourceRevision: 1, expectedTargetRevision: 1 });
    await bridge.organization.listCollections();
    await bridge.organization.listTags();
    await bridge.organization.getBook(bookId);
    await bridge.organization.createCollection({ name: "Favourites" });
    await bridge.organization.updateCollection({ id: collectionId, name: "Keepers", expectedRevision: 1 });
    await bridge.organization.deleteCollection({ id: collectionId, expectedRevision: 2 });
    await bridge.organization.createTag({ name: "Revisit", color: "ochre" });
    await bridge.organization.updateTag({ id: tagId, name: "Reread", expectedRevision: 1 });
    await bridge.organization.deleteTag({ id: tagId, expectedRevision: 2 });
    await bridge.organization.setBookCollection({ bookId, collectionId, included: true });
    await bridge.organization.setBookTag({ bookId, tagId, included: true });
    await bridge.organization.setHighlightTag({ bookId, highlightId, tagId, included: true });
    await bridge.threads.list();
    await bridge.threads.get(threadId);
    await bridge.threads.getHighlightMembership(bookId, highlightId);
    await bridge.threads.create({ name: "Home" });
    await bridge.threads.update({ id: threadId, name: "Homes", expectedRevision: 1 });
    await bridge.threads.delete({ id: threadId, expectedRevision: 2 });
    await bridge.threads.setHighlightMembership({ bookId, highlightId, threadIds: [threadId], expectedHighlightRevision: 1 });
    await bridge.daily.get("UTC");
    await bridge.daily.ensure({ timezone: "UTC", another: true });
    await bridge.imports.chooseFile();
    await bridge.imports.chooseFolder();
    await bridge.imports.commit({ token: "9d172e6f-8bbc-4d66-9013-1f801adfdda2", sourceId: "ae283f70-9ccd-4e77-a124-20912be0eeb3" });
    await bridge.imports.listConflicts();
    await bridge.imports.resolveConflict({ id: "bf394081-addf-4f88-b235-31a23cf1ffc4" as never, resolution: "keep-local" });
    await bridge.sync.listConflicts();
    await bridge.sync.resolveConflict({ id: "bf394081-addf-4f88-b235-31a23cf1ffc4" as never, resolution: "restore", expectedRevision: 2 });
    await bridge.sync.run();
    await bridge.backups.create();
    await bridge.backups.restore();
    await bridge.exports.create();
    await bridge.remote.describe();
    await bridge.remote.save({ provider: "postgres", databaseUrl: "postgresql://example", location: "default" });
    await bridge.remote.check();
    await bridge.remote.initialize();
    await bridge.ai.describe();
    await bridge.ai.save({ enabled: false, selectedProvider: "openai", selectedModel: "gpt-5-mini" });
    await bridge.ai.acceptTerms("gemini");
    await bridge.ai.describeExplainTask(bookId, highlightId, true);
    await bridge.ai.explainPassage({ requestId, disclosureId: highlightId });
    await bridge.ai.cancel(requestId);
    await bridge.appearance.describe();
    await bridge.appearance.save({ themeId: "rose-pine", mode: "dark" });
    await bridge.appearance.exportTheme("rose-pine");
    await bridge.appearance.importTheme();
    await bridge.appearance.openThemesFolder();

    expect(electron.invoke.mock.calls).toEqual([
      [SYSTEM_CAPABILITIES_CHANNEL],
      [SYSTEM_COMPLETE_SETUP_CHANNEL],
      [SYSTEM_OPEN_EXTERNAL_CHANNEL, "https://example.test/"],
      [COVER_RESOLVE_CHANNEL, "https://covers.openlibrary.org/b/id/1-L.jpg", requestId],
      [COVER_CANCEL_CHANNEL, requestId],
      [LIBRARY_LIST_CHANNEL, { includeArchived: true }],
      [LIBRARY_CREATE_CHANNEL, { title: "Book" }],
      [LIBRARY_UPDATE_METADATA_CHANNEL, { id: bookId, expectedRevision: 1, title: "Book", authors: [] }],
      [LIBRARY_METADATA_SOURCE_CHANNEL, bookId],
      [LIBRARY_GET_CONTENTS_CHANNEL, bookId],
      [LIBRARY_LIST_HIGHLIGHTS_CHANNEL, { bookId, limit: 20 }],
      [LIBRARY_CREATE_HIGHLIGHT_CHANNEL, { bookId, text: "Passage" }],
      [LIBRARY_UPDATE_HIGHLIGHT_CHANNEL, { id: highlightId, bookId, text: "Passage", expectedRevision: 1 }],
      [LIBRARY_CREATE_NOTE_CHANNEL, { bookId, markdown: "Note" }],
      [LIBRARY_UPDATE_NOTE_CHANNEL, { id: noteId, bookId, markdown: "Note", expectedRevision: 1 }],
      [LIBRARY_DELETE_HIGHLIGHT_CHANNEL, { id: highlightId, bookId, expectedRevision: 1 }],
      [LIBRARY_DELETE_NOTE_CHANNEL, { id: noteId, bookId, expectedRevision: 1 }],
      [LIBRARY_HIGHLIGHT_SOURCE_CHANNEL, bookId, highlightId],
      [LIBRARY_RESET_HIGHLIGHT_CHANNEL, { id: highlightId, bookId, expectedRevision: 1, resetToken: "a".repeat(64) }],
      [LIBRARY_SET_BOOK_ARCHIVED_CHANNEL, { id: bookId, archived: true, expectedRevision: 1 }],
      [LIBRARY_LIST_READING_STATUS_CHANNEL, bookId],
      [LIBRARY_SET_READING_STATUS_CHANNEL, { id: bookId, status: "reading", expectedRevision: 1 }],
      [LIBRARY_SET_COMPLETION_DATE_CHANNEL, { id: bookId, completedOn: "2024-02-29", expectedRevision: 2 }],
      [LIBRARY_MERGE_BOOKS_CHANNEL, { sourceBookId: bookId, targetBookId: "8c061d5e-7aab-4c55-8f02-0e7909cecc91", expectedSourceRevision: 1, expectedTargetRevision: 1 }],
      [ORGANIZATION_LIST_COLLECTIONS_CHANNEL],
      [ORGANIZATION_LIST_TAGS_CHANNEL],
      [ORGANIZATION_GET_BOOK_CHANNEL, bookId],
      [ORGANIZATION_CREATE_COLLECTION_CHANNEL, { name: "Favourites" }],
      [ORGANIZATION_UPDATE_COLLECTION_CHANNEL, { id: collectionId, name: "Keepers", expectedRevision: 1 }],
      [ORGANIZATION_DELETE_COLLECTION_CHANNEL, { id: collectionId, expectedRevision: 2 }],
      [ORGANIZATION_CREATE_TAG_CHANNEL, { name: "Revisit", color: "ochre" }],
      [ORGANIZATION_UPDATE_TAG_CHANNEL, { id: tagId, name: "Reread", expectedRevision: 1 }],
      [ORGANIZATION_DELETE_TAG_CHANNEL, { id: tagId, expectedRevision: 2 }],
      [ORGANIZATION_SET_BOOK_COLLECTION_CHANNEL, { bookId, collectionId, included: true }],
      [ORGANIZATION_SET_BOOK_TAG_CHANNEL, { bookId, tagId, included: true }],
      [ORGANIZATION_SET_HIGHLIGHT_TAG_CHANNEL, { bookId, highlightId, tagId, included: true }],
      [THREAD_LIST_CHANNEL],
      [THREAD_GET_CHANNEL, threadId],
      [THREAD_GET_HIGHLIGHT_MEMBERSHIP_CHANNEL, { bookId, highlightId }],
      [THREAD_CREATE_CHANNEL, { name: "Home" }],
      [THREAD_UPDATE_CHANNEL, { id: threadId, name: "Homes", expectedRevision: 1 }],
      [THREAD_DELETE_CHANNEL, { id: threadId, expectedRevision: 2 }],
      [THREAD_SET_HIGHLIGHT_MEMBERSHIP_CHANNEL, { bookId, highlightId, threadIds: [threadId], expectedHighlightRevision: 1 }],
      [DAILY_GET_CHANNEL, "UTC"],
      [DAILY_ENSURE_CHANNEL, { timezone: "UTC", another: true }],
      [IMPORT_CHOOSE_CHANNEL],
      [IMPORT_CHOOSE_FOLDER_CHANNEL],
      [IMPORT_COMMIT_CHANNEL, { token: "9d172e6f-8bbc-4d66-9013-1f801adfdda2", sourceId: "ae283f70-9ccd-4e77-a124-20912be0eeb3" }],
      [IMPORT_CONFLICTS_LIST_CHANNEL],
      [IMPORT_CONFLICT_RESOLVE_CHANNEL, { id: "bf394081-addf-4f88-b235-31a23cf1ffc4", resolution: "keep-local" }],
      [SYNC_CONFLICTS_LIST_CHANNEL],
      [SYNC_CONFLICT_RESOLVE_CHANNEL, { id: "bf394081-addf-4f88-b235-31a23cf1ffc4", resolution: "restore", expectedRevision: 2 }],
      [SYNC_RUN_CHANNEL, {}],
      [BACKUP_CREATE_CHANNEL],
      [BACKUP_RESTORE_CHANNEL],
      [LIBRARY_EXPORT_CHANNEL],
      [REMOTE_DESCRIBE_CHANNEL],
      [REMOTE_SAVE_CHANNEL, { provider: "postgres", databaseUrl: "postgresql://example", location: "default" }],
      [REMOTE_CHECK_CHANNEL],
      [REMOTE_INITIALIZE_CHANNEL],
      [AI_DESCRIBE_CHANNEL],
      [AI_SAVE_CHANNEL, { enabled: false, selectedProvider: "openai", selectedModel: "gpt-5-mini" }],
      [AI_ACCEPT_TERMS_CHANNEL, "gemini"],
      [AI_DESCRIBE_TASK_CHANNEL, bookId, highlightId, true],
      [AI_EXPLAIN_CHANNEL, { requestId, disclosureId: highlightId }],
      [AI_CANCEL_CHANNEL, requestId],
      [APPEARANCE_DESCRIBE_CHANNEL],
      [APPEARANCE_SAVE_CHANNEL, { themeId: "rose-pine", mode: "dark" }],
      [APPEARANCE_EXPORT_THEME_CHANNEL, "rose-pine"],
      [APPEARANCE_IMPORT_THEME_CHANNEL],
      [APPEARANCE_OPEN_THEMES_FOLDER_CHANNEL],
    ]);
  });

  it("passes IPC results and failures through unchanged", async () => {
    const result = { configured: false };
    electron.invoke.mockResolvedValueOnce(result);
    await expect(bridge.remote.describe()).resolves.toBe(result);

    const failure = new Error("main process rejected the request");
    electron.invoke.mockRejectedValueOnce(failure);
    await expect(bridge.imports.listConflicts()).rejects.toBe(failure);
  });
});
