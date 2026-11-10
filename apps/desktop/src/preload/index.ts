import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
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
  IMPORT_CHOOSE_CHANNEL,
  IMPORT_CHOOSE_FOLDER_CHANNEL,
  IMPORT_READERS_LIST_CHANNEL,
  IMPORT_READER_CHOOSE_CHANNEL,
  IMPORT_READERS_CHANGED_CHANNEL,
  IMPORT_COMMIT_CHANNEL,
  IMPORT_CONFLICTS_LIST_CHANNEL,
  IMPORT_CONFLICT_RESOLVE_CHANNEL,
  SYNC_CONFLICTS_LIST_CHANNEL,
  SYNC_CONFLICT_RESOLVE_CHANNEL,
  SYNC_RUN_CHANNEL,
  SYNC_STATUS_CHANNEL,
  SYNC_STATUS_CHANGED_CHANNEL,
  BACKUP_CREATE_CHANNEL,
  UPDATES_CHECK_CHANNEL,
  LIBRARY_EXPORT_MARKDOWN_CHANNEL,
  LIBRARY_STATISTICS_CHANNEL,
  LIBRARY_DUPLICATES_CHANNEL,
  UPDATES_INSTALL_CHANNEL,
  UPDATES_DESCRIBE_CHANNEL,
  UPDATES_SET_AUTOMATIC_CHANNEL,
  DASHBOARDS_DESCRIBE_CHANNEL,
  DASHBOARDS_SAVE_CHANNEL,
  WIDGETS_DELETE_CHANNEL,
  WIDGETS_EVALUATE_CHANNEL,
  WIDGETS_EXPORT_CHANNEL,
  WIDGETS_IMPORT_CHANNEL,
  WIDGETS_SAVE_CHANNEL,
  UPDATES_AVAILABLE_CHANNEL,
  BACKUP_RESTORE_CHANNEL,
  REMOTE_CHECK_CHANNEL,
  REMOTE_DESCRIBE_CHANNEL,
  REMOTE_INITIALIZE_CHANNEL,
  REMOTE_SAVE_CHANNEL,
  AI_DESCRIBE_CHANNEL,
  AI_SAVE_CHANNEL,
  AI_ACCEPT_TERMS_CHANNEL,
  AI_DESCRIBE_TASK_CHANNEL,
  AI_EXPLAIN_CHANNEL,
  AI_CANCEL_CHANNEL,
  APPEARANCE_DESCRIBE_CHANNEL,
  APPEARANCE_SAVE_CHANNEL,
  APPEARANCE_CHANGED_CHANNEL,
  APPEARANCE_EXPORT_THEME_CHANNEL,
  APPEARANCE_IMPORT_THEME_CHANNEL,
  APPEARANCE_OPEN_THEMES_FOLDER_CHANNEL,
  COVER_RESOLVE_CHANNEL,
  COVER_CANCEL_CHANNEL,
  SYSTEM_CAPABILITIES_CHANNEL,
  SYSTEM_COMPLETE_SETUP_CHANNEL,
  SYSTEM_OPEN_EXTERNAL_CHANNEL,
  DICTIONARY_LOOKUP_CHANNEL,
  MCP_DESCRIBE_CHANNEL,
  MCP_CONFIGURE_CHANNEL,
  type McpConfiguration,
  type DictionaryResult,
  type Book,
  type BookContents,
  type BookId,
  type Highlight,
  type HighlightPage,
  type HighlightQuery,
  type NewHighlight,
  type NewNote,
  type Note,
  type UpdateHighlight,
  type UpdateNote,
  type UpdateBookMetadata,
  type BookMetadataSource,
  type AnnotationDeletionReceipt,
  type DeleteHighlight,
  type DeleteNote,
  type HighlightId,
  type HighlightSource,
  type ResetHighlightToSource,
  type BackupReceipt,
  type BookArchiveChange,
  type BookReadingStatusChange,
  type LeaflogueBridge,
  type NewBook,
  type PendingImport,
  type ImportReceipt,
  type CommitImport,
  type ImportConflict,
  type ResolveImportConflict,
  type ResolveSyncConflict,
  type SyncConflictPage,
  type SyncRunResult,
  type SyncStatus,
  type SyncRunOptions,
  type MergeBooks,
  type MergeBooksReceipt,
  type LibraryExportReceipt,
  type UpdateStatus,
  type LibraryStatistics,
  type LibraryDuplicates,
  type ConnectedReader,
  type MarkdownExportReceipt,
  type MarkdownExportOptions,
  type UpdateSettings,
  type DashboardId,
  type DashboardLayouts,
  type DashboardPlacement,
  type CustomWidget,
  type WidgetExportReceipt,
  type WidgetImportReceipt,
  type WidgetResult,
  type RestoreReceipt,
  type SetBookArchived,
  type SetBookCompletionDate,
  type SetBookReadingStatus,
  type ReadingStatusHistoryPage,
  type RemoteConfigurationSummary,
  type RemoteDatabaseStatus,
  type RemoteSetupInput,
  type SystemCapabilities,
  type AiConfigurationSummary,
  type AiSettingsInput,
  type AiTaskDisclosure,
  type ExplainPassageRequest,
  type PassageExplanation,
  type AppearanceConfiguration,
  type AppearanceSettingsInput,
  type ThemeExportReceipt,
  type BookOrganization,
  type Collection,
  type DeleteCollection,
  type DeleteTag,
  type NewCollection,
  type NewTag,
  type SetBookCollectionMembership,
  type SetBookTagMembership,
  type SetHighlightTagMembership,
  type Tag,
  type UpdateCollection,
  type UpdateTag,
  type Thread,
  type ThreadId,
  type ThreadDetails,
  type NewThread,
  type UpdateThread,
  type DeleteThread,
  type SetHighlightThreadMembership,
  type ThreadMembershipReceipt,
  type EnsureDailyHighlight,
  type DailyHighlight,
  type ResolvedCoverImage,
} from "@leaflogue/contracts";

const bridge: LeaflogueBridge = Object.freeze({
  system: Object.freeze({
    describeMcp: (): Promise<McpConfiguration> => ipcRenderer.invoke(MCP_DESCRIBE_CHANNEL) as Promise<McpConfiguration>,
    configureMcp: (enabled: boolean): Promise<McpConfiguration> => ipcRenderer.invoke(MCP_CONFIGURE_CHANNEL, enabled) as Promise<McpConfiguration>,
    lookupWord: (word: string): Promise<DictionaryResult> => ipcRenderer.invoke(DICTIONARY_LOOKUP_CHANNEL, word) as Promise<DictionaryResult>,
    getCapabilities: (): Promise<SystemCapabilities> =>
      ipcRenderer.invoke(SYSTEM_CAPABILITIES_CHANNEL) as Promise<SystemCapabilities>,
    completeSetup: (): Promise<SystemCapabilities> =>
      ipcRenderer.invoke(SYSTEM_COMPLETE_SETUP_CHANNEL) as Promise<SystemCapabilities>,
    openExternal: (url: string): Promise<boolean> =>
      ipcRenderer.invoke(SYSTEM_OPEN_EXTERNAL_CHANNEL, url) as Promise<boolean>,
  }),
  library: Object.freeze({
    findDuplicates: (): Promise<LibraryDuplicates> =>
      ipcRenderer.invoke(LIBRARY_DUPLICATES_CHANNEL) as Promise<LibraryDuplicates>,
    listBooks: (options?: { readonly includeArchived?: boolean }): Promise<readonly Book[]> =>
      ipcRenderer.invoke(LIBRARY_LIST_CHANNEL, options) as Promise<readonly Book[]>,
    createBook: (input: NewBook): Promise<Book> =>
      ipcRenderer.invoke(LIBRARY_CREATE_CHANNEL, input) as Promise<Book>,
    updateBookMetadata: (input: UpdateBookMetadata): Promise<Book> =>
      ipcRenderer.invoke(LIBRARY_UPDATE_METADATA_CHANNEL, input) as Promise<Book>,
    getMetadataSource: (id: BookId): Promise<BookMetadataSource | undefined> =>
      ipcRenderer.invoke(LIBRARY_METADATA_SOURCE_CHANNEL, id) as Promise<BookMetadataSource | undefined>,
    getBookContents: (id: BookId): Promise<BookContents | undefined> =>
      ipcRenderer.invoke(LIBRARY_GET_CONTENTS_CHANNEL, id) as Promise<BookContents | undefined>,
    listHighlights: (query: HighlightQuery): Promise<HighlightPage> =>
      ipcRenderer.invoke(LIBRARY_LIST_HIGHLIGHTS_CHANNEL, query) as Promise<HighlightPage>,
    createHighlight: (input: NewHighlight): Promise<Highlight> =>
      ipcRenderer.invoke(LIBRARY_CREATE_HIGHLIGHT_CHANNEL, input) as Promise<Highlight>,
    updateHighlight: (input: UpdateHighlight): Promise<Highlight> =>
      ipcRenderer.invoke(LIBRARY_UPDATE_HIGHLIGHT_CHANNEL, input) as Promise<Highlight>,
    createNote: (input: NewNote): Promise<Note> =>
      ipcRenderer.invoke(LIBRARY_CREATE_NOTE_CHANNEL, input) as Promise<Note>,
    updateNote: (input: UpdateNote): Promise<Note> =>
      ipcRenderer.invoke(LIBRARY_UPDATE_NOTE_CHANNEL, input) as Promise<Note>,
    deleteHighlight: (input: DeleteHighlight): Promise<AnnotationDeletionReceipt> =>
      ipcRenderer.invoke(LIBRARY_DELETE_HIGHLIGHT_CHANNEL, input) as Promise<AnnotationDeletionReceipt>,
    deleteNote: (input: DeleteNote): Promise<AnnotationDeletionReceipt> =>
      ipcRenderer.invoke(LIBRARY_DELETE_NOTE_CHANNEL, input) as Promise<AnnotationDeletionReceipt>,
    getHighlightSource: (bookId: BookId, highlightId: HighlightId): Promise<HighlightSource | undefined> =>
      ipcRenderer.invoke(LIBRARY_HIGHLIGHT_SOURCE_CHANNEL, bookId, highlightId) as Promise<HighlightSource | undefined>,
    resetHighlightToSource: (input: ResetHighlightToSource): Promise<Highlight> =>
      ipcRenderer.invoke(LIBRARY_RESET_HIGHLIGHT_CHANNEL, input) as Promise<Highlight>,
    setBookArchived: (input: SetBookArchived): Promise<BookArchiveChange> =>
      ipcRenderer.invoke(LIBRARY_SET_BOOK_ARCHIVED_CHANNEL, input) as Promise<BookArchiveChange>,
    listReadingStatusHistory: (id: BookId): Promise<ReadingStatusHistoryPage> =>
      ipcRenderer.invoke(LIBRARY_LIST_READING_STATUS_CHANNEL, id) as Promise<ReadingStatusHistoryPage>,
    setBookReadingStatus: (input: SetBookReadingStatus): Promise<BookReadingStatusChange> =>
      ipcRenderer.invoke(LIBRARY_SET_READING_STATUS_CHANNEL, input) as Promise<BookReadingStatusChange>,
    setBookCompletionDate: (input: SetBookCompletionDate): Promise<Book> =>
      ipcRenderer.invoke(LIBRARY_SET_COMPLETION_DATE_CHANNEL, input) as Promise<Book>,
    mergeBooks: (input: MergeBooks): Promise<MergeBooksReceipt> =>
      ipcRenderer.invoke(LIBRARY_MERGE_BOOKS_CHANNEL, input) as Promise<MergeBooksReceipt>,
  }),
  covers: Object.freeze({
    resolve: (sourceUrl: string, requestId: string): Promise<ResolvedCoverImage | undefined> =>
      ipcRenderer.invoke(COVER_RESOLVE_CHANNEL, sourceUrl, requestId) as Promise<ResolvedCoverImage | undefined>,
    cancel: (requestId: string): Promise<void> =>
      ipcRenderer.invoke(COVER_CANCEL_CHANNEL, requestId) as Promise<void>,
  }),
  organization: Object.freeze({
    listCollections: (): Promise<readonly Collection[]> =>
      ipcRenderer.invoke(ORGANIZATION_LIST_COLLECTIONS_CHANNEL) as Promise<readonly Collection[]>,
    listTags: (): Promise<readonly Tag[]> =>
      ipcRenderer.invoke(ORGANIZATION_LIST_TAGS_CHANNEL) as Promise<readonly Tag[]>,
    getBook: (id: BookId): Promise<BookOrganization | undefined> =>
      ipcRenderer.invoke(ORGANIZATION_GET_BOOK_CHANNEL, id) as Promise<BookOrganization | undefined>,
    createCollection: (input: NewCollection): Promise<Collection> =>
      ipcRenderer.invoke(ORGANIZATION_CREATE_COLLECTION_CHANNEL, input) as Promise<Collection>,
    updateCollection: (input: UpdateCollection): Promise<Collection> =>
      ipcRenderer.invoke(ORGANIZATION_UPDATE_COLLECTION_CHANNEL, input) as Promise<Collection>,
    deleteCollection: (input: DeleteCollection): Promise<void> =>
      ipcRenderer.invoke(ORGANIZATION_DELETE_COLLECTION_CHANNEL, input) as Promise<void>,
    createTag: (input: NewTag): Promise<Tag> =>
      ipcRenderer.invoke(ORGANIZATION_CREATE_TAG_CHANNEL, input) as Promise<Tag>,
    updateTag: (input: UpdateTag): Promise<Tag> =>
      ipcRenderer.invoke(ORGANIZATION_UPDATE_TAG_CHANNEL, input) as Promise<Tag>,
    deleteTag: (input: DeleteTag): Promise<void> =>
      ipcRenderer.invoke(ORGANIZATION_DELETE_TAG_CHANNEL, input) as Promise<void>,
    setBookCollection: (input: SetBookCollectionMembership): Promise<BookOrganization> =>
      ipcRenderer.invoke(ORGANIZATION_SET_BOOK_COLLECTION_CHANNEL, input) as Promise<BookOrganization>,
    setBookTag: (input: SetBookTagMembership): Promise<BookOrganization> =>
      ipcRenderer.invoke(ORGANIZATION_SET_BOOK_TAG_CHANNEL, input) as Promise<BookOrganization>,
    setHighlightTag: (input: SetHighlightTagMembership): Promise<BookOrganization> =>
      ipcRenderer.invoke(ORGANIZATION_SET_HIGHLIGHT_TAG_CHANNEL, input) as Promise<BookOrganization>,
  }),
  threads: Object.freeze({
    list: (): Promise<readonly Thread[]> => ipcRenderer.invoke(THREAD_LIST_CHANNEL) as Promise<readonly Thread[]>,
    get: (id: ThreadId): Promise<ThreadDetails | undefined> => ipcRenderer.invoke(THREAD_GET_CHANNEL, id) as Promise<ThreadDetails | undefined>,
    getHighlightMembership: (bookId: BookId, highlightId: Highlight["id"]): Promise<readonly ThreadId[]> =>
      ipcRenderer.invoke(THREAD_GET_HIGHLIGHT_MEMBERSHIP_CHANNEL, { bookId, highlightId }) as Promise<readonly ThreadId[]>,
    create: (input: NewThread): Promise<Thread> => ipcRenderer.invoke(THREAD_CREATE_CHANNEL, input) as Promise<Thread>,
    update: (input: UpdateThread): Promise<Thread> => ipcRenderer.invoke(THREAD_UPDATE_CHANNEL, input) as Promise<Thread>,
    delete: (input: DeleteThread): Promise<void> => ipcRenderer.invoke(THREAD_DELETE_CHANNEL, input) as Promise<void>,
    setHighlightMembership: (input: SetHighlightThreadMembership): Promise<ThreadMembershipReceipt> =>
      ipcRenderer.invoke(THREAD_SET_HIGHLIGHT_MEMBERSHIP_CHANNEL, input) as Promise<ThreadMembershipReceipt>,
  }),
  daily: Object.freeze({
    get: (timezone: string): Promise<DailyHighlight | undefined> => ipcRenderer.invoke(DAILY_GET_CHANNEL, timezone) as Promise<DailyHighlight | undefined>,
    ensure: (input: EnsureDailyHighlight): Promise<DailyHighlight | undefined> => ipcRenderer.invoke(DAILY_ENSURE_CHANNEL, input) as Promise<DailyHighlight | undefined>,
  }),
  imports: Object.freeze({
    chooseFile: (): Promise<PendingImport | undefined> =>
      ipcRenderer.invoke(IMPORT_CHOOSE_CHANNEL) as Promise<PendingImport | undefined>,
    chooseFolder: (): Promise<PendingImport | undefined> =>
      ipcRenderer.invoke(IMPORT_CHOOSE_FOLDER_CHANNEL) as Promise<PendingImport | undefined>,
    listReaders: (): Promise<readonly ConnectedReader[]> =>
      ipcRenderer.invoke(IMPORT_READERS_LIST_CHANNEL) as Promise<readonly ConnectedReader[]>,
    chooseReader: (id: string): Promise<PendingImport | undefined> =>
      ipcRenderer.invoke(IMPORT_READER_CHOOSE_CHANNEL, id) as Promise<PendingImport | undefined>,
    onReadersChanged: (listener: (readers: readonly ConnectedReader[]) => void): (() => void) => {
      const receive = (_event: IpcRendererEvent, readers: unknown) => {
        if (Array.isArray(readers)) listener(readers as readonly ConnectedReader[]);
      };
      ipcRenderer.on(IMPORT_READERS_CHANGED_CHANNEL, receive);
      return () => { ipcRenderer.removeListener(IMPORT_READERS_CHANGED_CHANNEL, receive); };
    },
    commit: (input: CommitImport): Promise<ImportReceipt> =>
      ipcRenderer.invoke(IMPORT_COMMIT_CHANNEL, input) as Promise<ImportReceipt>,
    listConflicts: (): Promise<readonly ImportConflict[]> =>
      ipcRenderer.invoke(IMPORT_CONFLICTS_LIST_CHANNEL) as Promise<readonly ImportConflict[]>,
    resolveConflict: (input: ResolveImportConflict): Promise<void> =>
      ipcRenderer.invoke(IMPORT_CONFLICT_RESOLVE_CHANNEL, input) as Promise<void>,
  }),
  sync: Object.freeze({
    listConflicts: (): Promise<SyncConflictPage> =>
      ipcRenderer.invoke(SYNC_CONFLICTS_LIST_CHANNEL) as Promise<SyncConflictPage>,
    resolveConflict: (input: ResolveSyncConflict): Promise<void> =>
      ipcRenderer.invoke(SYNC_CONFLICT_RESOLVE_CHANNEL, input) as Promise<void>,
    run: (options: SyncRunOptions = {}): Promise<SyncRunResult> =>
      ipcRenderer.invoke(SYNC_RUN_CHANNEL, options) as Promise<SyncRunResult>,
    status: (): Promise<SyncStatus> =>
      ipcRenderer.invoke(SYNC_STATUS_CHANNEL) as Promise<SyncStatus>,
    onStatus: (listener: (status: SyncStatus) => void): (() => void) => {
      const receive = (_event: IpcRendererEvent, status: unknown) => {
        if (typeof status === "object" && status !== null && "state" in status) listener(status as SyncStatus);
      };
      ipcRenderer.on(SYNC_STATUS_CHANGED_CHANNEL, receive);
      return () => { ipcRenderer.removeListener(SYNC_STATUS_CHANGED_CHANNEL, receive); };
    },
  }),
  backups: Object.freeze({
    create: (): Promise<BackupReceipt | undefined> =>
      ipcRenderer.invoke(BACKUP_CREATE_CHANNEL) as Promise<BackupReceipt | undefined>,
    restore: (): Promise<RestoreReceipt | undefined> =>
      ipcRenderer.invoke(BACKUP_RESTORE_CHANNEL) as Promise<RestoreReceipt | undefined>,
  }),
  exports: Object.freeze({
    create: (): Promise<LibraryExportReceipt | undefined> =>
      ipcRenderer.invoke(LIBRARY_EXPORT_CHANNEL) as Promise<LibraryExportReceipt | undefined>,
    createMarkdown: (options: MarkdownExportOptions): Promise<MarkdownExportReceipt | undefined> =>
      ipcRenderer.invoke(LIBRARY_EXPORT_MARKDOWN_CHANNEL, options) as Promise<MarkdownExportReceipt | undefined>,
  }),
  statistics: Object.freeze({
    get: (): Promise<LibraryStatistics> =>
      ipcRenderer.invoke(LIBRARY_STATISTICS_CHANNEL) as Promise<LibraryStatistics>,

  }),
  dashboards: Object.freeze({
    describe: (): Promise<DashboardLayouts> =>
      ipcRenderer.invoke(DASHBOARDS_DESCRIBE_CHANNEL) as Promise<DashboardLayouts>,
    save: (dashboard: DashboardId, layout: readonly DashboardPlacement[] | null): Promise<DashboardLayouts> =>
      ipcRenderer.invoke(DASHBOARDS_SAVE_CHANNEL, dashboard, layout) as Promise<DashboardLayouts>,
  }),
  widgets: Object.freeze({
    save: (widget: CustomWidget): Promise<DashboardLayouts> =>
      ipcRenderer.invoke(WIDGETS_SAVE_CHANNEL, widget) as Promise<DashboardLayouts>,
    delete: (id: string): Promise<DashboardLayouts> =>
      ipcRenderer.invoke(WIDGETS_DELETE_CHANNEL, id) as Promise<DashboardLayouts>,
    evaluate: (widgets: readonly CustomWidget[]): Promise<readonly WidgetResult[]> =>
      ipcRenderer.invoke(WIDGETS_EVALUATE_CHANNEL, widgets) as Promise<readonly WidgetResult[]>,
    export: (id: string): Promise<WidgetExportReceipt | undefined> =>
      ipcRenderer.invoke(WIDGETS_EXPORT_CHANNEL, id) as Promise<WidgetExportReceipt | undefined>,
    import: (): Promise<WidgetImportReceipt | undefined> =>
      ipcRenderer.invoke(WIDGETS_IMPORT_CHANNEL) as Promise<WidgetImportReceipt | undefined>,
  }),
  updates: Object.freeze({
    check: (): Promise<UpdateStatus> =>
      ipcRenderer.invoke(UPDATES_CHECK_CHANNEL) as Promise<UpdateStatus>,
    install: (): Promise<void> =>
      ipcRenderer.invoke(UPDATES_INSTALL_CHANNEL) as Promise<void>,
    describe: (): Promise<UpdateSettings> =>
      ipcRenderer.invoke(UPDATES_DESCRIBE_CHANNEL) as Promise<UpdateSettings>,
    setAutomaticCheck: (enabled: boolean): Promise<UpdateSettings> =>
      ipcRenderer.invoke(UPDATES_SET_AUTOMATIC_CHANNEL, enabled) as Promise<UpdateSettings>,
    onAvailable: (listener: (version: string) => void): (() => void) => {
      const receive = (_event: IpcRendererEvent, version: unknown) => {
        if (typeof version === "string") listener(version);
      };
      ipcRenderer.on(UPDATES_AVAILABLE_CHANNEL, receive);
      return () => { ipcRenderer.removeListener(UPDATES_AVAILABLE_CHANNEL, receive); };
    },
  }),
  remote: Object.freeze({
    describe: (): Promise<RemoteConfigurationSummary> =>
      ipcRenderer.invoke(REMOTE_DESCRIBE_CHANNEL) as Promise<RemoteConfigurationSummary>,
    save: (input: RemoteSetupInput): Promise<RemoteConfigurationSummary | undefined> =>
      ipcRenderer.invoke(REMOTE_SAVE_CHANNEL, input) as Promise<RemoteConfigurationSummary | undefined>,
    check: (): Promise<RemoteDatabaseStatus> =>
      ipcRenderer.invoke(REMOTE_CHECK_CHANNEL) as Promise<RemoteDatabaseStatus>,
    initialize: (): Promise<RemoteDatabaseStatus> =>
      ipcRenderer.invoke(REMOTE_INITIALIZE_CHANNEL) as Promise<RemoteDatabaseStatus>,
  }),
  ai: Object.freeze({
    describe: (): Promise<AiConfigurationSummary> =>
      ipcRenderer.invoke(AI_DESCRIBE_CHANNEL) as Promise<AiConfigurationSummary>,
    save: (input: AiSettingsInput): Promise<AiConfigurationSummary> =>
      ipcRenderer.invoke(AI_SAVE_CHANNEL, input) as Promise<AiConfigurationSummary>,
    acceptTerms: (providerId: string): Promise<AiConfigurationSummary> =>
      ipcRenderer.invoke(AI_ACCEPT_TERMS_CHANNEL, providerId) as Promise<AiConfigurationSummary>,
    describeExplainTask: (bookId: BookId, highlightId: HighlightId, includeNotes: boolean): Promise<AiTaskDisclosure> =>
      ipcRenderer.invoke(AI_DESCRIBE_TASK_CHANNEL, bookId, highlightId, includeNotes) as Promise<AiTaskDisclosure>,
    explainPassage: (input: ExplainPassageRequest): Promise<PassageExplanation> =>
      ipcRenderer.invoke(AI_EXPLAIN_CHANNEL, input) as Promise<PassageExplanation>,
    cancel: (requestId: string): Promise<void> =>
      ipcRenderer.invoke(AI_CANCEL_CHANNEL, requestId) as Promise<void>,
  }),
  appearance: Object.freeze({
    describe: (): Promise<AppearanceConfiguration> =>
      ipcRenderer.invoke(APPEARANCE_DESCRIBE_CHANNEL) as Promise<AppearanceConfiguration>,
    save: (input: AppearanceSettingsInput): Promise<AppearanceConfiguration> =>
      ipcRenderer.invoke(APPEARANCE_SAVE_CHANNEL, input) as Promise<AppearanceConfiguration>,
    exportTheme: (themeId: string): Promise<ThemeExportReceipt | undefined> =>
      ipcRenderer.invoke(APPEARANCE_EXPORT_THEME_CHANNEL, themeId) as Promise<ThemeExportReceipt | undefined>,
    importTheme: (): Promise<AppearanceConfiguration | undefined> =>
      ipcRenderer.invoke(APPEARANCE_IMPORT_THEME_CHANNEL) as Promise<AppearanceConfiguration | undefined>,
    openThemesFolder: (): Promise<string> =>
      ipcRenderer.invoke(APPEARANCE_OPEN_THEMES_FOLDER_CHANNEL) as Promise<string>,
    onChanged: (listener: (configuration: AppearanceConfiguration) => void): (() => void) => {
      const receive = (_event: IpcRendererEvent, configuration: AppearanceConfiguration) => listener(configuration);
      ipcRenderer.on(APPEARANCE_CHANGED_CHANNEL, receive);
      return () => ipcRenderer.removeListener(APPEARANCE_CHANGED_CHANNEL, receive);
    },
  }),
});

contextBridge.exposeInMainWorld("leaflogue", bridge);

// Lets the header make room for, and be dragged like, the macOS title bar.
function markPlatform(): void { document.documentElement.dataset.platform = process.platform; }
if (typeof document !== "undefined") {
  if (document.documentElement) markPlatform();
  else document.addEventListener("DOMContentLoaded", markPlatform, { once: true });
}
